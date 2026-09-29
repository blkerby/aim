# Aim metrics viewer

A standalone, read-only viewer for existing Aim repositories. Select runs and
metric/context combinations, compare their histories, switch each Y axis between
linear and logarithmic, and zoom by training step. No Aim storage migration or
changes to the existing Aim UI are required.

## Run

Use the Python environment that already contains Aim. For this workspace:

```sh
cd /home/kerby/aim/metrics-viewer
npm ci
npm run build
/home/kerby/miniconda3/envs/map-gen/bin/python serve.py --repo /home/kerby/map-gen/.aim
```

Open **http://127.0.0.1:43801**. The Python server serves the built client and API;
Node is needed only to build/develop/test. Options: `--host` (default
`127.0.0.1`), `--port` (43801), and `--cache-mib` (512). `--repo` accepts either
the `.aim` directory or its parent. Another environment can install
`requirements.txt`; the implementation is tested with Aim 3.29.1 and Python 3.12.
Frontend builds require Node 20.19+ or 22.12+; this checkout was tested on Node 24.
Dependencies are locked in `package-lock.json`.

For frontend development, run the Python server and `npm run dev` in separate
terminals. Vite proxies `/api` to port 43801.

## Controls

- The sun/moon button toggles light/dark mode in one click. The preference is
  remembered; switching themes preserves selections, zooms, and loaded data.
- The panel button at the left of the toolbar collapses/expands the Runs/Metrics
  sidebar. **Per row** selects one to five charts. Both settings are remembered.
  Narrow windows scroll horizontally when needed to keep charts usable.
- Search and select runs in the sidebar. The list also serves as the shared run
  color legend. Names, hashes, and experiment names are searchable.
- Search and select metrics. Context variants are separate charts, preventing
  measurements such as different models or stages from being silently combined.
- Drag horizontally to zoom. Double-click the plot or click **↺** to reset.
  Y limits automatically fit the visible values. **Lin / Log** affects only that
  chart; nonpositive values are gaps on logarithmic axes.
- **Link x-axes** shares the last-interacted chart's step range. Y scales remain
  independent. Unlinking preserves the current ranges.
- Data refreshes every five seconds; **Pause**, **Resume**, and **↻** control it.
  Full-history views expand. A zoom containing the latest step keeps its left
  edge fixed and extends its right edge as new data arrives. A historical zoom
  stays fixed. Linked charts follow the latest step across the selected charts.
  During refresh, each chart keeps its displayed data and axes until its new
  summaries are ready, then replaces them together without blanking the plot.
- A small solid circle marks each run's actual latest sample, only when it lies
  inside the visible range. Active runs pulse without redrawing the Canvas.
  Activity requires a fresh Aim progress heartbeat and an existing progress flag;
  the heartbeat's expected interval plus ten seconds determines expiry. Finished
  or stale runs stay still. Missing heartbeats (e.g. copied datasets) stay still.
  This small activity pulse remains enabled with reduced-motion preferences.
- Hover highlights the nearest displayed min/max reference or sparse sample in
  screen space within 20px of the cursor. Dashed guides connect it to the axes; X/Y value boxes stay in the
  margins. Dense columns use a recorded middle step for the X label (the lower
  median for an even count); Y is the observed min or max. The representative
  step need not be where the extremum occurred within that pixel column. Sparse
  points use their recorded X/Y. Step labels are formatted as integers; Y labels retain three to five significant figures.
  Selection is entirely local, accounts for log scale, makes no network requests,
  and updates an overlay without repainting the Canvas curves.
- Run/metric selections and scale preferences are remembered in browser local
  storage, separately for each repository. New runs are not automatically selected.

## Rendering and fidelity

The server reads complete requested histories and partitions the visible step
range into **physical pixel columns**, accounting for device-pixel ratio and
excluding chart margins. There is no fixed point budget or reservoir sampling.

Rendering is local, so a single series can mix all three cases:

1. A column with multiple samples renders its min/max as a vertical segment.
   If the immediately preceding column is also dense and the ranges do not
   overlap, extend the latter segment to one physical pixel row short of the
   preceding **original** range, so they touch diagonally. Pixel rounding happens
   before this connection; extensions do not propagate into subsequent summaries.
2. A column containing one sample keeps that sample's exact step and value.
   Sparse samples connect with ordinary sloped line segments across empty
   columns; they are not rendered as interpolated stair steps.
3. Sparse/dense transitions connect to the nearest point in the neighboring
   range. Separated dense bins similarly connect their nearest bounds (or the
   midpoint of their overlap). Dense bins need no first/last samples.

Explicit nonfinite samples, and nonpositive samples in log mode, break
connectivity. If a single physical column contains both valid and invalid
samples, retain its extrema but disable incoming/outgoing connections. Subpixel
gap topology cannot be represented exactly by a single interval; zoom reveals
more detail. Boundary-crossing sparse lines are clipped to the requested range,
including when no recorded sample lies inside the zoom. Log interpolation takes
place in logarithmic Y coordinates.

Min/max envelopes preserve recorded extrema, not the original chronology within
a dense column. The added connections represent continuity, not additional data.
The Canvas renderer owns these rules; D3 supplies scales and ticks only.

## Read path and resources

- SQLite opens with `mode=ro`. RocksContainer opens with `read_only=True` and
  `skip_read_optimization=True`. The viewer never constructs Aim `Repo`/`Run`,
  invokes repair/reindexing, or starts Aim's maintenance processes.
- Metadata comes from individual registered runs' chunks. Unregistered physical
  directories are not included in a global health scan.
- Two background workers limit simultaneous database access. Readers/iterators
  close before yielding response data; slow clients do not pin databases.
- A 512 MiB LRU caches decoded histories, not handles. This bounds retained
  array storage, not total process RSS or transient arrays during reads. Histories
  larger than the cache still render but must be reread on subsequent requests.
- File fingerprints include WAL/manifest/file identity, size, and nanosecond
  mtime, detecting changes to old steps as well as appended points. Consistent
  snapshots read during ongoing writes are returned without being cached under
  an uncertain revision. Inconsistent step/value columns are retried once;
  errors retain previously displayed data. If new viewport summaries fail,
  the previous chart and its axes remain visible together.
- Chart rows and selectors are virtualized. Only visible charts plus one row of
  overscan load/render data. The client limits streams to two and keeps a 128 MiB,
  maximum-256-entry viewport cache. Mounted charts also retain their active arrays.
- Fetching/binary decoding happens in a Web Worker. Stale requests are cancelled;
  a running reader finishes before its worker slot is released. Hidden browser
  tabs stop polling. `/api/stats` reports cache, reader, descriptor, and RSS usage.

The first request for an uncached V2 history reads and sorts it fully: Aim's
hashed-step storage does not support efficient direct step-range reads. Later
zooms use cached histories. Broad queries load progressively.

## API

All endpoints are read-only. The service is intended for trusted local use.

| Endpoint | Input / output |
|---|---|
| `GET /api/runs` | Repository identity and registered run labels/metadata |
| `POST /api/metrics` | `{runs: string[]}` → metric/context IDs, run availability, extents, revisions, per-run errors |
| `POST /api/series` | `{runs, metric, domain: [min,max], width, scale: "linear" \| "log"}` → progressive binary frames |
| `GET /api/stats` | Retained bytes, loads, active/peak readers, process descriptors and RSS |

Metric IDs encode `[contextIdString, metricName]`; signed 64-bit context hashes
never travel as JavaScript numbers. Input run IDs must be registered. Physical
width is limited to 32,768; run batches to 4,096. Steps outside JavaScript's exact
integer range fail explicitly.

Each stream frame is: little-endian uint32 JSON-header length, uint32 payload
length, UTF-8 header, payload. Successful payloads contain five width-sized
columns: float64 min, float64 max, float64 representative step (lower median; NaN for empty bins), uint32
sample count, uint8 break flag. Numeric arrays are little-endian. Headers include
the viewport, scale, revision, raw count, invalid count, Y bounds, actual latest step/value,
and up to two clipped boundary points. `missing`/`error` frames have no payload.
Frames are independently decodable across arbitrary network chunk boundaries.

## Tests and measurements

```sh
# Use the selected Python environment; httpx is a test-only dependency.
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
npm test
npm run build

# Requires Chrome; override CHROME_PATH if necessary.
AIM_VIEWER_PYTHON=python npm run test:browser

# Optional read-only benchmark against a repository:
python tests/benchmark_reader.py --repo /path/to/.aim

# Optional browser benchmark against an already running viewer:
AIM_VIEWER_PYTHON=python REAL_REPO_URL=http://127.0.0.1:43801 npm run test:browser
```

Tests cover V1/V2 reads, source-file immutability, file-handle cleanup, cache
eviction/invalidation, writes during reads, framing, mixed sparse/dense rendering,
explicit gaps, log mode, zoom, live following, linked axes, persistence,
virtualization, and transient failures. Browser fixtures are isolated and never
served by the production launcher.

See [BENCHMARK.md](BENCHMARK.md) for measurements on the user's repository.
The prototype does not include smoothing, aggregation across runs, custom
x-axis metrics, editing, exports, saved dashboards, or automatic storage repair.
