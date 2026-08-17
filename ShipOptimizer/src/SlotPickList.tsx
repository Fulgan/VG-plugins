import type { ReactNode } from "react";
import { itemIcon, type Conn } from "./api";
import { RARITY_COLOR } from "./format";
import type { Item } from "./types";

// THE "CHOOSE AN ITEM FOR THIS SLOT" LIST — one component, every tab.
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
export interface SlotPickListProps {
  /** What the list is choosing FOR, shown in the head — "Fits this slot", "Slot #3". */
  title: string;
  items: Item[];
  conn: Conn;
  query: string;
  setQuery: (q: string) => void;
  placeholder?: string;
  onPick: (it: Item) => void;
  onClose: () => void;
  /** Hover wiring, so the caller decides what the cursor card compares against. */
  hoverProps?: (it: Item) => Record<string, unknown>;
  /** Where else this item is already promised, if anywhere — rendered as the `in …` marker. */
  spokenFor?: (it: Item) => string | null;
  /** Per-row cells between the name and the trailing figure (aspect marks, relative value, resonance…). */
  cells?: (it: Item) => ReactNode;
  /** The trailing figure. Free-form because a turret's is a DPS-ish power and a booster's is its main stat. */
  mainCell: (it: Item) => ReactNode;
  /** Anything above the rows — the gear tab's aspect-filter chips. */
  header?: ReactNode;
  /** A first row that is not an item: the boosters tab's "let the optimizer decide". */
  leadRow?: ReactNode;
  emptyText: string;
  /** Stable row identity; the two tabs key items differently (a gear handle, a booster id). */
  keyOf: (it: Item) => string;
}

export default function SlotPickList({
  title, items, conn, query, setQuery, placeholder, onPick, onClose,
  hoverProps, spokenFor, cells, mainCell, header, leadRow, emptyText, keyOf,
}: SlotPickListProps) {
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
              <span className="li-icon" style={{ backgroundImage: `url("${itemIcon(conn, it) ?? ""}")` }} />
              <span className="li-name" style={{ color: RARITY_COLOR[it.rarity] ?? "#cfcfcf" }}>{it.name}</span>
              {where && (
                <span className="li-elsewhere" title={`Already proposed for ${where}. Picking it here moves it — there is only one of it.`}>
                  in {where}
                </span>
              )}
              {cells?.(it)}
              <span className="li-main">{mainCell(it)}</span>
              <span className="li-lvl dim">Lv {it.level}</span>
            </div>
          );
        })}
      </div>
      </div>
    </>
  );
}
