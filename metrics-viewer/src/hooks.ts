import { useLayoutEffect, useRef, useState } from 'react';
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0, dpr: window.devicePixelRatio || 1 });
  useLayoutEffect(() => {
    const node = ref.current; if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setSize(old => {
        // CSS grid columns can be fractional. Rounding here shifts pointer
        // coordinates away from the drawn range and can disable follow-latest.
        const next = { width: rect.width, height: rect.height, dpr: window.devicePixelRatio || 1 };
        return old.width === next.width && old.height === next.height && old.dpr === next.dpr ? old : next;
      });
    };
    const observer = new ResizeObserver(update); observer.observe(node);
    window.addEventListener('resize', update); update();
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  return [ref, size] as const;
}
