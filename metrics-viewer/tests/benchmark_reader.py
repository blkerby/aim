"""Read-only benchmark; stdout JSON. Does not drop the operating system cache."""
import argparse
import json
from pathlib import Path
import resource
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import numpy as np
from backend.envelope import summarize
from backend.reader import Reader

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
args = parser.parse_args()
_, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
resource.setrlimit(resource.RLIMIT_NOFILE, (min(1024, hard), hard))
reader = Reader(args.repo)
runs = reader.runs()
report = {'repo': str(reader.root), 'runCount': len(runs), 'nofile': resource.getrlimit(resource.RLIMIT_NOFILE), 'scenarios': []}
for count in dict.fromkeys([min(10,len(runs)), min(50,len(runs)), len(runs)]):
    reader = Reader(args.repo)
    ids = [r['id'] for r in runs[:count]]
    start = time.perf_counter()
    metrics = reader.metrics(ids)
    catalog_seconds = time.perf_counter() - start
    loss = next(m for m in metrics['metrics'] if m['name'] == 'loss' and m['context'] == {})
    def run_pass():
        points = 0
        start = time.perf_counter()
        for run in loss['runs']:
            _, x, y = reader.series(run, loss['id'])
            if len(x):
                left, right = float(x[0]), float(x[-1])
                summarize(x, y, [left, right if right > left else left + 1], 600)
                points += len(x)
        return {'seconds': time.perf_counter() - start, 'rawPoints': points}
    before = reader.stats()
    first, warm = run_pass(), run_pass()
    report['scenarios'].append({'selectedRuns': count, 'matchedRuns': len(loss['runs']),
                                'catalogSeconds': catalog_seconds, 'firstPass': first, 'warmPass': warm,
                                'before': before, 'after': reader.stats(), 'catalogErrors': metrics['errors']})

run = 'b1f98301749f46bda12eeefc'
if any(r['id'] == run for r in runs):
    meta = reader.run_metadata(run)
    key = next(k for k,m in meta.items() if m['name'] == 'loss' and m['context'] == {})
    _, x, y = reader.series(run,key)
    s = summarize(x,y,[float(x[0]),float(x[-1])],300)
    report['spikeCheck'] = {'rawPoints':len(x), 'rawMaximum':float(np.nanmax(y)), 'envelopeMaximum':float(np.nanmax(s['high'])), 'width':300}
print(json.dumps(report,indent=2))
