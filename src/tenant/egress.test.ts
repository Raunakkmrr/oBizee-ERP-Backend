import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ password: vi.fn(), refresh: vi.fn(), limit: vi.fn(), refund: vi.fn() }));
vi.mock("./service.ts", async () => {
  const { createHash } = await import("node:crypto");
  return { passwordSignIn: mock.password, refreshSession: mock.refresh, currentIdentity: vi.fn(), signOut: vi.fn(),
    PASSWORD_REFUSAL: "That email and password do not match",
    tokenHash: (token: string) => createHash("sha256").update(token).digest("hex") };
});
vi.mock("../lib/rate-limit.ts", () => ({ consumeAll: mock.limit, clear: vi.fn(), refund: mock.refund,
  LIMITS: { passwordPerAccount: { max: 5, windowSeconds: 900 } },
  tooMany: () => new Response("{}", { status: 429 }) }));
import { createTenantApp } from "./app.ts";
const post = (path: string, body: object = {}, headers: Record<string,string> = {}) =>
  createTenantApp().request(path, { method: "POST", headers: { origin: "https://web.example.test",
    "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
    { event: { requestContext: { http: { sourceIp: "203.0.113.5" } } } });
let budgets: Map<string, number>;
beforeEach(() => {
  vi.resetAllMocks(); process.env.WEB_ORIGINS = "https://web.example.test";
  budgets = new Map();
  mock.password.mockResolvedValue(null); mock.refresh.mockResolvedValue(null);
  mock.limit.mockImplementation(async (entries: [string, { max: number }][]) => {
    let allowed = true;
    for (const [key, limit] of entries) {
      const used = (budgets.get(key) ?? 0) + 1; budgets.set(key, used);
      if (used > limit.max) allowed = false;
    }
    return allowed ? { allowed: true } : { allowed: false, retryAfter: 60 };
  });
});
describe("SSR shared-egress isolation", () => {
  it("does not let >20 failed accounts lock out another identity on the same egress", async () => {
    for (let n = 0; n < 40; n++) expect((await post("/auth/password", {
      email: `attacker-${n}@example.test`, password: "synthetic" }, { "x-forwarded-for": "spoofed" })).status).toBe(401);
    mock.password.mockResolvedValueOnce({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
      user: { name: "Other account", role: "owner" } });
    expect((await post("/auth/password", { email: "other@example.test", password: "synthetic" })).status).toBe(200);
    expect([...budgets.keys()].every(key => key.startsWith("pw:account:"))).toBe(true);
  });
  it("still limits account guesses even when forwarded addresses change", async () => {
    for (let n = 0; n < 6; n++) expect((await post("/auth/password", {
      email: "TARGET@example.test", password: "synthetic" }, { "x-forwarded-for": `spoofed-${n}` })).status).toBe(n < 5 ? 401 : 429);
    expect([...budgets.keys()]).toEqual(["pw:account:target@example.test"]);
  });
  it("does not let >30 bad refreshes spend another token's budget or persist raw credentials", async () => {
    for (let n = 0; n < 35; n++) expect((await post("/auth/refresh", {}, {
      cookie: "obizee_refresh=bad-token", "x-forwarded-for": "spoofed" })).status).toBe(n < 30 ? 401 : 429);
    mock.refresh.mockResolvedValueOnce({ accessToken: "synthetic-access", refreshToken: "rotated-token" });
    expect((await post("/auth/refresh", {}, { cookie: "obizee_refresh=other-token" })).status).toBe(200);
    expect(budgets.size).toBe(2);
    for (const key of budgets.keys()) expect(key).toMatch(/^refresh:token:[a-f0-9]{64}$/);
    expect(mock.refund).toHaveBeenCalledWith(expect.stringMatching(/^refresh:token:[a-f0-9]{64}$/));
  });
  it("does not allocate any shared anonymous budget for missing refresh credentials", async () => {
    for (let n = 0; n < 35; n++) expect((await post("/auth/refresh")).status).toBe(401);
    expect(mock.limit).not.toHaveBeenCalled(); expect(mock.refresh).not.toHaveBeenCalled();
  });
});
