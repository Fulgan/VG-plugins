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
// So the box is measured ONCE per hover and the size is cached: a move then costs arithmetic against that
// cache and two style writes, which is what keeps the per-move path free of layout reads. Hover intent
// already delays the mount by 70ms, so the one measurement lands where a reflow costs nothing visible.
//
// Flipping alone is NOT enough, and that was the bug: a direction chosen from the viewport midpoint
// says which way the box grows and never that it FITS. A cursor just past the midpoint anchored a tall gear
// tooltip upward, and it ran off the top edge — clipping the name and the headline, which are the two things
// the tooltip exists to say. So: prefer the side away from the cursor, flip when that side has no room, and
// CLAMP into the viewport either way. A box taller than the viewport cannot be placed at all and gets its own
// scroll instead (see the max-height below), because there is no position that fits it.
const GAP = 14;      // clear of the cursor, so the pointer never sits on the box
const EDGE = 8;      // never flush against a window edge

/** Where a box of `w`×`h` goes for a cursor at `px`,`py`. Exported for tests — placement is arithmetic. */
export function tipPlacement(
  px: number, py: number, w: number, h: number, vw: number, vh: number,
): { left: number; top: number } {
  const fit = (pos: number, size: number, viewport: number) => {
    // Away from the cursor first; the other side if that overflows; then clamped, which is what makes a box
    // bigger than the gap-to-edge still land inside the window rather than half outside it.
    let v = pos + GAP;
    if (v + size > viewport - EDGE) v = pos - GAP - size;
    return Math.min(Math.max(EDGE, v), Math.max(EDGE, viewport - size - EDGE));
  };
  return { left: fit(px, w, vw), top: fit(py, h, vh) };
}

export function useCursorTip(x: number, y: number): { ref: React.RefObject<HTMLDivElement | null>; style: CSSProperties } {
  const ref = useRef<HTMLDivElement>(null);
  // The measured box, and the last cursor position — so a re-measure (the content changed height) can re-place
  // without waiting for the next mouse move.
  const size = useRef({ w: 0, h: 0 });
  const at = useRef({ x, y });

  const place = useCallback((px: number, py: number) => {
    const el = ref.current;
    if (!el) return;
    at.current = { x: px, y: py };
    const { w, h } = size.current;
    if (!w || !h) {
      // Nothing measured yet (the very first paint): fall back to the quadrant rule, which needs no size. It
      // is replaced a frame later by the clamped placement, so this is never what the player ends up looking at.
      const flipX = px > window.innerWidth / 2, flipY = py > window.innerHeight / 2;
      el.style.left = flipX ? "auto" : `${px + 16}px`;
      el.style.right = flipX ? `${window.innerWidth - px + 16}px` : "auto";
      el.style.top = flipY ? "auto" : `${py + GAP}px`;
      el.style.bottom = flipY ? `${window.innerHeight - py + GAP}px` : "auto";
      return;
    }
    const { left, top } = tipPlacement(px, py, w, h, window.innerWidth, window.innerHeight);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
  }, []);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    size.current = { w: r.width, h: r.height };
    place(at.current.x, at.current.y);
  }, [place]);

  // One passive listener for the tip's lifetime — no per-move React work anywhere in the tree.
  useEffect(() => {
    const onMove = (e: MouseEvent) => place(e.clientX, e.clientY);
    document.addEventListener("mousemove", onMove, { passive: true });
    return () => document.removeEventListener("mousemove", onMove);
  }, [place]);

  // Measure on mount, and again when the box changes shape — an icon arriving or a comparison block appearing
  // changes the height AFTER the first measurement, and a stale height clamps to the wrong place.
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // First paint is positioned from the props (the cursor position at hover start) by the quadrant rule, then
  // corrected by the measurement above.
  const flipX = x > window.innerWidth / 2;
  const flipY = y > window.innerHeight / 2;
  const style: CSSProperties = {
    position: "fixed",
    left: flipX ? "auto" : x + 16,
    right: flipX ? window.innerWidth - x + 16 : "auto",
    top: flipY ? "auto" : y + GAP,
    bottom: flipY ? window.innerHeight - y + GAP : "auto",
    // No placement fits a box taller (or wider) than the window ∴ bound it and let it scroll. Checked at a small
    // window and at zoom ≠ 100%, where the box is largest relative to the viewport.
    maxHeight: `calc(100vh - ${EDGE * 2}px)`,
    maxWidth: `calc(100vw - ${EDGE * 2}px)`,
    overflowY: "auto",
  };
  return { ref, style };
}
