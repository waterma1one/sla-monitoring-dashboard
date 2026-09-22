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
