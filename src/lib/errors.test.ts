import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { handleError } from "./errors.ts";

/** Shaped like what Drizzle actually throws: the driver error on `.cause`. */
const wrapped = (constraint: string, code = "23505") =>
  Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error("duplicate key"), { code, constraint }),
  });

/** Built the way every route file is — `onError` on the instance itself. */
function appThrowing(err: unknown) {
  const app = new Hono();
  app.onError(handleError);
  app.get("/x", () => { throw err; });
  return app;
}

describe("a constraint firing is never an internal error", () => {
  it("finds the constraint through Drizzle's wrapper", async () => {
    const res = await appThrowing(wrapped("invoices_job_uq")).request("/x");
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, string>).error).toMatch(/bills once/);
  });

  it("names the rule, not the column", async () => {
    const res = await appThrowing(wrapped("invoices_contract_point_uq")).request("/x");
    expect(((await res.json()) as Record<string, string>).error).toMatch(/instalment has already been raised/);
  });

  it("maps a check violation to a 400 — the caller can fix it", async () => {
    const res = await appThrowing(wrapped("invoices_foots_exactly", "23514")).request("/x");
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, string>).error).toMatch(/does not add up/);
  });

  it("still refuses rather than 500s on a constraint nobody has worded yet", async () => {
    const res = await appThrowing(wrapped("some_future_uq")).request("/x");
    expect(res.status).toBe(409);
    expect(((await res.json()) as Record<string, string>).constraint).toBe("some_future_uq");
  });

  it("gives a genuine fault a 500 and no detail to probe with", async () => {
    const res = await appThrowing(new Error("null pointer somewhere")).request("/x");
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/null pointer/);
  });
});
