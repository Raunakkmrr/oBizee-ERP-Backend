import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, jwtVerify } from "jose";
import type { TenantUser } from "./store.ts";

const mock = vi.hoisted(() => ({ candidates: vi.fn(), active: vi.fn(), save: vi.fn(),
  revoke: vi.fn(), hash: vi.fn(), verify: vi.fn(), create: vi.fn(), session: vi.fn(),
  consume: vi.fn(), end: vi.fn() }));
vi.mock("./store.ts", () => ({ passwordCandidates: mock.candidates, activeUser: mock.active,
  saveRefresh: mock.save, revokeRefresh: mock.revoke }));
vi.mock("../auth/password.ts", () => ({ hashPassword: mock.hash, verifyPassword: mock.verify }));
vi.mock("../auth/z-sessions.ts", () => ({ createPasswordAuthSession: mock.create,
  accessSessionActive: mock.session, consumeActiveRefresh: mock.consume,
  revokeSessionByRefresh: mock.end }));
import { passwordSignIn, refreshSession, currentIdentity, signOut, tokenHash } from "./service.ts";

const user = { id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222", email: "owner@example.test",
  name: "Test owner", passwordHash: "synthetic-hash", active: true, role: "owner",
  level: null, mustChangePassword: false } as TenantUser;
const sid = "33333333-3333-4333-8333-333333333333";
const secret = "unit-test-only-tenant-secret-not-production-123456";
beforeEach(() => {
  vi.resetAllMocks();
  process.env.JWT_SECRET = secret;
  mock.candidates.mockResolvedValue([user]); mock.active.mockResolvedValue(user);
  mock.hash.mockResolvedValue("synthetic-hash"); mock.verify.mockResolvedValue(true);
  mock.create.mockResolvedValue(sid); mock.session.mockResolvedValue(true);
  mock.save.mockResolvedValue(undefined);
});

describe("0079-bounded tenant password authentication", () => {
  it("issues a tenant-realm token and stores only a refresh hash", async () => {
    const result = await passwordSignIn("OWNER@example.test", "unit-test-password");
    expect(result).not.toBeNull();
    const { payload } = await jwtVerify(result!.accessToken, new TextEncoder().encode(secret),
      { issuer: "obizee-erp-tenant", audience: "service-erp" });
    expect(payload).toMatchObject({ sub: user.id, tenantId: user.tenantId, sid });
    expect(mock.save).toHaveBeenCalledWith(user.tenantId, user.id, sid, tokenHash(result!.refreshToken));
    expect(mock.save.mock.calls[0]).not.toContain(result!.refreshToken);
  });
  it("refuses unknown, wrong, and inactive credentials without creating sessions", async () => {
    mock.candidates.mockResolvedValueOnce([]);
    expect(await passwordSignIn(user.email!, "unit-test-password")).toBeNull();
    expect(mock.hash).toHaveBeenCalledOnce();
    mock.verify.mockResolvedValueOnce(false);
    expect(await passwordSignIn(user.email!, "unit-test-password")).toBeNull();
    mock.candidates.mockResolvedValueOnce([{ ...user, active: false }]);
    expect(await passwordSignIn(user.email!, "unit-test-password")).toBeNull();
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("refuses an ambiguous email/password match across companies", async () => {
    mock.candidates.mockResolvedValue([user, { ...user, id: sid, tenantId: sid }]);
    expect(await passwordSignIn(user.email!, "unit-test-password")).toBeNull();
    expect(mock.create).not.toHaveBeenCalled();
  });
  it("refuses unavailable lifecycle/subscription state and concurrent credential changes", async () => {
    mock.active.mockResolvedValueOnce(null);
    expect(await passwordSignIn(user.email!, "unit-test-password")).toBeNull();
    mock.active.mockResolvedValueOnce({ ...user, passwordHash: "changed" });
    expect(await passwordSignIn(user.email!, "unit-test-password")).toBeNull();
    mock.create.mockResolvedValueOnce(null);
    expect(await passwordSignIn(user.email!, "unit-test-password")).toBeNull();
    expect(mock.save).not.toHaveBeenCalled();
  });
  it("fails closed on a database failure", async () => {
    mock.active.mockRejectedValueOnce(new Error("synthetic database failure"));
    await expect(passwordSignIn(user.email!, "unit-test-password")).rejects.toThrow();
    expect(mock.save).not.toHaveBeenCalled();
  });
});

describe("session identity and revocation", () => {
  it("rotates only a consumed live refresh session; a replay is refused", async () => {
    mock.consume.mockResolvedValueOnce({ tenantId: user.tenantId, userId: user.id, sessionId: sid })
      .mockResolvedValueOnce(null);
    expect(await refreshSession("synthetic-refresh")).not.toBeNull();
    expect(await refreshSession("synthetic-refresh")).toBeNull();
    expect(mock.save).toHaveBeenCalledOnce();
  });
  it("refuses refresh for a revoked session or deactivated account", async () => {
    mock.consume.mockResolvedValue({ tenantId: user.tenantId, userId: user.id, sessionId: sid });
    mock.session.mockResolvedValueOnce(false);
    expect(await refreshSession("synthetic-refresh")).toBeNull();
    mock.active.mockResolvedValueOnce(null);
    expect(await refreshSession("synthetic-refresh")).toBeNull();
  });
  it("revalidates the current user instead of trusting stale role claims", async () => {
    const result = await passwordSignIn(user.email!, "unit-test-password");
    mock.active.mockResolvedValueOnce({ ...user, role: "technician", mustChangePassword: true });
    expect(await currentIdentity(result!.accessToken)).toMatchObject({
      tenantId: user.tenantId, role: "technician", mustChangePassword: true });
    mock.session.mockResolvedValueOnce(false);
    expect(await currentIdentity(result!.accessToken)).toBeNull();
  });
  it("rejects forged, wrong-realm, and pre-session tokens", async () => {
    expect(await currentIdentity("not.a.jwt")).toBeNull();
    const old = await new SignJWT({ tenantId: user.tenantId }).setSubject(user.id)
      .setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode(secret));
    expect(await currentIdentity(old)).toBeNull();
    expect(mock.active).not.toHaveBeenCalled();
  });
  it("revokes the server session and refresh token together on sign-out", async () => {
    await signOut("synthetic-refresh");
    expect(mock.end).toHaveBeenCalledWith(tokenHash("synthetic-refresh"));
    expect(mock.revoke).toHaveBeenCalledWith(tokenHash("synthetic-refresh"));
  });
});
