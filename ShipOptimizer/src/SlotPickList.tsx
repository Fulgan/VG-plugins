import type { ReactNode } from "react";
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
  title, items, query, setQuery, placeholder, onPick, onClose,
  hoverProps, spokenFor, cells, mainCell, header, leadRow, emptyText, keyOf,
  iconOf, nameOf, rarityOf, trailOf,
}: SlotPickListProps<T>) {
  return (
    <>
      {/* CLICK ANYWHERE ELSE TO CLOSE, the way `FilterSelect` already behaves — a list that only Escape can
          dismiss is a modal wearing a dropdown's clothes, and the slot behind it is the thing the player is
          trying to get back to. Same transparent backdrop element, so the two controls close alike. */}
      <div className="fsel-back" onClick={(e) => { e.stopPropagation(); onClose(); }} />
      {/* `stopPropagation` because the panel behind this toggles selection on click. */}
      <div className="gear-list-popin" onClick={(e) => e.stopPropagation()}>
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
        {leadRow}
        {items.length === 0 && <div className="sum-none">{emptyText}</div>}
        {items.map((it) => {
          const where = spokenFor?.(it) ?? null;
          return (
            // Clicking the row IS the pick: the list opens inside the slot it applies to, so dragging it across
            // and a separate "select" button were both ceremony around a click that was already there.
            <div key={keyOf(it)} className="gear-litem"
                 onClick={() => onPick(it)}
                 {...(hoverProps?.(it) ?? {})}>
              <span className="li-icon" style={{ backgroundImage: `url("${iconOf(it) ?? ""}")` }} />
              <span className="li-name" style={{ color: RARITY_COLOR[rarityOf(it)] ?? "#cfcfcf" }}>{nameOf(it)}</span>
              {where && (
                <span className="li-elsewhere" title={`Already proposed for ${where}. Picking it here moves it — there is only one of it.`}>
                  in {where}
                </span>
              )}
              {cells?.(it)}
              <span className="li-main">{mainCell(it)}</span>
              <span className="li-lvl dim">{trailOf(it)}</span>
            </div>
          );
        })}
      </div>
      </div>
    </>
  );
}
