import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/client.ts";
import { customers, sites } from "../db/schema.ts";
import { requirePermission, type AppEnv } from "../auth/context.ts";
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
export const customerRoutes = new Hono<AppEnv>();

customerRoutes.get("/", requirePermission("customer:read"), async (c) => {
  const { tenantId } = c.get("caller");

  const rows = await db
    .select()
    .from(customers)
    .where(eq(customers.tenantId, tenantId))
    .orderBy(asc(customers.name));

  const allSites = await db
    .select()
    .from(sites)
    .where(eq(sites.tenantId, tenantId));

  return c.json({
    customers: rows.map((customer) => ({
      ...customer,
      sites: allSites.filter((s) => s.customerId === customer.id),
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
  zValidator("json", newCustomer),
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
