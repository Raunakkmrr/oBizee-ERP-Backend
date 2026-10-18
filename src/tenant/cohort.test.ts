import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ me: vi.fn(), workspace: vi.fn(), customers: vi.fn(), create: vi.fn(), enabled: true }));
vi.mock("./service.ts", () => ({ currentIdentity: mock.me, passwordSignIn: vi.fn(),
  refreshSession: vi.fn(), signOut: vi.fn(), tokenHash: vi.fn(), PASSWORD_REFUSAL: "Refused" }));
vi.mock("./workspace.ts", () => ({ readWorkspace: mock.workspace, readCustomers: mock.customers, createCustomer: mock.create }));
vi.mock("./entitlements.ts", () => ({ cohortAllowed: () => mock.enabled }));
vi.mock("../lib/rate-limit.ts", () => ({ consumeAll: vi.fn(), clear: vi.fn(), refund: vi.fn(), LIMITS: {} }));
import { createTenantApp } from "./app.ts";
const a = { id: "11111111-1111-4111-8111-111111111111", tenantId: "22222222-2222-4222-8222-222222222222", name: "Unit A", role: "technician" };
const b = { ...a, id: "33333333-3333-4333-8333-333333333333", tenantId: "44444444-4444-4444-8444-444444444444", role: "readonly_ca" };
const input = { id: "55555555-5555-4555-8555-555555555555", branchId: "66666666-6666-4666-8666-666666666666",
  name: "New customer", customerType: "BUSINESS", billingStateCode: "27",
  addressLine1: "Unit test address", locality: "Test locality", city: "Test city", pincode: "400001" };
function request(path: string, token?: string, body?: object) {
  return createTenantApp().request(path, { method: body ? "POST" : "GET", headers: {
    origin: "https://unit.test", ...(token ? { authorization: "Bearer " + token } : {}),
    "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
beforeEach(() => {
  vi.resetAllMocks(); mock.enabled = true; process.env.WEB_ORIGINS = "https://unit.test";
  mock.me.mockImplementation(async token => token === "a" ? a : token === "b" ? b : null);
  mock.workspace.mockImplementation(async actor => ({ company: { id: actor.tenantId } }));
  mock.customers.mockResolvedValue({ items: [], page: 0, hasMore: false });
  mock.create.mockImplementation(async (_, value) => ({ id: value.id, created: true }));
});
describe("strict operational cohort", () => {
  it("refuses unsigned, invalid or revoked/lifecycle-refused identities before querying data", async () => {
    for (const token of [undefined, "invalid", "revoked", "inactive", "closed", "expired"])
      for (const path of ["/api/core/workspace", "/api/core/customers"])
        expect((await request(path, token)).status).toBe(401);
    expect(mock.workspace).not.toHaveBeenCalled(); expect(mock.customers).not.toHaveBeenCalled();
    expect((await request("/api/core/customers", undefined, input)).status).toBe(401);
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("gives every actual active role the same cohort; never impersonates owner or trusts tenant query", async () => {
    for (const role of ["owner","coordinator","marketing","technician","accountant","readonly_ca"]) {
      mock.me.mockResolvedValueOnce({ ...a, role });
      expect((await request("/api/core/workspace?tenantId=" + b.tenantId, "a")).status).toBe(200);
      expect(mock.workspace).toHaveBeenLastCalledWith({ ...a, role });
    }
    expect((await request("/api/core/customers", "b", input)).status).toBe(201);
    expect(mock.create).toHaveBeenLastCalledWith(b, input);
  });
  it("keeps two principals and their tenant contexts distinct", async () => {
    for (const [token, actor] of [["a",a],["b",b]] as const) {
      const response = await request("/api/core/workspace", token);
      expect(await response.json()).toEqual({ company: { id: actor.tenantId } });
      await request("/api/core/customers?page=2", token);
      expect(mock.customers).toHaveBeenLastCalledWith(actor, 2);
    }
  });
  it("revokes all cohort grants centrally while identity remains available", async () => {
    mock.enabled = false;
    expect((await request("/api/me", "a")).status).toBe(200);
    expect((await request("/api/core/workspace", "a")).status).toBe(403);
    expect((await request("/api/core/customers", "a")).status).toBe(403);
    expect((await request("/api/core/customers", "a", input)).status).toBe(403);
    expect(mock.workspace).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled();
  });
  it("validates pages and writes, rejects browser tenant/role injection and excludes unclosed realms", async () => {
    for (const value of ["-1","0.5","10001","NaN"])
      expect((await request("/api/core/customers?page=" + value, "a")).status).toBe(400);
    for (const value of [{ ...input, tenantId: b.tenantId }, { ...input, role: "owner" },
      { ...input, name: " " }, { ...input, billingStateCode: "00" }])
      expect((await request("/api/core/customers", "a", value)).status).toBe(400);
    for (const path of ["/api/jobs","/api/core/jobs","/platform/plans","/cron/run"])
      expect((await request(path,"a")).status).toBe(404);
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("reports create versus idempotent replay and redacts database failure", async () => {
    expect((await request("/api/core/customers","a",input)).status).toBe(201);
    mock.create.mockResolvedValueOnce({ id: input.id, created: false });
    expect((await request("/api/core/customers","a",input)).status).toBe(200);
    mock.create.mockResolvedValueOnce(null);
    expect((await request("/api/core/customers","a",input)).status).toBe(409);
    mock.workspace.mockRejectedValueOnce(new Error("secret SQL"));
    const failed = await request("/api/core/workspace","a");
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("secret SQL");
  });
});
