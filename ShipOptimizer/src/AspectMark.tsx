import { useState } from "react";
import { api, type Conn } from "./api";
import { aspectValue } from "./aspect";
import { InfoTip, useTip } from "./HoverCard";
import type { Aspect } from "./types";

// An aspect, shown as the game's own badge.
//
// This replaces a row of ◆/◇ glyphs that only counted slots: the count is already on the item, whereas WHICH
// aspects are fitted is the thing worth seeing at a glance — a Frozen Core and a Gamma Ward are not
// interchangeable, and the placeholder said nothing about either.
//
// An empty slot still gets a marker, because "two aspects in three slots" is a different item from "two
// aspects in two slots" — one has room to grow.
export default function AspectMark({ conn, aspect, size = 14 }: { conn: Conn; aspect: Aspect; size?: number }) {
  // A missing sprite (older bridge, or an aspect whose art never loaded) degrades to the aspect's initial
  // rather than a broken-image icon.
  const [failed, setFailed] = useState(false);
  const v = aspectValue(aspect.description);
  const url = aspect.id && !failed ? api.aspectIconUrl(conn, aspect.id) : null;
  // WHAT THE ASPECT IS WORTH, which is why this is a card and not a `title`: the figure is computed
  // (`aspectValue` reads the game's own description text), and an attribute can only stringify it after a
  // second's delay with no room to set it apart from the prose.
  //
  // An area effect says so INSTEAD of a figure. Its worth depends on how many enemies are standing there,
  // which nothing here can know, so the gap is named rather than drawn as a zero.
  const worth = v.damageFraction > 0
    ? `+${Math.round(v.damageFraction * 100)}% damage${v.overTime ? ", over time" : ""}`
    : v.area ? "area damage, not counted for single-target" : null;
  // A MARK NEVER SITS INSIDE ANOTHER CARD'S HOVER TARGET, so no two cards can be open at once: the item
  // vignettes and list rows put their marks beside the icon-and-name target, never within it. Inside a tip the
  // question cannot arise at all, because a tip is `pointer-events: none` and nothing in it is hoverable.
  const { tip, anchor } = useTip();

  return (
    <span className="asp-mark" {...anchor(null)}>
      {tip && <InfoTip x={tip.x} y={tip.y} head={aspect.name} worth={worth} desc={aspect.description} />}
      {url
        // `draggable={false}`: an <img> is natively draggable, and inside a draggable row it starts its own
        // image drag instead of the row's, which breaks dropping an item onto a slot.
        ? <img className="asp-mark-icon" src={url} alt="" width={size} height={size} loading="lazy" draggable={false} onError={() => setFailed(true)} />
        : <span className="asp-mark-fallback" style={{ width: size, height: size }}>{aspect.name.slice(0, 1)}</span>}
    </span>
  );
}

// The aspects on an item, plus a marker per unfilled slot.
export function AspectMarks({ conn, aspects, slots, size = 14 }: {
  conn: Conn; aspects: Aspect[]; slots?: number; size?: number;
}) {
  const empty = Math.max(0, (slots ?? 0) - aspects.length);
  return (
    <span className="asp-marks">
      {aspects.map((a, i) => <AspectMark key={`${a.id ?? a.name}-${i}`} conn={conn} aspect={a} size={size} />)}
      {Array.from({ length: empty }, (_, i) => (
        <span key={`e${i}`} className="asp-mark-empty" style={{ width: size, height: size }} title="empty aspect slot" />
      ))}
    </span>
  );
}
