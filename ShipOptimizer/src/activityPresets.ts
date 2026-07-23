// Global "activity profile" → suggested officer-skill priority list. EDITABLE first-pass curation from
// doc/officer-skills.md — tweak the name lists freely (unknown names are simply skipped when composed
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

const KEY = "shipoptimizer.activityProfile";
export function loadProfile(): ActivityProfile {
  try {
    const r = localStorage.getItem(KEY);
    if (r) return { ...DEFAULT_PROFILE, ...JSON.parse(r) };
  } catch { /* ignore */ }
  return { ...DEFAULT_PROFILE };
}
export function saveProfile(p: ActivityProfile) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* quota */ }
}
