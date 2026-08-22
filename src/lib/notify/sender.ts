/**
 * Getting a message to a person.
 *
 * **Why an interface with a deliberately awkward development implementation.**
 * This is the same shape as `OtpSender`, and for the same reason. A reminder
 * that silently does nothing is the worst possible failure here: the whole
 * point of building it is that people stop remembering visits themselves, so a
 * quiet no-op means nobody is remembering and nobody knows. The development
 * sender therefore records exactly what it *would* have sent and says so, and
 * refuses to exist in production, where a real provider must be configured.
 *
 * **The provider is not the interesting part.** Whether WhatsApp goes through
 * Meta's Cloud API or an Indian aggregator, and whether email goes through
 * Mailgun or SES, changes one file each. What must not change is the outbox
 * around it: raise the intention, drain it once, record what happened.
 */

export type Outgoing = {
  /** E.164 for WhatsApp, an address for email. */
  readonly to: string;
  /**
   * The approved template this message is an instance of.
   *
   * Business-initiated WhatsApp cannot be free text — outside a 24-hour window
   * opened by the customer, only templates Meta has approved may be sent. So
   * the key and its variables travel together and the body is assembled by the
   * provider, not here.
   */
  readonly templateKey: string;
  readonly variables: Readonly<Record<string, string>>;
  /** Rendered fallback, used by email and by the dev sender's log. */
  readonly subject?: string;
  readonly body: string;
};

export type SendResult =
  | { readonly ok: true; readonly providerId: string }
  /**
   * `retryable` decides whether the drain tries again or gives up and puts it
   * in front of a human. A number that is not on WhatsApp will never succeed,
   * and retrying it forever hides it from the person who could ring instead.
   */
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

export type Sender = {
  readonly id: string;
  readonly channel: "whatsapp" | "email";
  send(message: Outgoing): Promise<SendResult>;
};

/**
 * Records what it would have sent, and sends nothing.
 *
 * This is what makes the whole mechanism demonstrable before a rupee is spent
 * or a Meta template is approved: generation, scheduling, idempotency, the
 * board, the failure path and the audit trail are all exercised, and the only
 * thing missing is the transport.
 */
export class DevSender implements Sender {
  readonly id = "dev";
  readonly sent: Outgoing[] = [];

  /*
    Declared and assigned rather than written as a constructor parameter
    property. `tsc` accepts `constructor(readonly channel: ...)`; Node's
    --experimental-strip-types does not, because stripping types cannot emit the
    assignment it implies. The typecheck passed and the server refused to boot —
    so the rule for this codebase is: no parameter properties.
  */
  readonly channel: "whatsapp" | "email";

  constructor(channel: "whatsapp" | "email", env: NodeJS.ProcessEnv = process.env) {
    this.channel = channel;
    if (env.NODE_ENV === "production") {
      throw new Error(
        `DevSender cannot run in production: every ${channel} reminder would be ` +
          "silently dropped while the product reported them as sent. Configure " +
          "a real provider.",
      );
    }
  }

  async send(message: Outgoing): Promise<SendResult> {
    this.sent.push(message);
    // Logged rather than swallowed, so a developer can see the exact text.
    console.log(
      `[dev ${this.channel}] → ${message.to} · ${message.templateKey}\n${message.body}`,
    );
    return { ok: true, providerId: `dev-${this.sent.length}` };
  }
}
