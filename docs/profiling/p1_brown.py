import csv, glob, os, re, collections, json, datetime as dt

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

for path in files:
    slow_by_status = collections.Counter()
    slow_service_day = collections.Counter()
    buckets = collections.Counter()
    n = 0
    with open(path, newline='') as fh:
        r = csv.reader(fh); next(r)
        for row in r:
            d = dict(zip(HDR, row))
            lv = d['latency'].strip()
            if lv == '': continue
            v = float(lv)
            lat = v * 1000.0 if d['latency_unit'].strip() == 's' else v
            n += 1
            if lat > 1000: buckets['>1000ms'] += 1
            if lat > 1500: buckets['>1500ms'] += 1
            if lat > 2000: buckets['>2000ms'] += 1
            if lat > 1500:
                slow_by_status[d['status_code'].strip()] += 1
                slow_service_day[f"{d['service_id'].strip()} {parse(d['timestamp']).date()}"] += 1
    print(f"== {os.path.basename(path)}  n_with_latency={n}")
    print(f"  buckets: {dict(buckets)}")
    print(f"  >1500ms by status: {dict(slow_by_status)}")
    print(f"  >1500ms clustered: {dict(slow_service_day.most_common(4))}")
