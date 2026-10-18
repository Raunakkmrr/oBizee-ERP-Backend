import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ password: vi.fn(), refresh: vi.fn(), me: vi.fn(),
  out: vi.fn(), limit: vi.fn(), clear: vi.fn(), refund: vi.fn() }));
vi.mock("./service.ts", async () => {
  const { createHash } = await import("node:crypto");
  return { passwordSignIn: mock.password, refreshSession: mock.refresh,
    currentIdentity: mock.me, signOut: mock.out, PASSWORD_REFUSAL: "That email and password do not match",
    tokenHash: (token: string) => createHash("sha256").update(token).digest("hex") };
});
vi.mock("../lib/rate-limit.ts", () => ({ consumeAll: mock.limit, clear: mock.clear,
  refund: mock.refund, LIMITS: { passwordPerAccount: { max: 5, windowSeconds: 900 } },
  tooMany: () => new Response("{}", { status: 429, headers: { "retry-after": "60" } }) }));
import { createTenantApp } from "./app.ts";
const origin = "https://web.example.test";
const post = (path: string, body: object = {}, extra: Record<string,string> = {}) =>
  createTenantApp().request(path, { method: "POST", headers: { origin,
    "content-type": "application/json", ...extra }, body: JSON.stringify(body) },
    { event: { requestContext: { http: { sourceIp: "203.0.113.5" } } } });
beforeEach(() => {
  vi.resetAllMocks(); process.env.WEB_ORIGINS = origin; process.env.NODE_ENV = "production";
  delete process.env.COOKIE_DOMAIN;
  mock.limit.mockResolvedValue({ allowed: true });
  mock.password.mockResolvedValue(null); mock.refresh.mockResolvedValue(null);
});
describe("bounded tenant surface", () => {
  it("serves health and excludes platform, OTP, and business routes", async () => {
    const app = createTenantApp();
    expect((await app.request("/health")).status).toBe(200);
    for (const path of ["/platform/plans", "/auth/otp/request", "/api/jobs"])
      expect((await app.request(path)).status).toBe(404);
    expect((await app.request("/api/me")).status).toBe(401);
  });
  it("returns one generic credential refusal", async () => {
    const res = await post("/auth/password", { email: "unknown@example.test", password: "synthetic" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "That email and password do not match" });
  });
  it("allows only the exact configured credentialed origin", async () => {
    const allowed = await post("/auth/password", { email: "a@example.test", password: "synthetic" });
    expect(allowed.headers.get("access-control-allow-origin")).toBe(origin);
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    const denied = await post("/auth/password", {}, { origin: "https://evil.example.test" });
    expect(denied.status).toBe(403); expect(mock.password).toHaveBeenCalledOnce();
  });
  it("sets an HttpOnly Secure Lax host-only /auth cookie and never gives it to browser JSON", async () => {
    mock.password.mockResolvedValue({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
      user: { name: "Test", role: "owner" } });
    const res = await post("/auth/password", { email: "a@example.test", password: "synthetic" });
    const cookie = res.headers.get("set-cookie")!;
    for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/auth"])
      expect(cookie).toContain(attribute);
    expect(cookie).not.toContain("Domain=");
    expect(await res.json()).not.toHaveProperty("refreshToken");
  });
  it("clears a refused refresh and keeps sign-out generic", async () => {
    const refresh = await post("/auth/refresh", {}, { cookie: "obizee_refresh=synthetic-refresh" });
    expect(refresh.status).toBe(401); expect(refresh.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await (await post("/auth/sign-out")).json()).toEqual({ signedOut: true });
  });
  it("validates input, retains rate limiting, and redacts internal failures", async () => {
    expect((await post("/auth/password", { email: "bad", password: "" })).status).toBe(400);
    mock.limit.mockResolvedValueOnce({ allowed: false, retryAfter: 60 });
    expect((await post("/auth/password", { email: "a@example.test", password: "synthetic" })).status).toBe(429);
    mock.password.mockRejectedValueOnce(new Error("DO-NOT-EXPOSE"));
    const failed = await post("/auth/password", { email: "a@example.test", password: "synthetic" });
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("DO-NOT-EXPOSE");
  });
});
