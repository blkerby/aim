import type { Summary } from './types';

export class FrameDecoder {
  private buffer = new Uint8Array(0);
  push(chunk: Uint8Array): Summary[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer); joined.set(chunk, this.buffer.length);
    let offset = 0;
    const frames: Summary[] = [];
    while (joined.length - offset >= 8) {
      const view = new DataView(joined.buffer, offset);
      const headSize = view.getUint32(0, true), dataSize = view.getUint32(4, true);
      if (headSize > 1024 * 1024 || dataSize > 32 * 1024 * 1024) throw new Error('Invalid series frame');
      if (joined.length - offset < 8 + headSize + dataSize) break;
      const header = JSON.parse(new TextDecoder().decode(joined.subarray(offset + 8, offset + 8 + headSize)));
      const p = offset + 8 + headSize, w = header.width;
      if (header.status === 'ok') {
        if (!Number.isInteger(w) || w < 1 || dataSize !== 29 * w) throw new Error('Invalid column lengths');
        header.low = new Float64Array(joined.slice(p, p + 8 * w).buffer);
        header.high = new Float64Array(joined.slice(p + 8 * w, p + 16 * w).buffer);
        header.sampleX = new Float64Array(joined.slice(p + 16 * w, p + 24 * w).buffer);
        header.counts = new Uint32Array(joined.slice(p + 24 * w, p + 28 * w).buffer);
        header.breaks = joined.slice(p + 28 * w, p + 29 * w);
      }
      frames.push(header);
      offset += 8 + headSize + dataSize;
    }
    this.buffer = joined.slice(offset);
    return frames;
  }
  finish() { if (this.buffer.length) throw new Error('Incomplete series response; please refresh.'); }
}
