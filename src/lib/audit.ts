import { db } from "../db/client.ts";
import { auditEntries } from "../db/schema.ts";
import type { Caller } from "../auth/context.ts";

/**
 * Record a mutation — FR-1305.
 *
 * The actor's **name** is stored alongside their id because a deactivated user
 * must still read as a person: a trail that renders "unknown" for anyone who
 * has left is a trail nobody can follow.
 *
 * Insert-only is enforced by a trigger, not by this function. There is no
 * update or delete path here because there is none in the database either.
 */
export async function audit(
  caller: Caller,
  action: string,
  summary: string,
  entity?: { table: string; id: string },
): Promise<void> {
  await db.insert(auditEntries).values({
    tenantId: caller.tenantId,
    actorUserId: caller.userId,
    actorName: caller.name,
    action,
    summary,
    origin: "web",
    entityTable: entity?.table ?? null,
    entityId: entity?.id ?? null,
  });
}
