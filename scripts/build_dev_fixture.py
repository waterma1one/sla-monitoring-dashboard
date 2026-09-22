#!/usr/bin/env python3
"""Derive fixtures/dev_checks.csv from the real datasets.

Phase 3 needs a small (~200 row) fixture that contains every issue class
documented in docs/data-findings.md (F1-F13), so cleaning-rule tests run fast
and exercise real corrupt rows instead of hand-typed guesses. This script
reads the source CSVs row by row (never loading a whole file into memory at
once beyond what csv.reader buffers, and never printing rows to stdout) and
selects a deterministic subset:

- svc-reports's full 9d day 2025-05-13 (the F11 brownout day), for a realistic
  run of a real incident window plus normal traffic either side of it.
- One F8 (status 999), one F9 (negative latency), one F10 (blank latency),
  one F5 (exact duplicate pair), one F4 (two-agent check-point), one F3
  (date-shifted +05:30 row), and one plain epoch-format row, all pulled from
  the 9d file where every one of those classes is independently confirmed
  present in docs/data-findings.md.
- F6 (same-agent conflicting pair) and F7 (cross-agent status disagreement)
  only occur in the 14d file, so those two check-points are pulled from there.
- A deterministic random sample of additional 9d rows to round the fixture
  out to roughly 200 rows spanning multiple services and both latency units.

Run: python3 scripts/build_dev_fixture.py
Output: fixtures/dev_checks.csv, fixtures/dev_checks.md (manifest)
"""
from __future__ import annotations

import csv
import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIELDS = ["service_id", "service_name", "timestamp", "status_code", "latency", "latency_unit", "agent", "region"]
TARGET_ROWS = 200
SEED = 42


def parse_utc(ts: str) -> datetime:
    """Parse any of the three timestamp formats found in the data (F2)."""
    if ts.isdigit():
        return datetime.fromtimestamp(int(ts), tz=timezone.utc)
    if ts.endswith("Z"):
        return datetime.fromisoformat(ts[:-1]).replace(tzinfo=timezone.utc)
    # +HH:MM / -HH:MM offset form, e.g. 2025-06-01T12:00:00+05:30
    return datetime.fromisoformat(ts).astimezone(timezone.utc)


def load(filename: str) -> list[dict]:
    path = ROOT / filename
    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    for row in rows:
        row["_utc"] = parse_utc(row["timestamp"])
        row["_source"] = filename
    return rows


@dataclass
class Pick:
    rows: list[dict]
    finding: str
    note: str


def find_full_day(rows: list[dict], service_id: str, day: str) -> list[dict]:
    return [r for r in rows if r["service_id"] == service_id and r["_utc"].strftime("%Y-%m-%d") == day]


def find_exact_duplicate(rows: list[dict]) -> list[dict]:
    seen: dict[tuple, list[dict]] = {}
    for r in rows:
        key = tuple(r[f] for f in FIELDS)
        seen.setdefault(key, []).append(r)
    for key, group in seen.items():
        if len(group) >= 2:
            return group[:2]
    raise RuntimeError("no exact duplicate found")


def find_status(rows: list[dict], code: str) -> dict:
    for r in rows:
        if r["status_code"] == code:
            return r
    raise RuntimeError(f"no row with status {code} found")


def find_negative_latency(rows: list[dict]) -> dict:
    for r in rows:
        try:
            if float(r["latency"]) < 0:
                return r
        except ValueError:
            continue
    raise RuntimeError("no negative-latency row found")


def find_blank_latency(rows: list[dict]) -> dict:
    for r in rows:
        if r["latency"] == "" and r["status_code"] == "200":
            return r
    raise RuntimeError("no blank-latency row found")


def find_two_agent_point(rows: list[dict]) -> list[dict]:
    by_point: dict[tuple, list[dict]] = {}
    for r in rows:
        by_point.setdefault((r["service_id"], r["_utc"]), []).append(r)
    for key, group in by_point.items():
        agents = {r["agent"] for r in group}
        if len(agents) >= 2:
            return group
    raise RuntimeError("no two-agent check-point found")


def find_date_shifted_offset(rows: list[dict]) -> dict:
    for r in rows:
        if "+05:30" not in r["timestamp"]:
            continue
        local_date = r["timestamp"][:10]
        utc_date = r["_utc"].strftime("%Y-%m-%d")
        if local_date != utc_date:
            return r
    raise RuntimeError("no date-shifted +05:30 row found")


def find_epoch_row(rows: list[dict], exclude: set[int]) -> dict:
    for i, r in enumerate(rows):
        if r["timestamp"].isdigit() and i not in exclude:
            return r
    raise RuntimeError("no epoch-format row found")


def find_seconds_unit_row(rows: list[dict]) -> dict:
    for r in rows:
        if r["latency_unit"] == "s":
            return r
    raise RuntimeError("no seconds-unit row found")


def find_same_agent_conflict(rows: list[dict]) -> list[dict]:
    """F6: same (service, timestamp, agent) reported twice, latency present once."""
    by_key: dict[tuple, list[dict]] = {}
    for r in rows:
        by_key.setdefault((r["service_id"], r["_utc"], r["agent"]), []).append(r)
    for key, group in by_key.items():
        if len(group) == 2 and group[0]["status_code"] == group[1]["status_code"]:
            blanks = [r["latency"] == "" for r in group]
            if blanks[0] != blanks[1]:
                return group
    raise RuntimeError("no same-agent conflicting pair found")


def find_status_disagreement(rows: list[dict]) -> list[dict]:
    """F7: two agents, same (service, timestamp), different status_code."""
    by_point: dict[tuple, list[dict]] = {}
    for r in rows:
        by_point.setdefault((r["service_id"], r["_utc"]), []).append(r)
    for key, group in by_point.items():
        codes = {r["status_code"] for r in group}
        if len(codes) >= 2 and len({r["agent"] for r in group}) >= 2:
            return group
    raise RuntimeError("no cross-agent status disagreement found")


def main() -> None:
    rows_9d = load("monitoring_checks_9d_seed101.csv")
    rows_14d = load("monitoring_checks_14d_seed202.csv")

    picks: list[Pick] = []

    picks.append(Pick(find_full_day(rows_9d, "svc-reports", "2025-05-13"),
                       "F11", "svc-reports full UTC day 2025-05-13 — the 9d brownout incident, plus its normal traffic"))
    picks.append(Pick(find_exact_duplicate(rows_9d), "F5", "exact duplicate row pair"))
    picks.append(Pick([find_status(rows_9d, "999")], "F8", "status 999, unclassifiable"))
    picks.append(Pick([find_negative_latency(rows_9d)], "F9", "negative latency"))
    picks.append(Pick([find_blank_latency(rows_9d)], "F10", "blank latency on a status-200 row"))
    picks.append(Pick(find_two_agent_point(rows_9d), "F4", "same check-point reported by both agents"))
    picks.append(Pick([find_date_shifted_offset(rows_9d)], "F3", "+05:30 row whose local date differs from its UTC date"))
    picks.append(Pick([find_seconds_unit_row(rows_9d)], "F1", "latency recorded in seconds rather than ms"))
    picks.append(Pick(find_same_agent_conflict(rows_14d), "F6", "same agent, same check-point, latency present once"))
    picks.append(Pick(find_status_disagreement(rows_14d), "F7", "two agents disagree on status_code for one check-point"))

    selected: list[dict] = []
    selected_ids: set[tuple] = set()

    def add(rows: list[dict]):
        for r in rows:
            key = (r["_source"], r["timestamp"], r["service_id"], r["agent"], r["status_code"], r["latency"])
            if key not in selected_ids:
                selected_ids.add(key)
                selected.append(r)

    for pick in picks:
        add(pick.rows)

    epoch_row = find_epoch_row(rows_9d, exclude=set())
    add([epoch_row])

    mandatory_count = len(selected)
    remaining_slots = max(TARGET_ROWS - mandatory_count, 0)

    rng = random.Random(SEED)
    already = {(r["_source"], r["timestamp"], r["service_id"], r["agent"]) for r in selected}
    pool = [r for r in rows_9d if (r["_source"], r["timestamp"], r["service_id"], r["agent"]) not in already]
    rng.shuffle(pool)
    filler = pool[:remaining_slots]
    add(filler)

    selected.sort(key=lambda r: (r["_utc"], r["service_id"], r["agent"]))

    out_csv = ROOT / "fixtures" / "dev_checks.csv"
    with out_csv.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        for r in selected:
            writer.writerow({k: r[k] for k in FIELDS})

    manifest_lines = [
        "# Dev fixture manifest",
        "",
        f"Derived by `scripts/build_dev_fixture.py` (seed {SEED}) from the real datasets.",
        f"Never hand-typed. {len(selected)} rows total, {mandatory_count} chosen for a specific",
        "finding class plus one plain epoch-format row, the rest a deterministic random sample",
        "of ordinary 9d rows for volume and service/day spread.",
        "",
        "| Finding | What it covers | Source |",
        "|---|---|---|",
    ]
    for pick in picks:
        source = pick.rows[0]["_source"]
        manifest_lines.append(f"| {pick.finding} | {pick.note} | {source} |")
    manifest_lines.append(f"| F2 | plain 10-digit epoch timestamp | {epoch_row['_source']} |")
    manifest_lines.append("")
    manifest_lines.append(
        "Re-run with `python3 scripts/build_dev_fixture.py` any time the source CSVs or the "
        "selection logic change; the output is deterministic given the same seed."
    )

    out_md = ROOT / "fixtures" / "dev_checks.md"
    out_md.write_text("\n".join(manifest_lines) + "\n")

    print(f"wrote {len(selected)} rows to {out_csv}")
    print(f"wrote manifest to {out_md}")


if __name__ == "__main__":
    main()
