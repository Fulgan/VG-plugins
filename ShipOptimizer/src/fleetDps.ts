import type { Item } from "./types";
import { aspectDamageFraction } from "./aspect";
import { mainVal, statTotals } from "./format";
import { catOf, compareModulesWhy, isTurret } from "./itemKind";
import type { ShipFit } from "./roleStats";
import { energyDraw, poolReactorFactor, reactorModifier } from "./reactor";
import { turretScore } from "./turretScore";

// Total ship DPS for a SET of turrets — the objective the expanded gear ranking optimises.
//
// A SET, not a score per slot, because every stat an item rolls registers on the UNIT: `AbstractEquipment.GetStat`
// returns `parent.GetStat(s)` plus the item's own `TurretBoostStat` lines. A Precision roll on one gun therefore
// lifts the crit chance of the whole battery, so a lower-damage turret carrying one can beat a bigger gun — a
// trade no per-slot ranking can express.
//
//   pooled   Precision (→ crit chance, level-scaled and soft-capping), Critical Damage, typed and untyped
//            damage %, the firing-cycle boosts (`fireDelay` is `_fireDelay / (1 + GetStat(AttackSpeed))`), and
//            every power SUBSTAT — which is what the equivalent-turret count divides
//   local    a turret's own MAIN power, its RAW delays and magazine, its aspects, and `TurretBoostStat` lines
//
// Main power is pooled on game 0.8.0.15 and local from 0.8.1.23, where `CalculateAttackPower` subtracts
// `GetMainPowerSum` before dividing: averaged, giving a headline up costs only a seventh of it on a seven-gun
// battery. Putting a stat on the wrong side is never a rounding error — it is a factor of the battery size,
// enough to invert a comparison.
//
// Modules pool too, but this optimiser does not choose them, so they stay part of the fixed background.

// A refit costs a trip to the workshop, so a proposal has to be worth making. The floor belongs to the OBJECTIVE,
// not to any tab: the optimizer, the per-slot suggest and both opportunity rails obey it, and a rail offering what
// the tab declines is one rule living in two places.
//
// It is set by what the model can RESOLVE, not by what a player would notice. Three gaps bound it: an unexplained
// x1.2439 on the combat pool, a multiplier folded into an additive term for the stats with no pool reading to
// scale (see `folded`), and weapon-local aspect stats the bridge cannot see (one worth 25% critical damage on its
// host). Against those a
// predicted 0.28% is noise — and 0.28% was enough to propose trading a Lv64 gun for a Lv63 one.
//
// So 1% is a JUDGEMENT about confidence, not a derivation: it clears that 0.276% case by roughly 4x while still
// letting a real upgrade through. Closing a gap argues for lowering it; churn reappearing argues for raising it.
export const MIN_GAIN = 0.01; // 1% of the whole battery's score

// Below this, the objective is not saying "no better" — it is saying NOTHING, and something it cannot see
// (armour, an aspect slot, breadth) may decide. Above it in either direction the objective HAS an opinion:
// worth a refit only past `MIN_GAIN`, but a measurable loss is a loss at any size and is never an upgrade.
//
// Set well under the model's own resolution on purpose. It exists to separate "identical" from "slightly
// worse", which is the difference between a tie-break and an override — an engine that gave up 425 pooled
// Combat Power and 2,173 of energy headroom was offered as an upgrade because it carried one more aspect slot.
export const OBJECTIVE_TIE = 0.0005;   // 0.05% of the battery's score

/** Ship-level context, from `/status`. The pools include the currently equipped turrets. */
export interface ShipPools {
  poolCombatPower: number;
  poolPrecision: number;
  equivalentTurrets: number;
  precisionDivisor: number;   // 25 × GameMath.DamageMultiplier(level)
  critDamage: number;         // effective, pooled
  megaCrit: number;
  // Pooled fire-cycle boosts, with the equipped turrets' own rolls taken back out by `background()` — the same
  // treatment Precision gets, and for the same reason: every one of them is a UNIT stat that each turret reads
  // back through `parent.GetStat`, so a candidate's roll has to enter the pool rather than stay on its host.
  // Optional because a bridge that predates them sends none: the cycle then stays at the raw rate, a ratio of 1.
  poolAttackSpeed?: number;
  poolReloadSpeed?: number;
  poolMagazineSize?: number;
  // The game's OWN effective crit chance, as reported. Optional: a bridge that does not send it leaves the
  // objective on the base-plus-curve path it used before.
  critChance?: number;
  // The multiplier half of that stat. The game computes crit chance as
  //   (BASE_CRIT_CHANCE + precisionCrit(precision) + additive) * multiplier
  // so the reported product alone does not determine the additive part: 0.19 additive at multiplier 1 and 0
  // additive at multiplier 1.676 report the same number and predict different things once Precision moves.
  critChanceMult?: number;
  // The multiplier on the reported combat pool. `GetStatRaw` is `(base + Σ additive) * Π multiplier`, and the
  // reactor bracket is only one factor of that product — a hull role bonus, skill nodes and gear lines are in
  // there too, running near 2.7 on a Combat hull once the reactor is divided out.
  poolCombatPowerMult?: number;
  // `combatReactorOutputCP.currentIncrease` — a skill-tree term the game ADDS to the reactor factor, for the
  // combat pool only and only in the top bracket. Without it the combat factor reads 1.20 where the game
  // applied 1.617, so both the de-bracket and the re-bracket are out by a third.
  combatReactorBonus?: number;
  // That product with the reactor factor removed: what stays constant while candidates are swapped. Derived by
  // `background()`; absent when the bridge reports no multiplier, which keeps the old arithmetic.
  combatMultResidual?: number;
  // The multiplier on the reported Precision pool. Precision is not a `reactorAffectedStat`, so this is the whole
  // product — hull, crew, skills and any gear line rolling `×Precision`.
  poolPrecisionMult?: number;
  // That product with the EQUIPPED turrets' own `×Precision` lines divided out, so a candidate set applies its
  // own in their place. 1 when the bridge reports no multiplier, which is the arithmetic that predates it.
  precisionResidual?: number;
  // The additive crit sources — skill tree, officers, crit aspects — recovered from the reading and held
  // constant while candidates are scored, exactly as the power pools are. Absent when there is no reading to
  // anchor on, or when the reading cannot be reconciled with the curve.
  critAdd?: number;
  // Mining and salvage have their OWN pools and their own equivalent-turret divisors: the count is per stat, so
  // reusing the combat one misprices a mixed battery. Optional, because a bridge that predates them sends
  // neither — a non-combat battery then has no objective to score against and degrades to no comparison at all
  // rather than to a wrong one.
  poolMiningPower?: number;
  poolSalvagePower?: number;
  // The multipliers on those pools, and the non-reactor residuals derived from them — the same product problem
  // the combat pool has. Absent ⇒ the old arithmetic, since a half-corrected pool is worse than a known-wrong one.
  poolMiningPowerMult?: number;
  poolSalvagePowerMult?: number;
  miningMultResidual?: number;
  salvageMultResidual?: number;
  equivalentTurretsMining?: number;
  equivalentTurretsSalvage?: number;
  // The reactor budget, when the bridge reports one. A turret's ENERGY DRAW is a damage stat: load decides a
  // bracketed multiplier on every power pool (+20% at =<50% down to -75% past 150%, see reactor.ts), so a gun
  // that draws nothing — Solar Powered — can be worth more than one with a bigger headline number and an extra
  // aspect. Without this the objective silently valued draw at zero.
  //
  // THIS IS THE ONLY CARRIER OF THE BUDGET. Anything that shows the player a load, a capacity or a bracket reads
  // it through `reactorBudgetOf` rather than off `/status` again: a second reader drifts from this one the moment
  // a cached reading stands in, and near a bracket edge the two then disagree about a 10% multiplier on every
  // power pool — which is the number that decided the suggestion the player is checking.
  energy?: {
    used: number;      // draw of everything EXCEPT the turrets in the set (modules, boosters, hull)
    capacity: number;
    mod: number;       // the bracket modifier already baked into poolCombatPower
    // The load the game printed, which is the only reading left when `capacity` is 0 — the objective divides
    // `used/capacity` itself and never consults this.
    usage?: number;
    // The ship's TOTAL draw when the pools were read. `used` has the equipped turrets taken out of it, so it is
    // the wrong load to de-bracket a reported figure with: the reading was taken at this one.
    usedAll?: number;
    // And the CAPACITY it was read at, which a reactor swap changes. Load is draw over capacity, so projecting
    // a new capacity onto the old reading de-brackets it by a factor the game never applied — the re-bracket
    // then cancels the de-bracket exactly, and a reactor that costs 11k of budget scores as its substats alone
    //. Absent ⇒ the capacity has not moved, which is every case but a reactor.
    capacityAll?: number;
  };
  // Does this build cut each gun's share AGAIN as the battery grows? Release only — see `poolShare`. Off when
  // the bridge sends no `caps`, which is the beta's behaviour and the safer default: applying a penalty a build
  // does not have would under-value every turret past the second on the branch this UI was written against.
  extraTurretPenalty?: boolean;
}

/**
 * `/status` → the ranking model's inputs, or null when the bridge sent no pools (an older plugin, or no live
 * ship) — the caller then falls back to **simple**, which needs no model.
 *
 * Here rather than in the tab that happens to call it: this is where the DTO's optionality is resolved into the
 * objective's shape, and every rule about what a missing field means lives in one place.
 */
export function poolsFromStatus(s: {
  poolCombatPower?: number | null; poolPrecision?: number | null; equivalentTurrets?: number | null;
  poolMiningPower?: number | null; poolSalvagePower?: number | null;
  equivalentTurretsMining?: number | null; equivalentTurretsSalvage?: number | null;
  precisionDivisor?: number | null; critChance?: number | null; critChanceMult?: number | null;
  poolCombatPowerMult?: number | null; poolMiningPowerMult?: number | null; poolSalvagePowerMult?: number | null;
  poolPrecisionMult?: number | null;
  combatReactorOutputCP?: number | null;
  critDamage?: number | null; megaCrit?: number | null;
  poolAttackSpeed?: number | null; poolReloadSpeed?: number | null; poolMagazineSize?: number | null;
  caps?: { extraTurretPenalty?: boolean } | null;
  energyCapacity?: number | null; energyUsed?: number | null; energyUsage?: number | null;
  reactorBonus?: number | null;
}): ShipPools | null {
  if (s.poolCombatPower == null || s.precisionDivisor == null) return null;
  return {
    poolCombatPower: s.poolCombatPower,
    poolPrecision: s.poolPrecision ?? 0,
    equivalentTurrets: s.equivalentTurrets ?? 1,
    // Left UNDEFINED rather than defaulted: a 0 pool reads as "this ship has no mining power", which a candidate
    // set's own contribution would then stand in for, making its guns look like the whole ship.
    poolMiningPower: s.poolMiningPower ?? undefined,
    poolSalvagePower: s.poolSalvagePower ?? undefined,
    equivalentTurretsMining: s.equivalentTurretsMining ?? undefined,
    equivalentTurretsSalvage: s.equivalentTurretsSalvage ?? undefined,
    precisionDivisor: s.precisionDivisor,
    critChance: s.critChance ?? undefined,
    critChanceMult: s.critChanceMult ?? undefined,
    poolCombatPowerMult: s.poolCombatPowerMult ?? undefined,
    poolPrecisionMult: s.poolPrecisionMult ?? undefined,
    combatReactorBonus: s.combatReactorOutputCP ?? undefined,
    poolMiningPowerMult: s.poolMiningPowerMult ?? undefined,
    poolSalvagePowerMult: s.poolSalvagePowerMult ?? undefined,
    critDamage: s.critDamage ?? 1,
    megaCrit: s.megaCrit ?? 0,
    // 0 is the honest default: a bridge that does not report these leaves every gun's cycle at its raw rate,
    // which is the ratio of 1 the objective used before — wrong in absolute terms but not silently invented.
    poolAttackSpeed: s.poolAttackSpeed ?? 0,
    poolReloadSpeed: s.poolReloadSpeed ?? 0,
    poolMagazineSize: s.poolMagazineSize ?? 0,
    // Energy makes the objective non-linear: load decides a multiplier on every power pool, so a gun's draw is
    // part of what it is worth. `used` is the WHOLE ship's draw here; `background()` takes the equipped turrets'
    // share out so a candidate set's can be added back.
    energy: s.energyCapacity != null && s.energyUsed != null
      ? { used: s.energyUsed, capacity: s.energyCapacity, mod: s.reactorBonus ?? 0,
          usage: s.energyUsage ?? undefined }
      : undefined,
    extraTurretPenalty: s.caps?.extraTurretPenalty === true,
  };
}

/**
 * Can this reading be scored against this battery?
 *
 * A pool reading is only usable if it CONTAINS the gear it will be asked about: `background()` removes the
 * equipped items' own contributions, and if the pool cannot absorb them the subtraction goes negative and gets
 * clamped to 0 — turning a real deficit into a plausible number and changing the objective's shape, because a
 * candidate's own power then becomes the whole pool instead of a small delta on a shared one.
 *
 * The failure it catches is a live unit whose equipment is not registered yet: `statsLive` only means
 * `unit != null`, so a mid-transition unit passes it while reporting hull-and-crew pools — CombatPower an order of
 * magnitude down, `equivalentTurrets` at 0, crew-dominated Precision unmoved. That 0 with turrets in the layout is
 * the same contradiction stated by the bridge itself, and is the cheaper half of the test.
 *
 * NB deliberately NOT keyed on `docked`: a settled undocked reading is identical to the docked one at the same
 * station, so refusing it would throw away good data.
 */
export function poolsReconcile(pools: ShipPools, equippedTurrets: Item[]): boolean {
  // Only the COMBAT battery can be reconciled against `poolCombatPower`, and `equivalentTurrets` is
  // `GetEquivalentTurretsCount(CombatPower)` — so a mining or salvage ship legitimately reports 0 with a full
  // set of guns fitted. Demanding a positive count there refuses every non-combat ship's perfectly good reading.
  const combat = equippedTurrets.filter((it) => isTurret(it) && isCombat(it));
  if (!combat.length) return true;                         // nothing in this pool to reconcile against
  if (!(pools.equivalentTurrets > 0)) return false;        // combat guns fitted, yet none shares the pool
  const own = combat.reduce((n, it) => n + contributionOf(it).combatPower, 0);
  // Reconciled in the SAME space the subtraction happens in. `background()` divides the reported pool by every
  // factor before taking raw contributions out of it, so a guard that only divided out the reactor would be
  // testing a pool several times larger than the one being drained — it would pass while the subtraction still
  // went negative and clamped, which is the exact failure this guard exists to catch.
  return additiveSpace(pools) >= own;
}

/** The reported combat pool with its multipliers removed — `base + Σ additive`, the space contributions live in.
 *  Falls back to reactor-only when the bridge reports no multiplier, which is the arithmetic that predates it. */
function additiveSpace(pools: ShipPools): number {
  const full = pools.poolCombatPowerMult;
  if (full != null && full > 0) return pools.poolCombatPower / full;
  // No reported multiplier: fall back to the factor the game applies to THIS pool, skill term included.
  const usage = pools.energy && pools.energy.capacity > 0 ? loadAsRead(pools.energy) : null;
  const factor = usage != null
    ? poolReactorFactor(usage, pools.combatReactorBonus ?? 0)
    : 1 + (pools.energy?.mod ?? 0);
  return pools.poolCombatPower / factor;
}

/**
 * May these pools score THIS ship's battery?
 *
 * `/status` reports the pools of the ship being FLOWN and has no others to report, while the gear tab can be
 * pointed at a PARKED ship. Scoring one ship's battery against another's pools is not an approximation, it is a
 * different ship: `background()` subtracts a battery the pool never contained, the deficit clamps to 0, and each
 * candidate's own power becomes the whole pool — so a WEAKER gun carrying a pooled Precision or Combat Power roll
 * reads as a large gain, on a background where the crit curve is still in its steep linear stretch.
 *
 * Refusing returns null, which is what puts the tab into SIMPLE mode — the treatment already prescribes for a
 * parked ship. This has to be asked separately from `poolsReconcile`: that one establishes a reading is INTERNALLY
 * consistent, and a cached reading for the flown ship passes it while still describing the wrong hull.
 */
export function poolsForShip(pools: ShipPools | null, poolsShip: string | null, scoring: string | null): ShipPools | null {
  if (!pools) return null;
  return poolsShip && scoring && poolsShip !== scoring ? null : pools;
}

/**
 * The reactor budget as anything OUTSIDE the objective reads it — the load rows, the capacity row, the bracket
 * warning, the skill-tree line.
 *
 * It is a projection of `ShipPools` and never a second read of `/status`, because the pools a score came from are
 * not always the pools the live payload describes: a cached reading stands in around a scene change (see the
 * substitution rule), and a panel reading the live payload would then print a load that decided nothing. On a ship
 * near a bracket edge the two readings land on OPPOSITE sides of it, so every figure the player checks is out by
 * the whole 10% the bracket is worth — with nothing on screen saying which of the two was scored.
 *
 * `capacityAll`/`usedAll` where present: those are the ship's TOTAL draw and the capacity it was read at, and a
 * background()-drained `used` is the wrong load to print for the same reason it is the wrong one to de-bracket
 * with.
 */
export interface ReactorBudget {
  capacity: number | null;
  used: number | null;
  usage: number | null;
  mod: number | null;          // the modifier already baked into the pools
  combatBonus: number | null;  // extra CombatPower from the skill tree, only at/under 50% load
}

export function reactorBudgetOf(pools: ShipPools | null): ReactorBudget | null {
  if (!pools) return null;
  const e = pools.energy;
  const capacity = e ? (e.capacityAll ?? e.capacity) : null;
  const used = e ? (e.usedAll ?? e.used) : null;
  return {
    capacity, used,
    usage: e && (e.capacityAll ?? e.capacity) > 0 ? loadAsRead(e) : (e?.usage ?? null),
    mod: e?.mod ?? null,
    combatBonus: pools.combatReactorBonus ?? null,
  };
}

/**
 * May THIS pool reading be scored against the budget the game is reporting NOW?
 *
 * The substitution rule lets the last reconcilable reading for a ship stand in, silently, because the ranking it
 * produces is still the right one. That holds while the ship's power REGIME is unchanged — and the reactor bracket
 * is a step function, so it is exactly what a stale budget can get wrong. A cached reading taken at 51% load and a
 * live ship at 49% differ by a 10% multiplier on every power pool: the objective prices a build one bracket below
 * what the game and the panel show, and because the two readings drift independently, successive refreshes flip
 * which side of the edge the objective believes it is on. That is a contradiction MANUFACTURED fresh each refresh,
 * so the both-ways guards cannot converge it — they refuse to order a pair, and here the pair changes underneath
 * them.
 *
 * ∴ where the cached budget and the live one land in different brackets the reading is REFUSED (→ simple mode) and
 * the refusal is NAMED: a build priced on the wrong side of a bracket edge is worse than no suggestion, and an
 * objective that quietly stops scoring is indistinguishable from one that found nothing worth changing.
 *
 * Silent, and deliberately so, in the two cases where the cached budget is still the only honest one: the live
 * payload carries no budget at all (the unit is gone, so `reactorModule` reads null), and both budgets sit in the
 * same bracket (a few units of drift decides nothing). Same bracket is the test rather than same NUMBERS, because
 * the load moves by a rounding every refresh and refusing on that would degrade the tab permanently.
 */
export function pairBudget(pools: ShipPools | null, live: ShipPools["energy"] | null): {
  pools: ShipPools | null; note: string | null;
} {
  const held = pools?.energy;
  if (!pools || !held || !live) return { pools: pools ?? null, note: null };
  if (!(held.capacity > 0) || !(live.capacity > 0)) return { pools, note: null };
  const heldUsage = loadAsRead(held);
  const liveUsage = loadAsRead(live);   // a live payload carries no pin, so this is its own load
  if (reactorModifier(heldUsage) === reactorModifier(liveUsage)) return { pools, note: null };
  const pct = (u: number) => `${Math.round(u * 100)}%`;
  return {
    pools: null,
    note: `The reactor load the ranking model holds (${pct(heldUsage)}) and the one the ship reports `
      + `(${pct(liveUsage)}) are in different brackets, worth ${signed(reactorModifier(liveUsage) - reactorModifier(heldUsage))} `
      + `on every power pool — so the set objective is switched off until the reading settles, rather than pricing `
      + `this build on the wrong side of the edge. Ranked on the headline stat meanwhile.`,
  };
}

const signed = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}%`;

/**
 * The MULTIPLIER half of an item's pooled stat lines, 1 where it rolls none.
 *
 * A stat is `(base + Σ amount) * Π multiplier` — `AggregateStatLines` does `calcedStats[st] += line.amount;
 * statMultipliers[st] *= line.multiplier` — so the two halves are different operations on the pool and cannot be
 * summed into one number. A `×1.05 Precision` roll scales the WHOLE unit's Precision, hull and crew included;
 * read as `+0.05` it would be worth nothing at all against a four-figure pool.
 *
 * Only the stats with a POOL READING are carried here. `allDamage` and `typedDamage` have none — see
 * `contributionOf`.
 */
export interface StatMul {
  combatPower: number;
  miningPower: number;
  salvagePower: number;
  precision: number;
  critDamage: number;
  attackSpeed: number;
  reloadSpeed: number;
  magazineSize: number;
}

/** What one item contributes to the pools, from its own parent-free stat lines. */
export interface Contribution {
  combatPower: number;
  miningPower: number;
  salvagePower: number;
  precision: number;
  critDamage: number;
  typedDamage: Map<string, number>;   // damage type → fraction
  allDamage: number;
  // Fire-cycle stats. Pooled like everything else — `AbstractTurret.fireDelay` divides by the UNIT's
  // AttackSpeed — so a roll here belongs to the whole battery and not to the hardpoint carrying it.
  attackSpeed: number;
  reloadSpeed: number;
  magazineSize: number;
  /** The same lines' multiplier halves. Composed by `background`/`poolParts`, never added to the fields above. */
  mul: StatMul;
  /**
   * WEAPON-LOCAL lines — an aspect's `TurretBoostStat`, which `AbstractEquipment.GetStat` folds into this gun
   * and no other. `CalculateDamage` reads them as `sourceTurret.GetStat(...)`, so they belong to the gun's own
   * term in `setDps` and must never be summed into a pool: `Critical Attenuation` (+25% critical damage) is
   * worth one gun's crits, and pooling it would credit the whole battery with a bonus one hardpoint carries.
   */
  local: { critDamage: number; attackSpeed: number; reloadSpeed: number; magazineSize: number };
}

const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();

// Stat lines arrive under the game's DISPLAY names ("Critical Damage"), not the EquipStat spelling.
// Coerced, because the failure mode of a non-number arriving here is invisible: `total +=` would concatenate,
// one NaN reaches every score, `rankGt` answers false to every comparison, and the optimizer silently returns
// its seed as though nothing beat it. A wrong suggestion with no error is the worst shape this can take.
//
// Both halves, kept apart: the game ADDS the amounts and MULTIPLIES the multipliers, and which one a stat line
// carries is not a property of the stat — a percentage line reports `amount: 0` with the factor in `multiplier`.
function part(it: Item, stat: string): { add: number; mul: number } {
  const want = norm(stat);
  let add = 0;
  let mul = 1;
  // POOLED halves only (`add`/`mul`). An aspect's weapon-local line is in `localAdd`/`localMul` and is read by
  // `localPart`, because it reaches one gun rather than the pool this composes.
  for (const [k, v] of statTotals(it))
    if (norm(k) === want) { add += Number(v.add); mul *= Number(v.mul); }
  return { add: Number.isFinite(add) ? add : 0, mul: Number.isFinite(mul) && mul !== 0 ? mul : 1 };
}

/** The WEAPON-LOCAL half of one stat on this item — an aspect's `TurretBoostStat` and nothing else. */
function localPart(it: Item, stat: string): number {
  const want = norm(stat);
  let add = 0;
  for (const [k, v] of statTotals(it))
    // A local MULTIPLIER has no per-gun base to act on in this model, so it folds the way `folded` folds one with
    // no pool reading: `×1.25` counts as +0.25 rather than as nothing.
    if (norm(k) === want) add += Number(v.localAdd) + (v.localMul !== 1 ? Number(v.localMul) - 1 : 0);
  return Number.isFinite(add) ? add : 0;
}

// A stat with no pool reading of its own: the multiplier has nothing to act on, so it is folded into the
// additive term. Wrong in the same way a missing pool is wrong — the unseen base is treated as 0 — but a `×1.05`
// read as a multiple of nothing would price the roll at zero, which is further from the game's answer than
// treating it as the five points it displays as.
function folded(it: Item, stat: string): number {
  const { add, mul } = part(it, stat);
  return add + (mul !== 1 ? mul - 1 : 0);
}

/** One stat's two halves on any item — exported for the module swap, which works on the REPORTED pools. */
export const statPart = part;

/**
 * THE TWO LOADS, AND THE ONLY TWO. Every reactor bracket in this app is one of these, and nothing else may divide a
 * draw by a capacity — `the build checks.ps1` scans for it.
 *
 * The whole family of defects here has been one mistake made in different places: picking one half of the ratio from
 * the READING and the other from the PROJECTION. `usedAll`/`capacityAll` are the pin (the draw and capacity the
 * reported figures were measured at) while `used`/`capacity` are what a candidate would fly at, and mixing them
 * yields a load the ship has never been at — 50.8% on a build whose real loads are 47.2% and 46.2%. Past a bracket
 * edge that invents or destroys a step worth 10-20% of every power pool. Three bugs: (two readings),
 * (`poolsWithModule` pinned one half), (`background`'s residual took the numerator from the projection).
 *
 * The rule was written as V73 and then broken twice more, because it was prose and each site still chose its own
 * fields. Two named owners and a scan make the wrong pairing unwritable instead of merely forbidden.
 */
export const loadAsRead = (e: NonNullable<ShipPools["energy"]>): number =>
  (e.usedAll ?? e.used) / (e.capacityAll ?? e.capacity);   // load-owner

/** The load a candidate would FLY at: the projection's own draw over the projection's own capacity. */
export const loadWith = (e: NonNullable<ShipPools["energy"]>, extraDraw = 0): number =>
  (e.used + extraDraw) / e.capacity;   // load-owner

// `Power` is the UMBRELLA over the three power pools, and a multiplier on it scales all of them at once.
//
// MEASURED on the live Assayer, game 0.8.1.23: an Engine carrying the aspect `Operational Reserves`
// (`Power ×1.02`, its only line) raised `poolCombatPowerMult`, `poolMiningPowerMult` AND `poolSalvagePowerMult`
// by exactly 1.02 while `poolPrecisionMult`, `critChanceMult` and `poolAttackSpeed` did not move at all. Those
// three pools are the game's own `reactorAffectedStats` minus `Power` itself, so the line reaches them the way
// the reactor bracket does rather than the way a named `×Mining Power` roll does.
//
// It matters because `MODULE_POOLS` maps a pool to ONE stat name: a line called `Power` matched no entry and was
// dropped, so the projection carried the reported multiplier through unchanged and every projected power figure
// came out 2% above what the game then reported.
//
// BOTH halves are the umbrella's, and the game says so per contribution. `GET /stat/sources?stat=<pool>` reports a
// `via` naming the stat each amount arrived through, and on the Manglor "2nd law" (0.8.1.23) the Reactor's
// `Power 2,289.86` and a Missile Launcher's `Power 1,262.33` appear under CombatPower, MiningPower AND
// SalvagePower alike — while `Precision` lists no `Power` source at all. MiningPower's whole additive sum on that
// ship IS those two lines, so a projection that drops them reports no mining change for a reactor swap.
//
// `Power` is ⊥ DRAW: draw arrives as `powerUsage`, and a reactor carrying `Power 2,289.86` reports
// `powerUsage: 0` — it contributes power, it does not consume it.
const POWER_POOLS = new Set(["combatpower", "miningpower", "salvagepower"]);

/**
 * One POOLED stat's two halves, with the umbrella folded in. The one owner of that rule: `deriveContribution` and
 * `poolsWithModule` both compose pool multipliers and a fold applied at only one of them is the shape —
 * the panel and the score disagreeing about the same swap.
 */
function poolPart(it: Item, stat: string): { add: number; mul: number } {
  const p = part(it, stat);
  if (!POWER_POOLS.has(norm(stat))) return p;
  const umbrella = part(it, "Power");
  return { add: p.add + umbrella.add, mul: p.mul * umbrella.mul };
}

/** Which power pool this turret feeds. `catOf` owns the classification (the game's own `gameplayType`). */
export type PowerActivity = "Mining" | "Salvage";

// Does this turret feed the COMBAT power pool?
export function isCombat(it: Item): boolean {
  return catOf(it) === "Combat";
}

// Cached by item identity: the same gun is scored once per hardpoint per ascent step, and deriving this walks
// every stat line it carries — the cost `axisValues` already refuses to pay twice.
const CONTRIB = new WeakMap<Item, Contribution>();

export function contributionOf(it: Item): Contribution {
  const hit = CONTRIB.get(it);
  if (hit) return hit;
  const c = deriveContribution(it);
  CONTRIB.set(it, c);
  return c;
}

function deriveContribution(it: Item): Contribution {
  const typed = new Map<string, number>();
  for (const type of ["Kinetic", "Energy", "Radiation", "Heat", "Cold", "Corrosion", "Explosive"]) {
    // No pool for a typed bonus, so the multiplier folds — see `folded`.
    const v = folded(it, `${type} Damage`);
    if (v !== 0) typed.set(type, v);
  }
  const act = catOf(it);
  const precision = part(it, "Precision");
  const critDamage = part(it, "Critical Damage");
  const attackSpeed = part(it, "Attack Speed");
  const reloadSpeed = part(it, "Reload Speed");
  const magazineSize = part(it, "Magazine Size");
  // A power multiplier is a UNIT stat like any other, so it applies whichever pool it names — a mining laser
  // rolling `×Combat Power` still lifts the ship's guns. Only the MAIN power is local to the gun that carries it.
  // Through `poolPart`, so an umbrella `×Power` line reaches all three the way the game applies it.
  const combatMul = poolPart(it, "Combat Power").mul;
  const miningMul = poolPart(it, "Mining Power").mul;
  const salvageMul = poolPart(it, "Salvage Power").mul;
  return {
    // A turret's headline power IS its contribution to its own pool, which is why ranking by it worked — but a
    // gun only feeds ONE pool. Reading a mining gun's Mining Power as combat power let the optimiser score
    // ore-throughput as damage; reading it as nothing at all left a mining battery with no objective.
    combatPower: act === "Combat" ? mainVal(it) ?? 0 : 0,
    miningPower: act === "Mining" ? mainVal(it) ?? 0 : 0,
    salvagePower: act === "Salvage" ? mainVal(it) ?? 0 : 0,
    precision: precision.add,
    critDamage: critDamage.add,
    typedDamage: typed,
    allDamage: folded(it, "Damage"),
    attackSpeed: attackSpeed.add,
    reloadSpeed: reloadSpeed.add,
    magazineSize: magazineSize.add,
    mul: {
      combatPower: combatMul, miningPower: miningMul, salvagePower: salvageMul,
      precision: precision.mul, critDamage: critDamage.mul,
      attackSpeed: attackSpeed.mul, reloadSpeed: reloadSpeed.mul, magazineSize: magazineSize.mul,
    },
    local: {
      critDamage: localPart(it, "Critical Damage"),
      attackSpeed: localPart(it, "Attack Speed"),
      reloadSpeed: localPart(it, "Reload Speed"),
      magazineSize: localPart(it, "Magazine Size"),
    },
  };
}

/** Π of one pooled stat's multiplier across a set — the product `statMultipliers[st]` holds for those items. */
export function mulOf(set: Item[], pick: (m: StatMul) => number): number {
  return set.reduce((n, it) => n * pick(contributionOf(it).mul), 1);
}

// How many candidates per criterion survive `shortlist`.
export const SHORTLIST_PER_KEY = 12;

// The candidates worth putting through a set search, out of every gun of the right size.
//
// The ascent is linear in the candidate list and the layered search runs it once per layer assignment, so a
// hoard decides whether the tab answers in 50ms or freezes: an armory holding ~4,400 Small turrets is an
// ordinary long playthrough, not a pathological one.
//
// Ranking by main stat alone would be the wrong cut — it is exactly the case this whole module exists for, a
// smaller gun whose Precision lifts the WHOLE battery. So the shortlist is a UNION of the top few by each
// axis a gun can win on: its own power, every pooled substat, and the LOWEST energy draw (a zero-draw gun
// wins by holding a reactor bracket, which no stat of its own shows).
//
// A per-axis union alone is NOT exact, and the gap is worth naming: a gun 13th on two axes at once can beat
// one that leads a single axis and is poor elsewhere. `turretScore` is the axis that covers it — a composite
// of the item's own rate, crit, damage and aspect gains — so a well-rounded gun qualifies on balance even
// when it tops nothing. What is left out is then dominated on every axis AND on the composite, and nothing
// dominated can win a slot.
// Per-item axis values, cached by item identity: the same gun is a candidate for every hardpoint of its size,
// and deriving these means parsing its stat lines. Without the cache a 5-hardpoint ship pays for the whole
// armory five times, which costs more than the search it is meant to shrink.
const AXES = new WeakMap<Item, number[]>();
function axisValues(it: Item): number[] {
  const hit = AXES.get(it);
  if (hit) return hit;
  const c = contributionOf(it);
  const v = [
    mainVal(it) ?? 0,
    c.precision, c.critDamage, c.allDamage,
    [...c.typedDamage.values()].reduce((n, x) => n + x, 0),
    c.attackSpeed, c.reloadSpeed, c.magazineSize,
    aspectDamageFraction(it),
    turretScore(it).score,   // the balanced gun that tops no single axis
  ];
  AXES.set(it, v);
  return v;
}

export function shortlist(cands: Item[], perKey = SHORTLIST_PER_KEY): Item[] {
  if (cands.length <= perKey) return cands;
  // One pass, keeping the top `perKey` per axis in a small insertion-sorted list — 11 full sorts of a
  // thousands-long array is itself the cost being avoided.
  const nAxes = axisValues(cands[0]).length;
  const best: { it: Item; v: number }[][] = Array.from({ length: nAxes }, () => []);
  for (const it of cands) {
    const v = axisValues(it);
    for (let a = 0; a < nAxes; a++) {
      const row = best[a];
      if (row.length === perKey && v[a] <= row[row.length - 1].v) continue;
      let i = row.length;
      while (i > 0 && row[i - 1].v < v[a]) i--;
      row.splice(i, 0, { it, v: v[a] });
      if (row.length > perKey) row.pop();
    }
  }
  const keep = new Set<Item>();
  for (const row of best) for (const x of row) keep.add(x.it);

  // DRAW is not an axis, and neither is power-per-draw: draw tracks power, so "lowest draw" nominates the
  // weakest guns in the armory and a ratio nominates whichever weapon family is efficient by design. Neither
  // is the property that wins a slot. What wins one is drawing NOTHING — Solar Powered — because the bracket it
  // holds lifts every gun on the ship, and that is categorical rather than a continuum. So zero-draw guns are
  // admitted on their own terms, best power first, and nothing is spent on the near-misses.
  const free = cands.filter((it) => energyDraw([it]) === 0);
  if (free.length) {
    free.sort((a, b) => (mainVal(b) ?? 0) - (mainVal(a) ?? 0));
    for (const it of free.slice(0, perKey)) keep.add(it);
  }

  // LAYER is categorical for the same reason draw is, and leaving it out made the optimizer blind: under a
  // balanced target the score is `min(surface, core)`, so a gun for the layer a ship cannot currently reach is
  // worth more than any amount of extra power on the layer it already works — its value is that the minimum stops
  // being zero. None of the axes above can express that. They rank by power and pooled substats ∴ a core gun that
  // sits 13th by mining power never entered the search at all, and the tab could not propose core mining however
  // the target was set. Admitted per layer, best power first, and bounded exactly like `free`.
  for (const layer of ["Surface", "Core"] as const) {
    const forLayer = cands.filter((it) => catOf(it) !== "Combat" && coversLayer(it, layer));
    if (!forLayer.length) continue;
    forLayer.sort((a, b) => (mainVal(b) ?? 0) - (mainVal(a) ?? 0));
    for (const it of forLayer.slice(0, perKey)) keep.add(it);
  }
  return [...keep];
}

// `AbstractUnit.GetPrecisionCrit`, reproduced: linear in Precision up to 5%, then `^0.75` past it.
//   float num2 = 0.05f * (stat / divisor);
//   if (num2 > 0.05f) num2 = 0.05f + Mathf.Pow(num2 - 0.05f + 1f, 0.75f) - 1f;
export function precisionCrit(precision: number, divisor: number): number {
  if (!(divisor > 0)) return 0;
  const raw = 0.05 * (precision / divisor);
  if (raw <= 0.05) return raw;
  return 0.05 + Math.pow(raw - 0.05 + 1, 0.75) - 1;
}

export const BASE_CRIT_CHANCE = 0.03;   // AbstractUnit.BaseCritChance

// How far below zero a recovered additive may sit and still count as zero. The reported crit chance arrives
// rounded, so a hull with no additive sources at all resolves to a few parts in 1e8 either side. Real
// disagreement between the reading and the curve is percentage points, nowhere near this.
const CRIT_READ_EPSILON = 1e-6;

// Expected multiplier from the crit cascade: each further crit rolls at half the previous chance, capped by
// the mega-crit skill node, and each multiplies by `2 + CriticalDamage`.
export function expectedCrit(chance: number, critDamage: number, megaCrit: number): number {
  const c = Math.max(0, Math.min(1, chance));
  if (c <= 0) return 1;
  const mult = 2 + critDamage;
  const cap = Math.max(0, Math.floor(megaCrit)) + 1;
  let expected = 0;
  let reached = 1;
  for (let k = 0; k <= cap; k++) {
    const next = k === cap ? 0 : Math.min(1, c * Math.pow(0.5, k));
    expected += reached * (1 - next) * Math.pow(mult, k);
    reached *= next;
    if (reached <= 0) break;
  }
  return expected;
}

/**
 * A turret's firing-cycle gain: `DamageData.CalculateDamage` divides per-shot damage by
 * `defaultAttacksPerSecond`, which is built from the turret's RAW `_fireDelay`/`_maxMagSize`/`_reloadDelay`,
 * while the gun actually fires on the boosted delays. The boosted-over-raw ratio is therefore a straight DPS
 * multiplier on that gun.
 *
 * The three boosts are POOLED, and that is the whole point of taking them as arguments: `fireDelay` is
 * `_fireDelay / (1 + GetStat(AttackSpeed))` where `AbstractEquipment.GetStat` reads the UNIT's stat, so an
 * Attack Speed roll on any one gun shortens every gun's cycle. Reading the roll off the host item instead
 * credited it to a single hardpoint — a seventh of its worth on a seven-gun battery — which made a pooled
 * Attack Speed roll lose to a pooled Critical Damage roll that was already counted battery-wide.
 *
 * The ratio is still per gun even though the inputs are shared: `ceil(mag / burst)` and the flat reload term
 * make the cycle non-proportional, so the same pooled boost is worth different amounts on different guns.
 */
export function speedRatio(it: Item, attackSpeed = 0, reloadSpeed = 0, magazineSize = 0): number {
  if (it.fireDelayRaw == null || it.magSizeRaw == null) return 1;
  const burst = Math.max(1, it.burstAmount ?? 1);
  const bd = it.burstDelay ?? 0;
  // THE DIVISOR THE GAME CHARGES, and it is not the cadence the gun achieves. `CalculateDamage` divides a shot
  // by `defaultAttacksPerSecond`, which is built from the RAW serialized fields with the reload counted in full
  // and the burst-end delay ADDED to it.
  const nominal = (() => {
    const m = Math.max(1, it.magSizeRaw as number);
    const cycle = Math.ceil(m / burst) * ((burst - 1) * bd + (it.fireDelayRaw as number)) + (it.reloadDelayRaw ?? 0);
    return cycle > 0 ? m / cycle : 0;
  })();
  // THE CADENCE IT ACTUALLY FIRES AT. Two differences from the divisor, both measured in game by the arena
  // thread across all 71 prefabs (`fixtures/cadence-structural.json`): `ReloadCoroutine` waits `reloadDelay *
  // 0.8`, and the burst-end delay OVERLAPS the reload rather than following it — `AdvanceBurstCycle` sets the
  // fire delay while `RecordShotFired` starts the reload in the same `Fire()` call, so the idle between
  // magazines is `max(fireDelay, reload * 0.8)`.
  //
  // At zero stats this is 1.044× (SmallGatlingTurret) to 2.077× (LargeSalvageLaser) of the nominal figure,
  // median 1.379×. It is PER TURRET and spans two-fold ∴ it does not cancel between two guns, and pricing it at
  // 1.0 — which this did until the table arrived — reorders a battery by up to that spread.
  const real = (fd: number, rd: number, mag: number) => {
    const m = Math.max(1, mag);
    const bursts = Math.ceil(m / burst);
    const cycle = (m - bursts) * bd + (bursts - 1) * fd + Math.max(fd, rd * 0.8);
    return cycle > 0 ? m / cycle : 0;
  };
  const boosted = real(
    (it.fireDelayRaw as number) / (1 + attackSpeed),
    (it.reloadDelayRaw ?? 0) / (1 + reloadSpeed),
    Math.round((it.magSizeRaw as number) * (1 + magazineSize)),
  );
  // Damage per shot is `power / 5 / nominal`; shots land at `boosted` ∴ the gun's throughput is scaled by their
  // ratio. The STAT half cancels within it exactly as before; the STRUCTURAL half no longer vanishes.
  return nominal > 0 ? boosted / nominal : 1;
}

/** The fixed part of each pool: hull + crew + modules, i.e. everything this optimiser is not choosing. */
export function background(pools: ShipPools, equippedTurrets: Item[]): ShipPools {
  // The reported pool is a PRODUCT — `(base + Σ additive) * Π multiplier` — so the raw contributions below can
  // only be subtracted out of it once the factors are divided away. `residual` is every factor except the
  // reactor bracket (hull role bonus, skill nodes, non-turret gear), which stays constant while candidates are
  // swapped and is re-applied by `poolParts()`.
  // Per pool, because the combat factor carries a skill term the others do not.
  //
  // AT THE LOAD THE REPORTED FIGURE WAS TAKEN AT, and both halves of that ratio come from the same reading.
  // `capacityAll`/`usedAll` are the pair a projection pins; taking the capacity from the pin and the draw from the
  // PROJECTION divides a new numerator by an old denominator, which is a load the ship has never flown at — 11,898
  // over 23,412 = 50.8% on a build whose real load is 46.2% and whose reading was taken at 47.2%. Past the 50%
  // edge that costs the bracket AND the combat skill term, so the residual came out ×1.3/1.1 too large. It does
  // not cancel: `shared × mult` is `reported × next / now` and loses it, but each gun's OWN main power is
  // multiplied by `mult` directly — and own power dominates the shared remainder, so the whole battery read ~9%
  // stronger for having projected a bracket it never lost.
  const usage = pools.energy && (pools.energy.capacityAll ?? pools.energy.capacity) > 0
    ? loadAsRead(pools.energy) : null;
  const factorFor = (skillBonus: number) =>
    usage != null ? poolReactorFactor(usage, skillBonus) : 1 + (pools.energy?.mod ?? 0);
  const reactorFactor = factorFor(0);
  const combatFactor = factorFor(pools.combatReactorBonus ?? 0);
  const resid = (mult: number | undefined, factor = reactorFactor) =>
    mult != null && mult > 0 ? mult / factor : undefined;
  const residual = resid(pools.poolCombatPowerMult, combatFactor);
  const miningResid = resid(pools.poolMiningPowerMult);
  const salvageResid = resid(pools.poolSalvagePowerMult);
  // The equipped guns' own MULTIPLIER lines. They are part of every reported product and they LEAVE with the
  // guns, so each one is divided out here and the candidate set's own product is applied in its place — the same
  // treatment their additive lines get, one operation down. A set rolling none leaves every figure untouched.
  const eq = (pick: (m: StatMul) => number) => mulOf(equippedTurrets, pick);
  const cpMulEq = eq((m) => m.combatPower);
  const miningMulEq = eq((m) => m.miningPower);
  const salvageMulEq = eq((m) => m.salvagePower);
  const precMulEq = eq((m) => m.precision);
  // A residual is what stays behind once the turrets' own factor is out of the reported product.
  const held = (r: number | undefined, mulEq: number) => (r != null ? r / mulEq : undefined);
  const heldCombat = held(residual, cpMulEq);
  const heldMining = held(miningResid, miningMulEq);
  const heldSalvage = held(salvageResid, salvageMulEq);
  // Into additive space, out of it again after the subtraction — the same round trip the combat pool makes.
  const down = (v: number | undefined, r: number | undefined, mulEq: number) =>
    v == null ? undefined : r != null ? v / reactorFactor / r : v / mulEq;
  const up = (v: number | undefined, r: number | undefined) =>
    v == null ? undefined : r != null ? v * reactorFactor * r : v;

  let power = residual != null
    ? pools.poolCombatPower / combatFactor / residual
    : pools.poolCombatPower / cpMulEq;
  // Precision carries no reactor bracket (`reactorAffectedStats` is the three power pools plus Power), so its
  // whole product is the reported multiplier. Without one the guns' own lines are still all that can be resolved.
  const precMult = pools.poolPrecisionMult != null && pools.poolPrecisionMult > 0 ? pools.poolPrecisionMult : precMulEq;
  const precResidual = precMult / precMulEq;
  let precision = pools.poolPrecision / precMult;
  // No reported multiplier for these, so the guns' own lines are the only part of the product that can be
  // separated: divide theirs out, and `setDps` applies the candidate set's.
  let critDamage = pools.critDamage / eq((m) => m.critDamage);
  let attackSpeed = (pools.poolAttackSpeed ?? 0) / eq((m) => m.attackSpeed);
  let reloadSpeed = (pools.poolReloadSpeed ?? 0) / eq((m) => m.reloadSpeed);
  let magazineSize = (pools.poolMagazineSize ?? 0) / eq((m) => m.magazineSize);
  // Absent when the bridge sends no such pool: there is nothing to subtract from, and inventing a 0 baseline
  // would let a candidate set's own power stand in for the whole pool.
  let mining = down(pools.poolMiningPower, miningResid, miningMulEq);
  let salvage = down(pools.poolSalvagePower, salvageResid, salvageMulEq);
  for (const t of equippedTurrets) {
    const c = contributionOf(t);
    power -= c.combatPower;
    precision -= c.precision;
    critDamage -= c.critDamage;
    attackSpeed -= c.attackSpeed;
    reloadSpeed -= c.reloadSpeed;
    magazineSize -= c.magazineSize;
    if (mining != null) mining -= c.miningPower;
    if (salvage != null) salvage -= c.salvagePower;
  }
  // The turrets' own draw comes out with their stats, so a candidate set's draw can be added back in whole.
  const energy = pools.energy
    ? { ...pools.energy, used: Math.max(0, pools.energy.used - energyDraw(equippedTurrets)),
        usedAll: pools.energy.usedAll ?? pools.energy.used }
    : undefined;
  // Crit is anchored the same way the pools are: the game's reported chance is the truth, and Precision
  // explains only part of it — the skill tree, officers and crit aspects contribute an ADDITIVE amount that no
  // Precision curve can produce. Recover that amount and hold it constant, letting a candidate move only the
  // curve. Inverted from the game's own composition, so it needs the multiplier as well as the product:
  //   reported = (BASE + curve(P) + additive) * multiplier
  // Derived against the FULL precision (before the equipped turrets come out), which is the precision the
  // reported chance belongs to.
  const mult = pools.critChanceMult;
  const add = pools.critChance == null || mult == null || !(mult > 0)
    ? undefined
    : pools.critChance / mult - BASE_CRIT_CHANCE - precisionCrit(pools.poolPrecision, pools.precisionDivisor);
  return {
    ...pools, energy,
    // Two different negatives, and they must not be treated alike. Within reading precision — the reported
    // chance arrives rounded, so a ship with NO additive sources lands a hair either side of zero — it is
    // zero, and clamping is honest. Beyond that the reading and the curve genuinely disagree about this ship,
    // and it is REFUSED: falling back to base-plus-curve leaves the objective on a footing it already had,
    // while clamping a real deficit would assert "no additive crit sources" about a hull reporting otherwise.
    critAdd: add == null ? undefined : add >= -CRIT_READ_EPSILON ? Math.max(0, add) : undefined,
    // Back into reported space when a residual was applied, so every existing consumer still sees a pool of
    // the same shape; `poolParts()` divides it out again with the same factors. The factor put back is the HELD
    // one — the equipped guns' own multiplier lines went out with their additive lines and belong to whatever
    // set is scored next.
    poolCombatPower: Math.max(0, heldCombat != null ? power * combatFactor * heldCombat : power),
    combatMultResidual: heldCombat,
    // ADDITIVE space, unlike the power pools: `setDps` composes it back with `precisionResidual` and the
    // candidate set's own multiplier, which is the order the game builds the stat in.
    poolPrecision: Math.max(0, precision),
    precisionResidual: precResidual,
    critDamage: Math.max(0, critDamage),
    // Clamped at 0 like the rest: the hull, crew and skill tree contribute most of these, so a battery whose
    // rolls exceed the reading means the reading is stale, not that the ship fires backwards.
    poolAttackSpeed: Math.max(0, attackSpeed),
    poolReloadSpeed: Math.max(0, reloadSpeed),
    poolMagazineSize: Math.max(0, magazineSize),
    poolMiningPower: mining == null ? undefined : Math.max(0, up(mining, heldMining) as number),
    poolSalvagePower: salvage == null ? undefined : Math.max(0, up(salvage, heldSalvage) as number),
    miningMultResidual: heldMining,
    salvageMultResidual: heldSalvage,
  };
}

/** Total DPS of a candidate set against a fixed background. Relative, but comparable ACROSS sets. */
// How much of the power pool one hardpoint draws — `AbstractTurret.turretEquivalentRating`, which depends on
// SIZE alone. Within a single slot it cancels (same size either way), so it only matters for a whole-battery
// figure and for comparing across sizes, where getting it wrong makes a Medium look as valuable as a Large.
// The count the game reports is the SUM of these ratings, which is what pins them:
//   3 Large + 3 Medium               → 15    ∴ Large 3, Medium 2
//   1 Large + 2 Small (mining)       → 5.85  ∴ Small 1.425, given Large 3
// Small is NOT 1: reading it as 1 understates a Small gun's share of the pool by 30% on any battery that mixes
// sizes.
export function rating(it: Item): number {
  switch (it.size) {
    case "Tiny": return 0.45;
    case "Small": return 1.425;
    case "Medium": return 2;
    case "Large": return 3;
    default: return 1;
  }
}

// Combat, Mining and Salvage Power are all `reactorAffectedStats` entries, so all three come through here.
/**
 * A power pool split into the two things `AbstractTurret.CalculateAttackPower` actually uses:
 *
 *     float statMultiplier = parent.GetStatMultiplier(powerStat);
 *     float num  = displayedPower * statMultiplier;                                  // this turret's OWN main
 *     float num2 = max(0, parent.GetStat(powerStat) - parent.GetMainPowerSum(powerStat) * statMultiplier);
 *     float num3 = max(0.45, parent.GetEquivalentTurretsCount(powerStat));
 *     return (num + num2 / num3 * turretEquivalentRating) * GetPowerMultiplier();
 *
 * `shared` is that `num2` in ADDITIVE space: the reported pool minus every turret's main power, i.e. substats,
 * hull, crew, modules and skills — the only part divided by the equivalent-turret count.
 *
 * `mult` is the multiplier to re-apply, evaluated at the load the CANDIDATE SET would draw, since `GetStatRaw` is
 * `(base + Σ additive) * Π multiplier` with the reactor bracket one factor of it. A set is therefore bracketed as
 * a whole: two swaps each affordable alone can still cross a threshold together, and a zero-draw gun can win by
 * keeping the ship in a better bracket. Adding a contribution onto a still-multiplied total would credit it at
 * 1/residual of its worth.
 *
 * `residual` is every other factor — hull role bonus, skill tree, non-turret gear — near 2.7 on a Combat hull.
 * 1 when the bridge reports no multiplier, which leaves the arithmetic as it was rather than half-fixed.
 *
 * `setMul` is the CANDIDATE set's own `×power` lines, which `background()` took out with the equipped guns'.
 * A gun rolling one scales the pool it names for the whole ship — its own main power included, since the game
 * reads that as `displayedPower * GetStatMultiplier(powerStat)`.
 */
function poolParts(reported: number, set: Item[], energy: ShipPools["energy"],
                   residual = 1, skillBonus = 0, setMul = 1): { shared: number; mult: number } {
  // De-bracket with the factor the game APPLIED when it reported this figure, which is the factor at the ship's
  // TOTAL draw — `background()` has since taken the equipped turrets' draw out of `used`, so dividing by a factor
  // recomputed from `used` would use a load the reading was never taken at. Both sides come from
  // `poolReactorFactor`, so the pair cannot disagree about the combat skill term.
  const has = !!energy && energy.capacity > 0;
  // `now` is the load the figure was REPORTED at — that draw over that capacity — and `next` the one the
  // candidate set would fly at. A reactor swap moves the capacity, so the two denominators differ.
  const now = has ? poolReactorFactor(loadAsRead(energy!), skillBonus) : 1 + (energy?.mod ?? 0);
  const next = has ? poolReactorFactor(loadWith(energy!, energyDraw(set)), skillBonus) : 1 + (energy?.mod ?? 0);
  return { shared: reported / now / residual, mult: residual * next * setMul };
}

// The RELEASE cuts a battery's per-gun share again once it grows, on top of dividing the pool: thresholds on the
// equivalent-turret count, checked high to low, straight out of `AbstractTurret.CalculateAttackPower`. Beta
// 0.8.1.19 deleted this formula ("we removed the existing formula that reduced damage output of extra turrets
// beyond the first") and raised enemy HP to compensate ∴ it is per build, never a constant.
const EXTRA_TURRET_PENALTY: ReadonlyArray<readonly [above: number, factor: number]> = [
  [5.9, 0.65], [4.9, 0.68], [3.9, 0.72], [2.9, 0.78], [1.9, 0.85],
];

/**
 * ONE gun's share of a power pool — the only place a pool is divided by the equivalent-turret count.
 *
 * Combat, mining and salvage all go through here because the game's own formula is per `powerStat` and applies
 * the same two steps to each: floor the divisor at 0.45, then scale by the release's ladder. Three call sites
 * dividing by hand is how one of them ends up without the ladder.
 *
 * The floor matters at the bottom of the range: a lone Tiny gun rates 0.45, and `pool / 0.45` is more than the
 * pool — the game floors the DIVISOR, so a single small gun cannot out-damage the whole pool.
 */
export function poolShare(pool: number, nEq: number, bg: ShipPools): number {
  const eq = Math.max(0.45, nEq);
  if (!bg.extraTurretPenalty) return pool / eq;
  for (const [above, factor] of EXTRA_TURRET_PENALTY) if (eq > above) return (pool / eq) * factor;
  return pool / eq;
}

export function setDps(set: Item[], bg: ShipPools): number {
  if (set.length === 0) return 0;
  const contribs = set.map(contributionOf);

  const { shared, mult } = poolParts(bg.poolCombatPower, set, bg.energy,
                                     bg.combatMultResidual ?? 1, bg.combatReactorBonus ?? 0,
                                     mulOf(set, (m) => m.combatPower));
  // Each pooled stat is rebuilt the way the game builds it — `(base + Σ amount) * Π multiplier` — with the
  // background holding the part no candidate can move. The two halves are never summed: a `×1.05` line lifts the
  // whole pool, hull and crew included, which is worth orders of magnitude more than the 0.05 it reads as flat.
  const pooled = (base: number, add: (c: Contribution) => number, pick: (m: StatMul) => number) =>
    (base + contribs.reduce((n, c) => n + add(c), 0)) * mulOf(set, pick);
  const precision = pooled(bg.poolPrecision, (c) => c.precision, (m) => m.precision) * (bg.precisionResidual ?? 1);
  const critDamage = pooled(bg.critDamage, (c) => c.critDamage, (m) => m.critDamage);
  const allDamage = contribs.reduce((n, c) => n + c.allDamage, 0);
  // Pooled, so the whole SET's rolls decide every gun's cycle — not each gun's own.
  const attackSpeed = pooled(bg.poolAttackSpeed ?? 0, (c) => c.attackSpeed, (m) => m.attackSpeed);
  const reloadSpeed = pooled(bg.poolReloadSpeed ?? 0, (c) => c.reloadSpeed, (m) => m.reloadSpeed);
  const magazineSize = pooled(bg.poolMagazineSize ?? 0, (c) => c.magazineSize, (m) => m.magazineSize);

  // Rebuilt the way the game builds it, anchored on its own reading where there is one (see `background`): the
  // additive sources and the multiplier are held constant and the candidate moves only the Precision curve.
  // Without an anchor this reduces to `BASE + curve`, which is what a bridge reporting no crit chance leaves.
  const critChance = (BASE_CRIT_CHANCE + precisionCrit(precision, bg.precisionDivisor) + (bg.critAdd ?? 0))
    * (bg.critAdd == null ? 1 : bg.critChanceMult ?? 1);

  // Only the SHARED part is divided by the equivalent-turret count, and each gun draws its own size's rating out
  // of it: `AbstractTurret.turretEquivalentRating` is Tiny 0.45 / Small 1.425 / Medium 2 / Large 3, and the count
  // the game reports is the sum of those ratings (3 Large + 3 Medium = 15). So a Large hardpoint takes 3/15 of the
  // shared remainder and a Medium 2/15.
  //
  // A gun's own MAIN power is not in that remainder — it belongs to the gun that carries it (`displayedPower *
  // statMultiplier`), which is what `CalculateAttackPower` subtracts via `GetMainPowerSum` before dividing. Average
  // it over the battery instead and a headline loss is spread across every hardpoint, so a lower-powered gun with
  // one good substat comes out ahead of the gun it replaces. Game 0.8.0.15 averages it; this follows 0.8.1.23.
  const nEq = bg.equivalentTurrets > 0 ? bg.equivalentTurrets : set.reduce((n, it) => n + rating(it), 0);

  let total = 0;
  for (const [i, it] of set.entries()) {
    // A mining or salvage turret occupies the hardpoint and draws energy, but deals no combat damage — it
    // must not contribute to a DPS figure just because it is mounted.
    if (!isCombat(it)) continue;
    // Typed bonuses are pooled too, so a Cold roll on one gun helps every Cold gun — summed across the set
    // and then read per turret by ITS type.
    const typed = it.damageType
      ? contribs.reduce((n, c) => n + (c.typedDamage.get(it.damageType as string) ?? 0), 0)
      : 0;
    // `CalculateAttackPower`, per turret: its own main power plus its rating's slice of the shared remainder,
    // the whole thing multiplied, then the damage calc's `/ 5`.
    const own = contribs[i].combatPower;
    // THE GUN'S OWN CRIT AND CYCLE, not the battery's. `AbstractEquipment.GetStat` is `parent.GetStat(s)` PLUS
    // this equipment's own boost lines, and `CalculateDamage` reads `sourceTurret.GetStat(CriticalDamage)` ∴ an
    // aspect's `TurretBoostStat` multiplies THIS gun's crits and no other's. Summed into the pool it would be
    // worth the whole battery, which is how giving one up could read as free.
    const loc = contribs[i].local;
    const crit = expectedCrit(critChance, critDamage + loc.critDamage, bg.megaCrit);
    total += ((own + poolShare(shared, nEq, bg) * rating(it)) * mult / 5)
      * speedRatio(it, attackSpeed + loc.attackSpeed, reloadSpeed + loc.reloadSpeed, magazineSize + loc.magazineSize)
      * crit
      * (1 + typed + allDamage)
      * (1 + aspectDamageFraction(it));
  }
  return total;
}

/**
 * A non-combat battery's throughput: the activity's pool, re-bracketed on the SET's draw and shared out by each
 * gun's size rating — the same shape as `setDps` with the combat-only model removed.
 *
 * No fire rate, no crit, no typed damage: those are per-SHOT quantities and a mining laser's yield is its share
 * of the Mining Power pool, not a shot. Returns 0 when the bridge sends no such pool — a battery with no
 * objective must compare as a tie rather than against a number that isn't there.
 */
/** One activity's `×power` product across a set. ONE owner, so the two scorers cannot disagree. */
function powerMulOf(set: Item[], act: PowerActivity): number {
  return mulOf(set, (m) => (act === "Mining" ? m.miningPower : m.salvagePower));
}

/** The non-reactor multiplier on one activity's pool. ONE owner, so the two scorers cannot disagree. */
function residualFor(bg: ShipPools, act: PowerActivity): number {
  return (act === "Mining" ? bg.miningMultResidual : bg.salvageMultResidual) ?? 1;
}

export function setPower(set: Item[], bg: ShipPools, act: PowerActivity): number {
  const reported = act === "Mining" ? bg.poolMiningPower : bg.poolSalvagePower;
  if (reported == null || set.length === 0) return 0;
  const own = (c: Contribution) => (act === "Mining" ? c.miningPower : c.salvagePower);
  // `CalculateAttackPower` is written per `powerStat`, so mining and salvage split exactly as combat does: the
  // gun's own main power stays with the gun, and only the remainder is divided by the equivalent-turret count.
  const { shared, mult } = poolParts(reported, set, bg.energy, residualFor(bg, act), 0, powerMulOf(set, act));

  // The divisor is per STAT: `GetEquivalentTurretsCount(MiningPower)` counts only the guns feeding that pool, so
  // a mixed battery does not dilute the mining share with its cannons.
  const count = act === "Mining" ? bg.equivalentTurretsMining : bg.equivalentTurretsSalvage;
  const nEq = count && count > 0 ? count : set.reduce((n, it) => (catOf(it) === act ? n + rating(it) : n), 0);
  if (!(nEq > 0)) return 0;

  let total = 0;
  for (const it of set)
    if (catOf(it) === act) total += (own(contributionOf(it)) + poolShare(shared, nEq, bg) * rating(it)) * mult;
  return total;
}

/** The layer a target sits on. `TargetLayer` in the game is `Surface | Core | Both`. */
export type Layer = "Surface" | "Core";

/** Which layers the player wants a hardpoint, or a whole ship, to cover. */
export type LayerTarget = "balanced" | "surface" | "core";

/**
 * Can this gun reach `layer`? ONE owner for the `Both` rule: a `Both` turret works either layer, so matching
 * `targetLayer === layer` exactly excludes it from BOTH — which under-reports every per-layer figure on a ship
 * carrying one. Consequence worth knowing: with a `Both` gun fitted the per-layer figures no longer sum to the
 * battery total, because that gun's share is genuinely available to either layer rather than split between them.
 */
export function coversLayer(it: Item, layer: string): boolean {
  const l = it.targetLayer ?? "";
  return l === layer || l === "Both";
}

/** Does every gun of this activity declare a reach? Without that the layer attribution is unknowable. */
function layersKnown(mine: Item[]): boolean {
  return mine.every((it) => {
    const l = it.targetLayer ?? "";
    return l === "Surface" || l === "Core" || l === "Both";
  });
}

/**
 * An activity's throughput against ONE target layer.
 *
 * A mining or salvage gun can only hit the layer it is built for (`targetLayer`: Surface | Core), so a battery of
 * Surface lasers has NO core mining power however large its pool share — the guns cannot reach the rock. Shares
 * the pool exactly as `setPower` does, then keeps only the guns that can hit `layer`, so the per-layer figures sum
 * to the battery's total.
 *
 * null when the bridge sent no pool for the activity, or the set has no gun of it — a missing figure, ⊥ a zero.
 */
export function setPowerByLayer(set: Item[], bg: ShipPools, act: PowerActivity, layer: string): number | null {
  const reported = act === "Mining" ? bg.poolMiningPower : bg.poolSalvagePower;
  if (reported == null) return null;
  const mine = set.filter((it) => catOf(it) === act);
  if (!mine.length) return null;
  const own = mine.filter((it) => coversLayer(it, layer));
  if (!own.length) return null;
  const { shared, mult } = poolParts(reported, set, bg.energy, residualFor(bg, act), 0, powerMulOf(set, act));
  const count = act === "Mining" ? bg.equivalentTurretsMining : bg.equivalentTurretsSalvage;
  const nEq = count && count > 0 ? count : mine.reduce((n, it) => n + rating(it), 0);
  if (!(nEq > 0)) return null;
  const mainOf = (it: Item) => (act === "Mining" ? contributionOf(it).miningPower : contributionOf(it).salvagePower);
  return own.reduce((n, it) => n + (mainOf(it) + poolShare(shared, nEq, bg) * rating(it)) * mult, 0);
}

/** Which non-combat pool a set is judged against. Mining wins a mixed non-combat battery — one number has to be
 *  chosen, and mixing the two pools would add unlike units. */
export function activityOf(set: Item[]): PowerActivity | undefined {
  if (set.some((it) => catOf(it) === "Mining")) return "Mining";
  if (set.some((it) => catOf(it) === "Salvage")) return "Salvage";
  return undefined;
}

/**
 * Does this set reach every layer the target asks for? The HARD-REJECT predicate: under `balanced` a battery that
 * cannot touch one layer cannot finish a wreck, so it is not a candidate at all rather than a candidate ranked
 * last. Returns true when the reach is unknowable (some gun sends no `targetLayer`) — an older bridge must not
 * have every non-combat fit rejected out from under it.
 */
export function coversLayers(set: Item[], act: PowerActivity, target: LayerTarget): boolean {
  const mine = set.filter((it) => catOf(it) === act);
  if (!mine.length) return false;
  if (!layersKnown(mine)) return true;
  const has = (l: Layer) => mine.some((it) => coversLayer(it, l));
  if (target === "surface") return has("Surface");
  if (target === "core") return has("Core");
  return has("Surface") && has("Core");
}

/**
 * A non-combat set's worth, LAYER-AWARE: the throughput of the SLOWER layer.
 *
 * A gun reaches one layer, and the guns fire at the same time — the laser works the surface while the grinder
 * works the core. So the two jobs run in PARALLEL and the wreck is not stripped until the slower one finishes:
 *
 *     t_strip = max(work_s / power_s, work_c / power_c) = work / min(power_s, power_c)      (equal work)
 *
 * ∴ the figure is `min(s, c)` — the BOTTLENECK, and NOT a harmonic mean: a harmonic treats the times as additive,
 * as if the layers were worked in sequence, over-rewards the strong side (100 and 1 harmonise to 1.98 where the
 * rate you get is 1), and needs a work-split weight that `min` does without. An uncovered layer falls out for
 * free: `min(s, 0) = 0`.
 *
 * Falls back to the summed `setPower` when any gun of the activity declares no reach — a 0 for a layer would be
 * a fabricated fact, and the rule about absent data applies here exactly as it does to a missing pool.
 *
 * STRICT, and deliberately ignorant of whether balance is achievable: exempting a set of fewer than two guns
 * (scoring `max(s, c)` so a one-hardpoint hull is not called worthless) makes the objective NON-MONOTONE IN SET
 * SIZE — one Core gun scores well, two score 0 — and a coordinate ascent reads that as "a second gun of this layer
 * is catastrophic", proposing one weak off-layer gun and leaving every other slot alone. Achievability depends on
 * the hull and the stock, neither visible here, so the CALLER degrades `target` (see GearTab's layerPlan).
 */
export function setPowerTargeted(set: Item[], bg: ShipPools, act: PowerActivity, target: LayerTarget): number {
  const mine = set.filter((it) => catOf(it) === act);
  if (!mine.length) return 0;
  if (!layersKnown(mine)) return setPower(set, bg, act);
  const s = setPowerByLayer(set, bg, act, "Surface") ?? 0;
  const c = setPowerByLayer(set, bg, act, "Core") ?? 0;
  if (target === "surface") return s;
  if (target === "core") return c;
  return Math.min(s, c);
}

// Every pooled stat a MODULE can move, as the reported field, its reported multiplier, and the stat's own
// display name. One table: a stat listed here but not there is a stat a module swap silently keeps constant.
const MODULE_POOLS: ReadonlyArray<readonly [pool: keyof ShipPools, mult: keyof ShipPools | null, stat: string]> = [
  ["poolCombatPower", "poolCombatPowerMult", "Combat Power"],
  ["poolMiningPower", "poolMiningPowerMult", "Mining Power"],
  ["poolSalvagePower", "poolSalvagePowerMult", "Salvage Power"],
  ["poolPrecision", "poolPrecisionMult", "Precision"],
  ["critChance", "critChanceMult", "Critical Chance"],
  ["critDamage", null, "Critical Damage"],
  ["poolAttackSpeed", null, "Attack Speed"],
  ["poolReloadSpeed", null, "Reload Speed"],
  ["poolMagazineSize", null, "Magazine Size"],
];

/**
 * Does the objective PRICE this stat on a module, or merely notice it?
 *
 * `MODULE_POOLS` is the whole list a module swap can move, so a stat outside it — Torpedo Power, Kinetic
 * Resistance, Hull HP — changes the score by exactly nothing. That is ⊥ a claim it is worthless: it is a
 * statement that the objective has NO OPINION, and the difference matters on a card where a player is weighing
 * "+3,892 Torpedo Power" against "−1,220 Precision" and cannot otherwise know which of the two the app acted on
 *. Derived from the table itself ∴ adding a pool teaches every surface at once.
 */
export type StatChannel = "pool" | "bracket" | null;

/**
 * Stats priced through the REACTOR BRACKET rather than as a pool of their own.
 *
 * A module's `Energy` is the reactor's CAPACITY: the objective moves it (`capacityWith`) and reads it back as
 * load → bracket → a multiplier on EVERY pool. It is therefore priced, and priced heavily — but it is not a pool,
 * so `MODULE_POOLS` cannot list it without `poolsWithModule` trying to move it as if it were.
 *
 * Leaving it out of the pricing answer entirely is what made the card mark `Energy` "not scored — your call" on a
 * reactor swap that doubled capacity from 10.8K to 21.2K. The player read that as the app ignoring the
 * energy budget, which is exactly what it said.
 *
 * `Power use` is here and `Power` is NOT, which is the opposite of how they read: DRAW is `powerUsage`, moves the
 * load and is bracket-priced, while a `×Power` line is the umbrella over the three power pools and scales them
 * DIRECTLY (`poolPart`). Marking draw "not scored" was defect on the other stat.
 */
const BRACKET_STATS = ["Energy", "Power use"] as const;

/**
 * WHICH channel prices a stat, or `null` where the objective genuinely has no opinion.
 *
 * `compareStats` names the two halves of one stat line DIFFERENTLY — `Precision` for the additive delta and
 * `× Precision` for the multiplier — and for the umbrella those halves are ⊥ priced alike: the multiplier is
 * modelled and a flat amount is not ∴ they must not share one verdict. Everywhere else the two halves are
 * priced together and the prefix changes nothing.
 */
export const moduleStatChannel = (stat: string): StatChannel => {
  const want = norm(stat);
  if (MODULE_POOLS.some(([, , s]) => norm(s) === want)) return "pool";
  // The umbrella feeds all three power pools, additive and multiplier alike (`poolPart`).
  if (want === "power") return "pool";
  if (BRACKET_STATS.some((s) => norm(s) === want)) return "bracket";
  return null;
};


export const pricesModuleStat = (stat: string): boolean => moduleStatChannel(stat) !== null;


/**
 * The reported pools as they would read with one MODULE swapped for another.
 *
 * A module's stat lines reach the UNIT exactly as a turret's do — a scanner's Precision, an armour
 * plate's Combat Power, a "+5% critical chance" aspect — so a module swap is a change to the BACKGROUND every
 * gun is scored against, and the objective can price it. Feed the result to `background()`: the battery is
 * unchanged, and what moves is the pool it draws on.
 *
 * Composed the way the game builds a stat, `(base + Σ amount) * Π multiplier`: the additive half enters
 * additive space and the multiplier half multiplies the reported product AND the reported multiplier, so
 * `background()` divides by the same factor the new figure was built with.
 *
 * ENERGY moves too, and it is not a detail: a module that draws 1,145 more can cost a reactor bracket, which
 * multiplies every power pool — the swap that looked like a Precision gain is then a loss on every gun.
 */
export function poolsWithModule(pools: ShipPools, out: Item | null, inn: Item | null): ShipPools {
  if (!out && !inn) return pools;
  const next: ShipPools = { ...pools };
  for (const [pool, multKey, stat] of MODULE_POOLS) {
    const reported = pools[pool] as number | undefined;
    if (reported == null) continue;                       // no reading ⇒ nothing to move
    const a = inn ? poolPart(inn, stat) : { add: 0, mul: 1 };
    const b = out ? poolPart(out, stat) : { add: 0, mul: 1 };
    const add = a.add - b.add;
    const mul = b.mul !== 0 ? a.mul / b.mul : 1;
    if (add === 0 && mul === 1) continue;
    const m = (multKey ? (pools[multKey] as number | undefined) : undefined) ?? 1;
    const write = next as unknown as Record<string, number>;
    write[pool] = Math.max(0, (reported + add * m) * mul);
    if (multKey && pools[multKey] != null) write[multKey] = m * mul;
  }
  // THE REPORTED CRIT CHANCE MOVES WITH PRECISION, or the change cancels itself.
  //
  // `background` recovers the ship's additive crit sources (skill tree, officers, crit aspects) by subtracting
  // the precision curve from the REPORTED chance — an anchor it derives from whatever pools it is handed. Hand it
  // a precision we just rewrote while the reported chance still describes the OLD precision, and the anchor grows
  // by exactly the crit the precision change removed: a module's Precision roll is then worth precisely nothing,
  // the objective reports a 0 gain, and the decision falls through to tie-breaks that hand the slot to whichever
  // module draws less ( — a hangar bay offered over one carrying +1,220 Precision, +1,335 Hull HP and two
  // aspects, on 26 units of draw).
  //
  // So the projection moves the reading too: the anchor is a fact about the SHIP, ⊥ about the module in the slot,
  // and it must come out the same before and after. A module's own `Critical Chance` line is separate and has
  // already been applied by the loop above — this is only the part precision drives.
  if (next.poolPrecision !== pools.poolPrecision && pools.critChance != null) {
    const mult = pools.critChanceMult ?? 1;
    const was = precisionCrit(pools.poolPrecision, pools.precisionDivisor);
    const now = precisionCrit(next.poolPrecision, next.precisionDivisor);
    next.critChance = Math.max(0, (next.critChance ?? pools.critChance) + (now - was) * mult);
  }
  // Both halves of the reactor budget move, and the second one is the whole point of a REACTOR: a module's
  // draw changes what is USED, its Energy stat changes what there is to use. Missing the capacity half made a
  // reactor swap look like its substats alone — +2,288 Combat Power for 11,091 less capacity, which took the
  // load from 40% to 61% and the reactor bonus from +20% to +10% on every pool at once.
  const draw = energyDraw(inn ? [inn] : []) - energyDraw(out ? [out] : []);
  const capacity = pools.energy
    ? capacityWith(pools.energy.capacity, out ? [out] : [], inn ? [inn] : [])
    : 0;
  if (pools.energy && (draw !== 0 || capacity !== pools.energy.capacity)) {
    next.energy = {
      ...pools.energy,
      used: Math.max(0, pools.energy.used + draw),
      capacity,
      // The load the reported figures were TAKEN at, and it is ONE ratio: both halves are pinned here, together,
      // or `poolParts` divides a projected numerator by a reported denominator. A projection that raises the
      // capacity is exactly where they part company — the new reactor's draw over the old reactor's capacity is a
      // load the ship has never flown at, and where it lands past a bracket edge the de-bracket invents a loss on
      // the BASELINE which the re-bracket then hands back as a gain. That fiction is worth the whole step (+9% at
      // the 50% edge), it appears only in the direction that gains capacity, and two builds where one direction is
      // honest and the other is not are a pair the objective will swap forever.
      usedAll: pools.energy.usedAll ?? pools.energy.used,
      capacityAll: pools.energy.capacityAll ?? pools.energy.capacity,
    };
  }
  return next;
}

/**
 * The reported pools with a WHOLE module set swapped at once — the plural of `poolsWithModule`, and what lets a
 * module PLAN be priced rather than a single slot.
 *
 * Two swaps are not two independent readings. Every pooled stat composes, and the reactor budget composes twice
 * over: each module's draw adds to what is USED while its `Energy` line changes what there IS to use. So two
 * modules that each keep the ship inside a bracket can cross it TOGETHER and dock every power pool at once.
 * Folding one swap at a time is exactly right for that — each step rewrites the reported product the next reads —
 * and it is what turns the bracket into an ordinary term of the objective instead of a constraint bolted beside it.
 *
 * Positional: `out[i]` is what leaves the slot `inn[i]` enters. A null on either side is a slot being filled or emptied.
 */
export function poolsWithModules(pools: ShipPools, out: (Item | null)[], inn: (Item | null)[]): ShipPools {
  let next = pools;
  for (let i = 0; i < Math.max(out.length, inn.length); i++) {
    const o = out[i] ?? null, n = inn[i] ?? null;
    if (o !== n) next = poolsWithModule(next, o, n);
  }
  return next;
}

// The reactor budget under both spellings the game uses for it: a headline says "Energy", an aspect says
// "EnergyCapacity", and an item carrying one of each contributes both. ASPECTS count — a reactor aspect
// granting "+10% reactor energy" moves the budget exactly as the reactor's own line does, and `statTotals`
// already folds an item's aspect lines in with its own.
function capacityPart(it: Item | null): { add: number; mul: number } {
  if (!it) return { add: 0, mul: 1 };
  const a = statPart(it, "Energy");
  const b = statPart(it, "Energy Capacity");
  return { add: a.add + b.add, mul: a.mul * b.mul };
}

/**
 * The reactor budget with one set of gear swapped for another — ONE owner, because the objective and the
 * totals panel projecting it differently is the two-answers-to-one-question shape this app keeps paying for.
 *
 * Composed like any other stat, `(base + Σ amount) * Π multiplier`: the outgoing product is divided out before
 * the additive move and the incoming one applied after, so a `×1.10 energy` aspect is worth 10% of the budget
 * rather than 10% of nothing.
 */
export function capacityWith(capacity: number, out: Item[], inn: Item[]): number {
  const sum = (set: Item[]) => set.reduce(
    (acc, it) => { const p = capacityPart(it); return { add: acc.add + p.add, mul: acc.mul * p.mul }; },
    { add: 0, mul: 1 });
  const a = sum(out), b = sum(inn);
  if (a.add === b.add && a.mul === b.mul) return capacity;
  const base = a.mul !== 0 ? capacity / a.mul : capacity;
  return Math.max(1, (base - a.add + b.add) * b.mul);
}

/** The battery's worth with one module swapped — the SAME objective a turret is judged by. */
export function moduleRank(pools: ShipPools, turrets: Item[], out: Item | null, inn: Item | null,
                           target: LayerTarget = "balanced", act?: PowerActivity): Rank {
  const bg = background(poolsWithModule(pools, out, inn), turrets);
  return setRank(turrets, bg, layerTargetFor(turrets, target, act), act);
}

/**
 * The target a FIXED battery can actually be judged against.
 *
 * A module cannot change which ore layers a ship reaches — only guns can. So asking `balanced` of a battery that
 * reaches one layer scores it `min(s, 0) = 0` no matter which module is fitted, and every module then ties at zero:
 * a swap losing 1,485 Mining Power reads as "same battery score", the tie-break chain takes over, and the winner is
 * whichever module keeps a better reactor bracket — a module measurably worse for the ship's job, offered because
 * the objective had gone silent.
 *
 * ∴ when the set cannot cover the target, judge it on the layers it DOES cover. That is not a softer objective, it
 * is the only one with a subject: this ship, as it is armed. `optimizeGearSet` must NOT use this for GUNS — there
 * the coverage is exactly what the search is choosing, and collapsing the target per candidate would make the
 * objective non-monotone in set size (the trap `setPowerTargeted` documents).
 */
export function layerTargetFor(set: Item[], target: LayerTarget, act?: PowerActivity): LayerTarget {
  if (target !== "balanced") return target;
  const a = act ?? activityOf(set);
  if (!a) return target;
  const mine = set.filter((it) => catOf(it) === a);
  if (!mine.length || !layersKnown(mine)) return target;
  const s = mine.some((it) => coversLayer(it, "Surface"));
  const c = mine.some((it) => coversLayer(it, "Core"));
  if (s && c) return "balanced";
  return s ? "surface" : c ? "core" : target;
}

/** What a module swap is worth as a FRACTION of the current build, 0 when there is nothing to compare against. */
export function moduleGain(cand: Item, eq: Item | null, ctx: ModuleCtx): number {
  if (!ctx.pools || !ctx.turrets?.length) return 0;
  const now = moduleRank(ctx.pools, ctx.turrets, eq, eq, ctx.target, ctx.act);
  const next = moduleRank(ctx.pools, ctx.turrets, eq, cand, ctx.target, ctx.act);
  return now[1] > 0 ? rankSub(next, now) / now[1] : 0;
}

/** What deciding a module needs. Pools ABSENT ⇒ the heuristic alone, which is simple mode's whole model. */
export interface ModuleCtx {
  pools?: ShipPools | null;
  turrets?: Item[];
  energy?: { usedWithout: number; capacity: number };
  role?: string | null;
  /** What the ship can use — see `statApplies`. Absent ⇒ role alone, which is what a caller without a layout has. */
  fit?: ShipFit | null;
  target?: LayerTarget;
  act?: PowerActivity;
}

/**
 * What an EMPTY aspect slot is worth, in the objective's own unit.
 *
 * A slot is not a unit of value — what it can HOLD is. The two outcomes worth pricing are the ones a player
 * reaches for: an aspect that removes the item's ENERGY DRAW (Solar Powered), which on a ship near a bracket
 * edge is worth more than any stat roll, and on a weapon one that adds DAMAGE. Both are priced by asking the
 * objective what the item would score WITH that effect, so a spare slot on a 2,173-draw engine and a spare slot
 * on a zero-draw one are correctly worth different amounts — the second one has nothing left to win.
 *
 * A JUDGEMENT, and stated as one: it assumes the best plausible aspect, ignores what finding and fitting it
 * costs, and prices ONE slot however many are empty (a second aspect competes with the first for the same
 * ship). That is why it is only ever consulted where the objective is otherwise SILENT — a potential gain must
 * never outweigh a measured one.
 */
export const ASPECT_DAMAGE_POTENTIAL = 0.15;   // the common "+15% damage" roll, as a fraction

export function slotPotential(it: Item, ctx: ModuleCtx): number {
  const empty = Math.max(0, (it.aspectSlots ?? 0) - (it.aspects ?? []).length);
  if (!empty || !ctx.pools || !ctx.turrets?.length) return 0;
  // Zero-draw: what this item would be worth to the battery if it stopped costing energy.
  const draw = it.powerUsage ?? it.powerUsageBase ?? 0;
  if (draw <= 0) return 0;
  const free = { ...it, powerUsage: 0, powerUsageBase: 0 } as Item;
  return Math.max(0, moduleGain(free, it, ctx));
}

/**
 * Is this module better than the one fitted?
 *
 * ONE owner, because the rails, the per-slot suggest and the plan all ask it and an item offered by one and
 * declined by another is the disagreement this module exists to prevent.
 *
 * The OBJECTIVE decides wherever it has an opinion. A module pools its stats, so a scanner's Precision, an
 * armour plate's Combat Power, a crit aspect and the energy draw are all things `setDps` already prices — and
 * ranking a module on its headline instead offered a Lv79 scanner with 6.4K more Precision that gave up 2,605
 * pooled Combat Power and a +5% crit aspect, which on a combat hull is a trade the headline cannot see.
 *
 * The HEURISTIC breaks only the ties it cannot: a hull kit that changes no damage figure at all still differs
 * by armour, aspect slots and draw, and an objective reading 0 there is SILENT, not negative. The three bands,
 * and the middle one is the one that bit:
 *
 *   gain ≥ MIN_GAIN         an upgrade, and worth the hangar trip
 *   |gain| < OBJECTIVE_TIE  the objective has nothing to say ∴ `compareModules` answers
 *   anything else           the objective HAS an opinion and it is not "better" ∴ keep what is fitted
 *
 * A sub-floor LOSS is still a loss: reading the whole band between the two as "indifferent" let a tie-break
 * override the objective, which is how an engine that gave up Combat Power and its zero draw won a slot on
 * having one more aspect slot.
 */
/**
 * Whether this module should displace that one AND WHY — one owner for both, because a verdict the player cannot
 * check is how three separate objective bugs stayed invisible for as long as they did.
 *
 * The `why` is written for the person reading a rail row, not for a log: it names what actually separated the two,
 * which on a silent objective is a countable tie-break and on a live one is a percentage of the battery.
 */
export function moduleWhy(cand: Item, eq: Item | null, ctx: ModuleCtx): { better: boolean; why: string } {
  if (!eq) return { better: true, why: "the slot is empty" };
  if (ctx.pools && ctx.turrets?.length) {
    const gain = moduleGain(cand, eq, ctx);
    // THE COMPARISON MUST DISAGREE WITH ITSELF IN AT MOST ONE DIRECTION. `moduleGain` prices a swap against the
    // pools as they read WITH the current module fitted, and two modules differing in a reactor-capacity aspect
    // (`Microgenerators ×1.1`) as well as in a pooled stat can each score a gain from the other's baseline: the
    // reported pool already embeds the bracket the fitted one produces, so the unwind is not symmetric. Acting on
    // that is the apply → suggest → apply BOUNCE the user saw — two module sets proposed alternately, forever.
    //
    // Where both directions claim a gain the honest answer is that the objective cannot order them, so it says so
    // and the tie-breaks below decide — which are antisymmetric by construction. A swap is only ever
    // DECLINED by this, never invented.
    const back = moduleGain(eq, cand, ctx);
    if (gain >= MIN_GAIN && back >= MIN_GAIN)
      return { better: false, why: "the two cannot be ordered — each scores higher from the other's build" };
    if (gain >= MIN_GAIN) return { better: true, why: `+${(gain * 100).toFixed(1)}% for the whole battery` };
    if (Math.abs(gain) >= OBJECTIVE_TIE)
      return { better: false, why: `${(gain * 100).toFixed(1)}% for the whole battery` };
    // Silent on what the two DO — so what they could BECOME decides, before the countable tie-breaks.
    const potential = slotPotential(cand, ctx) - slotPotential(eq, ctx);
    if (Math.abs(potential) >= OBJECTIVE_TIE)
      return { better: potential > 0, why: "an empty aspect slot is worth more than the difference" };
  }
  const { d, why } = compareModulesWhy(cand, eq, ctx.energy, ctx.role, ctx.fit);
  // The objective could not separate them, so SAY that as well as the tie-break: a "+0" with a reason reads as a
  // judgement, where a "+0" alone reads as a mistake.
  return { better: d > 0, why: why ? `same battery score — ${why}` : "nothing separates them" };
}

/** The verdict alone, for every caller that only orders by it. */
export function moduleBetter(cand: Item, eq: Item | null, ctx: ModuleCtx): boolean {
  return moduleWhy(cand, eq, ctx).better;
}

/** A set's worth: an ordered TIER plus a value inside it. Never one number — see `setRank`. */
export type Rank = [tier: number, value: number];

/**
 * A set's worth, per activity. Tier FIRST, because Mining Power and a DPS index share no unit: they are ordered,
 * never added, and never compared by magnitude. Score a non-combat set by its own headline power and let it
 * compete with a DPS figure, and a mining gun takes a combat slot whenever its number happens to be bigger.
 *
 * Combat outranks non-combat outright: a hardpoint that can take a weapon is worth more as a weapon, and the tier
 * enforces that without any magnitude comparison.
 *
 * `act` is the activity to judge the set ON, and any caller comparing two sets MUST pass it. Left out, the
 * activity is read off the set itself — and `activityOf` answers "Mining" for any battery holding one mining gun,
 * so two candidate sets can be scored against two different pools and compared as though they shared a unit. The
 * figure is then whichever pool is fatter rather than whichever build does the job. Passing it makes a gun of
 * another activity contribute 0, which is what stops it being proposed at all.
 */
export function setRank(set: Item[], bg: ShipPools, target: LayerTarget = "balanced", act?: PowerActivity): Rank {
  if (set.some(isCombat)) return [2, setDps(set, bg)];
  const a = act ?? activityOf(set);
  // A set holding no gun of the activity has no rank IN that activity's tier. Returning [1, 0] instead would tie
  // an empty battery with one that at least reaches a layer, and the ascent then stops filling slots at all.
  if (!a || !set.some((it) => catOf(it) === a)) return [0, 0];
  return [1, setPowerTargeted(set, bg, a, target)];
}

/**
 * Are two sets scored on the SAME scale, so a delta between them means anything?
 *
 * `Rank`'s tier keeps a DPS index away from a power share, but Mining and Salvage are BOTH tier 1 — so `rankSub`
 * will happily subtract a Mining Power figure from a Salvage one and the UI will print the difference as a
 * percentage: same tier, different unit. Any surface showing a delta has to ask this first.
 */
export function sameScale(a: Item[], b: Item[]): boolean {
  const ca = a.some(isCombat), cb = b.some(isCombat);
  if (ca !== cb) return false;
  if (ca) return true;
  return activityOf(a) === activityOf(b);
}

export const rankGt = (a: Rank, b: Rank) => (a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1]);
/** Difference only WITHIN a tier. Across tiers there is no difference to state, so it is 0. */
export const rankSub = (a: Rank, b: Rank) => (a[0] === b[0] ? a[1] - b[1] : 0);

/**
 * Is switching from `base` to `next` worth a hangar trip? The one place the `MIN_GAIN` floor is decided, so the
 * optimizer, the per-slot suggest and the rails cannot disagree about what counts as an upgrade.
 *
 * A tier RISE always is (a weapon where a mining laser sat is a different job, not a bigger number). Inside a
 * tier the gain must clear the floor as a fraction of the baseline — a ratio, which is why it stays valid for
 * Mining Power as much as for a DPS index.
 */
export function worthSwitching(next: Rank, base: Rank): boolean {
  if (next[0] !== base[0]) return next[0] > base[0];
  if (!(base[1] > 0)) return next[1] > base[1];
  return rankSub(next, base) / base[1] >= MIN_GAIN;
}

/* ---- THE RANKED GOAL ------------------------------------------------------------------------------------
 *
 * "combat power over armor over precision" — an ORDER, which is the one thing a player can actually state. A
 * weight cannot be stated: there is no knowable exchange rate between a hull point and a point of damage, and
 * inventing one is V31's "a guess wearing a measurement's clothes". A floor cannot be stated either: it needs a
 * MAGNITUDE (`hull >= 1,200,000`) nobody knows. An order needs neither, because it never compares two different
 * stats — it compares combat power to combat power, then armor to armor, and reads armor only where combat power
 * came out the same.
 *
 * THE SHAPE IS `officer.ts`'s comparator, which is six lines and already proven: scan a per-candidate vector,
 * then INCUMBENCY, then the existing tie-break. It is safe to be that simple because `cov[i]` is EXACT — a
 * boolean — so the scan is transitive and `sort` is well defined.
 *
 * THE ONE RULE THIS KEEPS: the key stays exact. Each sign is computed ONCE per candidate against the FITTED
 * build, and the band that decides "same" is applied THERE. A banded PAIRWISE comparator — `if (abs(d) > band)
 * return sign(d)` — is INTRANSITIVE: at a band of 0.5, 100 ties 100.4 ties 100.8 while 100 loses to 100.8. That
 * is V70's family, which has already cost five bugs; a hill-climb on it can cycle and `Array.sort` is
 * implementation-defined. Against a fixed reference the vector is exact and the order is total.
 *
 * THREE states, not two: an officer cannot anti-cover a priority, but a build can REGRESS, and it is `worse`
 * that disqualifies a plan before a lower key is ever read.
 */
export type GoalSign = -1 | 0 | 1;

/** What a goal may rank. Each is a figure the objective computes for a WHOLE build and that `reconcile.test.ts`
 *  covers — a key nothing validates would be an opinion with no measurement under it. */
export const GOAL_KEYS = ["dps", "combat", "precision", "mining", "salvage", "hull", "armor", "shield"] as const;
export type GoalKey = (typeof GOAL_KEYS)[number];

/** One build's figures, in the units the panel already shows. A key this build has no reading for is absent, and
 *  absent orders nothing — it can neither promote nor demote a candidate. */
export type GoalReading = Partial<Record<GoalKey, number>>;

/**
 * Better, same or worse than the FITTED build on ONE key.
 *
 * The band is `OBJECTIVE_TIE`, the documented silence band — the difference below which this objective already
 * declines to have an opinion. It is an INTRA-stat judgement ("what counts as no change in combat power") and so
 * is answerable; a weight would be an INTER-stat one, and that is the thing nobody can answer.
 */
export function goalSign(cand: number | undefined, fitted: number | undefined,
                         band = OBJECTIVE_TIE): GoalSign {
  if (cand == null || fitted == null || !Number.isFinite(cand) || !Number.isFinite(fitted)) return 0;
  if (!(Math.abs(fitted) > 0)) return cand > 0 ? 1 : cand < 0 ? -1 : 0;
  const d = (cand - fitted) / Math.abs(fitted);
  return d > band ? 1 : d < -band ? -1 : 0;
}

/** The whole vector, in the player's own order. Computed ONCE per candidate, against the fitted build. */
export function goalVector(keys: readonly GoalKey[], cand: GoalReading, fitted: GoalReading,
                           band = OBJECTIVE_TIE): GoalSign[] {
  return keys.map((k) => goalSign(cand[k], fitted[k], band));
}

/** A candidate as the goal comparator reads it: its signs, whether it IS the fitted build, and the scalar the
 *  objective already scores it by — which breaks ties inside a vector and nothing more. */
export interface GoalCandidate { signs: GoalSign[]; fitted?: boolean; scalar?: number }

/**
 * Negative ⇒ `a` ranks above `b`. A comparator, so it can be handed to `sort` — which is only sound because the
 * signs are exact.
 *
 * INCUMBENCY sits immediately after the keys, copied from `officer.ts` where it is the whole anti-churn
 * mechanism: "the optimizer never proposes a swap that doesn't change priority coverage — that churn read as
 * 'changes I didn't ask for'". A candidate that ties the fitted build on every key does not displace it.
 */
export function goalCompare(a: GoalCandidate, b: GoalCandidate): number {
  const n = Math.min(a.signs.length, b.signs.length);
  for (let i = 0; i < n; i++) if (a.signs[i] !== b.signs[i]) return b.signs[i] - a.signs[i];
  if (!!a.fitted !== !!b.fitted) return a.fitted ? -1 : 1;
  // Only inside an identical vector, and only as a magnitude: two candidates both "better on combat power" are
  // separated by HOW much, which is what keeps a ranked goal from flattening into indifference.
  return (b.scalar ?? 0) - (a.scalar ?? 0);
}

/** Does the goal prefer `cand` over the fitted build? The fitted build is `signs` of all zeroes by construction,
 *  so this is `goalCompare` against it — stated as its own name because it is the question every caller asks. */
export function goalPrefers(cand: GoalCandidate, fittedScalar = 0): boolean {
  return goalCompare(cand, { signs: cand.signs.map(() => 0), fitted: true, scalar: fittedScalar }) < 0;
}

/**
 * A LAYER HP as this build would read it, anchored on the game's own figure.
 *
 * `GetStat` is `(base + Σ amount) * Π multiplier`, and on the HP stats that product is enormous: measured on the
 * Varyag, Hull HP is `(1,409 + 8,338) * 269.176` — a Hull Kit contributing `Hull HP ×162.948` and two modules
 * contributing 4,575 and 3,763 flat. Taking a raw additive line off the REPORTED total (already multiplied) and
 * adding the candidate's back mixes the two spaces: an item's 2,339 of Hull HP moves the row by 2,339 where the
 * game moves it by 2,339 × 269. So: divide the product out, move the additive half there, put the candidate's
 * product back — the order `poolsWithModule` uses for the pools, and the same reason.
 *
 * ANCHORED, NEVER RE-SUMMED, and that is load-bearing: the reported figure already carries the game's own
 * scaling passes — `rankHp × escalationHp × hpBalance(level)`, measured at ×8.57 on a Legendary level-60 unit
 * and ×2.00 on a Rookie — which `ApplyHpBalanceBonus` applies to the PLAYER's ship too, with no faction guard.
 * A layer HP rebuilt from item lines alone is short by a factor that is not one number and that `/status` does
 * not serve. Only the RATIO between two builds is ours to compute; the magnitude stays the game's.
 *
 * An ESTIMATE where both halves move, and labelled as one wherever it is shown.
 */
export function projectLayer(cur: number | null, stat: string, curSet: Item[], nextSet: Item[]): number | null {
  if (cur == null) return null;
  const lines = (set: Item[]) => {
    let add = 0, mul = 1;
    for (const it of set) {
      const t = statTotals(it).get(stat);
      if (t) { add += t.add; mul *= t.mul; }
    }
    return { add, mul };
  };
  const a = lines(curSet);
  const b = lines(nextSet);
  if (a.add === b.add && Math.abs(a.mul - b.mul) < 1e-9) return cur;
  if (!(a.mul > 0)) return cur;
  // `cur / a.mul` is the whole additive side INCLUDING the hull's own base, which no gear swap moves.
  const base = cur / a.mul - a.add;
  return Math.max(0, (base + b.add) * b.mul);
}

/** One build's ranked figures, read off the pools the objective already scores with. HULL/ARMOR/SHIELD do not
 *  live in the pools at all — they are the GAME's own `/ship/vitals` reading, projected by `projectLayer` — so
 *  they arrive as `layers` or not at all, and a key with no reading orders nothing (`goalSign`) rather than
 *  silently counting as unchanged. */
export function goalReadingOf(p: ShipPools | null | undefined, rank?: Rank,
                              layers?: { hull?: number | null; armor?: number | null; shield?: number | null }): GoalReading {
  if (!p) return {};
  return {
    combat: p.poolCombatPower,
    precision: p.poolPrecision,
    mining: p.poolMiningPower,
    salvage: p.poolSalvagePower,
    dps: rank && rank[0] === 2 ? rank[1] : undefined,
    hull: layers?.hull ?? undefined,
    armor: layers?.armor ?? undefined,
    shield: layers?.shield ?? undefined,
  };
}

/**
 * The order a ship starts with, before the player states one.
 *
 * Deliberately ONE key — the pool the hull's own role is about. A longer default would be inventing an ordering
 * the player has not asked for, and the whole point of an order over a weight is that it comes from them. One key
 * is enough to refuse the class of plan that prompted this: a battery whose Combat Power FALLS is not an upgrade
 * to a combat ship, whatever it does for a stat further down.
 */
export function defaultGoalOrder(role?: string | null): GoalKey[] {
  switch (role) {
    case "Combat": return ["combat"];
    case "Mining": return ["mining"];
    case "Salvaging": return ["salvage"];
    default: return [];      // no role, no default opinion — the objective behaves exactly as before
  }
}

/**
 * The KEY that refuses this plan, or null when the goal is content.
 *
 * A veto only: the goal may decline a plan the objective liked, never invent one it did not — the same rule the
 * both-ways guard obeys, and for the same reason. It names the key so the tab can say WHY a slot was kept, since
 * a plan silently withheld is indistinguishable from having found nothing.
 */
/**
 * Every tracked measurement this plan LOWERS by more than `threshold`, worst first.
 *
 * A WARNING, ⊥ a refusal, and the difference is the whole point: the app declining a trade the player would have
 * taken is worse than the app taking one it should have flagged, because a refusal is invisible — it produces no
 * row, and the only trace is a sentence explaining an absence. Naming what falls hands the decision back with the
 * facts attached.
 *
 * It reads EVERY key rather than the three layers, because a plan can be ruinous on an axis nobody thought to cap:
 * a swap costing 4.9% of Combat Power on a combat hull said nothing at all while a hull cap was busy refusing
 * plans, which is the wrong axis watched for the wrong reason.
 *
 * A key missing from either reading is skipped rather than treated as zero — absent and "fell to nothing" are
 * different claims, and a bridge that stops reporting a pool must not read as every plan destroying it.
 */
export function goalDrops(fitted: GoalReading, planned: GoalReading,
                          threshold: number): { key: GoalKey; drop: number }[] {
  const out: { key: GoalKey; drop: number }[] = [];
  for (const k of GOAL_KEYS) {
    const a = fitted[k], b = planned[k];
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || !(a > 0)) continue;
    const drop = (a - b) / a;
    if (drop > threshold) out.push({ key: k, drop });
  }
  return out.sort((x, y) => y.drop - x.drop);
}

export function goalRefuses(order: readonly GoalKey[], fitted: GoalReading, planned: GoalReading,
                            band = OBJECTIVE_TIE): GoalKey | null {
  for (const k of order) {
    const s = goalSign(planned[k], fitted[k], band);
    if (s < 0) return k;        // worse on a ranked key: refused before any lower key is read
    if (s > 0) return null;     // better on a ranked key: nothing below it can overrule that
  }
  return null;                  // every ranked key tied — the objective's own scalar decides, as before
}

/**
 * THE DEFENSIVE LAYERS, AND THE ONE RULE THAT IS NOT AN EXCHANGE RATE.
 *
 * A ranked ORDER cannot answer the complaint that produced this — "it wants me to cut the shields and hull in
 * half for a small DPS gain" — because an order with Combat first never reads the hull key when combat WENT UP.
 * Ordering says which stat is consulted; it says nothing about how much of one is worth how much of another,
 * and by design nothing here invents that rate.
 *
 * What a player can state without inventing one is a REFUSAL TO BE WRECKED: however good the gain, do not shed
 * more than this share of a layer. It needs no magnitude — no `hull >= 1,200,000` that nobody can know — only a
 * fraction of what the ship already has, which is why it survives the objection that killed floors.
 *
 * PER LAYER, deliberately, and not against a summed "effective HP": shields absorb first, armor carries its own
 * weak/resist type table (`ArmorModule.ApplyArmorResistance`) and hull is what is left when both are gone, so a
 * total hides a layer going to zero while another rises to cover it. A plan may lift the shield and gut the
 * armor; the sum says nothing happened.
 *
 * The reading is the GAME's (`/ship/vitals`) projected by `projectLayer`, never a re-sum of item lines — the
 * reported figure carries `rankHp × escalationHp × hpBalance(level)`, which applies to the player's own ship and
 * is not one number.
 */
export const DEFAULT_LAYER_CAP = 0.10;

export interface LayerReading { hull?: number | null; armor?: number | null; shield?: number | null }

/** How a layer reads on screen when it is the one refusing. */
export const LAYER_LABEL: Record<keyof LayerReading, string> = { hull: "Hull", armor: "Armor", shield: "Shield" };

/**
 * The layer this plan sheds too much of, or null. Reports the WORST one and by how much, because a refusal that
 * cannot say which layer or how far is a refusal the player can do nothing with.
 *
 * A layer with no reading on either side orders nothing — absent is not zero, and a ship with no armor module
 * must not read as one whose armor was destroyed.
 */
export function layerRefuses(now: LayerReading, plan: LayerReading,
                             cap = DEFAULT_LAYER_CAP): { layer: keyof LayerReading; drop: number } | null {
  let worst: { layer: keyof LayerReading; drop: number } | null = null;
  for (const layer of ["hull", "armor", "shield"] as const) {
    const a = now[layer], b = plan[layer];
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || !(a > 0)) continue;
    const drop = (a - b) / a;
    if (drop > cap && (!worst || drop > worst.drop)) worst = { layer, drop };
  }
  return worst;
}

/** How a refused key reads on screen. */
export const GOAL_LABEL: Record<GoalKey, string> = {
  dps: "DPS", combat: "Combat Power", precision: "Precision", mining: "Mining Power",
  salvage: "Salvage Power", hull: "Hull", armor: "Armor", shield: "Shield",
};

/** What layer a hardpoint is FOR. `any` leaves the choice to the meta search. */
export type LayerRole = "surface" | "core" | "any";

/** One hardpoint to fill: its size, and what may go in it (already filtered by the slot's own filter). */
export interface SlotChoice {
  key: string;
  candidates: Item[];
  // What the slot holds NOW. The search is seeded from it so the answer can never be worse than the build the
  // player already flies — see optimizeTurretSet.
  current?: Item | null;
  // The layer this hardpoint is assigned to, if the player pinned one. `any`/absent means the meta search picks.
  layerRole?: LayerRole;
}

const LAYER_OF: Record<Exclude<LayerRole, "any">, Layer> = { surface: "Surface", core: "Core" };

/** Keep only what can serve `layer` — items of another activity are left alone, since the layer split is per activity. */
function forLayer(slot: SlotChoice, act: PowerActivity, layer: Layer): SlotChoice {
  return { ...slot, candidates: slot.candidates.filter((c) => catOf(c) !== act || coversLayer(c, layer)) };
}

/** How many `any` slots the enumeration will accept before it gives up and just runs the ascent once. */
const MAX_ENUMERATED_SLOTS = 8;

/**
 * Choose turrets for a BALANCED non-combat battery: exhaustive over layer assignments, greedy within each.
 *
 * `optimizeTurretSet` hill-climbs one scalar, which is sound while the objective is "maximise". It stops being
 * sound once two values must be BALANCED: the marginal worth of a Core gun depends on how much Core the set
 * already has, so a single-slot move is no longer a reliable step and the "may MISS a jointly-better pair"
 * becomes the normal case rather than an edge one — swapping two slots to opposite layers is precisely the move
 * ascent cannot make.
 *
 * So balance stops being part of the objective and becomes an ASSIGNMENT. Give every hardpoint a layer and the
 * problem decomposes: each slot maximises power within its own layer, which is exactly the shape ascent handles.
 * The assignment itself is small enough to enumerate — at most 2^n over the unpinned slots — so the search is
 * exhaustive where greedy is unsound and greedy where it is sound.
 *
 * The layers stay coupled through `poolShare`'s divisor and the reactor bracket, and that needs no handling here:
 * scoring is a SET function, so the coupling is seen by `setRank` rather than by the search.
 */
export function optimizeTurretSetLayered(
  slots: SlotChoice[], bg: ShipPools, act: PowerActivity,
  opts: { target?: LayerTarget; maxPasses?: number; fixed?: Item[] } = {},
): Map<string, Item> {
  const { target = "balanced", maxPasses = 4, fixed = [] } = opts;

  // A single-layer target needs no enumeration at all: filter to that layer and maximise one number.
  if (target !== "balanced") {
    const layer = LAYER_OF[target];
    return optimizeTurretSet(slots.map((s) => forLayer(s, act, layer)), bg, maxPasses, fixed, target, act);
  }

  // A hull with one hardpoint cannot cover two layers, so `balanced` would score every option 0 and the pick would
  // be arbitrary. Balance is only required where ACHIEVABLE, and the slot count is the caller's fact, not the
  // objective's — so resolve it here by taking the better of the two single-layer answers.
  if (slots.length < 2) {
    const each = (t: LayerTarget) => {
      const chosen = optimizeTurretSetLayered(slots, bg, act, { ...opts, target: t });
      return { chosen, score: setRank([...fixed, ...chosen.values()], bg, t, act) };
    };
    const [s1, c1] = [each("surface"), each("core")];
    return rankGt(c1.score, s1.score) ? c1.chosen : s1.chosen;
  }

  const free = slots.filter((s) => (s.layerRole ?? "any") === "any");
  // Past the cap the enumeration stops being interactive; the plain ascent is still monotone and still correct,
  // just no longer proof against a local optimum.
  if (free.length > MAX_ENUMERATED_SLOTS) {
    return optimizeTurretSet(slots, bg, maxPasses, fixed, target, act);
  }

  const pinned = new Map<string, Layer>();
  for (const s of slots) {
    const role = s.layerRole ?? "any";
    if (role !== "any") pinned.set(s.key, LAYER_OF[role]);
  }

  // A plain ascent is one of the candidates, not a fallback: each inner run is still greedy, so exploring more
  // assignments does not on its own guarantee a better answer, and keeping it makes "never worse than the plain
  // ascent" hold by construction — the same way `optimizeTurretSet` keeps whichever of its two seeds wins.
  //
  // It runs under the PINS, though, not unconstrained: a pinned role is the player's instruction, so an
  // unconstrained run that scored higher by ignoring it would not be a better answer to the question asked.
  // With no pins this is exactly the plain ascent, which is the case the search test exercises.
  const underPins = slots.map((s) => {
    const l = pinned.get(s.key);
    return l ? forLayer(s, act, l) : s;
  });
  let best: Map<string, Item> = optimizeTurretSet(underPins, bg, maxPasses, fixed, target, act);
  let bestScore: Rank = setRank([...fixed, ...best.values()], bg, target, act);
  for (let mask = 0; mask < 1 << free.length; mask++) {
    const layerFor = new Map(pinned);
    free.forEach((s, i) => layerFor.set(s.key, mask & (1 << i) ? "Core" : "Surface"));
    // Prune the degenerate assignments: one that reaches a single layer scores 0 under `balanced` anyway, so
    // running the ascent for it is pure waste.
    const reach = new Set(layerFor.values());
    if (reach.size < 2) continue;

    const chosen = optimizeTurretSet(
      slots.map((s) => forLayer(s, act, layerFor.get(s.key)!)), bg, maxPasses, fixed, target, act,
    );
    const score = setRank([...fixed, ...chosen.values()], bg, target, act);
    if (best == null || rankGt(score, bestScore)) { best = chosen; bestScore = score; }
  }

  // `best` is seeded with the plain ascent, so there is always an answer: a hull that cannot cover both layers
  // from the stock on hand is the `coversLayers` caller's news to break, not a reason to return nothing.
  return best;
}

/**
 * Choose a turret per slot to maximise TOTAL ship DPS.
 *
 * Greedy then fixed-point: seed each slot with its best candidate judged alone, then re-pick one slot at a time
 * against the set the others currently form, until a full pass changes nothing. Each re-pick goes through
 * `setRank`, so the shared pools are seen from the whole battery's perspective — which is what lets a
 * Precision-heavy gun win a slot it would lose on its own numbers.
 *
 * Not provably optimal: every slot's choice changes every other slot's value through the pools, and a coordinate
 * ascent can settle in a local maximum. It is monotone, converges in two or three passes on real inventories, and
 * `maxPasses` bounds the pathological case. An item can only be used once — gear is not shared between slots.
 */
// `fixed` are turrets the ship keeps but this call is not choosing (hand-set slots, hardpoints outside the filter).
// They take part in every evaluation: the objective is the WHOLE battery, so scoring a subset answers a question
// about a ship that does not exist.
export function optimizeTurretSet(slots: SlotChoice[], bg: ShipPools, maxPasses = 4, fixed: Item[] = [], target: LayerTarget = "balanced", act?: PowerActivity): Map<string, Item> {
  return optimizeGearSet({
    slots,
    maxPasses,
    score: (chosen) => setRank([...fixed, ...chosen.values()], bg, target, act),
    alone: (it) => setRank([...fixed, it], bg, target, act),
  });
}

/**
 * Choose a MODULE per slot against the whole ship — the module half of the same search the battery gets.
 *
 * Per slot was not enough, and the reason is the reactor: a module's draw and its `Energy` line both move the
 * bracket, and the bracket multiplies EVERY power pool. Judged one slot at a time, two modules that each stay
 * inside a bracket can cross it together, and the only defence was to forbid any swap that gave up a bracket —
 * a constraint standing in for a set objective, which also refused the crossings that PAY. Scoring the whole
 * assignment through `poolsWithModules` prices them instead.
 *
 * The battery is `turrets` and does not move here, but it is the thing being scored: a module is worth what it
 * does for the guns. Pass the planned turrets, not the fitted ones, when a turret plan is pending.
 *
 * `ctx` carries the parts of the decision the objective cannot see — role, fit, layer target, activity. Its
 * `pools`, `turrets` and `energy` are supplied per evaluation and whatever the caller sets is ignored.
 */
export function optimizeModuleSet(
  slots: SlotChoice[], pools: ShipPools, turrets: Item[], ctx: ModuleCtx = {}, maxPasses = 4,
): Map<string, Item> {
  // What each open slot holds now. Positional against the assignment below, so a slot nobody re-picks swaps its
  // own item for itself and moves nothing.
  const out = slots.map((s) => s.current ?? null);
  const inn = (chosen: ReadonlyMap<string, Item>, override?: { at: string; item: Item }) =>
    slots.map((s) => (override && s.key === override.at ? override.item : chosen.get(s.key) ?? s.current ?? null));

  return optimizeGearSet({
    slots,
    maxPasses,
    score: (chosen) => {
      const next = poolsWithModules(pools, out, inn(chosen));
      return setRank(turrets, background(next, turrets), ctx.target, ctx.act);
    },
    // `moduleBetter` is asked, never re-derived: its bands decide when the objective is SILENT rather than
    // negative, and a sub-floor loss is still a loss. It is handed the ship as the other slots would
    // leave it, with this slot still holding `best`, so `out`/`inn` inside it are exactly this one swap.
    tie: (cand, best, at, chosen) => {
      const next = poolsWithModules(pools, out, inn(chosen, { at, item: best }));
      const e = next.energy;
      return moduleBetter(cand, best, {
        ...ctx,
        pools: next,
        turrets,
        energy: e && e.capacity > 0
          ? { usedWithout: Math.max(0, e.used - (best.powerUsage ?? 0)), capacity: e.capacity }
          : undefined,
      });
    },
  });
}

/** Both halves of the ship, opened to ONE search. */
export interface ShipSearch {
  /** Hardpoints this search may fill. Empty is legal — then it is `optimizeModuleSet` with more ceremony. */
  turretSlots: SlotChoice[];
  moduleSlots: SlotChoice[];
  pools: ShipPools;
  /** The battery as FITTED — what the reported pools already contain, and therefore what `background` strips. */
  fittedTurrets: Item[];
  /** Turrets the ship keeps that this search is not choosing: pinned slots, hardpoints outside the filter. */
  fixedTurrets?: Item[];
  ctx?: ModuleCtx;
  target?: LayerTarget;
  act?: PowerActivity;
  maxPasses?: number;
}

/**
 * Choose turrets AND modules together — the coupling that runs BETWEEN the halves, which neither single-block
 * pass can see.
 *
 * `optimizeModuleSet` holds the battery still and `optimizeTurretSet` holds the modules still, so each is blind
 * to the move the other unlocks: a bigger reactor raises capacity, which relaxes the bracket, which makes a
 * THIRSTIER gun affordable — and the player can only reach it by pressing the two buttons in the right order,
 * twice. That is a ritual, and an optimizer exists to end it.
 *
 * Not a new ascent: the same `optimizeGearSet` over both slot lists, with one objective that folds the module
 * assignment onto the pools and then scores the candidate battery against it. The module slots come FIRST in
 * the order, because capacity moves before the guns that spend it.
 */
export function optimizeShipSet({
  turretSlots, moduleSlots, pools, fittedTurrets, fixedTurrets = [], ctx = {}, target, act, maxPasses = 4,
}: ShipSearch): Map<string, Item> {
  // Positional against `inn` below, so a module slot nobody re-picks swaps its own item for itself.
  const out = moduleSlots.map((s) => s.current ?? null);
  const moduleKeys = new Set(moduleSlots.map((s) => s.key));
  const inn = (chosen: ReadonlyMap<string, Item>, override?: { at: string; item: Item }) =>
    moduleSlots.map((s) => (override && s.key === override.at ? override.item : chosen.get(s.key) ?? s.current ?? null));
  const battery = (chosen: ReadonlyMap<string, Item>): Item[] => [
    ...fixedTurrets,
    ...turretSlots.map((s) => chosen.get(s.key) ?? s.current ?? null).filter((x): x is Item => !!x),
  ];

  // `background` is the expensive half and depends on the MODULE assignment alone — which does not move while a
  // hardpoint's candidates are tried. Memoised on that vector by identity ∴ a turret pass costs one `setRank`
  // per candidate instead of a full re-derivation of every pool.
  let lastMods: (Item | null)[] | null = null;
  let lastBg: ShipPools | null = null;
  const bgFor = (mods: (Item | null)[]): ShipPools => {
    if (lastBg && lastMods && lastMods.length === mods.length && lastMods.every((m, i) => m === mods[i])) return lastBg;
    lastMods = mods;
    lastBg = background(poolsWithModules(pools, out, mods), fittedTurrets);
    return lastBg;
  };

  return optimizeGearSet({
    slots: [...moduleSlots, ...turretSlots],
    maxPasses,
    // ONE evaluation for both halves: the modules decide the pools (capacity included), the battery is scored
    // against them, and `setDps` adds the candidate battery's own draw — so a bracket edge is crossed, or
    // cleared, by the WHOLE plan rather than by either half's guess about the other.
    score: (chosen) => setRank(battery(chosen), bgFor(inn(chosen)), target, act),
    // A turret alone is a battery of one, judged against the ship's CURRENT modules. A module has no such
    // reading — nothing else being chosen, every module scores the same — so it answers null and seeds from
    // `moduleBetter` below.
    alone: (it, at) => (moduleKeys.has(at)
      ? null
      : setRank([...fixedTurrets, it], bgFor(inn(NO_ASSIGNMENT)), target, act)),
    // `moduleBetter` is asked, never re-derived. Turret ties stay with the objective, which is
    // the only thing that can order two whole batteries.
    tie: (cand, best, at, chosen) => {
      if (!moduleKeys.has(at)) return false;
      const next = poolsWithModules(pools, out, inn(chosen, { at, item: best }));
      const e = next.energy;
      return moduleBetter(cand, best, {
        ...ctx,
        pools: next,
        turrets: battery(chosen),
        energy: e && e.capacity > 0
          ? { usedWithout: Math.max(0, e.used - (best.powerUsage ?? 0)), capacity: e.capacity }
          : undefined,
      });
    },
  });
}

const NO_ASSIGNMENT: ReadonlyMap<string, Item> = new Map();

/** What an ascent needs to know about the thing it is choosing. */
export interface GearSearch {
  slots: SlotChoice[];
  maxPasses?: number;
  /**
   * The WHOLE ship's worth with this assignment — the objective, whichever half is being chosen.
   *
   * Keyed by SLOT, because what a choice is worth can depend on the slot it lands in: a module swap has to know
   * what it displaces, and only the key says which item that is. The map is the ascent's live state, so read it and
   * never retain it.
   *
   * Gear the ship keeps but this call is not choosing belongs INSIDE this closure: the objective is the whole ship,
   * so scoring a subset answers a question about a ship that does not exist.
   */
  score: (chosen: ReadonlyMap<string, Item>) => Rank;
  /**
   * One item judged with nothing else open — seed B. Keyed by SLOT because a search over BOTH halves of the ship
   * has slots of two kinds: a turret alone is a battery of one, while a module alone is worth the same whatever
   * it is, so a module slot answers `null` and is seeded from the tie-break instead. Omitted entirely, every slot
   * is.
   */
  alone?: (it: Item, at: string) => Rank | null;
  /**
   * Break a tie the objective cannot: `true` if `cand` should displace `best` when the two score the same.
   *
   * Only consulted when `score` genuinely cannot separate them, and it is the caller's own predicate — for modules
 * that is `moduleBetter`, whose bands are load-bearing (a sub-floor LOSS is a loss,). The ascent must not
   * invent a tie rule of its own, or there are two answers to "is this better" again.
   */
  tie?: (cand: Item, best: Item, at: string, chosen: ReadonlyMap<string, Item>) => boolean;
}

/**
 * Choose an item per slot to maximise the whole ship's worth — the ONE coordinate ascent in the app, over
 * hardpoints, module slots, or both at once.
 *
 * Greedy then fixed-point: seed each slot, then re-pick one slot at a time against the set the others currently
 * form, until a full pass changes nothing. Every re-pick goes through `score`, so the shared pools are seen from
 * the whole ship's perspective — which is what lets a Precision-heavy gun win a slot it would lose on its own
 * numbers, and what lets two module swaps be bracketed TOGETHER rather than one at a time.
 *
 * Not provably optimal: every slot's choice changes every other slot's value through the pools, and a coordinate
 * ascent can settle in a local maximum. It is monotone, converges in two or three passes on real inventories, and
 * `maxPasses` bounds the pathological case. An item can only be used once — gear is not shared between slots.
 */
export function optimizeGearSet({ slots, maxPasses = 4, score, alone, tie }: GearSearch): Map<string, Item> {
  // Coordinate ascent from a seed. Each pass is monotone — a slot only changes when the whole set scores
  // higher — but ascent converges to a LOCAL optimum, so the seed decides which one. Seeding only with
  // "best item alone per slot" can therefore land BELOW the build already fitted, making every per-slot
  // suggestion worse than keeping what is there.
  //
  // So the current configuration is a seed too, and the better outcome wins. That makes the result never
  // worse than the status quo, which is the one guarantee a "suggest" button has to honour.
  const run = (seed: (slot: SlotChoice, used: Set<Item>) => Item | undefined): Map<string, Item> => {
    const chosen = new Map<string, Item>();
    const used = new Set<Item>();
    const take = (key: string, it: Item | undefined) => {
      const prev = chosen.get(key);
      if (prev) used.delete(prev);
      if (it) { chosen.set(key, it); used.add(it); } else chosen.delete(key);
    };

    for (const slot of slots) take(slot.key, seed(slot, used));

    for (let pass = 0; pass < maxPasses; pass++) {
      let changed = false;
      for (const slot of slots) {
        const current = chosen.get(slot.key);
        let bestItem = current;
        let bestScore = score(chosen);
        // The slot is scored by TRYING each candidate in it and putting the state back, rather than by building a
        // fresh assignment per candidate: an armory runs to thousands of modules, and the copy is the whole cost.
        for (const cand of slot.candidates) {
          if (cand !== current && used.has(cand)) continue;   // spoken for by another slot
          chosen.set(slot.key, cand);
          const s = score(chosen);
          if (rankGt(s, bestScore)) { bestScore = s; bestItem = cand; }
          // Equal on the objective: the caller's own tie-break decides, or nothing does.
          else if (tie && bestItem && !rankGt(bestScore, s) && tie(cand, bestItem, slot.key, chosen)) { bestScore = s; bestItem = cand; }
        }
        if (current) chosen.set(slot.key, current); else chosen.delete(slot.key);
        if (bestItem !== current) { take(slot.key, bestItem); changed = true; }
      }
      if (!changed) break;
    }
    return chosen;
  };

  const total = (chosen: Map<string, Item>) => score(chosen);

  // Seed A: keep what is fitted. Seed B: the best item alone per slot, which is the old per-slot answer and
  // reaches optima the status quo cannot climb to. A caller with no "alone" reading — a module scores the same
  // whatever it is when there is no battery beside it — seeds B from the tie-break instead.
  const fromCurrent = run((slot, used) => {
    const cur = slot.current ?? undefined;
    return cur && !used.has(cur) ? cur : undefined;
  });
  const fromBest = run((slot, used) => {
    const free = slot.candidates.filter((c) => !used.has(c));
    if (alone) {
      const ranked: [Item, Rank][] = [];
      for (const c of free) { const r = alone(c, slot.key); if (r) ranked.push([c, r]); }
      if (ranked.length) return ranked.reduce((a, b) => (rankGt(b[1], a[1]) ? b : a))[0];
    }
    // Nothing is assigned yet at seed time, so the tie-break judges each candidate against the ship as it stands.
    if (tie) return free.reduce<Item | undefined>((a, b) => (!a || tie(b, a, slot.key, NO_ASSIGNMENT) ? b : a), undefined);
    return free[0];
  });

  return rankGt(total(fromBest), total(fromCurrent)) ? fromBest : fromCurrent;
}
