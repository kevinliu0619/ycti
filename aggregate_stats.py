#!/usr/bin/env python3
"""Aggregate new result files → stats.json (incremental via git log --since)"""
import json, os, re, subprocess, time

STATS_FILE = 'stats.json'
CURSOR_FILE = 'last_aggregation.txt'

# Read cursor (last aggregation timestamp, seconds since epoch)
cursor = 0
if os.path.exists(CURSOR_FILE):
    with open(CURSOR_FILE) as f:
        cursor = int(f.read().strip() or 0)

# Read existing stats as base
stats = {"total": 0, "results": {}}
if os.path.exists(STATS_FILE):
    with open(STATS_FILE) as f:
        stats = json.load(f)
print(f"Base: total={stats.get('total',0)}, types={len(stats.get('results',{}))}")

# Find new result files since cursor using git log (NO --diff-filter=A)
cursor_time = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(cursor)) if cursor else '2026-06-01T00:00:00'
print(f"Cursor: {cursor_time}")

# git log --name-only --since=... -- results/  (without --diff-filter=A which breaks with --since)
cmd = ['git', 'log', f'--since={cursor_time}', '--name-only', '--pretty=format:', 'origin/results', '--', 'results/']
result = subprocess.run(cmd, capture_output=True, text=True)

pattern = re.compile(r'.*_([A-Z0-9!]+)\.json$')
new_counts = {}
new_files = 0

for line in result.stdout.strip().split('\n'):
    line = line.strip()
    if not line or not line.endswith('.json'):
        continue
    match = pattern.match(os.path.basename(line))
    if not match:
        continue
    code = match.group(1)
    new_counts[code] = new_counts.get(code, 0) + 1
    new_files += 1

print(f"New files: {new_files}")
print(f"New counts: {new_counts}")

# Merge
for code, count in new_counts.items():
    stats["total"] = stats.get("total", 0) + count
    stats["results"][code] = stats["results"].get(code, 0) + count

# Write
with open(STATS_FILE, 'w') as f:
    json.dump(stats, f, ensure_ascii=False)

new_cursor = int(time.time())
with open(CURSOR_FILE, 'w') as f:
    f.write(str(new_cursor))

print(f"Done: +{new_files}, total={stats['total']}")