import { useState } from "react";
import { api, type Conn } from "./api";
import { aspectValue } from "./aspect";
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
  const worth = v.damageFraction > 0
    ? ` (+${Math.round(v.damageFraction * 100)}% damage${v.overTime ? ", over time" : ""})`
    : v.area ? " (area damage — not counted for single-target)" : "";

  return (
    <span className="asp-mark" title={`${aspect.name}${worth}\n${aspect.description}`}>
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
