// Worker HTTP entry point. Routing only - all logic lives in ingest.ts so it stays
// testable without a full fetch() round trip. No router dependency: three fixed
// path shapes don't earn one.

import { openUpload } from "./ingest";

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

    return json({ error: "not found" }, 404);
  },
};
