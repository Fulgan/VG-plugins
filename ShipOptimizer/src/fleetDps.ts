import type { Item } from "./types";
import { aspectDamageFraction } from "./aspect";
import { mainVal, statTotals } from "./format";
import { catOf, isTurret } from "./itemKind";
import { energyDraw, poolReactorFactor } from "./reactor";

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
// x1.2439 on the combat pool, a multiplier folded into an additive term for absolute-valued stats, and
// weapon-local aspect stats the bridge cannot see (one worth 25% critical damage on its host). Against those a
// predicted 0.28% is noise — and 0.28% was enough to propose trading a Lv64 gun for a Lv63 one.
//
// So 1% is a JUDGEMENT about confidence, not a derivation: it clears that 0.276% case by roughly 4x while still
// letting a real upgrade through. Closing a gap argues for lowering it; churn reappearing argues for raising it.
export const MIN_GAIN = 0.01; // 1% of the whole battery's score

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
  energy?: {
    used: number;      // draw of everything EXCEPT the turrets in the set (modules, boosters, hull)
    capacity: number;
    mod: number;       // the bracket modifier already baked into poolCombatPower
    // The ship's TOTAL draw when the pools were read. `used` has the equipped turrets taken out of it, so it is
    // the wrong load to de-bracket a reported figure with: the reading was taken at this one.
    usedAll?: number;
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
  combatReactorOutputCP?: number | null;
  critDamage?: number | null; megaCrit?: number | null;
  poolAttackSpeed?: number | null; poolReloadSpeed?: number | null; poolMagazineSize?: number | null;
  caps?: { extraTurretPenalty?: boolean } | null;
  energyCapacity?: number | null; energyUsed?: number | null; reactorBonus?: number | null;
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
      ? { used: s.energyUsed, capacity: s.energyCapacity, mod: s.reactorBonus ?? 0 }
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
  const usage = pools.energy && pools.energy.capacity > 0 ? pools.energy.used / pools.energy.capacity : null;
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
}

const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();

// Stat lines arrive under the game's DISPLAY names ("Critical Damage"), not the EquipStat spelling.
function line(it: Item, stat: string): number {
  const want = norm(stat);
  let total = 0;
  for (const [k, v] of statTotals(it))
    if (norm(k) === want) total += v.add + (v.mul !== 1 ? v.mul - 1 : 0);
  return total;
}

/** Which power pool this turret feeds. `catOf` owns the classification (the game's own `gameplayType`). */
export type PowerActivity = "Mining" | "Salvage";

// Does this turret feed the COMBAT power pool?
export function isCombat(it: Item): boolean {
  return catOf(it) === "Combat";
}

export function contributionOf(it: Item): Contribution {
  const typed = new Map<string, number>();
  for (const type of ["Kinetic", "Energy", "Radiation", "Heat", "Cold", "Corrosion", "Explosive"]) {
    const v = line(it, `${type} Damage`);
    if (v !== 0) typed.set(type, v);
  }
  const act = catOf(it);
  return {
    // A turret's headline power IS its contribution to its own pool, which is why ranking by it worked — but a
    // gun only feeds ONE pool. Reading a mining gun's Mining Power as combat power let the optimiser score
    // ore-throughput as damage; reading it as nothing at all left a mining battery with no objective.
    combatPower: act === "Combat" ? mainVal(it) ?? 0 : 0,
    miningPower: act === "Mining" ? mainVal(it) ?? 0 : 0,
    salvagePower: act === "Salvage" ? mainVal(it) ?? 0 : 0,
    precision: line(it, "Precision"),
    critDamage: line(it, "Critical Damage"),
    typedDamage: typed,
    allDamage: line(it, "Damage"),
    attackSpeed: line(it, "Attack Speed"),
    reloadSpeed: line(it, "Reload Speed"),
    magazineSize: line(it, "Magazine Size"),
  };
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
  const rate = (fd: number, rd: number, mag: number) => {
    const m = Math.max(1, mag);
    const cycle = Math.ceil(m / burst) * ((burst - 1) * bd + fd) + rd;
    return cycle > 0 ? m / cycle : 0;
  };
  const raw = rate(it.fireDelayRaw, it.reloadDelayRaw ?? 0, it.magSizeRaw);
  const boosted = rate(
    it.fireDelayRaw / (1 + attackSpeed),
    (it.reloadDelayRaw ?? 0) / (1 + reloadSpeed),
    Math.round(it.magSizeRaw * (1 + magazineSize)),
  );
  return raw > 0 ? boosted / raw : 1;
}

/** The fixed part of each pool: hull + crew + modules, i.e. everything this optimiser is not choosing. */
export function background(pools: ShipPools, equippedTurrets: Item[]): ShipPools {
  // The reported pool is a PRODUCT — `(base + Σ additive) * Π multiplier` — so the raw contributions below can
  // only be subtracted out of it once the factors are divided away. `residual` is every factor except the
  // reactor bracket (hull role bonus, skill nodes, non-turret gear), which stays constant while candidates are
  // swapped and is re-applied by `poolParts()`.
  // Per pool, because the combat factor carries a skill term the others do not.
  const usage = pools.energy && pools.energy.capacity > 0 ? pools.energy.used / pools.energy.capacity : null;
  const factorFor = (skillBonus: number) =>
    usage != null ? poolReactorFactor(usage, skillBonus) : 1 + (pools.energy?.mod ?? 0);
  const reactorFactor = factorFor(0);
  const combatFactor = factorFor(pools.combatReactorBonus ?? 0);
  const resid = (mult: number | undefined, factor = reactorFactor) =>
    mult != null && mult > 0 ? mult / factor : undefined;
  const residual = resid(pools.poolCombatPowerMult, combatFactor);
  const miningResid = resid(pools.poolMiningPowerMult);
  const salvageResid = resid(pools.poolSalvagePowerMult);
  // Into additive space, out of it again after the subtraction — the same round trip the combat pool makes.
  const down = (v: number | undefined, r: number | undefined) =>
    v == null ? undefined : r != null ? v / reactorFactor / r : v;
  const up = (v: number | undefined, r: number | undefined) =>
    v == null ? undefined : r != null ? v * reactorFactor * r : v;

  let power = residual != null
    ? pools.poolCombatPower / combatFactor / residual
    : pools.poolCombatPower;
  let precision = pools.poolPrecision;
  let critDamage = pools.critDamage;
  let attackSpeed = pools.poolAttackSpeed ?? 0;
  let reloadSpeed = pools.poolReloadSpeed ?? 0;
  let magazineSize = pools.poolMagazineSize ?? 0;
  // Absent when the bridge sends no such pool: there is nothing to subtract from, and inventing a 0 baseline
  // would let a candidate set's own power stand in for the whole pool.
  let mining = down(pools.poolMiningPower, miningResid);
  let salvage = down(pools.poolSalvagePower, salvageResid);
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
    // the same shape; `poolParts()` divides it out again with the same factors.
    poolCombatPower: Math.max(0, residual != null ? power * combatFactor * residual : power),
    combatMultResidual: residual,
    poolPrecision: Math.max(0, precision),
    critDamage: Math.max(0, critDamage),
    // Clamped at 0 like the rest: the hull, crew and skill tree contribute most of these, so a battery whose
    // rolls exceed the reading means the reading is stale, not that the ship fires backwards.
    poolAttackSpeed: Math.max(0, attackSpeed),
    poolReloadSpeed: Math.max(0, reloadSpeed),
    poolMagazineSize: Math.max(0, magazineSize),
    poolMiningPower: mining == null ? undefined : Math.max(0, up(mining, miningResid) as number),
    poolSalvagePower: salvage == null ? undefined : Math.max(0, up(salvage, salvageResid) as number),
    miningMultResidual: miningResid,
    salvageMultResidual: salvageResid,
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
 */
function poolParts(reported: number, set: Item[], energy: ShipPools["energy"],
                   residual = 1, skillBonus = 0): { shared: number; mult: number } {
  // De-bracket with the factor the game APPLIED when it reported this figure, which is the factor at the ship's
  // TOTAL draw — `background()` has since taken the equipped turrets' draw out of `used`, so dividing by a factor
  // recomputed from `used` would use a load the reading was never taken at. Both sides come from
  // `poolReactorFactor`, so the pair cannot disagree about the combat skill term.
  const has = !!energy && energy.capacity > 0;
  const now = has ? poolReactorFactor((energy!.usedAll ?? energy!.used) / energy!.capacity, skillBonus)
                  : 1 + (energy?.mod ?? 0);
  const next = has ? poolReactorFactor((energy!.used + energyDraw(set)) / energy!.capacity, skillBonus)
                   : 1 + (energy?.mod ?? 0);
  return { shared: reported / now / residual, mult: residual * next };
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
                                     bg.combatMultResidual ?? 1, bg.combatReactorBonus ?? 0);
  const precision = bg.poolPrecision + contribs.reduce((n, c) => n + c.precision, 0);
  const critDamage = bg.critDamage + contribs.reduce((n, c) => n + c.critDamage, 0);
  const allDamage = contribs.reduce((n, c) => n + c.allDamage, 0);
  // Pooled, so the whole SET's rolls decide every gun's cycle — not each gun's own.
  const attackSpeed = (bg.poolAttackSpeed ?? 0) + contribs.reduce((n, c) => n + c.attackSpeed, 0);
  const reloadSpeed = (bg.poolReloadSpeed ?? 0) + contribs.reduce((n, c) => n + c.reloadSpeed, 0);
  const magazineSize = (bg.poolMagazineSize ?? 0) + contribs.reduce((n, c) => n + c.magazineSize, 0);

  // Rebuilt the way the game builds it, anchored on its own reading where there is one (see `background`): the
  // additive sources and the multiplier are held constant and the candidate moves only the Precision curve.
  // Without an anchor this reduces to `BASE + curve`, which is what a bridge reporting no crit chance leaves.
  const critChance = (BASE_CRIT_CHANCE + precisionCrit(precision, bg.precisionDivisor) + (bg.critAdd ?? 0))
    * (bg.critAdd == null ? 1 : bg.critChanceMult ?? 1);
  const crit = expectedCrit(critChance, critDamage, bg.megaCrit);

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
    total += ((own + poolShare(shared, nEq, bg) * rating(it)) * mult / 5)
      * speedRatio(it, attackSpeed, reloadSpeed, magazineSize)
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
  const { shared, mult } = poolParts(reported, set, bg.energy, residualFor(bg, act));

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
  const { shared, mult } = poolParts(reported, set, bg.energy, residualFor(bg, act));
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
  // Coordinate ascent from a seed. Each pass is monotone — a slot only changes when the whole set scores
  // higher — but ascent converges to a LOCAL optimum, so the seed decides which one. Seeding only with
  // "best gun alone per slot" can therefore land BELOW the build already fitted, making every per-slot
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
        const others = [...fixed, ...slots.filter((s) => s.key !== slot.key).map((s) => chosen.get(s.key)).filter((x): x is Item => !!x)];
        const current = chosen.get(slot.key);
        let bestItem = current;
        let bestScore = setRank(current ? [...others, current] : others, bg, target, act);
        for (const cand of slot.candidates) {
          if (cand !== current && used.has(cand)) continue;   // spoken for by another slot
          const score = setRank([...others, cand], bg, target, act);
          if (rankGt(score, bestScore)) { bestScore = score; bestItem = cand; }
        }
        if (bestItem !== current) { take(slot.key, bestItem); changed = true; }
      }
      if (!changed) break;
    }
    return chosen;
  };

  const score = (chosen: Map<string, Item>) => setRank([...fixed, ...chosen.values()], bg, target, act);

  // Seed A: keep what is fitted. Seed B: the best gun alone per slot, which is the old per-slot answer and
  // reaches optima that the status quo cannot climb to.
  const fromCurrent = run((slot, used) => {
    const cur = slot.current ?? undefined;
    return cur && !used.has(cur) ? cur : undefined;
  });
  const fromBest = run((slot, used) => slot.candidates
    .filter((c) => !used.has(c))
    .reduce<Item | undefined>((a, b) => (!a || rankGt(setRank([...fixed, b], bg, target, act), setRank([...fixed, a], bg, target, act)) ? b : a), undefined));

  return rankGt(score(fromBest), score(fromCurrent)) ? fromBest : fromCurrent;
}
