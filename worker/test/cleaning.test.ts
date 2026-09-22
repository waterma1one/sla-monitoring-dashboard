import { describe, it, expect } from "vitest";
import { convertLatencyUnit } from "../src/cleaning";

describe("convertLatencyUnit (C1)", () => {
  it("converts seconds to milliseconds", () => {
    expect(convertLatencyUnit(0.632, "s")).toBe(632);
  });

  it("leaves milliseconds unchanged", () => {
    expect(convertLatencyUnit(116, "ms")).toBe(116);
  });
});
