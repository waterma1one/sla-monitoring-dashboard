// D1-backed read endpoints for the dashboard: the stats payload (docs/decisions.md
// section 1's numbers, scoped to a date range) and the paginated logs view.

import { resolveCheckPoint, type CheckPointReport } from "./resolveCheckPoint";
import { daysBetweenInclusive, type LogsCursor } from "./queryParams";

// docs/decisions.md section 1: 15-minute check cadence.
const EXPECTED_POINTS_PER_DAY = 96;
const CORRECTIONS_SEPARATOR = ",";

async function uploadExists(env: Env, uploadId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT id FROM uploads WHERE id = ?1`).bind(uploadId).first();
  return row !== null;
}

export type ServiceStats = {
  serviceId: string;
  serviceName: string;
  available: number;
  unavailable: number;
  availability: number | null;
};

export type StatsResult = {
  from: string;
  to: string;
  checkPoints: { available: number; unavailable: number; excluded: number; expected: number };
  availability: number | null;
  coverage: number | null;
  degradedRate: number | null;
  latency: { mean: number | null; p95: number | null };
  // Blended availability above can read "no credit owed" while one service breached
  // and four did not - see docs/decisions.md section 10. Ordered by serviceId.
  perService: ServiceStats[];
};

export type StatsOutcome = { ok: true; stats: StatsResult } | { ok: false; reason: "upload_not_found" };

type StatsRow = {
  serviceId: string;
  serviceName: string;
  ts: number;
  statusClass: CheckPointReport["statusClass"];
  latencyMs: number | null;
};

function percentile95(sortedAscending: number[]): number | null {
  if (sortedAscending.length === 0) return null;
  // Nearest-rank method: the smallest value at or above the 95th percentile.
  const rank = Math.ceil(0.95 * sortedAscending.length) - 1;
  return sortedAscending[Math.min(rank, sortedAscending.length - 1)]!;
}

export async function getStats(
  env: Env,
  uploadId: string,
  from: string,
  to: string,
): Promise<StatsOutcome> {
  if (!(await uploadExists(env, uploadId))) return { ok: false, reason: "upload_not_found" };

  // All services this upload has ever reported, not just ones active in the
  // requested range - the assignment's 5 services are fixed for the whole file,
  // so a service silent for part of the range should still count against
  // coverage rather than shrink the expected denominator. See docs/decisions.md.
  const serviceCountRow = await env.DB.prepare(
    `SELECT COUNT(DISTINCT service_id) as n FROM checks WHERE upload_id = ?1`,
  )
    .bind(uploadId)
    .first<{ n: number }>();
  const serviceCount = serviceCountRow?.n ?? 0;

  const rangeRows = await env.DB.prepare(
    `SELECT service_id as serviceId, service_name as serviceName, ts,
            status_class as statusClass, latency_ms as latencyMs
     FROM checks WHERE upload_id = ?1 AND day BETWEEN ?2 AND ?3`,
  )
    .bind(uploadId, from, to)
    .all<StatsRow>();

  // Grouped by (serviceId, ts): a check-point can carry more than one report per
  // docs/decisions.md's resolution rule. serviceName travels on the row rather than
  // being looked up separately - see the checks table's denormalisation note.
  const groups = new Map<string, { serviceId: string; serviceName: string; reports: CheckPointReport[] }>();
  for (const row of rangeRows.results) {
    const key = `${row.serviceId}|${row.ts}`;
    const group = groups.get(key);
    if (group) group.reports.push(row);
    else groups.set(key, { serviceId: row.serviceId, serviceName: row.serviceName, reports: [row] });
  }

  let available = 0;
  let unavailable = 0;
  let excluded = 0;
  let degraded = 0;
  const perServiceTotals = new Map<string, { serviceName: string; available: number; unavailable: number }>();
  for (const group of groups.values()) {
    const resolution = resolveCheckPoint(group.reports);
    if (resolution.status === "available") available += 1;
    else if (resolution.status === "unavailable") unavailable += 1;
    else excluded += 1;
    if (resolution.degraded) degraded += 1;

    // Every service with a check-point in range appears in perService, excluded-only
    // included, so a service is never silently missing - it shows availability: null
    // instead, the same "we can't tell" signal the blended figure uses.
    const totals = perServiceTotals.get(group.serviceId) ?? {
      serviceName: group.serviceName,
      available: 0,
      unavailable: 0,
    };
    if (resolution.status === "available") totals.available += 1;
    else if (resolution.status === "unavailable") totals.unavailable += 1;
    perServiceTotals.set(group.serviceId, totals);
  }

  const perService: ServiceStats[] = Array.from(perServiceTotals.entries())
    .map(([serviceId, totals]) => ({
      serviceId,
      serviceName: totals.serviceName,
      available: totals.available,
      unavailable: totals.unavailable,
      availability:
        totals.available + totals.unavailable > 0
          ? totals.available / (totals.available + totals.unavailable)
          : null,
    }))
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId));

  // Latency is computed over rows with a latency, not over resolved check-points
  // - docs/decisions.md section 1 keeps these as genuinely different sets, since
  // a row with no latency is still evidence the check ran.
  const latencies = rangeRows.results
    .map((r) => r.latencyMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);
  const latencyMean =
    latencies.length > 0 ? latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length : null;

  const observed = available + unavailable + excluded;
  const expected = serviceCount * daysBetweenInclusive(from, to) * EXPECTED_POINTS_PER_DAY;

  return {
    ok: true,
    stats: {
      from,
      to,
      checkPoints: { available, unavailable, excluded, expected },
      availability: available + unavailable > 0 ? available / (available + unavailable) : null,
      coverage: expected > 0 ? observed / expected : null,
      degradedRate: available > 0 ? degraded / available : null,
      latency: { mean: latencyMean, p95: percentile95(latencies) },
      perService,
    },
  };
}

export type UploadSummary = {
  id: string;
  filename: string;
  uploadedAt: string;
  status: "open" | "complete" | "failed";
  dayFirst: string | null;
  dayLast: string | null;
  rowsTotal: number;
  rowsAccepted: number;
  rowsCorrected: number;
  rowsRejected: number;
  rowsDuplicate: number;
};

// Newest-first, for the dashboard's "which upload am I looking at" default. Sorted by
// uploaded_at with rowid as a tiebreaker: uploaded_at has millisecond resolution, and
// two uploads finishing in the same millisecond is plausible, not just a test artifact.
export async function listUploads(env: Env): Promise<UploadSummary[]> {
  const result = await env.DB.prepare(
    `SELECT id, filename, uploaded_at as uploadedAt, status,
            day_first as dayFirst, day_last as dayLast,
            rows_total as rowsTotal, rows_accepted as rowsAccepted,
            rows_corrected as rowsCorrected, rows_rejected as rowsRejected,
            rows_duplicate as rowsDuplicate
     FROM uploads ORDER BY uploaded_at DESC, rowid DESC`,
  ).all<UploadSummary>();
  return result.results;
}

export type LogRow = {
  id: number;
  serviceId: string;
  serviceName: string;
  region: string;
  agent: string;
  ts: number;
  day: string;
  statusCode: number;
  statusClass: string;
  latencyMs: number | null;
  degraded: boolean;
  corrections: string[];
};

export type LogsResult = { rows: LogRow[]; nextCursor: string | null };
export type LogsOutcome = { ok: true; logs: LogsResult } | { ok: false; reason: "upload_not_found" };

type LogQueryRow = Omit<LogRow, "degraded" | "corrections"> & {
  degraded: number;
  corrections: string;
};

export async function getLogs(
  env: Env,
  uploadId: string,
  from: string,
  to: string,
  limit: number,
  cursor: LogsCursor | null,
): Promise<LogsOutcome> {
  if (!(await uploadExists(env, uploadId))) return { ok: false, reason: "upload_not_found" };

  // Fetch one extra row to know whether a next page exists, per docs/decisions.md's
  // (ts, id) keyset - the same tiebreaker idx_checks_day already sorts by.
  const rows = cursor
    ? await env.DB.prepare(
        `SELECT id, service_id as serviceId, service_name as serviceName, region, agent, ts, day,
                status_code as statusCode, status_class as statusClass, latency_ms as latencyMs,
                degraded, corrections
         FROM checks
         WHERE upload_id = ?1 AND day BETWEEN ?2 AND ?3 AND (ts > ?4 OR (ts = ?4 AND id > ?5))
         ORDER BY ts ASC, id ASC
         LIMIT ?6`,
      )
        .bind(uploadId, from, to, cursor.ts, cursor.id, limit + 1)
        .all<LogQueryRow>()
    : await env.DB.prepare(
        `SELECT id, service_id as serviceId, service_name as serviceName, region, agent, ts, day,
                status_code as statusCode, status_class as statusClass, latency_ms as latencyMs,
                degraded, corrections
         FROM checks
         WHERE upload_id = ?1 AND day BETWEEN ?2 AND ?3
         ORDER BY ts ASC, id ASC
         LIMIT ?4`,
      )
        .bind(uploadId, from, to, limit + 1)
        .all<LogQueryRow>();

  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? `${last.ts}:${last.id}` : null;

  return {
    ok: true,
    logs: {
      rows: page.map((r) => ({
        ...r,
        degraded: r.degraded === 1,
        corrections: r.corrections.length > 0 ? r.corrections.split(CORRECTIONS_SEPARATOR) : [],
      })),
      nextCursor,
    },
  };
}
