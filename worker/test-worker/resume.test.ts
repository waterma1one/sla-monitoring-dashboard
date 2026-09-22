import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";

// The resumable-upload path exists because a 15,000-row CSV is posted as a
// sequence of chunk requests, and any one of them can be lost in flight. Until
// now it was only covered at the function level (postChunk called twice in
// process). These tests drive the real fetch handler over HTTP and replicate the
// browser's loop in UploadScreen.tsx, including its resume-from-failed-index
// behaviour, because the interesting failures live in the round trip rather than
// in postChunk itself.
//
// Every test asserts the same invariant: however a chunk request dies, resuming
// from the chunk the client believes failed produces byte-identical totals to an
// upload that was never interrupted, and never a duplicated row.

const BASE = "https://worker.test";
const HEADER = "service_id,service_name,timestamp,status_code,latency,latency_unit,agent,region";

function row(minute: number, overrides: Partial<Record<string, string>> = {}): string {
  const mm = String(minute % 60).padStart(2, "0");
  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const fields = {
    service_id: "svc-search",
    service_name: "search-api",
    timestamp: `2025-05-08T${hh}:${mm}:00Z`,
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

// Three chunks, header prepended to each, matching buildChunks() in the frontend.
// Chunk 1 carries a unit conversion and a reject so the totals under test are not
// all zeroes - a resume that silently dropped a chunk would otherwise still match.
function buildChunks(): string[] {
  return [
    [HEADER, row(0), row(1)].join("\r\n"),
    [HEADER, row(2, { latency: "0.4", latency_unit: "s" }), "svc-search,search-api,not-a-time"].join("\r\n"),
    [HEADER, row(4), row(4)].join("\r\n"),
  ];
}

type Summary = Record<string, unknown>;

async function openUpload(filename: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { uploadId: string }).uploadId;
}

function chunkUrl(uploadId: string, index: number): string {
  return `${BASE}/uploads/${uploadId}/chunks/${index}`;
}

async function postChunk(uploadId: string, index: number, body: string): Promise<Response> {
  const res = await SELF.fetch(chunkUrl(uploadId, index), { method: "POST", body });
  expect(res.status).toBe(200);
  return res;
}

async function finalize(uploadId: string): Promise<Summary> {
  const res = await SELF.fetch(`${BASE}/uploads/${uploadId}/finalize`, { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as Summary;
}

// What the browser does: post every chunk from startIndex on, then finalize.
async function drainFrom(uploadId: string, chunks: string[], startIndex: number): Promise<Summary> {
  for (let i = startIndex; i < chunks.length; i++) {
    await postChunk(uploadId, i, chunks[i]!);
  }
  return finalize(uploadId);
}

async function rowCount(uploadId: string): Promise<number> {
  const n = await env.DB.prepare("SELECT COUNT(*) as n FROM checks WHERE upload_id = ?1")
    .bind(uploadId)
    .first<{ n: number }>();
  return n?.n ?? 0;
}

// The summary carries the upload's own id, which differs per run by construction.
function comparable(summary: Summary): Summary {
  const { uploadId: _ignored, ...rest } = summary;
  return rest;
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM checks");
  await env.DB.exec("DELETE FROM upload_chunks");
  await env.DB.exec("DELETE FROM rejected_rows");
  await env.DB.exec("DELETE FROM uploads");
});

describe("resuming an upload whose chunk request was lost", () => {
  // The control. Every other test in this file is compared against it rather than
  // against hand-written totals, so the comparison keeps meaning if cleaning changes.
  async function uninterrupted(): Promise<{ summary: Summary; rows: number }> {
    const chunks = buildChunks();
    const uploadId = await openUpload("control.csv");
    const summary = await drainFrom(uploadId, chunks, 0);
    return { summary: comparable(summary), rows: await rowCount(uploadId) };
  }

  it("gives the same totals when the response was lost after the server committed", async () => {
    // The dangerous half of a dropped request: the Worker ran to completion and
    // wrote the rows, but the client never saw the 200 and cannot tell this case
    // from one where nothing arrived. It retries the same index. A server that
    // re-ingested here would double the rows and overstate the accepted count.
    const control = await uninterrupted();

    const chunks = buildChunks();
    const uploadId = await openUpload("lost-response.csv");
    await postChunk(uploadId, 0, chunks[0]!);
    await postChunk(uploadId, 1, chunks[1]!); // committed; imagine the response never lands
    const summary = await drainFrom(uploadId, chunks, 1); // client retries from 1

    expect(comparable(summary)).toEqual(control.summary);
    expect(await rowCount(uploadId)).toBe(control.rows);
  });

  it("gives the same totals when the request never reached the Worker", async () => {
    // The harmless half, asserted anyway because the client takes the same branch
    // for both and the two must converge.
    const control = await uninterrupted();

    const chunks = buildChunks();
    const uploadId = await openUpload("lost-request.csv");
    await postChunk(uploadId, 0, chunks[0]!);
    // chunk 1 dies on the wire, so the Worker never sees it
    const summary = await drainFrom(uploadId, chunks, 1);

    expect(comparable(summary)).toEqual(control.summary);
    expect(await rowCount(uploadId)).toBe(control.rows);
  });

  it("leaves no partial chunk behind when the client aborts mid-request", async () => {
    // A real abort, not a simulated one. The write is a single db.batch(), so the
    // only two legal outcomes are "chunk fully recorded" and "chunk absent" -
    // never rows without their marker, which is what would make the retry
    // double-count. Under workerd the abort has always landed before the batch
    // commits, so in practice this exercises the absent case; the assertion is
    // written to accept either, because the timing is the runtime's to decide and
    // a test that depended on it would be flaky rather than strict.
    const control = await uninterrupted();

    const chunks = buildChunks();
    const uploadId = await openUpload("aborted.csv");
    await postChunk(uploadId, 0, chunks[0]!);

    const controller = new AbortController();
    const inflight = SELF.fetch(chunkUrl(uploadId, 1), {
      method: "POST",
      body: chunks[1]!,
      signal: controller.signal,
    });
    controller.abort();
    await expect(inflight).rejects.toThrow();

    const marker = await env.DB.prepare(
      "SELECT rows_total as rowsTotal FROM upload_chunks WHERE upload_id = ?1 AND chunk_index = 1",
    )
      .bind(uploadId)
      .first<{ rowsTotal: number }>();
    // Either the chunk landed whole or it did not land at all. With no marker,
    // the only rows present must still be chunk 0's two - anything more is a
    // partial write that survived the abort.
    if (marker === null) expect(await rowCount(uploadId)).toBe(2);

    const summary = await drainFrom(uploadId, chunks, 1);
    expect(comparable(summary)).toEqual(control.summary);
    expect(await rowCount(uploadId)).toBe(control.rows);
  });

  it("resumes a finalize whose response was lost without re-posting chunks", async () => {
    // UploadScreen sets startIndex to chunks.length when finalize is what failed,
    // so the retry runs finalize alone. Asserted over HTTP because the 409-vs-200
    // decision lives in the route, not in finalizeUpload.
    const control = await uninterrupted();

    const chunks = buildChunks();
    const uploadId = await openUpload("lost-finalize.csv");
    await drainFrom(uploadId, chunks, 0); // finalize committed, response imagined lost
    const replay = await drainFrom(uploadId, chunks, chunks.length);

    expect(comparable(replay)).toEqual(control.summary);
    expect(await rowCount(uploadId)).toBe(control.rows);
  });
});
