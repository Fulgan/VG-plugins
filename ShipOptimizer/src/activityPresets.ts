// Global "activity profile" → suggested officer-skill priority list. EDITABLE first-pass curation from
// The skill<->role table — tweak the name lists freely (unknown names are simply skipped when composed
// against the live skill catalog). The profile is shared across ALL optimizers (officer now; boosters/
// gear later). Skill names must match the game's display names exactly (composed → matched by name).

export type MainActivity = "combat" | "mining" | "salvage" | "crafting";
/**
 * HOW MUCH DEFENCE, not whether. `offence` and `defence` were the only two answers, and a crew is no more a
 * binary choice than a build is: the gear tab already refuses to ask "how much is a point of armour worth" and
 * shows the trade instead. The middle values are what a player actually flies.
 *
 * Named steps rather than a number, for two reasons: they read in stored settings, and five of them is already
 * finer than the underlying lists can honestly express. The two ends keep their old names, so a profile saved
 * before this existed still loads.
 */
export type CombatStance = "offence" | "mostly-offence" | "balanced" | "mostly-defence" | "defence";

/** How much of the order goes to defence, 0 = all offence. */
export const STANCE_WEIGHT: Record<CombatStance, number> = {
  "offence": 0, "mostly-offence": 0.25, "balanced": 0.5, "mostly-defence": 0.75, "defence": 1,
};

export const STANCE_ORDER: CombatStance[] = ["offence", "mostly-offence", "balanced", "mostly-defence", "defence"];

/** Short labels for the five steps, in `STANCE_ORDER`. */
export const STANCE_LABEL: Record<CombatStance, string> = {
  "offence": "off", "mostly-offence": "off+", "balanced": "even", "mostly-defence": "def+", "defence": "def",
};

/**
 * Merge two ordered lists so that `weight` of the result comes from the first one.
 *
 * Used for both halves of the same question: composing a suggested order, and reordering one that already
 * exists. A ratio is the honest form of "something in between" here, because what a stance can actually change
 * is HOW SOON a defensive skill is taken, not how much any single skill is worth.
 */
export function mergeByWeight<T>(favoured: T[], rest: T[], weight: number): T[] {
  // ⚠ THIS IS A PRIORITY ORDER, ⊥ A FILTER, and the ends are not exceptions: weight 0 yields `[...rest, ...favoured]`
  // and weight 1 yields `[...favoured, ...rest]`. Every skill survives at every weight and the STANCE decides who
  // is asked first — `composeActivity` returns a ranked list and the optimizer takes the top ones per seat, so
  // dropping the other half would remove answers rather than deprioritise them. Truncating at the ends was tried
  // and reverted: `activityPresets.test.ts` pins both properties, and it is the membership one that is easy to
  // mistake for a bug when a `def` profile lists seventeen skills.
  const out: T[] = [];
  let fi = 0, ri = 0;
  while (fi < favoured.length || ri < rest.length) {
    if (ri >= rest.length) { out.push(favoured[fi++]); continue; }
    if (fi >= favoured.length) { out.push(rest[ri++]); continue; }
    // Take from the favoured list while it is under its share of what has been emitted so far.
    if (fi < weight * (out.length + 1)) out.push(favoured[fi++]);
    else out.push(rest[ri++]);
  }
  return out;
}
export type CombatLayer = "shield" | "armor";

export interface ActivityProfile {
  main: MainActivity;
  combatStance: CombatStance; // only meaningful when main === "combat"
  combatLayer: CombatLayer;
  echo: boolean; // ECHO (autopilot) automation
  drone: boolean; // drone carrier (drone skills also gate on hasDroneBay in the optimizer)
  boarding: boolean;
}

export const DEFAULT_PROFILE: ActivityProfile = {
  main: "combat", combatStance: "offence", combatLayer: "shield", echo: false, drone: false, boarding: false,
};

// Ordered skill NAMES per activity/flag. Highest priority first within each group.
export const ACTIVITY_SKILLS: Record<string, string[]> = {
  combat_offence: ["Fire Control Officer", "Targeting Specialist", "Veteran's Might", "Precise Targeting", "Rapid Assault", "Target Weak Spots", "Warpath", "Weapons Free", "Redline", "Iron Rage", "Instant Reload", "Critical Recursion"],
  combat_defence: ["Reactor Technician", "Overwhelming Resolve", "Iron Rage", "Veteran's Might"],
  combat_shield: ["Shield Boost", "Shield Leech"],
  combat_armor: ["Armor Plating", "Armor Leech", "Armor Repair Bot"],
  mining: ["Efficient Miner", "Harvester", "Miner's Edge", "Field Focus", "Fault Line", "Resource Maximizer", "Loadmaster", "Lode Sense", "Range Amplifier"],
  salvage: ["Scavenger", "Harvester", "Enhanced Beams", "Strip Focus", "Clean Sweep", "Precision Scraping", "Loadmaster", "Sharp Eye"],
  crafting: ["Faster Production II", "Faster Production I", "Hidden Crystals", "Smart Extraction", "Equipment Bonus", "Resource Maximizer", "Loadmaster"],
  echo: ["System Optimizer", "Sustained Operator", "Experience Penalty Reducer", "ECHO The Conqueror"],
  drone: ["Drone Handler", "Drone", "Optimized Drone Tools", "Power Tools", "Drone Agility", "Quick Rebuild", "Rapid Deployment", "Composite Drone Armor"],
  boarding: ["Assault Doctrine", "Shock Assault", "Extended Brig", "Crew Conditioning"],
};

// Compose the profile into an ordered, de-duplicated list of skill NAMES (main activity first, then
// additive flags). The caller maps names → live catalog skill ids.
export function composeActivity(p: ActivityProfile): string[] {
  const out: string[] = [];
  const add = (arr?: string[]) => arr?.forEach((n) => out.push(n));
  if (p.main === "combat") {
    // The stance MIXES the two lists rather than choosing one of them. At either end this is exactly what the
    // old two-way switch produced, so nothing regressed for a player who wants one or the other.
    const w = STANCE_WEIGHT[p.combatStance] ?? 0;
    const def = [
      ...(ACTIVITY_SKILLS.combat_defence ?? []),
      ...(ACTIVITY_SKILLS[p.combatLayer === "shield" ? "combat_shield" : "combat_armor"] ?? []),
    ];
    add(mergeByWeight(def, ACTIVITY_SKILLS.combat_offence ?? [], w));
  } else {
    add(ACTIVITY_SKILLS[p.main]);
  }
  if (p.boarding) add(ACTIVITY_SKILLS.boarding);
  if (p.drone) add(ACTIVITY_SKILLS.drone);
  if (p.echo) add(ACTIVITY_SKILLS.echo);
  return [...new Set(out)];
}

/**
 * The skills this profile counts as DEFENSIVE, in preset order.
 *
 * `Sort by value` prices skills through the damage model, which has no defensive stats in it at all: an Armor
 * HP node is not worth "less" there, it is worth NOTHING KNOWN, and it lands at the end with everything else the
 * model cannot price. That is the right answer for an offence profile and the wrong one for a player who just
 * said `def`, so the ordering asks this instead of inventing a number for armour.
 *
 * Read off the same table the suggestions come from, rather than a second list or a guess at the effect text:
 * one definition of "defensive" per profile, and it is the one the presets already use.
 */
export function defensiveSkillNames(p: ActivityProfile): string[] {
  if (p.main !== "combat") return [];
  return [
    ...(ACTIVITY_SKILLS.combat_defence ?? []),
    ...(ACTIVITY_SKILLS[p.combatLayer === "shield" ? "combat_shield" : "combat_armor"] ?? []),
  ];
}

// Map a ship's role (Combat | Mining | Salvaging | Cargo | Generic) to a suggestion main activity.
export function roleToActivity(role: string | null | undefined): MainActivity {
  switch (role) {
    case "Combat": return "combat";
    case "Mining": return "mining";
    case "Salvaging": return "salvage";
    default: return "combat"; // Cargo / Generic / unknown → combat (the neutral default)
  }
}

/**
 * WHICH LAYER THIS HULL TANKS ON, read from the slots it CARRIES rather than from what is fitted in them.
 *
 * Structural on purpose: a gear swap cannot move it, and the gear search cannot wander a ship into being neither
 * an armor nor a shield ship. Armor wins if a hull somehow carries both.
 *
 * ONE OWNER, because two consumers now ask it — the officer objective, which picks the skill list, and the gear
 * frontier, whose whole tank axis IS this layer. A second copy of the expression is how they come to
 * disagree about what a ship is for.
 */
export function defenseLayerOf(slotTypes: ReadonlyArray<string> | null | undefined): CombatLayer | null {
  if (!slotTypes) return null;
  const has = (t: string) => slotTypes.some((s) => s === t);
  return has("Armor") ? "armor" : has("ShieldGenerator") ? "shield" : null;
}

// Per-ship default suggestion profile: main activity from the ship role, combat layer from the ship's
// defensive module slot (armor preferred if it somehow carries both). Other flags off. Used until the
// user edits the profile for that ship.
export function defaultProfileForShip(role: string | null | undefined, defenseLayer: "shield" | "armor" | null): ActivityProfile {
  return { ...DEFAULT_PROFILE, main: roleToActivity(role), combatLayer: defenseLayer ?? DEFAULT_PROFILE.combatLayer };
}


/**
 * What a resonant booster's unlock requirement needs from the player, expressed in the vocabulary this module
 * already owns. Extending the role→activity map rather than writing a second one beside it: the two answer the
 * same question ("what does this ship do") and a second copy is how they come to disagree.
 *
 * The bridge sends the requirement as `resonance.unit`. `profit` and `absorbed` are deliberately absent: the
 * progress bus is global to the PLAYER, and selling above cost or having damage mitigated happens however you
 * play, so they are reachable on any hull. The other four need the ship to do the thing.
 */
export const UNIT_NEEDS: Record<string, MainActivity | "boarding"> = {
  kills: "combat",
  boardings: "boarding",
  ore: "mining",
  scrap: "salvage",
};

/**
 * Can this ship, played this way, ever finish that resonance?
 *
 * `activities` is what the hull's own turrets serve, so a Combat hull carrying a mining laser DOES mine — the
 * same reading `roleStats.statApplies` takes, and for the same reason: telling a player their booster is
 * worthless because of the ship's ROLE would be wrong about the ship in front of them.
 *
 * Unknown units return TRUE. A requirement this build has not seen is not evidence that it cannot be met, and
 * refusing to credit it would silently rank a booster below one whose unit we happen to recognise.
 */
export function unitReachable(
  unit: string | null | undefined,
  profile: ActivityProfile,
  activities: ReadonlyArray<string> | undefined,
): boolean {
  if (!unit) return false;                      // no requirement stated ∴ nothing to reach
  const needs = UNIT_NEEDS[unit];
  if (!needs) return true;
  if (needs === "boarding") return profile.boarding;
  const serves = (act: string) => (activities ?? []).includes(act);
  switch (needs) {
    case "combat": return profile.main === "combat" || serves("Combat");
    case "mining": return profile.main === "mining" || serves("Mining");
    case "salvage": return profile.main === "salvage" || serves("Salvage");
    default: return true;
  }
}
