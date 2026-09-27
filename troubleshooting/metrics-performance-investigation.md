Investigation of Aim metrics performance and fidelity, 2026-09-27

The evidence supports improving the read and visualization paths while retaining Aim's current storage. Sampling demonstrably hides significant events in this dataset. The browser has several mechanisms that scale with all selected charts and points, rather than what is visible. A metadata health check opens enough databases simultaneously to reproduce file-descriptor exhaustion under a 1,024-descriptor limit.

For a focused metrics viewer, I recommend a new, small read server and client sharing a carefully tested Aim reader adapter. First fix the existing project's descriptor-heavy health check and incorrect error classification. If maintaining all of Aim's existing explorers, query syntax, dashboards, and editing features is important, incrementally replace the current metrics pipeline instead. React and Python themselves do not need to be replaced to address these issues.

**Scope and measurements.** Source checkout: `6e098e38`; installed Aim in the `map-gen` Conda environment: 3.29.1. The installed sequence, RocksContainer, union, repo, and metric-streamer source files checked match this checkout. Data was read directly through read-only RocksContainer handles with `skip_read_optimization=True`, and SQLite `mode=ro`. No server was launched against the dataset, and no optimization, recovery, reindexing, deletion, or tracking was performed. Browser performance is inferred from the code, not measured with a browser trace. The actual failing server's process limits and traceback were unavailable.

The [probe](probe_metrics_readonly.py) and [recorded results](metrics-probe-2026-09-27.json) make the main measurements reproducible:

```sh
/home/kerby/miniconda3/envs/map-gen/bin/python troubleshooting/probe_metrics_readonly.py /home/kerby/map-gen/.aim --check-fd-limit 1024
```

| Measurement | Result |
|---|---:|
| Registered runs in SQLite | 156 |
| Runs in the metadata index | 157; all 156 registered runs present |
| Physical metadata / sequence chunk directories | 311 / 310 |
| Scalar series belonging to registered runs | 20,326, in both index and chunk metadata |
| Distinct metric names for registered runs | 373 |
| Scalar series per registered run: minimum / median / maximum | 0 / 136 / 295 |
| Scalar series across all metadata chunks | 44,050 |
| Files' logical size across the repository | About 2.12 GiB |
| Open descriptors while retaining 156 sequence databases | 855, versus baseline 5 |
| Descriptors after explicitly closing those databases | 5 |

Physical directories do not equal currently registered runs. The extra directories might reflect historical/deleted/unregistered runs; this investigation does not establish their origin or justify deleting them. Similarly, thousands of SST files exist on disk, but many are not referenced by current manifests. File counts are not a valid descriptor estimate: opening the current metadata index retained only three SST descriptors in one probe.

**Missing points: confirmed sampling loss.** The UI's [density choices](../aim/web/ui/src/config/enums/densityEnum.ts) are 50, 250, and 500; the current default is Maximum (500). The [metric endpoint](../aim/web/api/runs/views.py) defaults to 50 if `p` is omitted. The [streamer](../aim/web/api/runs/utils.py) calls `trace.data.sample(steps_num).numpy()`.

[SequenceV2Data](../aim/sdk/sequence.py) selects the first K entries in hashed-step order, then sorts the selected entries by actual step. This is deterministic, reservoir-like sampling, not uniform step spacing or extrema-preserving reduction. It attempts to include the latest point by replacing the last sampled point. The first point and interior peaks are not guaranteed. All scalar series found in the chunk inventory use V2.

In run `b1f98301749f46bda12eeefc`, `loss` has 5,237 finite points at steps 4,257–9,493. Full-history maximum: **0.342891**. The 500-point sample's maximum: **0.0258454**. It omits about 90.5% of points and entirely misses the large peak. Gaps between sampled steps range from 1 to 61 despite the raw sequence having consecutive steps. This directly explains apparently haphazard missing points without a storage failure.

[Zoom](../aim/web/ui/src/utils/d3/drawBrush.ts) rescales the existing paths; [its model handler](../aim/web/ui/src/utils/app/onZoomChange.ts) updates state and the URL. Neither fetches more detailed data. Increasing density only improves the odds of retaining an event. Raising the limit dramatically would also increase existing rendering and allocation costs.

Other concrete fidelity problems, conditional on the chosen view:

- [Custom alignment](../aim/web/api/runs/utils.py), lines 131–152, uses `if x_val`, dropping valid x=0 values. It also sends hashed step IDs as `x_axis_iters`, whereas the client's [missing-point alignment branch](../aim/web/ui/src/utils/app/alignMetricData.ts) compares those IDs against original step numbers. When x data is incomplete, that branch can discard valid matches. Hash IDs also travel as float64, an inappropriate representation for arbitrary 64-bit identifiers.
- [Invalid-value filtering](../aim/web/ui/src/utils/app/filterMetricData.ts) removes NaN/infinite values and some log-axis values. The [line generator](../aim/web/ui/src/utils/d3/lineGenerator.ts) then connects remaining points without a gap predicate. A missing interval can appear as a continuous line. Separately filtering coordinate arrays can also misalign their rows when validity differs; filtering should use a shared row mask appropriate to the selected x-axis.
- Smoothing and aggregation consume the sampled data. They therefore describe that sample, not necessarily the original time series. Accurate smoothing requires ordered raw data, with enough preceding context; an accurate aggregate must define how different step grids align.

**Browser sluggishness: strong code-level explanations.** The main scaling problems are in the metrics explorer:

- [ChartGrid](../aim/web/ui/src/components/ChartPanel/ChartGrid/ChartGrid.tsx) mounts every chart using `data.map`. Offscreen charts still own SVG geometry, hover data, and observers. Its keys include panel height and resize mode, causing remounts when those values change.
- [LineChart](../aim/web/ui/src/components/LineChart/LineChart.tsx) clears and rebuilds the drawing when dependencies change. [drawLines](../aim/web/ui/src/utils/d3/drawLines.ts) creates SVG paths per series; the geometry cost still grows with the number of points. Scheduling this work through `requestAnimationFrame` does not move it off the main thread.
- [Hover picking](../aim/web/ui/src/utils/d3/drawHoverAttributes.ts), starting at line 77, scans every scaled point in every series of the active chart to find the nearest point. The file also stores a separate `{x,y}` object for each scaled point. Mousemove schedules callbacks without coalescing all pending moves to the latest one.
- [ChartPanel](../aim/web/ui/src/components/ChartPanel/ChartPanel.tsx) broadcasts hover changes to every chart, including offscreen charts. The [metrics model](../aim/web/ui/src/services/models/explorer/metricsModelMethods.ts) can rebuild dynamic table rows on hover as well. A virtualized table alone does not eliminate the work of computing every row.
- Initial [stream decoding](../aim/web/ui/src/utils/app/getRunData.ts) accumulates all runs before updating charts. `processData` then decodes, filters, copies, smooths, and groups data on the main thread. Raw buffers, filtered arrays, x/y arrays, tuple arrays, unique-value sets, and scaled hover objects coexist. Even computing bounds in [processLineChartData](../aim/web/ui/src/utils/d3/processLineChartData.ts) builds full arrays and deduplicates them before finding extrema.
- Live updates already use a worker for fetching/decoding; the returned data still enters the full model-processing pipeline. Adding a worker only to network fetching would duplicate an existing partial solution.

For scale, 20,326 series × 500 points is an upper bound of 10.16 million sampled points. Values, steps, epochs, and timestamps alone would consume about 310 MiB of uncompressed float64 payload, before metadata, copies, JS objects, or SVG strings. Actual totals will be lower because some series are short and queries select subsets. This is an illustration, not a measured browser heap size.

These mechanisms plausibly explain long main-thread stalls and costly painting during scrolling. A Chrome/Firefox performance trace of the user's exact query is still needed to apportion time among JS, garbage collection, layout, and SVG painting.

**Open-file failures: reproduced mechanism.** [RocksContainer](../aim/storage/rockscontainer.pyx), line 80, sets `max_open_files=-1`. This allows each open database to retain all its needed table files. There is no global reader/descriptor budget.

More specifically, [project_api](../aim/web/api/projects/views.py), line 47, invokes `list_corrupted_runs()`. That constructs a [RocksUnionContainer](../aim/storage/union.pyx), opens the index and all metadata chunks, and seeks an iterator for each. Its chunk list includes the 311 physical directories, rather than just registered runs. This operation can exhaust descriptors before a large metrics query starts.

The controlled probe used a subprocess-local soft limit of 1,024, reserved eight descriptors to stand in for minimal server overhead, and retained the index/chunk readers while seeking each one. It reproduced **“Too many open files” after 218 database opens**. A probe that merely opens handles without seeking can understate the cost; reads open further files. The normal diagnostic environment has a 524,288 limit, so this does not establish the real server's limit or prove this was its exact failing stack.

The union code catches `RocksIOError` together with `Corruption`, and may label/skip affected chunks as corrupt. Its index-error branch can even remove the index. Resource exhaustion is not evidence of corruption. This error classification deserves a fix alongside resource management; no corruption/deletion path was invoked during these probes. `DB.close()` in the union is also a placeholder, and ordinary cleanup clears pools after requests instead of enforcing a peak budget.

**Option 1: improve the existing framework.** These changes need no writer or on-disk format changes:

| Priority | Change | Benefit and remaining constraint |
|---|---|---|
| First | Replace the project health check's all-open union scan with sequential or bounded checks, close iterators/readers explicitly, cache health results, distinguish resource errors from corruption | Directly addresses the demonstrated descriptor failure; check cancellation and concurrent requests too |
| First | Correct zero handling, align by original integer steps, preserve row correspondence and gaps | Small, testable correctness fixes independent of rendering |
| Next | Virtualize chart rows with modest overscan; stop work for offscreen charts; stabilize chart keys | Large likely reduction in scroll/paint and hover costs |
| Next | Coalesce hover to one update per frame; binary-search sorted x positions or use a suitable spatial index; update only visible charts/table rows | Eliminates scanning every point and broadcasting to every chart on each move |
| Next | Replace metric SVG paths with Canvas, while retaining React controls and optionally SVG axes | Reduces SVG cost; still needs bounded data and efficient picking |
| Next | Decode and transform in workers; retain typed buffers; share run metadata; compute bounds in one pass; update changed series only | Reduces main-thread work and allocation pressure |
| Substantial | Add viewport/detail requests, exact raw data, and extrema-preserving overview responses | Fixes sampling limitations; needs the reader/cache architecture below |
| Substantial | Run reads in a bounded worker pool, add cancellation/backpressure, and reuse immutable decoded results | Current async stream performs synchronous reads/encoding between awaits; `async` alone does not prevent event-loop stalls |

Raising the service's descriptor limit is a temporary mitigation once the actual process limit is checked. It is not a substitute for bounding readers. A finite per-database `max_open_files` may help ordinary read-only readers, but it is not a global cap and must be tested against concurrent writer compaction. RocksDB secondary readers have different requirements. [RocksDB's reader documentation](https://github.com/facebook/rocksdb/wiki/Read-only-and-Secondary-instances) distinguishes these modes.

Retrofitting virtualization and correctness fixes is reasonably contained. High-fidelity viewport loading crosses the API, model, alignment, smoothing, aggregation, rendering, and live-update code. Preserving the whole product favors this route; the work goes beyond changing one density constant or upgrading React.

**Option 2: a new focused metrics server and client.** Keep Aim writers and `.aim` files as they are. Use a separate read service, initially Python plus the installed Aim/aimrocks codecs, with a small React/TypeScript client. There is no measured reason yet to rewrite the reader in Rust; decoding compatibility and access patterns matter first.

The server should separate run/metric discovery from loading values. Enumerate registered runs and contexts once into a bounded metadata catalog; read only requested series, in a small worker pool with explicit iterator/handle ownership. Cache decoded arrays, not thousands of open databases. Use a global byte budget, eviction, request deduplication, cancellation, and a descriptor budget. Do not hold a reader open while waiting for a slow browser to receive data.

The client requests `(series IDs, x domain, pixel width, transform, fidelity)` for visible charts. Return binary typed columns and metadata saying how many raw points contributed, which reduction was applied, and whether the data is complete. Start with raw histories for modest series. At overview scale, use ordered first/min/max/last points per pixel bucket, preserving endpoints, extrema, and explicitly represented gaps. When zoomed in, return every raw point within the selected range plus boundary neighbors. Provide exact tooltip lookup and raw export. A reduced overview is still an approximation, and must be labeled accordingly.

Virtualize chart rows and render only visible charts plus a small margin. Use Canvas initially, with worker-side decoding, filtering, smoothing, and reduction. Keep bulk arrays outside React state. Hover should search the relevant series efficiently and avoid updating the entire page. [uPlot](https://leeoniya.github.io/uPlot/) is a Canvas-based candidate to benchmark, not a proven winner for this dataset; independent/irregular x grids and gap semantics need validation. A custom renderer or WebGL may be warranted for very large visible overlays. Workers can transfer buffers without cloning, and optional OffscreenCanvas can move drawing off the main thread. [MDN transferables](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects), [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas).

The principal constraint is the existing storage ordering. V2 stores entries by hashed step, and `SequenceV2Data.range()` explicitly rejects range selection. A new HTTP range endpoint cannot make an initial narrow read cheap by itself. The practical storage-preserving approach is to read a requested series fully, sort it by step, and build a bounded in-memory index and overview levels. Subsequent range requests are cheap; a cold/evicted series pays the full read again. An optional disposable cache outside `.aim` could reduce repeat cold costs, but is not required for the initial design and is not a replacement source of truth.

Six complete step/value reads in the largest three registered run directories took roughly 10–35 ms per series with warm local filesystem caches, for 1,701–5,237 points. These encouraging examples are not cold-disk measurements or a benchmark of all 20,326 series. This architecture should load selected, visible metrics progressively, not fully decode the whole repository at startup.

Live runs require explicit refresh semantics: ordinary read-only RocksDB handles represent a static view. Reopen them on invalidation, or investigate supported secondary-reader catch-up. Do not assume a permanent read handle sees new points, or that a monotonically increasing last step proves old values unchanged. Use short freshness windows/generations for active runs and revalidate metadata and sequence consistency. Incremental client updates can still help even if the storage reader occasionally rescans a selected series. Avoid copying Aim's normal launcher into the new read service: it starts indexing/status managers, and normal read optimization may temporarily open databases for writing. Those maintenance behaviors are not prerequisites for the proposed viewer.

The tradeoff is product scope. A focused viewer needs run selection, metric/context selection, comparison, grouping, zoom, exact hover/export, and live refresh. Reimplementing Aim's arbitrary Python query semantics, dashboards, tags/editing, images/audio, aggregation options, and saved URLs would substantially expand the project. Define that boundary before choosing a full replacement.

**Recommended validation sequence.** Fix the descriptor health check and the small alignment bugs first. Then build a narrow vertical slice with the same selected runs and two representative metrics: complete reader, bounded cache, overview/detail API, and virtualized Canvas charts. Compare it to existing Aim with the same query and device. This tests the expensive architectural assumptions before deciding whether to embed the components in Aim or ship a separate viewer.

Acceptance criteria should include: the demonstrated 0.342891 loss peak survives overview reduction; zoom returns every original point; zeros, NaNs, sparse contexts, and unequal x grids retain correct semantics; repeated queries/cancellation plateau in descriptors and memory; a health check succeeds under a controlled 1,024-descriptor limit; active writes become visible without source modification. Measure cold/warm query latency, bytes transferred, peak heap/RSS, descriptor high-water mark, main-thread long tasks, and scroll/hover latency at 10, 50, and all registered runs. Smooth scrolling should remain independent of the number of offscreen charts. These are proposed acceptance tests, not performance results already achieved.
