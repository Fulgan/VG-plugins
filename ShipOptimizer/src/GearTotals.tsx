import { activityOf, background, capacityWith, contributionOf, mulOf, sameScale, setPowerByLayer, setRank, type Rank, type ShipPools } from "./fleetDps";
import { energyDraw, reactorBracket, reactorModifier, repowered } from "./reactor";
import type { Item, Vitals } from "./types";
import { num, statTotals } from "./format";
import type { Ranking } from "./GearTab";

export interface ReactorInfo {
  capacity?: number | null;
  used?: number | null;
  usage?: number | null;
  bonus?: number | null;        // the modifier currently baked into the pools
  combatBonus?: number | null;  // extra CombatPower from the skill tree, only at/under 50% usage
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;

// One current → projected row. The delta is what the player is actually deciding on, so it carries the
// colour; `goodUp` flips it for a figure where less is better (energy draw).
function Row({ label, cur, next, fmt, goodUp = true, hint }: {
  label: string; cur: number | null; next: number | null;
  fmt: (v: number) => string; goodUp?: boolean; hint?: string;
}) {
  if (cur == null) return null;
  const changed = next != null && Math.abs(next - cur) > Math.max(1e-9, Math.abs(cur) * 1e-6);
  const d = changed ? (next as number) - cur : 0;
  const better = goodUp ? d > 0 : d < 0;
  return (
    <div className="gt-row" title={hint}>
      <span className="gt-label">{label}</span>
      <span className="gt-cur">{fmt(cur)}</span>
      {changed && <span className="gt-arrow">→</span>}
      {changed && <span className={`gt-next ${better ? "up" : "down"}`}>{fmt(next as number)}</span>}
    </div>
  );
}

// Whole-ship figures for the build being assembled, current against projected.
//
// These exist because gear cannot be judged slot by slot: stats pool at the ship, and energy draw feeds a
// bracketed multiplier on the power pools (see reactor.ts), so a bigger gun can cost damage overall. The panel
// is the only place that answers "is this build actually better".
export default function GearTotals({ pools, reactor, ranking, vitals, curTurrets, nextTurrets, curOther, nextOther, layerNote }: {
  pools?: ShipPools | null;
  reactor?: ReactorInfo | null;
  ranking: Ranking;
  vitals?: Vitals | null;   // hull / armor / shield totals, the game's own; a layer the ship lacks is absent
  curTurrets: Item[];
  nextTurrets: Item[];
  curOther: Item[];   // equipped non-turret gear, for the energy budget
  nextOther: Item[];
  // Why the score is single-layer when it is: set only when the ship cannot reach one layer at all.
  layerNote?: string | null;
}) {
  const capacityNow = reactor?.capacity ?? null;
  const usedNow = reactor?.used ?? null;
  // A REACTOR swap moves the budget itself, so the projected load is over the projected capacity — and the
  // objective's own owner does the arithmetic, aspect lines and multipliers included.
  const capacityNext = capacityNow == null ? null : capacityWith(capacityNow, curOther, nextOther);
  const capacity = capacityNow;

  // Energy is projected as a DELTA against the game's own used figure: the reactor sums every connected item,
  // including gear this tab never shows (boosters), so re-summing what we can see would understate the draw.
  const drawCur = energyDraw([...curTurrets, ...curOther]);
  const drawNext = energyDraw([...nextTurrets, ...nextOther]);
  const usedNext = usedNow == null ? null : usedNow + (drawNext - drawCur);

  const usageNow = capacity && capacity > 0 && usedNow != null ? usedNow / capacity : reactor?.usage ?? null;
  const usageNext = capacityNext && capacityNext > 0 && usedNext != null ? usedNext / capacityNext : null;

  // The modifier baked into the reported pools is the game's own figure where available — the table is only
  // used to project a usage the game hasn't evaluated yet.
  const modNow = reactor?.bonus ?? (usageNow != null ? reactorModifier(usageNow) : null);
  const modNext = usageNext != null ? reactorModifier(usageNext) : null;
  const crossing = modNow != null && modNext != null && modNext !== modNow;
  const bracket = usageNow != null ? reactorBracket(usageNow) : null;

  // Combat power, rebased out of its bracket so item lines (which are raw) can be added and removed, then
  // re-bracketed at the projected usage.
  const cpNow = pools?.poolCombatPower ?? null;
  let cpNext: number | null = null;
  if (cpNow != null) {
    const raw = repowered(cpNow, modNow ?? 0, 0);
    const delta = nextTurrets.reduce((n, it) => n + contributionOf(it).combatPower, 0)
                - curTurrets.reduce((n, it) => n + contributionOf(it).combatPower, 0);
    // A `×Combat Power` line scales the pool rather than adding to it, so the additive move happens with the
    // current product divided out and the pending one put back: `(base + Σ amount) * Π multiplier`, the game's
    // own order. Identical arithmetic to the plain sum when nothing in the build rolls such a line.
    const mulCur = mulOf([...curTurrets, ...curOther], (m) => m.combatPower);
    const mulNext = mulOf([...nextTurrets, ...nextOther], (m) => m.combatPower);
    cpNext = repowered(Math.max(0, (raw / mulCur + delta) * mulNext), 0, modNext ?? modNow ?? 0);
  }

  // The battery's own score against a fixed non-turret background. Only meaningful in expanded mode — simple
  // mode ranks on the headline stat and has no model behind it.
  //
  // The figure is TIERED (see setRank): a combat battery gets a DPS index, a mining or salvage one its power
  // share. They are different units, so the row is labelled by the tier and the projected side is only shown
  // when it stays in the same one — an arrow from a DPS index to a Mining Power figure would read as a change
  // in the same quantity.
  let dpsCur: number | null = null, dpsNext: number | null = null;
  let label = "DPS index";
  let noPool = false;
  if (pools && ranking === "expanded") {
    // setRank applies the reactor bracket itself, from the draw of the set it is given — so no scaling here,
    // which would double-count it. The projected side also shifts the NON-turret draw, because a module swap in
    // this same tab changes the load the turrets are bracketed against.
    const bg = background(pools, curTurrets);
    const cur: Rank = setRank(curTurrets, bg);
    const bgNext = bg.energy
      ? { ...bg, energy: {
            ...bg.energy,
            used: bg.energy.used - energyDraw(curOther) + energyDraw(nextOther),
            // A reactor swap moves the budget, and the reading keeps the one it was taken at (see ShipPools).
            capacity: capacityNext ?? bg.energy.capacity,
            capacityAll: bg.energy.capacityAll ?? bg.energy.capacity,
          } }
      : bg;
    const next: Rank = setRank(nextTurrets, bgNext);
    const act = cur[0] === 1 ? activityOf(curTurrets) : undefined;
    if (act) label = `${act} power`;
    // A bridge that predates the per-activity pools sends none, so a mining battery has nothing to be scored
    // against. Say so rather than print a 0 that reads as "this build does nothing".
    noPool = cur[0] === 1 && (act === "Salvage" ? pools.poolSalvagePower : pools.poolMiningPower) == null;
    if (!noPool) {
      dpsCur = cur[1];
      // Same TIER is not enough: a Mining figure against a Salvage one is two units, so the projected side
      // is withheld unless the activity matches too (sameScale).
      dpsNext = sameScale(curTurrets, nextTurrets) ? next[1] : null;
    }
  }

  // A defensive total projected across the pending build. The game applies a stat's lines as it walks them
  // (`num += add; num *= mul`), so an exact replay needs their order; what IS exact is the RATIO when only
  // multipliers change, which is the dominant case here (armour plating's main stat is `ArmorHP×`). So: scale the
  // game's own current figure by the multiplier ratio, then shift it by the additive difference. An estimate, and
  // labelled as one — but anchored on a real reading rather than a re-summed guess.
  const lines = (set: Item[], stat: string) => {
    let add = 0, mul = 1;
    for (const it of set) {
      const t = statTotals(it).get(stat);
      if (t) { add += t.add; mul *= t.mul; }
    }
    return { add, mul };
  };
  const project = (cur: number | null, stat: string): number | null => {
    if (cur == null) return null;
    const a = lines([...curTurrets, ...curOther], stat);
    const b = lines([...nextTurrets, ...nextOther], stat);
    if (a.add === b.add && Math.abs(a.mul - b.mul) < 1e-9) return cur;
    const scaled = a.mul !== 0 ? (cur - a.add) * (b.mul / a.mul) + b.add : cur;
    return Math.max(0, scaled);
  };

  // Precision is pooled, and it projects exactly the way Combat Power does — both halves of a stat line, with
  // no reactor bracket to unwind (Precision is not a `reactorAffectedStat`).
  const precNow = pools?.poolPrecision ?? null;
  const precNext = precNow == null ? null
    : Math.max(0, (precNow / mulOf([...curTurrets, ...curOther], (m) => m.precision)
        + nextTurrets.reduce((n, it) => n + contributionOf(it).precision, 0)
        - curTurrets.reduce((n, it) => n + contributionOf(it).precision, 0))
        * mulOf([...nextTurrets, ...nextOther], (m) => m.precision));

  // Per-layer throughput, because a gun can only reach the layer it is built for. Scored against the same fixed
  // background as the headline figure, so the rows and the index agree.
  const LAYERS = ["Surface", "Core"];
  const powerRows = !pools ? [] : (["Mining", "Salvage"] as const).flatMap((act) => {
    const bg = background(pools, curTurrets);
    return LAYERS.map((layer) => ({
      label: `${act} power · ${layer}`,
      cur: setPowerByLayer(curTurrets, bg, act, layer),
      next: setPowerByLayer(nextTurrets, bg, act, layer),
    })).filter((r) => r.cur != null || r.next != null);
  });

  const nothing = capacity == null && cpNow == null && dpsCur == null;
  return (
    <aside className="gear-totals">
      <div className="gt-head">This build</div>
      {nothing && <div className="sum-none" title="The bridge sent no pools — an older plugin, or no live ship">No ship figures</div>}

      <Row label={label} cur={dpsCur} next={dpsNext} fmt={(v) => num(v)}
           hint={label === "DPS index"
             ? "Estimated damage per second for the WHOLE battery, including pooled crit, typed bonuses and aspects. A relative index for comparing builds, not a number the game shows."
             : `This battery's share of the ship's ${label.toLowerCase()} pool, with the reactor bracket applied. No crit or fire rate: throughput here is the power share, not a per-shot figure.`} />
      {pools && ranking === "simple" && (
        <div className="gt-note dim">The build score needs the <b>expanded</b> ranking — simple mode has no model behind it.</div>
      )}
      {noPool && (
        <div className="gt-note dim">
          No {label.toLowerCase()} figure — the bridge sent no {label.toLowerCase()} pool (an older plugin).
        </div>
      )}

      <Row label="Combat power" cur={cpNow} next={cpNext} fmt={(v) => num(v)}
           hint="The pooled Combat Power every gun draws from, with the reactor bracket applied." />

      {/* Only for a battery that actually feeds the combat pool — a mining ship's Combat Power says nothing. */}
      {powerRows.map((r) => (
        <Row key={r.label} label={r.label} cur={r.cur} next={r.next} fmt={(v) => num(v)}
             hint="This battery's share of the pool, counting only the guns that can hit that layer — a Surface-only battery has no Core power at all." />
      ))}
      {/* A single-layer score is a substitution, so it says so: silence here is indistinguishable from a bug. */}
      {layerNote && <div className="gt-note dim">{layerNote}</div>}

      <Row label="Precision" cur={precNow} next={precNext} fmt={(v) => num(v)}
           hint="Pooled Precision, which sets crit chance for every gun through the game's own soft-capping curve." />

      {vitals && (
        <>
          <div className="gt-sep" />
          <Row label="Hull" cur={vitals.hull?.max ?? null} next={project(vitals.hull?.max ?? null, "Hull HP")} fmt={(v) => num(v)}
               hint="Maximum hull, projected across this build. An estimate: the game applies a stat's additive and multiplier lines in its own order." />
          <Row label="Armor" cur={vitals.armor?.max ?? null} next={project(vitals.armor?.max ?? null, "Armor HP")} fmt={(v) => num(v)}
               hint="Maximum armor. Absent when the ship carries no armor layer." />
          <Row label="Shield" cur={vitals.shield?.max ?? null} next={project(vitals.shield?.max ?? null, "Shield HP")} fmt={(v) => num(v)}
               hint="Maximum shield. Absent when the ship carries no shield generator." />
        </>
      )}

      {capacity != null && (
        <>
          <div className="gt-sep" />
          <Row label="Energy used" cur={usedNow} next={usedNext} fmt={(v) => num(v)} goodUp={false}
               hint={`Of ${num(capacity)} capacity. Every equipped item's effective draw, aspects included.`} />
          <Row label="Load" cur={usageNow} next={usageNext} fmt={pct} goodUp={false}
               hint="Used capacity as a fraction. The bracket it lands in multiplies Combat, Mining and Salvage Power." />
          <Row label="Reactor bonus" cur={modNow} next={modNext} fmt={signed}
               hint="Bracketed power modifier: +20% under 50% load, +10% to 75%, none to 100%, then −25% / −50% / −75%." />
          {!!reactor?.combatBonus && (usageNow ?? 1) <= 0.5 && (
            <div className="gt-note dim">
              +{pct(reactor.combatBonus)} extra Combat Power from the skill tree while load stays at or under 50%.
            </div>
          )}
          {crossing && (
            // The whole reason the panel exists: a swap that looks like an upgrade can cross a threshold and
            // dock every gun's power.
            <div className={`gt-warn ${(modNext as number) > (modNow as number) ? "good" : "bad"}`}>
              {(modNext as number) > (modNow as number) ? "▲" : "⚠"} This change moves the reactor bracket
              {" "}{signed(modNow as number)} → {signed(modNext as number)}, which scales <b>all</b> power pools.
            </div>
          )}
          {!crossing && bracket?.nextAt != null && usageNow != null && (
            <div className="gt-note dim">
              {pct(bracket.nextAt - usageNow)} of capacity left before the bonus drops to {signed(bracket.nextMod as number)}.
            </div>
          )}
        </>
      )}
    </aside>
  );
}
