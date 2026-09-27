import json
import os
from pathlib import Path
import sqlite3
import struct
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient
from aim.storage.context import Context
from aim.storage.hashing import hash_auto
from aim.storage.rockscontainer import RocksContainer

from backend.app import create_app
from backend.envelope import frame, summarize
from backend.reader import Reader


def make_repo(root, version=2):
    root.mkdir(exist_ok=True)
    with sqlite3.connect(root / 'run_metadata.sqlite') as db:
        db.executescript('CREATE TABLE experiment (id INTEGER, name TEXT); '
                         'CREATE TABLE run (hash TEXT, name TEXT, created_at TEXT, is_archived INTEGER, experiment_id INTEGER); '
                         "INSERT INTO run VALUES ('fixture_run', 'Test run', '2026-09-27', 0, NULL);")
    write_series(root, 'loss', [0, 1, 2, 3, 4], [1, 2, np.nan, 50, 3], version)


def write_series(root, name, xs, ys, version=2, context=None):
    ctx = Context(context or {}).idx
    for domain in ('meta', 'seqs'):
        (root / domain / 'chunks' / 'fixture_run').mkdir(parents=True, exist_ok=True)
    c = RocksContainer(str(root / 'meta/chunks/fixture_run'), read_only=False)
    try:
        t = c.tree()
        t['meta', 'contexts', ctx] = context or {}
        t['meta', 'chunks', 'fixture_run', 'traces', ctx, name] = {
            'dtype': 'float', 'version': version, 'first_step': xs[0], 'last_step': xs[-1]}
    finally:
        c.close()
    c = RocksContainer(str(root / 'seqs/chunks/fixture_run'), read_only=False)
    try:
        prefix = ('seqs', 'chunks', 'fixture_run') if version == 1 else ('seqs', 'v2', 'chunks', 'fixture_run')
        t = c.tree().subtree((*prefix, ctx, name))
        values = t.array('val').allocate()
        steps = t.array('step', dtype='int64').allocate() if version == 2 else None
        for step, y in zip(xs, ys):
            key = hash_auto(step) if version == 2 else step
            values[key] = float(y)
            if steps is not None:
                steps[key] = step
    finally:
        c.close()


def manifest(root):
    return {str(p.relative_to(root)): (p.stat().st_size, p.stat().st_mtime_ns) for p in root.rglob('*') if p.is_file()}


class EnvelopeTests(unittest.TestCase):
    def test_dense_extrema_and_singletons(self):
        s = summarize(np.array([0., .1, .2, 2.4, 4.]), np.array([2., 90., -5., 7., 4.]), [0, 4], 4)
        self.assertEqual(s['low'][0], -5)
        self.assertEqual(s['high'][0], 90)
        self.assertEqual(s['counts'][0], 3)
        self.assertEqual(s['sampleX'][0], .1)
        self.assertEqual(s['sampleX'][2], 2.4)
        self.assertTrue(np.isnan(s['low'][1]))  # Empty columns are not stair steps.

    def test_representative_steps_are_lower_medians_of_valid_samples(self):
        # Unevenly spaced steps distinguish a recorded median from bin centers
        # and from averaging the middle two steps in an even-sized bin.
        x = np.array([0., 1., 8., 9., 11., 12., 19., 31.])
        y = np.array([2., 9., 4., 5., 7., np.nan, 8., 0.])
        s = summarize(x, y, [0, 40], 4)
        np.testing.assert_equal(s['sampleX'], [1, 11, np.nan, 31])
        np.testing.assert_equal(s['counts'], [4, 2, 0, 1])
        self.assertEqual(s['low'][0], 2)
        self.assertEqual(s['high'][0], 9)
        log = summarize(x, y, [0, 40], 4, True)
        np.testing.assert_equal(log['sampleX'], [1, 11, np.nan, np.nan])
        empty = summarize(np.array([]), np.array([]), [0, 1], 2)
        self.assertTrue(np.isnan(empty['sampleX']).all())

    def test_explicit_gaps_and_log(self):
        x = np.arange(5, dtype=float)
        s = summarize(x, np.array([1., 0., -2., np.nan, 10.]), [0, 4], 5, True)
        self.assertEqual(s['invalidCount'], 3)
        self.assertEqual(s['breaks'].tolist(), [0, 1, 1, 1, 0])
        self.assertEqual(s['bounds'], [1, 10])

    def test_zoom_between_sparse_points_clips_line(self):
        s = summarize(np.array([0., 100.]), np.array([1., 101.]), [25, 75], 300)
        self.assertEqual(s['rawCount'], 0)
        self.assertEqual(s['boundaries'], [[25., 26.], [75., 76.]])
        self.assertEqual(s['bounds'], [26, 76])
        self.assertFalse(s['counts'].any())

    def test_do_not_connect_invalid_boundary_neighbors(self):
        s = summarize(np.array([0., 100.]), np.array([1., np.nan]), [25, 75], 300)
        self.assertEqual(s['boundaries'], [None, None])
        self.assertIsNone(s['bounds'])

    def test_binary_protocol(self):
        s = summarize(np.array([0., 1.]), np.array([2., 3.]), [0, 1], 3)
        data = frame({'width': 3, 'status': 'ok'}, s)
        h, n = struct.unpack('<II', data[:8])
        self.assertEqual(n, 3 * 29)
        self.assertEqual(json.loads(data[8:8+h])['width'], 3)
        np.testing.assert_equal(np.frombuffer(data[8+h:8+h+24], '<f8'), s['low'])


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / '.aim'
        make_repo(self.root)
        self.reader = Reader(self.root)
        self.metric = next(iter(self.reader.run_metadata('fixture_run')))

    def tearDown(self):
        self.tmp.cleanup()

    def test_full_history_cache_and_no_source_writes(self):
        before = manifest(self.root)
        base = len(os.listdir('/proc/self/fd'))
        for _ in range(20):
            _, x, y = self.reader.series('fixture_run', self.metric)
            np.testing.assert_equal(x, np.arange(5))
            self.assertEqual(np.nanmax(y), 50)
        self.assertEqual(self.reader.stats()['seriesLoads'], 1)
        self.assertEqual(self.reader.stats()['openReaders'], 0)
        self.assertLessEqual(len(os.listdir('/proc/self/fd')), base + 1)
        self.assertEqual(before, manifest(self.root))

    def test_same_step_overwrite_invalidates_cache(self):
        first, _, _ = self.reader.series('fixture_run', self.metric)
        write_series(self.root, 'loss', [0, 1, 2, 3, 4], [1, 2, 3, 900, 3])
        second, _, y = self.reader.series('fixture_run', self.metric)
        self.assertNotEqual(first, second)
        self.assertEqual(max(y), 900)

    def test_activity_expires_and_finished_events_override_heartbeats(self):
        check_ins = self.root / 'check_ins'
        check_ins.mkdir()
        progress = self.root / 'meta/progress'
        progress.mkdir(exist_ok=True)
        flag = progress / 'fixture_run'
        flag.touch()
        (check_ins / 'fixture_run-0001-progress-1000-30').touch()
        (check_ins / 'malformed-progress-file').touch()
        before = manifest(self.root)
        with patch('backend.reader.time.time', return_value=1020):
            self.assertTrue(self.reader.runs()[0]['active'])
        with patch('backend.reader.time.time', return_value=1041):
            self.assertFalse(self.reader.runs()[0]['active'])
        self.assertEqual(before, manifest(self.root))
        (check_ins / 'fixture_run-0002-finished-1021-0').touch()
        with patch('backend.reader.time.time', return_value=1022):
            self.assertFalse(self.reader.runs()[0]['active'])
        (check_ins / 'fixture_run-0003-progress-1023-30').touch()
        with patch('backend.reader.time.time', return_value=1024):
            self.assertTrue(self.reader.runs()[0]['active'])
            flag.unlink()
            self.assertFalse(self.reader.runs()[0]['active'])

    def test_v1_and_contexts(self):
        write_series(self.root, 'legacy', [0, 10, 100], [2, 3, 5], 1, {'stage': 'eval'})
        ms = self.reader.metrics(['fixture_run'])['metrics']
        legacy = next(m for m in ms if m['name'] == 'legacy')
        self.assertEqual(legacy['context'], {'stage': 'eval'})
        _, x, y = self.reader.series('fixture_run', legacy['id'])
        np.testing.assert_equal(x, [0, 10, 100])
        np.testing.assert_equal(y, [2, 3, 5])

    def test_continuous_writes_do_not_starve_consistent_reads(self):
        original_read = self.reader._read

        def read_then_write(run, info):
            arrays = original_read(run, info)
            write_series(self.root, 'loss', [0, 1, 2, 3, 4, 5], [1, 2, 3, 50, 3, 75])
            return arrays

        with patch.object(self.reader, '_read', read_then_write):
            _, x, y = self.reader.series('fixture_run', self.metric)
        self.assertEqual(len(x), 5)
        self.assertEqual(np.nanmax(y), 50)
        self.assertEqual(self.reader.cache_bytes, 0)
        _, x, y = self.reader.series('fixture_run', self.metric)
        self.assertEqual(len(x), 6)
        self.assertEqual(max(y), 75)

    def test_cache_byte_limit(self):
        reader = Reader(self.root, cache_mib=0.0001)
        reader.series('fixture_run', self.metric)
        write_series(self.root, 'second', [0, 1, 2, 3, 4], [2, 3, 4, 5, 6])
        key = next(k for k,v in reader.run_metadata('fixture_run').items() if v['name'] == 'second')
        reader.series('fixture_run', key)
        self.assertLessEqual(reader.cache_bytes, reader.budget)
        self.assertEqual(len(reader.cache), 1)

    def test_endpoints_and_errors(self):
        with TestClient(create_app(self.root, reader=self.reader)) as client:
            self.assertEqual(client.get('/api/runs').json()['runs'][0]['id'], 'fixture_run')
            self.assertEqual(client.post('/api/metrics', json={'runs':['../other']}).status_code, 400)
            body = {'runs':['fixture_run'], 'metric':self.metric, 'domain':[0,4], 'width':300}
            response = client.post('/api/series', json=body)
            self.assertEqual(response.status_code, 200)
            h, n = struct.unpack('<II', response.content[:8])
            header = json.loads(response.content[8:8+h])
            self.assertEqual(header['status'], 'ok')
            self.assertEqual(header['rawCount'], 5)
            self.assertEqual(header['latestStep'], 4)
            self.assertEqual(header['latestValue'], 3)  # Not the column's maximum (50).
            historical = client.post('/api/series', json={**body, 'domain': [0, 1]})
            length, _ = struct.unpack('<II', historical.content[:8])
            historical_header = json.loads(historical.content[8:8+length])
            self.assertEqual(historical_header['latestStep'], 4)
            self.assertEqual(historical_header['latestValue'], 3)
            self.assertEqual(n, 300*29)
            self.assertEqual(client.post('/api/series', json={**body,'domain':[1,1]}).status_code, 422)
            self.assertEqual(client.get('/api/stats').json()['openReaders'], 0)



if __name__ == '__main__':
    unittest.main()
