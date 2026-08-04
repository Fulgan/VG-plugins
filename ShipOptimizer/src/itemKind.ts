import type { Item } from "./types";
import { effectiveMainVal, statTotals } from "./format";
import { reactorModifier } from "./reactor";
import { isRoleStat } from "./roleStats";

// What KIND of thing an item is, and which activity a turret serves. Shared because both the gear editor and
// the item card need it, and neither should own it — a second copy is how the two drifted apart.
// Which ACTIVITY a turret belongs to. `gameplayType` is the game's own enum on `AbstractTurret`
// (Combat | Mining | Salvage) and is authoritative; the mainStat name is only a fallback for modules and
// for a bridge too old to send it. Deriving this from a display string was the previous behaviour and is
// the wrong source: "Combat Power" is text meant for a human.
export type Activity = "Combat" | "Mining" | "Salvage" | "Other";
export const ACTIVITIES: Activity[] = ["Combat", "Mining", "Salvage"];

export const catOf = (it: Item): Activity => {
  const g = it.gameplayType;
  if (g === "Combat" || g === "Mining" || g === "Salvage") return g;
  const n = it.mainStat?.name ?? "";
  return n.startsWith("Combat") ? "Combat" : n.startsWith("Mining") ? "Mining" : n.startsWith("Salvage") ? "Salvage" : "Other";
};

// The activity a turret serves, for display. Mining and salvage turrets also differ by which layer they
// can hit, and that decides whether a gun is usable at all on a given rock — so it travels with the label.
export const activityLabel = (it: Item): string => {
  const a = catOf(it);
  if (a === "Other") return "";
  return it.targetLayer && a !== "Combat" ? `${a} · ${it.targetLayer}` : a;
};
export const isTurret = (it: Item) => it.category === "Turret";

// Is module `a` better than module `b`? Positive when it is.
//
// Modules have no damage model, so the headline stat is the measure — but headline ties are common (two Tractor
// Beams both reading "7 Tractor Beams"), and a tie has to break on something or a strictly better module produces
// no suggestion at all. In order:
//
//   1. the effective headline (aspect and bonus lines on that stat folded in)
//   2. a change of REACTOR BRACKET, if the two draws land in different ones — it multiplies every power pool, so
//      it outweighs everything below
//   3. ASPECT SLOTS — permanent capacity, and an empty slot beats no slot
//   4. stats that matter for the SHIP'S ROLE — a mining hull wants mining stats before spare energy
//   5. energy draw, less being better — mild, once no bracket is at stake
//   6. how much else it brings — distinct stat names across `stats`, `substats` and aspect-granted lines
//
// `energy` is the ship's draw EXCLUDING the module being replaced, plus capacity; without it step 2 is skipped.
//
// Quality (the `Q15` on the card) is NOT a step: it boosts `bonusStat`, so it is already in the stat lines and
// scoring it again would count one advantage twice. Nor is any weighted sum of unlike stats — Armor HP and
// Corrosion Resistance share no unit, so a count says "this brings more" without inventing an exchange rate.
export function compareModules(a: Item, b: Item, energy?: { usedWithout: number; capacity: number }, role?: string | null): number {
  // Base draw, so a fitted item and a stored one are measured on the same basis (see Item.powerUsageBase).
  const draw = (x: Item) => x.powerUsageBase ?? x.powerUsage ?? 0;
  const bracket = (x: Item) =>
    energy && energy.capacity > 0 ? reactorModifier((energy.usedWithout + draw(x)) / energy.capacity) : 0;
  const names = (x: Item) => new Set([...statTotals(x).keys(), ...(x.substats ?? []).map((l) => l.stat)]);
  const steps = [
    (x: Item) => effectiveMainVal(x) ?? 0,
    bracket,
    (x: Item) => x.aspectSlots ?? 0,
    (x: Item) => (role ? [...names(x)].filter((n) => isRoleStat(role, n)).length : 0),
    (x: Item) => -draw(x),                  // less draw wins
    // Distinct stat names from both sources, de-duplicated: `substats` is the bridge's non-main view and may
    // mirror entries in `stats`, so a Set counts "how many different things it gives you" either way.
    (x: Item) => names(x).size,
  ];
  for (const f of steps) {
    const d = f(a) - f(b);
    if (Math.abs(d) > 1e-9) return d;
  }
  return 0;
}

// What a slot currently holds, by slot key ("t:<index>" hardpoint, "m:<EquipmentSlot>" module). Two copies of
// this existed — one in the gear builder, one in the tab — differing only in whether they tolerated a null key.
export function equippedIn(
  key: string | null | undefined,
  hps: { index: number; equipped: Item | null }[],
  mslots: { slot: string; equipped: Item | null }[],
): Item | null {
  if (!key) return null;
  return key.startsWith("t:")
    ? hps.find((h) => h.index === Number(key.slice(2)))?.equipped ?? null
    : mslots.find((m) => m.slot === key.slice(2))?.equipped ?? null;
}
