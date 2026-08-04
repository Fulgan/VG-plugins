import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Conn } from "./api";

// The three refresh cycles — shops, one station's mission board, the conquest tick — as one strip above the tab
// bar, so they are readable from whichever tab you are on. They used to live inside the Map tab, where the
// question they answer ("is it worth docking yet?") is exactly the question you have while looking at gear.
//
// Only shops and the conquest tick are galaxy-wide. A mission board is per station, so that row names its own.
//
// Fed by `GET /cycles`, not `/galaxy`: the same figures off the same `Clock` calls, but a strip on every tab
// polls this, and `/galaxy` carries every system, station and faction.

const mmss = (secs: number) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;

/**
 * A live countdown extrapolated from one reading: the bridge reports seconds remaining, the tick runs locally.
 *
 *   rearm    these cycles are periodic, so reaching zero starts the next one rather than parking at 0:00. With
 *            `period` known the countdown wraps locally and keeps running even if a refetch is slow or fails.
 *   refetch  expiry also asks for fresh data, correcting the drift from the play clock pausing with the game.
 *            Fired once per cycle, not once per render.
 */
function useCountdown(secs: number | null | undefined, period: number | null | undefined, onExpire: () => void) {
  const [now, setNow] = useState(() => Date.now());
  const fetched = useRef(Date.now());
  const lastCycle = useRef(-1);

  useEffect(() => {
    fetched.current = Date.now();
    lastCycle.current = -1;
    if (secs == null) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [secs]);

  const elapsed = (now - fetched.current) / 1000;
  let left: number | null = null;
  let cycle = 0;
  if (secs != null) {
    const over = elapsed - secs;                    // seconds past the first expiry
    if (over < 0) {
      left = secs - elapsed;
    } else if (period && period > 0) {
      cycle = Math.floor(over / period) + 1;        // which repeat we are in now
      left = period - (over % period);
    } else {
      left = 0;                                     // no period to rearm with
    }
  }

  useEffect(() => {
    if (secs == null || cycle === lastCycle.current) return;
    if (cycle > 0 || left === 0) { lastCycle.current = cycle; onExpire(); }
  }, [cycle, left, secs, onExpire]);

  return left;
}

/**
 * One cycle: a label, the COUNTDOWN, and how long the cycle has been running in parentheses beside it.
 *
 * The countdown is the number that matters, so it is the one that stands alone and it only ever counts DOWN.
 * The elapsed figure is derived from it (`period - left`) rather than measured, which is what keeps the pair
 * consistent across a local rearm, and it sits in parentheses because it answers a different question — "did I
 * just miss one?" — that no one asks first.
 */
function Cycle({ kind, label, secs, period, note, dueLabel = "due", onExpire }: {
  kind: "shop" | "mission" | "conquest";
  label: string;
  secs: number | null | undefined;
  period?: number | null;
  note?: string;
  dueLabel?: string;
  onExpire: () => void;
}) {
  // Zero means the cycle has come due and is waiting on the player rather than on the clock, so there is nothing
  // left to count: it reports when it will happen instead of rearming a countdown that would never be reached.
  const due = secs != null && secs <= 0;
  const left = useCountdown(due ? null : secs, period, onExpire);

  // A row with nothing to count still has to keep ASKING, and there are TWO such states, not one: `due` (waiting on
  // the player) and NO READING AT ALL (`secs == null` — the bridge had no board to report, e.g. undocked before any
  // station was visited). `useCountdown` neither ticks nor fires `onExpire` in either ∴ without this the row latches
  // on its label for the rest of the session — on `dueLabel` for the first, on `—` for the second — and never
  // notices the cycle running again, which for a mission board is the moment the player docks and it rerolls.
  const idle = due || secs == null;
  useEffect(() => {
    if (!idle) return;
    const t = window.setInterval(onExpire, 10000);
    return () => window.clearInterval(t);
  }, [idle, onExpire]);
  const since = left != null && period && period > 0 ? period - left : null;
  const pct = left != null && period && period > 0 ? Math.max(0, Math.min(1, 1 - left / period)) : 0;

  return (
    <div className={`cyc cyc-${kind}`} title={note}>
      <span className="cyc-label">{label}</span>
      <span className={`cyc-time${left != null && left < 120 ? " soon" : ""}`}>
        {due ? dueLabel : left == null ? "—" : mmss(left)}
      </span>
      {since != null && <span className="cyc-since" title="Elapsed since this cycle last rolled over">({mmss(since)} since refresh)</span>}
      <span className="cyc-track"><span className="cyc-fill" style={{ width: `${pct * 100}%` }} /></span>
    </div>
  );
}

export default function CycleTimers({ conn }: { conn: Conn }) {
  const [cycles, setCycles] = useState<Awaited<ReturnType<typeof api.cycles>> | null>(null);

  const load = useCallback(async () => {
    try { setCycles(await api.cycles(conn)); } catch { /* a strip of countdowns is never worth an error bar */ }
  }, [conn]);

  useEffect(() => { void load(); }, [load]);

  // Stable identity: the rows use this as an effect dependency, and a fresh arrow each render would tear down and
  // rebuild their intervals on every paint.
  const refetch = useCallback(() => { void load(); }, [load]);

  // Nothing to show before the first reading, or at the main menu where there is no play clock at all — an
  // empty strip would take a row of height to say nothing.
  if (!cycles?.shopRestock?.nextIn && !cycles?.missionRestock?.nextIn && !cycles?.conquest) return null;

  return (
    <div className="cyc-row">
      <Cycle kind="shop" label="Shop restock"
        secs={cycles.shopRestock?.nextIn} period={cycles.shopRestock?.interval}
        note="All stations at once; stale ones reroll when you dock" onExpire={refetch} />
      {/* The station is NOT in the label: the countdown always restarts at 5:00 on arrival and every board you are
          away from is pinned at the same due value, so the figure is "5:00 since you got here" rather than a fact
          about that station — naming it predicts nothing. It stays in the tooltip for the one case where the row is
          about somewhere you aren't: a station left under 5 minutes ago, still counting while you fly. */}
      <Cycle kind="mission" label="Mission board"
        secs={cycles.missionRestock?.nextIn} period={cycles.missionRestock?.interval} dueLabel="on arrival"
        note={`${cycles.missionRestock?.station ?? "The last station"}'s board. It restarts at 5:00 when you arrive and counts down while you are there. Away, it runs past due and waits for you — so it reads on arrival, and anywhere you left over 5 minutes ago is already stocked.`}
        onExpire={refetch} />
      {cycles.conquest && (
        <Cycle kind="conquest" label="Conquest tick"
          secs={cycles.conquest.tickIn} period={cycles.conquest.tickDelay}
          note="Attacks resolve, control shifts, system levels climb" onExpire={refetch} />
      )}
    </div>
  );
}
