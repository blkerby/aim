"""Pixel-column summaries. No reservoir sampling or fixed point budget."""
import json
import struct

import numpy as np


def summarize(x, y, domain, width, logarithmic=False):
    """Return min/max and a representative recorded step per occupied column.

    Nonfinite samples (and nonpositive log samples) break connectivity. A bin
    containing both valid and invalid samples keeps its extrema but is marked
    as a break: subpixel gap topology cannot be represented by one interval.
    """
    left, right = domain
    if not np.isfinite([left, right]).all() or right <= left:
        raise ValueError('The step range must have finite, increasing bounds.')
    if not 1 <= width <= 32768:
        raise ValueError('Plot width must be between 1 and 32768 physical pixels.')
    start = max(0, int(np.searchsorted(x, left)) - 1)
    stop = min(len(x), int(np.searchsorted(x, right, side='right')) + 1)
    sx, sy = x[start:stop], y[start:stop]
    valid = np.isfinite(sy) & ((sy > 0) if logarithmic else True)
    inside = (sx >= left) & (sx <= right)
    bins = np.clip(np.floor((sx - left) / (right - left) * width), 0, width - 1).astype(int)
    low, high = np.full(width, np.inf), np.full(width, -np.inf)
    counts = np.zeros(width, dtype='<u4')
    breaks = np.zeros(width, dtype='u1')
    sample_x = np.full(width, np.nan)
    selected = inside & valid
    np.minimum.at(low, bins[selected], sy[selected])
    np.maximum.at(high, bins[selected], sy[selected])
    np.add.at(counts, bins[selected], 1)
    # Input steps and therefore selected bins are sorted. Choose an actual
    # middle sample rather than averaging the two middle steps of an even bin.
    occupied = counts > 0
    ends = np.cumsum(counts, dtype=np.int64)
    starts = ends - counts
    middle = starts[occupied] + (counts[occupied].astype(np.int64) - 1) // 2
    sample_x[occupied] = sx[selected][middle]
    breaks[bins[inside & ~valid]] = 1
    # Only clip the two lines crossing viewport boundaries. Empty interior
    # columns stay empty: the client draws ordinary line segments between
    # local samples/ranges, rather than a staircase of interpolated columns.
    boundaries = []
    for edge in domain:
        i = int(np.searchsorted(sx, edge))
        if 0 < i < len(sx) and sx[i - 1] < edge < sx[i] and valid[i - 1] and valid[i]:
            pair = np.log10(sy[i - 1:i + 1]) if logarithmic else sy[i - 1:i + 1]
            v = float(np.interp(edge, sx[i - 1:i + 1], pair))
            boundaries.append([float(edge), 10 ** v if logarithmic else v])
        else:
            boundaries.append(None)
    low[~np.isfinite(low)] = np.nan
    high[~np.isfinite(high)] = np.nan
    finite = np.isfinite(low) & np.isfinite(high)
    extrema = [p[1] for p in boundaries if p is not None]
    if finite.any():
        extrema.extend([float(np.min(low[finite])), float(np.max(high[finite]))])
    bounds = [min(extrema), max(extrema)] if extrema else None
    return {
        'low': low.astype('<f8'), 'high': high.astype('<f8'),
        'sampleX': sample_x.astype('<f8'), 'counts': counts, 'breaks': breaks,
        'bounds': bounds, 'boundaries': boundaries,
        'rawCount': int(inside.sum()), 'invalidCount': int((inside & ~valid).sum()),
    }


def frame(header, summary=None):
    """LE uint32 JSON length, uint32 payload length, JSON, low/high/x/count/break.

    Buffers are LE float64 low/high/sampleX, uint32 count, uint8 break, width long.
    Headers are not padded; browser decoding copies into aligned buffers.
    """
    payload = b''
    if summary is not None:
        payload = b''.join(summary[k].tobytes() for k in ('low', 'high', 'sampleX', 'counts', 'breaks'))
    encoded = json.dumps(header, allow_nan=False, separators=(',', ':')).encode()
    return struct.pack('<II', len(encoded), len(payload)) + encoded + payload
