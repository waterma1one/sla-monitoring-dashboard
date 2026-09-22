// Pure cleaning functions for the SLA monitoring pipeline.
//
// No Worker or D1 imports here, deliberately: docs/decisions.md section 2 requires
// these to be testable in isolation. Each function implements one rule (C1-C11)
// from that document; the finding it responds to (F1-F13) is in docs/data-findings.md.

/** C1 (F1): latency_unit 's' means the value is seconds; convert to milliseconds. */
export function convertLatencyUnit(value: number, unit: string): number {
  return unit === "s" ? value * 1000 : value;
}

export type ParsedTimestamp = {
  epochSeconds: number;
  correction: "ts_epoch" | "ts_offset" | null;
};

const EPOCH_SECONDS = /^\d{10}$/;
const HAS_OFFSET = /[+-]\d{2}:\d{2}$/;

/**
 * C2 (F2): parse a `...Z` timestamp, a 10-digit epoch-seconds timestamp, or a
 * `+HH:MM`/`-HH:MM` offset timestamp to one UTC instant. Returns null when the
 * timestamp matches none of the three formats, or matches one but the value it
 * carries is not a real calendar instant - the caller rejects the row (C11).
 */
export function parseTimestamp(raw: string): ParsedTimestamp | null {
  if (EPOCH_SECONDS.test(raw)) {
    return { epochSeconds: Number(raw), correction: "ts_epoch" };
  }
  if (raw.endsWith("Z")) {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return null;
    return { epochSeconds: Math.floor(ms / 1000), correction: null };
  }
  if (HAS_OFFSET.test(raw)) {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return null;
    return { epochSeconds: Math.floor(ms / 1000), correction: "ts_offset" };
  }
  return null;
}

/**
 * C3 (F3): the stored day is derived from the UTC instant after C2, never from
 * the calendar date written in the source string - so a +05:30 row near midnight
 * cannot leak into the wrong billing day.
 */
export function deriveDay(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export type StatusClass = "available" | "unavailable" | "invalid";

/**
 * C6 (F8): an allowlist, not a `not 5xx` test - so an unseen 4xx classifies as
 * invalid instead of available, and 999 (not a real HTTP status) lands in invalid
 * rather than being guessed as either up or down.
 */
export function classifyStatus(code: number): StatusClass {
  if (code >= 200 && code < 400) return "available";
  if (code >= 500 && code < 600) return "unavailable";
  return "invalid";
}

/**
 * C7 (F9): a negative latency is physically impossible, so it is nulled rather
 * than repaired with abs() - a plausible magnitude is not a licence to guess
 * at intent. Status is untouched, so the row still counts toward availability.
 */
export function nullIfNegative(value: number): number | null {
  return value < 0 ? null : value;
}

export type ParsedLatency =
  | { kind: "value"; value: number }
  | { kind: "blank" }
  | { kind: "invalid" };

/**
 * C8 (F10) and the latency half of C11: a genuinely empty field is blank - the
 * check still ran and still counts toward availability, it just contributes no
 * latency. Anything present but not a number is structurally invalid instead,
 * for the caller to reject the whole row.
 */
export function parseLatencyField(raw: string): ParsedLatency {
  if (raw === "") return { kind: "blank" };
  const value = Number(raw);
  if (Number.isNaN(value)) return { kind: "invalid" };
  return { kind: "value", value };
}

const DEGRADED_THRESHOLD_MS = 1000;

/**
 * C9 (F11): a slow-but-successful response is flagged degraded, never counted
 * as downtime - a latency threshold must never silently change the credit owed.
 * 1000ms is the smallest round number above the observed p95 of 754-766ms.
 */
export function computeDegraded(statusClass: StatusClass, latencyMs: number | null): boolean {
  return statusClass === "available" && latencyMs !== null && latencyMs > DEGRADED_THRESHOLD_MS;
}

export type AcceptedRow = {
  serviceId: string;
  serviceName: string;
  region: string;
  agent: string;
  ts: number;
  day: string;
  statusCode: number;
  statusClass: StatusClass;
  latencyMs: number | null;
  degraded: boolean;
  corrections: string[];
};

export type RejectedRow = {
  lineNo: number;
  raw: string;
  reason: string;
};

export type CleanResult =
  | { accepted: true; row: AcceptedRow }
  | { accepted: false; row: RejectedRow };

const EXPECTED_FIELD_COUNT = 8;

/**
 * C11 orchestration: structural validation, then C1-C3 and C6-C9 wired together.
 * A structurally broken row - wrong field count, unparseable timestamp, a
 * non-numeric latency or status - is rejected with a reason rather than cleaned.
 * None of these four cases occurs in the five source files, but the Worker must
 * still handle them per docs/decisions.md C11.
 */
export function cleanRow(fields: string[], lineNo: number, raw: string): CleanResult {
  if (fields.length !== EXPECTED_FIELD_COUNT) {
    return { accepted: false, row: { lineNo, raw, reason: "wrong field count" } };
  }

  const [serviceId, serviceName, timestamp, statusCodeRaw, latencyRaw, latencyUnit, agent, region] = fields as [
    string, string, string, string, string, string, string, string,
  ];

  const parsedTs = parseTimestamp(timestamp);
  if (parsedTs === null) {
    return { accepted: false, row: { lineNo, raw, reason: "unparseable timestamp" } };
  }

  if (statusCodeRaw.trim() === "" || !Number.isFinite(Number(statusCodeRaw))) {
    return { accepted: false, row: { lineNo, raw, reason: "non-numeric status" } };
  }
  const statusCode = Number(statusCodeRaw);

  const parsedLatency = parseLatencyField(latencyRaw);
  if (parsedLatency.kind === "invalid") {
    return { accepted: false, row: { lineNo, raw, reason: "non-numeric latency" } };
  }

  const corrections: string[] = [];
  if (parsedTs.correction) corrections.push(parsedTs.correction);

  let latencyMs: number | null;
  if (parsedLatency.kind === "blank") {
    latencyMs = null;
    corrections.push("latency_missing");
  } else {
    if (latencyUnit === "s") corrections.push("unit_converted");
    const converted = convertLatencyUnit(parsedLatency.value, latencyUnit);
    const nulled = nullIfNegative(converted);
    if (nulled === null) corrections.push("latency_negative");
    latencyMs = nulled;
  }

  const statusClass = classifyStatus(statusCode);
  if (statusClass === "invalid") corrections.push("status_invalid");

  const degraded = computeDegraded(statusClass, latencyMs);

  return {
    accepted: true,
    row: {
      serviceId,
      serviceName,
      region,
      agent,
      ts: parsedTs.epochSeconds,
      day: deriveDay(parsedTs.epochSeconds),
      statusCode,
      statusClass,
      latencyMs,
      degraded,
      corrections,
    },
  };
}

/**
 * C4 (F5): discards exact duplicates within a batch of already-cleaned rows,
 * using the same key as the schema's idx_checks_dedup unique index - so a chunk
 * ingested through this function and one that instead hits INSERT OR IGNORE
 * agree on what counts as a duplicate. COALESCE(latency_ms, -1) in the index
 * means two blank-latency rows collide too; mirrored here with the same sentinel.
 */
export function dedupeAccepted(rows: AcceptedRow[]): { kept: AcceptedRow[]; duplicateCount: number } {
  const seen = new Set<string>();
  const kept: AcceptedRow[] = [];
  let duplicateCount = 0;

  for (const row of rows) {
    const key = [row.serviceId, row.ts, row.agent, row.statusCode, row.latencyMs ?? -1].join("|");
    if (seen.has(key)) {
      duplicateCount++;
      continue;
    }
    seen.add(key);
    kept.push(row);
  }

  return { kept, duplicateCount };
}
