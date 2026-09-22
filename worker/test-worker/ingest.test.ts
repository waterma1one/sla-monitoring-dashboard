import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { openUpload, postChunk, finalizeUpload } from "../src/ingest";

const HEADER = "service_id,service_name,timestamp,status_code,latency,latency_unit,agent,region";

function row(overrides: Partial<Record<string, string>> = {}): string {
  const fields = {
    service_id: "svc-search",
    service_name: "search-api",
    timestamp: "2025-05-08T05:45:00Z",
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

describe("openUpload", () => {
  it("mints an upload id and records it as open", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    const stored = await env.DB.prepare("SELECT status, filename FROM uploads WHERE id = ?1")
      .bind(uploadId)
      .first<{ status: string; filename: string }>();
    expect(stored).toEqual({ status: "open", filename: "checks.csv" });
  });
});

describe("postChunk", () => {
  it("rejects a chunk for an unknown upload", async () => {
    const outcome = await postChunk(env, "missing-upload", 0, [HEADER, row()].join("\n"));
    expect(outcome).toEqual({ ok: false, reason: "upload_not_found" });
  });

  it("cleans, dedupes, and persists a chunk's rows", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    const chunk = [
      HEADER,
      row({ agent: "agent-1", latency: "0.5", latency_unit: "s" }), // corrected: unit_converted
      row({ agent: "agent-2", status_code: "999" }), // corrected: status_invalid, still accepted
    ].join("\n");

    const outcome = await postChunk(env, uploadId, 0, chunk);
    expect(outcome).toEqual({
      ok: true,
      summary: { rowsTotal: 2, rowsAccepted: 2, rowsCorrected: 2, rowsRejected: 0, rowsDuplicate: 0 },
    });

    const persisted = await env.DB.prepare("SELECT COUNT(*) as n FROM checks WHERE upload_id = ?1")
      .bind(uploadId)
      .first<{ n: number }>();
    expect(persisted?.n).toBe(2);
  });

  it("strips the carriage return from a CRLF chunk", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    // The source CSVs are CRLF, so this is the real shape of a chunk, not an edge case.
    const chunk = [HEADER, row()].join("\r\n") + "\r\n";

    await postChunk(env, uploadId, 0, chunk);

    const stored = await env.DB.prepare("SELECT region FROM checks WHERE upload_id = ?1")
      .bind(uploadId)
      .first<{ region: string }>();
    expect(stored?.region).toBe("ap-south-1");
  });

  it("quarantines a structurally invalid row instead of persisting it", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    const chunk = [HEADER, row({ status_code: "not-a-number" })].join("\n");

    const outcome = await postChunk(env, uploadId, 0, chunk);
    expect(outcome).toEqual({
      ok: true,
      summary: { rowsTotal: 1, rowsAccepted: 0, rowsCorrected: 0, rowsRejected: 1, rowsDuplicate: 0 },
    });

    const rejected = await env.DB.prepare("SELECT reason FROM rejected_rows WHERE upload_id = ?1")
      .bind(uploadId)
      .first<{ reason: string }>();
    expect(rejected?.reason).toBe("non-numeric status");
  });

  it("records a rejected row's line number in the source file, not in its chunk", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    await postChunk(env, uploadId, 0, [HEADER, row(), row({ agent: "agent-2" })].join("\n"));
    // Chunk 1's first data row is source line 4: header, then chunk 0's two rows.
    await postChunk(env, uploadId, 1, [HEADER, row({ status_code: "not-a-number" })].join("\n"));

    const rejected = await env.DB.prepare("SELECT line_no FROM rejected_rows WHERE upload_id = ?1")
      .bind(uploadId)
      .first<{ line_no: number }>();
    expect(rejected?.line_no).toBe(4);
  });

  it("counts an exact duplicate within one chunk and does not persist it twice", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    const chunk = [HEADER, row(), row()].join("\n");

    const outcome = await postChunk(env, uploadId, 0, chunk);
    expect(outcome).toEqual({
      ok: true,
      summary: { rowsTotal: 2, rowsAccepted: 1, rowsCorrected: 0, rowsRejected: 0, rowsDuplicate: 1 },
    });
  });

  it("catches a duplicate that straddles a chunk boundary via the DB unique index", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    await postChunk(env, uploadId, 0, [HEADER, row()].join("\n"));
    const outcome = await postChunk(env, uploadId, 1, [HEADER, row()].join("\n"));

    expect(outcome).toEqual({
      ok: true,
      summary: { rowsTotal: 1, rowsAccepted: 0, rowsCorrected: 0, rowsRejected: 0, rowsDuplicate: 1 },
    });
  });

  it("replaying the same chunk index is idempotent, not a second ingest", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    const chunk = [HEADER, row()].join("\n");

    const first = await postChunk(env, uploadId, 0, chunk);
    const replay = await postChunk(env, uploadId, 0, chunk);
    expect(replay).toEqual(first);

    const chunkRows = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM upload_chunks WHERE upload_id = ?1 AND chunk_index = 0",
    )
      .bind(uploadId)
      .first<{ n: number }>();
    expect(chunkRows?.n).toBe(1);
  });

  it("refuses a chunk once the upload is already finalized", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    await postChunk(env, uploadId, 0, [HEADER, row()].join("\n"));
    await finalizeUpload(env, uploadId);

    const outcome = await postChunk(env, uploadId, 1, [HEADER, row()].join("\n"));
    expect(outcome).toEqual({ ok: false, reason: "upload_not_open" });
  });
});

describe("finalizeUpload", () => {
  it("sums chunk counters, derives the day range, and tallies corrections", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    await postChunk(
      env,
      uploadId,
      0,
      [
        HEADER,
        row({ timestamp: "2025-05-08T00:00:00Z", latency: "0.5", latency_unit: "s" }),
        row({ agent: "agent-2", timestamp: "2025-05-09T00:00:00Z" }),
      ].join("\n"),
    );

    const outcome = await finalizeUpload(env, uploadId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.summary).toMatchObject({
      status: "complete",
      dayFirst: "2025-05-08",
      dayLast: "2025-05-09",
      rowsTotal: 2,
      rowsAccepted: 2,
      rowsCorrected: 1,
      rowsRejected: 0,
      rowsDuplicate: 0,
      corrections: { unit_converted: 1 },
    });

    const stored = await env.DB.prepare("SELECT status FROM uploads WHERE id = ?1")
      .bind(uploadId)
      .first<{ status: string }>();
    expect(stored?.status).toBe("complete");
  });

  it("refuses to finalize an unknown upload", async () => {
    const outcome = await finalizeUpload(env, "missing-upload");
    expect(outcome).toEqual({ ok: false, reason: "upload_not_found" });
  });

  it("refuses to finalize an upload twice", async () => {
    const { uploadId } = await openUpload(env, "checks.csv");
    await postChunk(env, uploadId, 0, [HEADER, row()].join("\n"));
    await finalizeUpload(env, uploadId);

    const outcome = await finalizeUpload(env, uploadId);
    expect(outcome).toEqual({ ok: false, reason: "upload_not_open" });
  });
});
