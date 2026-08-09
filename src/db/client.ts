import { AsyncLocalStorage } from "node:async_hooks";

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema.ts";

/**
 * Two handles, and the difference between them is the tenancy boundary.
 *
 * `db` is what every route uses. Each statement it sends carries the caller's
 * tenant to the database, where row-level security policies do the filtering —
 * so a handler that forgets its `where` returns nothing rather than somebody
 * else's records. `adminDb` bypasses that, and the list of things allowed to
 * use it is short and named in this file.
 *
 * **Why this shape and not a connection pool.** Row-level security needs a
 * setting the policies can read, and the obvious way to supply it is
 * `SET LOCAL app.tenant_id` at the start of a transaction. That needs a session
 * that outlives one statement, which the HTTP driver does not have — and moving
 * to the WebSocket pool driver to get one undoes the reason the HTTP driver was
 * chosen. Measured, rather than assumed: a GUC passed as a connection-string
 * `options` parameter is dropped by Neon's proxy, and `SET LOCAL` on its own
 * call is gone by the next one.
 *
 * What does survive is Neon's own HTTP transaction — several statements in one
 * request, one transaction server-side. So each query is sent as a pair: set
 * the tenant, then run. One round trip, the same as before; the tenant is
 * simply the first thing in it.
 */
const SET_TENANT = "select set_config('app.tenant_id', $1, true)";

function url(name: "DATABASE_URL" | "APP_DATABASE_URL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Which tenant the current request belongs to.
 *
 * Async-local rather than threaded through every call, because a parameter can
 * be forgotten at one call site out of four hundred and this cannot. Set once
 * by `requireCaller`, read at the moment each statement is sent.
 */
const tenantStore = new AsyncLocalStorage<string>();

/**
 * Run `work` with every `db` statement scoped to this tenant.
 *
 * `work` must **await** what it builds. A drizzle query builder sends nothing
 * until it is awaited, so returning one unawaited hands the caller a thenable
 * that fires after this scope has closed — and the tenant is gone by then. The
 * error thrown in that case names this paragraph.
 */
export function withTenant<T>(tenantId: string, work: () => T): T {
  return tenantStore.run(tenantId, work);
}

/** The tenant in force, for code that needs to name it as well as be scoped by it. */
export function currentTenant(): string | undefined {
  return tenantStore.getStore();
}

type QueryOptions = { arrayMode?: boolean; fullResults?: boolean };

/**
 * A Neon client that prefixes every statement with the caller's tenant.
 *
 * Shaped as a callable with `.query` and `.transaction` because that is what
 * drizzle's HTTP session reaches for — it takes `client.query ?? client`.
 */
function tenantScoped(raw: NeonQueryFunction<boolean, boolean>) {
  const run = (text: string, params: unknown[], options?: QueryOptions) => {
    const tenantId = tenantStore.getStore();
    if (!tenantId) {
      /*
        Not a silent fall-through to the unscoped handle. A query that escapes
        the tenant context is a bug in this codebase, and the two ways to find
        out are an error here or a leak in production.
      */
      throw new Error(
        "A tenant-scoped query ran outside a request. Use adminDb, or wrap the work in withTenant() — " +
          "and await inside it, because a drizzle builder sends nothing until awaited.",
      );
    }

    return raw
      .transaction(
        [raw.query(SET_TENANT, [tenantId], options), raw.query(text, params, options)],
        options,
      )
      .then((results) => results[1]);
  };

  const client = ((text: string, params: unknown[] = [], options?: QueryOptions) =>
    run(text, params, options)) as unknown as NeonQueryFunction<false, false>;

  Object.assign(client, {
    query: run,
    /*
      Drizzle's `batch()` builds its statements by calling `query` and then
      hands the results to `transaction` — which cannot work here, because
      `query` has already sent them. Nothing uses `batch` today; this refuses
      loudly rather than returning something subtly wrong if anything starts to.
    */
    transaction: () => {
      throw new Error("batch() is not available on the tenant-scoped handle — see db/client.ts");
    },
  });

  return client;
}

/**
 * The handle every route uses. Scoped by the database, not by the handler.
 *
 * A separate role from `adminDb`'s, and the separation is the whole point:
 * Neon's default owner carries `BYPASSRLS`, so policies written against it are
 * decoration. `app_runtime` cannot bypass them.
 */
export const db = drizzle(tenantScoped(neon(url("APP_DATABASE_URL"))), { schema });

/**
 * Unscoped, privileged, and used deliberately in five places.
 *
 * Sign-in (the tenant is not known until the user is found), refresh-token
 * rotation, rate limiting (counted per phone and per address, across tenants),
 * the seed scripts, and the tests that need to set a second firm up. Anything
 * else reaching for this is a mistake.
 */
export const adminDb = drizzle(neon(url("DATABASE_URL")), { schema });

export { schema };
