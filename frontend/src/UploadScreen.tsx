import { useState } from "react";
import { finalizeUpload, openUpload, postChunk, type UploadSummary } from "./api";

// docs/decisions.md section 4: chunks are 1,000 data rows, header line prepended to
// each so a chunk is self-describing. Must match INSERT_BATCH_SIZE's chunk contract
// in worker/src/ingest.ts, not the D1 batch size (that's a Worker-internal detail).
const CHUNK_SIZE = 1000;

// No file this size is expected - the largest CSV in this project is ~1.1MB. 20MB is
// a round ceiling meant to catch "wrong file picked" mistakes, not a limit derived
// from any protocol constraint. See docs/decisions.md section 9.
const MAX_FILE_BYTES = 20 * 1024 * 1024;

type Phase = "idle" | "uploading" | "finalizing" | "done" | "error";

type Resumable = { uploadId: string; chunks: string[]; startIndex: number };

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function validateFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(".csv")) return "File must be a .csv file.";
  if (file.size === 0) return "File is empty.";
  if (file.size > MAX_FILE_BYTES) {
    return `File is too large (${(file.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_FILE_BYTES / 1024 / 1024}MB).`;
  }
  return null;
}

function buildChunks(csvText: string): string[] {
  // \r?\n, not \n: the source CSVs are CRLF and a bare \n split leaves the carriage
  // return on the last column of every row. The Worker splits the same way.
  const lines = csvText.split(/\r?\n/).filter((line) => line.length > 0);
  const [header, ...dataLines] = lines;
  if (!header || dataLines.length === 0) throw new Error("File has a header but no data rows.");
  return chunkArray(dataLines, CHUNK_SIZE).map((rows) => [header, ...rows].join("\n"));
}

export default function UploadScreen({ onUploaded }: { onUploaded: (uploadId: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [resumable, setResumable] = useState<Resumable | null>(null);

  function handleFileSelect(selected: File | null) {
    setFile(selected);
    setFileError(selected ? validateFile(selected) : null);
    setPhase("idle");
    setError(null);
    setSummary(null);
    setResumable(null);
  }

  async function runUpload(resume?: Resumable) {
    setPhase("uploading");
    setError(null);

    let uploadId: string;
    let chunks: string[];
    let startIndex: number;

    try {
      if (resume) {
        ({ uploadId, chunks, startIndex } = resume);
      } else {
        if (!file) return;
        const text = await file.text();
        chunks = buildChunks(text);
        const opened = await openUpload(file.name);
        uploadId = opened.uploadId;
        startIndex = 0;
      }
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Could not read or open the file.");
      return;
    }

    setProgress({ done: startIndex, total: chunks.length });

    let i = startIndex;
    try {
      for (; i < chunks.length; i++) {
        await postChunk(uploadId, i, chunks[i]!);
        setProgress({ done: i + 1, total: chunks.length });
      }
    } catch (err) {
      setPhase("error");
      setError(
        `Upload failed on chunk ${i + 1} of ${chunks.length}: ` +
          (err instanceof Error ? err.message : "unknown error") +
          ". Rows already uploaded are safe - retry resumes from here.",
      );
      setResumable({ uploadId, chunks, startIndex: i });
      return;
    }

    setPhase("finalizing");
    try {
      const finalSummary = await finalizeUpload(uploadId);
      setSummary(finalSummary);
      setPhase("done");
      setResumable(null);
      onUploaded(finalSummary.uploadId);
    } catch (err) {
      setPhase("error");
      setError(
        "All rows uploaded, but finalizing failed: " +
          (err instanceof Error ? err.message : "unknown error") +
          ". Retry will only re-run finalize.",
      );
      setResumable({ uploadId, chunks, startIndex: chunks.length });
    }
  }

  const busy = phase === "uploading" || phase === "finalizing";

  return (
    <div>
      <h1 className="text-2xl font-semibold">SLA monitoring — upload</h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Upload a health-check CSV. It's parsed, cleaned, and persisted by the deployed Worker.
      </p>

      <div className="mt-6 rounded-lg border border-slate-300 p-4 dark:border-slate-700">
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:mr-4 file:rounded file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white disabled:opacity-50 dark:file:bg-slate-100 dark:file:text-slate-900"
        />
        {fileError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{fileError}</p>}

        <button
          type="button"
          disabled={!file || !!fileError || busy || phase === "done"}
          onClick={() => runUpload()}
          className="mt-4 rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy ? "Uploading…" : "Upload"}
        </button>

        {resumable && (
          <button
            type="button"
            onClick={() => runUpload(resumable)}
            className="mt-4 ml-2 rounded border border-slate-400 px-4 py-2 text-sm font-medium"
          >
            Retry
          </button>
        )}
      </div>

      {progress && busy && (
        <div className="mt-4">
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className="h-full rounded-full bg-slate-900 transition-[width] dark:bg-slate-100"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {phase === "finalizing"
              ? "Finalizing…"
              : `Uploaded chunk ${progress.done} of ${progress.total}`}
          </p>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      {summary && (
        <div className="mt-6 rounded-lg border border-slate-300 p-4 dark:border-slate-700">
          <h2 className="text-lg font-semibold">Upload complete</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {summary.dayFirst && summary.dayLast ? `${summary.dayFirst} to ${summary.dayLast}` : "No dated rows"}
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryStat label="Accepted" value={summary.rowsAccepted} />
            <SummaryStat label="Corrected" value={summary.rowsCorrected} />
            <SummaryStat label="Rejected" value={summary.rowsRejected} />
            <SummaryStat label="Duplicate" value={summary.rowsDuplicate} />
          </dl>
          {Object.keys(summary.corrections).length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-medium">Corrections applied</h3>
              <ul className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                {Object.entries(summary.corrections).map(([rule, count]) => (
                  <li key={rule}>
                    {rule}: {count}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
            View it on the <span className="font-medium">Dashboard</span> tab above.
          </p>
        </div>
      )}
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="text-xl font-semibold">{value.toLocaleString()}</dd>
    </div>
  );
}
