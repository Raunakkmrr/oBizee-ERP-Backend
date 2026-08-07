import { describe, expect, it } from "vitest";
import {
  DEV_OTP_CODE,
  DevOtpSender,
  Msg91OtpSender,
  otpSenderFrom,
} from "./otp-sender.ts";

/**
 * The fixed development code is a convenience with a blast radius: every phone
 * accepts 123456. These tests are the reason it cannot reach a real user.
 */
describe("DevOtpSender cannot run in production", () => {
  it("throws when NODE_ENV is production, even with the dev flag on", () => {
    expect(
      () => new DevOtpSender({ NODE_ENV: "production", OTP_DEV_MODE: "on" }),
    ).toThrow(/cannot run in production/);
  });

  it("throws when the dev flag is not explicitly on", () => {
    // Deliberately awkward. A fixed code must never be what you get by default.
    expect(() => new DevOtpSender({ NODE_ENV: "development" })).toThrow(
      /OTP_DEV_MODE=on/,
    );
    expect(
      () => new DevOtpSender({ NODE_ENV: "development", OTP_DEV_MODE: "off" }),
    ).toThrow(/OTP_DEV_MODE=on/);
  });

  it("needs both switches wrong before the fixed code is reachable", async () => {
    const sender = new DevOtpSender({ NODE_ENV: "development", OTP_DEV_MODE: "on" });
    expect(await sender.send("919820012345")).toBe(DEV_OTP_CODE);
  });
});

describe("selecting a sender", () => {
  it("refuses to guess when OTP_PROVIDER is unset", () => {
    // Guessing on the caller's behalf is how the wrong sender gets used.
    expect(() => otpSenderFrom({})).toThrow(/must be "dev" or "msg91"/);
  });

  it("refuses an unknown provider rather than falling back to dev", () => {
    expect(() => otpSenderFrom({ OTP_PROVIDER: "twilio" })).toThrow(/got twilio/);
  });

  it("builds the dev sender only with both switches", () => {
    expect(
      otpSenderFrom({ OTP_PROVIDER: "dev", OTP_DEV_MODE: "on", NODE_ENV: "test" }).id,
    ).toBe("dev");
  });

  it("requires MSG91 credentials before it will construct", () => {
    expect(() => otpSenderFrom({ OTP_PROVIDER: "msg91" })).toThrow(/required/);
  });
});

describe("Msg91OtpSender", () => {
  it("throws rather than silently falling back to the fixed code", async () => {
    // The failure mode this prevents: MSG91 selected, unimplemented, and every
    // phone quietly still accepting 123456.
    const sender = new Msg91OtpSender("key", "template");
    await expect(sender.send("919820012345")).rejects.toThrow(/not implemented/);
  });
});
