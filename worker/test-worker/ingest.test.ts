import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { openUpload } from "../src/ingest";

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
