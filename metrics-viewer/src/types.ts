export type Domain = [number, number];
export type Scale = 'linear' | 'log';
export interface Run { id: string; name: string; createdAt: string; archived: boolean; active: boolean; experiment: string | null }
export interface Metric {
  id: string; name: string; context: Record<string, unknown>;
  runs: Record<string, { firstStep: number | null; lastStep: number | null; revision: string }>;
}
export interface View { domain: Domain | null; follow: boolean; scale: Scale }
export interface Summary {
  run: string; status: 'ok' | 'error' | 'missing'; error?: string;
  width: number; domain: Domain; scale: Scale; bounds: Domain | null;
  rawCount: number; invalidCount: number; totalCount: number; latestStep: number | null; latestValue: number | null;
  boundaries: [Domain | null, Domain | null];
  revision: string; low: Float64Array; high: Float64Array; sampleX: Float64Array; counts: Uint32Array; breaks: Uint8Array;
}
export interface SeriesSpec { runs: string[]; metric: string; domain: Domain; width: number; scale: Scale }
