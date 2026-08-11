/**
 * `Due 2h` / `Late 1d` — a word, never a bare colour (§6.4.2, P3).
 *
 * Shared rather than duplicated. It lived inside `routes/board.ts` and the jobs
 * list needed the same chip; two copies of a rule about how late something is
 * would eventually disagree, and a job that reads "Due 3h" on one screen and
 * "Late 1h" on another is worse than no chip at all.
 */
export type Sla = { word: string; kind: "due_soon" | "late" | "ok" };

/**
 * Null when nothing was promised. A job with no promise has no SLA to miss, and
 * inventing an "ok" chip for it would put a reassuring green on a job nobody
 * has committed to.
 */
export function sla(promisedBy: Date | null, now: Date): Sla | null {
  if (!promisedBy) return null;
  const ms = promisedBy.getTime() - now.getTime();
  const hours = Math.abs(ms) / 3_600_000;
  const word = hours >= 24 ? `${Math.round(hours / 24)}d` : `${Math.max(1, Math.round(hours))}h`;
  if (ms < 0) return { word: `Late ${word}`, kind: "late" };
  if (hours <= 4) return { word: `Due ${word}`, kind: "due_soon" };
  return { word: `Due ${word}`, kind: "ok" };
}
