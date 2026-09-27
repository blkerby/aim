import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Domain, Metric, Run, View } from './types';
import { contextLabel, defaultView, displayDomain, extent, includesLatest, runColor } from './geometry';
import { useSize } from './hooks';
import Chart from './Chart';

function CheckList({ items, selected, onToggle }: { items: { id: string; label: string; detail: string; color?: string }[]; selected: string[]; onToggle: (id: string) => void }) {
  const [host, size] = useSize<HTMLDivElement>();
  const [scroll, setScroll] = useState(0);
  const itemKey = items.map(item => item.id).join('|');
  useEffect(() => { if (host.current) host.current.scrollTop = 0; setScroll(0); }, [itemKey]);
  const start = Math.max(0, Math.floor(scroll / 48) - 3), end = Math.min(items.length, Math.ceil((scroll + size.height) / 48) + 3);
  return <div className="check-list" ref={host} onScroll={e => setScroll(e.currentTarget.scrollTop)}><div style={{ height: items.length * 48, position: 'relative' }}>
    {items.slice(start, end).map((item, index) => <label className={`check-row ${selected.includes(item.id) ? 'selected' : ''}`} key={item.id} style={{ top: (start + index) * 48 }}>
      <input type="checkbox" checked={selected.includes(item.id)} onChange={() => onToggle(item.id)} aria-label={item.label + (item.detail ? ` · ${item.detail}` : '')} />
      {item.color && <i className="run-dot" style={{ background: item.color }} />}
      <span><strong title={item.label}>{item.label}</strong>{item.detail && <small title={item.detail}>{item.detail}</small>}</span>
    </label>)}
  </div>{!items.length && <p className="list-empty">No matches</p>}</div>;
}

const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
const unique = (ids: string[]) => [...new Set(ids)];
const ROW_HEIGHT = 364;
const LAYOUT_KEY = 'aim-viewer:layout';
function savedLayout() {
  const defaults = { collapsed: false, columns: window.innerWidth >= 1150 ? 2 : 1 };
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
    return { collapsed: stored.collapsed === true,
      columns: Number.isInteger(stored.columns) && stored.columns >= 1 && stored.columns <= 5 ? stored.columns : defaults.columns };
  } catch { return defaults; }
}

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const [layout, setLayout] = useState(savedLayout);
  const { collapsed, columns } = layout;
  const [runs, setRuns] = useState<Run[]>([]), [metrics, setMetrics] = useState<Metric[]>([]);
  const [repo, setRepo] = useState('');
  const [selectedRuns, setSelectedRuns] = useState<string[]>([]), [selectedMetrics, setSelectedMetrics] = useState<string[]>([]);
  const [runSearch, setRunSearch] = useState(''), [metricSearch, setMetricSearch] = useState('');
  const [views, setViews] = useState<Record<string, View>>({});
  const [linked, setLinked] = useState(false), [linkedView, setLinkedView] = useState(defaultView);
  const [paused, setPaused] = useState(false), [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(''), loadedRepo = useRef('');
  const lastCatalogRequest = useRef('');
  const [grid, gridSize] = useSize<HTMLDivElement>();
  const [scroll, setScroll] = useState(0);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('aim-viewer:theme', theme); } catch { /* Storage may be disabled. */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--page-bg').trim());
  }, [theme]);
  const selectedKey = selectedRuns.join('|');

  useEffect(() => {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* Storage may be disabled. */ }
  }, [layout]);

  useEffect(() => {
    let alive = true, pending = false;
    const controller = new AbortController();
    const update = async () => {
      if (pending || document.hidden) return;
      pending = true; setBusy(true);
      try {
        const r = await fetch('/api/runs', { signal: controller.signal });
        if (!r.ok) throw new Error(`Run list failed (${r.status})`);
        const catalog = await r.json(); if (!alive) return;
        setRuns(catalog.runs); setRepo(catalog.repo);
        if (loadedRepo.current !== catalog.repo) {
          loadedRepo.current = catalog.repo;
          try {
            const stored = JSON.parse(localStorage.getItem(`aim-viewer:${catalog.repo}`) || '{}');
            const available = new Set(catalog.runs.map((run: Run) => run.id));
            if (Array.isArray(stored.runs)) setSelectedRuns(stored.runs.filter((id: string) => available.has(id)));
            if (Array.isArray(stored.metrics)) setSelectedMetrics(stored.metrics.filter((id: unknown) => typeof id === 'string'));
            if (stored.scales && typeof stored.scales === 'object') setViews(Object.fromEntries(Object.entries(stored.scales).map(([id, scale]) => [id, { ...defaultView(), scale: scale === 'log' ? 'log' : 'linear' }])));
          } catch { /* Invalid or unavailable local storage must not prevent use. */ }
        }
        const validIds = new Set(catalog.runs.map((run: Run) => run.id));
        const requested = selectedRuns.filter(id => validIds.has(id));
        if (requested.length !== selectedRuns.length) setSelectedRuns(requested);
        if (requested.length) {
          const m = await fetch('/api/metrics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runs: requested }), signal: controller.signal });
          if (!m.ok) throw new Error(`Metric list failed (${m.status})`);
          const data = await m.json(); if (!alive) return;
          setMetrics(data.metrics);
          setError(data.errors.length ? `${data.errors.length} runs could not be read. ${data.errors[0].error}` : '');
        } else { setMetrics([]); setError(''); }
      } catch (err) { if (alive && !controller.signal.aborted) setError(String(err)); }
      finally { pending = false; if (alive) setBusy(false); }
    };
    const requestKey = JSON.stringify([selectedKey, refresh]);
    // Pausing cancels polling without initiating one final refresh. Explicit
    // refreshes and selection changes still work while polling is paused.
    if (!paused || lastCatalogRequest.current !== requestKey) update();
    else setBusy(false);
    lastCatalogRequest.current = requestKey;
    const timer = paused ? undefined : setInterval(update, 5000);
    const resume = () => { if (!document.hidden && !paused) update(); };
    document.addEventListener('visibilitychange', resume);
    return () => { alive = false; controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', resume); };
  }, [selectedKey, paused, refresh]);

  useEffect(() => {
    if (!repo) return;
    try { localStorage.setItem(`aim-viewer:${repo}`, JSON.stringify({ runs: selectedRuns, metrics: selectedMetrics, scales: Object.fromEntries(Object.entries(views).map(([id, view]) => [id, view.scale])) })); } catch { /* Storage may be disabled. */ }
  }, [repo, selectedRuns, selectedMetrics, views]);

  const chosenRuns = useMemo(() => runs.filter(r => selectedRuns.includes(r.id)), [runs, selectedKey]);
  const chosenMetrics = useMemo(() => metrics.filter(m => selectedMetrics.includes(m.id)), [metrics, selectedMetrics]);
  const globalExtent = useMemo<Domain>(() => {
    const extents = chosenMetrics.map(extent).filter((d): d is Domain => !!d);
    return extents.length ? [Math.min(...extents.map(d => d[0])), Math.max(...extents.map(d => d[1]))] : [0, 1];
  }, [chosenMetrics]);

  // Persist expanding right bounds so a temporarily missing/shorter run cannot
  // make a following historical window contract on a later poll.
  useEffect(() => {
    setViews(old => {
      let next = old;
      for (const metric of chosenMetrics) {
        const view = old[metric.id], full = extent(metric);
        if (view?.follow && view.domain && full && full[1] > view.domain[1]) {
          if (next === old) next = { ...old };
          next[metric.id] = { ...view, domain: [view.domain[0], full[1]] };
        }
      }
      return next;
    });
    setLinkedView(old => old.follow && old.domain && globalExtent[1] > old.domain[1] ? { ...old, domain: [old.domain[0], globalExtent[1]] } : old);
  }, [chosenMetrics, globalExtent]);

  const changeRuns = (next: string[]) => {
    setSelectedRuns(next);
    setViews(old => Object.fromEntries(Object.entries(old).map(([id, v]) => [id, { ...v, domain: null, follow: true }])));
    setLinkedView(defaultView());
  };
  const changeView = (id: string, next: View) => {
    const current = views[id] || defaultView();
    if (linked && current.scale === next.scale) setLinkedView({ ...next });
    setViews(old => ({ ...old, [id]: next }));
  };
  const toggleLinked = () => {
    if (!linked) {
      const metric = chosenMetrics.find(m => m.id === active.current) || chosenMetrics[0];
      const view = metric ? views[metric.id] || defaultView() : defaultView();
      const domain = displayDomain(view, metric ? extent(metric) || [0, 1] : [0, 1]);
      setLinkedView({ ...view, domain, follow: includesLatest(domain, globalExtent) });
    } else {
      const domain = displayDomain(linkedView, globalExtent);
      setViews(old => ({ ...old, ...Object.fromEntries(chosenMetrics.map(m => [m.id, { ...(old[m.id] || defaultView()), domain, follow: linkedView.follow }])) }));
    }
    setLinked(!linked);
  };
  const runItems = useMemo(() => runs.filter(r => `${r.name} ${r.id} ${r.experiment || ''}`.toLowerCase().includes(runSearch.toLowerCase())).map(r => ({ id: r.id, label: r.name || r.id.slice(0, 12), detail: `${r.createdAt.slice(0, 10)} · ${r.id.slice(0, 8)}${r.archived ? ' · archived' : ''}`, color: runColor(r.id, theme === 'dark') })), [runs, runSearch, theme]);
  const metricItems = useMemo(() => metrics.filter(m => `${m.name} ${contextLabel(m)}`.toLowerCase().includes(metricSearch.toLowerCase())).map(m => ({ id: m.id, label: m.name, detail: contextLabel(m) })), [metrics, metricSearch]);
  const totalRows = Math.ceil(chosenMetrics.length / columns);
  const start = Math.max(0, Math.floor(scroll / ROW_HEIGHT) - 1), end = Math.min(totalRows, Math.ceil((scroll + gridSize.height) / ROW_HEIGHT) + 1);
  useEffect(() => { if (grid.current) { const limit = Math.max(0, totalRows * ROW_HEIGHT - gridSize.height); if (grid.current.scrollTop > limit) grid.current.scrollTop = limit; } }, [totalRows, gridSize.height]);
  const focusChart = useCallback((id: string) => { active.current = id; }, []);
  const changeColumns = (columns: number) => {
    setLayout(old => ({ ...old, columns }));
    if (grid.current) grid.current.scrollTop = 0;
    setScroll(0);
  };

  return <div className="app-shell">
    <div className="workspace">
      <aside className="sidebar" id="selectors" hidden={collapsed}>
        <section className="selector"><div className="section-title"><h2>Runs <span>{runs.length}</span></h2><span>{selectedRuns.length} selected</span></div>
          <input className="search" aria-label="Search runs" placeholder="Search name, hash, experiment…" value={runSearch} onChange={e => setRunSearch(e.target.value)} />
          <div className="selection-actions"><button onClick={() => changeRuns(unique([...selectedRuns, ...runItems.map(r => r.id)]))}>Select filtered</button><button onClick={() => changeRuns([])}>Clear</button></div>
          <CheckList items={runItems} selected={selectedRuns} onToggle={id => changeRuns(toggle(selectedRuns, id))} />
        </section>
        <section className="selector metrics-selector"><div className="section-title"><h2>Metrics <span>{metrics.length}</span></h2><span>{chosenMetrics.length} selected</span></div>
          <input className="search" aria-label="Search metrics" placeholder="Search metric or context…" value={metricSearch} onChange={e => setMetricSearch(e.target.value)} disabled={!selectedRuns.length} />
          <div className="selection-actions"><button onClick={() => setSelectedMetrics(unique([...selectedMetrics, ...metricItems.map(m => m.id)]))}>Select filtered</button><button onClick={() => setSelectedMetrics([])}>Clear</button></div>
          {!selectedRuns.length ? <p className="selector-hint">Choose a run to see its metrics.</p> : <CheckList items={metricItems} selected={selectedMetrics} onToggle={id => setSelectedMetrics(toggle(selectedMetrics, id))} />}
        </section>
      </aside>
      <main className="main-panel">
        <div className="toolbar"><div className="toolbar-start">
          <button className="button sidebar-toggle" aria-label={collapsed ? 'Expand side panel' : 'Collapse side panel'} title={collapsed ? 'Expand side panel' : 'Collapse side panel'} aria-expanded={!collapsed} aria-controls="selectors" onClick={() => setLayout(old => ({ ...old, collapsed: !old.collapsed }))}>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2" /><path d="M7 3v14" /><path d={collapsed ? 'm11 7 3 3-3 3' : 'm14 7-3 3 3 3'} /></svg>
          </button>
          <h2>Metric histories <span>{chosenMetrics.length ? `${chosenMetrics.length} charts` : ''}</span></h2></div>
          <div className="toolbar-actions">
            <label className="column-select">Per row <select className="button" aria-label="Charts per row" value={columns} onChange={e => changeColumns(Number(e.target.value))}>{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
            <label className="link-toggle"><input type="checkbox" checked={linked} onChange={toggleLinked} /> Link x-axes</label>
            <button className="button" onClick={() => setPaused(!paused)}>{paused ? '▶ Resume' : 'Ⅱ Pause'}</button><button className="button refresh-button" disabled={busy} onClick={() => setRefresh(x => x + 1)} aria-label="Refresh now" title="Refresh now">↻</button>
            <button className="button theme-toggle" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-pressed={theme === 'dark'} onClick={() => setTheme(old => old === 'dark' ? 'light' : 'dark')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {theme === 'dark' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></> : <path d="M20.5 14A8.7 8.7 0 0 1 10 3.5 8.7 8.7 0 1 0 20.5 14Z" />}
              </svg>
            </button></div>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="chart-scroll" ref={grid} onScroll={e => setScroll(e.currentTarget.scrollTop)}>
          {!chosenMetrics.length ? <div className="welcome"><p>{busy ? 'Loading…' : selectedRuns.length ? 'Select metrics to display.' : 'Select runs to begin.'}</p></div> :
            <div className="virtual-charts" style={{ height: totalRows * ROW_HEIGHT, minWidth: columns * 200 + (columns - 1) * 16 }}>
              {Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset).map(row => <div className="chart-row" key={row} style={{ top: row * ROW_HEIGHT, gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                {chosenMetrics.slice(row * columns, (row + 1) * columns).map(metric => {
                  const own = views[metric.id] || defaultView();
                  return <Chart theme={theme} key={metric.id} metric={metric} runs={chosenRuns} view={linked ? { ...linkedView, scale: own.scale } : own} full={linked ? globalExtent : extent(metric) || [0, 1]} refresh={refresh} onView={next => changeView(metric.id, next)} onFocus={() => focusChart(metric.id)} />;
                })}
              </div>)}
            </div>}
        </div>
      </main>
    </div>
  </div>;
}
