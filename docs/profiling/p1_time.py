import csv, glob, os, re, collections, json, datetime as dt

files = sorted(glob.glob('/Users/watermalone/Documents/earthre/monitoring_checks_*.csv'))
HDR = ['service_id','service_name','timestamp','status_code','latency','latency_unit','agent','region']

def parse(t):
    """Return (utc_datetime, fmt_class, naive_local_datetime_or_None)."""
    t = t.strip()
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', t):
        return dt.datetime.strptime(t, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc), 'iso_Z', None
    m = re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{2}):(\d{2})', t)
    if m:
        naive = dt.datetime.strptime(m.group(1), '%Y-%m-%dT%H:%M:%S')
        off = dt.timedelta(hours=int(m.group(2)), minutes=int(m.group(3)) * (1 if m.group(2)[0] == '+' else -1))
        return naive.replace(tzinfo=dt.timezone.utc) - off, 'iso_offset', naive
    if re.fullmatch(r'\d{9,13}', t):
        v = int(t)
        unit = 'epoch_s' if len(t) <= 10 else 'epoch_ms'
        if unit == 'epoch_ms': v //= 1000
        return dt.datetime.fromtimestamp(v, dt.timezone.utc), unit, None
    return None, 'UNPARSED', None

out = []
for path in files:
    name = os.path.basename(path)
    agent_x_fmt = collections.Counter()
    agent_x_unit = collections.Counter()
    agent_x_blanklat = collections.Counter()
    agent_x_status999 = collections.Counter()
    agent_x_neglat = collections.Counter()
    minute_off_grid = collections.Counter()
    epoch_units = collections.Counter()
    seen_exact = collections.Counter()          # whole raw line
    key_sa = collections.Counter()              # (sid, utc, agent)
    key_s = collections.Counter()               # (sid, utc)
    by_service_utc = collections.defaultdict(set)
    agent1_keys = set()
    off_rows_utc = []                           # +05:30 rows: converted utc
    off_rows_naive = []                         # same rows read as if already utc
    lo = hi = None
    rows = 0
    with open(path, newline='') as fh:
        r = csv.reader(fh); next(r)
        for row in r:
            rows += 1
            d = dict(zip(HDR, row))
            a = d['agent'].strip(); sid = d['service_id'].strip()
            u, fmt, naive = parse(d['timestamp'])
            agent_x_fmt[(a, fmt)] += 1
            agent_x_unit[(a, d['latency_unit'].strip())] += 1
            if d['latency'].strip() == '': agent_x_blanklat[a] += 1
            if d['status_code'].strip() == '999': agent_x_status999[a] += 1
            try:
                if float(d['latency']) < 0: agent_x_neglat[a] += 1
            except ValueError: pass
            if fmt.startswith('epoch'): epoch_units[fmt] += 1
            if u is None: continue
            if u.minute % 15 or u.second: minute_off_grid[(a, fmt)] += 1
            lo = u if lo is None or u < lo else lo
            hi = u if hi is None or u > hi else hi
            seen_exact[','.join(row)] += 1
            key_sa[(sid, u, a)] += 1
            key_s[(sid, u)] += 1
            by_service_utc[sid].add(u)
            if a == 'agent-1': agent1_keys.add((sid, u))
            if fmt == 'iso_offset':
                off_rows_utc.append((sid, u))
                off_rows_naive.append((sid, naive.replace(tzinfo=dt.timezone.utc)))
    dup_exact = sum(n - 1 for n in seen_exact.values() if n > 1)
    dup_exact_groups = sum(1 for n in seen_exact.values() if n > 1)
    dup_sa = sum(n - 1 for n in key_sa.values() if n > 1)
    dup_s = sum(n - 1 for n in key_s.values() if n > 1)
    # grid coverage per service over [lo, hi]
    gaps = {}
    for sid, s in by_service_utc.items():
        cur = lo; missing = 0; total = 0
        while cur <= hi:
            total += 1
            if cur not in s: missing += 1
            cur += dt.timedelta(minutes=15)
        gaps[sid] = dict(expected=total, missing=missing, distinct=len(s))
    # which reading of the +05:30 rows collides with agent-1's grid?
    hit_utc = sum(1 for k in off_rows_utc if k in agent1_keys)
    hit_naive = sum(1 for k in off_rows_naive if k in agent1_keys)
    out.append(dict(file=name, rows=rows,
                    utc_lo=lo.isoformat(), utc_hi=hi.isoformat(),
                    span_days=round((hi - lo).total_seconds() / 86400, 2),
                    epoch_units=dict(epoch_units),
                    agent_x_fmt={f'{a}|{f}': n for (a, f), n in sorted(agent_x_fmt.items())},
                    agent_x_unit={f'{a}|{u}': n for (a, u), n in sorted(agent_x_unit.items())},
                    agent_x_blanklat=dict(agent_x_blanklat),
                    agent_x_999=dict(agent_x_status999),
                    agent_x_neglat=dict(agent_x_neglat),
                    off_grid={f'{a}|{f}': n for (a, f), n in sorted(minute_off_grid.items())},
                    dup_exact_rows=dup_exact, dup_exact_groups=dup_exact_groups,
                    dup_service_ts_agent=dup_sa, dup_service_ts=dup_s,
                    offset_rows=len(off_rows_utc),
                    offset_collides_as_utc=hit_utc, offset_collides_stripped=hit_naive,
                    gaps=gaps))
print(json.dumps(out, indent=1))
