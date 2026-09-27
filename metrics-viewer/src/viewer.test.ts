import { describe, expect, it } from 'vitest';
import { connectedInterval, defaultView, displayDomain, formatHoverValue, includesLatest } from './geometry';
import { paintEnvelope } from './renderEnvelope';
import { buildPickIndex, pickPoint } from './pickPoint';
import { FrameDecoder } from './protocol';
import type { Summary } from './types';

function summary(counts: number[], low: number[], high = low, sampleX = counts.map((_, i) => i)) {
  return { width: counts.length, counts: new Uint32Array(counts), low: new Float64Array(low), high: new Float64Array(high), sampleX: new Float64Array(sampleX), breaks: new Uint8Array(counts.length), boundaries: [null, null] } as Summary;
}
function paint(row: Summary) {
  const verticals: number[][] = [], lines: number[][] = [], points: number[][] = [];
  paintEnvelope(row, 0, x => x, y => y, {
    vertical: (...v) => verticals.push(v), line: (...v) => lines.push(v), point: (...v) => points.push(v),
  });
  return { verticals, lines, points };
}
describe('local pixel rendering', () => {
  it('connects dense adjacent ranges using original bounds, not cascading extensions', () => {
    // In screen coordinates high is the top, low is the bottom.
    const result = paint(summary([2,2,2], [5,10,2], [2,8,1]));
    expect(result.verticals).toEqual([[0,2,5], [1,6,10], [2,1,7]]);
    expect(result.lines).toHaveLength(0);
    expect(connectedInterval(8,10,2,5)).toEqual([6,10]);
  });
  it('connects after pixel rounding and preserves recorded extrema and real overlaps', () => {
    expect(paint(summary([2,2], [5.9,10.8], [2.2,8.7])).verticals).toEqual([[0,2,5], [1,6,10]]);
    expect(paint(summary([2,2], [10.8,5.9], [8.7,2.2])).verticals).toEqual([[0,8,10], [1,2,7]]);
    // Already diagonally adjacent: neither endpoint needs extending.
    expect(paint(summary([2,2], [5.9,6.9], [5.1,6.1])).verticals).toEqual([[0,5,5], [1,6,6]]);
    // Both bins genuinely contain this pixel row; it must remain in both.
    expect(paint(summary([2,2], [5.9,5.8], [5.1,5.2])).verticals).toEqual([[0,5,5], [1,5,5]]);
  });
  it('draws sparse sloped lines through exact subpixel sample positions', () => {
    const result = paint(summary([1,0,0,1], [2,NaN,NaN,8], undefined, [0.2,NaN,NaN,3.8]));
    expect(result.lines).toEqual([[0.2,2,3.8,8]]);
    expect(result.verticals).toHaveLength(0);
  });
  it('mixes dense columns and sparse lines within a single series', () => {
    const result = paint(summary([2,2,0,0,1], [5,10,NaN,NaN,20], [2,8,NaN,NaN,20], [NaN,NaN,NaN,NaN,4.4]));
    expect(result.verticals).toEqual([[0,2,5], [1,6,10]]);
    expect(result.lines).toEqual([[1.5,10,4.4,20]]);
  });
  it('does not connect across explicit missing values', () => {
    const row = summary([1,0,1], [2,NaN,4]); row.breaks[1] = 1;
    expect(paint(row).lines).toHaveLength(0);
  });
  it('draws the clipped sparse line even when no sample is inside the viewport', () => {
    const row = summary([0,0,0], [NaN,NaN,NaN]); row.boundaries = [[0,2],[3,8]];
    expect(paint(row).lines).toEqual([[0,2,3,8]]);
  });
});
describe('live zoom ranges', () => {
  it('expands the right edge while preserving the left edge', () => {
    expect(displayDomain({ ...defaultView(), domain:[100,200] }, [0,215])).toEqual([100,215]);
  });
  it('does not move a historical range or shrink a following range', () => {
    expect(displayDomain({ ...defaultView(), domain:[100,200], follow:false }, [0,215])).toEqual([100,200]);
    expect(displayDomain({ ...defaultView(), domain:[100,200] }, [0,180])).toEqual([100,200]);
  });
  it('follows only when the latest point is included', () => {
    expect(includesLatest([100,200],[0,200])).toBe(true);
    expect(includesLatest([100,199],[0,200])).toBe(false);
    expect(displayDomain(defaultView(), [0,215])).toEqual([0,215]);
  });
});
describe('binary framing', () => {
  it('decodes across arbitrary network chunk boundaries', () => {
    const header = new TextEncoder().encode(JSON.stringify({ status:'ok', width:1, run:'test' }));
    const payload = new Uint8Array(29); const p = new DataView(payload.buffer);
    p.setFloat64(0, 2, true); p.setFloat64(8, 8, true); p.setFloat64(16, 0.25, true); p.setUint32(24, 1, true);
    const all = new Uint8Array(8 + header.length + payload.length), view = new DataView(all.buffer);
    view.setUint32(0, header.length, true); view.setUint32(4, payload.length, true); all.set(header,8); all.set(payload,8+header.length);
    const decoder = new FrameDecoder(); const results = [];
    for (const byte of all) results.push(...decoder.push(new Uint8Array([byte])));
    decoder.finish();
    expect(results).toHaveLength(1); expect(results[0].sampleX[0]).toBe(.25); expect(results[0].high[0]).toBe(8);
  });
  it('rejects truncated responses', () => {
    const decoder = new FrameDecoder(); decoder.push(new Uint8Array([1,2,3]));
    expect(() => decoder.finish()).toThrow('Incomplete');
  });
});


describe('local summary picking', () => {
  function row(counts: number[], low: number[], high = low, sampleX = counts.map((_, i) => i + .5)) {
    return { ...summary(counts, low, high, sampleX), run: 'run', domain: [0, counts.length] } as Summary;
  }
  it('selects observed dense extrema, not values inside the range or connecting extensions', () => {
    const index = buildPickIndex([row([2, 0, 1], [0, NaN, 4], [10, NaN, 4], [.2, NaN, 2.8])], 0, 300, y => y);
    expect(pickPoint(index, 50, 6)).toMatchObject({ step: .2, value: 10, aggregated: true, x: 50, y: 10 });
    expect(pickPoint(index, 280, 4)).toMatchObject({ step: 2.8, value: 4, aggregated: false });
  });
  it('searches beyond the nearest X and compares all runs in screen space', () => {
    const first = row([1, 1, 1], [100, 0, 0], undefined, [.1, 1.1, 2.1]);
    expect(pickPoint(buildPickIndex([first], 0, 3, y => y), .1, 0)?.step).toBe(1.1);
    const second = { ...row([1, 0, 0], [0, NaN, NaN]), run: 'other' };
    expect(pickPoint(buildPickIndex([first, second], 0, 3, y => y), .1, 0)?.run).toBe('other');
  });
  it('uses logarithmic Y distance and ignores gaps and synthetic boundary points', () => {
    const values = row([1, 1], [1, 100]);
    expect(pickPoint(buildPickIndex([values], 0, 2, Math.log10), 1, .8)?.value).toBe(1);
    expect(pickPoint(buildPickIndex([values], 0, 2, y => y), 1, 60)?.value).toBe(100);
    const empty = row([0, 0], [NaN, NaN]); empty.boundaries = [[0, 1], [2, 2]];
    expect(pickPoint(buildPickIndex([empty], 0, 100, y => y), 50, 1.5)).toBeNull();
  });
});

it('formats Y labels with at least three significant figures without rounding small decimals away', () => {
  expect(formatHoverValue(.005)).toBe('0.00500');
  expect(formatHoverValue(.0051234)).toBe('0.0051234');
  expect(formatHoverValue(1)).toBe('1.00');
  expect(formatHoverValue(0)).toBe('0.00');
  expect(formatHoverValue(-.005)).toBe('-0.00500');
  expect(formatHoverValue(.000005)).toBe('5.00E-6');
  expect(formatHoverValue(1000000)).toBe('1.00E6');
});
