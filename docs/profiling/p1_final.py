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

out = []
for path in files:
    name = os.path.basename(path)
    pts = collections.defaultdict(list)
    copies = collections.Counter()
    exact = collections.Counter()
    blank_pts = 0; blank_recoverable = 0
    lat_on_5xx = []; lat_on_200 = []
    per_sd_bad = collections.Counter()      # (sid, utc date) -> bad points
    per_sd_total = collections.Counter()
    with open(path, newline='') as fh:
        r = csv.reader(fh); next(r)
        for row in r:
            d = dict(zip(HDR, row))
            u = parse(d['timestamp'])
            sid = d['service_id'].strip(); sc = d['status_code'].strip()
            lv = d['latency'].strip()
            lat = None
            if lv != '':
                v = float(lv)
                lat = v * 1000.0 if d['latency_unit'].strip() == 's' else v
                (lat_on_5xx if sc.startswith('5') else lat_on_200).append(lat)
            exact[','.join(row)] += 1
            pts[(sid, u)].append((sc, lat, d['agent'].strip()))
    for k, v in pts.items():
        copies[len(v)] += 1
        sid, u = k
        per_sd_total[(sid, u.date())] += 1
        if any(sc != '200' for sc, _, _ in v): per_sd_bad[(sid, u.date())] += 1
        if any(l is None for _, l, _ in v):
            blank_pts += 1
            if any(l is not None for _, l, _ in v): blank_recoverable += 1
    exact_dup_status = collections.Counter(line.split(',')[3] for line, n in exact.items() if n > 1)
    # worst single service-day
    worst = sorted(((per_sd_bad[k] / per_sd_total[k], k) for k in per_sd_total), reverse=True)[:3]
    days = sorted({k[1] for k in per_sd_total})
    out.append(dict(file=name,
        reports_per_point=dict(copies),
        blank_latency_points=blank_pts, blank_recoverable_from_partner=blank_recoverable,
        exact_dup_by_status=dict(exact_dup_status),
        lat_mean_on_5xx=round(statistics.mean(lat_on_5xx), 1) if lat_on_5xx else None,
        lat_mean_on_200=round(statistics.mean(lat_on_200), 1),
        n_days=len(days), first_day=str(days[0]), last_day=str(days[-1]),
        worst_service_days=[f"{k[0]} {k[1]} down={round(100*f,2)}%" for f, k in worst],
        one_point_of_96_pp=round(100/96, 3)))
print(json.dumps(out, indent=1))

# targeted check: the 9d seeded incident window
print('--- 9d svc-reports 2025-05-13 15:30-18:00 UTC ---')
with open('/Users/watermalone/Documents/earthre/monitoring_checks_9d_seed101.csv', newline='') as fh:
    r = csv.reader(fh); next(r)
    for row in r:
        d = dict(zip(HDR, row))
        if d['service_id'].strip() != 'svc-reports': continue
        u = parse(d['timestamp'])
        if u.date().isoformat() == '2025-05-13' and dt.time(15, 30) <= u.time() <= dt.time(18, 0):
            print(f"  {u.isoformat()} {d['status_code']:>4} {d['latency']:>8}{d['latency_unit']:<3} {d['agent']}")
