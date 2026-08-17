// The WHERE editor: the chips a filter is read and edited as, and the two-pane popover that adds one.
//
// Owned by neither list. The sell list writes these clauses about what you hold and the shopping list about
// what a station has on offer, and the vocabulary is one registry (`sellRules.FIELDS`) — so the editor over it
// is one component. A second copy is how the two would come to say different words for the same clause, which
// is the defect this app has paid for more than once.
//
// What stays with the callers: everything a clause is FOR. The sell list keeps its GROUP BY / TAKE / HAVING
// rows and its split preview; the shopping list keeps its match count. Both hand a `where` in and take one out.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  FIELDS, NO_VALUE, RARITY_ORDER, REL_QS, SET_QS, SET_QS_ONE, clauseKeys, fieldOf, fieldVaries, freeKey, hasField, needCount,
  relAbs, relBound, relFixed, relFixedQ, relNeedsNumber, relTermOf, setCondFor, setQNeedsNumber, setQOf,
  setQWords, typeOf, valueLabel,
  type Cond, type FieldCtx, type RangeCond, type RelQ, type RelTerm, type SetCond, type SetQ, type Where,
} from "./sellRules";
import type { Item } from "./types";
import "./sellList.css";

const OPS: [string, string][] = [["lt", "<"], ["lte", "≤"], ["eq", "="], ["gte", "≥"], ["gt", ">"]];

// Coarse first: these are what most rules are about, and they used to sit below every turret type. The two
// shop-floor fields follow the other numbers; on a sell rule they read a constant and `varies` drops them.
const FIELD_ORDER = ["l", "lrel", "v", "p", "own", "r", "s", "c", "a", "t", "st", "cat", "dt", "ms", "mv", "sub", "subN", "asp", "aspN", "aspE"];

/**
 * A number field that survives being typed in.
 *
 * A controlled `<input type="number">` bound straight to the clause cannot be edited: every keystroke that
 * leaves the box momentarily unparseable — clearing it to retype, or a lone `-` on the way to a negative —
 * parses as nothing, the clause loses that bound, the chip changes shape and the input UNMOUNTS mid-edit. That
 * is why a `0` could not be changed: selecting it and typing anything empties the box for one keystroke.
 *
 * So the text being typed is local state and only a PARSEABLE value reaches the rule. An unparseable box is
 * left alone while the caret is in it and restored on blur. Removing a bound is the `clear`/`×` control's job,
 * never a side effect of editing.
 */
export function NumBox({ value, onCommit, className }: { value: number; onCommit: (n: number) => void; className?: string }) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  // Follow the rule while the caret is elsewhere: another control (a preset, a cleared clause) can move it.
  useEffect(() => { if (!editing) setText(String(value)); }, [value, editing]);
  return (
    <input
      type="text" inputMode="numeric" className={className} value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t === "" || t === "-") return;      // mid-edit, not a value yet
        const n = Number(t);
        if (Number.isFinite(n)) onCommit(n);
      }}
      onBlur={() => { setEditing(false); setText(String(value)); }}
    />
  );
}

/**
 * Where a popover opens, in VIEWPORT coordinates.
 *
 * A menu positioned inside its trigger's box is clipped by the first ancestor that scrolls, and the rule editor
 * sits inside one — so the field picker was cut off at the panel's edge and the panel grew a scrollbar around
 * it. `position: fixed` leaves every such box behind (nothing on the path is transformed, so the viewport is
 * the containing block) while the node stays INSIDE the `<dialog>`, which a portal to `document.body` would
 * not: the modal's top layer paints over everything outside it.
 *
 * The rect is read on open and followed while the page moves, since a fixed box does not travel with its
 * anchor by itself.
 */
export function usePopAnchor(open: boolean, width = 560) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(width, window.innerWidth * 0.92);
      // Flipped above the trigger when the space below cannot hold it — the editor sits low in a tall popin.
      const below = window.innerHeight - r.bottom;
      const tall = Math.min(380, window.innerHeight * 0.46);
      setAt({
        left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)),
        ...(below < tall && r.top > below ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open, width]);
  return { trigger, at };
}

/**
 * The three ways out of an open popover, which is what a popover is expected to have:
 *
 *  - a click anywhere outside it (the pop and its trigger stop propagation, so their own clicks don't count)
 *  - Escape, taken in the CAPTURE phase and stopped there: a modal above it also closes on Escape, and the
 *    popover has to win or one key press throws away the whole rule
 *  - the thing it was editing going away, which is the caller's own effect
 */
export function usePopDismiss(open: string | null, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.(".sl-pop, .sl-popwrap")) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `close` is a setter wrapper, stable by construction
  }, [open]);
}

/**
 * Values the ITEMS in front of the editor cannot supply — the game's own catalog (`/catalog/types`).
 *
 * A shopping list names what you do NOT own: read off the shop floor and the armory, the `type` list held the
 * nine types that happened to be in stock out of the game's thirty-one, so the one clause a want rule is mostly
 * made of could not be written. A SELL list has no use for this — you can only sell what you hold — which is
 * why it is the caller's to supply rather than something the picker reaches for.
 */
export interface Vocabulary {
  /** Extra values per FIELD id, merged into that field's list. */
  values: Record<string, string[]>;
  /** Which slot a `type` value mounts in, so a type nobody owns still lands in the right group. */
  slotOfType?: Record<string, string>;
}

export interface WhereEditorProps {
  where: Where;
  onChange: (next: Where) => void;
  /** The game's own vocabulary, for a list that shops for what is not here yet. */
  catalog?: Vocabulary;
  /** The population the picker offers values from — what a clause will be run against, plus anything else the
   *  vocabulary should stay rich against (a station's few rows alone would hide most fields). */
  items: Item[];
  ctx: FieldCtx;
  /** Which popover is open, held by the caller so two editors on one screen cannot both be open. */
  openPop: string | null;
  setOpenPop: (s: string | null) => void;
  /** Namespaces this editor's popover, since the id is compared against one shared value. */
  popId?: string;
  addLabel?: string;
}

/** The clause chips, followed by the adder. The lead words ("Keep", "everything") belong to the caller: they
 *  are what the rule is FOR, and only the caller knows. */
export function WhereChips(p: WhereEditorProps) {
  const entries = Object.entries(p.where);
  const set = (next: Where) => p.onChange(next);
  // Which CLAUSE the picker is looking at lives HERE, not inside the picker: a chip has to be able to send it to
  // its own clause, which is what makes an existing one editable rather than only deletable. A field carries
  // several clauses, so the target is a clause key — `null` means the next tick starts a new one.
  const [pickField, setPickField] = useState("l");
  const [pickKey, setPickKey] = useState<string | null>(null);
  const editIn = (key: string) => {
    setPickField(fieldOf(key));
    setPickKey(key);
    p.setOpenPop((p.popId ?? "") + "where");
  };
  return (
    <>
      {entries.map(([key, cond], i) => {
        const k = fieldOf(key);
        const F = FIELDS[k];
        if (!F) return null;
        const drop = () => { const w = { ...p.where }; delete w[key]; set(w); };
        // Every clause opens ITSELF in the picker. A set clause has no other way to be changed — its values are
        // a tick list — and reopening the picker by hand meant finding the field again in a pane that hides
        // whatever the current inventory does not happen to vary.
        const open = (label: string, extra = "") => (
          <button className={"chipword" + extra} title={`click to change ${F.label}`}
                  onClick={(e) => { e.stopPropagation(); editIn(key); }}>{label}</button>
        );
        if (F.kind === "range") {
          const c = cond as RangeCond;
          const hasMin = c.min != null, hasMax = c.max != null;
          const numBox = (v: number, on: (n: number) => void) => <NumBox value={v} onCommit={on} />;
          // Which SIDE the bound is on is part of the clause and has to be editable in place. The picker
          // only ever ADDS a bound, so re-adding the opposite comparison closes a range instead of flipping
          // one — the clause could only be corrected by deleting it and starting again.
          const flip = (to: "min" | "max") => set({
            ...p.where, [key]: to === "min" ? { min: c.max ?? null, max: null } : { min: null, max: c.min ?? null },
          });
          const side = (label: string, to: "min" | "max") => (
            <button className="chipword" title="click to flip the comparison" onClick={() => flip(to)}>{label}</button>
          );
          // `level vs mine` is read as a DIRECTION and a distance — "at least 10 below mine" — never as the
          // signed offset it is stored as. Every word of that is a control: which end, how far, which way.
          if (k === "lrel") {
            const setTerm = (was: "min" | "max", t: RelTerm) => {
              const next: RangeCond = { min: c.min ?? null, max: c.max ?? null };
              next[was] = null;                       // a flipped term moves to the other bound
              const b = relBound(t);
              next[b.side] = b.value;
              set({ ...p.where, [key]: next });
            };
            const terms = (["min", "max"] as const)
              .map((s) => [s, relTermOf(c, s)] as const)
              .filter((x): x is readonly ["min" | "max", RelTerm] => !!x[1]);
            // The quantifier decides the SHAPE of the clause: three of its five readings carry no distance
            // at all, and those are the ones a player reaches for most ("everything at or below my level").
            const fixed = relFixedQ(c);
            const qSelect = (value: RelQ, onPick: (q: RelQ) => void) => (
              <select value={value} onChange={(e) => onPick(e.target.value as RelQ)}>
                {REL_QS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            );
            // Moving to a reading that needs one starts at ONE level, in the direction the old one named:
            // a distance of 0 with a quantifier is the arithmetic this list exists to avoid.
            const pick = (was: "min" | "max", t: RelTerm | null, q: RelQ) => {
              const f = relFixed(q);
              if (f) return set({ ...p.where, [key]: f });
              const dir = t?.dir ?? (fixed === "at or above" ? "above" : "below");
              setTerm(was, { q: q as RelTerm["q"], n: t?.n || 1, dir });
            };
            return (
              <span key={key} className="sl-chip">
                {i > 0 && <span className="sl-and">AND</span>}
                <span className="cw">level is </span>
                {!terms.length && !fixed && <span className="cw">anything</span>}
                {fixed && qSelect(fixed, (q) => pick(fixed === "at or above" ? "min" : "max", null, q))}
                {!fixed && terms.map(([s, t], ti) => (
                  <Fragment key={s}>
                    {ti > 0 && <span className="cw"> and </span>}
                    {qSelect(t.q, (q) => pick(s, t, q))}
                    <NumBox value={t.n} onCommit={(n) => setTerm(s, { ...t, n: Math.abs(n) })} />
                    <span className="cw">{t.n === 1 ? "level" : "levels"}</span>
                    <select value={t.dir} onChange={(e) => setTerm(s, { ...t, dir: e.target.value as RelTerm["dir"] })}>
                      <option value="below">below</option>
                      <option value="above">above</option>
                    </select>
                  </Fragment>
                ))}
                <span className="cw"> mine</span>
                <span className="dim sl-abs" title={`Your level is ${p.ctx.myLevel}`}>{relAbs(c, p.ctx.myLevel)}</span>
                <button onClick={drop}>×</button>
              </span>
            );
          }
          // A floor-only field has no other shape to take, so the words are words and only the number is a control
          //.
          if (F.onlyMin) {
            return (
              <span key={key} className="sl-chip">
                {i > 0 && <span className="sl-and">AND</span>}
                {open(F.label)}<span className="cw"> at least </span>
                {numBox(c.min ?? 0, (n) => set({ ...p.where, [key]: { min: n, max: null } }))}
                <button onClick={drop}>×</button>
              </span>
            );
          }
          return (
            <span key={key} className="sl-chip">
              {i > 0 && <span className="sl-and">AND</span>}
              {open(F.label)}<span className="cw"> is </span>
              {hasMin && hasMax && <>{numBox(c.min!, (n) => set({ ...p.where, [key]: { ...c, min: n } }))}<span className="cw"> to </span>{numBox(c.max!, (n) => set({ ...p.where, [key]: { ...c, max: n } }))}</>}
              {hasMax && !hasMin && <>{numBox(c.max!, (n) => set({ ...p.where, [key]: { ...c, max: n } }))}{side("or less", "min")}</>}
              {hasMin && !hasMax && <>{numBox(c.min!, (n) => set({ ...p.where, [key]: { ...c, min: n } }))}{side("or more", "max")}</>}
              {!hasMin && !hasMax && <span className="cw">anything</span>}
              <button onClick={drop}>×</button>
            </span>
          );
        }
        const c = cond as SetCond;
        return (
          <span key={key} className={"sl-chip" + (c.not ? " neg" : "")}>
            {i > 0 && <span className="sl-and">AND</span>}
            {open(F.label)}{" "}
            {/* The reading is a WORD of the clause, so it is edited where it is read — the same treatment the
                relative-level chip gives its quantifier. Nothing here says `not` or `and`: those are what the
                rule stores, and a player should not have to compose them to say "any 2 of these". */}
            <SetQSelect where={p.where} clause={key} onChange={set} />
            {" "}
            {open(c.values.map((v) => valueLabel(k, v)).join(setQOf(c) === "all" ? " and " : " or "), " sl-vals-edit")}
            <button onClick={drop}>×</button>
          </span>
        );
      })}
      <WherePicker {...p} field={pickField} setField={setPickField} clause={pickKey} setClause={setPickKey} />
    </>
  );
}

/**
 * The reading of a ticked list, said in words and editable as words: `has any of`, `has all of`,
 * `has at least [2]`, `has none of`, `is missing at least one of`, `has fewer than [2]`.
 *
 * ONE control, used by the chip AND by the picker's footer, over `SET_QS` — the vocabulary the SENTENCE is
 * built from too. The rule stores `not` and a threshold; nobody is asked to combine them, because "any 2 of
 * these" out of a NOT and an ALL checkbox is arithmetic, not a filter.
 *
 * A field that answers with ONE value (a size, a quality) gets the two readings it can honour.
 */
function SetQSelect({ where, clause, onChange }: { where: Where; clause: string; onChange: (w: Where) => void }) {
  const c = where[clause] as SetCond;
  const several = FIELDS[fieldOf(clause)]?.kind === "multi";
  const q = setQOf(c);
  const one = c.values.length === 1;
  const options = several ? SET_QS : SET_QS_ONE;
  // A threshold needs at least two values to be about, and "all of" says nothing over a single one.
  const usable = options.filter((x) => (one ? x === "any" || x === "none" : true));
  const put = (next: SetCond) => onChange({ ...where, [clause]: next });
  return (
    <>
      <select value={q} title="what the ticked values have to add up to"
              onChange={(e) => put(setCondFor(e.target.value as SetQ, c, needCount(c)))}>
        {usable.map((x) => <option key={x} value={x}>{setQWords(x, several, one)}</option>)}
      </select>
      {setQNeedsNumber(q) && (
        <>
          <NumBox value={needCount(c)} onCommit={(n) => put(setCondFor(q, c, Math.max(2, Math.round(n))))} />
          <span className="cw">of</span>
        </>
      )}
    </>
  );
}

/**
 * The clause target that means "not one of the existing ones" — what the picker holds while the player is
 * writing an ADDITIONAL clause about a field that already has one. It cannot be `null`: that is the state of
 * having chosen nothing yet, which edits the field's first clause.
 */
const NEW_CLAUSE = "+";

/** A clause in two or three words, for the row that picks which of a field's clauses is being edited. */
function clauseBrief(c: Cond | undefined, field: string): string {
  if (!c) return "anything";
  if (FIELDS[field]?.kind === "range") {
    const r = c as RangeCond;
    return [r.min != null ? "≥ " + r.min : null, r.max != null ? "≤ " + r.max : null].filter(Boolean).join(" ") || "anything";
  }
  const s = c as SetCond;
  const vals = s.values.map((v) => valueLabel(field, v));
  const txt = vals.length > 2 ? `${vals.slice(0, 2).join(", ")} +${vals.length - 2}` : vals.join(", ");
  return (s.not ? "not " : "") + (txt || "anything");
}

/* ---- two panes: the field on the left, its values on the right ---------------------------------- */
export function WherePicker(p: WhereEditorProps & {
  field: string; setField: (f: string) => void;
  /** The clause being edited, `NEW_CLAUSE` to start another about this field, or null for the field's first. */
  clause: string | null; setClause: (c: string | null) => void;
}) {
  const openId = (p.popId ?? "") + "where";
  const isOpen = p.openPop === openId;
  const { trigger, at } = usePopAnchor(isOpen);
  const set = (next: Where) => p.onChange(next);

  // The field being looked at is the CHIPS' state (a chip sends the picker to its own field); the half-written
  // comparison is this popover's own, since nothing outside it can read a number that is not a clause yet.
  const pickField = p.field, setPickField = p.setField;
  const [pickOp, setPickOp] = useState("lte");
  // The relative-level adder speaks the chip's vocabulary, so it holds the same two words rather than an op.
  const [pickRelQ, setPickRelQ] = useState<RelQ>("at least");
  const [pickRelDir, setPickRelDir] = useState<RelTerm["dir"]>("below");
  const [pickNum, setPickNum] = useState("");
  const [pickQ, setPickQ] = useState("");

  // A field the rule ALREADY uses is always listed, however uniform the items in front of us are. Hiding it
  // leaves a clause that can only be deleted: the rule was written at another station, or against a bigger
  // armory, and "nothing here varies by it" is no reason to take away the way to change it.
  // A field the CATALOG can vary is offered too: a station stocking one damage type says nothing about whether
  // the player wants to shop for another.
  const fields = FIELD_ORDER.filter((k) => FIELDS[k]
    && (fieldVaries(p.items, k, p.ctx) || (p.catalog?.values[k]?.length ?? 0) > 1 || hasField(p.where, k)));
  const field = fields.includes(pickField) ? pickField : fields[0];
  const F = field ? FIELDS[field] : null;

  // WHICH clause about that field the panes edit. A chip sends its own; picking the field sends null, which is
  // the field's first clause (so ticking values keeps refining the clause that is already there); asking for
  // another sends `NEW_CLAUSE`, and the first tick then mints a key of its own.
  const keys = clauseKeys(p.where, field);
  const slot = p.clause === NEW_CLAUSE ? null
    : p.clause && p.clause in p.where && fieldOf(p.clause) === field ? p.clause
    : keys[0] ?? null;
  const cur = slot ? p.where[slot] : undefined;

  // Same rule for VALUES: a ticked value that nothing on offer has must still be listed, or the tick cannot be
  // seen and cannot be cleared. Appended after what the items do have, since it is not on offer here.
  const withTicked = (listed: (string | number)[]): (string | number)[] => {
    const ticked = (cur as SetCond | undefined)?.values ?? [];
    const have = new Set(listed.map(String));
    return [...listed, ...ticked.filter((v) => !have.has(v))];
  };

  /** What the ITEMS themselves answer with — everything the catalog adds is not here, and says so on screen. */
  const onOffer = useMemo(() => {
    const out = new Set<string>();
    for (const it of p.items) {
      const v = FIELDS[field]?.get(it, p.ctx);
      const xs = v == null || v === "" ? [] : Array.isArray(v) ? v : [v];
      for (const x of xs) out.add(String(x));
    }
    return out;
  }, [p.items, p.ctx, field]);

  const valuesFor = (f: string): (string | number)[] => {
    const extra = p.catalog?.values[f] ?? [];
    if (f === "cat") return withTicked([...Object.keys(p.ctx.cats).filter((n) => p.items.some((it) => (p.ctx.cats[n] ?? []).includes(it.type ?? ""))), ...extra]);
    if (f === "r") return withTicked(RARITY_ORDER.filter((r) => p.items.some((it) => it.rarity === r) || extra.includes(r)));
    // Items with NONE of this field are offered as a value of their own, last. Left out, a rule that names an
    // activity or a damage type silently condemns every module and booster the player owns: they cannot match
    // it, so the default stance takes them and the rule never said so.
    let none = false;
    const vals = [...new Set([...p.items.flatMap((it) => {
      const v = FIELDS[f].get(it, p.ctx);
      const xs = v == null || v === "" ? [] : Array.isArray(v) ? v : [v];
      if (!xs.length) { none = true; return []; }
      return xs;
    }), ...extra])];
    const sorted = vals.every((v) => typeof v === "number")
      ? (vals as number[]).sort((a, b) => a - b)
      : vals.map(String).sort();
    return withTicked(none ? [...sorted, NO_VALUE] : sorted);
  };

  const toggle = (v: string | number) => {
    const val = String(v);
    const c = cur as SetCond | undefined;
    const w = { ...p.where };
    if (c?.values && slot) {
      const next = c.values.includes(val) ? c.values.filter((x) => x !== val) : [...c.values, val];
      // A clause with nothing ticked selects everything, so unticking the last value is dropping the clause.
      if (next.length) w[slot] = { ...c, values: next }; else { delete w[slot]; p.setClause(null); }
    } else {
      // The new clause is now the one being edited, or the next tick would start another beside it.
      const k = freeKey(p.where, field);
      w[k] = { values: [val], not: false };
      p.setClause(k);
    }
    set(w);
  };
  const applyCompare = () => {
    const target = slot ?? freeKey(p.where, field);
    // A distance-free reading is the one comparison that can be added without a number.
    const fixed = field === "lrel" ? relFixed(pickRelQ) : null;
    if (fixed) {
      set({ ...p.where, [target]: fixed });
      p.setClause(target);
      p.setOpenPop(null);
      return;
    }
    if (pickNum === "") return;
    const n = +pickNum;
    const c = { ...(cur as RangeCond | undefined ?? { min: null, max: null }) };
    if (field === "lrel") {
      // The picker writes the clause the CHIP will read, in the same words — `relBound` decides which bound
      // that is. Two vocabularies for one clause is how the editor and the rule come to disagree.
      const b = relBound({ q: pickRelQ as RelTerm["q"], n: Math.abs(n), dir: pickRelDir });
      c[b.side] = b.value;
    } else if (F?.onlyMin) {
      c.min = n;
      c.max = null;
    } else {
      if (pickOp === "lt") c.max = n - 1;
      if (pickOp === "lte") c.max = n;
      if (pickOp === "gt") c.min = n + 1;
      if (pickOp === "gte") c.min = n;
      if (pickOp === "eq") { c.min = n; c.max = n; }
    }
    set({ ...p.where, [target]: c });
    p.setClause(target);
    setPickNum("");
    // A comparison is COMPLETE once added, so the picker's work is done and it gets out of the way. Value
    // lists are the opposite case and stay open: ticking types one at a time is the normal way to use them.
    p.setOpenPop(null);
  };

  const ql = pickQ.trim().toLowerCase();
  const slotOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of p.items) { const t = typeOf(it); if (t && !m.has(t)) m.set(t, it.slotType ?? "—"); }
    return m;
  }, [p.items]);

  return (
    <span className="sl-popwrap">
      {/* The primary of the three adders while the rule still matches everything: narrowing is the only one
          that must happen, and the other two refine what narrowing produced. */}
      <button ref={trigger} className={"sl-add" + (isOpen ? " on" : "") + (Object.keys(p.where).length ? "" : " start")}
              onClick={(e) => { e.stopPropagation(); p.setOpenPop(isOpen ? null : openId); setPickQ(""); }}>
        {p.addLabel ?? "＋ narrow it down"}
      </button>
      {isOpen && F && (
        <div className="sl-pop" style={at} onClick={(e) => e.stopPropagation()}>
          <div className="sl-pk2">
            <div className="sl-fields">
              {fields.map((k) => (
                <button key={k} className={"sl-field" + (k === field ? " sel" : "") + (hasField(p.where, k) ? " used" : "")}
                        onClick={() => { setPickField(k); p.setClause(null); setPickQ(""); }}>
                  {FIELDS[k].label}
                </button>
              ))}
            </div>
            <div className="sl-vals">
              {/* WHICH clause about this field is being written. Several of them are ANDed, which is the only
                  way to say "any of these AND any of those": one ticked list is a single OR however it is
                  counted, and `all` over the union demands every value in it. */}
              {!!keys.length && (
                <div className="sl-slots">
                  {keys.map((k, i) => (
                    <button key={k} className={"sl-slot" + (k === slot ? " sel" : "")} onClick={() => p.setClause(k)}>
                      {i + 1}. {clauseBrief(p.where[k], field)}
                    </button>
                  ))}
                  <button className={"sl-slot add" + (slot === null ? " sel" : "")} onClick={() => p.setClause(NEW_CLAUSE)}>
                    ＋ another {F.label} filter
                  </button>
                </div>
              )}
              {F.kind === "range" ? (
                <>
                  <div className="sl-pkrow">
                    {/* The adder writes the same sentence the chip reads back, word for word — a relative level
                        is a direction and a distance here too, never the signed offset it is stored as. */}
                    {field === "lrel" ? (
                      <>
                        <span className="dim">level is</span>
                        <select value={pickRelQ} onChange={(e) => setPickRelQ(e.target.value as RelQ)}>
                          {REL_QS.map((x) => <option key={x} value={x}>{x}</option>)}
                        </select>
                        {relNeedsNumber(pickRelQ) && (
                          <>
                            <input type="number" min={0} value={pickNum} onChange={(e) => setPickNum(e.target.value)}
                                   onKeyDown={(e) => { if (e.key === "Enter") applyCompare(); }} />
                            <span className="dim">{pickNum === "1" ? "level" : "levels"}</span>
                            <select value={pickRelDir} onChange={(e) => setPickRelDir(e.target.value as RelTerm["dir"])}>
                              <option value="below">below</option>
                              <option value="above">above</option>
                            </select>
                          </>
                        )}
                        <span className="dim">mine</span>
                      </>
                    ) : (
                      <>
                        <span className="dim">{F.label}</span>
                        {/* A field with one reading offers no comparison to pick — the word IS the operator. */}
                        {F.onlyMin
                          ? <span className="dim">at least</span>
                          : (
                            <select value={pickOp} onChange={(e) => setPickOp(e.target.value)}>
                              {OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                            </select>
                          )}
                        <input type="number" value={pickNum} onChange={(e) => setPickNum(e.target.value)}
                               onKeyDown={(e) => { if (e.key === "Enter") applyCompare(); }} />
                      </>
                    )}
                    <button className="apply"
                            disabled={pickNum === "" && !(field === "lrel" && !relNeedsNumber(pickRelQ))}
                            onClick={applyCompare}>add</button>
                  </div>
                  {field === "lrel" && (
                    <div className="dim sl-opt">
                      {!relNeedsNumber(pickRelQ)
                        ? `Your own level is Lv ${p.ctx.myLevel}`
                        : `You are Lv ${p.ctx.myLevel} · ${Math.abs(+pickNum || 0)} ${pickRelDir} is Lv `
                          + Math.max(1, p.ctx.myLevel + (pickRelDir === "below" ? -1 : 1) * Math.abs(+pickNum || 0))}
                    </div>
                  )}
                  <div className="dim sl-opt" title="Add a second comparison to close the range.">
                    {(() => {
                      const c = cur as RangeCond | undefined;
                      if (!c) return "";
                      const bounds = [c.min != null ? "≥ " + c.min : null, c.max != null ? "≤ " + c.max : null].filter(Boolean).join("  ");
                      return field === "lrel" && bounds ? `${bounds}  ${relAbs(c, p.ctx.myLevel)}` : bounds;
                    })()}
                  </div>
                  {slot && <button className="mini" onClick={() => { const w = { ...p.where }; delete w[slot]; set(w); p.setClause(null); }}>clear</button>}
                </>
              ) : (
                <>
                  {valuesFor(field).length > 12 && (
                    <input value={pickQ} placeholder={`search ${F.label}…`} onChange={(e) => setPickQ(e.target.value)} />
                  )}
                  <div className="sl-vlist">
                    {(() => {
                      const all = valuesFor(field).filter((v) => !ql || String(v).toLowerCase().includes(ql));
                      const ticked = (cur as SetCond | undefined)?.values;
                      // A value the catalog knows and nothing here has is still tickable — that is the whole
                      // point of a shopping list — but it is marked, so "none of these are in stock" is a fact
                      // the player reads rather than a count they have to work out.
                      const opt = (v: string | number) => (
                        <button key={String(v)} className={"sl-val" + (ticked?.includes(String(v)) ? " on" : "")
                                  + (onOffer.has(String(v)) || v === NO_VALUE ? "" : " away")}
                                title={onOffer.has(String(v)) || v === NO_VALUE ? undefined : "nothing here has this"}
                                onClick={() => toggle(v)}>
                          {ticked?.includes(String(v)) ? "✓ " : ""}{valueLabel(field, String(v))}
                        </button>
                      );
                      if (field !== "t") return all.map(opt);
                      // `type` is the long list, so its values sit under the slot they go in. A type nobody owns
                      // has no item to read that off, which is what the catalog's own map is for.
                      const bySlot = new Map<string, (string | number)[]>();
                      for (const v of all) {
                        const k = slotOf.get(String(v)) ?? p.catalog?.slotOfType?.[String(v)] ?? "—";
                        const a = bySlot.get(k); if (a) a.push(v); else bySlot.set(k, [v]);
                      }
                      const rank = (k: string) => (k === "Hardpoint" ? -1 : k === "Booster" ? 1 : 0);
                      return [...bySlot.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
                        .flatMap((k) => [<div key={"h" + k} className="sl-sub">{k}</div>, ...bySlot.get(k)!.map(opt)]);
                    })()}
                  </div>
                  {/* The footer says the clause being built as a sentence — `substat has at least 2 of` — over
                      the same control the chip carries. Two checkboxes named NOT and ALL asked the player to do
                      boolean algebra to reach a reading the list can simply offer. */}
                  <div className="sl-pkfoot">
                    {slot && cur ? (
                      <span className="sl-pkq">
                        <span className="cw">{F.label}</span>
                        <SetQSelect where={p.where} clause={slot} onChange={set} />
                        <span className="cw">
                          {(cur as SetCond).values.length} ticked
                        </span>
                      </span>
                    ) : (
                      <span className="dim">tick what it may be — several read as “any of these” until you say otherwise</span>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="sl-pkclose"><button className="mini" onClick={() => p.setOpenPop(null)}>close</button></div>
        </div>
      )}
    </span>
  );
}
