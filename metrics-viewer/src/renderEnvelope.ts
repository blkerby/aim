import { connectedInterval } from './geometry';
import type { Summary } from './types';

interface Node { column: number; x: number; top: number; bottom: number; dense: boolean }
export interface Painter {
  vertical(x: number, top: number, bottom: number): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  point(x: number, y: number): void;
}

/** Hybrid local rendering: singleton points, sparse lines, dense envelopes.
 * All coordinates are physical pixels. Dense bins retain only min/max.
 */
export function paintEnvelope(row: Summary, x0: number, xScale: (x: number) => number, yScale: (y: number) => number, painter: Painter, columnWidth = 1) {
  let previous: Node | null = null;
  function visit(node: Node, draw = true) {
    const prev = previous;
    if (prev && prev.dense && node.dense && node.column === prev.column + 1) {
      const [top, bottom] = connectedInterval(node.top, node.bottom, prev.top, prev.bottom);
      if (draw) painter.vertical(Math.floor(node.x), Math.floor(top), Math.floor(bottom));
    } else {
      if (prev) {
        let from: number, to: number;
        if (node.top > prev.bottom) { from = prev.bottom; to = node.top; }
        else if (node.bottom < prev.top) { from = prev.top; to = node.bottom; }
        else { from = to = (Math.max(node.top, prev.top) + Math.min(node.bottom, prev.bottom)) / 2; }
        painter.line(prev.x, from, node.x, to);
      }
      if (draw) {
        if (node.dense) painter.vertical(Math.floor(node.x), Math.floor(node.top), Math.floor(node.bottom));
        else painter.point(node.x, node.top);
      }
    }
    previous = node; // Original interval, never its connected extension.
  }
  const [left, right] = row.boundaries;
  if (left) visit({ column: -1, x: xScale(left[0]), top: yScale(left[1]), bottom: yScale(left[1]), dense: false }, false);
  for (let i = 0; i < row.width; i++) {
    if (row.breaks[i]) previous = null;
    if (row.counts[i] && Number.isFinite(row.low[i]) && Number.isFinite(row.high[i])) {
      visit({ column: i, x: row.counts[i] === 1 ? xScale(row.sampleX[i]) : x0 + (i + 0.5) * columnWidth,
        top: yScale(row.high[i]), bottom: yScale(row.low[i]), dense: row.counts[i] > 1 });
    }
    if (row.breaks[i]) previous = null;
  }
  if (right) visit({ column: row.width, x: xScale(right[0]), top: yScale(right[1]), bottom: yScale(right[1]), dense: false }, false);
}
