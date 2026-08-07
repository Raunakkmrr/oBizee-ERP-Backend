import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
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
export const authRoutes = new Hono<AppEnv>();

const phoneBody = z.object({ phone: z.string().min(1) });

authRoutes.post("/otp/request", zValidator("json", phoneBody), async (c) => {
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
  zValidator("json", phoneBody.extend({ code: z.string().length(6) })),
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
  zValidator("json", z.object({ email: z.string().email(), password: z.string().min(1) })),
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
  zValidator("json", z.object({ refreshToken: z.string().min(1) })),
  async (c) => {
    const result = await rotateRefresh(c.req.valid("json").refreshToken);
    if (result.kind === "refused") return c.json({ error: result.reason }, 401);
    return c.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  },
);
