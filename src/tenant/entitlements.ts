/**
 * ERP-PLATFORM-005A temporary product rule. One audited, reversible server switch.
 * This is NOT authentication. Call only after currentIdentity has revalidated the
 * SID, active user, tenant lifecycle/subscription. Never put this grant in a JWT.
 * Revoke by changing enabled to false in a reviewed release; /account still works.
 */
export const TEMPORARY_ACCESS = { id: "ERP-PLATFORM-005A", enabled: true } as const;
export const SHIPPED_MODULES = ["overview", "customers"] as const;
export type ShippedModule = typeof SHIPPED_MODULES[number];
export function cohortEntitlements() {
  return { policy: TEMPORARY_ACCESS.id, universal: TEMPORARY_ACCESS.enabled,
    modules: TEMPORARY_ACCESS.enabled ? [...SHIPPED_MODULES] : [] };
}
export function cohortAllowed(module: ShippedModule): boolean {
  return cohortEntitlements().modules.includes(module);
}
