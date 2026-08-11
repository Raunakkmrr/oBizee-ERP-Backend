/**
 * One job, in full — PRD §6.5.
 *
 * **The one decision:** *can the person holding this phone finish this visit
 * without ringing the office?* Which is why the address carries a landmark on
 * its own line (an Indian address is resolved by landmark, not by pincode), the
 * access note travels with it, and the asset's last three services are here
 * rather than a click away — a technician standing at a gate cannot navigate.
 *
 * `contract.coverage` is on the payload for FR-504: whether a consumed part is
 * billable is decided by coverage alone, and the technician needs to know that
 * *while* logging the part, not when the office raises the invoice.
 */
import { and, desc, eq } from "drizzle-orm";

import { PRICE_FIELDS, stripFields } from "../auth/context.ts";
import { can } from "../auth/roles.ts";
import { db } from "../db/client.ts";
import {
  assets,
  contacts,
  contractSchedules,
  contracts,
  customers,
  invoices,
  jobEvents,
  jobParts,
  jobs,
  signOffs,
  sites,
  users,
} from "../db/schema.ts";
import { apiRouter } from "../lib/router.ts";

export const jobDetailRoutes = apiRouter();

function clockWord(at: Date): string {
  return at.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

function dayWord(at: Date | string | null): string | null {
  if (!at) return null;
  const d = typeof at === "string" ? new Date(`${at}T00:00:00`) : at;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** In-flight states have an elapsed time worth showing; finished ones do not. */
const IN_FLIGHT = ["EN_ROUTE", "ON_SITE", "PARTS_AWAITED"];

/** `J-2608-0431` — the form a coordinator reads down the phone (FR-210). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

jobDetailRoutes.get("/:id", async (c) => {
  const caller = c.get("caller");
  const key = c.req.param("id");

  /*
    Accepts either the id or the job number.

    The screen's URL is `/jobs/J-2608-0431`, deliberately: the number is what
    gets read aloud on a call and typed into a browser afterwards. Taking only
    a uuid meant every load of that page answered 400 — the number is not a
    malformed id, it is the other way of naming the same job.
  */
  const identifies = UUID.test(key) ? eq(jobs.id, key) : eq(jobs.jobNumber, key);

  const seesAll = can(caller.role, "job:read", undefined, caller.level);
  const seesOwn = can(caller.role, "job:read_own", undefined, caller.level);
  if (!seesAll && !seesOwn) {
    return c.json(
      { error: `A ${caller.role} cannot do this`, needs: "job:read", role: caller.role },
      403,
    );
  }

  const [row] = await db
    .select({
      job: jobs,
      customer: customers.name,
      site: sites,
      technician: users.name,
    })
    .from(jobs)
    .innerJoin(customers, eq(jobs.customerId, customers.id))
    .innerJoin(sites, eq(jobs.siteId, sites.id))
    .leftJoin(users, eq(jobs.primaryTechnicianId, users.id))
    .where(and(identifies, eq(jobs.tenantId, caller.tenantId)))
    .limit(1);

  if (!row) return c.json({ error: "No such job" }, 404);

  // Everything below joins on the resolved row, not on what the caller typed.
  const id = row.job.id;

  // FR-306: a technician may open his own job and no one else's.
  if (!seesAll && row.job.primaryTechnicianId !== caller.userId) {
    return c.json({ error: "That job is not yours", needs: "job:read", role: caller.role }, 403);
  }

  const [events, parts, signOff, invoice, contractRow, siteContacts, siteAssets] =
    await Promise.all([
      db
        .select({
          id: jobEvents.id,
          label: jobEvents.label,
          occurredAt: jobEvents.occurredAt,
          offline: jobEvents.offline,
          place: jobEvents.place,
          actor: users.name,
        })
        .from(jobEvents)
        .leftJoin(users, eq(jobEvents.actorUserId, users.id))
        .where(and(eq(jobEvents.tenantId, caller.tenantId), eq(jobEvents.jobId, id)))
        .orderBy(desc(jobEvents.occurredAt)),
      db.select().from(jobParts).where(eq(jobParts.jobId, id)),
      db
        .select()
        .from(signOffs)
        .where(and(eq(signOffs.tenantId, caller.tenantId), eq(signOffs.jobId, id)))
        .limit(1),
      db
        .select({ number: invoices.number })
        .from(invoices)
        .where(and(eq(invoices.tenantId, caller.tenantId), eq(invoices.jobId, id)))
        .limit(1),
      row.job.contractScheduleId
        ? db
            .select({ reference: contracts.reference, coverage: contracts.coverage })
            .from(contractSchedules)
            .innerJoin(contracts, eq(contractSchedules.contractId, contracts.id))
            .where(eq(contractSchedules.id, row.job.contractScheduleId))
            .limit(1)
        : Promise.resolve([]),
      db
        .select()
        .from(contacts)
        .where(and(eq(contacts.tenantId, caller.tenantId), eq(contacts.siteId, row.job.siteId))),
      db
        .select()
        .from(assets)
        .where(and(eq(assets.tenantId, caller.tenantId), eq(assets.siteId, row.job.siteId))),
    ]);

  // The last transition into the state the job is in now.
  const statusSince =
    IN_FLIGHT.includes(row.job.status) && events.length > 0
      ? `since ${clockWord(events[0]!.occurredAt)}`
      : null;

  /*
    One asset per site is the common case and the only one this screen can show
    honestly — a job is not yet tied to a specific unit. When a site holds
    several, showing the first would be a guess, so it shows none.
  */
  const asset = siteAssets.length === 1 ? siteAssets[0]! : null;

  const lastServices = asset
    ? await db
        .select({
          scheduledDate: jobs.scheduledDate,
          serviceType: jobs.serviceType,
          status: jobs.status,
          technician: users.name,
        })
        .from(jobs)
        .leftJoin(users, eq(jobs.primaryTechnicianId, users.id))
        .where(and(eq(jobs.tenantId, caller.tenantId), eq(jobs.siteId, row.job.siteId)))
        .orderBy(desc(jobs.scheduledDate))
        .limit(4)
    : [];

  const detail = {
    id: row.job.id,
    jobNumber: row.job.jobNumber,
    status: row.job.status,
    statusSince,
    priority: row.job.priority,
    customer: row.customer,
    serviceType: row.job.serviceType,
    /*
      When the work is for.

      Both of these were on the selected row all along and neither reached the
      response, so the one screen devoted to a single job could not say what day
      it happened on. FR-203 is explicit that a schedule is **a date and a
      slot**, and the detail page was showing neither — which also meant nothing
      on it could be marked late, because it did not know there was a date to
      have passed.
    */
    scheduledDate: row.job.scheduledDate,
    slot: row.job.slot,
    visit:
      row.job.visitNumber !== null && row.job.visitOf !== null
        ? { n: row.job.visitNumber, of: row.job.visitOf }
        : null,
    technician: row.job.primaryTechnicianId
      ? { id: row.job.primaryTechnicianId, name: row.technician ?? "—" }
      : null,
    valuePaise: row.job.valuePaise,

    site: {
      addressLine: row.site.addressLine1,
      landmark: row.site.landmark,
      locality: row.site.locality ?? "—",
      pincode: row.site.pincode ?? "",
      // What a maps app is actually given. Coordinates when we have them,
      // because a pin beats a string an Indian geocoder will guess at.
      mapQuery:
        row.site.lat !== null && row.site.lng !== null
          ? `${row.site.lat},${row.site.lng}`
          : [row.site.addressLine1, row.site.locality, row.site.city, row.site.pincode]
              .filter(Boolean)
              .join(", "),
      accessNotes: row.site.accessNotes,
      contacts: siteContacts.map((x) => ({
        name: x.name,
        role: x.roleLabel,
        phone: x.phoneE164 ?? "",
      })),
    },

    asset: asset
      ? {
          description: `${asset.make} ${asset.model} ${asset.assetType.toLowerCase()}`,
          serial: asset.serialNumber,
          warrantyTo: dayWord(asset.warrantyExpiry),
          lastServices: lastServices
            .filter((s) => s.scheduledDate !== null)
            .slice(0, 3)
            .map((s) => ({
              date: dayWord(s.scheduledDate) ?? "",
              technician: s.technician ?? "Unassigned",
              summary: `${s.serviceType} — ${s.status.toLowerCase().replace(/_/g, " ")}`,
            })),
          // A third failure in a year is a different conversation from a first.
          repeatFailure: asset.repeatFailure
            ? "This unit has failed more than once — check the last two visits before quoting."
            : null,
        }
      : null,

    timeline: events.map((ev) => ({
      id: ev.id,
      label: ev.label,
      actor: ev.actor ?? "System",
      at: clockWord(ev.occurredAt),
      // §6.5.2: an event captured offline is normal, and says so plainly.
      offline: ev.offline,
      place: ev.place,
    })),

    parts: parts.map((p) => ({
      name: p.name,
      qty: p.qty,
      unit: p.unit ?? "no.",
      ratePaise: p.ratePaise ?? 0,
      code: p.code ?? "8532",
      ratePercent: p.ratePercent ?? 18,
    })),

    contract: contractRow[0] ?? null,

    signOff: signOff[0]
      ? {
          signerName: signOff[0].signerName,
          at: dayWord(signOff[0].signedAt) ?? "",
          rating: signOff[0].rating ?? 5,
          signatureUploaded: signOff[0].signatureUploaded,
        }
      : null,

    invoiceNumber: invoice[0]?.number ?? null,
  };

  // FR-1302: the price is absent for a role that may not see it, not blanked.
  return c.json(
    can(caller.role, "price:view_selling", undefined, caller.level)
      ? detail
      : stripFields([detail], PRICE_FIELDS as readonly (keyof typeof detail)[])[0],
  );
});
