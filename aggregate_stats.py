#!/usr/bin/env python3
"""全量重算 stats.json

以 results 分支的文件列表为唯一事实来源：每次从头数一遍，幂等。
旧的增量方案（git log --since + 游标）会重复计入边界提交，导致统计虚高。

输出结构：
  {"total": N, "results": {CODE: n, ...}, "langs": {"zh": n, "ja": n}}
（不含时间戳：数据没变时文件内容不变，避免产生空提交）
"""
import collections
import json
import os
import re
import subprocess
import time

STATS_FILE = 'stats.json'
CURSOR_FILE = 'last_aggregation.txt'
BRANCH = 'origin/results'
PATTERN = re.compile(r'_([A-Z0-9!]+)\.json$')


def git(*args):
    return subprocess.run(['git', *args], capture_output=True, check=True).stdout


def list_records():
    """列出 results 分支上的所有记录文件 → [(path, blob_sha), ...]"""
    out = git('ls-tree', '-r', BRANCH, '--', 'results/').decode('utf-8', 'replace')
    entries = []
    for line in out.splitlines():
        if not line.strip():
            continue
        meta, path = line.split('\t', 1)
        if not path.endswith('.json'):
            continue
        parts = meta.split()
        if len(parts) < 3 or parts[1] != 'blob':
            continue
        entries.append((path, parts[2]))
    return entries


def count_langs(shas):
    """一次 cat-file --batch 批量读取所有记录内容，统计 lang 字段"""
    langs = collections.Counter()
    if not shas:
        return langs
    proc = subprocess.run(
        ['git', 'cat-file', '--batch'],
        input='\n'.join(shas).encode(),
        capture_output=True,
        check=True,
    )
    raw = proc.stdout
    pos = 0
    while pos < len(raw):
        nl = raw.find(b'\n', pos)
        if nl < 0:
            break
        header = raw[pos:nl].decode('utf-8', 'replace').split()
        pos = nl + 1
        if len(header) < 3:
            continue
        try:
            size = int(header[2])
        except ValueError:
            continue
        blob = raw[pos:pos + size]
        pos += size + 1  # 内容后跟一个换行
        try:
            body = json.loads(blob.decode('utf-8', 'replace'))
        except Exception:
            continue
        langs[str(body.get('lang') or 'unknown')] += 1
    return langs


def main():
    entries = list_records()

    counts = collections.Counter()
    for path, _ in entries:
        m = PATTERN.search(os.path.basename(path))
        if m:
            counts[m.group(1)] += 1

    langs = count_langs([sha for _, sha in entries])

    stats = {
        'total': sum(counts.values()),
        'results': dict(sorted(counts.items(), key=lambda kv: -kv[1])),
        'langs': dict(sorted(langs.items(), key=lambda kv: -kv[1])),
    }

    # 语义比较后再决定要不要写文件：
    # Worker 写的 JSON 与这里的 key 顺序不同（JS 会把 "3776" 这类数字键排在最前），
    # 只比文本会每天误判为"有变化"，与 Worker 来回提交打架。
    existing = None
    try:
        with open(STATS_FILE, encoding='utf-8') as f:
            existing = json.load(f)
    except Exception:
        existing = None

    new_text = json.dumps(stats, ensure_ascii=False, separators=(',', ':'))

    if existing == stats:
        print('统计无变化（语义一致），不写文件')
        with open(CURSOR_FILE, 'w') as f:
            f.write(str(int(time.time())))
        return

    with open(STATS_FILE, 'w', encoding='utf-8') as f:
        f.write(new_text)

    # 游标文件仅保留给人工排查，聚合本身不再依赖它
    with open(CURSOR_FILE, 'w') as f:
        f.write(str(int(time.time())))

    print(f"files={len(entries)} total={stats['total']} "
          f"types={len(counts)} langs={dict(langs)}")
    print('top5:', list(stats['results'].items())[:5])


if __name__ == '__main__':
    main()