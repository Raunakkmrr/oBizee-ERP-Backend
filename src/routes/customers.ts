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
    db
      .select({ customerId: invoices.customerId, total: sum(invoices.grandTotalPaise) })
      .from(invoices)
      .where(eq(invoices.tenantId, tenantId))
      .groupBy(invoices.customerId),
    db
      .select({ customerId: invoices.customerId, total: sum(payments.amountPaise) })
      .from(payments)
      .innerJoin(invoices, eq(payments.invoiceId, invoices.id))
      .where(eq(payments.tenantId, tenantId))
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

    await audit(caller, "ADD_CUSTOMER", `Added ${body.name} to the customer register`, {
      table: "customers",
      id: customer!.id,
    });

    return c.json({ ...customer, sites: [site] }, 201);
  },
);
