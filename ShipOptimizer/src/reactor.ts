// Reactor energy brackets — `ReactorModule.energyThresholdModifiers`.
//
// Energy usage is not a comfort stat: the bracket it lands in multiplies the ship's Power, CombatPower,
// MiningPower and SalvagePower pools. Fitting a bigger gun can therefore LOWER total damage, by pushing usage
// past a threshold and docking every gun's power. That makes the bracket the thing to watch when swapping
// gear, and the reason the gear panel shows projected usage next to current.
//
// Thresholds are inclusive upper bounds (`usage <= key`), so exactly 50% still earns the +20%.
export const REACTOR_BRACKETS: { upTo: number; mod: number }[] = [
  { upTo: 0.5, mod: 0.2 },
  { upTo: 0.75, mod: 0.1 },
  { upTo: 1, mod: 0 },
  { upTo: 1.25, mod: -0.25 },
  { upTo: 1.5, mod: -0.5 },
  { upTo: Infinity, mod: -0.75 },
];

// The factor a power pool is actually multiplied by, which is NOT the same for all of them.
// `AbstractUnit.ApplyReactorModifier` singles out CombatPower (stat index 21):
//
//     if (index == 21 && reactorModule.GetEnergyUsage(cap) <= 0.5f)
//         statMultipliers[index] *= num + SkilltreeNode.combatReactorOutputCP.currentIncrease;
//     else statMultipliers[index] *= num;                       // num = 1 + energyBonusOrPenalty
//
// so the combat pool carries a SKILL TREE term the other pools do not, and only inside the top bracket —
// whose bound is `usage <= 0.5`, exactly the condition the game tests. Mining and salvage pass `skillBonus`
// 0 and get the plain bracket.
export function poolReactorFactor(usage: number, skillBonus = 0): number {
  const top = REACTOR_BRACKETS[0];
  return 1 + reactorModifier(usage) + (skillBonus > 0 && usage <= top.upTo ? skillBonus : 0);
}

// The power modifier for a usage fraction (0.42 = 42% of capacity drawn).
export function reactorModifier(usage: number): number {
  for (const b of REACTOR_BRACKETS) if (usage <= b.upTo) return b.mod;
  return 0;
}

// How far into the current bracket, and what's next — so the UI can warn before a swap crosses a line rather
// than only reporting it afterwards. `nextAt` is the usage at which the modifier changes for the worse;
// null in the last bracket, where nothing worse remains.
export function reactorBracket(usage: number): { mod: number; nextAt: number | null; nextMod: number | null } {
  const i = REACTOR_BRACKETS.findIndex((b) => usage <= b.upTo);
  const at = i < 0 ? REACTOR_BRACKETS.length - 1 : i;
  const next = REACTOR_BRACKETS[at + 1];
  return {
    mod: REACTOR_BRACKETS[at].mod,
    nextAt: next ? REACTOR_BRACKETS[at].upTo : null,
    nextMod: next ? next.mod : null,
  };
}

// Total energy a set of equipped items draws. `powerUsage` is the item's effective draw (aspects included),
// which is what the reactor sums over its connected equipment.
export const energyDraw = (items: { powerUsage?: number | null }[]): number =>
  items.reduce((sum, it) => sum + (it.powerUsage ?? 0), 0);

// Re-scale a pooled power figure from the bracket it was MEASURED under to the one a build would land in.
// `/status` pools already have the current modifier baked in (the game applies it as a stat multiplier), so a
// projection has to divide the old one out before applying the new — otherwise it compounds.
export function repowered(pool: number, fromMod: number, toMod: number): number {
  const from = 1 + fromMod;
  return from === 0 ? pool : (pool / from) * (1 + toMod);
}
