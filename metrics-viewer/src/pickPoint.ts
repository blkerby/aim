import type { Summary } from './types';

export interface PickedPoint { run: string; step: number; value: number; x: number; y: number; aggregated: boolean }
interface IndexedRow { row: Summary; bins: number[]; x: Float64Array; lowY: Float64Array; highY: Float64Array }
const HOVER_RADIUS = 20; // CSS pixels, independent of device pixel ratio.

/** Build once per displayed snapshot/size/scale; pointer motion only searches
 * cached screen coordinates, never the server or the Canvas curves. */
export function buildPickIndex(rows: Summary[], left: number, plotWidth: number, yScale: (y: number) => number): IndexedRow[] {
  return rows.map(row => {
    const bins = Array.from(row.counts.keys()).filter(i => row.counts[i] && Number.isFinite(row.low[i]) && Number.isFinite(row.high[i]));
    return { row, bins,
      x: Float64Array.from(bins, i => left + plotWidth * (row.counts[i] === 1
        ? (row.sampleX[i] - row.domain[0]) / (row.domain[1] - row.domain[0]) : (i + .5) / row.width)),
      lowY: Float64Array.from(bins, i => yScale(row.low[i])),
      highY: Float64Array.from(bins, i => yScale(row.high[i])),
    };
  });
}

export function pickPoint(index: IndexedRow[], x: number, y: number): PickedPoint | null {
  let best: PickedPoint | null = null, distance = HOVER_RADIUS ** 2;
  for (const entry of index) {
    const { row, bins, x: xs, lowY, highY } = entry;
    let lo = 0, hi = xs.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (xs[mid] < x) lo = mid + 1; else hi = mid; }
    let left = lo - 1, right = lo;
    // Walk outward in X, stopping as soon as the horizontal distance alone
    // exceeds the best 2D distance. This also searches past a nearby-X spike.
    while (left >= 0 || right < xs.length) {
      const dl = left >= 0 ? Math.abs(xs[left] - x) : Infinity;
      const dr = right < xs.length ? Math.abs(xs[right] - x) : Infinity;
      const dx = Math.min(dl, dr);
      if (dx * dx > distance) break;
      const j = dl <= dr ? left-- : right++;
      const bin = bins[j];
      for (const [value, py] of [[row.low[bin], lowY[j]], [row.high[bin], highY[j]]]) {
        const d = dx * dx + (py - y) ** 2;
        if (d < distance || (best === null && d === distance)) {
          distance = d;
          const aggregated = row.counts[bin] > 1;
          best = { run: row.run, value, x: xs[j], y: py, aggregated,
            // Older servers left dense X entries empty; keep an integer
            // fallback until their summaries have been upgraded.
            step: Number.isFinite(row.sampleX[bin]) ? row.sampleX[bin]
              : Math.round(row.domain[0] + (bin + .5) / row.width * (row.domain[1] - row.domain[0])) };
        }
      }
    }
  }
  return best;
}
