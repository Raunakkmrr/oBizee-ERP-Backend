import { serve } from "@hono/node-server";
import { Hono } from "hono";

import type { AppEnv } from "./auth/context.ts";
import { handleError } from "./lib/errors.ts";
import { platformRoutes } from "./routes/platform.ts";

/**
 * The platform surface as a long-running process on the oBizee API host,
 * replacing the `obizee-erp-platform` Lambda. Same routes, same guard, nothing
 * else: no tenant sign-in, office routes or webhooks are reachable here.
 *
 * Binds to loopback only; nginx terminates TLS for erp-api.obizee.com and is
 * the one way in.
 */
const app = new Hono<AppEnv>();
app.onError(handleError);
// `release` lets a deploy prove the new build is the one answering.
app.get("/health", (c) =>
  c.json({ ok: true, service: "obizee-erp-platform", release: process.env.ERP_RELEASE ?? "unknown" }));
app.route("/platform", platformRoutes);

const port = Number(process.env.PORT ?? 8790);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(JSON.stringify({ level: "info", service: "erp-platform", msg: "listening", port }));
