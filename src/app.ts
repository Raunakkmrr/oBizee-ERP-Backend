import { Hono } from "hono";
import { authRoutes } from "./routes/auth.ts";
import { requireCaller, type AppEnv } from "./auth/context.ts";

/**
 * The application.
 *
 * Route order is the security model: everything mounted **after**
 * `requireCaller` needs a token, and the only things before it are health and
 * sign-in. A new route is protected by default, which is the correct default —
 * forgetting to add a guard should fail closed, not open.
 */
export const app = new Hono<AppEnv>();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/auth", authRoutes);

app.use("/api/*", requireCaller);

app.get("/api/me", (c) => {
  const caller = c.get("caller");
  return c.json({
    name: caller.name,
    role: caller.role,
    level: caller.level,
    tenantId: caller.tenantId,
  });
});
