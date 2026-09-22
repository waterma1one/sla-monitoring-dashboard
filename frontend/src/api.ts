// Client for the three ingest endpoints in worker/src/index.ts. Request and response
// shapes here must match worker/src/ingest.ts's OpenUploadResult, ChunkSummary, and
// UploadSummary exactly - see docs/decisions.md section 4 for why the protocol is
// shaped this way (open / post-chunk / finalize, chunk = header line + up to 1,000
// data rows).

const WORKER_URL = import.meta.env.VITE_WORKER_URL ?? "http://localhost:8787";

export class WorkerError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `worker returned ${res.status}`;
    throw new WorkerError(message, res.status);
  }
  return data as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

async function postText<T>(path: string, body: string): Promise<T> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  return handleResponse<T>(res);
}

export type ChunkSummary = {
  rowsTotal: number;
  rowsAccepted: number;
  rowsCorrected: number;
  rowsRejected: number;
  rowsDuplicate: number;
};

export type UploadSummary = ChunkSummary & {
  uploadId: string;
  status: "complete";
  dayFirst: string | null;
  dayLast: string | null;
  corrections: Record<string, number>;
};

export function openUpload(filename: string): Promise<{ uploadId: string }> {
  return postJson("/uploads", { filename });
}

export function postChunk(uploadId: string, chunkIndex: number, chunkText: string): Promise<ChunkSummary> {
  return postText(`/uploads/${uploadId}/chunks/${chunkIndex}`, chunkText);
}

export function finalizeUpload(uploadId: string): Promise<UploadSummary> {
  return postJson(`/uploads/${uploadId}/finalize`, {});
}
