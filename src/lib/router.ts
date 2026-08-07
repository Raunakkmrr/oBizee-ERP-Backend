import { Hono } from "hono";
import { handleError } from "./errors.ts";
import type { AppEnv } from "../auth/context.ts";

/**
 * Build a route group that already knows how to refuse.
 *
 * Hono catches a thrown error inside the instance it was thrown in and calls
 * *that* instance's `onError` — so a handler on a sub-app mounted with
 * `route()` never reaches the parent's, and a wrapping middleware never sees
 * the rejection either. A constraint would fire, the rule would work, and the
 * caller would still get a bare 500 saying the server broke.
 *
 * Every route file uses this instead of `new Hono()`, so the mapping cannot be
 * forgotten on the next one.
 */
export function apiRouter() {
  const router = new Hono<AppEnv>();
  router.onError(handleError);
  return router;
}
