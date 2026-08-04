import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

// Hover intent: only commit to a hover target after the pointer has RESTED on it briefly. Sweeping down a
// long list crosses dozens of rows, and without this each one built (and threw away) a full multi-panel
// tooltip — the mount, its layout, and an icon fetch per card. 70ms is below the ~100ms threshold where a
// delay becomes perceptible, so a deliberate hover still feels immediate while a sweep costs nothing.
export function useHoverIntent<T>(delay = 70): { target: T | null; show: (t: T) => void; hide: () => void } {
  const [target, setTarget] = useState<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current != null) { clearTimeout(timer.current); timer.current = null; } };
  const show = useCallback((t: T) => {
    clear();
    timer.current = setTimeout(() => { timer.current = null; setTarget(t); }, delay);
  }, [delay]);
  const hide = useCallback(() => { clear(); setTarget(null); }, []);
  useEffect(() => clear, []);
  return { target, show, hide };
}

// Cursor-following tooltip positioning, done in the DOM and WITHOUT measuring.
//
// Two costs made these tooltips feel heavy, and both are avoided here:
//
//  1. Storing the cursor in React state re-rendered the whole owning tab on every mouse move. Handled by
//     writing straight to the element's style — the owner only tracks WHICH item is hovered.
//  2. Measuring the tooltip with getBoundingClientRect forces a SYNCHRONOUS layout flush of the whole
//     document. On the inventory tab that document contains a table of hundreds of rows × ~15 cells, and
//     the tooltip mounting had just dirtied layout — so every hover paid a full-table reflow before it
//     could position itself. The gear tab's DOM is a fraction of the size, which is exactly why its
//     tooltips felt instant while the inventory's dragged.
//
// So instead of measuring, the tooltip is anchored to the cursor by QUADRANT: the near edge is pinned and
// the box grows away from the pointer. Left/right and top/bottom flip around the viewport midpoint, which
// needs no knowledge of the tooltip's size and therefore no layout read at all. It also means the element
// can render visible immediately — no hidden-first pass waiting for a measurement.
export function useCursorTip(x: number, y: number): { ref: React.RefObject<HTMLDivElement | null>; style: CSSProperties } {
  const ref = useRef<HTMLDivElement>(null);

  const place = useCallback((px: number, py: number) => {
    const el = ref.current;
    if (!el) return;
    const flipX = px > window.innerWidth / 2;
    const flipY = py > window.innerHeight / 2;
    el.style.left = flipX ? "auto" : `${px + 16}px`;
    el.style.right = flipX ? `${window.innerWidth - px + 16}px` : "auto";
    el.style.top = flipY ? "auto" : `${py + 14}px`;
    el.style.bottom = flipY ? `${window.innerHeight - py + 14}px` : "auto";
  }, []);

  // One passive listener for the tip's lifetime — no per-move React work anywhere in the tree.
  useEffect(() => {
    const onMove = (e: MouseEvent) => place(e.clientX, e.clientY);
    document.addEventListener("mousemove", onMove, { passive: true });
    return () => document.removeEventListener("mousemove", onMove);
  }, [place]);

  // First paint is positioned from the props (the cursor position at hover start) by the same rule, so
  // there's nothing to correct afterwards.
  const flipX = x > window.innerWidth / 2;
  const flipY = y > window.innerHeight / 2;
  const style: CSSProperties = {
    position: "fixed",
    left: flipX ? "auto" : x + 16,
    right: flipX ? window.innerWidth - x + 16 : "auto",
    top: flipY ? "auto" : y + 14,
    bottom: flipY ? window.innerHeight - y + 14 : "auto",
  };
  return { ref, style };
}
