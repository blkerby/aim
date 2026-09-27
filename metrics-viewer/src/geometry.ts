import type { Domain, Metric, View } from './types';

export function formatHoverValue(value: number): string {
  const magnitude = Math.abs(value);
  return value.toLocaleString(undefined, {
    minimumSignificantDigits: 3, maximumSignificantDigits: 5, useGrouping: false,
    notation: magnitude >= 1e5 || (magnitude > 0 && magnitude < .001) ? 'scientific' : 'standard',
  });
}

export function extent(metric: Metric): Domain | null {
  const points = Object.values(metric.runs).flatMap(r => [r.firstStep, r.lastStep]).filter((v): v is number => v != null && Number.isFinite(v));
  if (!points.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const x of points) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  return [lo, hi];
}
export function normalized(d: Domain): Domain { return d[0] === d[1] ? [d[0] - 0.5, d[1] + 0.5] : d; }
export function displayDomain(view: View, full: Domain): Domain {
  if (!view.domain) return normalized(full);
  return [view.domain[0], view.follow ? Math.max(view.domain[1], full[1]) : view.domain[1]];
}
export function includesLatest(d: Domain, full: Domain): boolean {
  return d[0] <= full[1] && d[1] >= full[1] - Math.max(1, Math.abs(full[1])) * 1e-10;
}
// Quantize to inclusive physical pixel rows before connecting. Stop one row
// short of the preceding interval so adjacent columns meet diagonally.
// The previous ORIGINAL interval is used; extensions must never cascade.
export function connectedInterval(top: number, bottom: number, prevTop: number, prevBottom: number): Domain {
  top = Math.floor(top); bottom = Math.floor(bottom);
  prevTop = Math.floor(prevTop); prevBottom = Math.floor(prevBottom);
  if (Number.isFinite(prevTop)) {
    if (top > prevBottom + 1) top = prevBottom + 1;
    else if (bottom < prevTop - 1) bottom = prevTop - 1;
  }
  return [top, bottom];
}
export function runColor(id: string, dark = false): string {
  let hash = 2166136261;
  for (const ch of id) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return `hsl(${(hash >>> 0) % 360} ${dark ? "72% 68%" : "61% 43%"})`;
}
export const defaultView = (): View => ({ domain: null, follow: true, scale: 'linear' });
export function contextLabel(metric: Metric): string {
  return Object.entries(metric.context).map(([k, v]) => `${k}=${String(v)}`).join(' · ');
}
