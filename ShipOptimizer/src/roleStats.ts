// Editable per-role key stats. Values are display-name substrings, matched case-insensitively
// against stat names (so "Cargo" matches "Cargo Capacity"). Tweak freely as you learn the exact names.
export const ROLE_STATS: Record<string, string[]> = {
  Combat: ["Combat Power"],
  Mining: ["Mining Power", "Cargo"],
  Salvaging: ["Salvage Power", "Cargo"],
  Cargo: ["Cargo"],
  Generic: [],
};

export function roleStats(role?: string | null): string[] {
  return (role ? ROLE_STATS[role] : undefined) ?? [];
}

export function isRoleStat(role: string | null | undefined, statName: string): boolean {
  const n = statName.toLowerCase();
  return roleStats(role).some((k) => n.includes(k.toLowerCase()));
}

/** What this hull can actually use a stat FOR: its role, what it carries, and what it has fitted. */
export interface ShipFit {
  role?: string | null;
  hasDroneBay?: boolean;
  /** Activities the ship's own turrets serve — a combat hull with a mining laser DOES mine. */
  activities?: ReadonlyArray<string>;
}

/**
 * Does this stat do anything on this ship?
 *
 * Only clearly INERT stats are excluded, and each needs a reason on the ship rather than a taste: Drone Power
 * with no drone bay is a number attached to nothing, and Salvage Power on a hull that neither salvages by role
 * nor carries a salvage gun feeds a pool nothing draws from. Everything else stays — armour is worth something
 * on a gunship, and a comparator that decides otherwise is imposing a playstyle, not reading the ship.
 *
 * Deliberately NOT keyed on role alone: a Combat hull with a mining laser fitted mines, and telling that player
 * their Mining Power roll is worthless would be wrong about the ship in front of them.
 */
export function statApplies(statName: string, fit: ShipFit | null | undefined): boolean {
  if (!fit) return true;
  const n = statName.toLowerCase();
  const serves = (act: string) => (fit.activities ?? []).includes(act);
  if (n.includes("drone")) return fit.hasDroneBay !== false;
  if (n.includes("mining") || n.includes("ore")) return fit.role === "Mining" || serves("Mining");
  if (n.includes("salvage")) return fit.role === "Salvaging" || serves("Salvage");
  return true;
}
