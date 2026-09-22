-- Initial schema for the SLA monitoring dashboard.
--
-- Rules and reasoning behind every choice here are in docs/decisions.md; the data
-- evidence they respond to is in docs/data-findings.md, referenced below as F1-F13.
--
-- Conventions:
--   * All instants are UTC. `ts` is epoch seconds; `day` is the UTC calendar date.
--   * All latencies are milliseconds. The source CSV's latency_unit column mixes `ms`
--     and `s` (F1) and is normalised at ingest rather than stored.
--   * Every row is scoped to an upload (F12): the supplied files are overlapping
--     simulations of the same services that disagree at up to 216 shared check-points
--     per pair, so (service_id, ts) is not unique across uploads.

-- One row per uploaded CSV. The scope every other table hangs off.
CREATE TABLE uploads (
    id            TEXT PRIMARY KEY,           -- uuid, minted when the upload is opened
    filename      TEXT NOT NULL,
    uploaded_at   TEXT NOT NULL,              -- ISO 8601 UTC
    status        TEXT NOT NULL               -- see CHECK below
                  CHECK (status IN ('open', 'complete', 'failed')),
    -- Observed UTC day range, written at finalise. Null while status = 'open'.
    day_first     TEXT,
    day_last      TEXT,
    -- Copied from the SUM over upload_chunks at finalise so the dashboard reads one row.
    rows_total    INTEGER NOT NULL DEFAULT 0,
    rows_accepted INTEGER NOT NULL DEFAULT 0,
    rows_corrected INTEGER NOT NULL DEFAULT 0,
    rows_rejected INTEGER NOT NULL DEFAULT 0,
    rows_duplicate INTEGER NOT NULL DEFAULT 0,
    -- Per-rule correction counts as JSON, e.g. {"unit_converted": 1242, ...}. JSON so a
    -- new cleaning rule does not require a migration.
    corrections   TEXT
);

-- One row per accepted chunk. The browser slices the CSV and posts chunks separately,
-- because the Workers free tier allows 10ms CPU per invocation and 15,577 rows do not
-- parse in that budget. Keyed by chunk_index so a client retry is idempotent and the
-- upload summary is a SUM over chunks rather than an incremented counter.
CREATE TABLE upload_chunks (
    upload_id      TEXT NOT NULL REFERENCES uploads(id),
    chunk_index    INTEGER NOT NULL,
    rows_total     INTEGER NOT NULL,
    rows_accepted  INTEGER NOT NULL,
    rows_corrected INTEGER NOT NULL,
    rows_rejected  INTEGER NOT NULL,
    rows_duplicate INTEGER NOT NULL,
    PRIMARY KEY (upload_id, chunk_index)
);

-- Accepted check rows, corrections applied, with a record of what was corrected.
CREATE TABLE checks (
    id           INTEGER PRIMARY KEY,         -- keyset pagination tiebreaker
    upload_id    TEXT NOT NULL REFERENCES uploads(id),
    service_id   TEXT NOT NULL,
    -- service_name and region are functionally dependent on service_id and agent (F13).
    -- Kept denormalised: 5 low-cardinality values over 15k rows costs nothing against a
    -- 500MB budget, and normalising would buy storage we are not short of at the price of
    -- a join on every query.
    service_name TEXT NOT NULL,
    region       TEXT NOT NULL,
    agent        TEXT NOT NULL,
    ts           INTEGER NOT NULL,            -- epoch seconds, UTC (F2)
    day          TEXT NOT NULL,               -- 'YYYY-MM-DD' UTC, derived from ts (F3)
    status_code  INTEGER NOT NULL,            -- as reported, including 999 (F8)
    -- Allowlist rather than a `not 5xx` test, so an unseen 4xx classifies correctly.
    status_class TEXT NOT NULL
                 CHECK (status_class IN ('available', 'unavailable', 'invalid')),
    latency_ms   REAL,                        -- always ms; NULL when absent (F10) or negative (F9)
    degraded     INTEGER NOT NULL DEFAULT 0   -- available but latency_ms > 1000 (F11)
                 CHECK (degraded IN (0, 1)),
    -- Comma-separated correction flags applied to this row, e.g. 'unit_converted,ts_offset'.
    -- Empty string when the row needed no correction.
    corrections  TEXT NOT NULL DEFAULT ''
);

-- Rows that could not be parsed. Retained with the raw text so a credit dispute has
-- something to inspect. Status-999 rows are NOT here - they are well-formed observations
-- we cannot classify, so they stay in `checks` and appear in the logs view.
CREATE TABLE rejected_rows (
    id        INTEGER PRIMARY KEY,
    upload_id TEXT NOT NULL REFERENCES uploads(id),
    line_no   INTEGER NOT NULL,
    raw       TEXT NOT NULL,
    reason    TEXT NOT NULL
);

-- Logs view: single date (day = ?) and date range (day BETWEEN ? AND ?) are a prefix
-- match then a range scan. Because day is derived from ts, index order is already
-- ORDER BY day, ts, so the sort is free.
CREATE INDEX idx_checks_day ON checks(upload_id, day, ts);

-- Stats section: groups by service and day. Also serves a service-filtered logs view.
CREATE INDEX idx_checks_service ON checks(upload_id, service_id, day, ts);

-- The definition of an exact duplicate (F5), enforced in the schema so INSERT OR IGNORE
-- makes ingest idempotent and duplicates that straddle a chunk boundary are still caught.
-- COALESCE because SQLite treats NULLs as distinct in a unique index, so without it two
-- identical blank-latency rows would both insert.
CREATE UNIQUE INDEX idx_checks_dedup
    ON checks(upload_id, service_id, ts, agent, status_code, COALESCE(latency_ms, -1));

CREATE INDEX idx_rejected_upload ON rejected_rows(upload_id);
