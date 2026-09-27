"""Read-only metrics diagnostics; run with the Python environment that has Aim installed.

Usage: python troubleshooting/probe_metrics_readonly.py ~/map-gen/.aim
Never constructs Repo or invokes optimization, recovery, reindexing, or tracking.
JSON goes to stdout. All database handles are explicitly closed.
"""

import argparse
import collections
import gc
import json
import os
from pathlib import Path
import resource
import sqlite3
import time

import numpy as np
from aim.sdk.sequence import SequenceV2Data
from aim.storage.rockscontainer import RocksContainer


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('repo', type=Path)
parser.add_argument('--check-fd-limit', type=int, help='Also test retained metadata readers under this temporary soft limit')
args = parser.parse_args()
ROOT = args.repo.expanduser().resolve()


def fd_count():
    return len(os.listdir('/proc/self/fd'))


def open_db(path):
    return RocksContainer(str(path), read_only=True, skip_read_optimization=True)


def check_fd_limit(limit):
    original = resource.getrlimit(resource.RLIMIT_NOFILE)
    held = []
    reserved = []
    result = {'soft_limit': limit, 'reserved_server_overhead_fds': 8}
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (limit, original[1]))
        reserved = [open('/dev/null', 'rb') for _ in range(8)]
        paths = [ROOT / 'meta/index', *sorted((ROOT / 'meta/chunks').iterdir())]
        for path in paths:
            try:
                container = open_db(path)
                held.append(container)
                iterator = container.db.iteritems()
                iterator.seek_to_first()
                next(iterator, None)
                del iterator
            except Exception as exc:
                result['error'] = str(exc)
                break
        result['opened_databases'] = len(held)
    finally:
        resource.setrlimit(resource.RLIMIT_NOFILE, original)
        for container in held:
            container.close()
        for file in reserved:
            file.close()
    return result


def main():
    report = {'repo': str(ROOT), 'nofile': resource.getrlimit(resource.RLIMIT_NOFILE)}
    with sqlite3.connect(f'{ROOT.as_uri()}/run_metadata.sqlite?mode=ro', uri=True) as db:
        visible = {r[0] for r in db.execute('select hash from run')}
    report['sql_runs'] = len(visible)
    catalog = {}
    counts = {}
    names = collections.Counter()
    started = time.perf_counter()
    for path in sorted((ROOT / 'meta/chunks').iterdir()):
        if not path.is_dir():
            continue
        container = open_db(path)
        try:
            traces = container.tree().subtree(('meta', 'chunks', path.name)).get('traces', {})
            metrics = [(ctx, name, meta) for ctx, items in traces.items()
                       for name, meta in items.items()
                       if meta.get('dtype', 'float') in ('float', 'float64', 'int')]
            counts[path.name] = len(metrics)
            if path.name in visible:
                catalog[path.name] = metrics
                names.update(name for _, name, _ in metrics)
        finally:
            container.close()
    report['metadata_scan_seconds'] = time.perf_counter() - started
    report['meta_chunk_dirs'] = len(counts)
    report['scalar_series_in_chunks'] = sum(counts.values())
    report['scalar_series_in_sql_runs_chunks'] = sum(len(v) for v in catalog.values())
    report['unique_metric_names_in_sql_runs_chunks'] = len(names)
    per_run = [len(v) for v in catalog.values()]
    report['series_per_sql_run_min_median_max'] = [min(per_run), float(np.median(per_run)), max(per_run)]

    container = open_db(ROOT / 'meta/index')
    try:
        tree = container.tree().subtree(('meta', 'chunks'))
        indexed = set(tree.keys())
        report['indexed_runs'] = len(indexed)
        report['sql_runs_missing_from_index'] = sorted(visible - indexed)
        report['scalar_series_in_sql_runs_index'] = sum(
            meta.get('dtype', 'float') in ('float', 'float64', 'int')
            for h in visible for ctx in tree.subtree(h).get('traces', {}).values()
            for meta in ctx.values())
        report['index_open_fds'] = fd_count()
    finally:
        container.close()

    sizes = []
    for path in (ROOT / 'seqs/chunks').iterdir():
        if path.is_dir() and path.name in visible:
            sizes.append((sum(f.stat().st_size for f in path.iterdir() if f.is_file()), path.name))
    report['examples'] = []
    for _, run_hash in sorted(sizes, reverse=True)[:3]:
        meta_db = open_db(ROOT / 'meta/chunks' / run_hash)
        seq_db = open_db(ROOT / 'seqs/chunks' / run_hash)
        try:
            for ctx, name, meta in catalog[run_hash]:
                if name not in ('loss', 'success_rate') or meta.get('version') != 2:
                    continue
                data = SequenceV2Data(
                    meta_db.tree().subtree(('meta', 'chunks', run_hash, 'traces', ctx, name)),
                    seq_db.tree().subtree(('seqs', 'v2', 'chunks', run_hash, ctx, name)),
                    columns=[('val', 'float64')])
                start = time.perf_counter()
                steps, (values,) = data.numpy()
                elapsed = time.perf_counter() - start
                sample_steps, (sample_values,) = data.sample(500).numpy()
                finite = values[np.isfinite(values)]
                sampled_finite = sample_values[np.isfinite(sample_values)]
                report['examples'].append({
                    'run': run_hash, 'metric': name, 'points': len(steps),
                    'full_read_seconds': elapsed, 'sampled_points': len(sample_steps),
                    'nonfinite_points': int((~np.isfinite(values)).sum()),
                    'full_step_min_max': [int(steps[0]), int(steps[-1])],
                    'sample_step_gap_min_median_max': [float(f(np.diff(sample_steps)))
                                                       for f in (np.min, np.median, np.max)],
                    'full_value_min_max': [float(np.min(finite)), float(np.max(finite))],
                    'sample_value_min_max': [float(np.min(sampled_finite)), float(np.max(sampled_finite))],
                })
        finally:
            meta_db.close()
            seq_db.close()

    # Deliberately retain handles to quantify the cost of unbounded reader lifetimes.
    # This is a controlled diagnostic, not a simulation of a specific API request.
    held = []
    report['fd_baseline'] = fd_count()
    start = time.perf_counter()
    try:
        for _, h in sorted(sizes):
            held.append(open_db(ROOT / 'seqs/chunks' / h))
        report['held_seq_databases'] = len(held)
        report['held_seq_fds'] = fd_count()
        report['held_seq_open_seconds'] = time.perf_counter() - start
    finally:
        for container in held:
            container.close()
        held.clear()
        gc.collect()
    report['fd_after_close'] = fd_count()
    if args.check_fd_limit is not None:
        report['controlled_fd_check'] = check_fd_limit(args.check_fd_limit)
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
