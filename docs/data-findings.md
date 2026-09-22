# Data findings

Phase 1 output. This document records what is *wrong* with the five monitoring CSVs.
It deliberately does not propose fixes — the handling decisions are made in phase 2,
kept separate from the evidence they respond to.

## How I profiled

No CSV was ever read whole. Every number below comes from an aggregation script that
reads a file row by row and prints only counts. The scripts are committed in `docs/profiling/` so each figure can be
re-derived:

| Script | What it answers |
|---|---|
| `p1_structure.py` | Column-level profile: field counts, blanks, distinct values, timestamp format classes, latency ranges per unit |
| `p1_time.py` | Timestamp normalisation to UTC, cross-tabs by agent, 15-minute grid coverage, duplicate keys |
| `p1_dups.py` | Duplicate classes, agent disagreement, whitespace and case drift, the offset counterfactual |
| `p1_impact.py` | Availability under competing readings of the data, latency distortion, incident run detection |
| `p1_final.py` | Reports per check-point, blank-latency recoverability, worst service-days |
| `p1_brown.py` | Latency outlier buckets and their correlation with status code |
| `p1_overlap.py` | Whether the five files collide with each other on `(service, timestamp)` |

Run any of them with `python3 docs/profiling/<script>.py`. Standard library only.

`dataset_incident_log.json` was used **only as an oracle** — I derived the incident
windows from the status codes and latencies first, then checked them against the log.
That is what exposed finding F11.

## Dataset shape

Each file is an independent simulation of the same five services (`svc-auth`,
`svc-notify`, `svc-payments`, `svc-reports`, `svc-search`), one check every 15 minutes,
which is 96 check-points per service-day.

| File | Data rows | Days | UTC range | Distinct check-points | Rows above cadence |
|---|---|---|---|---|---|
| `monitoring_checks_9d_seed101.csv` | 4,672 | 9 | 2025-05-08 → 2025-05-16 | 4,320 | 352 |
| `monitoring_checks_12d_seed505.csv` | 6,230 | 12 | 2025-04-10 → 2025-04-21 | 5,760 | 470 |
| `monitoring_checks_14d_seed202.csv` | 7,269 | 14 | 2025-05-19 → 2025-06-01 | 6,720 | 549 |
| `monitoring_checks_21d_seed303.csv` | 10,904 | 21 | 2025-04-03 → 2025-04-23 | 10,080 | 824 |
| `monitoring_checks_30d_seed404.csv` | 15,577 | 30 | 2025-04-06 → 2025-05-05 | 14,400 | 1,177 |

In every file the distinct check-point count equals `days × 96 × 5` exactly. The day
counts and start dates match `dataset_incident_log.json`. All five files carry the
identical header `service_id,service_name,timestamp,status_code,latency,latency_unit,agent,region`
and every row has exactly 8 fields.

Two reporting agents appear, `agent-1` and `agent-2`, both tagged `ap-south-1`.
`agent-1` carries roughly 92% of rows; `agent-2` re-reports a sampled subset.

---

## F1 — `latency` is recorded in two different units · material

**Files:** all five. **Scale:** about 20% of rows use seconds.

| File | `ms` rows | `s` rows |
|---|---|---|
| 9d | 3,737 | 935 |
| 12d | 4,988 | 1,242 |
| 14d | 5,817 | 1,452 |
| 21d | 8,720 | 2,184 |
| 30d | 12,446 | 3,131 |

Example, seconds: `svc-search,search-api,2025-05-31T11:00:00Z,999,0.632,s,agent-1,ap-south-1`
Example, milliseconds: `svc-auth,auth-api,2025-04-16T19:00:00Z,999,116,ms,agent-1,ap-south-1`

The `latency_unit` column is trustworthy: within `s`-labelled rows the observed range is
0.339–2.452, and within `ms`-labelled rows it is 223–3,022 in absolute value. Neither
range is plausible under the other unit, so no row appears to be mislabelled — the unit
column genuinely varies rather than being noise.

**Why it matters:** treating the `latency` column as a single unit understates mean
latency by roughly 30% — 254–257 ms naive against 363–367 ms once converted, consistent
across all five files. Any latency SLO, p95, or "slowest service" ranking computed
without conversion is wrong, and wrong in the direction that makes the service look
better than it is.

## F2 — `timestamp` arrives in three different formats · material

**Files:** all five.

| File | `...Z` | Unix epoch seconds | `+05:30` offset |
|---|---|---|---|
| 9d | 4,570 | 70 | 32 |
| 12d | 6,094 | 93 | 43 |
| 14d | 7,110 | 109 | 50 |
| 21d | 10,665 | 163 | 76 |
| 30d | 15,235 | 233 | 109 |

Examples: `2025-04-16T19:00:00Z`; `1744349400` (epoch seconds, 10 digits — never
milliseconds — which is `2025-04-11T05:30:00Z`); `2025-06-01T12:00:00+05:30`.

The format does not correlate with the agent. In the 12d file `agent-1` writes all three
formats (5,641 `Z`, 86 epoch, 43 offset) and `agent-2` writes two. So this is a parsing
problem, not an agent-attribution problem, and cannot be handled by branching on `agent`.

**Why it matters, and how I know the offset is real:** after converting all three formats
to UTC, every single timestamp in all five files lands exactly on a 15-minute boundary,
and there are zero gaps in the grid. If the `+05:30` rows were instead local wall-clock
that had been mislabelled — that is, if the correct reading were to drop the offset —
then converting them opens 25 to 99 holes in the grid per file (9d: 25, 12d: 39, 14d: 45,
21d: 61, 30d: 99) and creates a matching number of collisions elsewhere. Zero holes under
one reading and 250 holes across the corpus under the other is not a coincidence, so
these rows are genuinely the same instants written in IST. Mis-parsing them displaces
those checks by 5h30m, which moves them into the wrong hour, the wrong SLA day, and in
some cases the wrong month.

## F3 — 73 rows carry a calendar date that is not their UTC date · material

**Files:** all five. **Scale:** 9d 3 rows, 12d 9, 14d 12, 21d 23, 30d 26.

These are the subset of F2's `+05:30` rows near a midnight boundary: the date written in
the string differs from the date of the instant in UTC. Example:
`2025-06-01T02:30:00+05:30` is `2025-05-31T21:00:00Z` — a different day.

**Why it matters:** the dashboard filters logs by a single date or a date range, and the
SLA is billed per period. A check filed on the wrong side of a midnight boundary moves
between billing buckets. It is a small number of rows, but they are concentrated exactly
where a day boundary decision bites.

## F4 — the same check-point is reported more than once · material

**Files:** all five. This is the bulk of the excess row count in the shape table.

| File | Points with 1 report | with 2 | with 3 |
|---|---|---|---|
| 9d | 3,968 | 352 | 0 |
| 12d | 5,290 | 470 | 0 |
| 14d | 6,172 | 547 | 1 |
| 21d | 9,257 | 822 | 1 |
| 30d | 13,227 | 1,169 | 4 |

Almost all of these are a second, independent observation by `agent-2` of a check-point
`agent-1` already reported — not a copied row. The two agents' latencies differ by a
median of 8 ms and a p95 of 34–38 ms, which reads like two probes measuring the same
thing rather than a duplicated record. Mean latency per agent agrees to within about
20 ms in every file.

**Why it matters:** these rows are not interchangeable with duplicates. Counting them
row-wise double-weights every check-point that happens to have two observers, which
biases latency averages toward whichever points `agent-2` sampled, and it makes the
denominator of an availability calculation depend on observer coverage rather than on
elapsed time. The 9d file shows the bias has a sign that is not predictable: row-wise
availability there is 99.0154% but per-check-point availability is *higher* at 99.0278%,
because the duplicated points happen to be disproportionately failing ones. In the other
four files the bias runs the other way.

## F5 — exact duplicate rows · material for latency, cosmetic for availability

**Files:** all five. **Scale:** 9d 6 groups, 12d 8, 14d 10, 21d 18, 30d 24. Every group
is exactly 2 copies; no row appears 3 times.

Every exact duplicate carries status `200`. None sits on a failing check.

**Why it matters:** because they are all successes, they cannot move the availability
numerator much, so for uptime this is close to cosmetic. They still double-count into any
row-wise latency average, and they will violate a primary key or unique index if the
schema declares one, which makes them a persistence problem rather than a maths problem.

## F6 — duplicate rows for the same agent that disagree · material

**Files:** `monitoring_checks_14d_seed202.csv` only. **Scale:** 2 cases.

```
svc-payments @ 2025-06-01T12:00:00Z agent-1 -> 200/269ms | 200/<blank>
svc-reports  @ 2025-06-01T12:00:00Z agent-1 -> 200/<blank> | 200/586ms
```

The same agent reports the same check-point twice, agreeing on status but with the
latency present in one copy and empty in the other. These are the hard case: they are not
exact duplicates (F5), and they are not two agents (F4), so neither a naive `DISTINCT`
nor an agent-priority rule resolves them.

**Why it matters:** whichever copy wins decides whether that check-point has a latency at
all. Picking the blank one silently discards a measurement that is sitting right there in
the file.

## F7 — the two agents disagree about a status code · material

**Files:** `monitoring_checks_14d_seed202.csv` only. **Scale:** 1 case out of 3,190
check-points observed by both agents across all five files.

```
svc-search @ 2025-05-31T11:00:00Z -> agent-1: 999 / 632ms | agent-2: 200 / 638ms
```

**Why it matters:** cross-agent agreement is otherwise total, which means the one
disagreement is informative rather than noise — and it is the same row as F8. Two probes
measured near-identical latency (632 ms vs 638 ms) at the same instant; only the status
code differs. That is evidence about what `999` actually is.

## F8 — status code `999`, exactly once per file · material

**Files:** all five, exactly one row each.

```
svc-payments,payments-api,2025-05-10T22:30:00Z,999,389,ms,agent-1,ap-south-1
svc-auth,auth-api,2025-04-16T19:00:00Z,999,116,ms,agent-1,ap-south-1
svc-search,search-api,2025-05-31T11:00:00Z,999,0.632,s,agent-1,ap-south-1
svc-search,search-api,2025-04-04T20:00:00Z,999,0.566,s,agent-1,ap-south-1
svc-auth,auth-api,2025-04-18T10:30:00Z,999,151,ms,agent-1,ap-south-1
```

`999` is not an HTTP status code. Every occurrence is on `agent-1`, and every one carries
a latency in the normal healthy range (116 ms to 632 ms against a 363 ms baseline) rather
than the elevated latency that accompanies real failures (F11). In the one case where
`agent-2` observed the same check-point, it reported `200` at 638 ms (F7).

**Why it matters:** the whole availability number turns on whether "available" is defined
as `status == 200`, `2xx`, or `not 5xx`. Under the first two readings `999` is downtime;
under the third it is not. One check-point is 1/96 of a service-day, so a single `999`
moves that service's daily availability by 1.042 percentage points — far more than the
0.1 point that decides whether a credit is owed. Corpus-wide the effect is smaller but
still real: for the 30d file, per-check-point availability is 98.7292% if `999` counts as
down and 98.7361% if it does not.

## F9 — negative latency, exactly once per file · material

**Files:** all five, exactly one row each.

```
svc-notify,notify-worker,2025-04-19T14:15:00Z,200,-296,ms,agent-1,ap-south-1
svc-auth,auth-api,2025-06-01T03:15:00Z,200,-342,ms,agent-1,ap-south-1
svc-reports,reports-api,2025-04-11T00:45:00Z,200,-307,ms,agent-1,ap-south-1
svc-notify,notify-worker,2025-04-16T13:00:00Z,200,-223,ms,agent-1,ap-south-1
svc-reports,reports-api,2025-05-11T21:15:00Z,200,-286,ms,agent-1,ap-south-1
```

All five are status `200`, all on `agent-1`, and all have an absolute value in the normal
latency band (223–342 ms against a 363 ms baseline). A negative elapsed time is
physically impossible, so the value is corrupt; the magnitude being plausible is the
interesting part.

**Why it matters:** a negative number does not just add noise to a mean, it subtracts. It
also passes straight through a naive `MIN(latency)` and any "fastest response" statistic,
and a percentile computed over a sorted array puts it at the bottom where it displaces a
real value. It does not affect availability, since all five rows are successes.

## F10 — empty `latency` on otherwise valid rows · material

**Files:** all five. **Scale:** about 1.2% of rows.

| File | Blank-latency rows | Check-points affected | Of those, a co-report has a latency |
|---|---|---|---|
| 9d | 56 | 56 | 9 |
| 12d | 74 | 74 | 9 |
| 14d | 87 | 87 | 16 |
| 21d | 130 | 130 | 23 |
| 30d | 186 | 186 | 20 |

The field is genuinely empty rather than whitespace or a sentinel string. Blanks are
overwhelmingly on successful checks (e.g. 30d: all 186 on status `200`; 21d: 128 on `200`,
1 on `500`, 1 on `502`), so this is not "latency is missing because the request failed".
Status code is never blank.

**Why it matters:** the row is still evidence that the check ran and what it returned, so
it counts toward availability, but it contributes nothing to latency. That means the
availability denominator and the latency denominator are not the same set of rows, and a
stats section that presents both from one `COUNT(*)` will misreport one of them.
Separately, 9–23 of these check-points per file have another report at the same instant
that *does* carry a latency, so the information is not always lost.

## F11 — incidents include latency brownouts that return `200` · material

**Files:** four of five (absent from the 14d file).

Latency outliers are not scattered — they cluster on exactly one service-day per file,
and that service-day is the seeded incident:

| File | Rows >1500 ms | Clustered on | Status of those rows |
|---|---|---|---|
| 9d | 6 | `svc-reports` 2025-05-13 (6) | 200×2, 502×2, 503×2 |
| 12d | 20 | `svc-search` 2025-04-14 (15), 2025-04-18 (5) | 200×7, 500×6, 502×4, 503×3 |
| 21d | 6 | `svc-payments` 2025-04-05 (6) | 200×2, 500×2, 502×1, 503×1 |
| 30d | 9 | `svc-reports` 2025-04-09 (9) | 200×2, 502×5, 503×2 |
| 14d | 0 | — | — |

The 9d file is the clearest case. `dataset_incident_log.json` declares
`svc-reports day 5: check-points 64-69 (~16:00-17:15 UTC)`, but that window contains no
run of four or more consecutive non-200 responses, which is why my run-detection missed
it at first. The actual window looks like this:

```
2025-05-13T15:30:00Z  200   797ms
2025-05-13T15:45:00Z  200   623ms
2025-05-13T16:00:00Z  502  3000ms
2025-05-13T16:15:00Z  502  3022ms
2025-05-13T16:30:00Z  200  2193ms   <-- "successful"
2025-05-13T16:45:00Z  503  1942ms
2025-05-13T17:00:00Z  200  2983ms   <-- "successful"
2025-05-13T17:15:00Z  503  2805ms
2025-05-13T17:30:00Z  500   790ms
2025-05-13T17:45:00Z  200   713ms
2025-05-13T18:00:00Z  500   640ms
```

Mean latency on failing rows is 481–791 ms depending on the file, against 361–363 ms on
successes, so failures are slower on average — but the reverse also holds: some of the
slowest responses in the corpus are nominally successful.

**Why it matters:** this is the finding with the largest consequence for what the
dashboard should say. An availability number computed purely from status codes reports
`svc-reports` at 8.33% down on 2025-05-13 while the service was in fact returning
3-second responses through the middle of that window. Whether a 3,000 ms `200` counts as
"available" is a definition question, not a data-cleaning question, and it changes both
the credit owed and whether an on-call engineer looking at the dashboard would even see
the incident.

## F12 — cross-file collisions on `(service_id, timestamp)` · material for the schema

The five files are independent simulations of the same five services over *overlapping*
calendar dates, and they disagree with each other:

| Pair | Shared check-points | Status disagreements |
|---|---|---|
| 12d vs 21d | 5,760 | 132 |
| 12d vs 30d | 5,760 | 144 |
| 21d vs 30d | 8,640 | 216 |

**Why it matters:** `(service_id, timestamp)` is not a unique key across uploads. If the
deployed app ingests two of these files, every shared check-point has two different
truths and the availability figure becomes a function of upload order. This constrains
the schema — rows need to be scoped to an upload or a dataset, or ingest needs a defined
replace/reject behaviour — and it has to be decided before the schema is written, not
after.

## F13 — degenerate and redundant columns · cosmetic

- `region` is `ap-south-1` for every row in all five files. The column carries no
  information, and "which region reported it" cannot be answered from this data.
- `service_name` is functionally dependent on `service_id` — the mapping is exactly 1:1
  in every file (`svc-auth`→`auth-api`, `svc-notify`→`notify-worker`,
  `svc-payments`→`payments-api`, `svc-reports`→`reports-api`, `svc-search`→`search-api`)
  with no drift. Storing it per row is redundant but harmless.

Neither can change an availability or latency figure, so both are cosmetic. They matter
only as schema design input.

---

## Checked and *not* present

The brief listed classes to check, not classes that are necessarily there. These were
checked and found absent, which is itself worth recording because some of them are the
obvious things a reviewer will ask about:

- **Missing check-points.** Zero. Every service has all 96 daily check-points for every
  day of its range, in every file. The seeded incidents manifest as error codes and
  elevated latency, never as absent rows. There is no gap-versus-downtime problem in
  this data — though a `999`, a blank latency, or a discarded row can *create* one during
  cleaning.
- **Malformed rows.** None. Every row has exactly 8 fields; no ragged rows, no embedded
  delimiters, no quoting problems.
- **Naming drift.** None. `service_id`, `service_name`, `agent`, `region`, and
  `latency_unit` each use a single consistent spelling, all lowercase, with no
  whitespace padding and no case variants.
- **Null or empty fields outside `latency`.** None. No other column is ever empty or
  whitespace-only.
- **Off-grid timestamps.** None. After UTC conversion every timestamp is exactly on a
  15-minute boundary with zero seconds.
- **Mislabelled units.** None detected. The only `ms`-labelled row below 10 in each file
  is the negative-latency row from F9.
- **4xx status codes.** None anywhere. Observed codes are `200`, `500`, `502`, `503`,
  and the single `999`.
- **Absurd latency.** Nothing above 3,022 ms and nothing zero. No obvious sentinel values
  such as `-1`, `9999`, or `99999`.
- **Epoch ambiguity.** All epoch timestamps are 10 digits (seconds); none are
  milliseconds, so there is no scale-detection problem.
- **Header drift.** All five files share a byte-identical header.

## What the numbers do to the SLA figure

Availability per file under competing readings, to show the size of the effect:

| File | Row-wise, as-is | Per check-point, any bad report = down | Per check-point, `999` treated as up |
|---|---|---|---|
| 9d | 99.0154% | 99.0278% | 99.0509% |
| 12d | 98.6677% | 98.6458% | 98.6632% |
| 14d | 98.4730% | 98.4226% | 98.4375% |
| 21d | 98.7894% | 98.7599% | 98.7698% |
| 30d | 98.7610% | 98.7292% | 98.7361% |

Two observations. First, every file is far below 99.9% however it is computed, so at the
whole-corpus level the choices above do not flip the credit decision — the incidents
dominate. Second, that is *not* true per service per day, which is the granularity the
dashboard actually shows: one check-point is 1.042 percentage points of a service-day,
so a single `999` or a single dropped row visibly moves a daily figure, and the worst
service-days are already severe:

| File | Worst service-day |
|---|---|
| 9d | `svc-reports` 2025-05-13 — 8.33% of check-points bad |
| 12d | `svc-search` 2025-04-14 — 16.67% |
| 14d | `svc-notify` 2025-05-19 — 17.71% |
| 21d | `svc-payments` 2025-04-05 — 17.71% |
| 30d | `svc-auth` 2025-04-22 — 18.75% |

Latency is where the cleaning choices bite hardest, because the distortion is large and
uniform rather than concentrated: mean latency is 254–257 ms if the unit column is
ignored and 363–367 ms once it is honoured, a ~30% understatement in every file. p95 sits
at 754–766 ms once units are converted.

## Questions phase 2 has to settle

Listed without recommendations, since the handling decisions are the point of phase 2:

1. What "available" means per check-point — `200` only, any `2xx`, or `not 5xx` — and
   therefore what `999` (F8) does to the number.
2. Whether a slow-but-successful response (F11) is available, degraded, or unavailable,
   and if there is a latency threshold, what it is.
3. How a check-point with two reports is resolved when they disagree (F4, F6, F7), and
   whether `agent-1` has priority, the worst status wins, or something else.
4. Which set of rows the availability denominator is computed over, given that blank
   latencies (F10) mean the latency denominator differs from it.
5. Whether the `+05:30` rows (F2, F3) are converted, and which timezone defines the
   dashboard's day boundary for filtering and for billing.
6. Whether cleaning is destructive or whether rejected and corrected rows are retained
   for audit — which the upload summary depends on.
7. How ingest behaves when a second file collides with data already stored (F12).
