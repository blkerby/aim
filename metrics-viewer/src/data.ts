import type { SeriesSpec, Summary } from './types';

const worker = new Worker(new URL('./data.worker.ts', import.meta.url), { type: 'module' });
let nextId = 0;
type Event = { type: 'series' | 'done' | 'error'; summary?: Summary; error?: string };
const callbacks = new Map<number, (event: Event) => void>();
worker.onmessage = ({ data }) => { callbacks.get(data.id)?.(data); if (data.type === 'done' || data.type === 'error') callbacks.delete(data.id); };
export function loadSeries(spec: SeriesSpec, callback: (event: Event) => void): () => void {
  const id = ++nextId; callbacks.set(id, callback); worker.postMessage({ id, type: 'load', spec });
  return () => { callbacks.delete(id); worker.postMessage({ id, type: 'cancel' }); };
}

// Cache viewport results, not raw histories. Active charts pin their own data;
// unmounted charts release it, and this LRU is the only retained offscreen data.
const cache = new Map<string, { rows: Summary[]; bytes: number }>();
let bytes = 0;
const LIMIT = 128 * 1024 * 1024;
export function getCached(key: string): Summary[] | undefined {
  const entry = cache.get(key);
  if (entry) { cache.delete(key); cache.set(key, entry); }
  return entry?.rows;
}
export function putCached(key: string, rows: Summary[]) {
  if (cache.has(key)) { bytes -= cache.get(key)!.bytes; cache.delete(key); }
  const size = key.length * 2 + rows.length * 512 + rows.reduce((sum, row) => sum + (row.status === 'ok' ? row.low.byteLength + row.high.byteLength + row.sampleX.byteLength + row.counts.byteLength + row.breaks.byteLength : 0), 0);
  if (size > LIMIT) return;
  while (cache.size && (bytes + size > LIMIT || cache.size >= 256)) {
    const oldest = cache.keys().next().value!; bytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
  }
  cache.set(key, { rows, bytes: size }); bytes += size;
}
