import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

// Draw only the rows a scroll container can actually show.
//
// A table row is a real `<tr>` of a dozen cells, so a list is linear in what it renders and an armory of 8k
// items (an ordinary long playthrough, not a pathological one) costs minutes of layout. A CAP would fix the
// cost and break the feature — the whole point of an armory view is working THROUGH it — so the rows are
// windowed instead: everything stays in the list, scrollable and reachable, and only what fits is in the DOM.
//
// Spacer rows above and below stand in for the undrawn ones, so the scrollbar still measures the full list and
// scroll position means what it says. Callers keep filtering and sorting over the WHOLE set: this decides only
// which slice is on screen.
//
// Row height is MEASURED from the first drawn row rather than assumed, because it follows the stylesheet (and
// a browser's font settings), and a wrong constant shows as rows drifting out of the window on long scrolls.
export interface Windowed {
  start: number;
  end: number;      // exclusive
  padTop: number;
  padBottom: number;
  /** Put on the first drawn row, so the hook can learn the real row height. */
  measureRef: (el: HTMLElement | null) => void;
}

export interface WindowedOpts {
  /** The element that scrolls. */
  scroll: RefObject<HTMLElement | null>;
  /** The list's own root, when it does NOT fill the scroller — a popin whose body scrolls has content above
   *  the list, and without that offset the window is off by however tall that content is. */
  list?: RefObject<HTMLElement | null>;
  rowH?: number;
  overscan?: number;
}

export function useWindowed(count: number, opts: WindowedOpts): Windowed {
  const { scroll: scrollRef, list: listRef, rowH: fallbackRowH = 20, overscan = 10 } = opts;
  // The floor on how many rows are drawn, whatever the measurements say — see the clamp at the end.
  const minRows = overscan * 3;
  const [rowH, setRowH] = useState(fallbackRowH);
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 80) });
  const raf = useRef<number | null>(null);

  // Measured ONCE. Re-measuring on every slide invites a loop: whichever row lands first can differ by a
  // pixel (a flashed or selected row), rowH then flips between two values, the spacers resize under the
  // scroll position, and the container chases itself. Rows in these tables are single-line and uniform, so
  // one reading is the right one.
  const measured = useRef(false);
  const measureRef = useCallback((el: HTMLElement | null) => {
    if (!el || measured.current) return;
    const h = el.getBoundingClientRect().height;
    if (h <= 0) return;          // not laid out yet — try again on the next row that mounts
    measured.current = true;
    if (Math.abs(h - rowH) > 0.5) setRowH(h);
  }, [rowH]);

  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const h = rowH > 0 ? rowH : fallbackRowH;
    // How far the list starts down the scroller. 0 when it fills it; the height of whatever sits above it
    // otherwise, which is why a popin body scrolling its own content needs this at all.
    const list = listRef?.current;
    const offset = list ? list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop : 0;
    const first = Math.max(0, Math.floor((el.scrollTop - offset) / h) - overscan);
    const visible = Math.ceil(el.clientHeight / h) + overscan * 2;
    const start = Math.min(first, Math.max(0, count - 1));
    const end = Math.min(count, start + Math.max(visible, 1));
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [scrollRef, listRef, rowH, fallbackRowH, overscan, count]);

  // Before paint, so the first frame already shows the right slice rather than the top of the list.
  useLayoutEffect(recompute, [recompute]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Coalesced to one recompute per frame: a scroll fires far more often than it can usefully redraw.
    const onScroll = () => {
      if (raf.current != null) return;
      raf.current = requestAnimationFrame(() => { raf.current = null; recompute(); });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(onScroll) : null;
    ro?.observe(el);
    window.addEventListener("resize", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      window.removeEventListener("resize", onScroll);
      if (raf.current != null) cancelAnimationFrame(raf.current);
    };
  }, [scrollRef, recompute]);

  // NEVER an empty window over a non-empty list. Every input here comes from layout — a container that has not
  // been measured yet, a rect taken while the panel was still hidden — so the arithmetic can land on a range
  // that draws nothing, and a list that renders nothing looks broken rather than mispositioned. Falling back to
  // the head of the list means a wrong window shows the first rows instead of blank space.
  const span = Math.max(1, Math.ceil(minRows));
  let start = Math.min(Math.max(0, range.start), Math.max(0, count - 1));
  let end = Math.min(count, Math.max(range.end, start + span));
  if (count > 0 && end <= start) { start = 0; end = Math.min(count, span); }
  return { start, end, padTop: start * rowH, padBottom: Math.max(0, (count - end) * rowH), measureRef };
}
