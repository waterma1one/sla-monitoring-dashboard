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

async function getJson<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${WORKER_URL}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  const res = await fetch(url);
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

// A single day, or a from/to range, never both - matches worker/src/queryParams.ts's
// parseDateFilter, which rejects any other combination.
export type DateFilter = { day: string } | { from: string; to: string };

function dateFilterParams(filter: DateFilter): Record<string, string> {
  return "day" in filter ? { day: filter.day } : { from: filter.from, to: filter.to };
}

export type ServiceStats = {
  serviceId: string;
  serviceName: string;
  available: number;
  unavailable: number;
  availability: number | null;
};

export type StatsResult = {
  from: string;
  to: string;
  checkPoints: { available: number; unavailable: number; excluded: number; expected: number };
  availability: number | null;
  coverage: number | null;
  degradedRate: number | null;
  latency: { mean: number | null; p95: number | null };
  perService: ServiceStats[];
};

export function getStats(uploadId: string, filter: DateFilter): Promise<StatsResult> {
  return getJson(`/uploads/${uploadId}/stats`, dateFilterParams(filter));
}

export type LogRow = {
  id: number;
  serviceId: string;
  serviceName: string;
  region: string;
  agent: string;
  ts: number;
  day: string;
  statusCode: number;
  statusClass: string;
  latencyMs: number | null;
  degraded: boolean;
  corrections: string[];
};

export type LogsResult = { rows: LogRow[]; nextCursor: string | null };

export function getLogs(
  uploadId: string,
  filter: DateFilter,
  opts?: { limit?: number; cursor?: string },
): Promise<LogsResult> {
  const params = dateFilterParams(filter);
  if (opts?.limit !== undefined) params.limit = String(opts.limit);
  if (opts?.cursor !== undefined) params.cursor = opts.cursor;
  return getJson(`/uploads/${uploadId}/logs`, params);
}

// Distinct from UploadSummary above (that one is the finalize response shape).
// This is worker/src/query.ts's listUploads row.
export type UploadListItem = {
  id: string;
  filename: string;
  uploadedAt: string;
  status: "open" | "complete" | "failed";
  dayFirst: string | null;
  dayLast: string | null;
  rowsTotal: number;
  rowsAccepted: number;
  rowsCorrected: number;
  rowsRejected: number;
  rowsDuplicate: number;
};

export function listUploads(): Promise<UploadListItem[]> {
  return getJson("/uploads");
}
