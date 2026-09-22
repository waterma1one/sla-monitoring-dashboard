import { useEffect, useState } from "react";
import { getLogs, WorkerError, type DateFilter, type LogRow } from "./api";

const PAGE_SIZE = 100;

function formatTimestamp(ts: number): string {
  // ts is epoch seconds UTC (docs/decisions.md); display in UTC explicitly so it
  // never silently shifts to the viewer's local timezone.
  return new Date(ts * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

export default function LogsSection({ uploadId, filter }: { uploadId: string; filter: DateFilter }) {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filterReady = "day" in filter ? filter.day !== "" : filter.from !== "" && filter.to !== "";
  const filterKey = "day" in filter ? filter.day : `${filter.from}:${filter.to}`;

  useEffect(() => {
    if (!filterReady) return;
    let cancelled = false;
    setError(null);
    setRows([]);
    setCursor(null);
    getLogs(uploadId, filter, { limit: PAGE_SIZE }).then(
      (result) => {
        if (cancelled) return;
        setRows(result.rows);
        setCursor(result.nextCursor);
      },
      (err) => {
        if (!cancelled) setError(err instanceof WorkerError ? err.message : "Could not load logs.");
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadId, filterKey]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const result = await getLogs(uploadId, filter, { limit: PAGE_SIZE, cursor });
      setRows((prev) => [...prev, ...result.rows]);
      setCursor(result.nextCursor);
    } catch (err) {
      setError(err instanceof WorkerError ? err.message : "Could not load more logs.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-300 dark:border-slate-700">
      <div className="px-4 py-3">
        <h2 className="text-lg font-semibold">Logs</h2>
      </div>

      <div className="border-t border-slate-300 p-4 dark:border-slate-700">
        {!filterReady && <p className="text-sm text-slate-500 dark:text-slate-400">Pick a date to see logs.</p>}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="py-1 pr-4">Time (UTC)</th>
                  <th className="py-1 pr-4">Service</th>
                  <th className="py-1 pr-4">Region</th>
                  <th className="py-1 pr-4">Status</th>
                  <th className="py-1 pr-4">Latency</th>
                  <th className="py-1">Corrections</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-200 dark:border-slate-800">
                    <td className="py-1 pr-4 whitespace-nowrap">{formatTimestamp(r.ts)}</td>
                    <td className="py-1 pr-4">{r.serviceName}</td>
                    <td className="py-1 pr-4">{r.region}</td>
                    <td className="py-1 pr-4">
                      {r.statusCode}
                      {r.degraded && (
                        <span className="ml-1 rounded bg-amber-100 px-1 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                          degraded
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-4">{r.latencyMs === null ? "—" : `${r.latencyMs.toFixed(0)}ms`}</td>
                    <td className="py-1 text-xs text-slate-500 dark:text-slate-400">
                      {r.corrections.length > 0 ? r.corrections.join(", ") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {filterReady && rows.length === 0 && !error && (
          <p className="text-sm text-slate-500 dark:text-slate-400">No rows in this range.</p>
        )}

        {cursor && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="mt-4 rounded border border-slate-400 px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </section>
  );
}
