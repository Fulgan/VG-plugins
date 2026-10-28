import { useEffect, useRef, type ReactNode } from "react";
import { RARITY_COLOR } from "./format";

// THE "CHOOSE SOMETHING FOR THIS SLOT" LIST: one component, every tab.
//
// The gear tab grew it first: a pop-in over the slot rather than a column (a permanent rail cost width on every
// unselected slot) with a search box, rows that ARE the pick (clicking one answers the question the pop-in was
// asking, so it closes), a marker on anything already spoken for elsewhere, and Escape to leave.
//
// The boosters tab then needed the same thing, and the same thing is what it must GET: reproducing the markup
// under the same class names is how two surfaces come to disagree about a detail nobody notices until it is a
// bug — this repo's costliest defect, and the reason `the build checks.ps1` exists. What differs between the two is
// not the list, it is which CELLS a row carries, so that is the prop: `cells` renders whatever the caller wants
// between the name and the trailing value.
//
// THE ROW IS A TYPE PARAMETER, not an `Item`. The officers tab picks an `Officer`, which has no icon URL of its
// own and no `level` field meaning what a turret's means. A component typed to whatever its first callers
// happened to hold is a component the third caller must copy, so what a row NEEDS is stated as accessors (a
// key, a name, a rarity, an icon, a trailing note), and every caller answers them for its own kind.
export interface SlotPickListProps<T> {
  /** What the list is choosing FOR, shown in the head — "Fits this slot", "Slot #3". */
  title: string;
  items: T[];
  query: string;
  setQuery: (q: string) => void;
  placeholder?: string;
  onPick: (it: T) => void;
  onClose: () => void;
  /** Refuse this row on this ship, or lift the refusal. Absent ⇒ the list offers no ban at all. */
  onBan?: (it: T) => void;
  /** Whether the row already carries one, so the control states which way it goes. */
  banned?: (it: T) => boolean;
  /** Hover wiring, so the caller decides what the cursor card compares against. */
  hoverProps?: (it: T) => Record<string, unknown>;
  /** Where else this row is already promised, if anywhere, rendered as the `in …` marker. */
  spokenFor?: (it: T) => string | null;
  /** Per-row cells between the name and the trailing figure (aspect marks, relative value, resonance…). */
  cells?: (it: T) => ReactNode;
  /** The trailing figure. Free-form because a turret's is a DPS-ish power and a booster's is its main stat. */
  mainCell: (it: T) => ReactNode;
  /** Anything above the rows — the gear tab's aspect-filter chips. */
  header?: ReactNode;
  /** A first row that is not one of the items: the boosters tab's "let the optimizer decide". */
  leadRow?: ReactNode;
  /**
   * Hand the slot back to the optimizer, WITHOUT refusing what was in it.
   *
   * Clearing and ignoring are different requests and were one control: dropping a choice says nothing about the
   * item, while ignoring it says never offer this again. A player trying gear out needs the first, and the only
   * way to it was an unlabelled cross on the card's tag.
   */
  onClearSlot?: () => void;
  emptyText: string;
  /** Stable row identity; every tab keys differently (a gear handle, a booster id, an officer guid). */
  keyOf: (it: T) => string;
  /** The row's own thumbnail. `null` leaves the square empty rather than requesting a missing image. */
  iconOf: (it: T) => string | null;
  nameOf: (it: T) => string;
  /** Keys `RARITY_COLOR`; anything it does not know falls back to the neutral text colour. */
  rarityOf: (it: T) => string;
  /** The far-right note after the main cell: `Lv 74` for gear, an officer's profession and level. */
  trailOf: (it: T) => ReactNode;
}

export default function SlotPickList<T>({
  title, items, query, setQuery, placeholder, onPick, onClose, onBan, banned,
  hoverProps, spokenFor, cells, mainCell, header, leadRow, onClearSlot, emptyText, keyOf,
  iconOf, nameOf, rarityOf, trailOf,
}: SlotPickListProps<T>) {
  const popRef = useRef<HTMLDivElement>(null);
  // The PRESS decides, not a click on an overlay: by the time a click completes, the element under it has
  // already been chosen, so closing on mousedown lets the same gesture answer the slot it was aimed at.
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);
  return (
    <>
      {/* CLICK ANYWHERE ELSE TO CLOSE, and the click still ARRIVES where it was aimed. A transparent backdrop
          did the closing before, which meant the first click on another slot was spent dismissing this list and
          the player had to click that slot twice: once to close, once to open. Listening for the press instead
          leaves nothing over the page, so one click closes this and opens the next. */}
      {/* `stopPropagation` because the panel behind this toggles selection on click. */}
      <div className="gear-list-popin" ref={popRef} onClick={(e) => e.stopPropagation()}>
      <div className="gear-list-head">
        <b>{title}</b>
        <span className="dim">· {items.length}</span>
        <span className="spacer" />
        <button className="popin-x" title="close (Esc)" onClick={onClose}>×</button>
      </div>
      <input className="gear-list-search" value={query} onChange={(e) => setQuery(e.target.value)}
             placeholder={placeholder ?? "search name / type…"} />
      {header}
      <div className="gear-list">
        {onClearSlot && (
          <div className="pick-clear"><button type="button" className="undo-suggest" onClick={onClearSlot}>clear this suggestion</button></div>
        )}
        {leadRow}
        {items.length === 0 && <div className="sum-none">{emptyText}</div>}
        {items.map((it) => {
          const where = spokenFor?.(it) ?? null;
          return (
            // Clicking the row IS the pick: the list opens inside the slot it applies to, so dragging it across
            // and a separate "select" button were both ceremony around a click that was already there.
            <div key={keyOf(it)} className="gear-litem"
                 onClick={() => onPick(it)}>
              {/* The cursor card opens under the pointer ∴ only the icon and the name summon it, or it covers the
                  row's own controls at the far end and they cannot be reached. */}
              <span className="li-hov" {...(hoverProps?.(it) ?? {})}>
                <span className="li-icon" style={{ backgroundImage: `url("${iconOf(it) ?? ""}")` }} />
                <span className="li-name" style={{ color: RARITY_COLOR[rarityOf(it)] ?? "#cfcfcf" }}>{nameOf(it)}</span>
              </span>
              {where && (
                <span className="li-elsewhere" title={`Already proposed for ${where}. Picking it here moves it — there is only one of it.`}>
                  in {where}
                </span>
              )}
              {cells?.(it)}
              <span className="li-main">{mainCell(it)}</span>
              <span className="li-lvl dim">{trailOf(it)}</span>
              {/* The ban sits ON the row it refuses and stops the click from picking what it is rejecting. */}
              {onBan && (
                <button className={`li-ban${banned?.(it) ? " on" : ""}`}
                        title={banned?.(it) ? "Offer this again on this ship" : "Stop offering this on this ship"}
                        onClick={(e) => { e.stopPropagation(); onBan(it); }}>{banned?.(it) ? "show" : "ignore"}</button>
              )}
            </div>
          );
        })}
      </div>
      </div>
    </>
  );
}
