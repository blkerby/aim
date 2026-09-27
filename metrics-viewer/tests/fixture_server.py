"""Deterministic browser fixture, never mounted in the production server."""
from pathlib import Path
import sys
import threading
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
import uvicorn
from backend.app import create_app


class FixtureReader:
    root = Path('/tmp/aim-viewer-browser-fixture/.aim')
    tick = 0
    failing = False
    read_gate = threading.Event()
    read_gate.set()

    def runs(self):
        return [{'id': f'run{i:03}', 'name': f'Run {i:03}', 'createdAt': '2026-09-27T12:00:00',
                 'archived': False, 'active': i == 0, 'experiment': 'fixture'} for i in range(120)]

    def validate_runs(self, runs):
        if any(h not in {r['id'] for r in self.runs()} for h in runs):
            raise ValueError('Unknown run')

    def metrics(self, runs):
        return {'metrics': [{'id': f'metric{i:02}', 'name': f'metric_{i:02}', 'context': {},
                             'runs': {r: {'firstStep': 0, 'lastStep': 200 + self.tick * 15,
                                          'revision': str(self.tick)} for r in runs}} for i in range(60)], 'errors': []}

    def series(self, run, metric):
        if not self.read_gate.wait(timeout=15):
            raise RuntimeError('Fixture read gate timed out')
        if self.failing:
            raise RuntimeError('Simulated transient read failure')
        n = int(metric[-2:])
        end = 200 + self.tick * 15
        if n % 3 == 0:
            x = np.linspace(0, end, 9000)
        elif n % 3 == 1:
            x = np.linspace(0, end, 15)
        else:
            x = np.r_[np.linspace(0, 70, 5000), np.linspace(80, end, 10)]
        y = np.exp(-x / 100) * (1 + .3 * np.sin(x * 2)) + int(run[-3:]) / 1000
        y[(x > 90) & (x < 100)] = np.nan
        return str(self.tick), x.astype('<f8'), y.astype('<f8')

    def stats(self):
        return {'openReaders': 0}



reader = FixtureReader()
app = create_app(reader.root, reader=reader)

# StaticFiles is mounted last by create_app; insert test routes before it.
from fastapi import APIRouter
control = APIRouter()

@control.post('/test/advance')
def advance():
    reader.tick += 1
    return {'lastStep': 200 + reader.tick * 15}

@control.post('/test/reset')
def reset():
    reader.read_gate.set()
    reader.tick = 0
    reader.failing = False
    return {'ok': True}

@control.post('/test/fail')
def fail():
    reader.failing = True
    return {'ok': True}

@control.post('/test/hold')
def hold():
    reader.read_gate.clear()
    return {'ok': True}

@control.post('/test/release')
def release():
    reader.read_gate.set()
    return {'ok': True}

app.router.routes[0:0] = control.routes

if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=43802)
