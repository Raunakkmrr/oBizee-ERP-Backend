/**
 * Deciding who to tell about a visit, and when.
 *
 * Pure on purpose, exactly like `billing-periods.ts`: the whole rule is
 * testable without a database, a clock, or a message provider. `today` is
 * passed rather than read, so "what goes out on the 23rd" is an assertion
 * rather than something you wait a day to find out.
 *
 * **The three audiences are not three copies of one message.** A customer is
 * told to expect somebody. A technician is told where to be. The office is told
 * what still has nobody against it — and is told *once*, about the whole day,
 * because twenty-five messages a day to the same five people becomes a mail
 * rule inside a week, and a system nobody reads is worse than no system at all
 * because it is still trusted.
 */

/** FR-203's promise windows, as the customer hears them. */
const SLOT_WORDS: Record<string, string> = {
  "9-1": "9 am and 1 pm",
  "1-5": "1 pm and 5 pm",
  "5-8": "5 pm and 8 pm",
};

export function slotWords(slot: string | null): string {
  return slot ? (SLOT_WORDS[slot] ?? slot) : "the day";
}

export type ReminderKind = "visit_in_7_days" | "visit_tomorrow" | "daily_digest";
export type ReminderChannel = "whatsapp" | "email";
export type ReminderAudience = "customer" | "technician" | "office";

/** How far ahead each kind fires. Raunak asked for both. */
export const LEAD_DAYS: Record<"visit_in_7_days" | "visit_tomorrow", number> = {
  visit_in_7_days: 7,
  visit_tomorrow: 1,
};

export type PlannableJob = {
  id: string;
  jobNumber: string;
  /** `2026-08-24`, the day the visit is promised for. */
  scheduledDate: string | null;
  slot: string | null;
  serviceType: string;
  customerName: string;
  siteLabel: string;
  siteLocality: string;
  status: string;
  /** Null when nobody is assigned — which is what the office needs to know. */
  technician: { id: string; name: string; phoneE164: string | null } | null;
  /** The site contact to write to, already filtered for opt-out by the caller. */
  customerContact: { name: string; phoneE164: string | null; email: string | null } | null;
};

export type PlannedReminder = {
  jobId: string | null;
  kind: ReminderKind;
  channel: ReminderChannel;
  audience: ReminderAudience;
  recipient: string;
  recipientUserId: string | null;
  templateKey: string;
  payload: Record<string, string>;
  body: string;
  subject?: string;
  dedupeKey: string;
};

/**
 * Statuses that no longer want a reminder.
 *
 * A cancelled visit must never be announced, and one already signed off has
 * happened — telling the customer to expect us tomorrow after we have been is
 * the kind of message that costs more trust than the reminder earns.
 */
const DONE_OR_GONE = new Set(["CANCELLED", "SIGNED_OFF", "WORK_DONE"]);

/** `2026-08-24` plus n days, without dragging a Date across a timezone. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** `24 Aug 2026` — dates in a customer's message are read, not parsed. */
export function dayWords(iso: string): string {
  const at = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
}

/**
 * The key that makes sending twice impossible.
 *
 * Spelled out rather than inferred from a composite index, because a digest has
 * no job and Postgres treats nulls as distinct — so a composite would let every
 * run insert a fresh digest and message the office forever.
 */
export function dedupeKey(parts: {
  kind: ReminderKind;
  channel: ReminderChannel;
  recipient: string;
  jobId?: string | null;
  day?: string;
}): string {
  const scope = parts.kind === "daily_digest" ? `digest:${parts.day}` : `job:${parts.jobId}`;
  return `${scope}:${parts.kind}:${parts.channel}:${parts.recipient}`;
}

/**
 * Everything that should go out today, for one tenant.
 *
 * `firmName` appears in every message because a customer with three suppliers
 * cannot act on "your service is due tomorrow" from an unidentified sender.
 */
export function planReminders(input: {
  jobs: readonly PlannableJob[];
  today: string;
  firmName: string;
  /** Where the office digest goes. Empty is legitimate and simply skips it. */
  officeEmails: readonly { email: string; userId: string }[];
}): PlannedReminder[] {
  const planned: PlannedReminder[] = [];

  for (const [kind, days] of Object.entries(LEAD_DAYS) as [
    "visit_in_7_days" | "visit_tomorrow",
    number,
  ][]) {
    const target = addDays(input.today, days);

    for (const job of input.jobs) {
      if (job.scheduledDate !== target) continue;
      if (DONE_OR_GONE.has(job.status)) continue;

      const when = kind === "visit_tomorrow" ? "tomorrow" : `on ${dayWords(target)}`;
      const window = slotWords(job.slot);

      /*
        The technician is deliberately not named to the customer.

        Assignment changes between a reminder and the visit more often than
        anyone admits, and a message naming the wrong person is worse than one
        naming nobody — the customer turns away the man who actually turns up.
      */
      const customerBody =
        `Namaste ${job.customerContact?.name ?? job.customerName}, this is ${input.firmName}. ` +
        // Not lowercased: the service names are the firm's own words and half
        // of them are acronyms, so "Chiller AMC" became "chiller amc".
        `Your ${job.serviceType} at ${job.siteLabel} is due ${when}, ` +
        `between ${window}. Reply here if you need a different time.`;

      const contact = job.customerContact;
      if (contact?.phoneE164) {
        planned.push({
          jobId: job.id,
          kind,
          channel: "whatsapp",
          audience: "customer",
          recipient: contact.phoneE164,
          recipientUserId: null,
          templateKey: `visit_reminder_${kind}`,
          payload: {
            customer: contact.name,
            firm: input.firmName,
            service: job.serviceType,
            date: dayWords(target),
            window,
          },
          body: customerBody,
          dedupeKey: dedupeKey({ kind, channel: "whatsapp", recipient: contact.phoneE164, jobId: job.id }),
        });
      }
      if (contact?.email) {
        planned.push({
          jobId: job.id,
          kind,
          channel: "email",
          audience: "customer",
          recipient: contact.email,
          recipientUserId: null,
          templateKey: `visit_reminder_${kind}`,
          payload: { service: job.serviceType, date: dayWords(target), window },
          subject: `${job.serviceType} at ${job.siteLabel} — ${when}`,
          body: `${customerBody}\n\nSite: ${job.siteLabel}, ${job.siteLocality}\nReference: ${job.jobNumber}`,
          dedupeKey: dedupeKey({ kind, channel: "email", recipient: contact.email, jobId: job.id }),
        });
      }

      // The technician gets the address and the window, and only for his own.
      if (job.technician?.phoneE164) {
        planned.push({
          jobId: job.id,
          kind,
          channel: "whatsapp",
          audience: "technician",
          recipient: job.technician.phoneE164,
          recipientUserId: job.technician.id,
          templateKey: `visit_assigned_${kind}`,
          payload: { job: job.jobNumber, date: dayWords(target), window },
          body:
            `${job.jobNumber} — ${job.customerName}, ${job.siteLabel} (${job.siteLocality}). ` +
            `${job.serviceType}, ${when} between ${window}.`,
          dedupeKey: dedupeKey({
            kind,
            channel: "whatsapp",
            recipient: job.technician.phoneE164,
            jobId: job.id,
          }),
        });
      }
    }
  }

  /*
    One digest for the office, about tomorrow, naming what is still unassigned.

    Raunak asked for every desk employee to be told. Told *once* — the count
    plus the exceptions is the thing they can act on, and a per-job copy is the
    thing they would mute.
  */
  const tomorrow = addDays(input.today, 1);
  const dueTomorrow = input.jobs.filter(
    (j) => j.scheduledDate === tomorrow && !DONE_OR_GONE.has(j.status),
  );
  if (dueTomorrow.length > 0 && input.officeEmails.length > 0) {
    const unassigned = dueTomorrow.filter((j) => !j.technician);
    const lines = dueTomorrow.map(
      (j) =>
        `  ${j.jobNumber}  ${j.customerName} · ${j.siteLocality} · ${slotWords(j.slot)}` +
        `  — ${j.technician?.name ?? "NOBODY ASSIGNED"}`,
    );
    const body =
      `${dueTomorrow.length} visit${dueTomorrow.length === 1 ? "" : "s"} tomorrow, ` +
      `${dayWords(tomorrow)}.` +
      (unassigned.length > 0
        ? ` ${unassigned.length} still ha${unassigned.length === 1 ? "s" : "ve"} nobody assigned.`
        : " All assigned.") +
      `\n\n${lines.join("\n")}`;

    for (const person of input.officeEmails) {
      planned.push({
        jobId: null,
        kind: "daily_digest",
        channel: "email",
        audience: "office",
        recipient: person.email,
        recipientUserId: person.userId,
        templateKey: "office_daily_digest",
        payload: { count: String(dueTomorrow.length), unassigned: String(unassigned.length) },
        subject:
          `Tomorrow: ${dueTomorrow.length} visit${dueTomorrow.length === 1 ? "" : "s"}` +
          (unassigned.length > 0 ? ` · ${unassigned.length} unassigned` : ""),
        body,
        dedupeKey: dedupeKey({
          kind: "daily_digest",
          channel: "email",
          recipient: person.email,
          day: tomorrow,
        }),
      });
    }
  }

  return planned;
}

/**
 * When a message may actually go out.
 *
 * 09:00–19:00 IST. Nobody wants a WhatsApp about pest control at three in the
 * morning, and a business that sends one is the business they mute. Held to the
 * next window rather than dropped — late is recoverable, silent is not.
 */
export const WINDOW_OPENS_IST = 9;
export const WINDOW_CLOSES_IST = 19;

export function sendableAt(now: Date): Date {
  /*
    Worked out in IST, not by nudging the UTC clock.

    The first version read the IST *hour* but then set the time on the **UTC**
    date, and those are different days for most of the Indian evening: at 21:30
    UTC it is already 03:00 tomorrow in Kolkata, so "hold until 09:00" landed on
    09:00 IST *yesterday* — a timestamp in the past, which the drain would have
    sent immediately and at exactly the hour this function exists to avoid.
  */
  const IST_OFFSET_MINUTES = 5 * 60 + 30;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    // Explicit, because a 12-hour cycle reports midnight as 24 and the
    // comparison below would quietly stop holding overnight messages.
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";

  const istDay = `${part("year")}-${part("month")}-${part("day")}`;
  const istHour = Number(part("hour"));

  if (istHour >= WINDOW_OPENS_IST && istHour < WINDOW_CLOSES_IST) return now;

  // Before it opens: this morning. After it closes: tomorrow morning.
  const targetDay = istHour >= WINDOW_CLOSES_IST ? addDays(istDay, 1) : istDay;
  const [y, m, d] = targetDay.split("-").map(Number);
  const minutesFromMidnightUtc = WINDOW_OPENS_IST * 60 - IST_OFFSET_MINUTES;
  return new Date(Date.UTC(y!, m! - 1, d!, 0, minutesFromMidnightUtc, 0, 0));
}
