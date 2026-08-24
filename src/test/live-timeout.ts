/**
 * How long a `.live` test may take before it counts as hung.
 *
 * **Why these need their own number.** The live suites drive the running API
 * over HTTP against a serverless Postgres, and a single case is often four or
 * five sequential round trips — raise an invoice, issue it, pay it, cancel it —
 * with password hashing in some of them, which is deliberately slow. Vitest's
 * five-second default is right for a pure test, where a timeout genuinely means
 * something has stopped, and wrong for these, where it just means the network
 * was ordinary.
 *
 * **The failure mode it prevents is worse than slowness.** Every feature that
 * adds a query to those paths pushes a few more cases over the line, so they
 * begin failing at random rather than for a reason — and people learn to re-run
 * the suite until it passes. That is exactly how a real failure gets waved
 * through. Two separate cases had already started flapping this way.
 *
 * Applied per file rather than globally, so the pure tests keep the strict
 * default and this stays an explicit statement about what a live test is.
 */
export const LIVE_TIMEOUT_MS = 30_000;
