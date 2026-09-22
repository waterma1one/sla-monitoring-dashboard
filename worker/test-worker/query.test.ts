import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { openUpload, postChunk } from "../src/ingest";
import { getStats, getLogs } from "../src/query";

const HEADER = "service_id,service_name,timestamp,status_code,latency,latency_unit,agent,region";

function row(overrides: Partial<Record<string, string>> = {}): string {
  const fields = {
    service_id: "svc-search",
    service_name: "search-api",
    timestamp: "2025-05-08T00:00:00Z",
    status_code: "200",
    latency: "300",
    latency_unit: "ms",
    agent: "agent-1",
    region: "ap-south-1",
    ...overrides,
  };
  return [
    fields.service_id,
    fields.service_name,
    fields.timestamp,
    fields.status_code,
    fields.latency,
    fields.latency_unit,
    fields.agent,
    fields.region,
  ].join(",");
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM checks");
  await env.DB.exec("DELETE FROM upload_chunks");
  await env.DB.exec("DELETE FROM rejected_rows");
  await env.DB.exec("DELETE FROM uploads");
});

describe("getStats", () => {
  it("returns upload_not_found for a missing upload", async () => {
    const outcome = await getStats(env, "missing-upload", "2025-05-08", "2025-05-08");
    expect(outcome).toEqual({ ok: false, reason: "upload_not_found" });
  });

  it("computes availability, coverage, degraded rate, and latency over the requested range", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    // One service, one day, four check-points: 2 available (one degraded), 1 unavailable, 1 excluded (999).
    await postChunk(
      env,
      uploadId,
      0,
      [
        HEADER,
        row({ timestamp: "2025-05-08T00:00:00Z", status_code: "200", latency: "300" }),
        row({ timestamp: "2025-05-08T00:15:00Z", status_code: "200", latency: "1500" }),
        row({ timestamp: "2025-05-08T00:30:00Z", status_code: "500", latency: "200" }),
        row({ timestamp: "2025-05-08T00:45:00Z", status_code: "999", latency: "100" }),
      ].join("\n"),
    );

    const outcome = await getStats(env, uploadId, "2025-05-08", "2025-05-08");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.stats.checkPoints).toEqual({
      available: 2,
      unavailable: 1,
      excluded: 1,
      expected: 96, // 1 service x 1 day x 96
    });
    expect(outcome.stats.availability).toBeCloseTo(2 / 3, 5); // available / (available + unavailable)
    expect(outcome.stats.degradedRate).toBeCloseTo(1 / 2, 5); // 1 degraded of 2 available
    expect(outcome.stats.coverage).toBeCloseTo(4 / 96, 5); // 4 observed check-points
    expect(outcome.stats.latency.mean).toBeCloseTo((300 + 1500 + 200 + 100) / 4, 5); // over rows, not check-points
  });

  it("excludes rows outside the requested day range", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    await postChunk(
      env,
      uploadId,
      0,
      [
        HEADER,
        row({ timestamp: "2025-05-08T00:00:00Z" }),
        row({ timestamp: "2025-05-09T00:00:00Z", status_code: "500" }),
      ].join("\n"),
    );

    const outcome = await getStats(env, uploadId, "2025-05-08", "2025-05-08");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.stats.checkPoints).toEqual({ available: 1, unavailable: 0, excluded: 0, expected: 96 });
  });

  it("returns null availability and degraded rate when no valid check-points fall in range", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    await postChunk(env, uploadId, 0, [HEADER, row({ status_code: "999" })].join("\n"));

    const outcome = await getStats(env, uploadId, "2025-05-08", "2025-05-08");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.stats.availability).toBeNull();
    expect(outcome.stats.degradedRate).toBeNull();
  });
});

describe("getLogs", () => {
  it("returns upload_not_found for a missing upload", async () => {
    const outcome = await getLogs(env, "missing-upload", "2025-05-08", "2025-05-08", 100, null);
    expect(outcome).toEqual({ ok: false, reason: "upload_not_found" });
  });

  it("filters to a single day", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    await postChunk(
      env,
      uploadId,
      0,
      [
        HEADER,
        row({ timestamp: "2025-05-08T00:00:00Z" }),
        row({ timestamp: "2025-05-09T00:00:00Z" }),
      ].join("\n"),
    );

    const outcome = await getLogs(env, uploadId, "2025-05-08", "2025-05-08", 100, null);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.logs.rows).toHaveLength(1);
    expect(outcome.logs.rows[0]?.day).toBe("2025-05-08");
  });

  it("orders by ts then id and paginates via cursor", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    await postChunk(
      env,
      uploadId,
      0,
      [
        HEADER,
        row({ timestamp: "2025-05-08T00:30:00Z", agent: "agent-1" }),
        row({ timestamp: "2025-05-08T00:00:00Z", agent: "agent-2" }),
        row({ timestamp: "2025-05-08T00:15:00Z", agent: "agent-2" }),
      ].join("\n"),
    );

    const page1 = await getLogs(env, uploadId, "2025-05-08", "2025-05-08", 2, null);
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.logs.rows.map((r) => r.ts)).toEqual([1746662400, 1746663300]); // 00:00, 00:15
    expect(page1.logs.nextCursor).not.toBeNull();

    const cursorMatch = /^(\d+):(\d+)$/.exec(page1.logs.nextCursor!);
    const cursor = { ts: Number(cursorMatch![1]), id: Number(cursorMatch![2]) };

    const page2 = await getLogs(env, uploadId, "2025-05-08", "2025-05-08", 2, cursor);
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.logs.rows.map((r) => r.ts)).toEqual([1746664200]); // 00:30
    expect(page2.logs.nextCursor).toBeNull();
  });
});
