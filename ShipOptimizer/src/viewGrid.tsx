// The LAYOUT bar: grouping, columns and the sort in force, over any grid that lets a player drive it.
//
// Owned by no tab. It began on the sell list's review grid and the inventory tab's three grids want the
// same control — and those grids do NOT share a column vocabulary with it: the sell list names columns by
// `FIELDS` key while `ItemGrid` has its own set (Item, Type, Lvl, Where, Qual, per-stat columns). So the
// vocabulary is a PARAMETER: the caller says which keys exist, what each is called, and which of them a player
// may group by. Anything less and the bar would have to know about both, which is how one control becomes two.
import { useMemo, useState } from "react";
import type { ViewState } from "./sellView";
import "./sellList.css";

export interface ViewBarProps {
  view: ViewState;
  setView: (v: ViewState) => void;
  /** Column keys this grid can show, in the order the picker lists them. */
  fields: string[];
  /** Keys a player may GROUP by — a subset: a column of distinct numbers makes one group per row. */
  groupable: string[];
  /** What a key is called on screen. */
  label: (k: string) => string;
  /**
   * Whether an EMPTY `cols` means "every column" for this grid, rather than "no columns".
   *
   * The two callers disagree, and the disagreement is why the picker lied: the sell list stores an explicit list
   * (`DEFAULT_COLS`) so empty means empty, while `ItemGrid` treats empty as untouched-so-show-everything — which
   * left a grid displaying all its columns with not one box ticked, and made UNticking a box produce a one-column
   * table (`[] → [k]` reads as "show only k"). One type over two conventions is fine; leaving the bar to guess
   * which one it is looking at is not.
   */
  allWhenEmpty?: boolean;
}

/* ---- the view bar: how the REVIEW list is laid out, and nothing about what it decides -------------
 *
 * It sits on the list that decides what sells, because that is the list a player reads item by item — "what am
 * I about to lose the most on" is a sort, not a rule. Worded apart from a rule's own `counting … separately`
 * on purpose: two controls that both say "group by", one of which edits the pipeline, is a trap sprung by
 * reading normally.
 */
export function ViewBar(q: ViewBarProps) {
  const [pick, setPick] = useState<"group" | "cols" | null>(null);
  const v = q.view;
  const own = !!v.group.length;
  const fieldLabel = q.label;
  // Offered: whatever the caller says this grid HAS, plus whatever is already ticked so it can be UNticked.
  // The caller does the narrowing — the sell list drops a field every row answers the same (`fieldVaries`), which
  // is what keeps `price` out of a list of things you own.
  const colFields = useMemo(
    () => [...q.fields, ...v.cols.filter((k) => !q.fields.includes(k))], [q.fields, v.cols]);
  // What the grid is ACTUALLY showing, which is what a tick has to mean.
  const shownCols = useMemo(
    () => (q.allWhenEmpty && v.cols.length === 0 ? q.fields : v.cols), [q.allWhenEmpty, q.fields, v.cols]);
  const toggleCol = (k: string) => {
    const next = shownCols.includes(k) ? shownCols.filter((x) => x !== k) : [...shownCols, k];
    // Back to the "everything" sentinel once all of them are ticked again, so a column added by a later build
    // shows up on its own instead of being hidden by a list written before it existed.
    const all = q.allWhenEmpty && next.length === q.fields.length && q.fields.every((f) => next.includes(f));
    q.setView({ ...v, cols: all ? [] : next });
  };
  const groupPick = useMemo(() => q.groupable.filter((k) => !v.group.includes(k)), [q.groupable, v.group]);
  const move = (i: number, d: number) => {
    const g = [...v.group], j = i + d;
    if (j < 0 || j >= g.length) return;
    [g[i], g[j]] = [g[j], g[i]];
    q.setView({ ...v, group: g });
  };
  return (
    <div className="sl-view">
      <span className="lead">layout</span>
      <span className="sl-vchips">
        {!own && <span className="dim">one list, no groups</span>}
        {v.group.map((k, i) => (
          <span key={k} className="sl-vchip">
            <button className="mv" title="move out one level" onClick={() => move(i, -1)}>‹</button>
            {fieldLabel(k)}
            <button className="mv" title="move in one level" onClick={() => move(i, 1)}>›</button>
            <button className="x" title="stop grouping by this"
                    onClick={() => q.setView({ ...v, group: v.group.filter((x) => x !== k) })}>×</button>
          </span>
        ))}
        <button className="mini" onClick={() => setPick(pick === "group" ? null : "group")}>+ group by…</button>
        {own && <button className="mini" title="drop every grouping and show one list"
                        onClick={() => q.setView({ ...v, group: [] })}>ungroup</button>}
        <button className="mini" onClick={() => setPick(pick === "cols" ? null : "cols")}>columns…</button>
        {!!v.sort.length && (
          <button className="mini" title={v.sort.map((s) => `${fieldLabel(s.k)} ${s.dir}`).join(", ")}
                  onClick={() => q.setView({ ...v, sort: [] })}>
            sorted by {v.sort.map((s) => fieldLabel(s.k)).join(", ")} ×
          </button>
        )}
      </span>
      {pick === "group" && (
        <div className="sl-vpop">
          {groupPick.map((k) => (
            <button key={k} className="mini" onClick={() => { q.setView({ ...v, group: [...v.group, k] }); setPick(null); }}>
              {fieldLabel(k)}
            </button>
          ))}
          {!groupPick.length && <span className="dim">nothing left that tells these rows apart</span>}
        </div>
      )}
      {pick === "cols" && (
        <div className="sl-vpop">
          {colFields.map((k) => (
            <label key={k} className="sl-vcol">
              <input type="checkbox" checked={shownCols.includes(k)} onChange={() => toggleCol(k)} />
              {fieldLabel(k)}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

