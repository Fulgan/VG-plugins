// Global "activity profile" → suggested officer-skill priority list. EDITABLE first-pass curation from
// The skill<->role table — tweak the name lists freely (unknown names are simply skipped when composed
// against the live skill catalog). The profile is shared across ALL optimizers (officer now; boosters/
// gear later). Skill names must match the game's display names exactly (composed → matched by name).

export type MainActivity = "combat" | "mining" | "salvage" | "crafting";
export type CombatStance = "offence" | "defence";
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
    add(ACTIVITY_SKILLS[p.combatStance === "offence" ? "combat_offence" : "combat_defence"]);
    add(ACTIVITY_SKILLS[p.combatLayer === "shield" ? "combat_shield" : "combat_armor"]);
  } else {
    add(ACTIVITY_SKILLS[p.main]);
  }
  if (p.boarding) add(ACTIVITY_SKILLS.boarding);
  if (p.drone) add(ACTIVITY_SKILLS.drone);
  if (p.echo) add(ACTIVITY_SKILLS.echo);
  return [...new Set(out)];
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
