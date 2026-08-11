/**
 * Sending a one-time code.
 *
 * **Why this is an interface with two implementations rather than an `if`.**
 * The development sender uses a fixed code, `123456`, because there is no SMS
 * provider yet. That is a reasonable thing to build and a catastrophic thing to
 * ship: a fixed OTP means anyone who knows a colleague's phone number can sign
 * in as them, and the usual protection — a comment saying "remove before
 * production" — has never once worked.
 *
 * So the protection is structural. `DevOtpSender` throws at construction when
 * `NODE_ENV` is production, and again when `OTP_DEV_MODE` is not explicitly
 * turned on. Two independent switches, both of which must be wrong for the
 * fixed code to reach a real user, and the process refuses to boot rather than
 * running insecurely.
 *
 * Wiring MSG91 later is filling in `Msg91OtpSender.send` and setting
 * `OTP_PROVIDER=msg91`. Nothing else changes — not the routes, not the
 * challenge table, not the verification, not the rate limiting. The dev sender
 * does **not** skip verification; it only makes the code predictable, so the
 * real flow is exercised from the first day.
 */

export type OtpSender = {
  readonly id: string;
  /** Returns the code to store. The transport is the implementation's problem. */
  send(phoneE164: string): Promise<string>;
};

export const DEV_OTP_CODE = "123456";

export class DevOtpSender implements OtpSender {
  readonly id = "dev";

  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "DevOtpSender cannot run in production. Every phone would accept " +
          `${DEV_OTP_CODE}. Set OTP_PROVIDER=msg91 and configure it.`,
      );
    }
    if (env.OTP_DEV_MODE !== "on") {
      throw new Error(
        "DevOtpSender needs OTP_DEV_MODE=on. It is deliberately awkward: a " +
          "fixed one-time code is a development convenience, never a default.",
      );
    }
  }

  async send(phoneE164: string): Promise<string> {
    // Logged, because a developer needs to see it and because a log line is a
    // standing reminder of which sender is running.
    console.warn(
      `[otp:dev] ${phoneE164} → ${DEV_OTP_CODE} (fixed code, development only)`,
    );
    return DEV_OTP_CODE;
  }
}

export class Msg91OtpSender implements OtpSender {
  readonly id = "msg91";

  // Plain fields rather than TypeScript parameter properties: Node's
  // type-stripping runs without a compiler and cannot desugar them.
  private readonly authKey: string;
  private readonly templateId: string;

  constructor(authKey: string, templateId: string) {
    if (!authKey || !templateId) {
      throw new Error("MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are both required");
    }
    this.authKey = authKey;
    this.templateId = templateId;
  }

  async send(_phoneE164: string): Promise<string> {
    // Deliberately unimplemented rather than silently falling back to the dev
    // code. When the account exists: generate six random digits, POST them to
    // MSG91's flow endpoint with `this.authKey` and `this.templateId`, and
    // return them for hashing.
    throw new Error(
      `MSG91 is selected (template ${this.templateId}) but send() is not ` +
        "implemented. Implement it before setting OTP_PROVIDER=msg91.",
    );
  }
}

/**
 * Does this sender put a real message on a real phone?
 *
 * Asked by the rate limiter, which prices `/auth/otp/request` in SMS — money
 * out, and somebody's handset buzzing whether or not they asked for it. That
 * price is real for every sender here except the development one, which writes
 * a line to the console.
 *
 * A function beside the senders rather than a check at the call site, so that
 * adding a fourth sender means answering this question about it. The default is
 * the safe one: anything that is not the dev sender is assumed to cost money.
 */
export function sendsRealMessages(sender: OtpSender): boolean {
  return sender.id !== "dev";
}

/**
 * Pick a sender from the environment.
 *
 * Defaults to nothing. An unset `OTP_PROVIDER` is a configuration mistake, and
 * guessing on the caller's behalf is how the wrong one gets used.
 */
export function otpSenderFrom(env: NodeJS.ProcessEnv = process.env): OtpSender {
  switch (env.OTP_PROVIDER) {
    case "dev":
      return new DevOtpSender(env);
    case "msg91":
      return new Msg91OtpSender(env.MSG91_AUTH_KEY ?? "", env.MSG91_TEMPLATE_ID ?? "");
    default:
      throw new Error(
        `OTP_PROVIDER must be "dev" or "msg91", got ${env.OTP_PROVIDER ?? "nothing"}`,
      );
  }
}
