import { Hono } from "hono";
import { zBody } from "../lib/validate.ts";
import { apiRouter } from "../lib/router.ts";
import { revokeRefreshToken } from "../auth/sign-in.ts";
import { callerIp, clear, consumeAll, LIMITS, refund, tooMany } from "../lib/rate-limit.ts";
import { z } from "zod";
import { e164 } from "../lib/phone.ts";
import { otpSenderFrom, sendsRealMessages } from "../auth/otp-sender.ts";
import {
  requestOtp,
  rotateRefresh,
  signInWithPassword,
  verifyOtp,
} from "../auth/sign-in.ts";
import type { AppEnv } from "../auth/context.ts";
import {
  clearRefreshCookie,
  readRefreshToken,
  setRefreshCookie,
  wantsTokenInBody,
} from "../auth/refresh-cookie.ts";

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
  /*
    Chosen before the budget is spent, because what the budget is *for* depends
    on which sender is about to run. A misconfigured `OTP_PROVIDER` now throws
    before the counter moves rather than after — the same 500 for every number,
    so it still says nothing about who is on file.
  */
  const sender = otpSenderFrom();

  /*
    Consumed before the send, and keyed on the *normalised* number so that
    9820012345, +919820012345 and 09820012345 share one budget rather than
    three. Each request here is an SMS: money out, and a message on somebody's
    real phone whether or not they asked for it.

    Which is exactly why the development sender is exempt, and why it is the
    only thing that is. `DevOtpSender` sends no SMS and buzzes no handset; it
    prints a fixed code to the console. Charging an hour's lockout for a console
    line is what made the E2E suite fail on its third run of the morning, with
    two specs in `permissions.spec.ts` reporting a technician who could not see
    their jobs — a permissions regression that never happened. A budget that
    only ever fires on the people building the product is not defending anyone.

    Read off the sender rather than a flag of its own, deliberately. A
    `RATE_LIMIT_DEV` or a list of exempt test numbers would be a third switch to
    set wrong, and the one that got set wrong would open the SMS budget in
    production. The sender is already the hardened switch: `DevOtpSender` throws
    at construction under `NODE_ENV=production`, and again without
    `OTP_DEV_MODE=on`. Both of those must already be wrong before this exemption
    can be reached, and in that state the process refuses to boot at all. With
    `OTP_PROVIDER=msg91` the sender costs money, and every request is counted
    exactly as before.

    `/otp/verify` is *not* exempt, and must not become so. That door prices
    guessing rather than sending, and guessing is as available in development as
    anywhere else.
  */
  if (sendsRealMessages(sender)) {
    const ip = callerIp(c);
    const verdict = await consumeAll([
      [`otp:req:phone:${normalised ?? phone}`, LIMITS.otpRequestPerPhone],
      [`otp:req:ip:${ip}`, LIMITS.otpRequestPerIp],
    ]);
    if (!verdict.allowed) return tooMany(c, verdict.retryAfter);
  }

  if (normalised) {
    await requestOtp(normalised, sender);
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

    /*
      Same rule as the password door: a code that worked was not an attempt at
      guessing. Technicians share a site's connection far more often than office
      staff share the office's, so the address budget here matters more, not
      less.
    */
    await Promise.all([
      clear(`otp:verify:phone:${normalised}`),
      refund(`otp:verify:ip:${callerIp(c)}`),
    ]);
    setRefreshCookie(c, result.refreshToken);
    return c.json({
      accessToken: result.accessToken,
      ...(wantsTokenInBody(c) ? { refreshToken: result.refreshToken } : {}),
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
      Getting in clears the account's failures and refunds the address's.

      Only failures should accumulate — otherwise a coordinator who signs in
      from the shop floor several times a day locks herself out by working, and
      the limiter punishes use rather than attack. That was written about the
      account key and true only of it: the per-IP key was consumed by every
      attempt and never given back, so a dozen people sharing one office
      connection locked the building out by arriving on a Monday.

      Refunded rather than cleared. See `0012_rate_limit_refund.sql` — clearing
      would let one valid credential wipe the counter between guesses at other
      accounts, which is most of what the address key exists to stop.
    */
    await Promise.all([clear(accountKey), refund(`pw:ip:${ip}`)]);
    /*
      The refresh token goes into an httpOnly cookie and, unless a native
      client asked for it, nowhere else. Handing it back in the body is what
      put it in `localStorage`, where any injected script could read it and
      hold a working session for thirty days.
    */
    setRefreshCookie(c, result.refreshToken);
    return c.json({
      accessToken: result.accessToken,
      ...(wantsTokenInBody(c) ? { refreshToken: result.refreshToken } : {}),
      user: { name: result.caller.name, role: result.caller.role },
    });
  },
);

authRoutes.post(
  "/refresh",
  /*
    The token arrives in a cookie the browser sends and script cannot read, so
    the body is optional now. Still accepted, because a native client that
    asked for the token in the body has to return it somehow — and because a
    browser holding an old `localStorage` token from before this change gets
    one last refresh, after which it has a cookie and the old token is rotated
    away.
  */
  zBody(z.object({ refreshToken: z.string().min(1).optional() })),
  async (c) => {
    /*
      By IP only. A refresh token is the identifier here, and keying on it
      would let anybody holding a stolen one lock the rightful owner out of
      rotating theirs.
    */
    const ip = callerIp(c);
    const verdict = await consumeAll([[`refresh:ip:${ip}`, LIMITS.refreshPerIp]]);
    if (!verdict.allowed) return tooMany(c, verdict.retryAfter);

    const presented = readRefreshToken(c, c.req.valid("json").refreshToken);
    if (!presented) return c.json({ error: "Sign in again" }, 401);

    const result = await rotateRefresh(presented);
    if (result.kind === "refused") {
      // A cookie that no longer works is worse than no cookie: every later
      // request presents it, is refused, and the session never resolves.
      clearRefreshCookie(c);
      return c.json({ error: result.reason }, 401);
    }
    /*
      Refunded, for the same reason as the password door and with more force.

      This endpoint runs on **every** cold page load — a bookmark, a refresh, a
      new tab, the first open of the morning — because the access token lives in
      memory and dies with the document. Thirty an hour across an office sharing
      one NAT address is a quiet morning, and the failure was vicious: everybody
      is signed out, signing in again works, and the very next page load
      refreshes, fails, and signs them out again. A loop nobody can escape by
      doing the obvious thing.

      Found by the E2E suite, which loads pages the way a person does. The
      earlier sign-in fix closed the door and left this corridor open.
    */
    await refund(`refresh:ip:${ip}`);
    setRefreshCookie(c, result.refreshToken);
    return c.json({
      accessToken: result.accessToken,
      ...(wantsTokenInBody(c) ? { refreshToken: result.refreshToken } : {}),
    });
  },
);

/**
 * Sign out — the token dies with the click.
 *
 * Unauthenticated on purpose: an expired access token must not stop somebody
 * ending their session, and the refresh token in the body is proof enough of
 * what to revoke. Always answers the same way, so it cannot be used to ask
 * whether a token was real.
 */
authRoutes.post(
  "/sign-out",
  zBody(z.object({ refreshToken: z.string().min(1).optional() }).optional()),
  async (c) => {
    const presented = readRefreshToken(c, c.req.valid("json")?.refreshToken);
    if (presented) await revokeRefreshToken(presented);
    // Cleared whether or not anything was revoked. A sign-out that leaves the
    // cookie behind is a door closed with the key still in it.
    clearRefreshCookie(c);
    return c.json({ signedOut: true });
  },
);
