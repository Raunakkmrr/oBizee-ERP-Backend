import { Hono } from "hono";
import { authRoutes } from "./routes/auth.ts";
import { customerRoutes } from "./routes/customers.ts";
import { moneyRoutes } from "./routes/money.ts";
import { jobDetailRoutes } from "./routes/job-detail.ts";
import { reportRoutes } from "./routes/reports.ts";
import { peopleRoutes } from "./routes/people.ts";
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
app.route("/api/leads", leadRoutes);
app.route("/api/contracts", contractRoutes);
app.route("/api/invoices", invoiceRoutes);
app.route("/api/vendors", vendorRoutes);
app.route("/api/advances", advanceRoutes);
app.route("/api/payments", paymentRoutes);
app.route("/api/money", moneyRoutes);
app.route("/api/gst", gstRoutes);

app.get("/api/me", (c) => {
  const caller = c.get("caller");
  return c.json({
    name: caller.name,
    role: caller.role,
    level: caller.level,
    tenantId: caller.tenantId,
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
