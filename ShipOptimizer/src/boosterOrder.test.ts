import { describe, it, expect } from "vitest";
import { ANY_TYPE, boosterId, optimizeBoosters, resonanceRank, type BoosterCtx, type ResonanceOrder } from "./booster";
import { migrateOrder } from "./BoostersTab";
import type { Item } from "./types";

// THE PLAYER'S ORDER OVER RESONANCE BONUSES, READ BEFORE THE VALUE — and the refusal that re-picks rather than
// freezing the slot.
//
// Strict priority is the player's own decision, and it is not a weight: rank is compared to rank, so nothing
// here invents an exchange rate between Combat Power and Shield HP. It
// follows that the order CAN hand over a much smaller booster, and that is the asked-for behaviour rather than
// a defect — the tests below pin it in both directions so nobody "fixes" it later.

const boost = (name: string, value: number, bonusStat?: string, location = "armory", type = "Combat Power"): Item => ({
  key: Math.round(value), slot: 0, name, rarity: "Exotic", level: 60, category: "Booster", type: "Booster",
  sellValue: 0, location, mainStat: { name: type, amount: String(value) },
  stats: [], substats: [], aspects: [], bonus: null, bonusStat: null,
  resonance: bonusStat ? { unlocked: true, progress: 100, threshold: 100, unit: "kills", bonusStat } : null,
} as unknown as Item);

// A bare array means "this ranking covers every type", which is what `ANY_TYPE` is — so the cases written before
// the preference was asked per type keep testing the behaviour they were written for.
const ctx = (order: string[] | ResonanceOrder, blacklist: string[] = []): BoosterCtx => ({
  scope: "current", profile: { id: "combat", label: "Combat", activities: [] } as never,
  fit: { role: "Combat", activities: ["Combat"] } as never,
  blacklist: new Set(blacklist), order: Array.isArray(order) ? { [ANY_TYPE]: order } : order,
});

describe("resonance order", () => {
  it("ranks a listed bonus ahead of an unlisted one, and no resonance with the unlisted", () => {
    const c = ctx(["Combat Power", "Reload Speed"]);
    expect(resonanceRank(boost("a", 100, "Combat Power"), c)).toBe(0);
    expect(resonanceRank(boost("b", 100, "Reload Speed"), c)).toBe(1);
    expect(resonanceRank(boost("c", 100, "Shield HP"), c)).toBe(2);   // unlisted → last
    expect(resonanceRank(boost("d", 100), c)).toBe(2);                // no resonance → same place
  });

  it("ties everything when no order is stated, so the score decides exactly as before", () => {
    const c = ctx([]);
    expect(resonanceRank(boost("a", 100, "Combat Power"), c)).toBe(0);
    expect(resonanceRank(boost("b", 100), c)).toBe(0);
  });

  it("sends a BLACKLISTED bonus to the back even when the order lists it first", () => {
    // The two controls answer one question; a bonus this ship is told not to chase cannot also be its
    // first preference, and the narrower statement wins.
    const c = ctx(["Combat Power"], ["Combat Power"]);
    expect(resonanceRank(boost("a", 100, "Combat Power"), c)).toBe(1);
  });

  it("picks the ranked booster over a much bigger unranked one — the asked-for trade", () => {
    const pool = [boost("big", 5_000, "Shield HP"), boost("small", 300, "Combat Power")];
    const { picks } = optimizeBoosters(pool, ["Combat Power"], undefined, ctx(["Combat Power", "Shield HP"]));
    expect(picks[0].chosen?.name).toBe("small");
  });

  it("falls back to value inside one rank", () => {
    const pool = [boost("lesser", 300, "Combat Power"), boost("greater", 5_000, "Combat Power")];
    const { picks } = optimizeBoosters(pool, ["Combat Power"], undefined, ctx(["Combat Power"]));
    expect(picks[0].chosen?.name).toBe("greater");
  });

  it("leaves the old behaviour exactly in place with no order", () => {
    const pool = [boost("big", 5_000, "Shield HP"), boost("small", 300, "Combat Power")];
    const { picks } = optimizeBoosters(pool, ["Combat Power"], undefined, ctx([]));
    expect(picks[0].chosen?.name).toBe("big");
  });
});

// THE ORDER IS PER BOOSTER TYPE, because the bonus pools overlap without partitioning: Drone Power is rollable
// on a Combat, Drone, Mining or Salvage booster. One list over all types cannot say "Drone Power first on a
// combat booster, last on a mining one" — ranking the stat once answers for every type that carries it.
describe("resonance order, per booster type", () => {
  it("ranks the SAME stat differently on two types", () => {
    const c = ctx({ "Combat Power": ["Drone Power"], "Mining Power": ["Resource Yield"] });
    expect(resonanceRank(boost("a", 100, "Drone Power", "armory", "Combat Power"), c)).toBe(0);
    // Same bonus, different booster type, and it is unranked there — the whole point of the split.
    expect(resonanceRank(boost("b", 100, "Drone Power", "armory", "Mining Power"), c)).toBe(1);
  });

  it("gives each type its own last place, so two lists of different lengths do not distort each other", () => {
    const c = ctx({ "Combat Power": ["Critical Chance", "Reload Speed", "Drone Power"], "Mining Power": ["Ore Upgrade Chance"] });
    expect(resonanceRank(boost("a", 100, "Shield HP", "armory", "Combat Power"), c)).toBe(3);
    expect(resonanceRank(boost("b", 100, "Shield HP", "armory", "Mining Power"), c)).toBe(1);
  });

  it("falls back to the ANY_TYPE list for a type with none of its own", () => {
    const c = ctx({ [ANY_TYPE]: ["Drone Power"], "Combat Power": ["Reload Speed"] });
    expect(resonanceRank(boost("a", 100, "Drone Power", "armory", "Salvage Power"), c)).toBe(0);
    // Combat Power has its own list, so the fallback does not reach it: Drone Power is unranked there.
    expect(resonanceRank(boost("b", 100, "Drone Power", "armory", "Combat Power"), c)).toBe(1);
  });

  it("lets an EMPTY list for a type override the fallback — cleared is an answer, not a gap", () => {
    const c = ctx({ [ANY_TYPE]: ["Drone Power"], "Combat Power": [] });
    expect(resonanceRank(boost("a", 100, "Drone Power", "armory", "Combat Power"), c)).toBe(0); // every candidate ties
    expect(resonanceRank(boost("b", 100, "Shield HP", "armory", "Combat Power"), c)).toBe(0);
  });

  it("fills two slots of different types from their OWN orders", () => {
    // One pool, two types, and the ranking hands each slot a different answer — a flat list could not.
    const pool = [
      boost("combat-big", 5_000, "Reload Speed", "armory", "Combat Power"),
      boost("combat-small", 300, "Drone Power", "armory", "Combat Power"),
      boost("mining-big", 5_000, "Drone Power", "armory", "Mining Power"),
      boost("mining-small", 300, "Resource Yield", "armory", "Mining Power"),
    ];
    const c = ctx({ "Combat Power": ["Drone Power"], "Mining Power": ["Resource Yield"] });
    const { picks } = optimizeBoosters(pool, ["Combat Power", "Mining Power"], undefined, c);
    expect(picks[0].chosen?.name).toBe("combat-small");   // Drone Power ranked on combat boosters
    expect(picks[1].chosen?.name).toBe("mining-small");   // and NOT on mining ones, where Resource Yield is
  });

  it("migrates a stored flat list onto ANY_TYPE, so a stated preference survives the shape change", () => {
    const migrated = migrateOrder({ "ship-1": ["Combat Power", "Reload Speed"] });
    expect(migrated["ship-1"]).toEqual({ [ANY_TYPE]: ["Combat Power", "Reload Speed"] });
    // It still acts on every type, which is what the player said when there was only one list.
    const c = ctx(migrated["ship-1"]);
    expect(resonanceRank(boost("a", 100, "Combat Power", "armory", "Salvage Power"), c)).toBe(0);
  });

  it("leaves an already-per-type stored order alone", () => {
    const stored = { "ship-1": { "Combat Power": ["Drone Power"] } };
    expect(migrateOrder(stored)["ship-1"]).toEqual({ "Combat Power": ["Drone Power"] });
  });
});

describe("refusing a suggestion", () => {
  it("re-picks the next best rather than emptying the slot", () => {
    const pool = [boost("first", 5_000), boost("second", 4_000)];
    const refused = new Set([boosterId(pool[0])]);
    const { picks } = optimizeBoosters(pool, ["Combat Power"], undefined, ctx([]), refused);
    expect(picks[0].chosen?.name).toBe("second");
  });

  it("leaves the slot empty only when nothing else is owned — a refusal is not a lock", () => {
    const pool = [boost("only", 5_000)];
    const { picks } = optimizeBoosters(pool, ["Combat Power"], undefined, ctx([]), new Set([boosterId(pool[0])]));
    expect(picks[0].chosen).toBeNull();
  });

  it("refuses the EQUIPPED booster too, so a slot can be told to move on", () => {
    const eq = boost("fitted", 5_000, undefined, "equipped");
    const pool = [eq, boost("other", 1_000)];
    const { picks } = optimizeBoosters(pool, ["Combat Power"], undefined, ctx([]), new Set([boosterId(eq)]));
    expect(picks[0].chosen?.name).toBe("other");
  });

  it("puts a PINNED booster in the slot the player chose, whatever the score says", () => {
    // Choosing a booster is an answer already given, not a preference to weigh — so it is placed before
    // anything is scored, and it sets the slot's type too (choosing the booster is the more specific statement).
    const pool = [boost("best", 9_000), boost("wanted", 100, "Shield HP")];
    const pins = new Map([[1, boosterId(pool[1])]]);
    const { picks } = optimizeBoosters(pool, ["Combat Power", "Combat Power"], undefined, ctx([]), undefined, pins);
    expect(picks[1].chosen?.name).toBe("wanted");
    expect(picks[0].chosen?.name).toBe("best");     // the other slot is still optimized
  });

  it("does not let one booster fill two slots when pinned", () => {
    const pool = [boost("only", 5_000)];
    const pins = new Map([[0, boosterId(pool[0])]]);
    const { picks } = optimizeBoosters(pool, ["Combat Power", "Combat Power"], undefined, ctx([]), undefined, pins);
    expect(picks[0].chosen?.name).toBe("only");
    expect(picks[1].chosen).toBeNull();
  });

  it("LOCKS a slot to what is fitted, and nothing else may take that booster", () => {
    // A lock is about the SLOT — "this one is fine, stop offering" — where a pin names an item and a refusal
    // rejects a candidate. It must also hold its booster: a lock that let another slot steal the very booster
    // it was protecting would be no lock at all.
    const fitted = { ...boost("fitted", 1_000, undefined, "equipped"), slot: 0 } as Item;
    const better = boost("better", 9_000);
    const { picks } = optimizeBoosters([fitted, better], ["Combat Power", "Combat Power"],
                                       undefined, ctx([]), undefined, undefined, new Set([0]));
    expect(picks[0].chosen?.name).toBe("fitted");     // not upgraded
    expect(picks[1].chosen?.name).toBe("better");     // the other slot still optimizes
  });

  it("leaves an EMPTY locked slot empty rather than filling it", () => {
    const { picks } = optimizeBoosters([boost("spare", 5_000)], ["Combat Power"],
                                       undefined, ctx([]), undefined, undefined, new Set([0]));
    expect(picks[0].chosen).toBeNull();
  });

  it("does nothing when the refused id matches nothing owned", () => {
    const pool = [boost("first", 5_000)];
    const { picks } = optimizeBoosters(pool, ["Combat Power"], undefined, ctx([]), new Set(["armory:99:ghost:60"]));
    expect(picks[0].chosen?.name).toBe("first");
  });
});
