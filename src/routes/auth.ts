import { Hono } from "hono";
import { zBody } from "../lib/validate.ts";
import { apiRouter } from "../lib/router.ts";
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
    const result = await signInWithPassword(email.toLowerCase().trim(), password);
    if (result.kind === "refused") return c.json({ error: result.reason }, 401);
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
    const result = await rotateRefresh(c.req.valid("json").refreshToken);
    if (result.kind === "refused") return c.json({ error: result.reason }, 401);
    return c.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  },
);
