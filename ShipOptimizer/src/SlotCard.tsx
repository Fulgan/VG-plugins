import { useState, type MouseEvent, type ReactNode } from "react";
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

/**
 * THE SLOT'S ONE SWITCH: the optimizer chooses here, or it does not.
 *
 * Every tab grew its own vocabulary for those two states and ended up with several controls for them: the
 * booster tab had a pin badge, a lock toggle and a lightning bolt, the gear tab a pin badge and a lock, the
 * officers tab a pin badge. They were never different ideas. Locking a slot is pinning it to whatever is
 * already in it, and picking something for a slot locks it to that instead, so one control covers both and the
 * only thing that varies is what it is locked TO.
 *
 * The word is LOCK because that is the word people already have for it. `keep`, `pinned` and `yours` all named
 * the same state and none of them said what pressing it would do.
 */
export function SlotLock({ locked, onToggle, what }: {
  locked: boolean;
  onToggle: () => void;
  /** What the slot would be locked to when it is not locked yet. Names the thing, not the mechanism. */
  what?: string;
}) {
  return (
    <button className={`slot-lock${locked ? " on" : ""}`}
      title={locked ? "Unlock: let the optimizer choose this slot" : `Lock this slot to ${what ?? "what is fitted"}`}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      {locked ? "🔒 locked" : "🔓"}
    </button>
  );
}

export function VigIcon({ it, conn }: { it: Item; conn: Conn }) {
  const src = itemIcon(conn, it);
  if (!src) return null;
  return <span className="gear-vig-icon" style={{ backgroundImage: `url("${src}")` }} />;
}

/**
 * THE VIGNETTE SHELL: the tag strip and the box around it, and nothing about what is inside.
 *
 * `Vig` and `NewVig` render an `Item`, which is what the gear and booster tabs hold. The officers tab holds an
 * `Officer` and shows a portrait and skill chips where those two show an icon and a stat line, so it needs the
 * FRAME without the body. Typing this component to `Item` in order to spare the two callers that have one is
 * what forces the third to copy the markup instead, and two surfaces wearing the same class names is the defect
 * this file exists to prevent.
 */
export function VigFrame({ tag, best, dimmed, className, onMouseEnter, onMouseLeave, children }: {
  /** Omitted where the box needs no name. An always-identical tag is a line of decoration. */
  tag?: ReactNode; best?: boolean; dimmed?: boolean; className?: string;
  onMouseEnter?: (e: MouseEvent) => void; onMouseLeave?: () => void; children: ReactNode;
}) {
  return (
    <div className={`gear-vig${best ? " best" : ""}${dimmed ? " dim" : ""}${className ? ` ${className}` : ""}`}
         onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {tag != null && <div className="gear-vig-tag">{tag}</div>}
      {children}
    </div>
  );
}

/**
 * The CURRENT side. `it === null` is an empty slot, said rather than left blank.
 *
 * IT CARRIES NO TAG. The label was always the word "current", on every caller, so it distinguished the box from
 * nothing: what a slot card shows first IS what is fitted, and the other side already names itself (`new`,
 * `locked`, `kept`). A label that is constant is decoration that costs a line.
 */
export function Vig({ it, conn, sub, extra, onHover }: {
  it: Item | null; conn: Conn;
  /** The line under the name — a turret's `Explosive · Lv 74 · +10,153`, a booster's stat and value. */
  sub?: ReactNode;
  /** Anything to the right of the text: aspect marks, a resonance bar. */
  extra?: ReactNode;
  onHover?: (h: { it: Item; x: number; y: number } | null) => void;
}) {
  if (!it) return <VigFrame><div className="gear-vig-name dim">empty</div></VigFrame>;
  return (
    <VigFrame
      onMouseEnter={(e) => onHover?.({ it, x: e.clientX, y: e.clientY })} onMouseLeave={() => onHover?.(null)}>
      <div className="gear-vig-body">
        <VigIcon it={it} conn={conn} />
        <div className="gear-vig-text">
          <div className="gear-vig-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</div>
          <div className="gear-vig-sub">{sub}</div>
        </div>
        {extra && <span className="gear-vig-asps">{extra}</span>}
      </div>
    </VigFrame>
  );
}

/**
 * NOTHING CHANGES HERE: the shared rendering of a slot whose proposal is what is already fitted.
 *
 * The target side goes EMPTY and says `kept`. It does NOT repeat the current side: a card showing the same
 * thing twice reads at a glance like a swap, and a grid of them hides the two slots that are actually moving,
 * which is the one question the before/after layout exists to answer.
 *
 * It lives here because the three tabs had drifted into two answers already: boosters blanked the side, gear
 * kept the item and added a small "changes nothing" beneath it. Each was defensible alone and together they
 * meant one screen answered "did this slot change" two ways. The comparison itself stays the caller's, because
 * only the caller knows what equivalence means for its own kind (`sameFit` for gear, a booster id, a guid).
 */
export function KeptVig({ mine }: { mine?: boolean }) {
  return (
    // `kept` marks it as the side holding one word, so the layout can hand the width to the side that has
    // something to say instead of splitting the card evenly between a booster's stat line and the word "kept".
    // The tag already says `locked`; repeating it as a body word underneath is the same state named twice.
    <VigFrame className="kept" tag={mine ? "locked" : "new"}>
      {!mine && <div className="gear-vig-verdict" title="Already in this slot, so applying it would do nothing">kept</div>}
    </VigFrame>
  );
}

/** The NEW side: a proposal, the player's own pick, or the reason there is neither. */
export function NewVig({ it, onClear, onHover, dimmed, conn, sub, extra, verdict, unchanged, mine, action }: {
  it: Item | null; onClear?: () => void;
  onHover: (h: { it: Item; x: number; y: number } | null) => void;
  dimmed?: boolean; conn: Conn; sub?: ReactNode; extra?: ReactNode;
  verdict?: { text: string; why?: string } | null;
  /** The proposal equals what is fitted. Overrides `it`: the control decides how that looks, not the caller. */
  unchanged?: boolean; mine?: boolean;
  /** One action ABOUT the proposed item, drawn on it. A control about an item belongs on that item: in the
   *  card's head it becomes a bare glyph beside the slot NAME, which reads as acting on the slot. It is a WORD
   *  and the word names the consequence: a cross reads as "remove this choice" where the thing it does may
   *  outlive the choice entirely. */
  action?: { label: string; title?: string; onClick: () => void } | null;
}) {
  if (unchanged) return <KeptVig mine={mine} />;
  return (
    /* The tag says WHOSE choice this is. A pinned slot holds the item the PLAYER picked, and labelling it "new"
       like an optimizer answer leaves no way to tell a proposal from a decision, which reads as the suggester
       having written through the pin. */
    // THE WHOLE VIGNETTE IS THE HOVER TARGET, not the text inside it. `Vig` already put the handlers on the
    // frame; here they sat on the body, so the card described its current item anywhere in the box and its
    // proposed one only over the words. A box that responds in part of itself reads as not responding.
    <VigFrame best={!!it} dimmed={dimmed}
      onMouseEnter={it ? (e) => onHover({ it, x: e.clientX, y: e.clientY }) : undefined}
      onMouseLeave={it ? () => onHover(null) : undefined}
      tag={<>{mine ? "locked" : "new"}{it && onClear && <button className="vig-x" onClick={(e) => { e.stopPropagation(); onClear(); }} title="leave alone">×</button>}</>}>
      {it ? (
        <div className="gear-vig-body">
          <VigIcon it={it} conn={conn} />
          <div className="gear-vig-text">
            <div className="gear-vig-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</div>
            <div className="gear-vig-sub">{sub}</div>
          </div>
          {extra && <span className="gear-vig-asps">{extra}</span>}
        </div>
      ) : verdict ? (
        <div className="gear-vig-verdict" title={verdict.why ?? verdict.text}>
          {verdict.text}
          {/* Only where it states something the label cannot: a threshold, a mechanism, a reason with a fact in it.
              A restatement of the label was noise on a card read at a glance. */}
          {verdict.why && <span className="gear-vig-why">{verdict.why}</span>}
        </div>
      ) : <div className="gear-vig-name dim">keep current</div>}
      {it && action && (
        <button className="vig-action" title={action.title ?? action.label}
                onClick={(e) => { e.stopPropagation(); action.onClick(); }}>{action.label}</button>
      )}
    </VigFrame>
  );
}

/**
 * The card around them. `head` carries the slot's own buttons, `arrow` whatever belongs between the two
 * vignettes (the gear tab prints the whole battery's gain there), and `foot` the control that chooses, a
 * filter select or a picker button, with the pop-in rendered as `children` so it anchors inside the card.
 *
 * `stack` PUTS CURRENT ABOVE NEW INSTEAD OF BESIDE IT, and the criterion is the CONTENT's shape rather than
 * the tab's taste: a vignette that is TALL (an officer's portrait over a wrapping row of skill chips) makes
 * two narrow columns of a side-by-side card and leaves most of the width empty, worst of all when one side is
 * a one-line `kept`. A vignette that is two short lines (a turret, a booster) reads better across. That is the
 * whole rule, and it is written here so a third caller answers it by measuring its own content rather than by
 * copying whichever neighbour it happened to look at.
 */
export default function SlotCard({ title, sub, head, current, next, arrow, foot, children, className, stack, onClick, onMouseEnter, onMouseLeave }: {
  title: ReactNode; sub?: ReactNode; head?: ReactNode;
  current: ReactNode; next: ReactNode; arrow?: ReactNode; foot?: ReactNode; children?: ReactNode;
  /** Current ABOVE new, for a card whose vignettes are tall. See the note above for when that is true. */
  stack?: boolean;
  className?: string; onClick?: () => void; onMouseEnter?: () => void; onMouseLeave?: () => void;
}) {
  return (
    <div className={`gear-panel${className ? ` ${className}` : ""}`}
         onClick={onClick} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="gear-panel-head">{title}{sub && <span className="dim"> · {sub}</span>}{head}</div>
      <div className={`gear-swap${stack ? " stack" : ""}`}>
        {current}
        {/* The arrow points the way the card reads, or it argues with the layout around it. */}
        <span className="gear-arrow">{stack ? "▼" : "→"}{arrow}</span>
        {next}
      </div>
      {foot}
      {children}
    </div>
  );
}
