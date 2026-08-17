/**
 * The team — who works here, and who may sign in.
 *
 * **Owner only.** `people:manage` is granted to the owner and to nobody else,
 * which is the right answer for a firm this size: the person who carries the
 * liability decides who can raise an invoice in the firm's name. A coordinator
 * who could add a user could add themselves an owner account.
 *
 * This is the one screen where a mistake locks people out of the product
 * rather than producing a wrong number, so three refusals matter more than
 * anything else here:
 *
 * 1. **Nobody deactivates themselves.** The most common way to lose access to
 *    your own ERP is to be tidying up the team list at the time.
 * 2. **The last active owner cannot be deactivated or demoted.** A tenant with
 *    no owner has nobody who can appoint one, and the only fix is us reaching
 *    into the database.
 * 3. **A phone number and an email are how you sign in**, so both are unique
 *    per tenant and the constraint says so in words when they collide.
 *
 * Deactivation, never deletion: a person who did work is on the audit trail,
 * on job events and on invoices, and removing the row would orphan all of it.
 */
import { and, asc, count, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { requirePermission } from "../auth/context.ts";
import { ROLES } from "../auth/roles.ts";
import { db } from "../db/client.ts";
import { users } from "../db/schema.ts";
import { audit } from "../lib/audit.ts";
import { hashPassword } from "../auth/password.ts";
import { revokeAllForUser } from "../auth/sign-in.ts";
import { e164 } from "../lib/phone.ts";
import { apiRouter } from "../lib/router.ts";
import { zBody } from "../lib/validate.ts";

export const peopleRoutes = apiRouter();

/**
 * Field staff sign in by phone, office staff by email.
 *
 * Requiring both would stop a technician being added at all — most have no
 * work email — and requiring neither creates a person who can never sign in.
 * The `users_reachable` check in `0001_guards.sql` enforces the same rule at
 * the table; this one is here to say it in a sentence first.
 */
const personFields = z.object({
  name: z.string().trim().min(2).max(120),
  role: z.enum(ROLES),
  level: z.string().trim().min(1).nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().trim().min(1).nullable().optional(),
  skills: z.array(z.string().trim().min(1)).max(20).default([]),
  localities: z.array(z.string().trim().min(1)).max(20).default([]),
  /**
   * The password this person starts with, chosen by the owner.
   *
   * Only meaningful with an email — field staff sign in by phone and OTP and
   * never have one. Whoever holds it is made to replace it before they can do
   * anything, because a password somebody else typed is a shared secret.
   *
   * Ten characters and no composition rule: "one uppercase, one digit, one
   * symbol" reliably produces Password@1.
   */
  initialPassword: z.string().min(10).max(200).nullable().optional(),
});

const person = personFields
  .refine((v) => Boolean(v.email) || Boolean(v.phone), {
    message: "A person needs an email or a phone number, or they cannot sign in",
    path: ["phone"],
  })
  .refine((v) => !v.phone || e164(v.phone) !== null, {
    message: "That is not a phone number this system can dial",
    path: ["phone"],
  });

peopleRoutes.get("/", requirePermission("people:read"), async (c) => {
  const { tenantId } = c.get("caller");

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      role: users.role,
      level: users.level,
      email: users.email,
      phone: users.phoneE164,
      // FR-1304: a per-user override on the role's default language.
      languageOverride: users.languageOverride,
      skills: users.skills,
      localities: users.localities,
      active: users.active,
      // Deliberately not selected: passwordHash. Nothing needs it up here.
    })
    .from(users)
    .where(eq(users.tenantId, tenantId))
    .orderBy(asc(users.name));

  return c.json({ people: rows });
});

peopleRoutes.post("/", requirePermission("people:manage"), zBody(person), async (c) => {
  const caller = c.get("caller");
  const body = c.req.valid("json");

  const [created] = await db
    .insert(users)
    .values({
      tenantId: caller.tenantId,
      branchId: caller.branchId ?? null,
      name: body.name,
      role: body.role,
      level: body.level ?? null,
      email: body.email?.toLowerCase().trim() ?? null,
      phoneE164: body.phone ? e164(body.phone) : null,
      skills: body.skills,
      localities: body.localities,
      active: true,
      /*
        An owner-chosen password, if one was given, and a standing instruction
        to replace it.

        This route used to store no password at all and a comment claimed the
        person would set one "via the reset flow" — a flow that did not exist.
        Every office user added through the product was therefore created
        unable to sign in, and nothing said so.
      */
      passwordHash: body.initialPassword ? await hashPassword(body.initialPassword) : null,
      mustChangePassword: Boolean(body.initialPassword),
    })
    .returning({ id: users.id, name: users.name, role: users.role });

  await audit(caller, "ADD_PERSON", `Added ${body.name} as ${body.role}`, {
    table: "users",
    id: created!.id,
  });

  return c.json(created, 201);
});

/**
 * Everything about a person except whether they are active — that is below.
 *
 * Built from the field shape rather than from `person`, because the create
 * refinements do not apply to an edit: a partial patch that mentions neither
 * email nor phone is not a person who cannot sign in, it is a patch that is
 * not touching either.
 */
const edits = personFields.partial();

peopleRoutes.patch("/:id", requirePermission("people:manage"), zBody(edits), async (c) => {
  const caller = c.get("caller");
  const id = c.req.param("id");
  const body = c.req.valid("json");

  const [subject] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.tenantId, caller.tenantId)))
    .limit(1);
  if (!subject) return c.json({ error: "No such person" }, 404);

  // Demoting the last owner leaves a tenant nobody can administer.
  if (body.role && body.role !== "owner" && subject.role === "owner") {
    const [others] = await db
      .select({ value: count() })
      .from(users)
      .where(
        and(
          eq(users.tenantId, caller.tenantId),
          eq(users.role, "owner"),
          eq(users.active, true),
          ne(users.id, id),
        ),
      );
    if (Number(others?.value ?? 0) === 0) {
      return c.json(
        { error: "This is the only owner. Appoint another owner before changing this one." },
        409,
      );
    }
  }

  const [updated] = await db
    .update(users)
    .set({
      name: body.name ?? subject.name,
      role: body.role ?? subject.role,
      level: body.level === undefined ? subject.level : body.level,
      email: body.email === undefined ? subject.email : (body.email?.toLowerCase().trim() ?? null),
      phoneE164:
        body.phone === undefined ? subject.phoneE164 : body.phone ? e164(body.phone) : null,
      skills: body.skills ?? subject.skills,
      localities: body.localities ?? subject.localities,
    })
    .where(eq(users.id, id))
    .returning({ id: users.id, name: users.name, role: users.role });

  await audit(caller, "UPDATE_PERSON", `Updated ${subject.name}`, { table: "users", id });
  return c.json(updated);
});

/**
 * Turn someone's access on or off.
 *
 * Its own route rather than a field on the patch above, because it is a
 * different act with different consequences: an edit corrects a record, this
 * one decides whether a person can open the product tomorrow morning.
 */
peopleRoutes.post(
  "/:id/active",
  requirePermission("people:manage"),
  zBody(z.object({ active: z.boolean() })),
  async (c) => {
    const caller = c.get("caller");
    const id = c.req.param("id");
    const { active } = c.req.valid("json");

    if (!active && id === caller.userId) {
      return c.json(
        { error: "You cannot deactivate yourself — ask another owner to do it." },
        409,
      );
    }

    const [subject] = await db
      .select({ id: users.id, name: users.name, role: users.role, active: users.active })
      .from(users)
      .where(and(eq(users.id, id), eq(users.tenantId, caller.tenantId)))
      .limit(1);
    if (!subject) return c.json({ error: "No such person" }, 404);

    if (!active && subject.role === "owner") {
      const [others] = await db
        .select({ value: count() })
        .from(users)
        .where(
          and(
            eq(users.tenantId, caller.tenantId),
            eq(users.role, "owner"),
            eq(users.active, true),
            ne(users.id, id),
          ),
        );
      if (Number(others?.value ?? 0) === 0) {
        return c.json(
          { error: "This is the only active owner. The firm would have nobody who can add one." },
          409,
        );
      }
    }

    const [updated] = await db
      .update(users)
      .set({ active })
      .where(eq(users.id, id))
      .returning({ id: users.id, name: users.name, active: users.active });

    /*
      Withdrawing access has to actually withdraw it.

      Deactivation used to change a boolean that only the *sign-in* path read,
      so anybody already signed in kept working — and could refresh forever,
      because nothing revoked their refresh tokens either. The button removed
      access from nobody who was using the product at the time.

      Their access token survives until it expires, fifteen minutes at most,
      and then there is nothing left to renew it with.
    */
    if (!active) await revokeAllForUser(caller.tenantId, id);

    await audit(
      caller,
      active ? "ACTIVATE_PERSON" : "DEACTIVATE_PERSON",
      `${active ? "Restored" : "Removed"} access for ${subject.name}`,
      { table: "users", id },
    );

    return c.json(updated);
  },
);
