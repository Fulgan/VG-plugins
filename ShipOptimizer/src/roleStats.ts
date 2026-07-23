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
