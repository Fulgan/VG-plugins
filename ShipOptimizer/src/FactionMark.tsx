import { useState } from "react";
import { api, type Conn } from "./api";
import "./faction.css";

// A faction, marked the way the game marks it: its own badge art plus its own colour on the name.
//
// The badge comes from the game (`GET /factions/icon` → `FactionIconSet`), so it is the same art the in-game
// map and Reputation panel draw. The colour dot is only a FALLBACK — the sprite for a faction is registered
// as the UI carrying it awakens, so early in a session some badges genuinely do not exist yet, and a coloured
// dot beside a badge is redundant rather than informative.
//
// One component for every place a faction is named, so a row in the standing panels, a map legend chip and a
// tooltip line can never disagree about what a faction looks like.
export default function FactionMark({ conn, id, name, color, showName = true, size = 14, title }: {
  conn: Conn;
  id?: string | null;
  name?: string | null;
  color?: string | null;
  showName?: boolean;
  size?: number;
  title?: string;
}) {
  // A badge that 404s (no sprite loaded yet, or an older bridge) must degrade to the dot, not to a broken
  // image icon — hence per-instance failure state rather than a global "icons work" flag.
  const [failed, setFailed] = useState(false);
  const url = id && !failed ? api.factionIconUrl(conn, id) : null;
  const label = name ?? id ?? "";

  return (
    <span className="fac-mark" title={title ?? (name && id ? `${name} (${id})` : label)}>
      {url ? (
        <img className="fac-mark-icon" src={url} alt="" width={size} height={size}
          loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="fac-mark-dot" style={{ background: color ?? "#4a4a55", width: size * 0.7, height: size * 0.7 }} />
      )}
      {showName && <span className="fac-mark-name" style={{ color: color ?? undefined }}>{label}</span>}
    </span>
  );
}
