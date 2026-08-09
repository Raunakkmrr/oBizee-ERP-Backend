import { Hono } from "hono";
import { authRoutes } from "./routes/auth.ts";
import { customerRoutes } from "./routes/customers.ts";
import { moneyRoutes } from "./routes/money.ts";
import { jobDetailRoutes } from "./routes/job-detail.ts";
import { reportRoutes } from "./routes/reports.ts";
import { peopleRoutes } from "./routes/people.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { partRoutes } from "./routes/parts.ts";
import { changeOwnPassword } from "./auth/sign-in.ts";
import { homeRoutes } from "./routes/home.ts";
import { boardRoutes } from "./routes/board.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { leadRoutes } from "./routes/leads.ts";
import { contractRoutes } from "./routes/contracts.ts";
import { invoiceRoutes } from "./routes/invoices.ts";
import { vendorRoutes } from "./routes/vendors.ts";
import { advanceRoutes } from "./routes/advances.ts";
import { paymentRoutes } from "./routes/payments.ts";
import { gstRoutes } from "./routes/gst.ts";
import { requireCaller, type AppEnv } from "./auth/context.ts";
import { handleError } from "./lib/errors.ts";

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

app.route("/api/customers", customerRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api/job", jobDetailRoutes);
app.route("/api/board", boardRoutes);
app.route("/api/home", homeRoutes);
app.route("/api/reports", reportRoutes);
app.route("/api/people", peopleRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/parts", partRoutes);
app.route("/api/leads", leadRoutes);
app.route("/api/contracts", contractRoutes);
app.route("/api/invoices", invoiceRoutes);
app.route("/api/vendors", vendorRoutes);
app.route("/api/advances", advanceRoutes);
app.route("/api/payments", paymentRoutes);
app.route("/api/money", moneyRoutes);
app.route("/api/gst", gstRoutes);

/**
 * Who is signed in, according to the token.
 *
 * The web app's `useCurrentUser` reads this. It used to read `actingAs` from
 * the browser store — a switcher that let anybody become the owner by picking
 * them from a menu, which is fine for a fixture and unthinkable once real
 * sign-in exists.
 *
 * `id` is here because the screens need it: the team form refuses to let you
 * change your own role, and it can only know which person that is by
 * comparing ids.
 */
/**
 * Choose your own password.
 *
 * Under `/api/me` and therefore behind `requireCaller`, which is what lets it
 * be the single exception to the must-change gate: a caller in that state can
 * reach this and nothing else.
 */
app.post("/api/me/password", async (c) => {
  const caller = c.get("caller");
  const body = await c.req.json<{ currentPassword?: string; newPassword?: string }>();

  // Ten characters, and no other rule. Composition requirements produce
  // Password@1, which is worse than a long thing somebody can remember.
  if (!body.newPassword || body.newPassword.length < 10) {
    return c.json({ error: "A password needs at least ten characters.", field: "newPassword" }, 400);
  }
  if (!body.currentPassword) {
    return c.json({ error: "Enter the password you were given.", field: "currentPassword" }, 400);
  }

  const result = await changeOwnPassword(caller.userId, body.currentPassword, body.newPassword);
  if (result.kind === "refused") return c.json({ error: result.reason }, 401);

  return c.json({ accessToken: result.accessToken, refreshToken: result.refreshToken });
});

app.get("/api/me", (c) => {
  const caller = c.get("caller");
  return c.json({
    id: caller.userId,
    name: caller.name,
    role: caller.role,
    level: caller.level,
    tenantId: caller.tenantId,
    // The app routes on this: everything else is refused until it is false.
    mustChangePassword: caller.mustChangePassword ?? false,
  });
});

/**
 * One place where a database refusal becomes a readable answer.
 *
 * Hono's default turns any thrown error into a bare 500 "Internal Server
 * Error". A constraint firing is the opposite of an internal error — it is the
 * system stopping somebody from doing something wrong — and it deserves a
 * sentence naming the rule.
 */
app.onError(handleError);
