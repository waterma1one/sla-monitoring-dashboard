import csv, glob, os, re, collections, json

files = sorted(glob.glob('/Users/watermalone/Documents/earthre/monitoring_checks_*.csv'))
HDR = ['service_id','service_name','timestamp','status_code','latency','latency_unit','agent','region']

def ts_class(s):
    t = s.strip()
    if t == '': return 'EMPTY'
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', t): return 'iso_Z'
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\+|-)\d{2}:\d{2}', t): return 'iso_offset_' + t[19:]
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}', t): return 'iso_naive'
    if re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}', t): return 'space_naive'
    if re.fullmatch(r'\d{9,13}', t): return 'epoch'
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', t): return 'date_only'
    if re.fullmatch(r'\d{2}/\d{2}/\d{4}.*', t): return 'us_slash'
    return 'OTHER:' + t[:30]

out = []
for path in files:
    name = os.path.basename(path)
    rows = 0
    badlen = collections.Counter()
    blank = collections.Counter()      # empty or whitespace-only per column
    vals = {c: collections.Counter() for c in ['service_id','service_name','latency_unit','status_code','agent','region']}
    tsc = collections.Counter()
    pair_sid_sname = collections.Counter()
    pair_agent_region = collections.Counter()
    lat_bad = collections.Counter()
    lat_stats = {}   # unit -> [min,max,count,sum]
    with open(path, newline='') as fh:
        r = csv.reader(fh)
        hdr = next(r)
        hdr_ok = (hdr == HDR)
        for row in r:
            rows += 1
            if len(row) != 8:
                badlen[len(row)] += 1
                continue
            d = dict(zip(HDR, row))
            for c in HDR:
                if d[c].strip() == '':
                    blank[c] += 1
            for c in vals:
                vals[c][d[c].strip()] += 1
            tsc[ts_class(d['timestamp'])] += 1
            pair_sid_sname[(d['service_id'].strip(), d['service_name'].strip())] += 1
            pair_agent_region[(d['agent'].strip(), d['region'].strip())] += 1
            lv = d['latency'].strip()
            u = d['latency_unit'].strip()
            if lv == '':
                lat_bad['empty'] += 1
            else:
                try:
                    f = float(lv)
                except ValueError:
                    lat_bad['nonnumeric:' + lv[:20]] += 1
                else:
                    if f < 0: lat_bad['negative'] += 1
                    elif f == 0: lat_bad['zero'] += 1
                    s = lat_stats.setdefault(u, [f, f, 0, 0.0])
                    s[0] = min(s[0], f); s[1] = max(s[1], f); s[2] += 1; s[3] += f
    out.append(dict(file=name, rows=rows, hdr_ok=hdr_ok,
                    badlen=dict(badlen), blank=dict(blank),
                    ts_classes=dict(tsc),
                    service_ids=dict(vals['service_id']),
                    service_names=dict(vals['service_name']),
                    sid_sname_pairs={f'{a}|{b}': n for (a, b), n in sorted(pair_sid_sname.items())},
                    latency_unit=dict(vals['latency_unit']),
                    status_code=dict(sorted(vals['status_code'].items(), key=lambda kv: kv[0])),
                    agents=dict(vals['agent']),
                    regions=dict(vals['region']),
                    agent_region_pairs={f'{a}|{b}': n for (a, b), n in sorted(pair_agent_region.items())},
                    latency_bad=dict(lat_bad),
                    latency_by_unit={u: dict(min=s[0], max=s[1], n=s[2], mean=round(s[3]/s[2], 1)) for u, s in lat_stats.items()}))

print(json.dumps(out, indent=1))
