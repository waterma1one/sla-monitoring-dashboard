import type { AcceptedRow, StatusClass } from "./cleaning";

export type CheckPointStatus = "available" | "unavailable" | "excluded";

export type CheckPointResolution = {
  status: CheckPointStatus;
  latencyMs: number | null;
  degraded: boolean;
};

/**
 * Resolves every accepted report for one (service, instant) check-point into a
 * single verdict, per docs/decisions.md section 1:
 *
 *   reports := all accepted rows for this (service, instant)
 *   valid   := reports where class != 'invalid'
 *
 *   if valid is empty            -> check-point is EXCLUDED (observed, unclassifiable)
 *   else if any valid is 5xx     -> check-point is UNAVAILABLE
 *   else                         -> check-point is AVAILABLE
 *
 *   latency_ms := mean of non-null latency_ms over valid reports  (null if none)
 *   degraded   := check-point is AVAILABLE and latency_ms > 1000
 *
 * Worst-status-wins: ambiguity between two reports must never favour the party
 * computing the bill (F7). Mean-of-non-null disposes of F6 for free - the blank
 * copy of a same-agent conflicting pair contributes nothing instead of winning
 * a coin toss, without inventing a value that was not recorded.
 *
 * `reports` is every AcceptedRow already sharing one (service_id, ts) pair -
 * the caller groups rows before calling this, this function only resolves one
 * group. Never empty in practice (a check-point implies at least one report),
 * but do not assume that here without checking - defend that call in review.
 */
export function resolveCheckPoint(reports: AcceptedRow[]): CheckPointResolution {
  const valid = reports.filter((r) => r.statusClass !== "invalid");

  if (valid.length === 0) {
    return { status: "excluded", latencyMs: null, degraded: false };
  }

  const status: CheckPointStatus = valid.some((r) => r.statusClass === "unavailable")
    ? "unavailable"
    : "available";

  const latencies = valid
    .map((r) => r.latencyMs)
    .filter((ms): ms is number => ms !== null);
  const latencyMs = latencies.length > 0
    ? latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length
    : null;

  const degraded = status === "available" && latencyMs !== null && latencyMs > 1000;

  return { status, latencyMs, degraded };
}
