import csv, glob, os, re, collections, json, datetime as dt, statistics

files = sorted(glob.glob('/Users/watermalone/Documents/earthre/monitoring_checks_*.csv'))
HDR = ['service_id','service_name','timestamp','status_code','latency','latency_unit','agent','region']

def parse(t):
    t = t.strip()
    if t.endswith('Z'):
        return dt.datetime.strptime(t, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)
    m = re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{2}):(\d{2})', t)
    if m:
        naive = dt.datetime.strptime(m.group(1), '%Y-%m-%dT%H:%M:%S').replace(tzinfo=dt.timezone.utc)
        sign = 1 if m.group(2)[0] == '+' else -1
        return naive - sign * dt.timedelta(hours=abs(int(m.group(2))), minutes=int(m.group(3)))
    return dt.datetime.fromtimestamp(int(t), dt.timezone.utc)

def local_date_str(t):
    """Calendar date as written in the raw string, before any conversion."""
    t = t.strip()
    if re.fullmatch(r'\d{9,13}', t): return None
    return t[:10]

out = []
for path in files:
    name = os.path.basename(path)
    pts = collections.defaultdict(list)          # (sid, utc) -> [(status, lat_ms)]
    raw_rows = []
    date_shifted = 0
    nz_raw = 0
    lat_raw_ignoring_unit = []
    lat_ms_true = []
    dup_on_5xx = 0
    with open(path, newline='') as fh:
        r = csv.reader(fh); next(r)
        for row in r:
            d = dict(zip(HDR, row))
            u = parse(d['timestamp'])
            sid = d['service_id'].strip(); sc = d['status_code'].strip()
            ld = local_date_str(d['timestamp'])
            if ld is not None and ld != u.date().isoformat(): date_shifted += 1
            lv = d['latency'].strip()
            lat = None
            if lv != '':
                v = float(lv)
                lat_raw_ignoring_unit.append(v)
                lat = v * 1000.0 if d['latency_unit'].strip() == 's' else v
                lat_ms_true.append(lat)
            if sc != '200': nz_raw += 1
            raw_rows.append(sc)
            pts[(sid, u)].append((sc, lat))

    total_pts = len(pts)
    # availability under four readings
    def avail(rule):
        ok = 0
        for v in pts.values():
            codes = [sc for sc, _ in v]
            if rule == 'any_bad_down':
                ok += all(sc == '200' for sc in codes)
            elif rule == 'any_bad_down_999_up':
                ok += all(sc == '200' or sc == '999' for sc in codes)
            elif rule == 'first_wins':
                ok += codes[0] == '200'
            elif rule == 'first_wins_999_up':
                ok += codes[0] in ('200', '999')
        return round(100.0 * ok / total_pts, 4)

    avail_raw_rowwise = round(100.0 * sum(1 for sc in raw_rows if sc == '200') / len(raw_rows), 4)
    # 5xx / non-200 counts
    bad_pts = {k: v for k, v in pts.items() if any(sc != '200' for sc, _ in v)}
    bad_codes = collections.Counter(sc for v in pts.values() for sc, _ in v if sc != '200')
    dup_bad = sum(1 for k, v in bad_pts.items() if len(v) > 1)
    # incident runs: contiguous non-200 grid points per service
    runs = collections.defaultdict(list)
    for sid in {k[0] for k in pts}:
        ts = sorted(k[1] for k in pts if k[0] == sid)
        cur = None
        for t in ts:
            down = any(sc != '200' for sc, _ in pts[(sid, t)])
            if down:
                if cur and t - cur[1] == dt.timedelta(minutes=15):
                    cur = (cur[0], t, cur[2] + 1)
                else:
                    if cur: runs[sid].append(cur)
                    cur = (t, t, 1)
        if cur: runs[sid].append(cur)
    long_runs = {sid: [f"{a.isoformat()}..{b.isoformat()} n={n}" for a, b, n in v if n >= 4]
                 for sid, v in runs.items()}
    long_runs = {k: v for k, v in long_runs.items() if v}
    isolated = sum(1 for v in runs.values() for a, b, n in v if n < 4)

    out.append(dict(file=name, grid_points=total_pts,
        avail_rowwise_raw=avail_raw_rowwise,
        avail_dedup_any_bad_down=avail('any_bad_down'),
        avail_dedup_999_treated_up=avail('any_bad_down_999_up'),
        avail_first_wins=avail('first_wins'),
        avail_first_wins_999_up=avail('first_wins_999_up'),
        nonzero_codes=dict(bad_codes), bad_points=len(bad_pts), bad_points_duplicated=dup_bad,
        date_shifted_rows=date_shifted,
        latency_mean_unit_ignored=round(statistics.mean(lat_raw_ignoring_unit), 2),
        latency_mean_ms_correct=round(statistics.mean(lat_ms_true), 2),
        latency_p95_ms_correct=round(sorted(lat_ms_true)[int(len(lat_ms_true) * 0.95)], 1),
        incident_runs_ge_4=long_runs, isolated_bad_runs=isolated))
print(json.dumps(out, indent=1))
