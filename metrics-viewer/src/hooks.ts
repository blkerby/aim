import { useLayoutEffect, useRef, useState } from 'react';
export function useSize<T extends HTMLElement>(alignToPixels = false) {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0, dpr: window.devicePixelRatio || 1, offsetX: 0, offsetY: 0 });
  useLayoutEffect(() => {
    const node = ref.current; if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setSize(old => {
        const dpr = window.devicePixelRatio || 1;
        const snap = (value: number) => Math.round(value * dpr) / dpr;
        // Align both edges: rounding only the bitmap size still stretches it
        // over fractional CSS widths and leaves later grid columns off-pixel.
        // Consumers must use these same dimensions for drawing and interaction.
        const next = alignToPixels
          ? { width: snap(rect.right) - snap(rect.left), height: snap(rect.bottom) - snap(rect.top),
            dpr, offsetX: snap(rect.left) - rect.left, offsetY: snap(rect.top) - rect.top }
          : { width: rect.width, height: rect.height, dpr, offsetX: 0, offsetY: 0 };
        return old.width === next.width && old.height === next.height && old.dpr === next.dpr
          && old.offsetX === next.offsetX && old.offsetY === next.offsetY ? old : next;
      });
    };
    const observer = new ResizeObserver(update); observer.observe(node);
    let resolution: MediaQueryList;
    const watchResolution = () => {
      resolution?.removeEventListener('change', watchResolution);
      resolution = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      resolution.addEventListener('change', watchResolution);
      update();
    };
    watchResolution();
    if (alignToPixels) window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update); update();
    return () => {
      observer.disconnect(); window.removeEventListener('resize', update);
      resolution.removeEventListener('change', watchResolution);
      if (alignToPixels) window.removeEventListener('scroll', update, true);
    };
  }, [alignToPixels]);
  return [ref, size] as const;
}
