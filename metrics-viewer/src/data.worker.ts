import { FrameDecoder } from './protocol';
import type { SeriesSpec } from './types';

const controllers = new Map<number, AbortController>();
const queue: { id: number; spec: SeriesSpec }[] = [];
let running = 0;
self.onmessage = (event) => {
  const { type, id, spec } = event.data;
  if (type === 'cancel') {
    controllers.get(id)?.abort();
    const index = queue.findIndex(job => job.id === id);
    if (index !== -1) queue.splice(index, 1);
  } else { queue.push({ id, spec }); pump(); }
};
function pump() {
  while (running < 2 && queue.length) {
    const job = queue.shift()!;
    running++;
    load(job.id, job.spec).finally(() => { running--; pump(); });
  }
}
async function load(id: number, spec: SeriesSpec) {
  const controller = new AbortController(); controllers.set(id, controller);
  try {
    const response = await fetch('/api/series', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec), signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Series request failed (${response.status})`);
    const reader = response.body.getReader(), decoder = new FrameDecoder();
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      for (const summary of decoder.push(value)) {
        const transfers = summary.status === 'ok' ? [summary.low.buffer, summary.high.buffer, summary.sampleX.buffer, summary.counts.buffer, summary.breaks.buffer] : [];
        self.postMessage({ id, type: 'series', summary }, { transfer: transfers });
      }
    }
    decoder.finish(); self.postMessage({ id, type: 'done' });
  } catch (error) {
    if (!controller.signal.aborted) self.postMessage({ id, type: 'error', error: String(error) });
  } finally { controllers.delete(id); }
}
