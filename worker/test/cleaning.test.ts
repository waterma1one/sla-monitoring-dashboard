import { describe, it, expect } from "vitest";
import {
  convertLatencyUnit,
  parseTimestamp,
  deriveDay,
  classifyStatus,
  nullIfNegative,
  parseLatencyField,
} from "../src/cleaning";

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
