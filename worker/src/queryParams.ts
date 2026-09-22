// Pure query-parameter parsing for the phase 4 read endpoints. No Worker or D1
// imports, so validation is testable without a simulated D1 binding - the same
// separation cleaning.ts and resolveCheckPoint.ts use for the ingest path.

export type DateFilter = { from: string; to: string };
export type DateFilterResult = { ok: true; filter: DateFilter } | { ok: false; error: string };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false;
  // Date.parse accepts calendar-impossible strings like 2025-02-30 by rolling
  // them into March; round-tripping through toISOString catches that instead
  // of silently querying the wrong day.
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * A single `day`, or a `from`/`to` range, never both, never neither - the
 * assignment requires the logs view to be filterable by exactly one of the two.
 * `day` is returned as a one-day `{ from, to }` range so callers have one shape.
 */
export function parseDateFilter(params: URLSearchParams): DateFilterResult {
  const day = params.get("day");
  const from = params.get("from");
  const to = params.get("to");

  if (day !== null && (from !== null || to !== null)) {
    return { ok: false, error: "specify either day, or from and to, not both" };
  }

  if (day !== null) {
    if (!isValidDay(day)) return { ok: false, error: "day must be a valid YYYY-MM-DD date" };
    return { ok: true, filter: { from: day, to: day } };
  }

  if (from !== null || to !== null) {
    if (from === null || to === null) {
      return { ok: false, error: "from and to must both be given" };
    }
    if (!isValidDay(from) || !isValidDay(to)) {
      return { ok: false, error: "from and to must be valid YYYY-MM-DD dates" };
    }
    if (from > to) {
      return { ok: false, error: "from must not be after to" };
    }
    return { ok: true, filter: { from, to } };
  }

  return { ok: false, error: "day, or from and to, is required" };
}

/** Inclusive day span, e.g. the same day twice is a 1-day range. */
export function daysBetweenInclusive(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

export type LogsCursor = { ts: number; id: number };
export type PaginationResult =
  | { ok: true; limit: number; cursor: LogsCursor | null }
  | { ok: false; error: string };

const DEFAULT_LIMIT = 100;
// Keeps a page well under D1's response size and the browser table readable -
// the largest file is ~15,000 rows, far too many for one response.
const MAX_LIMIT = 500;
const CURSOR_RE = /^(\d+):(\d+)$/;

/**
 * `cursor` is the opaque `"ts:id"` pair from a previous page's `nextCursor`,
 * matching the `WHERE (ts, id) > (?, ?)` keyset in docs/decisions.md's
 * Pagination section - id is the tiebreaker the schema exists to provide.
 */
export function parsePagination(params: URLSearchParams): PaginationResult {
  const limitParam = params.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      return { ok: false, error: `limit must be an integer between 1 and ${MAX_LIMIT}` };
    }
    limit = n;
  }

  const cursorParam = params.get("cursor");
  let cursor: LogsCursor | null = null;
  if (cursorParam !== null) {
    const match = CURSOR_RE.exec(cursorParam);
    if (!match) return { ok: false, error: "cursor is malformed" };
    cursor = { ts: Number(match[1]), id: Number(match[2]) };
  }

  return { ok: true, limit, cursor };
}
