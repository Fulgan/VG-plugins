import type { Item } from "./types";

// A TORPEDO IS NOT A SHOT WITH A DIFFERENT SPRITE, and every line here is a place the turret model does not
// apply. Off `TorpedoBayModule.CreateDamageData`, `DamageData.CalculateDamage` and `Behaviour.Unit.Torpedo`,
// transcribed in `the internal notes`.
//
// Takes plain numbers rather than `ShipPools`: `fleetDps` already builds the crit and damage terms and calls in
// here, so depending back on it would make the two modules import each other. It also means every line below is
// testable without a ship.

/** Seconds of a launch cycle that no stat covers: latch 0.5s, fade-in 0.5s, finish 3s. */
export const LAUNCH_OVERHEAD_S = 4;

/** The bay's own cadence and the hull's latch count. Null on a hull with no bay, which is most of them. */
export interface TorpedoBay {
  /** `fireRate`, a PERIOD in seconds despite the name (`nextFireTime = Time.time + fireRate`). */
  fireDelay: number;
  /** `reloadSpeed`, also a period: how long ONE latch takes to re-arm. */
  reloadTime: number;
  /**
   * Latch points on the hull. A property of the SHIP and not of the bay: `SetDoorMechanismAndLatchPoints` walks
   * the PARENT's `DoorMechanism` children, so the same bay on two hulls sustains different rates. 1 when the
   * bridge cannot say, which is the slowest reading and therefore the one that cannot flatter a bay.
   */
  latches: number;
}

/**
 * Sustained launches per second.
 *
 * `min(1/fireRate, latches/reloadSpeed)` is WRONG and was the first reading of this path: it counts neither the
 * `firing` flag, which serializes the whole sequence, nor the fixed waits inside it. The reload runs in PARALLEL
 * with the sequence, per latch, so the binding constraint is whichever of the two is slower:
 *
 *     1 / max(fireDelay + 4 + door, (4 + door + reloadTime) / latches)
 *
 * The door animation is `Door.ToggleDoor` with a per-prefab speed modifier and is not a constant readable off the
 * assembly ∴ omitted, which makes every figure here an UPPER bound on the rate. That direction is deliberate: it
 * cannot make a bay look worse than it is, and a ranking between two bays is what this feeds.
 */
export function launchesPerSecond(bay: TorpedoBay): number {
  const latches = Math.max(1, Math.floor(bay.latches));
  const perLaunch = Math.max(0, bay.fireDelay) + LAUNCH_OVERHEAD_S;
  const perReload = (LAUNCH_OVERHEAD_S + Math.max(0, bay.reloadTime)) / latches;
  const cycle = Math.max(perLaunch, perReload);
  return cycle > 0 ? 1 / cycle : 0;
}

/**
 * The power ONE torpedo carries: `GetStat(TorpedoPower) + GetNormalizedPower(CombatPower)`.
 *
 * The second term is the coupling that makes a bay impossible to score as an independent slot.
 * `GetNormalizedPower(s)` is `GetStat(s) / equivalent turret count`, so fitting another Large turret takes the
 * count 15 to 18 and drops every torpedo's combat term by a sixth. Nothing divides the TorpedoPower pool itself,
 * because a hull carries at most one bay.
 *
 * ⚠ IT RETURNS THE UNDIVIDED POOL WHEN THE COUNT IS 0, which is the game's own behaviour and a trap rather than
 * a convenience: a status read mid-recalculation reports 0 equivalent turrets with guns fitted, and a torpedo
 * figure taken from it is inflated by the whole turret count. `/status`'s `statsDirty` is how a caller knows to
 * wait. Reproduced rather than papered over, so the inflation stays visible instead of being averaged away.
 */
export function torpedoPower(poolTorpedoPower: number, poolCombatPower: number, nEq: number): number {
  return poolTorpedoPower + (nEq > 0 ? poolCombatPower / nEq : poolCombatPower);
}

/**
 * Damage per second from one torpedo bay.
 *
 * `alpha = power / 5` and there is NO fire-rate divisor, which is the difference that matters most:
 * `CalculateDamage` divides by `sourceTurret.defaultAttacksPerSecond` only when a TURRET fired, and a torpedo has
 * no source turret ∴ `power / 5` is the damage of ONE torpedo rather than a per-second figure. For the same
 * reason the crit-damage and damage-boost reads fall to their `sourceUnit` branches: a torpedo is scaled by the
 * SHIP's pooled `CriticalDamage`, `HeatDamage` and `Damage`, and by no gun's aspects.
 *
 * `crit` is the expected crit multiplier and `heatDamage` the pooled Heat bonus: the type is ALWAYS `Heat` and
 * never rolled, so Heat is the only typed damage that reaches a torpedo.
 */
export function torpedoDps(
  bay: TorpedoBay | null | undefined,
  power: number,
  crit: number,
  heatDamage: number,
  allDamage: number,
): number {
  if (!bay) return 0;
  const rate = launchesPerSecond(bay);
  if (rate <= 0 || power <= 0) return 0;
  return (power / 5) * crit * (1 + heatDamage + allDamage) * rate;
}

/**
 * A bay's cadence off an item, or null when the item is not a bay or the bridge did not send its numbers.
 *
 * Null rather than a guess when the numbers are missing: an assumed cadence would price a bay this app cannot
 * actually read, which is the failure the whole slot had before it was priced at all.
 */
export function bayOf(it: Item | null | undefined, latches: number | null | undefined): TorpedoBay | null {
  if (!it || it.torpedoFireDelay == null || it.torpedoReloadTime == null) return null;
  return {
    fireDelay: it.torpedoFireDelay,
    reloadTime: it.torpedoReloadTime,
    // A hull reporting no latch count still has at least one, or the bay it carries could never fire.
    latches: latches != null && latches > 0 ? latches : 1,
  };
}
