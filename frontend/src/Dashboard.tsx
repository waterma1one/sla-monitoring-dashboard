import { useEffect, useState } from "react";
import { listUploads, WorkerError, type DateFilter, type UploadListItem } from "./api";
import DateFilterControl from "./DateFilterControl";
import StatsSection from "./StatsSection";
import LogsSection from "./LogsSection";

export default function Dashboard({ preferredUploadId }: { preferredUploadId: string | null }) {
  const [uploads, setUploads] = useState<UploadListItem[] | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [filter, setFilter] = useState<DateFilter>({ day: "" });
  // Debounced separately from `filter`: the year sub-field of a native date input
  // reports a live intermediate value on every keystroke (e.g. typing "2025" reports
  // "0005", "0050", "0508" along the way), each of which would otherwise fire a
  // request - several invalid - straight at the Worker. The input stays bound to the
  // instant `filter` so it feels responsive; the sections fetch off this instead.
  const [debouncedFilter, setDebouncedFilter] = useState<DateFilter>(filter);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFilter(filter), 400);
    return () => clearTimeout(timer);
  }, [filter]);

  useEffect(() => {
    listUploads().then(
      (result) => setUploads(result),
      (err) => setError(err instanceof WorkerError ? err.message : "Could not load uploads."),
    );
    // Deliberately runs once: preferredUploadId only matters the first time this
    // list loads (right after an upload finishes), not on every re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (uploads === null || uploads.length === 0) return;
    const preferred = preferredUploadId && uploads.find((u) => u.id === preferredUploadId);
    selectUpload((preferred || uploads[0]!).id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploads]);

  // Selecting an upload re-seeds the date filter to that upload's most recent day.
  // Two uploads can cover completely different windows, so carrying the old date
  // across would show "No rows in this range" and look like an empty upload.
  // Both states are set directly, skipping the debounce - this isn't a keystroke.
  function selectUpload(id: string) {
    setUploadId(id);
    const selected = uploads?.find((u) => u.id === id);
    if (selected?.dayLast) {
      setFilter({ day: selected.dayLast });
      setDebouncedFilter({ day: selected.dayLast });
    }
  }

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (uploads === null) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  }

  if (uploads.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        No uploads yet. Upload a CSV on the <span className="font-medium">Upload</span> tab first.
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">SLA monitoring — dashboard</h1>
        {uploads.length > 1 && uploadId && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-slate-500 dark:text-slate-400">Upload</span>
            <select
              value={uploadId}
              onChange={(e) => selectUpload(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
            >
              {uploads.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.filename} ({u.uploadedAt.slice(0, 10)})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="mt-4">
        <DateFilterControl value={filter} onChange={setFilter} />
      </div>

      {uploadId && (
        <div className="mt-4 flex flex-col gap-4">
          <StatsSection uploadId={uploadId} filter={debouncedFilter} />
          <LogsSection uploadId={uploadId} filter={debouncedFilter} />
        </div>
      )}
    </div>
  );
}
