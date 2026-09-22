import { describe, it, expect } from "vitest";
import {
  convertLatencyUnit,
  parseTimestamp,
  deriveDay,
  classifyStatus,
  nullIfNegative,
  parseLatencyField,
  computeDegraded,
  cleanRow,
  dedupeAccepted,
  type AcceptedRow,
} from "../src/cleaning";

function acceptedRow(overrides: Partial<AcceptedRow> = {}): AcceptedRow {
  return {
    serviceId: "svc-auth",
    serviceName: "auth-api",
    region: "ap-south-1",
    agent: "agent-1",
    ts: 1744830000,
    day: "2025-04-16",
    statusCode: 200,
    statusClass: "available",
    latencyMs: 300,
    degraded: false,
    corrections: [],
    ...overrides,
  };
}

describe("convertLatencyUnit (C1)", () => {
  it("converts seconds to milliseconds", () => {
    expect(convertLatencyUnit(0.632, "s")).toBe(632);
  });

  it("leaves milliseconds unchanged", () => {
    expect(convertLatencyUnit(116, "ms")).toBe(116);
  });
});

describe("parseTimestamp (C2)", () => {
  it("parses a Z-suffixed UTC timestamp with no correction flag", () => {
    expect(parseTimestamp("2025-04-16T19:00:00Z")).toEqual({
      epochSeconds: Date.UTC(2025, 3, 16, 19, 0, 0) / 1000,
      correction: null,
    });
  });

  it("parses a 10-digit epoch-seconds timestamp, flagged ts_epoch", () => {
    // F2: 1744349400 is documented as 2025-04-11T05:30:00Z.
    expect(parseTimestamp("1744349400")).toEqual({
      epochSeconds: 1744349400,
      correction: "ts_epoch",
    });
  });

  it("parses a +05:30 offset timestamp to its UTC instant, flagged ts_offset", () => {
    expect(parseTimestamp("2025-06-01T12:00:00+05:30")).toEqual({
      epochSeconds: Date.UTC(2025, 5, 1, 6, 30, 0) / 1000,
      correction: "ts_offset",
    });
  });

  it("returns null for an unparseable timestamp", () => {
    expect(parseTimestamp("not-a-timestamp")).toBeNull();
  });
});

describe("deriveDay (C3)", () => {
  it("derives the UTC calendar date from an epoch instant", () => {
    const epochSeconds = Date.UTC(2025, 3, 16, 19, 0, 0) / 1000;
    expect(deriveDay(epochSeconds)).toBe("2025-04-16");
  });

  it("F3: a +05:30 instant just after local midnight lands on the prior UTC day", () => {
    // 2025-06-01T02:30:00+05:30 is 2025-05-31T21:00:00Z - a different calendar date.
    const parsed = parseTimestamp("2025-06-01T02:30:00+05:30")!;
    expect(deriveDay(parsed.epochSeconds)).toBe("2025-05-31");
  });
});

describe("classifyStatus (C6)", () => {
  it("classifies 2xx as available", () => {
    expect(classifyStatus(200)).toBe("available");
  });

  it("classifies 3xx as available", () => {
    expect(classifyStatus(302)).toBe("available");
  });

  it("classifies 5xx as unavailable", () => {
    expect(classifyStatus(503)).toBe("unavailable");
  });

  it("F8: classifies 999 as invalid, not repaired to 200", () => {
    expect(classifyStatus(999)).toBe("invalid");
  });

  it("classifies an unseen 4xx as invalid, not as available under a not-5xx test", () => {
    expect(classifyStatus(404)).toBe("invalid");
  });
});

describe("nullIfNegative (C7)", () => {
  it("F9: nulls a negative latency rather than repairing it with abs()", () => {
    expect(nullIfNegative(-296)).toBeNull();
  });

  it("leaves a non-negative latency unchanged", () => {
    expect(nullIfNegative(269)).toBe(269);
  });

  it("leaves zero unchanged", () => {
    expect(nullIfNegative(0)).toBe(0);
  });
});

describe("parseLatencyField (C8, and the latency half of C11)", () => {
  it("parses a numeric latency string", () => {
    expect(parseLatencyField("389")).toEqual({ kind: "value", value: 389 });
  });

  it("F10: recognises a genuinely empty field as blank, not invalid", () => {
    expect(parseLatencyField("")).toEqual({ kind: "blank" });
  });

  it("C11: a non-numeric latency is invalid, for the caller to reject", () => {
    expect(parseLatencyField("not-a-number")).toEqual({ kind: "invalid" });
  });
});

describe("computeDegraded (C9)", () => {
  it("F11: an available check-point over 1000ms is degraded", () => {
    expect(computeDegraded("available", 2193)).toBe(true);
  });

  it("an available check-point at or under 1000ms is not degraded", () => {
    expect(computeDegraded("available", 754)).toBe(false);
  });

  it("a slow response never makes uptime the deciding factor - unavailable is never degraded", () => {
    expect(computeDegraded("unavailable", 3000)).toBe(false);
  });

  it("a null latency is never degraded", () => {
    expect(computeDegraded("available", null)).toBe(false);
  });
});

describe("cleanRow (C11 orchestration)", () => {
  const clean = (fields: string[]) => cleanRow(fields, 1, fields.join(","));

  it("accepts a clean row with no corrections", () => {
    const result = clean(["svc-auth", "auth-api", "2025-04-16T18:00:00Z", "200", "300", "ms", "agent-1", "ap-south-1"]);
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error("expected accepted");
    expect(result.row).toMatchObject({
      serviceId: "svc-auth",
      statusCode: 200,
      statusClass: "available",
      latencyMs: 300,
      degraded: false,
      corrections: [],
    });
  });

  it("F1: converts a seconds-latency row and flags unit_converted", () => {
    const result = clean(["svc-search", "search-api", "2025-05-31T11:00:00Z", "200", "0.632", "s", "agent-1", "ap-south-1"]);
    if (!result.accepted) throw new Error("expected accepted");
    expect(result.row.latencyMs).toBe(632);
    expect(result.row.corrections).toContain("unit_converted");
  });

  it("F8: a 999 status is invalid but its latency still cleans normally", () => {
    const result = clean(["svc-payments", "payments-api", "2025-05-10T22:30:00Z", "999", "389", "ms", "agent-1", "ap-south-1"]);
    if (!result.accepted) throw new Error("expected accepted");
    expect(result.row.statusClass).toBe("invalid");
    expect(result.row.latencyMs).toBe(389);
    expect(result.row.corrections).toContain("status_invalid");
  });

  it("F9: a negative latency is nulled and flagged, status untouched", () => {
    const result = clean(["svc-notify", "notify-worker", "2025-04-19T14:15:00Z", "200", "-296", "ms", "agent-1", "ap-south-1"]);
    if (!result.accepted) throw new Error("expected accepted");
    expect(result.row.latencyMs).toBeNull();
    expect(result.row.statusClass).toBe("available");
    expect(result.row.corrections).toContain("latency_negative");
  });

  it("F10: a blank latency is nulled and flagged, row still accepted", () => {
    const result = clean(["svc-reports", "reports-api", "2025-05-13T15:30:00Z", "200", "", "ms", "agent-1", "ap-south-1"]);
    if (!result.accepted) throw new Error("expected accepted");
    expect(result.row.latencyMs).toBeNull();
    expect(result.row.corrections).toContain("latency_missing");
  });

  it("F2: an epoch-format timestamp is flagged ts_epoch", () => {
    const result = clean(["svc-auth", "auth-api", "1744349400", "200", "300", "ms", "agent-1", "ap-south-1"]);
    if (!result.accepted) throw new Error("expected accepted");
    expect(result.row.corrections).toContain("ts_epoch");
  });

  it("F3: a +05:30 offset row is flagged ts_offset and its day is the UTC day", () => {
    const result = clean(["svc-search", "search-api", "2025-06-01T02:30:00+05:30", "200", "300", "ms", "agent-1", "ap-south-1"]);
    if (!result.accepted) throw new Error("expected accepted");
    expect(result.row.corrections).toContain("ts_offset");
    expect(result.row.day).toBe("2025-05-31");
  });

  it("F11: a slow available row is flagged degraded", () => {
    const result = clean(["svc-reports", "reports-api", "2025-05-13T16:30:00Z", "200", "2193", "ms", "agent-1", "ap-south-1"]);
    if (!result.accepted) throw new Error("expected accepted");
    expect(result.row.degraded).toBe(true);
  });

  it("C11: rejects a row with the wrong field count", () => {
    const result = clean(["svc-auth", "auth-api", "2025-04-16T18:00:00Z", "200", "300", "ms", "agent-1"]);
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("expected rejected");
    expect(result.row.reason).toBe("wrong field count");
  });

  it("C11: rejects a row with an unparseable timestamp", () => {
    const result = clean(["svc-auth", "auth-api", "not-a-timestamp", "200", "300", "ms", "agent-1", "ap-south-1"]);
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("expected rejected");
    expect(result.row.reason).toBe("unparseable timestamp");
  });

  it("C11: rejects a row with a non-numeric latency", () => {
    const result = clean(["svc-auth", "auth-api", "2025-04-16T18:00:00Z", "200", "N/A", "ms", "agent-1", "ap-south-1"]);
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("expected rejected");
    expect(result.row.reason).toBe("non-numeric latency");
  });

  it("C11: rejects a row with a non-numeric status code", () => {
    const result = clean(["svc-auth", "auth-api", "2025-04-16T18:00:00Z", "abc", "300", "ms", "agent-1", "ap-south-1"]);
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("expected rejected");
    expect(result.row.reason).toBe("non-numeric status");
  });
});

describe("dedupeAccepted (C4)", () => {
  it("F5: collapses an exact duplicate pair, keeping one copy", () => {
    const row = acceptedRow();
    const { kept, duplicateCount } = dedupeAccepted([row, { ...row }]);
    expect(kept).toHaveLength(1);
    expect(duplicateCount).toBe(1);
  });

  it("F4: a real second observer at the same check-point is not a duplicate", () => {
    const first = acceptedRow({ agent: "agent-1" });
    const second = acceptedRow({ agent: "agent-2", latencyMs: 308 });
    const { kept, duplicateCount } = dedupeAccepted([first, second]);
    expect(kept).toHaveLength(2);
    expect(duplicateCount).toBe(0);
  });

  it("treats two blank-latency rows as duplicates, matching COALESCE(latency_ms, -1) in the schema", () => {
    const row = acceptedRow({ latencyMs: null });
    const { kept, duplicateCount } = dedupeAccepted([row, { ...row }]);
    expect(kept).toHaveLength(1);
    expect(duplicateCount).toBe(1);
  });

  it("a row that differs only in status_code is not a duplicate", () => {
    const first = acceptedRow({ statusCode: 200 });
    const second = acceptedRow({ statusCode: 500, statusClass: "unavailable" });
    const { kept, duplicateCount } = dedupeAccepted([first, second]);
    expect(kept).toHaveLength(2);
    expect(duplicateCount).toBe(0);
  });
});
