import csv, glob, os, re, collections, datetime as dt
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

per_file = {}
for path in files:
    pts = {}
    with open(path, newline='') as fh:
        r = csv.reader(fh); next(r)
        for row in r:
            d = dict(zip(HDR, row))
            pts[(d['service_id'].strip(), parse(d['timestamp']))] = d['status_code'].strip()
    per_file[os.path.basename(path)] = pts

names = list(per_file)
for i in range(len(names)):
    for j in range(i + 1, len(names)):
        a, b = per_file[names[i]], per_file[names[j]]
        common = set(a) & set(b)
        if not common: continue
        disagree = sum(1 for k in common if a[k] != b[k])
        print(f"{names[i]} vs {names[j]}: shared_points={len(common)} status_disagree={disagree}")
