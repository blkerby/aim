# Measurements, 2026-09-27

Read-only tests against `/home/kerby/map-gen/.aim`, Aim 3.29.1, Python 3.12,
NumPy 2.4.6; Chrome headless at 1440 × 1000, device-pixel ratio 1. These are local
measurements, not comparisons against an instrumented original Aim browser.
The operating system's file cache was not cleared; “first pass” means an empty
viewer cache, not cold disk.

## Reader

Each scenario discovers metadata, reads every matching default-context `loss`
history, and creates a 600-column summary per run. The process soft file limit
was **1,024**. Raw results are in [benchmark-reader.json](benchmark-reader.json).

| Selected runs | Matching runs | Raw points | Catalog | First pass | Cached pass |
|---:|---:|---:|---:|---:|---:|
| 10 | 8 | 7,805 | 77 ms | 78 ms | 5 ms |
| 50 | 48 | 21,824 | 373 ms | 265 ms | 21 ms |
| 156 | 154 | 112,996 | 767 ms | 979 ms | 62 ms |

All three scenarios started and finished at **four process descriptors**. The
sequential benchmark peaked at one simultaneous reader and returned to zero
active readers. The 156-run scenario retained 1.72 MiB of decoded arrays; process
RSS was about 146 MiB afterward, including Python, Aim, RocksDB, and metadata.

The 5,237-point loss history in run `b1f98301749f46bda12eeefc` retained its exact
maximum **0.3428910043819997** in a 300-column summary. Aim's 500-point sample in
the preceding investigation had missed this peak.

## Browser

Selected all **156 registered runs**, then displayed six default-context metrics:
`loss`, `success_rate`, `avg_conn`, `avg_door`, `temperature`, and `min_conn`.

- All six charts finished loading in **7.88 seconds**, including browser startup
  navigation, catalog discovery, transfer, decode, and progressive rendering.
- Over 90 animation frames of warm scrolling, p95 and maximum frame intervals
  were **16.7 ms** and **16.8 ms**, respectively. No main-thread long tasks were recorded in that interval.
- Reported JS heap during that interval was approximately **33.1 MiB**.
- Selecting all **535 metric/context combinations** mounted just **eight** chart
  components; scrolling to the end also kept the mounted count below twelve.
- The server peaked at **two simultaneous readers** and recorded no browser
  exceptions or per-series errors during the initial six-chart load.

These scroll measurements concern six loaded charts. The all-metrics check
validates virtualization, not a claim that all 535 charts were fetched or rendered
simultaneously. Cold-cache zooms and continuous writes can take longer. Hardware,
browser, pixel density, selected histories, and filesystem cache affect results.

The optional browser test writes screenshots and a machine-readable report to
`test-results/`. The fixtures separately verify dense curves, sparse sloped lines,
locally mixed curves, explicit gaps, refresh/follow behavior, and zoom linking.
