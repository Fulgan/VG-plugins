import { useState, type ReactNode } from "react";
import { itemIcon, type Conn } from "./api";
import { RARITY_COLOR } from "./format";
import type { Item } from "./types";

// ONE SLOT CARD FOR THE WHOLE APP: a head that names the slot and carries its buttons, the CURRENT → NEW pair,
// and a foot for whatever chooses what goes in it.
//
// The gear tab grew this shape and the booster tab needed the same thing. Reproducing it there — a narrow
// vertical stack with its own idea of where the picker goes — meant two answers to "what does a slot look
// like", which is the defect `the build checks.ps1` exists for and which the player meets as two tabs that do not
// resemble each other.
//
// What genuinely differs between a turret and a booster is what a vignette SAYS (a turret's damage type and
// power; a booster's stat and where it lives), so that is a prop. The frame is not.

export interface FGroup { label: string; opts: { v: string; label: string }[] }

/**
 * The slot's own selector, at the foot of the card: a searchable grouped dropdown, full width.
 *
 * The gear tab uses it to narrow what may go in a hardpoint; the booster tab to say what a slot is FOR. Same
 * control, same place, so the two tabs answer "how do I change this slot" identically — a native `<select>`
 * tucked into the head was the booster tab's own invention and read as a different kind of card.
 */
export function FilterSelect({ value, groups, onChange, placeholder, restingLabel, className }: {
  value: string; groups: FGroup[]; onChange: (v: string) => void;
  placeholder?: string; restingLabel?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const cur = groups.flatMap((g) => g.opts).find((o) => o.v === value);
  // `placeholder` marks an action-style select (e.g. "Set all to…") whose value stays "" after each
  // pick — show the placeholder instead of the resting label.
  const resting = restingLabel ?? "All compatible";
  const label = value === "" ? (placeholder ?? resting) : cur?.label ?? value;
  const ql = q.trim().toLowerCase();
  const pick = (v: string) => { onChange(v); setOpen(false); setQ(""); };
  return (
    <div className={`fsel${className ? ` ${className}` : ""}`} onClick={(e) => e.stopPropagation()}>
      <button className="fsel-btn" onClick={() => setOpen((o) => !o)}>{label}<span className="dim"> ▾</span></button>
      {open && (
        <>
          <div className="fsel-back" onClick={() => setOpen(false)} />
          <div className="fsel-pop">
            <input autoFocus className="fsel-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="search…" />
            <div className="fsel-opts">
              {resting.toLowerCase().includes(ql) && <div className={`fsel-opt${value === "" ? " on" : ""}`} onClick={() => pick("")}>{resting}</div>}
              {groups.map((g) => {
                const opts = g.opts.filter((o) => o.label.toLowerCase().includes(ql));
                if (!opts.length) return null;
                return <div key={g.label}><div className="fsel-grp">{g.label}</div>{opts.map((o) => <div key={o.v} className={`fsel-opt${value === o.v ? " on" : ""}`} onClick={() => pick(o.v)}>{o.label}</div>)}</div>;
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function VigIcon({ it, conn }: { it: Item; conn: Conn }) {
  const src = itemIcon(conn, it);
  if (!src) return null;
  return <span className="gear-vig-icon" style={{ backgroundImage: `url("${src}")` }} />;
}

/** The CURRENT side. `it === null` is an empty slot, said rather than left blank. */
export function Vig({ it, label, conn, sub, extra, onHover }: {
  it: Item | null; label: string; conn: Conn;
  /** The line under the name — a turret's `Explosive · Lv 74 · +10,153`, a booster's stat and value. */
  sub?: ReactNode;
  /** Anything to the right of the text: aspect marks, a resonance bar. */
  extra?: ReactNode;
  onHover?: (h: { it: Item; x: number; y: number } | null) => void;
}) {
  if (!it) return <div className="gear-vig"><div className="gear-vig-tag">{label}</div><div className="gear-vig-name dim">empty</div></div>;
  return (
    <div className="gear-vig" onMouseEnter={(e) => onHover?.({ it, x: e.clientX, y: e.clientY })} onMouseLeave={() => onHover?.(null)}>
      <div className="gear-vig-tag">{label}</div>
      <div className="gear-vig-body">
        <VigIcon it={it} conn={conn} />
        <div className="gear-vig-text">
          <div className="gear-vig-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</div>
          <div className="gear-vig-sub">{sub}</div>
        </div>
        {extra && <span className="gear-vig-asps">{extra}</span>}
      </div>
    </div>
  );
}

/** The NEW side: a proposal, the player's own pick, or the reason there is neither. */
export function NewVig({ it, onClear, onHover, dimmed, conn, sub, extra, verdict, same, mine }: {
  it: Item | null; onClear?: () => void;
  onHover: (h: { it: Item; x: number; y: number } | null) => void;
  dimmed?: boolean; conn: Conn; sub?: ReactNode; extra?: ReactNode;
  verdict?: { text: string; why: string } | null; same?: boolean; mine?: boolean;
}) {
  return (
    <div className={`gear-vig${it ? " best" : ""}${dimmed ? " dim" : ""}`}>
      {/* WHOSE choice this is. A pinned slot holds the item the PLAYER picked, and labelling it "new" like an
          optimizer answer leaves no way to tell a proposal from a decision — which reads as the suggester having
          written through the pin. */}
      <div className="gear-vig-tag">{mine ? "your pick" : "new"}{it && onClear && <button className="vig-x" onClick={(e) => { e.stopPropagation(); onClear(); }} title="leave alone">×</button>}</div>
      {it ? (
        <div className="gear-vig-body" onMouseEnter={(e) => onHover({ it, x: e.clientX, y: e.clientY })} onMouseLeave={() => onHover(null)}>
          <VigIcon it={it} conn={conn} />
          <div className="gear-vig-text">
            <div className="gear-vig-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</div>
            <div className="gear-vig-sub">{sub}</div>
          </div>
          {extra && <span className="gear-vig-asps">{extra}</span>}
          {/* An equivalent item: `changes` drops it (sameFit), so it is never counted or applied. Without saying so
              the slot shows a pending swap that nothing else in the app agrees exists. */}
          {same && <span className="gear-vig-same" title="Identical fit to what is already equipped, so applying it would do nothing">changes nothing</span>}
        </div>
      ) : verdict ? (
        <div className="gear-vig-verdict" title={verdict.why}>
          {verdict.text}
          <span className="gear-vig-why">{verdict.why}</span>
        </div>
      ) : <div className="gear-vig-name dim">keep current</div>}
    </div>
  );
}

/**
 * The card around them. `head` carries the slot's own buttons, `arrow` whatever belongs between the two
 * vignettes (the gear tab prints the whole battery's gain there), and `foot` the control that chooses — a
 * filter select, a picker button — with the pop-in rendered as `children` so it anchors inside the card.
 */
export default function SlotCard({ title, sub, head, current, next, arrow, foot, children, className, onClick, onMouseEnter, onMouseLeave }: {
  title: ReactNode; sub?: ReactNode; head?: ReactNode;
  current: ReactNode; next: ReactNode; arrow?: ReactNode; foot?: ReactNode; children?: ReactNode;
  className?: string; onClick?: () => void; onMouseEnter?: () => void; onMouseLeave?: () => void;
}) {
  return (
    <div className={`gear-panel${className ? ` ${className}` : ""}`}
         onClick={onClick} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="gear-panel-head">{title}{sub && <span className="dim"> · {sub}</span>}{head}</div>
      <div className="gear-swap">
        {current}
        <span className="gear-arrow">→{arrow}</span>
        {next}
      </div>
      {foot}
      {children}
    </div>
  );
}
