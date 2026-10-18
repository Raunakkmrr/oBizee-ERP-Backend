import { handle } from "hono/aws-lambda";
import { Hono } from "hono";

import type { AppEnv } from "./auth/context.ts";
import { handleError } from "./lib/errors.ts";
import { platformRoutes } from "./routes/platform.ts";

/** Platform-only production surface: no tenant sign-in, office routes or webhooks. */
export const platformApp = new Hono<AppEnv>();
platformApp.onError(handleError);
platformApp.get("/health", (c) => c.json({ ok: true, service: "obizee-erp-platform" }));
platformApp.route("/platform", platformRoutes);

export const handler = handle(platformApp);
