import { useState } from "react";
import { GOAL_KEYS, GOAL_LABEL, type GoalKey } from "./fleetDps";

/**
 * THE PLAYER STATES THE ORDER — the one control behind, and the reason it is an order rather than a weight.
 *
 * A weight cannot be stated: there is no knowable exchange rate between a hull point and a point of damage, and
 * "how much better is Combat Power than Armor" has no answer a player could give. A position does.
 *
 * COLLAPSED TO ONE LINE, opening on demand. It is a SETTING — read often, changed rarely — so what it costs when
 * shut is what it costs most of the time, and the sentence it collapses to is the thing worth having on screen
 * beside a plan. Expanded it takes a full-width row of its own rather than a column wedged into the button bar,
 * where five rows of list had to share a line with a number field and two buttons.
 */
export interface GoalOrderProps {
  order: GoalKey[];
  setOrder: (next: GoalKey[]) => void;
  /**
   * Ranked keys this ship's plan cannot be judged on, from `goalUnread`. Rendered as a stated gap rather than
   * left to look like agreement: a key the search cannot MOVE and a key it moved to a tie are the same pixels,
 * and only one of them is a verdict.
   */
  unread?: readonly GoalKey[];
  /**
   * The keys this hull can be ranked on (`goalKeysFor`). A key nothing can read orders nothing, so offering it
   * would invite a goal the app then ignores — V48's shape. Absent ⇒ every key, which is what a caller with no
   * hull in hand should show.
   */
  offer?: readonly GoalKey[];
}

export default function GoalOrder({ order, setOrder, unread = [], offer = GOAL_KEYS }: GoalOrderProps) {
  const [open, setOpen] = useState(false);
  // The key being dragged. Held here rather than read off the drag event because Safari does not expose
  // `dataTransfer` payloads during `dragover`, and the insertion marker has to follow the pointer.
  const [held, setHeld] = useState<GoalKey | null>(null);
  const [over, setOver] = useState<GoalKey | null>(null);

  // An order the player already stated is never hidden, even if this hull cannot read it: silently dropping a
   // stated goal is worse than showing one that reports itself unread.
  const rest = offer.filter((k) => !order.includes(k));

  // Landing on a position rather than swapping with it: dropping "armor" onto row 1 means "armor is now first",
  // which is what the gesture looks like. A swap would move a key the player never touched.
  const drop = (at: number) => {
    if (!held) return;
    const from = order.indexOf(held);
    const without = order.filter((k) => k !== held);
    // ⚠ `at` INDEXES THE ORIGINAL LIST while the splice happens after the removal, so dragging DOWNWARDS landed
    // one place late: `[dps, combat, precision, armor]`, dropping `dps` on the `precision` row, gave
    // `[combat, precision, dps, armor]` instead of `[combat, dps, precision, armor]`. Removing an earlier element
    // shifts every later index left by one, and only downward drags cross the hole.
    const to = from >= 0 && at > from ? at - 1 : at;
    setOrder(at < 0 ? without : [...without.slice(0, to), held, ...without.slice(to)]);
    setHeld(null);
    setOver(null);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length) return;
    const n = [...order];
    [n[from], n[to]] = [n[to], n[from]];
    setOrder(n);
  };

  return (
    <div className={`goal-order${open ? " open" : ""}`}>
      <div className="goal-bar">
        <span className="goal-title">goal order</span>
        <span className="goal-said">
          {order.length
            ? order.map((k, i) => (
                <span key={k} className={unread.includes(k) ? "goal-chip unread" : "goal-chip"}>
                  {GOAL_LABEL[k]}
                  {i < order.length - 1 && <i className="goal-arrow">›</i>}
                </span>
              ))
            : <span className="goal-none">nothing ranked — the objective has no opinion</span>}
        </span>
        <button className="goal-edit" onClick={() => setOpen(!open)}>{open ? "done" : "edit"}</button>
      </div>

      {open && (
        <div className="goal-body">
          <div className="goal-half">
            <div className="goal-head">
              ranked, in order
              <span className="goal-hint" title="Read top down: each goal decides, and the next only breaks a tie">
                first is consulted first
              </span>
            </div>
            <ul className="goal-list">
              {order.map((k, i) => (
                <li
                  key={k}
                  className={`goal-row${held === k ? " held" : ""}${over === k ? " over" : ""}`}
                  draggable
                  onDragStart={() => setHeld(k)}
                  onDragEnd={() => { setHeld(null); setOver(null); }}
                  onDragOver={(e) => { e.preventDefault(); setOver(k); }}
                  onDrop={(e) => { e.preventDefault(); drop(i); }}
                >
                  <span className="goal-rank">{i + 1}</span>
                  <span className="goal-name">{GOAL_LABEL[k]}</span>
                  {unread.includes(k) && (
                    <span className="goal-unread" title="This plan cannot move this measurement, so the order does not apply here">
                      not read here
                    </span>
                  )}
                  {/* The two arrows keep their slot at every position, disabled at the ends. Hiding one shifts
                      every control on the row and makes the column jump as the list is reordered. */}
                  <span className="goal-moves">
                    <button disabled={i === 0} title="Move up" onClick={() => move(i, i - 1)}>▲</button>
                    <button disabled={i === order.length - 1} title="Move down" onClick={() => move(i, i + 1)}>▼</button>
                    <button className="goal-drop" title="Stop consulting this measurement"
                            onClick={() => setOrder(order.filter((x) => x !== k))}>×</button>
                  </span>
                </li>
              ))}
              {!order.length && <li className="goal-empty">nothing ranked</li>}
            </ul>
          </div>

          <div className="goal-half">
            <div className="goal-head">
              not consulted
              <span className="goal-hint" title="Measured and shown, but the objective forms no opinion about them">
                measured, never ranked
              </span>
            </div>
            {/* CHIPS, not rows: nothing here has a position, so a numbered list would imply one. */}
            <ul className="goal-rest">
              {rest.map((k) => (
                <li key={k}>
                  <button title="Consult this measurement, after the ones already ranked"
                          onClick={() => setOrder([...order, k])}>
                    {GOAL_LABEL[k]}<i>+</i>
                  </button>
                </li>
              ))}
              {!rest.length && <li className="goal-empty">everything is ranked</li>}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
