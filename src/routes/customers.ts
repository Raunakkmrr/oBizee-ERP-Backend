import { zBody } from "../lib/validate.ts";
import { z } from "zod";
import { and, asc, eq, sum } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  assets,
  contacts,
  customers,
  invoices,
  jobs,
  payments,
  sites,
  users,
} from "../db/schema.ts";
import { requirePermission, type AppEnv } from "../auth/context.ts";
import { apiRouter } from "../lib/router.ts";
import { e164 } from "../lib/phone.ts";
import { audit } from "../lib/audit.ts";

/**
 * Customers and their sites — FR-201, FR-202.
 *
 * A customer is created **with** their first site, because a customer with no
 * site has no place of supply and cannot be billed. Half a record blocks the
 * thing the record exists to enable, and the web app already learned that the
 * hard way.
 *
 * Every query filters on the caller's tenant. That is not defensive style, it
 * is the whole isolation model: the tenant comes off the token, so a handler
 * cannot be written without it.
 */
export const customerRoutes = apiRouter();

/** `8 Feb 2028` — dates are read by people, not parsers. */
function dateWord(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

customerRoutes.get("/", requirePermission("customer:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const today = new Date();

  const rows = await db
    .select()
    .from(customers)
    .where(eq(customers.tenantId, tenantId))
    .orderBy(asc(customers.name));

  const [allSites, allContacts, allAssets, history, billed, received] = await Promise.all([
    db.select().from(sites).where(eq(sites.tenantId, tenantId)),
    db.select().from(contacts).where(eq(contacts.tenantId, tenantId)),
    db.select().from(assets).where(eq(assets.tenantId, tenantId)),
    /*
      The service history a site has actually had. Built from jobs rather than
      stored twice: a timeline that can drift from the job board is a timeline
      nobody trusts.
    */
    db
      .select({
        id: jobs.id,
        siteId: jobs.siteId,
        jobNumber: jobs.jobNumber,
        scheduledDate: jobs.scheduledDate,
        serviceType: jobs.serviceType,
        status: jobs.status,
        technician: users.name,
      })
      .from(jobs)
      .leftJoin(users, eq(jobs.primaryTechnicianId, users.id))
      .where(eq(jobs.tenantId, tenantId)),
    /*
      Issued invoices only — a cancelled one charges nobody and a draft is not
      a document yet.

      Both sides summed every invoice regardless of status, so a customer whose
      bills had been cancelled still showed the money as outstanding, and the
      Customers screen and the Money screen gave different answers for the same
      customer. `money.ts` already scopes its receivables this way; this is the
      copy that drifted.
    */
    db
      .select({ customerId: invoices.customerId, total: sum(invoices.grandTotalPaise) })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), eq(invoices.status, "ISSUED")))
      .groupBy(invoices.customerId),
    // Scoped the same way, or money paid against a cancelled bill would show as
    // a credit reducing what is genuinely owed on the live ones.
    db
      .select({ customerId: invoices.customerId, total: sum(payments.amountPaise) })
      .from(payments)
      .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
      .where(and(eq(payments.tenantId, tenantId), eq(invoices.status, "ISSUED")))
      .groupBy(invoices.customerId),
  ]);

  const billedBy = new Map(billed.map((r) => [r.customerId, Number(r.total ?? 0)]));
  const paidBy = new Map(received.map((r) => [r.customerId, Number(r.total ?? 0)]));

  return c.json({
    customers: rows.map((customer) => ({
      ...customer,
      // Derived, never a stored figure somebody has to keep in step.
      outstandingPaise: (billedBy.get(customer.id) ?? 0) - (paidBy.get(customer.id) ?? 0),
      sites: allSites
        .filter((s) => s.customerId === customer.id)
        .map((site) => ({
          ...site,
          contacts: allContacts.filter((x) => x.siteId === site.id).map((x) => ({
            id: x.id,
            name: x.name,
            phone: x.phoneE164,
            whatsapp: x.whatsappE164,
            roleLabel: x.roleLabel,
            isPrimary: x.isPrimary,
          })),
          assets: allAssets.filter((x) => x.siteId === site.id).map((x) => ({
            id: x.id,
            assetType: x.assetType,
            make: x.make,
            model: x.model,
            serialNumber: x.serialNumber,
            locationInSite: x.locationInSite ?? "",
            condition: x.condition,
            warrantyExpiry: x.warrantyExpiry
              ? {
                  dateWord: dateWord(x.warrantyExpiry) ?? x.warrantyExpiry,
                  daysLeft: Math.round(
                    (new Date(`${x.warrantyExpiry}T00:00:00`).getTime() - today.getTime()) /
                      86_400_000,
                  ),
                }
              : null,
            repeatFailure: x.repeatFailure,
          })),
          timeline: history
            .filter((h) => h.siteId === site.id && h.scheduledDate !== null)
            .map((h) => ({
              id: h.id,
              dateWord: dateWord(h.scheduledDate) ?? "",
              assetId: null,
              jobNumber: h.jobNumber,
              summary: `${h.serviceType} — ${h.status.toLowerCase().replace(/_/g, " ")}`,
              technician: h.technician ?? "Unassigned",
            })),
        })),
    })),
  });
});

customerRoutes.get("/:id", requirePermission("customer:read"), async (c) => {
  const { tenantId } = c.get("caller");
  const id = c.req.param("id");

  const [customer] = await db
    .select()
    .from(customers)
    // Both conditions, always. Filtering on id alone would serve another
    // tenant's customer to anyone who guessed a uuid.
    .where(and(eq(customers.id, id), eq(customers.tenantId, tenantId)))
    .limit(1);

  if (!customer) return c.json({ error: "No such customer" }, 404);

  const rows = await db.select().from(sites).where(eq(sites.customerId, customer.id));
  return c.json({ ...customer, sites: rows });
});

const newCustomer = z.object({
  name: z.string().trim().min(2).max(120),
  customerType: z.enum(["INDIVIDUAL", "BUSINESS"]),
  gstin: z
    .string()
    .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/)
    .nullable()
    .optional(),
  creditDays: z.number().int().min(0).max(365).default(30),
  site: z.object({
    label: z.string().trim().min(1),
    addressLine1: z.string().trim().min(1),
    locality: z.string().trim().min(2),
    city: z.string().trim().min(1),
    /** Decides CGST+SGST versus IGST on every invoice for this site. */
    stateCode: z.string().regex(/^[0-9]{2}$/),
    pincode: z.string().regex(/^[1-8][0-9]{5}$/),
    landmark: z.string().nullable().optional(),
    accessNotes: z.string().nullable().optional(),
  }),
  /*
    Who to ring at this site.

    The form has always collected one and the register had nowhere to put it,
    so it was posted and silently dropped — leaving every new customer with a
    site nobody could be called about, which is the one thing the collections
    list and the job card both need.
  */
  contact: z
    .object({
      name: z.string().trim().min(2),
      /*
        Refused at the door rather than stored as typed. A number this cannot
        normalise is one FR-102's duplicate check can never match, so storing
        it puts a customer on file and makes them invisible — and the message
        here is the same one the sign-in route gives, because it is the same
        fact about the same number.
      */
      phone: z
        .string()
        .trim()
        .min(1)
        .refine((value) => e164(value) !== null, {
          message: "That is not a phone number this system can dial",
        }),
      roleLabel: z
        .enum(["OWNER", "SITE_INCHARGE", "TENANT", "SECURITY", "ACCOUNTS", "OTHER"])
        .default("SITE_INCHARGE"),
    })
    .nullable()
    .optional(),
});

customerRoutes.post(
  "/",
  requirePermission("customer:write"),
  zBody( newCustomer),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    const [customer] = await db
      .insert(customers)
      .values({
        tenantId: caller.tenantId,
        name: body.name,
        customerType: body.customerType,
        gstin: body.gstin ?? null,
        // The site's state until a separate billing address is captured.
        billingStateCode: body.site.stateCode,
        creditDays: body.creditDays,
      })
      .returning();

    const [site] = await db
      .insert(sites)
      .values({
        tenantId: caller.tenantId,
        customerId: customer!.id,
        label: body.site.label,
        addressLine1: body.site.addressLine1,
        locality: body.site.locality,
        city: body.site.city,
        stateCode: body.site.stateCode,
        pincode: body.site.pincode,
        landmark: body.site.landmark ?? null,
        accessNotes: body.site.accessNotes ?? null,
      })
      .returning();

    /*
      The first contact is the primary one: "who do I ring" must have exactly
      one answer, and the only sensible answer for a site with one contact is
      that contact.
    */
    const contact = body.contact
      ? (
          await db
            .insert(contacts)
            .values({
              tenantId: caller.tenantId,
              siteId: site!.id,
              name: body.contact.name,
              /*
                Normalised or refused — never the raw input. Falling back to
                what was typed stored a number FR-102's duplicate check can
                never match, so the customer was on file and invisible, and
                nothing anywhere said so. The database now refuses it too.
              */
              phoneE164: e164(body.contact.phone) ?? "",
              whatsappE164: e164(body.contact.phone),
              roleLabel: body.contact.roleLabel,
              isPrimary: true,
            })
            .returning()
        )[0]
      : null;

    await audit(caller, "ADD_CUSTOMER", `Added ${body.name} to the customer register`, {
      table: "customers",
      id: customer!.id,
    });

    return c.json({ ...customer, sites: [{ ...site, contacts: contact ? [contact] : [] }] }, 201);
  },
);

/**
 * Adding somebody to ring at a site that already exists — FR-202.
 *
 * **Why this had to exist.** The customer screen has always warned "No contact
 * recorded — nobody to call on arrival. Add a name and number before the next
 * visit", and the product had nowhere to add one: the only route into the
 * `contacts` table was the optional block on customer creation, so a site that
 * arrived without a contact — every converted lead, until conversion learned to
 * carry the number — stayed uncallable forever. A screen that instructs an
 * action it does not offer is worse than one that says nothing.
 *
 * `customer:write`, the same permission that created the site. A coordinator
 * ringing ahead is the person who discovers the number is missing, and sending
 * them to find the owner is how it stays missing.
 */
const addContact = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z
    .string()
    .trim()
    .refine((v) => e164(v) !== null, {
      message: "That does not look like an Indian mobile number",
    }),
  roleLabel: z
    .enum(["OWNER", "SITE_INCHARGE", "TENANT", "SECURITY", "ACCOUNTS", "OTHER"])
    .default("SITE_INCHARGE"),
});

customerRoutes.post(
  "/:customerId/sites/:siteId/contacts",
  requirePermission("customer:write"),
  zBody(addContact),
  async (c) => {
    const caller = c.get("caller");
    const { customerId, siteId } = c.req.param();
    const body = c.req.valid("json");

    /*
      The site is checked against the caller's tenant *and* the customer in the
      path. Trusting the site id alone would let a correct-looking request file
      a contact under another firm's site, and trusting the customer id alone
      would file it against the wrong site of the right customer.
    */
    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(
        and(
          eq(sites.id, siteId),
          eq(sites.customerId, customerId),
          eq(sites.tenantId, caller.tenantId),
        ),
      )
      .limit(1);
    if (!site) return c.json({ error: "No such site for that customer" }, 404);

    const existing = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.siteId, siteId), eq(contacts.tenantId, caller.tenantId)));

    const phone = e164(body.phone)!;
    const [contact] = await db
      .insert(contacts)
      .values({
        tenantId: caller.tenantId,
        siteId,
        name: body.name,
        phoneE164: phone,
        whatsappE164: phone,
        roleLabel: body.roleLabel,
        // First one in is the one to ring; later ones do not silently displace
        // a primary somebody chose.
        isPrimary: existing.length === 0,
      })
      .returning();

    await audit(caller, "ADD_CONTACT", `Added ${body.name} as a contact for the site`, {
      table: "contacts",
      id: contact!.id,
    });

    return c.json(contact, 201);
  },
);
