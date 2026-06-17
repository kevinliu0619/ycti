#!/usr/bin/env python3
"""Aggregate independent result files → stats.json (filesystem scan, no git dependency)"""
import json, os, re, time

STATS_FILE = 'stats.json'
CURSOR_FILE = 'last_aggregation.txt'
RESULTS_DIR = 'results'

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

# Scan filesystem for new result files (modified after cursor)
pattern = re.compile(r'.*_([A-Z0-9!]+)\.json$')
new_counts = {}
new_files = 0

if os.path.isdir(RESULTS_DIR):
    for root, dirs, files in os.walk(RESULTS_DIR):
        for fname in files:
            if not fname.endswith('.json'):
                continue
            fpath = os.path.join(root, fname)
            mtime = os.path.getmtime(fpath)
            if mtime <= cursor:
                continue
            match = pattern.match(fname)
            if not match:
                continue
            code = match.group(1)
            new_counts[code] = new_counts.get(code, 0) + 1
            new_files += 1

print(f"New files found: {new_files}")
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

print(f"Aggregated: +{new_files} files, total: {stats['total']}")