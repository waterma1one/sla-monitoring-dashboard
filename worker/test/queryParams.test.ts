import { describe, it, expect } from "vitest";
import { parseDateFilter, parsePagination, daysBetweenInclusive } from "../src/queryParams";

function params(query: Record<string, string>): URLSearchParams {
  return new URLSearchParams(query);
}

describe("parseDateFilter", () => {
  it("accepts a single day and treats it as a one-day range", () => {
    const result = parseDateFilter(params({ day: "2025-05-08" }));
    expect(result).toEqual({ ok: true, filter: { from: "2025-05-08", to: "2025-05-08" } });
  });

  it("accepts a from/to range", () => {
    const result = parseDateFilter(params({ from: "2025-05-08", to: "2025-05-10" }));
    expect(result).toEqual({ ok: true, filter: { from: "2025-05-08", to: "2025-05-10" } });
  });

  it("rejects when neither day nor from/to is given", () => {
    const result = parseDateFilter(params({}));
    expect(result.ok).toBe(false);
  });

  it("rejects day combined with from/to", () => {
    const result = parseDateFilter(params({ day: "2025-05-08", from: "2025-05-01", to: "2025-05-10" }));
    expect(result.ok).toBe(false);
  });

  it("rejects from without to", () => {
    const result = parseDateFilter(params({ from: "2025-05-01" }));
    expect(result.ok).toBe(false);
  });

  it("rejects an inverted range", () => {
    const result = parseDateFilter(params({ from: "2025-05-10", to: "2025-05-01" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed date", () => {
    const result = parseDateFilter(params({ day: "05/08/2025" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a calendar-impossible date", () => {
    const result = parseDateFilter(params({ day: "2025-02-30" }));
    expect(result.ok).toBe(false);
  });
});

describe("daysBetweenInclusive", () => {
  it("counts a single day as 1", () => {
    expect(daysBetweenInclusive("2025-05-08", "2025-05-08")).toBe(1);
  });

  it("counts an inclusive span", () => {
    expect(daysBetweenInclusive("2025-05-08", "2025-05-10")).toBe(3);
  });
});

describe("parsePagination", () => {
  it("defaults to a limit with no cursor", () => {
    const result = parsePagination(params({}));
    expect(result).toEqual({ ok: true, limit: 100, cursor: null });
  });

  it("accepts an explicit limit within bounds", () => {
    const result = parsePagination(params({ limit: "25" }));
    expect(result).toEqual({ ok: true, limit: 25, cursor: null });
  });

  it("rejects a limit above the max", () => {
    const result = parsePagination(params({ limit: "5000" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a limit of zero", () => {
    const result = parsePagination(params({ limit: "0" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer limit", () => {
    const result = parsePagination(params({ limit: "12.5" }));
    expect(result.ok).toBe(false);
  });

  it("parses a valid cursor", () => {
    const result = parsePagination(params({ cursor: "1748689200:42" }));
    expect(result).toEqual({ ok: true, limit: 100, cursor: { ts: 1748689200, id: 42 } });
  });

  it("rejects a malformed cursor", () => {
    const result = parsePagination(params({ cursor: "not-a-cursor" }));
    expect(result.ok).toBe(false);
  });
});
