import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanRow, dedupeAccepted } from "../src/cleaning";

// Not new production behavior - an integration check that the whole cleaning
// module survives fixtures/dev_checks.csv (real rows, derived by
// scripts/build_dev_fixture.py) rather than only the synthetic rows above.
const fixturePath = fileURLToPath(new URL("../../fixtures/dev_checks.csv", import.meta.url));
const lines = readFileSync(fixturePath, "utf8").trim().split("\n");
const [, ...dataLines] = lines;

describe("cleaning module against the real dev fixture", () => {
  const results = dataLines.map((line, i) => cleanRow(line.split(","), i + 2, line));
  const accepted = results.filter((r) => r.accepted).map((r) => r.row);
  const rejected = results.filter((r) => !r.accepted);

  it("has exactly 200 data rows", () => {
    expect(dataLines).toHaveLength(200);
  });

  it("accepts every row - the fixture contains no structurally broken rows", () => {
    expect(rejected).toHaveLength(0);
  });

  it("applies every correction flag at least once", () => {
    const allFlags = new Set(accepted.flatMap((r) => r.corrections));
    for (const flag of ["unit_converted", "ts_epoch", "ts_offset", "status_invalid", "latency_negative", "latency_missing"]) {
      expect(allFlags.has(flag), `expected ${flag} to appear somewhere in the fixture`).toBe(true);
    }
  });

  it("flags at least one degraded check-point from the F11 brownout window", () => {
    expect(accepted.some((r) => r.degraded)).toBe(true);
  });

  it("dedupeAccepted removes the fixture's known exact-duplicate pair", () => {
    const { duplicateCount } = dedupeAccepted(accepted);
    expect(duplicateCount).toBeGreaterThan(0);
  });
});
