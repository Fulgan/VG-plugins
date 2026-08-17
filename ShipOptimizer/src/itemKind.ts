import type { Item } from "./types";
import { saturatedMainVal, statTotals } from "./format";
import { reactorModifier } from "./reactor";
import { isRoleStat, statApplies, type ShipFit } from "./roleStats";

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
//   3. EMPTY ASPECT SLOTS — permanent capacity to add one later; a FITTED aspect is already counted by the
//      stats it grants, so counting its slot too would price the same advantage twice
//   4. stats that matter for the SHIP'S ROLE — a mining hull wants mining stats before spare energy
//   5. energy draw, less being better — mild, once no bracket is at stake
//   6. how much else it brings — distinct stat names across `stats`, `substats` and aspect-granted lines
//
// `energy` is the ship's draw EXCLUDING the module being replaced, plus capacity; without it step 2 is skipped.
//
// Quality (the `Q15` on the card) is NOT a step: it boosts `bonusStat`, so it is already in the stat lines and
// scoring it again would count one advantage twice. Nor is any weighted sum of unlike stats — Armor HP and
// Corrosion Resistance share no unit, so a count says "this brings more" without inventing an exchange rate.
/** A draw difference under this much of the reactor budget is noise, not a reason. */
export const DRAW_TIE_FRACTION = 0.01;
/** And this much in absolute terms, for a hull whose budget is not reported at all. */
export const DRAW_TIE_ABS = 100;

/**
 * WHICH STEP decided, beside the ordering it produced — `d > 0` when `a` wins, and `why` the words for the step
 * that separated them (null when nothing did).
 *
 * A rail row that says only "+0" reads as broken when a tie-break put it there, and three separate bugs in one
 * day were invisible for exactly that reason: a silent verdict cannot be checked by the
 * person it is shown to.
 */
export function compareModulesWhy(a: Item, b: Item, energy?: { usedWithout: number; capacity: number },
                                  role?: string | null, fit?: ShipFit | null): { d: number; why: string | null } {
  // Base draw, so a fitted item and a stored one are measured on the same basis (see Item.powerUsageBase).
  const draw = (x: Item) => x.powerUsageBase ?? x.powerUsage ?? 0;
  const bracket = (x: Item) =>
    energy && energy.capacity > 0 ? reactorModifier((energy.usedWithout + draw(x)) / energy.capacity) : 0;
  // How much of a draw difference is worth deciding on. See the draw step below.
  const drawTie = energy && energy.capacity > 0 ? energy.capacity * DRAW_TIE_FRACTION : DRAW_TIE_ABS;
  // Stats this ship can do nothing with are not counted at all: Drone Power with no drone bay, Salvage Power
  // on a hull that neither salvages nor carries a salvage gun. A count of "how much it brings" that includes
  // them ranks a module by rolls the player can never use.
  const names = (x: Item) => new Set([...statTotals(x).keys(), ...(x.substats ?? []).map((l) => l.stat)]
    .filter((n) => statApplies(n, fit ?? { role })));
  // NAMED steps, because the row that shows the verdict has to be able to say which one made it. The words are
  // the PLAYER's reading of the step, kept beside the arithmetic so the two cannot drift apart.
  const steps: { why: string; of: (x: Item) => number }[] = [
    // The headline as a DECISION reads it: clamped where the stat saturates, or a count with nothing behind it
    // (ten tractor beams where five is already everything) wins before any other step is consulted.
    { why: "a bigger main stat", of: (x: Item) => saturatedMainVal(x) ?? 0 },
    { why: "it keeps a better reactor bracket", of: bracket },
    // EMPTY slots, not total: a fitted aspect already counts through the stats it grants, and counting the
    // slot as well ranks a full 2/2 above a full 1/1 for capacity neither of them has.
    { why: "a spare aspect slot", of: (x: Item) => Math.max(0, (x.aspectSlots ?? 0) - (x.aspects ?? []).length) },
    { why: `more stats this ${role ?? "hull"} uses`, of: (x: Item) => (role ? [...names(x)].filter((n) => isRoleStat(role, n)).length : 0) },
    // Distinct stat names from both sources, de-duplicated: `substats` is the bridge's non-main view and may
    // mirror entries in `stats`, so a Set counts "how many different things it gives you" either way.
    { why: "it brings more stat lines", of: (x: Item) => names(x).size },
    // DRAW COUNTS ONLY THROUGH THE BRACKET, per the user ("power draw should only count if it would change the
    // reactor bracket") — and the bracket has its own step second, so by the time control reaches here the two
    // candidates sit in the SAME band and the difference buys nothing the player can feel. It stays as the step
    // of LAST resort, below substance: two modules alike in every other way, and the leaner one wins.
    //
    // Compared any earlier, 26 units of a 22,190 budget outranked +1,220 Precision, +1,335 Hull HP and two
    // aspects — and it did so hardest where the objective is silent, which for a non-combat battery is
    // the normal case: a salvage power figure prices no combat stat at all, so this chain decides everything.
    // Bucketed as well as demoted, so the last resort is not itself decided by noise.
    { why: "it draws less power", of: (x: Item) => -Math.round(draw(x) / drawTie) },
  ];
  for (const step of steps) {
    const d = step.of(a) - step.of(b);
    if (Math.abs(d) > 1e-9) return { d, why: step.why };
  }
  return { d: 0, why: null };
}

/**
 * The comparator's answer as a NUMBER, which is what every ordering caller wants. One line over `compareModulesWhy`
 * so the decision and the explanation of it can never be two implementations (the defect this repo pays for most).
 */
export function compareModules(a: Item, b: Item, energy?: { usedWithout: number; capacity: number },
                               role?: string | null, fit?: ShipFit | null): number {
  return compareModulesWhy(a, b, energy, role, fit).d;
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

/**
 * What a ship can USE, read off the ship rather than assumed from its role.
 *
 * `mslots` names the slots the hull has, so a drone bay is a fact about the fit and not a guess; the turrets
 * fitted say which activities it actually serves, which is what stops "Combat hull" from meaning "your mining
 * laser's rolls are worthless".
 */
export function shipFit(
  role: string | null | undefined,
  mslots: ReadonlyArray<{ slot: string }>,
  turrets: ReadonlyArray<Item>,
): ShipFit {
  return {
    role: role ?? null,
    hasDroneBay: mslots.some((m) => /drone/i.test(m.slot)),
    activities: [...new Set(turrets.map(catOf))],
  };
}

// Never-shown item classes.
export const EXCLUDE_KINDS = ["ammo", "aspect", "deploy", "drone", "defensiveturret"];

// Classify an item as equipment we care about, or null to always exclude it.
//
// By CATEGORY, which is the game's own `ItemCategory` enum (Turret | Module | Booster are the three that are
// equipment; Ore, Ammo, Junk, TradeGoods and the rest are stock). It used to require a non-empty `stats[]` as
// well — "no stats ⇒ ammo/consumable" — and that is false of every COMMON piece of gear: a plain module rolls
// no substats, so a Lv63 Standard tractor beam classified as nothing, never reached the sell list, and
// survived a rule that said to sell it.
export function kindOf(it: Item): "Turret" | "Module" | "Booster" | null {
  const c = (it.category ?? "").toLowerCase();
  const t = (it.type ?? "").toLowerCase();
  if (EXCLUDE_KINDS.some((e) => c.includes(e))) return null;
  if (c === "turret") return "Turret";
  if (c === "booster") return "Booster";
  if (c === "module") return "Module";
  if (c) return null;                 // a category the game named, and it is not equipment
  // No category at all — a bridge too old to send one. Guess from the shape, as this always did.
  if (!it.stats?.length) return null;
  if (t.endsWith("turret")) return "Turret";
  if (t.endsWith("booster")) return "Booster";
  return "Module";
}
