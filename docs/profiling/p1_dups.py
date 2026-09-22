import csv, glob, os, re, collections, json, datetime as dt, statistics

files = sorted(glob.glob('/Users/watermalone/Documents/earthre/monitoring_checks_*.csv'))
HDR = ['service_id','service_name','timestamp','status_code','latency','latency_unit','agent','region']
G = dt.timedelta(minutes=15)

def parse(t, offset_mode='convert'):
    t = t.strip()
    if t.endswith('Z'):
        return dt.datetime.strptime(t, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)
    m = re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{2}):(\d{2})', t)
    if m:
        naive = dt.datetime.strptime(m.group(1), '%Y-%m-%dT%H:%M:%S').replace(tzinfo=dt.timezone.utc)
        if offset_mode == 'ignore':
            return naive
        sign = 1 if m.group(2)[0] == '+' else -1
        return naive - sign * dt.timedelta(hours=abs(int(m.group(2))), minutes=int(m.group(3)))
    return dt.datetime.fromtimestamp(int(t), dt.timezone.utc)

def ms(lat, unit):
    if lat.strip() == '': return None
    v = float(lat)
    return v * 1000.0 if unit.strip() == 's' else v

out = []
for path in files:
    name = os.path.basename(path)
    raw = collections.Counter()
    recs = collections.defaultdict(list)     # (sid, utc) -> list of dicts
    same_agent = collections.defaultdict(list)
    ws_fields = collections.Counter()
    case_vals = collections.Counter()
    unit_suspect = collections.Counter()
    blank_by_status = collections.Counter()
    lat_by_agent = collections.defaultdict(list)
    extreme = []
    sentinel_rows, neg_rows = [], []
    grid_ignore = collections.defaultdict(set)
    with open(path, newline='') as fh:
        r = csv.reader(fh); next(r)
        for row in r:
            raw[','.join(row)] += 1
            d = dict(zip(HDR, row))
            for c in HDR:
                if d[c] != d[c].strip() and d[c].strip() != '': ws_fields[c] += 1
            for c in ('service_id','service_name','agent','region','latency_unit'):
                if d[c].strip() != d[c].strip().lower(): case_vals[f'{c}:{d[c].strip()}'] += 1
            sid, a, sc = d['service_id'].strip(), d['agent'].strip(), d['status_code'].strip()
            u = parse(d['timestamp'])
            grid_ignore[sid].add(parse(d['timestamp'], 'ignore'))
            lat = ms(d['latency'], d['latency_unit'])
            if d['latency'].strip() == '': blank_by_status[sc] += 1
            if lat is not None:
                if d['latency_unit'].strip() == 'ms' and lat < 10: unit_suspect['ms_lt_10'] += 1
                if d['latency_unit'].strip() == 's' and lat > 100000: unit_suspect['s_gt_100s'] += 1
                lat_by_agent[a].append(lat)
                if lat < 0: neg_rows.append(','.join(row))
                elif lat > 5000: extreme.append(','.join(row))
            if sc == '999': sentinel_rows.append(','.join(row))
            rec = dict(sc=sc, lat=lat, a=a, ts=d['timestamp'].strip())
            recs[(sid, u)].append(rec)
            same_agent[(sid, u, a)].append(rec)

    # counterfactual: parse +05:30 rows as if already UTC -> how many grid holes appear?
    lo = min(k[1] for k in recs); hi = max(k[1] for k in recs)
    holes_ignore = 0
    for sid, s in grid_ignore.items():
        cur = lo
        while cur <= hi:
            if cur not in s: holes_ignore += 1
            cur += G

    multi = {k: v for k, v in recs.items() if len(v) > 1}
    both_agents = {k: v for k, v in multi.items() if len({r['a'] for r in v}) > 1}
    status_disagree = sum(1 for v in both_agents.values() if len({r['sc'] for r in v}) > 1)
    dis_examples = []
    for k, v in both_agents.items():
        if len({r['sc'] for r in v}) > 1 and len(dis_examples) < 3:
            dis_examples.append(f"{k[0]} @ {k[1].isoformat()} -> " + ' | '.join(f"{r['a']}:{r['sc']}/{r['lat']}" for r in v))
    deltas = [abs(v[0]['lat'] - v[1]['lat']) for v in both_agents.values()
              if len(v) == 2 and v[0]['lat'] is not None and v[1]['lat'] is not None]
    sa_conflict = {k: v for k, v in same_agent.items() if len(v) > 1 and
                   len({(r['sc'], r['lat']) for r in v}) > 1}
    sa_examples = [f"{k[0]} @ {k[1].isoformat()} {k[2]} -> " + ' | '.join(f"{r['sc']}/{r['lat']}/{r['ts']}" for r in v)
                   for k, v in list(sa_conflict.items())[:3]]
    out.append(dict(file=name,
        exact_dup_groups=sum(1 for n in raw.values() if n > 1),
        exact_dup_extra_rows=sum(n - 1 for n in raw.values() if n > 1),
        max_copies=max(raw.values()),
        holes_if_offset_ignored=holes_ignore,
        multi_report_points=len(multi), both_agent_points=len(both_agents),
        status_disagreements=status_disagree, status_disagree_examples=dis_examples,
        latency_delta_median_ms=round(statistics.median(deltas), 1) if deltas else None,
        latency_delta_p95_ms=round(sorted(deltas)[int(len(deltas) * 0.95)], 1) if deltas else None,
        same_agent_conflicts=len(sa_conflict), same_agent_examples=sa_examples,
        agent_latency_mean_ms={a: round(statistics.mean(v), 1) for a, v in lat_by_agent.items()},
        agent_latency_median_ms={a: round(statistics.median(v), 1) for a, v in lat_by_agent.items()},
        whitespace_padded=dict(ws_fields), case_drift=dict(case_vals),
        unit_suspect=dict(unit_suspect), blank_latency_by_status=dict(blank_by_status),
        sentinel_999=sentinel_rows, negative_latency=neg_rows,
        latency_over_5000ms=len(extreme), latency_over_5000ms_examples=extreme[:3]))
print(json.dumps(out, indent=1))
