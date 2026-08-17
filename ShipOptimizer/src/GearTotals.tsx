import { activityOf, background, BASE_CRIT_CHANCE, capacityWith, contributionOf, mulOf, poolsWithModules, precisionCrit, projectLayer, sameScale, setPowerByLayer, setRank, type Rank, type ReactorBudget, type ShipPools } from "./fleetDps";
import { energyDraw, reactorBracket, reactorModifier, repowered } from "./reactor";
import type { Item, Vitals } from "./types";
import { num } from "./format";
import type { Ranking } from "./GearTab";
import { useEffect } from "react";
import { save, PLAN_KEY } from "./storage";

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
export default function GearTotals({ pools, reactor, ranking, vitals, curTurrets, nextTurrets, curOther, nextOther, layerNote, budgetNote, shipGuid }: {
  pools?: ShipPools | null;
  // Only so the published diagnosis record says WHICH ship it describes; the panel itself never reads it.
  shipGuid?: string | null;
  // Projected out of the pools by `reactorBudgetOf` — never read off `/status` a second time, or the load printed
  // here and the load the score divided by drift apart the moment a cached reading stands in.
  reactor?: ReactorBudget | null;
  ranking: Ranking;
  vitals?: Vitals | null;   // hull / armor / shield totals, the game's own; a layer the ship lacks is absent
  curTurrets: Item[];
  nextTurrets: Item[];
  curOther: Item[];   // equipped non-turret gear, for the energy budget
  nextOther: Item[];
  // Why the score is single-layer when it is: set only when the ship cannot reach one layer at all.
  layerNote?: string | null;
  // Why there is no set score at all: the held budget and the reported one straddle a bracket edge.
  budgetNote?: string | null;
}) {
  const capacityNow = reactor?.capacity ?? null;
  const usedNow = reactor?.used ?? null;
  // A REACTOR swap moves the budget itself, so the projected load is over the projected capacity — and the
  // objective's own owner does the arithmetic, aspect lines and multipliers included.
  const capacityNext = capacityNow == null ? null : capacityWith(capacityNow, curOther, nextOther);
  // THE PLAN'S POOLS, moved by the module swaps themselves — their pooled stats, their draw and the capacity.
  // Every projected figure below reads from this. Projecting only the DRAW (which is what this did) made a module's
  // own contribution invisible: a scanner swap giving up 1,122 Mining Power showed no change on any mining row,
  // and the per-layer rows scored the planned battery against the CURRENT background outright.
  // `poolsWithModules` is the objective's own owner for this, so the panel and the score cannot disagree.
  const projPools = pools ? poolsWithModules(pools, curOther, nextOther) : null;
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
  const modNow = reactor?.mod ?? (usageNow != null ? reactorModifier(usageNow) : null);
  const modNext = usageNext != null ? reactorModifier(usageNext) : null;
  const crossing = modNow != null && modNext != null && modNext !== modNow;

  // Combat power, rebased out of its bracket so item lines (which are raw) can be added and removed, then
  // re-bracketed at the projected usage.
  const cpNow = pools?.poolCombatPower ?? null;
  // THROUGH THE OBJECTIVE'S OWN OWNER, and nothing hand-rolled beside it. This row used to compose the projection
  // itself — a `repowered` rebase, an additive delta summed from `contributionOf`, and a multiplier product — and
  // `contributionOf(module).combatPower` is 0, because it reads `catOf`, which classifies TURRET activities and
  // answers null for every module. So a plan swapping a reactor, a hull kit and an armour plate moved this row by
  // nothing while the DPS index below, built from `poolsWithModules`, counted all three: the same quantity derived
  // twice, disagreeing by the whole of what the modules contribute.
  //
  // `poolsWithModules` is positional over out/in and knows nothing about modules specifically, so the whole plan —
  // turrets AND modules — folds through it. Each item's own pooled lines are summed by `poolPart` (main, substats
  // and the `Power` umbrella alike), which is what the POOL holds; the main-power-only reading `contributionOf`
  // returns is a different quantity, for `GetMainPowerSum`, and belongs only inside `setDps`.
  const planPools = pools
    ? poolsWithModules(pools, [...curTurrets, ...curOther], [...nextTurrets, ...nextOther])   // display-projection
    : null;
  // Re-bracketed at the load the plan would fly at: `poolsWithModules` moves the pool's own lines and leaves the
  // reported bracket in place, so the step from `modNow` to `modNext` is applied here and exactly once.
  const cpNext = cpNow == null || planPools?.poolCombatPower == null
    ? null
    : repowered(planPools.poolCombatPower, modNow ?? 0, modNext ?? modNow ?? 0);

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
    // Built from the PLAN's pools (see `projPools`) against the same fitted turrets, so the projection carries the
    // modules' pooled stats and not merely their draw.
    const bgNext = projPools ? background(projPools, curTurrets) : bg;
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
  // `projectLayer` owns this arithmetic (`fleetDps`), because the objective ranks on the same figures the moment
  // survivability becomes a key and a panel deriving them a second way is how a row and a verdict come to
  // disagree about the same swap.
  const project = (cur: number | null, stat: string): number | null =>
    projectLayer(cur, stat, [...curTurrets, ...curOther], [...nextTurrets, ...nextOther]);

  // Precision is pooled, and it projects exactly the way Combat Power does — both halves of a stat line, with
  // no reactor bracket to unwind (Precision is not a `reactorAffectedStat`).
  const precNow = pools?.poolPrecision ?? null;
  const precAdd = (set: Item[]) => set.reduce((n, it) => n + contributionOf(it).precision, 0);
  const precNext = precNow == null ? null
    : Math.max(0, (precNow / mulOf([...curTurrets, ...curOther], (m) => m.precision)
        + (precAdd(nextTurrets) + precAdd(nextOther))
        - (precAdd(curTurrets) + precAdd(curOther)))
        * mulOf([...nextTurrets, ...nextOther], (m) => m.precision));

  // Crit chance from the SAME pools the objective scores with, through the game's own curve and anchored on its
  // reported chance the way `setDps` anchors: the additive sources (skill tree, officers, crit aspects) are held
  // and only the Precision curve moves. Where the bridge reports no chance there is nothing to anchor on and the
  // row is absent rather than invented.
  const critOf = (prec: number | null, p?: ShipPools | null): number | null => {
    if (prec == null || !p || p.critChance == null) return null;
    const mult = p.critChanceMult ?? 1;
    const add = p.critChance / mult - BASE_CRIT_CHANCE - precisionCrit(p.poolPrecision, p.precisionDivisor);
    return (BASE_CRIT_CHANCE + precisionCrit(prec, p.precisionDivisor) + add) * mult;
  };
  const critNow = critOf(precNow, pools);
  const critNext = critOf(precNext, pools);

  // Per-layer throughput, because a gun can only reach the layer it is built for. Scored against the same fixed
  // background as the headline figure, so the rows and the index agree.
  const LAYERS = ["Surface", "Core"];
  const powerRows = !pools ? [] : (["Mining", "Salvage"] as const).flatMap((act) => {
    const bg = background(pools, curTurrets);
    const bgPlan = projPools ? background(projPools, curTurrets) : bg;
    return LAYERS.map((layer) => ({
      label: `${act} power · ${layer}`,
      cur: setPowerByLayer(curTurrets, bg, act, layer),
      // The PLANNED battery against the PLANNED pools — both halves of the change, or the row reports a gun swap
      // while ignoring the module swap sitting beside it in the same plan.
      next: setPowerByLayer(nextTurrets, bgPlan, act, layer),
    })).filter((r) => r.cur != null || r.next != null);
  });

  // WHAT THIS PANEL IS SHOWING, PUBLISHED FOR DIAGNOSIS — the plan, the figures, and the verdict, pushed through
  // `storage.save` (∴ the bridge, per playthrough) so `GET /client/state` answers "what is the player looking at".
  //
  // It is written HERE, at the end of the panel's own derivation, because every other answer to that question is a
  // SECOND derivation and drifts from this one. An offline harness re-mounting the builder was the previous
  // answer, and it silently ran with no slot filters at all: it reported a plan of Kinetic guns while the tab —
  // filtered to one turret category — was proposing something else entirely, and the difference was invisible from
  // the report alone. A published record cannot drift from the panel, because it IS the panel's own values.
  //
  // Small and dedup-friendly on purpose: `queuePush` skips an unchanged payload, so a re-render costs nothing and
  // only a plan that actually changed reaches the bridge. `PLAN_KEY` is DISPOSABLE — diagnosis, never a preference.
  const planRecord = {
    ship: shipGuid ?? null,
    ranking,
    label,
    swaps: [
      ...curTurrets.map((it, i) => [it, nextTurrets[i]] as const),
      ...curOther.map((it, i) => [it, nextOther[i]] as const),
    ].filter(([a, b]) => b && a !== b).map(([a, b]) => ({
      out: `${a.name} Lv${a.level}${a.bonus ? ` Q${a.bonus}` : ""}`,
      in: `${b!.name} Lv${b!.level}${b!.bonus ? ` Q${b!.bonus}` : ""}`,
      outPower: a.mainStat?.amount ?? null, inPower: b!.mainStat?.amount ?? null,
      outDraw: a.powerUsage ?? 0, inDraw: b!.powerUsage ?? 0,
      outAspects: (a.aspects ?? []).map((x) => x.name),
      inAspects: (b!.aspects ?? []).map((x) => x.name),
    })),
    figures: {
      score: { label, cur: dpsCur, next: dpsNext },
      combatPower: { cur: cpNow, next: cpNext },
      precision: { cur: precNow, next: precNext },
      critChance: { cur: critNow, next: critNext },
      load: { cur: usageNow, next: usageNext, bracketCrossed: crossing },
      // THE DEFENSIVE ROWS TOO. The panel has drawn these all along while the objective scored none of them, so
      // a plan could shed a third of the hull for a small DPS gain and the record of that plan would not even
      // show it. A figure nothing scores is exactly the one a diagnosis needs to carry.
      hull: { cur: vitals?.hull?.max ?? null, next: project(vitals?.hull?.max ?? null, "Hull HP") },
      armor: { cur: vitals?.armor?.max ?? null, next: project(vitals?.armor?.max ?? null, "Armor HP") },
      shield: { cur: vitals?.shield?.max ?? null, next: project(vitals?.shield?.max ?? null, "Shield HP") },
    },
    notes: { layerNote: layerNote ?? null, budgetNote: budgetNote ?? null },
  };
  useEffect(() => { save(PLAN_KEY, planRecord); }, [JSON.stringify(planRecord)]);

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
      {/* And a score WITHHELD says so for the same reason, one step further: a tab that quietly stops applying the
          set objective looks exactly like one that found nothing worth changing. */}
      {budgetNote && <div className="gt-note dim">{budgetNote}</div>}

      <Row label="Precision" cur={precNow} next={precNext} fmt={(v) => num(v)}
           hint="Pooled Precision, which sets crit chance for every gun through the game's own soft-capping curve." />
      {/* WHAT THE PRECISION IS FOR, in the unit the damage actually uses. The curve soft-caps past 5%
          (`^0.75`), so on a built-up ship a large Precision move buys almost no crit — 13,401 → 14,295 is
          +6.7% of Precision and +1.0pp of crit, worth about half a percent of damage. Showing only Precision
          invites reading that as a real gain; the chance is the figure a player can weigh against the power
          rows beside it. */}
      <Row label="Crit chance" cur={critNow} next={critNext} fmt={(v) => `${(v * 100).toFixed(1)}%`}
           hint="Crit chance the whole battery fires at, through the game's own soft-capping curve — what the Precision above is worth once the curve is applied." />

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
          {/* THE BUDGET ITSELF, not only what is drawn from it. A reactor swap moves the capacity — and an aspect
              like Microgenerators moves it by a multiplier — so "energy used" alone cannot be checked against
              anything: 6,863 is worse than 5,827 at one capacity and better at another. `capacityWith` folds the
              aspect lines, which is why this row can differ from the reactor's printed headline. */}
          <Row label="Reactor capacity" cur={capacityNow} next={capacityNext} fmt={num}
               hint="Total energy the reactor supplies, including what aspects add or multiply. Load is draw ÷ this." />
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
          {!crossing && (() => {
            // The headroom that MATTERS is the one the player is about to have: with a plan on screen this read the
            // CURRENT load while the row above it showed 49% → 46%, so the panel said "1% left" beside a figure with
            // four. A number describing a different build than the one beside it is read as a contradiction.
            const u = usageNext ?? usageNow;
            if (u == null) return null;
            const b = reactorBracket(u);
            if (b?.nextAt == null) return null;
            return (
              <div className="gt-note dim">
                {pct(b.nextAt - u)} of capacity left before the bonus drops to {signed(b.nextMod as number)}
                {usageNext != null ? ", with this plan applied" : ""}.
              </div>
            );
          })()}
        </>
      )}
    </aside>
  );
}
