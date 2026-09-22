# Dev fixture manifest

Derived by `scripts/build_dev_fixture.py` (seed 42) from the real datasets.
Never hand-typed. 200 rows total, 116 chosen for a specific
finding class plus one plain epoch-format row, the rest a deterministic random sample
of ordinary 9d rows for volume and service/day spread.

| Finding | What it covers | Source |
|---|---|---|
| F11 | svc-reports full UTC day 2025-05-13 — the 9d brownout incident, plus its normal traffic | monitoring_checks_9d_seed101.csv |
| F5 | exact duplicate row pair | monitoring_checks_9d_seed101.csv |
| F8 | status 999, unclassifiable | monitoring_checks_9d_seed101.csv |
| F9 | negative latency | monitoring_checks_9d_seed101.csv |
| F10 | blank latency on a status-200 row | monitoring_checks_9d_seed101.csv |
| F4 | same check-point reported by both agents | monitoring_checks_9d_seed101.csv |
| F3 | +05:30 row whose local date differs from its UTC date | monitoring_checks_9d_seed101.csv |
| F1 | latency recorded in seconds rather than ms | monitoring_checks_9d_seed101.csv |
| F6 | same agent, same check-point, latency present once | monitoring_checks_14d_seed202.csv |
| F7 | two agents disagree on status_code for one check-point | monitoring_checks_14d_seed202.csv |
| F2 | plain 10-digit epoch timestamp | monitoring_checks_9d_seed101.csv |

Re-run with `python3 scripts/build_dev_fixture.py` any time the source CSVs or the selection logic change; the output is deterministic given the same seed.
