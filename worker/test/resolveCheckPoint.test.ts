import { describe, it, expect } from "vitest";
import { resolveCheckPoint } from "../src/resolveCheckPoint";
import type { AcceptedRow } from "../src/cleaning";

// resolveCheckPoint is deliberately unimplemented - see the TODO in
// src/resolveCheckPoint.ts. These tests encode docs/decisions.md section 1 and
// are meant to be turned green by hand, not generated.

function report(overrides: Partial<AcceptedRow> = {}): AcceptedRow {
  return {
    serviceId: "svc-search",
    serviceName: "search-api",
    region: "ap-south-1",
    agent: "agent-1",
    ts: 1748689200,
    day: "2025-05-31",
    statusCode: 200,
    statusClass: "available",
    latencyMs: 300,
    degraded: false,
    corrections: [],
    ...overrides,
  };
}

describe("resolveCheckPoint", () => {
  it("F8: a lone invalid (999) report resolves to excluded, not repaired to up or down", () => {
    const result = resolveCheckPoint([
      report({ agent: "agent-1", statusCode: 999, statusClass: "invalid", latencyMs: 632 }),
    ]);
    expect(result).toEqual({ status: "excluded", latencyMs: null, degraded: false });
  });

  it("resolves to available when the only valid report succeeded", () => {
    const result = resolveCheckPoint([report({ statusCode: 200, statusClass: "available" })]);
    expect(result.status).toBe("available");
  });

  it("resolves to unavailable when any valid report is 5xx - worst status wins", () => {
    const result = resolveCheckPoint([
      report({ agent: "agent-1", statusCode: 200, statusClass: "available", latencyMs: 300 }),
      report({ agent: "agent-2", statusCode: 503, statusClass: "unavailable", latencyMs: 3000 }),
    ]);
    expect(result.status).toBe("unavailable");
  });

  it("F7: agent disagreement (999 vs 200) resolves on the valid report alone", () => {
    const result = resolveCheckPoint([
      report({ agent: "agent-1", statusCode: 999, statusClass: "invalid", latencyMs: 632 }),
      report({ agent: "agent-2", statusCode: 200, statusClass: "available", latencyMs: 638 }),
    ]);
    expect(result.status).toBe("available");
  });

  it("F6: mean-of-non-null latency uses the twin's real measurement when one copy is blank", () => {
    const result = resolveCheckPoint([
      report({ agent: "agent-1", latencyMs: null }),
      report({ agent: "agent-1", latencyMs: 269 }),
    ]);
    expect(result.latencyMs).toBe(269);
  });

  it("averages latency across two valid reports at the same check-point", () => {
    const result = resolveCheckPoint([
      report({ agent: "agent-1", latencyMs: 300 }),
      report({ agent: "agent-2", latencyMs: 308 }),
    ]);
    expect(result.latencyMs).toBe(304);
  });

  it("latencyMs is null when no valid report carries a latency", () => {
    const result = resolveCheckPoint([report({ latencyMs: null })]);
    expect(result.latencyMs).toBeNull();
  });

  it("degraded is recomputed from the resolved mean, not OR'd from any single report's row-level flag", () => {
    // 950 alone is not degraded; 1010 alone is. The mean, 980, is not.
    const result = resolveCheckPoint([
      report({ agent: "agent-1", latencyMs: 950, degraded: false }),
      report({ agent: "agent-2", latencyMs: 1010, degraded: true }),
    ]);
    expect(result.degraded).toBe(false);
  });

  it("an unavailable check-point is never degraded, however high the latency", () => {
    const result = resolveCheckPoint([
      report({ statusCode: 503, statusClass: "unavailable", latencyMs: 3000 }),
    ]);
    expect(result.degraded).toBe(false);
  });

  it("excluded when every report is invalid, even with two agents", () => {
    const result = resolveCheckPoint([
      report({ agent: "agent-1", statusCode: 999, statusClass: "invalid", latencyMs: 116 }),
      report({ agent: "agent-2", statusCode: 999, statusClass: "invalid", latencyMs: 120 }),
    ]);
    expect(result).toEqual({ status: "excluded", latencyMs: null, degraded: false });
  });
});
