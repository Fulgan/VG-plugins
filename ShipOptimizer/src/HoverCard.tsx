import { useCallback, useState, type ReactNode } from "react";
import { useCursorTip } from "./useCursorTip";

// THE CURSOR CARD FOR EVERYTHING THAT IS NOT AN ITEM OR AN OFFICER.
//
// Those two have their own bodies (`ItemTip`, `OfficerTip`) because what they say is elaborate and per-kind. What
// they share is the BOX: a fixed element that follows the pointer, measures itself once, and clamps into the
// viewport. That part belongs to `useCursorTip` and to nobody else. A hand-rolled placement is the defect this
// replaces: choosing a side from the viewport midpoint says which way the box grows and never that it FITS, so a
// tall card anchored just past the midpoint ran off the top edge and lost its own headline.
//
// A card here is warranted where a native `title` cannot carry the answer: a computed figure, a colour that means
// something, more than one line. Where the whole answer IS the string (clipped text), the native attribute stays:
// it works on touch, survives a scroll, and needs no state at all.

/** The positioned box. The body is the caller's; the placement is never. */
export function TipBox({ x, y, className = "skill-tip", children }: {
  x: number; y: number; className?: string; children: ReactNode;
}) {
  const { ref, style } = useCursorTip(x, y);
  return <div className={className} ref={ref} style={style}>{children}</div>;
}

/**
 * Hover state for one surface: what is pointed at, and where the pointer was when it landed.
 *
 * ENTER AND LEAVE ONLY. The box follows the cursor from a passive document listener, so tracking moves here would
 * re-render the owning tab on every pixel to compute a position that is already correct.
 *
 * There is no hover-intent delay: these cards are small and open on small targets, where a delay reads as lag.
 * `useHoverIntent` earns its 70ms on the multi-panel item card, which builds a row of panels and fetches art.
 */
export function useTip<T = null>(): {
  tip: { at: T; x: number; y: number } | null;
  anchor: (at: T) => { onMouseEnter: (e: { clientX: number; clientY: number }) => void; onMouseLeave: () => void };
  close: () => void;
} {
  const [tip, setTip] = useState<{ at: T; x: number; y: number } | null>(null);
  const close = useCallback(() => setTip(null), []);
  const anchor = useCallback((at: T) => ({
    onMouseEnter: (e: { clientX: number; clientY: number }) => setTip({ at, x: e.clientX, y: e.clientY }),
    onMouseLeave: () => setTip(null),
  }), []);
  return { tip, anchor, close };
}

/**
 * The small card: a head, what the thing is WORTH, what it does, and what it belongs to.
 *
 * `worth` is drawn only when there is a figure to draw. A skill this ship's damage model cannot price and a
 * skill priced at nothing would otherwise be the same pixels, and an absent line must never read as "checked, and
 * it comes to nothing" for the case nobody examined.
 */
export function InfoTip({ x, y, head, headColor, worth, desc, foot }: {
  x: number; y: number;
  head?: ReactNode; headColor?: string;
  worth?: ReactNode;
  desc: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <TipBox x={x} y={y}>
      {head != null && <div className="skill-tip-head" style={headColor ? { color: headColor } : undefined}>{head}</div>}
      {worth != null && <div className="skill-tip-worth">{worth}</div>}
      <div className="skill-tip-desc">{desc}</div>
      {foot != null && <div className="skill-tip-foot">{foot}</div>}
    </TipBox>
  );
}
