// The one verdict on the WHOLE plan, rendered wherever a plan is decided or committed.
//
// Rendered ONLY when the plan is measurably worse. `null` means the objective cannot judge this plan at all
// (simple ranking, no pools, or a module-only change), and an absent warning must never read as "checked, and
// fine" — so there is no reassuring variant of this component to fall into.
import { num } from "./format";

/**
 * What the objective measured about a plan. Everything the notice says comes from here — the figures included,
 * because a warning without them is a claim the player has to take on trust (and one of ours was wrong twice).
 */
export interface PlanVerdict {
  worse: boolean;
  /** What the figure IS ("Mining power", "DPS index") — the two are different units. */
  label: string;
  cur: number;
  next: number;
  /** Fraction of the current figure, negative when worse. Absent where there is no ratio to take. */
  pct?: number | null;
  /**
   * The reactor bracket either side, when the plan MOVES it. Present or absent, never assumed: a bracket that
   * did not move must not be blamed, and one that dropped is not by itself a failure — the objective already
   * nets it against what the plan gains, and this notice only ever appears when that NET came out worse.
   */
  bracket?: { from: number; to: number } | null;
}

const pctText = (f: number) => `${f > 0 ? "+" : "−"}${(Math.abs(f) * 100).toFixed(1)}%`;
const modText = (m: number) => `${m > 0 ? "+" : ""}${Math.round(m * 100)}%`;

export default function PlanNotice({ verdict }: { verdict: PlanVerdict | null }) {
  if (!verdict?.worse) return null;
  const { label, cur, next, pct, bracket } = verdict;
  return (
    <div className="sum-msg warn">
      {/* ONE flex child (`.sum-msg-t`), as in every other `.sum-msg`: this container is a flexbox, so bare text
          nodes and a `<b>` become separate flex items and the sentence renders out of order. */}
      <span className="sum-msg-t">
        {/* THE FIGURES FIRST. "This plan is worse" with a paragraph of theory behind it was reported as impossible
            to understand; what a player needs is the number that got worse, why, and what to do. */}
        ⚠ <b>{label} {num(cur)} → {num(next)}</b>
        {pct != null && <> ({pctText(pct)})</>} — this plan is worse than what you have fitted.{" "}
        {bracket
          ? <>It drops the reactor bonus from {modText(bracket.from)} to {modText(bracket.to)}, which scales every
              power pool, and the extra power does not cover that. A lighter module keeps the bonus.</>
          : <>The changes are worth less together than they look separately. Try removing one.</>}
      </span>
    </div>
  );
}
