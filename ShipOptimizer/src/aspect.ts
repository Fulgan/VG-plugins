import type { Item } from "./types";

// What an aspect is worth, for ranking gear.
//
// The one aspect family whose value can be computed rather than guessed is the extra-damage payload (`Frozen
// Core`, `Punch Through`, `Firestarter`, …), which `PayloadTurretExtraDamage` fires as a SECOND independent hit:
// `GetCopy(damageData.totalDamageAmount * damagePercentage)`, re-typed to the aspect's element. Three consequences:
//
//   1. it scales the parent shot's TOTAL, after crit and after the turret's own typed/generic bonuses, so it is a
//      straight percentage uplift on whatever the host gun does
//   2. it is independent of the host's damage type — an aspect adding cold works as well on a kinetic gun
//   3. the copy is mitigated by the target's resistance to the ASPECT's element, not the weapon's. That is a bonus
//      against a target resistant to your main type, and is NOT modelled: it depends on the target
//
// Everything else (resists, drone-bay capacity, repair rates, …) is not damage and scores 0 rather than being
// invented: a made-up number that ranks gear is worse than an absent one.

export type AspectKind = "extraDamage" | "other";

export interface AspectValue {
  kind: AspectKind;
  // EXPECTED fraction of the host's damage added per hit: magnitude x chance. 0 for `other`, and 0 for an
  // area effect, whose worth depends on how many enemies are nearby — something the optimizer cannot know.
  damageFraction: number;
  // Whether the damage arrives over time. Same total, but it can be lost if the target dies first, so a
  // caller may choose to discount it. (Counted at full value here, by decision.)
  overTime: boolean;
  // Probability the effect fires at all. 1 for the unconditional ones.
  chance: number;
  // Area damage ("nearby enemies") — excluded from the single-target value above.
  area: boolean;
  // Declared stack ceiling, when the description states one. Informational: over the cap the stack COUNTER
  // stops rising but `DamageOverTime.Add` still pools the damage, so it is not a damage cap.
  maxStacks: number | null;
}

const NONE: AspectValue = { kind: "other", damageFraction: 0, overTime: false, chance: 1, area: false, maxStacks: null };

// The game's own description text is the source. It is stable, localised phrasing straight from the aspect
// asset — parsing it beats a hardcoded table that silently rots when the balance changes, and the numbers
// differ per aspect. Every shape that exists in the game today:
//
//   "Deals an additional 10% Cold damage. Hits may slow the target's movement."          flat, instant
//   "Deals an additional 15% Heat damage over 6 seconds."                                flat, DoT
//   "Has a 20% chance on hit to deal an additional 50% Heat damage over 6 seconds.
//    Stacks up to 10 times."                                                             CHANCE-gated DoT
//   "5% chance on hit to trigger a plasma explosion, dealing 200% damage to nearby
//    enemies."                                                                           chance-gated AoE
const EXTRA_DAMAGE = /(?:additional|dealing)\s+([\d.]+)\s*%(?:\s+\w+)?\s+damage/i;
// "Deals 40% BONUS damage to targets above 90% total HP" — a second phrasing, and it cost `Opening Blow` its
// whole value: it states its number and scored 0 because the pattern above wants `additional|dealing` first.
const BONUS_DAMAGE = /([\d.]+)\s*%\s+bonus\s+damage/i;
// A bonus gated on the TARGET'S REMAINING HEALTH pays only while the target is above that mark, so it is worth
// its UPTIME and nothing like its headline. The player's own reading, and it is the right one: a weak target
// dies before the gate closes and the difference never shows; a real one spends a sliver of the fight above 90%
// ∴ ~4% of a fight's damage at the very most, halved again to be safe. 40% x 0.05 = 2%.
//
// Stated here rather than folded into a magic 0.02, so the two halves stay arguable separately: the gate's
// uptime is a judgement, the 40% is read off the prefab (`BossFirstHitPayload.damageMultiplier 1.4`).
const HP_GATED = /above\s+[\d.]+\s*%\s*(?:total\s*)?HP/i;
const HP_GATE_UPTIME = 0.05;
// A leading "N% chance on hit" gates the whole effect, so the expected value is chance x magnitude. Reading
// the magnitude alone credits Hugged By Flames with 50% instead of 10% — five times too much.
const CHANCE = /([\d.]+)\s*%\s*chance/i;
const OVER_TIME = /over\s+[\d.]+\s*seconds?/i;
// "nearby enemies" is area damage: worth a lot in a crowd and nothing against a single target, so it is
// parsed but deliberately kept OUT of the single-target ranking rather than guessed at.
const AREA = /nearby enemies|nearby targets/i;
// Only some effects declare a stack ceiling (`maxStackSize` is per-prefab; 0 = unlimited). Recorded for
// display: over the cap the COUNTER stops but the damage still pools, so it does not reduce the value.
const STACKS = /stacks? up to\s+(\d+)/i;

export function aspectValue(description: string | null | undefined): AspectValue {
  if (!description) return NONE;
  const m = EXTRA_DAMAGE.exec(description) ?? BONUS_DAMAGE.exec(description);
  if (!m) return NONE;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct) || pct <= 0) return NONE;

  const chanceMatch = CHANCE.exec(description);
  const chance = chanceMatch ? Number(chanceMatch[1]) / 100 : 1;
  const area = AREA.test(description);
  const stacksMatch = STACKS.exec(description);

  return {
    kind: "extraDamage",
    // Expected value per hit. Area effects report their magnitude but contribute nothing single-target.
    // Chance and HP-gate uptime both scale the headline, and they compose: an effect that must both roll AND
    // catch the target high is worth the product.
    damageFraction: area ? 0
      : (pct / 100) * (Number.isFinite(chance) ? chance : 1) * (HP_GATED.test(description) ? HP_GATE_UPTIME : 1),
    overTime: OVER_TIME.test(description),
    chance: Number.isFinite(chance) ? chance : 1,
    area,
    maxStacks: stacksMatch ? Number(stacksMatch[1]) : null,
  };
}

// Total damage uplift an item's aspects give, as a fraction of its own output. Additive across aspects:
// each payload fires its own copy off the same parent hit, so two 10% aspects add 20%, and neither
// compounds with the other.
//
// TURRETS ONLY. The payload's `ShouldTrigger` requires `GetComponentInParent<AbstractTurret>()` and that the
// hit came from that same turret, so an extra-damage aspect socketed into a module never fires — counting it
// there would inflate a module's rank for nothing.
export function aspectDamageFraction(it: Item): number {
  if (it.category !== "Turret") return 0;
  return (it.aspects ?? []).reduce((sum, a) => sum + aspectValue(a.description).damageFraction, 0);
}

// The score multiplier for an item: 1 when it has no damage aspects. Applied to the host's damage-ish
// ranking value, which is what makes the aspect worth more on a bigger gun — exactly how the game computes
// it, since the payload takes a cut of the parent shot.
export function aspectMultiplier(it: Item): number {
  return 1 + aspectDamageFraction(it);
}

// The aspects that actually contributed, for showing WHY an item ranked where it did. An unexplained
// number moves a decision without letting the reader check it.
export function damageAspects(it: Item): { name: string; fraction: number; overTime: boolean }[] {
  return (it.aspects ?? [])
    .map((a) => ({ name: a.name, ...aspectValue(a.description) }))
    .filter((a) => a.kind === "extraDamage")
    .map((a) => ({ name: a.name, fraction: a.damageFraction, overTime: a.overTime }));
}
