import { num } from "./format";
import { GOAL_LABEL, type FrontierPoint, type GoalKey, type GoalReading } from "./fleetDps";

/**
 * WHAT OTHER ALLOWANCES BUY.
 *
 * The `allow` box states how much of a ranked stat a plan may spend, and it is the one thing a player can state
 * without an exchange rate between two stats. This lists what the search returns at the neighbouring settings, so
 * the trade is picked from real builds rather than reasoned about.
 *
 * NO VOCABULARY OF ITS OWN, and that is the whole design. A row is named by the NUMBER the player types in the
 * box beside it, and its columns are the keys they put in the goal order, printed by the same labels the rest of
 * the tab uses. An earlier revision named each row for the constraint that produced it — `all damage`, `lose no
 * tank`, `+10% tank` — and invented `floor`, `tank` and `warn threshold` to explain them; the player could read
 * none of it, and the fix is to have nothing to explain rather than to explain it better.
 */
export interface AllowanceSweepProps {
  /** The keys the player ranked, in their order. The first is what a plan buys; the rest are what it may spend. */
  order: readonly GoalKey[];
  /** What the ship reads NOW, so a row is a change rather than a bare figure. */
  now: GoalReading | null;
  /** The allowance in force, so its row can be marked as the one being flown under. */
  allowance: number;
  points: FrontierPoint[] | null;
  /** How many steps were solved, so a short list says so instead of looking like a small armory. */
  solved: number | null;
  busy: boolean;
  onBuild: () => void;
  onPick: (p: FrontierPoint) => void;
  onClear: () => void;
}

const pctOf = (v: number | undefined, base: number | undefined) =>
  v == null || base == null || !(base > 0) ? "" : `${v >= base ? "+" : ""}${(((v - base) / base) * 100).toFixed(1)}%`;

export default function AllowanceSweep({ order, now, allowance, points, solved, busy,
                                        onBuild, onPick, onClear }: AllowanceSweepProps) {
  // An order is what an allowance bounds. With none stated there is nothing to sweep, and a control that cannot
  // act is worse than an absent one.
  if (!order.length) return null;
  const pc = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div className={`sweep${points ? " open" : ""}`}>
      <div className="sweep-bar">
        {/* "other allowances" named the MECHANISM and told a player nothing: what the panel offers is other
            BUILDS, and the allowance is only how each one was reached. The rows say the rest themselves, in the
            numbers the player typed and the keys they ranked, so nothing here explains them. */}
        <span className="sweep-title">alternate builds</span>
        {points
          ? <button className="sweep-go" onClick={onClear}>close</button>
          : <button className="sweep-go" onClick={onBuild} disabled={busy}>
              {busy ? "searching…" : "show"}
            </button>}
      </div>

      {points && (
        <div className="sweep-body">
          {!points.length && (
            <div className="sweep-none">
              Every allowance solved to the same build, so there is nothing to choose between. The order decides
              this ship on its own.
            </div>
          )}
          {!!points.length && (
            <table className="sweep-tbl">
              <thead>
                <tr>
                  <th>allow</th>
                  {order.map((k) => <th key={k} className="n">{GOAL_LABEL[k]}</th>)}
                  <th />
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.allow} className={p.allow === allowance ? "mine" : undefined}>
                    <td>
                      {pc(p.allow)}
                      {p.allow === allowance && <i>yours</i>}
                    </td>
                    {order.map((k) => (
                      <td key={k} className="n">
                        {p.reading[k] == null ? "—" : num(Math.round(p.reading[k] as number))}
                        <i>{pctOf(p.reading[k], now?.[k])}</i>
                      </td>
                    ))}
                    <td><button onClick={() => onPick(p)}>take it</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {/* The count, not a caveat: a sweep that solved five settings and lists two has told the player
              something (three of them buy nothing new), and silence would read as a thin armory instead. */}
          {solved != null && solved > points.length && (
            <div className="sweep-foot">
              {solved} settings solved, {points.length} distinct {points.length === 1 ? "build" : "builds"} —
              the rest returned one already listed.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
