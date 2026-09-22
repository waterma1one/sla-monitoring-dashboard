// Pure cleaning functions for the SLA monitoring pipeline.
//
// No Worker or D1 imports here, deliberately: docs/decisions.md section 2 requires
// these to be testable in isolation. Each function implements one rule (C1-C11)
// from that document; the finding it responds to (F1-F13) is in docs/data-findings.md.

/** C1 (F1): latency_unit 's' means the value is seconds; convert to milliseconds. */
export function convertLatencyUnit(value: number, unit: string): number {
  return unit === "s" ? value * 1000 : value;
}
