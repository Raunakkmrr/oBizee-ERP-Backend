import { handle } from "hono/aws-lambda";

import { app } from "./app.ts";

/**
 * The same application, behind API Gateway instead of a socket.
 *
 * `server.ts` stays for local work and for the test harnesses, which want a
 * real port. Nothing about the app differs between the two — Hono is a
 * `fetch` handler and this is the adapter — but three things about running on
 * Lambda are worth stating where somebody will read them.
 *
 * **The HTTP database driver is why this works at all.** A pooled TCP driver on
 * Lambda opens a connection per concurrent execution and exhausts the database
 * long before it exhausts anything else, and needs a VPC and a NAT gateway to
 * reach Neon privately. The HTTP driver has no pool, no handshake to amortise
 * and no VPC. That choice was made for serverless and blocked the obvious route
 * to row-level security; `db/client.ts` describes how RLS was got anyway.
 *
 * **`AsyncLocalStorage` survives here.** Lambda reuses an execution context
 * between invocations, so module-level *mutable* state leaks between requests —
 * but an async-local store does not: it is scoped to the async context of one
 * request, and `requireCaller` enters it per request. Nothing else in this
 * codebase holds request state at module scope.
 *
 * **Give it memory.** Password verification is scrypt, deliberately expensive,
 * and Lambda scales CPU with memory — at 128 MB a sign-in takes seconds. 512 MB
 * is the floor; measure before trimming it.
 */
export const handler = handle(app);
