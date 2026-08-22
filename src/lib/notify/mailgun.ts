/**
 * Email through Mailgun.
 *
 * **Chosen for the free tier, and the free tier has two edges worth knowing
 * before anyone relies on it:**
 *
 * 1. **5,000 a month, 100 a day**, and *every recipient counts separately*. At
 *    ~25 visits a day with two lead times, per-job email to the office alone
 *    would breach the daily cap — which is the arithmetic behind the office
 *    receiving one digest rather than one message per job.
 * 2. **A sandbox domain reaches only five authorised addresses.** Real
 *    customers need the verified custom domain, and sending to arbitrary
 *    recipients needs a card on file even inside the free allowance.
 *
 * Neither is a reason to avoid Mailgun; both are reasons the volume estimate
 * belongs next to the code that spends it.
 *
 * No SDK: this is one form-encoded POST, and a dependency for that is a
 * dependency to keep patched forever.
 */
import type { Outgoing, SendResult, Sender } from "./sender.ts";

export class MailgunSender implements Sender {
  readonly id = "mailgun";
  readonly channel = "email" as const;

  private readonly apiKey: string;
  private readonly domain: string;
  private readonly from: string;
  /** EU accounts are a different host, and the wrong one 401s confusingly. */
  private readonly base: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const apiKey = env.MAILGUN_API_KEY;
    const domain = env.MAILGUN_DOMAIN;
    if (!apiKey || !domain) {
      throw new Error(
        "MailgunSender needs MAILGUN_API_KEY and MAILGUN_DOMAIN. Refusing to " +
          "construct rather than failing on the first reminder, so a misconfigured " +
          "deployment stops at boot instead of silently telling nobody.",
      );
    }
    this.apiKey = apiKey;
    this.domain = domain;
    this.from = env.MAILGUN_FROM ?? `oBizee <no-reply@${domain}>`;
    this.base = env.MAILGUN_REGION === "eu"
      ? "https://api.eu.mailgun.net"
      : "https://api.mailgun.net";
  }

  async send(message: Outgoing): Promise<SendResult> {
    const form = new URLSearchParams({
      from: this.from,
      to: message.to,
      subject: message.subject ?? "Reminder",
      text: message.body,
    });

    let response: Response;
    try {
      response = await fetch(`${this.base}/v3/${this.domain}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${this.apiKey}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form,
        // A hung request must not hold the drain open behind it.
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      // Network and timeout: the message may yet be deliverable, so retry.
      return { ok: false, error: `mailgun unreachable: ${String(cause)}`, retryable: true };
    }

    if (response.ok) {
      const body = (await response.json().catch(() => ({}))) as { id?: string };
      return { ok: true, providerId: body.id ?? "accepted" };
    }

    const detail = await response.text().catch(() => "");
    /*
      4xx is our mistake — a bad address, an unauthorised sandbox recipient, a
      wrong key. Retrying cannot fix any of them, and doing so would keep the
      failure out of the human's sight, which is the one outcome this system
      cannot afford. 5xx and 429 are Mailgun's, and worth trying again.
    */
    const retryable = response.status >= 500 || response.status === 429;
    return {
      ok: false,
      error: `mailgun ${response.status}: ${detail.slice(0, 300)}`,
      retryable,
    };
  }
}
