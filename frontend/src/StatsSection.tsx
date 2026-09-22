import { useEffect, useState } from "react";
import { getStats, WorkerError, type DateFilter, type StatsResult } from "./api";

// docs/decisions.md section 1: a credit is owed below 99.9% availability.
const CREDIT_THRESHOLD = 0.999;

function formatPercent(value: number | null, digits = 2): string {
  return value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

export default function StatsSection({ uploadId, filter }: { uploadId: string; filter: DateFilter }) {
  const [open, setOpen] = useState(true);
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filterReady = "day" in filter ? filter.day !== "" : filter.from !== "" && filter.to !== "";

  const verdict =
    stats === null || stats.availability === null
      ? null
      : stats.availability >= CREDIT_THRESHOLD
        ? "no credit owed"
        : "credit owed (below 99.9%)";
  const coverageRounded =
    stats === null || stats.coverage === null ? null : Math.round(stats.coverage * 10000) / 100;

  useEffect(() => {
    if (!filterReady) return;
    let cancelled = false;
    setError(null);
    // Clear the previous upload's or date's figures before fetching. Leaving them
    // up renders one upload's availability and credit verdict under another's
    // heading, and keeps them on screen beside the error if the request fails -
    // the worst possible outcome for a number someone might bill against.
    setStats(null);
    getStats(uploadId, filter).then(
      (result) => {
        if (!cancelled) setStats(result);
      },
      (err) => {
        if (!cancelled) setError(err instanceof WorkerError ? err.message : "Could not load stats.");
      },
    );
    return () => {
      cancelled = true;
    };
    // filter is a plain object rebuilt on every keystroke; comparing its fields
    // rather than its identity avoids re-fetching on every render for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadId, "day" in filter ? filter.day : `${filter.from}:${filter.to}`]);

  return (
    <section className="rounded-lg border border-slate-300 dark:border-slate-700">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <h2 className="text-lg font-semibold">Stats</h2>
        <span className="text-sm text-slate-500 dark:text-slate-400">{open ? "Collapse ▲" : "Expand ▼"}</span>
      </button>

      {open && (
        <div className="border-t border-slate-300 p-4 dark:border-slate-700">
          {!filterReady && <p className="text-sm text-slate-500 dark:text-slate-400">Pick a date to see stats.</p>}
          {filterReady && !stats && !error && (
            <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
          )}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          {stats && (
            <>
              <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Availability</dt>
                  <dd className="text-2xl font-semibold">
                    {formatPercent(stats.availability)}
                    {verdict && (
                      <span className="ml-2 text-sm font-normal text-slate-500 dark:text-slate-400">{verdict}</span>
                    )}
                  </dd>
                  {stats.availability !== null && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {stats.checkPoints.available.toLocaleString()} available /{" "}
                      {stats.checkPoints.unavailable.toLocaleString()} unavailable
                    </p>
                  )}
                </div>

                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Degraded rate</dt>
                  <dd className="text-2xl font-semibold">{formatPercent(stats.degradedRate)}</dd>
                  <p className="text-xs text-slate-500 dark:text-slate-400">available checks with latency &gt; 1000ms</p>
                </div>

                <div>
                  <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Latency p95</dt>
                  <dd className="text-2xl font-semibold">
                    {stats.latency.p95 === null ? "—" : `${stats.latency.p95.toFixed(0)}ms`}
                  </dd>
                </div>
              </dl>

              {stats.checkPoints.excluded > 0 && (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  {stats.checkPoints.excluded.toLocaleString()} check-point(s) excluded (unclassifiable) — not counted
                  toward availability.
                </p>
              )}

              <p
                className={`mt-3 text-sm ${
                  coverageRounded === null || coverageRounded >= 100
                    ? "text-slate-500 dark:text-slate-400"
                    : "font-medium text-amber-700 dark:text-amber-400"
                }`}
              >
                {coverageRounded === null
                  ? "No coverage data for this range."
                  : coverageRounded >= 100
                    ? "100% coverage, no gaps."
                    : `⚠ ${coverageRounded.toFixed(2)}% coverage — some check-points are missing.`}
              </p>

              {stats.perService.length > 0 && (
                <div className="mt-4 overflow-x-auto">
                  <h3 className="text-sm font-medium">By service</h3>
                  <table className="mt-2 w-full text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      <tr>
                        <th className="py-1 pr-4">Service</th>
                        <th className="py-1 pr-4">Availability</th>
                        <th className="py-1 pr-4">Available</th>
                        <th className="py-1">Unavailable</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.perService.map((s) => (
                        <tr key={s.serviceId} className="border-t border-slate-200 dark:border-slate-800">
                          <td className="py-1 pr-4">{s.serviceName}</td>
                          <td
                            className={`py-1 pr-4 ${
                              s.availability !== null && s.availability < CREDIT_THRESHOLD
                                ? "font-medium text-red-700 dark:text-red-400"
                                : ""
                            }`}
                          >
                            {formatPercent(s.availability)}
                          </td>
                          <td className="py-1 pr-4">{s.available.toLocaleString()}</td>
                          <td className="py-1">{s.unavailable.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
