import { Hono } from "hono";
import { cors } from "hono/cors";
import { authRoutes } from "./routes/auth.ts";
import { customerRoutes } from "./routes/customers.ts";
import { moneyRoutes } from "./routes/money.ts";
import { jobDetailRoutes } from "./routes/job-detail.ts";
import { reportRoutes } from "./routes/reports.ts";
import { peopleRoutes } from "./routes/people.ts";
import { cronRoutes, reminderRoutes } from "./routes/reminders.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { partRoutes } from "./routes/parts.ts";
import { changeOwnPassword } from "./auth/sign-in.ts";
import { setRefreshCookie, wantsTokenInBody } from "./auth/refresh-cookie.ts";
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

/**
 * Which origins a browser may call this from.
 *
 * **There was none of this at all**, which meant the web app could not reach
 * the API from a browser — every request failed at the preflight. Nothing
 * caught it: the contract tests run in Node, every probe was `curl` or
 * `fetch` from a script, and none of those are subject to the same-origin
 * policy. The first Playwright run found it in a minute.
 *
 * An allow-list, not `*`. The API answers with a caller's own data on the
 * strength of a bearer token, and while `*` cannot leak that on its own, an
 * explicit list is the thing that stays correct when a cookie or a second
 * front end arrives.
 */
const ALLOWED_ORIGINS = (
  /*
    Every port this app is served on in development. 3000 is a bare `next dev`,
    3100 the Playwright suite, 3200 the production server `npm run budget:js`
    measures against, and 3210 what `.claude/launch.json` uses so the browser
    preview does not collide with the other product on 3220.

    A missing entry fails at the preflight, which looks exactly like a broken
    password — and did, twice.
  */
  process.env.WEB_ORIGINS ??
  "http://localhost:3000,http://localhost:3100,http://localhost:3200,http://localhost:3210"
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  "*",
  cors({
    origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Token-Delivery"],
    /*
      The refresh token is an httpOnly cookie, and a browser will neither send
      nor store one on a cross-origin call without this. Safe only because the
      allow-list above is explicit: `credentials` alongside a wildcard origin is
      the combination that hands any site a signed-in session, and the browser
      refuses that pairing outright.
    */
    credentials: true,
    /*
      The web app reads `Retry-After` off a 429 to say how long the wait is.
      A browser hides every response header that is not on this list, so
      without it the sentence would have to guess.
    */
    exposeHeaders: ["Retry-After"],
    maxAge: 600,
  }),
);

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
app.route("/api/reminders", reminderRoutes);
// Outside /api: a scheduler carries a shared secret, not a user token.
app.route("/cron", cronRoutes);

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

  /*
    A new password means new tokens — the old access token still carries the
    must-change claim — and the cookie has to be replaced too, or the browser
    keeps refreshing its way back to a session that was just revoked.
  */
  setRefreshCookie(c, result.refreshToken);
  return c.json({
    accessToken: result.accessToken,
    ...(wantsTokenInBody(c) ? { refreshToken: result.refreshToken } : {}),
  });
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
