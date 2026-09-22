import type { DateFilter } from "./api";

// One shared control for both dashboard sections rather than two independent ones -
// the assignment only requires the logs view to be filterable, but getStats is
// range-scoped too (docs/decisions.md section 1: "the dashboard computes over the
// selected date range"). Two unsynced date pickers on one screen would leave a
// reader unable to tell whether the stats above match the logs below.
export default function DateFilterControl({
  value,
  onChange,
}: {
  value: DateFilter;
  onChange: (next: DateFilter) => void;
}) {
  const mode: "day" | "range" = "day" in value ? "day" : "range";

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-300 p-3 text-sm dark:border-slate-700">
      <div className="flex rounded border border-slate-300 text-xs dark:border-slate-700">
        <button
          type="button"
          onClick={() => mode !== "day" && onChange({ day: "from" in value ? value.to : "" })}
          className={`px-2 py-1 ${mode === "day" ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : ""}`}
        >
          Single day
        </button>
        <button
          type="button"
          onClick={() =>
            mode !== "range" && onChange({ from: "day" in value ? value.day : "", to: "day" in value ? value.day : "" })
          }
          className={`px-2 py-1 ${mode === "range" ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : ""}`}
        >
          Range
        </button>
      </div>

      {mode === "day" && "day" in value && (
        <label className="flex flex-col">
          <span className="text-xs text-slate-500 dark:text-slate-400">Day</span>
          <input
            type="date"
            name="day"
            value={value.day}
            onChange={(e) => onChange({ day: e.target.value })}
            className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          />
        </label>
      )}

      {mode === "range" && "from" in value && (
        <>
          <label className="flex flex-col">
            <span className="text-xs text-slate-500 dark:text-slate-400">From</span>
            <input
              type="date"
              name="from"
              value={value.from}
              onChange={(e) => onChange({ from: e.target.value, to: value.to })}
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-slate-500 dark:text-slate-400">To</span>
            <input
              type="date"
              name="to"
              value={value.to}
              onChange={(e) => onChange({ from: value.from, to: e.target.value })}
              className="rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
        </>
      )}
    </div>
  );
}
