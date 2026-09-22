// Worker HTTP entry point. Routing only - all logic lives in ingest.ts so it stays
// testable without a full fetch() round trip. No router dependency: three fixed
// path shapes don't earn one.

import { openUpload, postChunk } from "./ingest";

// No auth is in scope for this project (problem_statement.md), so there is no origin
// to restrict this to - the upload UI is the only client and free-tier Workers
// have no session/cookie boundary for this to protect.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function statusForReason(reason: "upload_not_found" | "upload_not_open"): number {
  return reason === "upload_not_found" ? 404 : 409;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // POST /uploads
    if (request.method === "POST" && parts.length === 1 && parts[0] === "uploads") {
      const body = (await request.json().catch(() => null)) as { filename?: string } | null;
      if (!body?.filename) return json({ error: "filename is required" }, 400);
      const result = await openUpload(env, body.filename);
      return json(result, 201);
    }

    // POST /uploads/:uploadId/chunks/:chunkIndex
    if (
      request.method === "POST" &&
      parts.length === 4 &&
      parts[0] === "uploads" &&
      parts[2] === "chunks"
    ) {
      const uploadId = parts[1]!;
      const chunkIndex = Number(parts[3]);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
        return json({ error: "chunk index must be a non-negative integer" }, 400);
      }
      const chunkText = await request.text();
      const outcome = await postChunk(env, uploadId, chunkIndex, chunkText);
      if (!outcome.ok) return json({ error: outcome.reason }, statusForReason(outcome.reason));
      return json(outcome.summary);
    }

    return json({ error: "not found" }, 404);
  },
};
