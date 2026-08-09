/**
 * Stock control — PRD §6.14, FR-601 to FR-604.
 *
 * **The one decision:** *what do I need to buy, and where has the rest gone?*
 * Not a warehouse system — a service firm's van stock, which is a different
 * problem: the stock is mobile, it is consumed on jobs, and the person holding
 * it is out of the office.
 *
 * **On hand is summed from the movement ledger, never stored.** A balance and
 * a history are two records of one fact, and the day they disagree nothing can
 * say which is right. Summing is slower and always true — and it is what makes
 * the negative-balance exception detectable at all, because a stored balance
 * would simply have been overwritten.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { requirePermission } from "../auth/context.ts";
import { db } from "../db/client.ts";
import {
  jobParts,
  jobs,
  parts,
  stockLocations,
  stockMovements,
  users,
  vendors,
} from "../db/schema.ts";
import { audit } from "../lib/audit.ts";
import { apiRouter } from "../lib/router.ts";
import { zBody } from "../lib/validate.ts";

export const partRoutes = apiRouter();

/** Ninety days, the window a reorder decision is actually made against. */
const CONSUMPTION_WINDOW_DAYS = 90;

type Balance = Map<string, number>;

/** `partId:locationId` — the grain a stock count is taken at. */
const cell = (partId: string, locationId: string) => `${partId}:${locationId}`;

partRoutes.get("/", requirePermission("part:read"), async (c) => {
  const { tenantId } = c.get("caller");

  const [catalogue, locations, movements, consumed, uncatalogued] = await Promise.all([
    db
      .select({
        id: parts.id,
        name: parts.name,
        code: parts.code,
        reorderLevel: parts.reorderLevel,
        unitCostPaise: parts.unitCostPaise,
        vendor: vendors.name,
      })
      .from(parts)
      .leftJoin(vendors, eq(parts.preferredVendorId, vendors.id))
      .where(and(eq(parts.tenantId, tenantId), eq(parts.active, true)))
      .orderBy(asc(parts.name)),
    db
      .select({
        id: stockLocations.id,
        name: stockLocations.name,
        kind: stockLocations.kind,
        technicianName: users.name,
      })
      .from(stockLocations)
      .leftJoin(users, eq(stockLocations.technicianId, users.id))
      .where(and(eq(stockLocations.tenantId, tenantId), eq(stockLocations.active, true)))
      .orderBy(asc(stockLocations.kind), asc(stockLocations.name)),
    db
      .select({
        partId: stockMovements.partId,
        fromLocationId: stockMovements.fromLocationId,
        toLocationId: stockMovements.toLocationId,
        qty: stockMovements.qty,
      })
      .from(stockMovements)
      .where(eq(stockMovements.tenantId, tenantId)),
    db
      .select({
        partId: stockMovements.partId,
        qty: sql<string>`sum(${stockMovements.qty})`,
      })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.tenantId, tenantId),
          eq(stockMovements.kind, "CONSUME"),
          sql`${stockMovements.occurredAt} > now() - interval '${sql.raw(String(CONSUMPTION_WINDOW_DAYS))} days'`,
        ),
      )
      .groupBy(stockMovements.partId),
    /*
      Parts fitted on jobs that are not in the catalogue.

      §6.14's second exception. A technician writes "capacitor 40uF" on a job
      card, nobody adds it to the catalogue, and it is bought again next month
      because no reorder level exists for a part the system has never heard of.
    */
    db
      .select({ name: jobParts.name, jobId: jobParts.jobId })
      .from(jobParts)
      .where(eq(jobParts.tenantId, tenantId)),
  ]);

  /* Balances, summed. In minus out, per part per location. */
  const balance: Balance = new Map();
  for (const move of movements) {
    if (move.toLocationId) {
      const key = cell(move.partId, move.toLocationId);
      balance.set(key, (balance.get(key) ?? 0) + move.qty);
    }
    if (move.fromLocationId) {
      const key = cell(move.partId, move.fromLocationId);
      balance.set(key, (balance.get(key) ?? 0) - move.qty);
    }
  }

  const consumedBy = new Map(consumed.map((row) => [row.partId, Number(row.qty ?? 0)]));
  const byName = new Map(catalogue.map((part) => [part.name.toLowerCase(), part]));

  const onHandOf = (partId: string) =>
    locations.reduce((sum, place) => sum + (balance.get(cell(partId, place.id)) ?? 0), 0);

  /*
    What to buy. Everything at or below its level, worst first.

    Monthly consumption is on the row because "3 left" means nothing on its
    own: three is a fortnight for one part and a year for another, and the
    reorder decision is the ratio, not the count.
  */
  const reorder = catalogue
    .map((part) => ({
      id: part.id,
      name: part.name,
      hsn: part.code,
      onHand: onHandOf(part.id),
      reorderLevel: part.reorderLevel,
      monthlyConsumption: Math.round((consumedBy.get(part.id) ?? 0) / 3),
      preferredVendor: part.vendor,
      unitCostPaise: part.unitCostPaise,
    }))
    .filter((row) => row.reorderLevel > 0 && row.onHand <= row.reorderLevel)
    .sort((a, b) => a.onHand - b.onHand);

  const stockAt = locations.map((place) => ({
    id: place.id,
    name: place.name,
    kind: place.kind,
    technicianName: place.technicianName,
    lines: catalogue
      .map((part) => ({
        partId: part.id,
        partName: part.name,
        qty: balance.get(cell(part.id, place.id)) ?? 0,
      }))
      // A location lists what it holds. Zero is not holding it.
      .filter((line) => line.qty !== 0),
  }));

  /* §6.14's three exceptions, each with its own remedy. */
  const exceptions: {
    id: string;
    kind: string;
    partName: string;
    detail: string;
    qty: number | null;
    raisedBy: string | null;
    raisedOn: string;
  }[] = [];

  for (const place of locations) {
    for (const part of catalogue) {
      const qty = balance.get(cell(part.id, place.id)) ?? 0;
      if (qty >= 0) continue;
      exceptions.push({
        id: `negative:${part.id}:${place.id}`,
        kind: "NEGATIVE_ON_HAND",
        partName: part.name,
        detail: `${place.name} shows ${qty}. Something was fitted that was never issued, or an issue was never recorded.`,
        qty,
        raisedBy: null,
        raisedOn: new Date().toISOString(),
      });
    }
  }

  const seenUncatalogued = new Set<string>();
  for (const fitted of uncatalogued) {
    const key = fitted.name.toLowerCase();
    if (byName.has(key) || seenUncatalogued.has(key)) continue;
    seenUncatalogued.add(key);
    exceptions.push({
      id: `uncatalogued:${key}`,
      kind: "UNCATALOGUED",
      partName: fitted.name,
      detail:
        "Fitted on a job but not in the catalogue, so it has no reorder level and nobody is told when it runs out.",
      qty: null,
      raisedBy: null,
      raisedOn: new Date().toISOString(),
    });
  }

  /*
    Rule 55: goods that move without a supply still travel on a document. A van
    loaded with no challan is stock the firm cannot account for in transit.
  */
  const undocumented = await db
    .select({
      id: stockMovements.id,
      qty: stockMovements.qty,
      occurredAt: stockMovements.occurredAt,
      partName: parts.name,
      actor: users.name,
    })
    .from(stockMovements)
    .innerJoin(parts, eq(stockMovements.partId, parts.id))
    .leftJoin(users, eq(stockMovements.actorUserId, users.id))
    .where(
      and(
        eq(stockMovements.tenantId, tenantId),
        eq(stockMovements.kind, "ISSUE_TO_VAN"),
        sql`${stockMovements.challanNumber} is null`,
      ),
    )
    .orderBy(desc(stockMovements.occurredAt))
    .limit(20);

  for (const move of undocumented) {
    exceptions.push({
      id: `challan:${move.id}`,
      kind: "ISSUE_WITHOUT_CHALLAN",
      partName: move.partName,
      detail: "Issued to a van with no delivery challan recorded.",
      qty: move.qty,
      raisedBy: move.actor,
      raisedOn: move.occurredAt.toISOString(),
    });
  }

  return c.json({ reorder, locations: stockAt, exceptions });
});

/* ------------------------------------------------------------------ writes */

partRoutes.post(
  "/",
  requirePermission("part:purchase"),
  zBody(
    z.object({
      name: z.string().trim().min(2).max(120),
      code: z.string().trim().min(4).max(8),
      unit: z.string().trim().min(1).max(12).default("no"),
      reorderLevel: z.number().int().min(0).max(100_000).default(0),
      preferredVendorId: z.string().uuid().nullable().optional(),
      unitCostPaise: z.number().int().min(0).nullable().optional(),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    const [part] = await db
      .insert(parts)
      .values({
        tenantId: caller.tenantId,
        name: body.name,
        code: body.code,
        unit: body.unit,
        reorderLevel: body.reorderLevel,
        preferredVendorId: body.preferredVendorId ?? null,
        unitCostPaise: body.unitCostPaise ?? null,
      })
      .returning({ id: parts.id, name: parts.name });

    await audit(caller, "ADD_PART", `Catalogued ${body.name}`, { table: "parts", id: part!.id });
    return c.json(part, 201);
  },
);

partRoutes.post(
  "/locations",
  requirePermission("part:issue_to_van"),
  zBody(
    z.object({
      name: z.string().trim().min(2).max(80),
      kind: z.enum(["STORE", "VAN"]),
      technicianId: z.string().uuid().nullable().optional(),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    // §6.14: a van is named by whose it is, so it cannot exist without one.
    if (body.kind === "VAN" && !body.technicianId) {
      return c.json(
        { error: "A van belongs to a technician — say whose it is.", field: "technicianId" },
        400,
      );
    }

    const [place] = await db
      .insert(stockLocations)
      .values({
        tenantId: caller.tenantId,
        name: body.name,
        kind: body.kind,
        technicianId: body.technicianId ?? null,
        branchId: caller.branchId ?? null,
      })
      .returning({ id: stockLocations.id, name: stockLocations.name });

    return c.json(place, 201);
  },
);

/**
 * Record a movement — FR-602 to FR-604.
 *
 * One endpoint for every kind, because they are one act with different
 * endpoints on it: stock leaves somewhere and arrives somewhere, and which
 * pair it is decides the kind. Splitting them into four routes would let the
 * four drift.
 */
partRoutes.post(
  "/movements",
  requirePermission("part:consume"),
  zBody(
    z.object({
      partId: z.string().uuid(),
      kind: z.enum(["RECEIPT", "ISSUE_TO_VAN", "RETURN_TO_STORE", "CONSUME", "ADJUSTMENT"]),
      fromLocationId: z.string().uuid().nullable().optional(),
      toLocationId: z.string().uuid().nullable().optional(),
      qty: z.number().int().positive(),
      jobId: z.string().uuid().nullable().optional(),
      challanNumber: z.string().trim().max(40).nullable().optional(),
      note: z.string().trim().max(300).nullable().optional(),
    }),
  ),
  async (c) => {
    const caller = c.get("caller");
    const body = c.req.valid("json");

    if (!body.fromLocationId && !body.toLocationId) {
      return c.json(
        { error: "Say where it came from, where it went, or both." },
        400,
      );
    }

    /*
      An issue to a van needs a challan (Rule 55), but a missing one is
      recorded rather than refused.

      Refusing would stop a technician leaving on a breakdown call at seven in
      the morning because the office has not written the challan yet — which
      makes the rule the reason the job is late. It becomes one of §6.14's
      exceptions instead, on a screen somebody works through.
    */

    const [part] = await db
      .select({ id: parts.id, name: parts.name })
      .from(parts)
      .where(and(eq(parts.id, body.partId), eq(parts.tenantId, caller.tenantId)))
      .limit(1);
    if (!part) return c.json({ error: "No such part" }, 404);

    const [move] = await db
      .insert(stockMovements)
      .values({
        tenantId: caller.tenantId,
        partId: body.partId,
        kind: body.kind,
        fromLocationId: body.fromLocationId ?? null,
        toLocationId: body.toLocationId ?? null,
        qty: body.qty,
        jobId: body.jobId ?? null,
        challanNumber: body.challanNumber ?? null,
        note: body.note ?? null,
        actorUserId: caller.userId,
      })
      .returning({ id: stockMovements.id, kind: stockMovements.kind, qty: stockMovements.qty });

    await audit(
      caller,
      `STOCK_${body.kind}`,
      `${body.qty} × ${part.name}${body.note ? ` — ${body.note}` : ""}`,
      { table: "stock_movements", id: move!.id },
    );

    return c.json(move, 201);
  },
);
