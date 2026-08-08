import { Hono } from "hono";
import { zBody } from "../lib/validate.ts";
import { apiRouter } from "../lib/router.ts";
import { callerIp, clear, consumeAll, LIMITS, tooMany } from "../lib/rate-limit.ts";
import { z } from "zod";
import { e164 } from "../lib/phone.ts";
import { otpSenderFrom } from "../auth/otp-sender.ts";
import {
  requestOtp,
  rotateRefresh,
  signInWithPassword,
  verifyOtp,
} from "../auth/sign-in.ts";
import type { AppEnv } from "../auth/context.ts";

/**
 * Sign-in routes. Mounted **before** `requireCaller`, deliberately — these are
 * the only endpoints that may be reached without a token, and being public is
 * therefore a decision somebody made rather than a check somebody forgot.
 */
/*
  `apiRouter()`, not `new Hono()`. Hono calls the `onError` of the instance the
  error was thrown in, so an auth route on a bare instance had no mapping at
  all — a malformed sign-in body came back as a bare 500. This is the drift
  `router.ts` warns about, and auth was the one file that had it.
*/
export const authRoutes = apiRouter();

/*
  A malformed number is a 400; an unrecognised one is still a neutral 200.

  The two are different failures and only one of them is the caller's mistake.
  `min(1)` accepted "abc", which `e164` then refused, and the route answered
  with the same "a code is on its way" it gives a real number — so a client
  sending a name instead of a number looked successful forever.

  The neutral answer stays for anything *shaped* like a number, because that
  is what stops the endpoint being used to ask who works here.
*/
const phoneBody = z.object({
  phone: z
    .string()
    .trim()
    .min(1)
    .refine((value) => e164(value) !== null, {
      message: "That is not a phone number this system can dial",
    }),
});

authRoutes.post("/otp/request", zBody( phoneBody), async (c) => {
  const { phone } = c.req.valid("json");
  const normalised = e164(phone);
  const ip = callerIp(c);

  /*
    Consumed before the send, and keyed on the *normalised* number so that
    9820012345, +919820012345 and 09820012345 share one budget rather than
    three. Each request here is an SMS: money out, and a message on somebody's
    real phone whether or not they asked for it.
  */
  const verdict = await consumeAll([
    [`otp:req:phone:${normalised ?? phone}`, LIMITS.otpRequestPerPhone],
    [`otp:req:ip:${ip}`, LIMITS.otpRequestPerIp],
  ]);
  if (!verdict.allowed) return tooMany(c, verdict.retryAfter);

  if (normalised) {
    await requestOtp(normalised, otpSenderFrom());
  }

  /*
    Always the same reply, whether the number is real, unknown, malformed or
    belongs to a deactivated technician. An endpoint that distinguishes them is
    a directory of who works here, available to anyone.
  */
  return c.json({ sent: true, message: "If that number is on file, a code is on its way" });
});

authRoutes.post(
  "/otp/verify",
  zBody( phoneBody.extend({ code: z.string().length(6) })),
  async (c) => {
    const { phone, code } = c.req.valid("json");
    const normalised = e164(phone);
    if (!normalised) return c.json({ error: "That code is not right" }, 401);

    /*
      The challenge already stops at five attempts. This stops the way around
      that: ask for a fresh challenge and start the five again.
    */
    const verdict = await consumeAll([
      [`otp:verify:phone:${normalised}`, LIMITS.otpVerifyPerPhone],
      [`otp:verify:ip:${callerIp(c)}`, LIMITS.otpVerifyPerIp],
    ]);
    if (!verdict.allowed) return tooMany(c, verdict.retryAfter);

    const result = await verifyOtp(normalised, code);
    if (result.kind === "refused") return c.json({ error: result.reason }, 401);
    return c.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: { name: result.caller.name, role: result.caller.role },
    });
  },
);

authRoutes.post(
  "/password",
  zBody( z.object({ email: z.string().email(), password: z.string().min(1) })),
  async (c) => {
    const { email, password } = c.req.valid("json");
    const account = email.toLowerCase().trim();
    const ip = callerIp(c);
    const accountKey = `pw:account:${account}`;

    const verdict = await consumeAll([
      [accountKey, LIMITS.passwordPerAccount],
      [`pw:ip:${ip}`, LIMITS.passwordPerIp],
    ]);
    if (!verdict.allowed) return tooMany(c, verdict.retryAfter);

    const result = await signInWithPassword(account, password);
    if (result.kind === "refused") return c.json({ error: result.reason }, 401);

    /*
      Getting in clears the account's failures. Only failures should
      accumulate — otherwise a coordinator who signs in from the shop floor
      several times a day locks herself out by working, and the limiter
      punishes use rather than attack.
    */
    await clear(accountKey);
    return c.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      user: { name: result.caller.name, role: result.caller.role },
    });
  },
);

authRoutes.post(
  "/refresh",
  zBody( z.object({ refreshToken: z.string().min(1) })),
  async (c) => {
    /*
      By IP only. A refresh token is the identifier here, and keying on it
      would let anybody holding a stolen one lock the rightful owner out of
      rotating theirs.
    */
    const verdict = await consumeAll([[`refresh:ip:${callerIp(c)}`, LIMITS.refreshPerIp]]);
    if (!verdict.allowed) return tooMany(c, verdict.retryAfter);

    const result = await rotateRefresh(c.req.valid("json").refreshToken);
    if (result.kind === "refused") return c.json({ error: result.reason }, 401);
    return c.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  },
);
