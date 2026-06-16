#!/usr/bin/env python3
"""Aggregate independent result files → stats.json (incremental)"""
import json, os, re, time, subprocess

STATS_FILE = 'stats.json'
CURSOR_FILE = 'last_aggregation.txt'

# Read cursor (last aggregation timestamp, seconds since epoch)
cursor = 0
if os.path.exists(CURSOR_FILE):
    with open(CURSOR_FILE) as f:
        cursor = int(f.read().strip() or 0)

# Read existing stats as base (preserves historical data)
stats = {"total": 0, "results": {}}
if os.path.exists(STATS_FILE):
    with open(STATS_FILE) as f:
        stats = json.load(f)
print(f"Base stats: total={stats.get('total',0)}, personalities={len(stats.get('results',{}))}")

# Find new result files using git log (commit timestamps, not checkout time)
cursor_time = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(cursor)) if cursor else '1970-01-01T00:00:00'
print(f"Cursor time: {cursor_time}")

cmd = ['git', 'log', '--diff-filter=A', f'--since={cursor_time}', '--name-only', '--pretty=format:', '--', 'results/']
result = subprocess.run(cmd, capture_output=True, text=True)

# Parse personality code from filename: results/.../ts_rand_CODE.json
pattern = re.compile(r'.*_([A-Z0-9!]+)\.json$')
new_counts = {}
new_files_processed = 0

for line in result.stdout.strip().split('\n'):
    line = line.strip()
    if not line or not line.endswith('.json'):
        continue
    match = pattern.match(os.path.basename(line))
    if not match:
        continue
    code = match.group(1)
    new_counts[code] = new_counts.get(code, 0) + 1
    new_files_processed += 1

print(f"New files found: {new_files_processed}")
print(f"New counts: {new_counts}")

# Aggregate into stats
for code, count in new_counts.items():
    stats["total"] = stats.get("total", 0) + count
    stats["results"][code] = stats["results"].get(code, 0) + count

# Write updated stats
with open(STATS_FILE, 'w') as f:
    json.dump(stats, f, ensure_ascii=False)

# Update cursor
new_cursor = int(time.time())
with open(CURSOR_FILE, 'w') as f:
    f.write(str(new_cursor))

print(f"Aggregated: +{new_files_processed} files, total: {stats['total']}")