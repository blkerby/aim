"""Aim codecs with explicit reader lifetimes; never construct Repo or Run."""
from collections import OrderedDict
from contextlib import contextmanager, closing
import hashlib
from itertools import zip_longest
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time

import numpy as np
import psutil
from aim.storage.rockscontainer import RocksContainer


SCALARS = {'float', 'float64', 'int', 'number'}


class Reader:
    def __init__(self, root, cache_mib=512):
        self.root = Path(root).expanduser().resolve()
        if self.root.name != '.aim' and (self.root / '.aim').is_dir():
            self.root = self.root / '.aim'
        if not (self.root / 'run_metadata.sqlite').is_file():
            raise ValueError(f'No Aim repository at {self.root}')
        self.budget = int(cache_mib * 1024 * 1024)
        self.cache = OrderedDict()
        self.cache_bytes = 0
        self.metadata = OrderedDict()
        self.lock = threading.RLock()
        self.run_locks = [threading.Lock() for _ in range(64)]
        self.open_readers = 0
        self.peak_readers = 0
        self.loads = 0

    def runs(self):
        with closing(sqlite3.connect(f'{self.root.as_uri()}/run_metadata.sqlite?mode=ro', uri=True)) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute('SELECT r.hash AS id, r.name, r.created_at AS createdAt, '
                              'r.is_archived AS archived, e.name AS experiment FROM run r '
                              'LEFT JOIN experiment e ON r.experiment_id=e.id '
                              'ORDER BY r.created_at DESC').fetchall()
        active = self.active_runs()
        return [{**dict(row), 'active': row['id'] in active} for row in rows]

    def active_runs(self):
        """Read Aim's heartbeat filenames; stale progress flags alone aren't live.

        No watcher/maintenance service is started and no metadata is changed.
        The ten-second grace matches Aim's run status manager.
        """
        latest = {}
        try:
            with os.scandir(self.root / 'check_ins') as entries:
                for entry in entries:
                    try:
                        run, index, kind, timestamp, interval = entry.name.rsplit('-', 4)
                        if kind not in ('progress', 'finished'):
                            continue
                        event = (int(index), kind, float(timestamp), int(interval))
                        if run not in latest or event[0] > latest[run][0]:
                            latest[run] = event
                    except ValueError:
                        continue
        except FileNotFoundError:
            return set()
        now = time.time()
        return {run for run, (_, kind, timestamp, interval) in latest.items()
                if kind == 'progress' and interval > 0 and now <= timestamp + interval + 10
                and (self.root / 'meta' / 'progress' / run).is_file()}

    def validate_runs(self, ids):
        known = {r['id'] for r in self.runs()}
        if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', h) or h not in known for h in ids):
            raise ValueError('An unknown run was requested. Refresh the run list.')

    def fingerprint(self, domain, run):
        directory = self.root / domain / 'chunks' / run
        # Include files, not just directory mtime: writes can append to a WAL
        # or replace values without advancing the last tracked step.
        parts = []
        for path in sorted(directory.iterdir()):
            if path.name in ('LOCK', 'LOG') or path.name.startswith('LOG.old'):
                continue
            stat = path.stat()
            if path.is_file():
                parts.append((path.name, stat.st_size, stat.st_mtime_ns, stat.st_ino))
        return hashlib.blake2b(repr(parts).encode(), digest_size=12).hexdigest()

    @contextmanager
    def container(self, domain, run):
        container = RocksContainer(str(self.root / domain / 'chunks' / run),
                                   read_only=True, skip_read_optimization=True)
        with self.lock:
            self.open_readers += 1
            self.peak_readers = max(self.peak_readers, self.open_readers)
        try:
            yield container
        finally:
            container.close()
            with self.lock:
                self.open_readers -= 1

    def run_metadata(self, run):
        revision = self.fingerprint('meta', run)
        with self.lock:
            cached = self.metadata.get(run)
            if cached and cached[0] == revision:
                self.metadata.move_to_end(run)
                return cached[1]
        with self.container('meta', run) as container:
            root = container.tree().subtree('meta')
            contexts = root.get('contexts', {})
            traces = root.subtree(('chunks', run)).get('traces', {})
            result = {}
            for ctx, items in traces.items():
                for name, meta in items.items():
                    if meta.get('dtype', 'float') not in SCALARS:
                        continue
                    context = contexts.get(ctx, {})
                    # The wire identifier contains the signed context ID as a
                    # string, never a lossy JavaScript float64 hash.
                    key = json.dumps([str(ctx), name], separators=(',', ':'), ensure_ascii=False)
                    result[key] = {'id': key, 'name': name, 'context': context,
                                   'contextId': str(ctx), 'version': meta.get('version', 1),
                                   'firstStep': meta.get('first_step'), 'lastStep': meta.get('last_step')}
        with self.lock:
            self.metadata[run] = (revision, result)
            self.metadata.move_to_end(run)
            while len(self.metadata) > 512:
                self.metadata.popitem(last=False)
        return result

    def metrics(self, runs):
        result, errors = {}, []
        for run in runs:
            try:
                revision = self.fingerprint('seqs', run) + self.fingerprint('meta', run)
                for key, entry in self.run_metadata(run).items():
                    merged = result.setdefault(key, {**entry, 'runs': {}})
                    merged['runs'][run] = {'firstStep': entry['firstStep'], 'lastStep': entry['lastStep'],
                                           'revision': revision}
            except Exception as exc:
                errors.append({'run': run, 'error': str(exc)})
        return {'metrics': sorted(result.values(), key=lambda m: (m['name'], m['id'])), 'errors': errors}

    def series(self, run, metric_id):
        stripe = int(hashlib.blake2b(run.encode(), digest_size=2).hexdigest(), 16) % len(self.run_locks)
        with self.run_locks[stripe]:
            key = (run, metric_id)
            for attempt in range(2):
                try:
                    revision = self.fingerprint('seqs', run) + self.fingerprint('meta', run)
                    with self.lock:
                        cached = self.cache.get(key)
                        if cached and cached[0] == revision:
                            self.cache.move_to_end(key)
                            return cached
                    info = self.run_metadata(run).get(metric_id)
                    if info is None:
                        raise KeyError('This run does not contain the selected metric/context.')
                    x, y = self._read(run, info)
                    # A read-only DB is a snapshot. Continuous training may
                    # change files during every read: return consistent arrays,
                    # but do not cache them under an uncertain generation.
                    after = self.fingerprint('seqs', run) + self.fingerprint('meta', run)
                    value = (revision, x, y)
                    size = x.nbytes + y.nbytes
                    with self.lock:
                        old = self.cache.pop(key, None)
                        if old:
                            self.cache_bytes -= old[1].nbytes + old[2].nbytes
                        while self.cache and self.cache_bytes + size > self.budget:
                            _, old = self.cache.popitem(last=False)
                            self.cache_bytes -= old[1].nbytes + old[2].nbytes
                        if size <= self.budget and after == revision:
                            self.cache[key] = value
                            self.cache_bytes += size
                        self.loads += 1
                    return value
                except Exception:
                    if attempt:
                        raise

    def _read(self, run, info):
        version, ctx, name = info['version'], int(info['contextId']), info['name']
        if version not in (1, 2):
            raise ValueError(f'Unsupported Aim sequence version {version}')
        with self.container('seqs', run) as container:
            prefix = ('seqs', 'chunks', run) if version == 1 else ('seqs', 'v2', 'chunks', run)
            tree = container.tree().subtree((*prefix, ctx, name))

            def rows():
                vals = tree.array('val').items()
                steps = tree.array('step').items() if version == 2 else None
                try:
                    if version == 1:
                        for step, val in vals:
                            yield step, float(val) if val is not None else np.nan
                    else:
                        for s, v in zip_longest(steps, vals):
                            if s is None or v is None or s[0] != v[0]:
                                raise RuntimeError('Inconsistent step/value columns during live read.')
                            yield s[1], float(v[1]) if v[1] is not None else np.nan
                finally:
                    vals.close()
                    if steps is not None:
                        steps.close()

            with closing(rows()) as iterator:
                records = np.fromiter(iterator, dtype=[('x', '<i8'), ('y', '<f8')])
            if len(records) and np.any(np.abs(records['x'].astype(np.float64)) > 2**53 - 1):
                raise ValueError('Steps exceed the exact integer range supported by this browser viewer.')
            order = np.argsort(records['x'], kind='stable')
            x = np.asarray(records['x'][order], dtype='<f8')
            y = np.asarray(records['y'][order], dtype='<f8')
            x.flags.writeable = y.flags.writeable = False
            return x, y

    def stats(self):
        with self.lock:
            return {'cacheBytes': self.cache_bytes, 'cacheLimitBytes': self.budget,
                    'cachedSeries': len(self.cache), 'openReaders': self.open_readers,
                    'peakReaders': self.peak_readers, 'seriesLoads': self.loads,
                    'openFiles': len(os.listdir('/proc/self/fd')) if Path('/proc/self/fd').exists() else None,
                    'rssBytes': psutil.Process().memory_info().rss}
