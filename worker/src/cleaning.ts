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
