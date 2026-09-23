# Decisions

Phase 2 output. Every rule here was chosen deliberately; `docs/data-findings.md` holds the
evidence each one responds to. Findings are referenced as F1–F13.

## 1. The SLA definition

### What a check-point is

A *check-point* is one `(service, instant)` pair on the 15-minute grid — the thing that
was supposed to be measured. It is not a row. F4 established that 352–1,169 check-points
per file carry two or three rows, because a second agent observed the same instant.
Availability is computed over check-points, never over rows, so the denominator depends
on elapsed time rather than on how many agents happened to be watching.

### Status classification

Each *row* gets one of three classes:

| Class | Rule | Rationale |
|---|---|---|
| `available` | `status_code` is 2xx or 3xx | The service responded |
| `unavailable` | `status_code` is 5xx | The service failed |
| `invalid` | anything else | We do not know what happened |

The allowlist is deliberate rather than a `not 5xx` test. `not 5xx` would give the right
answer for the `999` rows and the wrong answer for a `404` or a `418`, and the point of
this column is to be correct for status codes this dataset does not happen to contain.

`999` (F8) therefore lands in `invalid`. It is not an HTTP status code, and all five
occurrences carry healthy latency (116–632 ms against a 363 ms baseline) — in the 14d
file `agent-2` reported `200/638 ms` at the very instant `agent-1` reported `999/632 ms`.
So the check almost certainly succeeded and the status field is corrupt. We do not repair
it to `200`, because that invents a value nobody recorded; we mark it unknown and say so.

### Resolving a check-point

```
reports := all accepted rows for this (service, instant)
valid   := reports where class != 'invalid'

if valid is empty            -> check-point is EXCLUDED (observed, unclassifiable)
else if any valid is 5xx     -> check-point is UNAVAILABLE
else                         -> check-point is AVAILABLE

latency_ms := mean of non-null latency_ms over valid reports  (null if none)
degraded   := check-point is AVAILABLE and latency_ms > 1000
```

Worst-status-wins, because this number decides a billing credit and ambiguity should not
favour the party computing the bill. It is also barely consequential in practice: the two
agents agree on status at 3,299 of 3,300 co-observed check-points.

Mean-of-non-null latency disposes of F6 for free. Those two rows are the same agent
reporting the same instant twice, agreeing on status, with the latency present in one copy
and blank in the other; the blank contributes nothing instead of winning a coin toss. This
is *not* imputation — no value is invented, a real measurement simply is not discarded
because its twin was empty.

### The numbers

```
availability = available_points / (available_points + unavailable_points)
coverage     = observed_points  / expected_points        expected = days x 96 per service
degraded_rate= degraded_points  / available_points
latency mean/p95 over reports where latency_ms IS NOT NULL
```

Three denominators, deliberately not one:

- **Availability** excludes `EXCLUDED` check-points. We were not able to tell whether the
  service was up, so we decline to guess in either direction.
- **Latency** is computed over rows that have a latency. 1.2% of rows do not (F10), and a
  row with no latency is still evidence the check ran — so the availability set and the
  latency set are genuinely different sets, and reporting both from one `COUNT(*)` would
  misstate one of them.
- **Coverage** exists as a safety net. F-negatives recorded that this data has *zero*
  missing check-points, which means any gap that ever appears was created by our own
  cleaning. Coverage makes that visible rather than letting a denominator quietly shrink.
  On this data it should read exactly 100%, and if it does not, we have a bug.

A credit is owed below 99.9%. The dashboard computes over the selected date range and
labels it as such — it is not a calendar month, and the datasets span 9 to 30 days.

### Slow but successful

Availability is computed from status codes only. A latency threshold does not make a check
count as downtime, because that conflates two different SLOs and would change the credit
owed on grounds the contract never mentions.

But a response is not merely a number, and F11 showed why this cannot be ignored: the 9d
`svc-reports` incident on 2025-05-13 interleaves 5xx with `200` responses at 2,193 ms and
2,983 ms. Availability from status codes reports that service at 8.33% down while it was
in fact serving 3-second responses through the middle of the window. So each available
check-point also carries a `degraded` flag at **latency > 1000 ms**, reported as its own
statistic and never folded into uptime.

1000 ms is chosen as the smallest round number above the observed p95 of 754–766 ms. It
catches every brownout row (6–28 per file) without flagging ordinary traffic. The 14d file
yields zero degraded check-points, which is the correct answer — its incidents are pure
5xx with no latency excursion at all.

### Timezone

Everything is stored and bucketed in **UTC**, and every date the dashboard displays is
labelled UTC.

UTC matches the majority timestamp format, matches how `dataset_incident_log.json`
describes its own incident windows, and has no DST edge cases. The alternative, IST, is
tempting because the `+05:30` rows and the `ap-south-1` tag suggest the operator sits in
India — but it shifts every day boundary by 5h30m and re-buckets the 73 rows from F3. The
label is not decoration: those 73 rows are precisely the ones where a reader who assumes
local time will read the wrong day.

## 2. Cleaning rules

Rules are pure functions over a single parsed row, with no Worker or D1 imports, so they
are testable in isolation. A row is either accepted (possibly with corrections recorded),
discarded as an exact duplicate, or rejected into quarantine with a reason.

| # | Finding | Rule | Flag recorded |
|---|---|---|---|
| C1 | F1 | `latency_unit = 's'` → multiply by 1000. Store `latency_ms` as REAL, always milliseconds. The unit column is never stored. | `unit_converted` |
| C2 | F2 | Parse `...Z`, 10-digit epoch seconds, and `±HH:MM` offsets to one UTC instant, stored as epoch seconds. Unparseable → reject. | `ts_epoch`, `ts_offset` |
| C3 | F3 | No separate rule. `day` is derived from the UTC instant after C2, so a date written in IST cannot leak into the wrong bucket. | — |
| C4 | F5 | Exact duplicate rows are discarded, not rejected — a byte-identical copy carries no information. Counted separately from rejections in the summary. | — |
| C5 | F4, F6, F7 | All other rows for the same check-point are kept. Resolution happens at query time, per section 1. | — |
| C6 | F8 | `999` and any other unrecognised code → `status_class = 'invalid'`. The row stays in `checks` so it appears in the logs view; it is excluded from both the availability numerator and denominator. | `status_invalid` |
| C7 | F9 | Negative latency → `latency_ms = NULL`. Status is untouched, so the check still counts toward availability. | `latency_negative` |
| C8 | F10 | Empty latency → `latency_ms = NULL`. The row is accepted; it counts for availability and not for latency. | `latency_missing` |
| C9 | F11 | `degraded = 1` when class is `available` and `latency_ms > 1000`. | — |
| C10 | F13 | `service_name` and `region` are stored as-is on every row. Denormalising 5 low-cardinality values across 15k rows costs nothing against a 500 MB budget, and normalising would buy storage we are not short of at the price of a join on every query. | — |
| C11 | — | Rows failing structural validation — wrong field count, unparseable timestamp, non-numeric latency, non-numeric status — are rejected to quarantine with the raw line and a reason. None occur in these five files; the Worker must still handle them. | — |

### One rule I chose by extension, not by instruction

C7 (negative latency) was not among the seven questions. I made it `NULL` rather than
`abs()` to stay consistent with the `999` decision: the magnitude is plausible, so `abs()`
is tempting, but it repairs a corrupt field by guessing at the author's intent. Marking it
unknown applies the same principle we applied to `999`. It affects exactly one row per
file, so it cannot move any published figure — say the word and it flips to `abs()`.

## 3. Audit trail

Cleaning is non-destructive in the ways that matter for a credit dispute:

- Accepted rows are stored with corrections **applied**, plus a `corrections` list naming
  what changed on that row. The original value is recoverable for every correction we
  make, because each is a deterministic transform of a value we can reconstruct — except
  the two that set `NULL`, where the flag itself records what was there.
- Rejected rows are stored in a separate `rejected_rows` table with the raw line text, the
  line number, and a reason.
- Per-upload and per-chunk counts of accepted, corrected, rejected, and duplicate rows are
  stored rather than computed and thrown away. The upload UI's summary is a query against
  those counters, not a value that exists only in one HTTP response.

Quarantine is for rows we could not parse. `invalid`-status rows (C6) deliberately stay in
the main table instead: they are well-formed observations that we simply cannot classify,
and hiding them from the logs view would make a check-point look unobserved when it was
not.

## 4. Ingest architecture and batch sizing

### Why the upload is chunked by the browser

The Workers free tier allows **10 ms of CPU per invocation**, and D1 allows **50 queries
per invocation** on that tier. Verified against the current Cloudflare docs rather than
recalled. Parsing, cleaning, and serialising 15,577 rows does not fit in 10 ms of CPU.

So the browser slices the CSV on line boundaries into chunks of **1,000 data rows** and
POSTs each chunk as its own request. Each request is a separate invocation with a fresh
10 ms CPU budget and a fresh 50-query budget, and 15,577 rows becomes 16 requests against
a 100,000-request daily allowance.

The browser does **no parsing, validation, or cleaning** — it splits bytes at newlines and
prepends the header line to every chunk so each chunk is self-describing. Every cleaning
rule in section 2 runs in the deployed Worker, which is what the assignment requires.
Chunking also makes the upload UI's progress indicator report real progress instead of
animating.

Ingest is three endpoint shapes: open an upload, post chunk *n*, finalise. Each is
stateless; all state lives in D1.

### Why rows are inserted via `json_each`

D1 caps bound parameters at **100 per statement**. An 11-column multi-row `VALUES` insert
therefore fits 9 rows per statement, which is ~1,730 statements for the largest file — far
past the 50-query ceiling, and unusable.

Instead each insert is one statement with one bound parameter:

```sql
INSERT OR IGNORE INTO checks (upload_id, service_id, service_name, ts, day, agent,
                              region, status_code, status_class, latency_ms, degraded,
                              corrections)
SELECT ?1,
       json_extract(value, '$.s'), json_extract(value, '$.n'),
       json_extract(value, '$.t'), json_extract(value, '$.d'),
       json_extract(value, '$.a'), json_extract(value, '$.g'),
       json_extract(value, '$.c'), json_extract(value, '$.k'),
       json_extract(value, '$.l'), json_extract(value, '$.x'),
       json_extract(value, '$.f')
FROM json_each(?2)
```

The row data travels in a single string parameter, whose ceiling is the 2 MB maximum bound
string rather than 100 parameter slots.

**Batch size: 500 rows per statement.** A row serialises to roughly 120 bytes with short
keys, so a 500-row payload is about 60 KB — 3% of the 2 MB limit, leaving room for service
names or agent names considerably longer than these. A 1,000-row chunk is therefore 2
insert statements plus 1 chunk-counter insert, sent as one `db.batch()`: 3 queries against
a 50-query budget, with headroom for the quarantine insert and for the chunk size to be
raised later without redesign.

The numbers this is derived from, all verified: 100 bound parameters per statement, 100 KB
maximum SQL statement length, 2 MB maximum bound string, 50 D1 queries per invocation on
free, 10 ms CPU per invocation on free.

### Partial failure

Per the current D1 documentation, `batch()` executes and commits each statement
sequentially in auto-commit rather than giving all-or-nothing rollback. We do not pretend
otherwise:

- Every insert is `INSERT OR IGNORE` against a unique index that defines what an exact
  duplicate is, so replaying a chunk is idempotent and a client retry cannot double-insert.
- Per-chunk counters live in `upload_chunks` keyed by `(upload_id, chunk_index)`, so the
  summary is a `SUM` over recorded chunks rather than an incremented counter that a retry
  would inflate.
- An upload that never reaches finalise keeps `status = 'open'`, so a partially ingested
  file is visibly partial rather than silently short.

This also makes the unique index load-bearing rather than decorative: exact duplicates
(F5) can straddle a chunk boundary, where no in-Worker `Set` would see both copies.

## 5. Schema

`migrations/0001_initial_schema.sql`. Four tables.

**`uploads`** — one row per uploaded file, and the scope every other row hangs off.
Carries the filename, the UTC upload time, the observed day range, and a status of
`open`, `complete`, or `failed`.

**`upload_chunks`** — one row per accepted chunk, primary key `(upload_id, chunk_index)`,
holding that chunk's accepted / corrected / rejected / duplicate counts. Makes ingest
idempotent and the upload summary a `SUM`.

**`checks`** — the accepted rows. `ts` is epoch seconds UTC; `day` is the denormalised
`YYYY-MM-DD` UTC date, stored because every dashboard filter is a date filter and deriving
it per row per query would defeat the index.

**`rejected_rows`** — quarantine: raw line, line number, reason.

### Upload scoping

Rows are scoped to `upload_id`, and the dashboard filters by upload. F12 found that the
five files are overlapping simulations of the same services that disagree at 132–216
shared check-points per pair, so `(service_id, ts)` is not a unique key across uploads and
merging them would make the availability figure a function of upload order. Scoping makes
collisions impossible instead of resolving them arbitrarily.

This adds a dataset selector to the dashboard, defaulting to the most recent completed
upload. It is the one decision here that expands phase 5 and 6, and it was taken with that
understood.

### Indexes

```sql
CREATE INDEX idx_checks_day     ON checks(upload_id, day, ts);
CREATE INDEX idx_checks_service ON checks(upload_id, service_id, day, ts);
CREATE UNIQUE INDEX idx_checks_dedup
    ON checks(upload_id, service_id, ts, agent, status_code, COALESCE(latency_ms, -1));
```

- `idx_checks_day` serves the logs view. Both filter shapes the assignment requires — a
  single date (`day = ?`) and a range (`day BETWEEN ? AND ?`) — are a prefix match then a
  range scan on this index, and because `day` is derived from `ts`, the index order *is*
  `ORDER BY day, ts`, so the sort is free.
- `idx_checks_service` serves the stats section, which groups by service and by day, and
  also serves a service-filtered logs view.
- `idx_checks_dedup` is the exact-duplicate definition from C4, enforced in the schema so
  `INSERT OR IGNORE` makes ingest idempotent. `COALESCE(latency_ms, -1)` is there because
  SQLite treats `NULL`s as distinct in a unique index, so without it two identical
  blank-latency rows would both insert and defeat the constraint.

No index on `status_code` or `status_class`: the whole table is 15k rows per upload and
every stats query already filters by `upload_id` first, so a scan within an upload is
cheaper than another index to maintain on write.

### Pagination

`checks` has an `INTEGER PRIMARY KEY` so that the logs view can page by keyset — `WHERE
(ts, id) > (?, ?)` — rather than by `OFFSET`, which re-scans everything it skips. Phase 4
decides the page size; the schema just needs the stable tiebreaker to exist.

## 6. Open for phase 3

`resolveCheckPoint` — the function implementing section 1's resolution block — is the piece
worth writing by hand rather than generating. It encodes Q1, Q2, and Q3 together, it is a
pure function with obvious known-bad inputs from `docs/data-findings.md`, and it is the
single thing a follow-up discussion is most likely to attack.

## 7. Ingest implementation (phase 3)

### `resolveCheckPoint` written by the assistant, not by hand

Section 6 above asks for this function to be hand-written. It was implemented by the
assistant instead, on the user's explicit live authorization to push through standing
process gates rather than stop and wait. This is not a retraction of the reasoning in
section 6 — the function is still the single piece most likely to be attacked in a
follow-up discussion — only a record of who actually wrote it and why the standing
instruction was overridden this once.

### Rejected rows use the same batch-insert shape as accepted rows

The batching math above (500 rows/statement) was worked out for the accepted-rows path.
Rejected rows are quarantined through the same `json_each` batch insert, not one `INSERT`
per row, because a chunk that is mostly or entirely structurally invalid would otherwise
blow the 50-query-per-invocation budget on the reject path alone. Same batch size, same
reasoning as the accepted path.

### `rows_corrected` is counted pre-dedup

`INSERT OR IGNORE ... SELECT ... FROM json_each(...)` reports how many rows were ignored
only as a count (`meta.changes`), not which ones. Getting an exact post-dedup corrected
count would need a `RETURNING` clause, and current D1 support for `RETURNING` on this
insert shape was not confirmed against the docs, so it was not assumed. `rows_corrected`
is therefore counted before the dedup check runs, which can overcount by at most the
chunk's `rows_duplicate` count, in the rare case a corrected row is also a cross-chunk
exact duplicate. Bounded, and `rows_duplicate` is reported in the same summary alongside
it, so the discrepancy is visible rather than hidden.

### CORS is open on all three ingest endpoints

`Access-Control-Allow-Origin: *`. No authentication is in scope per the assignment, so
there is no session or cookie boundary this would weaken, and the upload UI (phase 5) is
the only client this is meant to serve.

### `wrangler types` output replaces `@cloudflare/workers-types`

`@cloudflare/workers-types` was added, then removed once `wrangler types` printed its own
recommendation to generate `worker-configuration.d.ts` instead and drop the separate
package. The generated file is committed, per Cloudflare's own default template
`.gitignore`, and gets regenerated with `npm run types` after any `wrangler.jsonc` binding
change.

## 8. Query endpoints (phase 4)

### Expected points use the whole upload's service count, not the range's

`coverage`'s denominator (`days x 96 per service`) counts every service that
appears anywhere in the upload, not just the ones with rows in the requested
range. The assignment's 5 services are fixed for a given file, so a service
that is silent for part of the range should still count against coverage -
narrowing the denominator to only-services-present-in-range would make a total
outage in a range look identical to that service simply not existing.

### Availability, coverage, and degraded rate are `null`, not `0`, on an empty denominator

`available / (available + unavailable)`, `observed / expected`, and
`degraded / available` all return `null` when their denominator is 0 (no
resolvable check-points in range, or an upload with zero services) rather than
0. A `0` would read as "confirmed down" or "confirmed zero coverage"; `null` is
"nothing to report," which is a different fact and the dashboard should be able
to tell the two apart rather than silently plotting a false zero.

### Stats and logs require the upload to exist, not to be finalized

Both endpoints 404 on an unknown `uploadId` but do not check `status`. An
in-progress (`open`) upload can still be queried - useful for a client
watching partial results land - and nothing about the query logic depends on
`finalize` having run, since it reads `checks` directly rather than the
`uploads` summary columns.

### Logs pagination: `limit` defaults to 100, capped at 500

Chosen the same way as the phase 3 batch size - deliberately, not by default.
100 is a browser-table-sized page; 500 is a hard ceiling that still keeps a D1
response and the JSON payload small, well under the free-tier response-size
limits phase 3 already designed around. `getLogs` fetches `limit + 1` rows to
know whether a next page exists without a second COUNT query.

### p95 uses the nearest-rank method

`latency.p95` is the smallest value at or above the 95th percentile of the
sorted, non-null latencies in range (`ceil(0.95 * n) - 1`, clamped to the last
index). This is computed in the Worker after one D1 read rather than in SQL,
since SQLite has no built-in percentile function; the same read already backs
the check-point grouping, so this adds no extra query.

### Known constraint: stats grouping is O(rows in range) in Worker memory, not SQL

`getStats` fetches every row in the requested range and groups it into
check-points in JavaScript, because resolving a check-point (worst-status-wins,
mean-of-non-null-latency) is not expressible as a single SQL aggregate. For a
narrow range this is cheap; for the full ~15,577-row file queried as one range,
it is the same order of magnitude of work as a chunk in phase 3's ingest path,
which is already sized to the Workers free-tier CPU budget - phase 7's full-file
verification is the place this gets confirmed under real volume rather than
assumed here.

## 9. Upload UI (phase 5)

### Chunking is sequential and client-driven, matching the phase 3 ingest contract

The browser reads the whole file with `file.text()`, splits on the header line,
groups data lines into 1,000-row chunks (`docs/decisions.md` section 4), and
POSTs each chunk in order, waiting for one to succeed before sending the next.
Sequential, not parallel: `postChunk` is idempotent per `(uploadId,
chunkIndex)` by design, so a serial loop is the simplest thing that is also
correct on retry, and the largest real file here is ~16 chunks - there is no
throughput problem sequential POSTs need to solve.

### File size cap: 20MB, client-side only

Not derived from any protocol limit - the D1 2MB bound-string ceiling already
governs the chunk size, not the whole file, and the largest CSV in this
project is ~1.1MB. 20MB is a round number whose only job is to catch "wrong
file picked" before the browser reads the whole thing into memory, checked
against `file.size` before `file.text()` is ever called.

### File type check is by extension, not MIME type

`accept=".csv,text/csv"` on the input is a picker hint only; the actual
guard checks `file.name` ends in `.csv`. Browsers report inconsistent or
empty MIME types for CSV depending on OS and how the file arrived (a `.csv`
downloaded from Slack, say, may have no `type` at all), so MIME is not a
reliable signal here and extension is.

### A failed chunk leaves the upload resumable, not restarted

If a chunk POST fails partway through, the UI keeps the `uploadId` and the
already-built chunk list in state and offers a "Retry" button that resumes
from the failed chunk index, not chunk 0. This falls directly out of ingest's
per-chunk-index idempotency (section 4/7): re-POSTing an already-recorded
chunk index is safe but wasteful, so resuming from the failure point is the
natural choice, not a new mechanism. The same path handles a failure in
`finalize` after all chunks succeeded, by resuming with `startIndex` set past
the last chunk so the retry re-runs only `finalize`.

### Verified live against the real Worker

`wrangler dev` (local D1, migrations applied via `wrangler d1 migrations
apply sla-monitoring --local`) plus the Vite dev server, driven with
`chrome-devtools`: uploaded `fixtures/dev_checks.csv` through the real UI,
confirmed the accepted/corrected/rejected/duplicate summary and the
corrections breakdown render correctly (199 accepted, 26 corrected, 0
rejected, 1 duplicate on the fixture). Also confirmed the wrong-file-type
error shows inline and disables Upload.

One real bug caught and fixed here: the page had `dark:` text-color classes
but no explicit background, so on a dark-mode browser the text rendered
near-white on the default white page background - unreadable. Fixed by
giving `<body>` and the root `<main>` explicit light/dark backgrounds instead
of leaving the background at browser default.

## 10. Dashboard stats selection (phase 6, part 1)

`StatsResult` computes ten numbers. The dashboard shows four. The assignment grades
the choice of stats as a design decision, and showing everything computable is the
absence of a choice, so each one below earns its place against a named reader.

The two readers are an on-call engineer ("is something broken, which thing, how bad")
and a billing analyst ("is a credit owed, and can I defend it in a dispute"). They
want different numbers, and neither wants all ten.

### The four

**Availability, with the credit verdict attached.** The headline. Rendered as
`99.94% - no credit owed` or `98.31% - credit owed (below 99.9%)`. The 99.9%
threshold is already settled in section 1; printing the percentage without the
verdict leaves the reader to make the comparison that the dashboard exists to make
for them. Underneath it, the supporting count `N available / M unavailable`, so the
figure is checkable rather than asserted - a credit dispute is exactly where a bare
percentage is worth least.

**Degraded rate.** Section 1 argues that a brownout must never fold into uptime,
because that conflates two SLOs and changes the credit owed on grounds the contract
never mentions. The consequence is that availability alone actively misleads: the 9d
`svc-reports` incident reports 8.33% down while the service was serving 3-second
responses through the middle of the window. Having deliberately kept the two apart in
the SLA definition, the dashboard has to show both or the separation becomes a way of
hiding the brownout rather than of measuring it honestly.

**Latency p95.** The on-call number.

**Coverage, as a data-integrity line rather than a fourth tile.** Section 1 records
that this data contains zero missing check-points, so coverage must read exactly 100%
and anything less is a bug in our own cleaning rather than a fact about the services.
That makes it an alarm, not a KPI: it renders as a status line (`100% coverage, no
gaps`) or as a visible warning, and it does not compete for attention with the three
numbers a reader is actually here for.

### What is not shown, and why

- **Latency mean** is dropped. p95 is the SLO-relevant figure, and a mean displayed
  beside it invites averaging away precisely the tail that the degraded flag exists to
  surface.
- **`expected`** is not shown on its own. It is only meaningful as coverage's
  denominator, where it already appears.
- **`excluded`** is shown only when greater than zero, as a footnote. It is the
  explanation for why availability's denominator is smaller than the total check-point
  count, which is invisible and confusing otherwise, but it is noise on a range where
  nothing was excluded.

### `null` is a display state, not a zero

Section 8 makes `availability`, `coverage`, and `degradedRate` null on an empty
denominator rather than zero. The distinction has to survive into the UI: rendering a
null as `0%` would report a total outage on a range where there is simply no data.
Each of the four gets an explicit no-data rendering, and no call site defaults a null
to a number.

### Blended availability is wrong for a credit decision, so stats gain a service dimension

`getStats` aggregates across every service in the upload. For a credit decision that
is not merely incomplete, it is incorrect: credits are owed per service, so a blended
figure both hides one service's breach behind four healthy ones and implies a credit
for the four that met their SLO. A dashboard whose headline number can answer "no
credit owed" while a credit is owed is not defensible in the interview this project
has to survive.

So `getStats` is extended with a per-service breakdown, and the dashboard shows the
per-service availability alongside the blended figure. This is Worker work that phase
4 did not scope; it was raised as scope expansion and agreed before starting, rather
than absorbed silently into the phase 6 build.

### The dashboard needs `GET /uploads`

Every existing route is scoped to an `uploadId`, and nothing lists them, so after a
page refresh the dashboard has no way to discover which upload to display. A small
route listing uploads newest-first is added, and the dashboard defaults to the most
recent. The alternatives considered were holding the id in React state (a refresh
empties the screen, which is a poor thing to discover during phase 7's live
verification) and persisting it in `localStorage` (survives a refresh but shows a
stale id whenever the D1 data is reset).

## 11. Dashboard build (phase 6, part 2)

### Upload and dashboard are two tabs in one app, not two routes

The assignment names them as separate concerns (upload screen; single-screen dashboard
with two sections). No router is added for a two-way switch - `App.tsx` holds which
screen is showing in local state, matching the existing "no dependency without a
concrete need" rule from earlier sections. Finishing an upload switches to the
Dashboard tab automatically and preselects the upload just created, which is the
"does it work end to end" path the assignment cares about most.

### Stats and logs share one date filter, not two

The assignment requires only the logs view to be filterable, but `getStats` is
range-scoped too - section 1 already commits to "the dashboard computes over the
selected date range." A single `DateFilterControl` in `Dashboard.tsx` drives both
`StatsSection` and `LogsSection`, so the two sections are never looking at different
ranges without saying so. The alternative, two independent pickers, was rejected for
exactly that reason.

### The date filter is debounced before it reaches the sections, not at the input

Live verification (`chrome-devtools`, typing a year into the native date input one
digit at a time) found that a `<input type="date">` reports a live intermediate value
on every keystroke - typing "2025" reports "0005", "0050", "0508" along the way - each
of which fired a real request at the Worker, several of them invalid. `Dashboard.tsx`
keeps the input bound to the instant filter state for responsiveness and derives a
second, 400ms-debounced value that `StatsSection`/`LogsSection` actually fetch against.
This is a general lesson worth restating: a value that changes once per keystroke is
the wrong thing to fetch against directly, regardless of which component owns it.

### Verified live against the real Worker

`wrangler dev` (local D1) plus the Vite dev server, driven with `chrome-devtools`:
loaded the dashboard, confirmed the upload selector, the default date (the upload's
`dayLast`), and both sections render against `dev_checks.csv`. Widened the range to
the fixture's full span and got the exact figures already seen over curl - blended
availability 95.74%, credit owed, `reports-api` at 92.92% while the other four
services read 100% - confirming the per-service breakdown renders the real dilution
case section 10 argued from, with `reports-api`'s row styled in red for being below
the 99.9% threshold. Confirmed the null/no-data and validation-error paths render
visibly rather than silently (an inverted range surfaced the Worker's own "from must
not be after to" message in both sections). Confirmed dark mode, learning from phase
5's bug: backgrounds are explicit, nothing relies on the browser default.

Not exercised live: the "Load more" pagination button itself (its cursor mechanism is
already covered by `query.test.ts`'s "paginates via cursor" test, and the button's
correct appearance with a valid cursor after a real fetch confirms the wiring reaches
it) and the upload-selector dropdown with genuinely distinct uploads (only same-named
fixture re-uploads existed locally).

## 12. Deploy and live verification (phase 7)

### Frontend hosting migrated from classic Pages to Workers+assets

`wrangler pages project create` no longer creates a classic Cloudflare Pages
project for a new account - it delegates to Cloudflare's unified Workers+assets
platform instead (`*.workers.dev`, not `*.pages.dev`), and does so silently: it
also scaffolded `frontend/wrangler.jsonc`, added `@cloudflare/vite-plugin` and
`wrangler` as dependencies, rewrote `vite.config.ts` to use the Cloudflare Vite
plugin, and changed the `deploy`/`preview` scripts, all in one command. Accepted
this rather than fighting the CLI: it's the same provider, same free tier, same
CLI, and the same "one deploy story I can explain" reasoning section 1 gave for
choosing Pages in the first place - Cloudflare just renamed and merged the
mechanism. The project was renamed `sla-frontend` (the CLI's auto-generated
name was `frontend`) to match `sla-worker`'s naming.

Two stray projects from working out the correct deploy command (`sla-monitoring`,
a broken build with `localhost:8787` baked in from the CLI's own untracked
rebuild, and `frontend`, the auto-generated name before the rename) were deleted.

### Live URLs

- Worker: `https://sla-worker.blusinghaditya.workers.dev`
- Frontend: `https://sla-frontend.blusinghaditya.workers.dev`
- D1 database: `sla-monitoring` (id `edf9c3c5-76b0-454a-9855-9ef9d2732748`)

### Full-volume upload verified live, against the real deployed Worker and D1

Uploaded `monitoring_checks_30d_seed404.csv` (15,578 lines, the largest of the
five files) through the live UI with `playwright`, not curl - 16 chunks, all
succeeded. 15,552 rows persisted to remote D1 (confirmed with
`wrangler d1 execute --remote`), the small gap from 15,577 data rows being
exactly the kind of drop the cleaning rules in section 2 are expected to
produce. Real span turned out to be 2025-04-06 to 2025-05-05, not the ~30 days
counted forward from the last day that the filename suggested.

A range query first tested against a guessed `to` date outside the real data
(2025-06-04) returned numbers identical to the single-day view except for a
dropped coverage percentage - looked like a bug at first glance. It wasn't:
the guessed range only overlapped the real data on one day, so `day BETWEEN`
correctly matched only that day, while `expected` (coverage's denominator)
scaled correctly against the full guessed span. Re-run against the upload's
real `dayFirst`/`dayLast` (2025-04-06 to 2025-05-05, from `GET /uploads`)
returned 14,399 resolved check-points, 98.74% blended availability, credit
owed, 100% coverage, and a distinct, plausible per-service breakdown - all
consistent with real cleaned data at full volume. Confirms `day BETWEEN`
range queries, the coverage/expected calculation, and per-service aggregation
all hold up under the full 15,552-row file, not just the ~200-row dev fixture.

Also confirmed live on the deployed site: persistence survives a hard page
reload (identical stats after reloading with no client-side state, refetched
from remote D1 - proves it's server-side, not in-memory), zero console errors,
and the stats collapse toggle. Screenshot saved to `docs/dashboard-live.png`.

**Not yet exercised**: the resumable-retry path in `UploadScreen.tsx`
(mid-upload chunk failure, finalize failure) - never triggered against a real
dropped request, deployed or local. Carried forward as an open question.
(Later: the Worker side is now covered over HTTP by
`worker/test-worker/resume.test.ts`; the browser side still is not.)
(Later again, 2026-09-23: the browser side has been exercised locally. Chromium
against `wrangler dev`, faults injected with Playwright request interception on
`monitoring_checks_9d_seed101.csv` (5 chunks): chunk index 2 response dropped
after commit, chunk index 3 aborted before sending, finalize response dropped
after commit. Retry recovered from each; the upload matched a clean upload of
the same file exactly - 4,672 total, 4,665 stored, 1,059 corrected, 7
duplicates, identical corrections JSON, 5 chunk markers. Not a real network
drop, and not against the deployed site.)

**Verified live at**: 2026-09-22, ~17:50 UTC.

## 13. Post-review fixes (after phase 9)

A code review after phase 9 found ten defects, which it reported
rather than fixed. Nine were fixed afterwards; the tenth was
already recorded here as an accepted constraint. Each fix is one commit.

**C13.1 — CRLF is stripped at the split, not later.** All five source CSVs are
CRLF, and both the Worker and the browser split chunks on `"\n"`, so a carriage
return stayed glued to the last column and every stored `region` was
`"ap-south-1\r"`. Both now split on `/\r?\n/`. No SLA figure moves - `region` is
the degenerate column from F13 - but the value was corrupt, and the reason 93
tests missed it is worth recording: every assertion looked at a number. Two new
assertions look at `region` instead, one in the fixture test and one against a
CRLF chunk posted through the real ingest path.

**C13.2 — a whitespace-only latency is missing, not zero.** `Number(" ")` is
`0`, so a blank-but-not-empty latency field bypassed `latency_missing` and would
have been stored as a real measurement of zero, pulling mean and p95 down.
`parseLatencyField` now trims before its emptiness test, matching what the
status field two lines above already did. Latent in this data - phase 1
established these fields are genuinely empty - but wrong for any future file.

**C13.3 — a chunk's rows and its marker commit together.** The `upload_chunks`
marker used to be written after the row inserts, so a failure in between left
rows with no marker; the client's retry then re-inserted the quarantined rows
(`rejected_rows` has no unique constraint) and recorded the chunk as accepting
nothing, because every check row now collided with the copy already stored.
The marker moved into the same `db.batch()` as the rows, which D1 runs as one
transaction. `rows_accepted` has to be bound before the batch executes, which
`INSERT OR IGNORE` does not allow, so the marker derives it in SQL from the
upload's row count before and after the inserts, and the response is read back
from the stored row so the two cannot disagree.

**C13.4 — finalize is idempotent.** A repeat finalize used to get 409
`upload_not_open` forever, so an upload whose finalize response was lost had its
rows committed and its summary unreachable - and the summary is the only thing
the upload screen shows. A finalize against an already-complete upload now
returns the summary stored on the `uploads` row. 409 remains for a `failed`
upload, which is a real conflict. The alternative - treating 409 as success in
the browser - was rejected: the client cannot distinguish a lost response from a
finalize that never arrived, so the server is the only place the question can be
answered correctly.

**C13.5 — thrown Worker errors come back as JSON with CORS headers.** An
unhandled D1 error got Cloudflare's default 500, which carries no
`Access-Control-Allow-Origin`; the browser turns that into an opaque
`TypeError`, so the UI reported "unknown error" for every server-side failure.
The router moved out of the default-export object into a `route` function and
the handler wraps it in try/catch.

**C13.6 — `rejected_rows.line_no` is the source line number.** It restarted at
2 in every chunk, so source lines 2, 1002 and 2002 all recorded `line_no = 2`,
defeating the only purpose the table has. The offset comes from summing
`rows_total` over earlier chunks rather than multiplying by an assumed chunk
size, so the Worker keeps no opinion about how the client slices the file.

**C13.7 — the dashboard no longer shows the previous filter's data.** The stats
panel never cleared its last response, so switching upload or date rendered one
upload's availability and credit verdict under another's heading, and left them
beside the error if the new request failed. The logs "load more" had no
cancellation, so a page fetched under the old filter could append to the new one
and overwrite the cursor. Both now key on the upload and filter being displayed.

**C13.8 — selecting an upload re-seeds the date filter.** Two uploads can cover
completely different windows, so carrying the old date across a switch showed
"No rows in this range" and made a good upload look empty.

**Not fixed:** the stats query is unbounded and grouped in JS. That is section 8
above, an accepted constraint rather than a new finding.

**Verification:** `cd worker && npm test` - 97 passed, 6 files (93 before, plus
four written for these fixes). `cd frontend && npx tsc -b && npm run lint` clean.
End to end against `wrangler dev` with local D1 and the 200-row fixture posted as
two CRLF chunks: 199 accepted, 1 duplicate, `region` returned as `ap-south-1`
with no carriage return, a repeat finalize returning 200 with the same summary
rather than 409, and OPTIONS, 404 and 400 responses all still carrying CORS
headers after the router refactor.

**Not yet redeployed.** These fixes are local only. The live Worker still runs
the pre-fix code and the remote database still holds the phase 7 upload with
carriage returns on all 15,552 rows.
