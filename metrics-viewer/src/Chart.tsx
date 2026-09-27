import { useEffect, useMemo, useRef, useState } from 'react';
import { scaleLinear, scaleLog } from 'd3-scale';
import type { Domain, Metric, Run, SeriesSpec, Summary, View } from './types';
import { contextLabel, displayDomain, formatHoverValue, includesLatest, runColor } from './geometry';
import { paintEnvelope } from './renderEnvelope';
import { getCached, loadSeries, putCached } from './data';
import { useSize } from './hooks';
import { buildPickIndex, pickPoint } from './pickPoint';

const LEFT = 64, RIGHT = 16, TOP = 12, BOTTOM = 30;
const number = (value: number) => Math.abs(value) >= 1e5 || (Math.abs(value) > 0 && Math.abs(value) < 0.001) ? value.toExponential(2) : Number(value.toPrecision(5)).toLocaleString();

const EMPTY_ROWS: Summary[] = [];
interface Snapshot { spec: SeriesSpec; rows: Summary[] }

interface Props {
  metric: Metric; runs: Run[]; view: View; full: Domain; refresh: number;
  onView: (view: View) => void; onFocus: () => void;
}
export default function Chart({ metric, runs, view, full, refresh, onView, onFocus }: Props) {
  const [host, size] = useSize<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const requestedDomain = displayDomain(view, full);
  const width = Math.max(1, Math.round(size.width * size.dpr) - Math.round((LEFT + RIGHT) * size.dpr));
  const runIds = runs.filter(r => metric.runs[r.id]).map(r => r.id);
  const spec: SeriesSpec = { runs: runIds, metric: metric.id, domain: requestedDomain, width, scale: view.scale };
  const specKey = JSON.stringify(spec);
  const revision = runIds.map(id => metric.runs[id].revision).join('|');
  const key = specKey + revision + refresh;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const rows = snapshot?.rows || EMPTY_ROWS;
  const domain = snapshot?.spec.domain || requestedDomain;
  const scale = snapshot?.spec.scale || view.scale;
  const dataWidth = snapshot?.spec.width || width;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState<Domain | null>(null);
  const dragRef = useRef<Domain | null>(null);
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;

  useEffect(() => {
    if (!size.width) return;
    const cached = getCached(key);
    if (cached) { setSnapshot({ spec, rows: cached }); setError(''); setLoading(false); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const previous = snapshotRef.current;
    const compatible = previous && JSON.stringify(previous.spec) === specKey;
    // Keep the complete displayed snapshot (including axes) during refresh.
    // Never combine summaries produced for different pixel bins or domains.
    const current = new Map((compatible ? previous.rows : []).map(row => [row.run, row]));
    setLoading(true); setError('');
    let failed = false;
    const publish = () => {
      timer = undefined;
      if (!cancelled && !(failed && previous && !compatible)) {
        setSnapshot({ spec, rows: [...current.values()] });
       
      }
    };
    const cancel = loadSeries(spec, event => {
      if (cancelled) return;
      if (event.type === 'series') {
        const row = event.summary!;
        if (row.status === 'ok') current.set(row.run, row);
        else if (row.status === 'missing') current.delete(row.run);
        else { failed = true; setError(row.error || 'Could not read this run'); }
        // First loads remain progressive; refreshes commit once all runs arrive.
        if (!previous && !timer) timer = setTimeout(publish, 80);
      } else if (event.type === 'error') {
        failed = true; setError(event.error!); setLoading(false);
        if (timer) clearTimeout(timer);
        publish();
      } else {
        if (timer) clearTimeout(timer); publish(); setLoading(false);
        if (!failed) putCached(key, [...current.values()]);
      }
    });
    return () => { cancelled = true; cancel(); if (timer) clearTimeout(timer); };
    // key represents every input; avoid cancelling a stream on unrelated UI renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, !!size.width]);

  const visibleRows = rows;
  const yScale = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const row of rows) if (row.bounds) { lo = Math.min(lo, row.bounds[0]); hi = Math.max(hi, row.bounds[1]); }
    if (!Number.isFinite(lo)) { lo = scale === 'log' ? 0.1 : 0; hi = 1; }
    if (scale === 'log') {
      const padding = Math.max(0.03, (Math.log10(hi) - Math.log10(lo)) * 0.06);
      return scaleLog().domain([10 ** (Math.log10(lo) - padding), 10 ** (Math.log10(hi) + padding)]).range([size.height - BOTTOM, TOP]);
    }
    const padding = (hi - lo || Math.abs(lo) || 1) * 0.06;
    return scaleLinear().domain([lo - padding, hi + padding]).range([size.height - BOTTOM, TOP]);
  }, [rows, scale, size.height]);

  useEffect(() => {
    const node = canvas.current; if (!node || !size.width || !size.height) return;
    node.width = Math.round(size.width * size.dpr); node.height = Math.round(size.height * size.dpr);
    const ctx = node.getContext('2d')!;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.font = '11px ui-monospace, SFMono-Regular, monospace'; ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    let yTicks = yScale.ticks(5);
    if (yTicks.length > 8) yTicks = yTicks.filter((_, i) => i % Math.ceil(yTicks.length / 8) === 0);
    for (const value of yTicks) {
      const y = yScale(value); ctx.strokeStyle = '#e8ece9'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(LEFT, y); ctx.lineTo(size.width - RIGHT, y); ctx.stroke();
      ctx.fillStyle = '#758078'; ctx.fillText(number(value), LEFT - 9, y);
    }
    const xScale = scaleLinear().domain(domain).range([LEFT, size.width - RIGHT]);
    ctx.textAlign = 'center';
    for (const value of xScale.ticks(Math.max(2, Math.floor((size.width - LEFT - RIGHT) / 100)))) {
      ctx.fillStyle = '#758078'; ctx.fillText(number(value), xScale(value), size.height - 12);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(LEFT, TOP, size.width - LEFT - RIGHT, size.height - TOP - BOTTOM); ctx.clip();
    // Dense bins are pixel rectangles; local sparse samples use true sloped
    // line segments. No global point-count threshold or first/last reduction.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const x0 = Math.round(LEFT * size.dpr);
    ctx.globalAlpha = visibleRows.length > 20 ? 0.6 : 0.82;
    for (const row of visibleRows) {
      ctx.fillStyle = runColor(row.run);
      ctx.strokeStyle = runColor(row.run); ctx.lineWidth = size.dpr; ctx.beginPath();
      paintEnvelope(row, x0, value => (xScale(value) * size.dpr), value => (yScale(value) * size.dpr), {
        vertical: (x, top, bottom) => ctx.fillRect(x, top, Math.max(1, width / dataWidth), Math.max(1, bottom - top + 1)),
        line: (x1, y1, x2, y2) => { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); },
        point: (x, y) => ctx.fillRect(Math.min(x0 + width - 1, Math.max(x0, Math.floor(x))), Math.floor(y), 1, 1),
      }, width / dataWidth);
      ctx.stroke();
    }
    ctx.restore();
  }, [snapshot, size.width, size.height, size.dpr, yScale]);

  const index = useMemo(() => buildPickIndex(rows, LEFT, size.width - LEFT - RIGHT, yScale), [rows, size.width, yScale]);
  const [pointer, setPointer] = useState<Domain | null>(null);
  const pendingPointer = useRef<Domain | null>(null);
  const hoverFrame = useRef(0);
  const clearHover = () => {
    cancelAnimationFrame(hoverFrame.current); hoverFrame.current = 0;
    pendingPointer.current = null; setPointer(null);
  };
  useEffect(() => () => cancelAnimationFrame(hoverFrame.current), []);
  const picked = useMemo(() => pointer ? pickPoint(index, pointer[0], pointer[1]) : null, [index, pointer]);
  const pickedX = picked?.x || 0, pickedY = picked?.y || 0;
  const stepLabel = picked ? Math.round(picked.step).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '';
  const stepLabelWidth = Math.min(size.width, Math.max(84, stepLabel.length * 6 + 8));
  const valueLabel = picked ? formatHoverValue(picked.value) : '';
  const localX = (clientX: number) => Math.max(0, Math.min(1, (clientX - canvas.current!.getBoundingClientRect().left - LEFT) / (size.width - LEFT - RIGHT)));
  const hasValues = visibleRows.some(row => row.bounds);
  const label = contextLabel(metric);
  return <article className="chart-card" data-metric={metric.name} aria-busy={loading} onPointerDown={onFocus}>
    <header className="chart-heading">
      <div className="chart-title"><h2 title={metric.name}>{metric.name}</h2>{label && <span title={label}>{label}</span>}</div>
      <div className="chart-controls">
        {loading && <span className="spinner tiny" aria-label="Loading" />}
        <div className="segmented" aria-label={`Y scale for ${metric.name}`}>
          <button aria-pressed={view.scale === 'linear'} onClick={() => onView({ ...view, scale: 'linear' })}>Lin</button>
          <button aria-pressed={view.scale === 'log'} onClick={() => onView({ ...view, scale: 'log' })}>Log</button>
        </div>
        <button className="icon-button" aria-label={`Reset zoom for ${metric.name}`} title="Reset zoom" onClick={() => onView({ ...view, domain: null, follow: true })}>↺</button>
      </div>
    </header>
    <div className="plot" ref={host}>
      <canvas ref={canvas} aria-label={`${metric.name} chart, step ${number(domain[0])} to ${number(domain[1])}`} role="img"
        onDoubleClick={() => onView({ ...view, domain: null, follow: true })}
        onPointerDown={event => { if (event.button !== 0) return; const x = localX(event.clientX); dragRef.current = [x, x]; setDrag([x, x]); clearHover(); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => {
          if (dragRef.current) { dragRef.current = [dragRef.current[0], localX(event.clientX)]; setDrag([...dragRef.current]); }
          else {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - rect.left - LEFT) / (size.width - LEFT - RIGHT);
            const y = (event.clientY - rect.top - TOP) / (size.height - TOP - BOTTOM);
            if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
              pendingPointer.current = [event.clientX - rect.left, event.clientY - rect.top];
              if (!hoverFrame.current) hoverFrame.current = requestAnimationFrame(() => {
                hoverFrame.current = 0; setPointer(pendingPointer.current);
              });
            }
            else clearHover();
          }
        }}
        onPointerUp={event => {
          if (!dragRef.current) return;
          const [a, b] = dragRef.current; dragRef.current = null; setDrag(null);
          event.currentTarget.releasePointerCapture(event.pointerId);
          if (Math.abs(a - b) * (size.width - LEFT - RIGHT) > 5) {
            const next: Domain = [domain[0] + Math.min(a, b) * (domain[1] - domain[0]), domain[0] + Math.max(a, b) * (domain[1] - domain[0])];
            onView({ ...view, domain: next, follow: includesLatest(next, full) });
          }
        }}
        onPointerCancel={() => { dragRef.current = null; setDrag(null); clearHover(); }}
        onPointerLeave={() => clearHover()} />
      {visibleRows.map(row => {
        // Use the actual final sample, never the maximum/edge of its envelope.
        const step = row.latestStep, value = row.latestValue;
        if (step == null || value == null || !Number.isFinite(value) || step < domain[0] || step > domain[1] || (scale === 'log' && value <= 0)) return null;
        const run = runs.find(run => run.id === row.run);
        return <span key={row.run} className={`endpoint-marker${run?.active ? ' active' : ''}`} role="img"
          aria-label={`${run?.name || row.run}, latest step ${number(step)}${run?.active ? ', active' : ''}`}
          style={{ left: LEFT + (step - domain[0]) / (domain[1] - domain[0]) * (size.width - LEFT - RIGHT), top: yScale(value), background: runColor(row.run) }} />;
      })}
      {drag && <div className="zoom-selection" style={{ left: LEFT + Math.min(...drag) * (size.width - LEFT - RIGHT), width: Math.abs(drag[1] - drag[0]) * (size.width - LEFT - RIGHT), top: TOP, bottom: BOTTOM }} />}
      {!hasValues && <div className="plot-empty">{loading ? <><span className="spinner" /> Reading histories…</> : scale === 'log' ? 'No positive values in this range' : 'No values in this range'}</div>}
      {picked && <>
        <svg className="hover-guides" width={size.width} height={size.height} role="img"
          aria-label={`Highlighted point for ${runs.find(run => run.id === picked.run)?.name || picked.run}: step ${picked.step}, value ${picked.value}`}>
          <g stroke={runColor(picked.run)} strokeWidth="1" strokeDasharray="4 3" opacity=".8">
            <line className="hover-guide-x" x1={pickedX} y1={pickedY} x2={pickedX} y2={size.height - BOTTOM} />
            <line className="hover-guide-y" x1={LEFT} y1={pickedY} x2={pickedX} y2={pickedY} />
          </g>
          <circle className="hover-point" cx={pickedX} cy={pickedY} r="4" fill={runColor(picked.run)} stroke="white" strokeWidth="1.5" />
        </svg>
        <div className="hover-axis-label hover-x" aria-label={`X value: ${Math.round(picked.step)}`}
          style={{ left: Math.max(0, Math.min(size.width - stepLabelWidth, pickedX - stepLabelWidth / 2)), width: stepLabelWidth, top: size.height - BOTTOM + 6 }}>{stepLabel}</div>
        <div className="hover-axis-label hover-y" aria-label={`Y value: ${picked.value}`}
          style={{ left: 4, width: LEFT - 8, fontSize: Math.min(10, (LEFT - 14) / (valueLabel.length * .61)), top: Math.max(TOP, Math.min(size.height - BOTTOM - 20, pickedY - 10)) }}>{valueLabel}</div>
      </>}

    </div>
    {error && <div className="chart-error" title={error}>Refresh failed · retaining previous data <span>{error}</span></div>}
  </article>;
}
