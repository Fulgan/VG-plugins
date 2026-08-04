import { describe, it, expect } from "vitest";
import { background, contributionOf, coversLayers, optimizeTurretSet, poolsFromStatus, poolsReconcile, rankGt, rating, setPower, setPowerByLayer, setRank, type ShipPools } from "./fleetDps";
import { rankValue } from "./GearTab";
import { turretFits, parseActivity } from "./gearFit";
import { catOf } from "./itemKind";
import { effectiveMainVal } from "./format";
import type { Item, ShipLayout, Status } from "./types";

// The whole client model run against a real bridge capture, so the objective is exercised on gear that
// actually exists rather than on fixtures shaped to suit it. See ../fixtures/README.md for what was captured
// and, importantly, what the capture cannot show.
//
// These assert SHAPE and ORDERING, never absolute magnitudes: the numbers move with the save.
// Loaded through Vite's glob rather than node's fs: `tsconfig.app.json` carries only `vite/client` types, and
// pulling `node:fs` in for one test would put node's globals on the whole app project. The values stay `unknown`,
// which also spares tsc inferring a type for three megabytes of JSON literal.
const FIXTURES = import.meta.glob("../fixtures/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const read = <T,>(name: string): T => {
  const hit = Object.entries(FIXTURES).find(([p]) => p.endsWith(`/${name}`));
  if (!hit) throw new Error(`fixture ${name} not found — captured files live in ShipOptimizer/fixtures`);
  return hit[1] as T;
};

const status = read<Status>("status.json");
const layout = read<ShipLayout>("ship-layout.json");
const owned: Item[] = read<{ stores: { items: Item[] }[] }>("inventories.json")
  .stores.flatMap((s) => s.items ?? []);

const equipped = layout.hardpoints.map((h) => h.equipped).filter((x): x is Item => !!x);
const ownedOf = (act: string, size: string) =>
  owned.filter((i) => i.category === "Turret" && catOf(i) === act && i.size === size);
const ALL = { mode: "all" } as const;
const CRIT = { chance: 0.47, damage: 0.35, megaCrit: 3 };

describe("bridge capture: the ship and its gear", () => {
  it("is the docked six-hardpoint battery the spec measured", () => {
    expect(status.docked).toBe(true);
    expect(layout.hardpoints).toHaveLength(6);
    expect(equipped).toHaveLength(6);
    // 3 Medium (2) + 3 Large (3) = 15, the sum the game reports.
    expect(status.equivalentTurrets).toBe(15);
  });

  it("owns turrets of all three activities", () => {
    for (const act of ["Combat", "Mining", "Salvage"])
      expect(owned.filter((i) => i.category === "Turret" && catOf(i) === act).length).toBeGreaterThan(0);
  });

  it("carries a zero-draw gun, which is what makes the bracket matter", () => {
    expect(equipped.some((i) => (i.powerUsage ?? 0) === 0)).toBe(true);
    expect((status.energyUsed as number) / (status.energyCapacity as number)).toBeLessThan(0.5);
  });
});

describe("bridge capture: combat objective", () => {
  const pools = poolsFromStatus(status) as ShipPools;

  it("resolves /status into a usable model", () => {
    expect(pools).not.toBeNull();
    expect(pools.poolCombatPower).toBeGreaterThan(0);
    expect(pools.energy?.capacity).toBeGreaterThan(0);
  });

  it("scores the fitted battery in the combat tier", () => {
    const [tier, value] = setRank(equipped, background(pools, equipped));
    expect(tier).toBe(2);
    expect(value).toBeGreaterThan(0);
  });

  it("keeps the fitted battery when the whole armory is on offer (never regresses)", () => {
    const bg = background(pools, equipped);
    const slots = layout.hardpoints.map((h) => ({
      key: `t:${h.index}`,
      current: h.equipped,
      candidates: [
        ...(h.equipped ? [h.equipped] : []),
        ...owned.filter((g) => turretFits(g, h.size, ALL, {})),
      ],
    }));
    const chosen = optimizeTurretSet(slots, bg, 4, []);
    // Monotone from the fitted seed: whatever it proposes, the result cannot be worse than what is flown.
    expect(rankGt(setRank(equipped, bg), setRank([...chosen.values()], bg))).toBe(false);
  });
});

// An older bridge, derived by stripping the four newest status fields off the real capture rather than kept as a second
// file — the point is what the client does when they are ABSENT, and deriving it means the rest of the payload
// stays the same real ship.
describe("bridge capture: older bridge degrades, it does not lie", () => {
  const older = { ...status };
  delete older.poolMiningPower; delete older.poolSalvagePower;
  delete older.equivalentTurretsMining; delete older.equivalentTurretsSalvage;
  const pools = poolsFromStatus(older) as ShipPools;

  it("sends no per-activity pool", () => {
    expect(pools.poolMiningPower).toBeUndefined();
    expect(pools.poolSalvagePower).toBeUndefined();
  });

  it("scores a real mining battery as [1, 0] rather than ranking it wrongly", () => {
    const miners = ownedOf("Mining", "Large").slice(0, 3);
    expect(miners.length).toBe(3);
    expect(setRank(miners, background(pools, equipped))).toEqual([1, 0]);
  });

  // The guarantee that matters when every candidate ties: it must not send the player to the hangar to swap
  // one mining gun for another it cannot actually distinguish.
  it("keeps a fitted mining gun rather than swapping blind", () => {
    const bg = background(pools, equipped);
    const miners = ownedOf("Mining", "Large");
    const fitted = miners[0];
    const chosen = optimizeTurretSet([{ key: "t:3", current: fitted, candidates: miners }], bg, 4, []);
    expect(chosen.get("t:3")).toBe(fitted);
  });

  // An EMPTY hardpoint is the one case where a tied candidate still wins: tier 1 beats tier 0, because a gun
  // in a vacant slot beats no gun even when the model cannot say which gun.
  it("still fills an empty hardpoint", () => {
    const bg = background(pools, equipped);
    const miners = ownedOf("Mining", "Large");
    const chosen = optimizeTurretSet([{ key: "t:3", current: null, candidates: miners }], bg, 4, []);
    expect(miners).toContain(chosen.get("t:3"));
  });
});

// The real per-activity pools, live off the restarted bridge.
//
// `equivalentTurretsMining` and `-Salvage` both read 0 here, and that is the honest reading: the ship flies no
// mining or salvage gun, so no turret shares those pools. It exercises `setPower`'s fallback — the divisor comes
// from the candidate set's own size ratings — which is the case that matters in practice, since planning a mining
// refit starts from a ship that has none.
describe("bridge capture: per-activity objective (T37)", () => {
  const pools = poolsFromStatus(status) as ShipPools;
  const bg = background(pools, equipped);

  it("carries both pools, with a per-stat divisor of zero for unflown activities", () => {
    expect(pools.poolMiningPower).toBeGreaterThan(0);
    expect(pools.poolSalvagePower).toBeGreaterThan(0);
    expect(pools.equivalentTurretsMining).toBe(0);
    expect(pools.equivalentTurretsSalvage).toBe(0);
  });

  // Every Large mining gun this save owns is Surface, which is what makes it a good layer test: the pool
  // plumbing has to score it, and `balanced` has to refuse it, and those are different questions.
  it("scores a real mining battery above zero against the layer it can actually reach", () => {
    const miners = ownedOf("Mining", "Large").slice(0, 3);
    expect(miners.every((m) => m.targetLayer === "Surface")).toBe(true);
    const [tier, value] = setRank(miners, bg, "surface");
    expect(tier).toBe(1);
    expect(value).toBeGreaterThan(0);
  });

  it("refuses that same all-Surface battery under `balanced` — it cannot touch core ore", () => {
    const miners = ownedOf("Mining", "Large").slice(0, 3);
    expect(setRank(miners, bg, "balanced")).toEqual([1, 0]);
    expect(coversLayers(miners, "Mining", "balanced")).toBe(false);
    expect(coversLayers(miners, "Mining", "surface")).toBe(true);
  });

  // The fixture owns 3 Core + 1 Surface Large salvage guns, so a battery that CAN finish a wreck is buildable.
  it("scores a mixed salvage battery above zero, and below its own summed figure", () => {
    const sv = ownedOf("Salvage", "Large");
    const surface = sv.find((i) => i.targetLayer === "Surface");
    const core = sv.find((i) => i.targetLayer === "Core");
    expect(surface && core).toBeTruthy();
    const mixed = [surface!, core!];
    const balanced = setRank(mixed, bg, "balanced")[1];
    expect(balanced).toBeGreaterThan(0);
    expect(coversLayers(mixed, "Salvage", "balanced")).toBe(true);
    // Harmonic, not summed: the whole point is that it cannot be gamed by piling on one layer.
    expect(balanced).toBeLessThan(setPower(mixed, bg, "Salvage"));
  });

  it("prefers the stronger of two real mining guns", () => {
    const val = (i: Item) => Number(String(i.mainStat?.amount ?? "0").replace(/[^0-9.]/g, ""));
    const miners = [...ownedOf("Mining", "Large")].sort((a, b) => val(b) - val(a));
    const [strong, weak] = [miners[0], miners[miners.length - 1]];
    expect(val(strong)).toBeGreaterThan(val(weak));
    // Every Large mining gun here is Surface, and the objective is STRICT — `balanced` scores a single-layer
    // battery 0 and could not tell these two apart. A real caller degrades the target when the stock cannot cover
    // both layers (GearTab's layerPlan), so the comparison is asked on the scale that exists.
    const chosen = optimizeTurretSet([{ key: "t:3", current: weak, candidates: [weak, strong] }], bg, 4, [], "surface");
    expect(chosen.get("t:3")).toBe(strong);
  });

  it("ranks a real combat gun above a real mining gun in the same slot", () => {
    const gun = ownedOf("Combat", "Large")[0];
    const miner = ownedOf("Mining", "Large")[0];
    const chosen = optimizeTurretSet([{ key: "t:3", current: null, candidates: [miner, gun] }], bg, 4, []);
    // By TIER, whatever the two headline numbers happen to be.
    expect(chosen.get("t:3")).toBe(gun);
  });

  // Each activity reads its OWN pool. Asserted as a difference rather than an ordering, because which of the two
  // is larger is a property of this save, not of the model.
  it("scores salvage off the salvage pool, not the mining one", () => {
    const salvage = ownedOf("Salvage", "Large").slice(0, 1);
    const mining = ownedOf("Mining", "Large").slice(0, 1);
    expect(salvage.length).toBe(1);
    // Single-layer targets, for the same reason as above: one gun cannot satisfy `balanced`.
    const s = setRank(salvage, bg, salvage[0].targetLayer === "Core" ? "core" : "surface");
    const m = setRank(mining, bg, mining[0].targetLayer === "Core" ? "core" : "surface");
    expect(s[0]).toBe(1);
    expect(m[0]).toBe(1);
    expect(s[1]).toBeGreaterThan(0);
    expect(s[1]).not.toBeCloseTo(m[1]);
    // And the pools they read differ, which is why the two figures do.
    expect(pools.poolSalvagePower).not.toBeCloseTo(pools.poolMiningPower as number);
  });
});

// THREE readings of one ship, minutes apart, all with `statsLive: true`:
//
//   status.json                 docked     eqT 15   CP 249,126
//   status-undocked.json        undocked   eqT 15   CP 249,126   <- steady undocked: identical, and CORRECT
//   status-transient.json       undocked   eqT  0   CP  42,198   <- caught around a scene change
//
// So undocking is NOT the cause; the third was taken while the game was still settling (a save loading, or a
// dock/undock in flight), when the unit exists but its equipment is not registered. Precision is unmoved in all
// three because it is crew-dominated, while CombatPower is gear-dominated — the signature of a unit without its
// gear. The guard is therefore reconciliation, not `docked`.
describe("B12: a reading is judged by whether it contains the battery, not by docked", () => {
  const own = equipped.reduce((n, i) => n + contributionOf(i).combatPower, 0);
  const P = (f: string) => poolsFromStatus(read<Status>(f)) as ShipPools;

  it("accepts the docked reading", () => {
    expect(poolsReconcile(P("status.json"), equipped)).toBe(true);
  });

  // The regression the first fix would have caused: a steady undocked reading is good and must not be refused.
  it("accepts a settled UNDOCKED reading — it is identical to the docked one", () => {
    const u = P("status-undocked.json"), d = P("status.json");
    expect(u.poolCombatPower).toBeCloseTo(d.poolCombatPower);
    expect(u.equivalentTurrets).toBe(d.equivalentTurrets);
    expect(poolsReconcile(u, equipped)).toBe(true);
  });

  it("refuses the transient reading, which cannot absorb its own battery", () => {
    const t = P("status-transient.json");
    expect(t.equivalentTurrets).toBe(0);                       // the bridge's own contradiction
    expect(t.poolCombatPower / (1 + (t.energy?.mod ?? 0))).toBeLessThan(own);
    expect(poolsReconcile(t, equipped)).toBe(false);
  });

  it("and the damage it would have done is not a small error", () => {
    const t = P("status-transient.json");
    expect(background(t, equipped).poolCombatPower).toBe(0);    // the clamp
    expect(setRank(equipped, background(t, equipped))[1])
      .toBeLessThan(setRank(equipped, background(P("status.json"), equipped))[1] * 0.5);
  });

  it("reconciles trivially when there is no battery to reconcile against", () => {
    expect(poolsReconcile(P("status-transient.json"), [])).toBe(true);
  });
});

// A SECOND ship: `Maul`, role Mining, 3 hardpoints, all mining guns (Large + Small + Small). Captured because a
// combat ship cannot exercise any of this — every bug below is invisible on the Manglor.
describe("mining ship (Maul): non-combat readings and pool shares", () => {
  const st = read<Status>("maul-status.json");
  const lay = read<ShipLayout>("maul-ship-layout.json");
  const pools = poolsFromStatus(st) as ShipPools;
  const eq = lay.hardpoints.map((h) => h.equipped).filter((x): x is Item => !!x);

  // `equivalentTurrets` is GetEquivalentTurretsCount(CombatPower), so a mining ship reports 0 with a full set of
  // guns fitted. A reconciliation that demands a positive count refuses every non-combat ship's good reading —
  // which then drops ranking to a fallback that scores mining guns with a combat damage model.
  it("reconciles a mining ship even though equivalentTurrets is 0", () => {
    expect(pools.equivalentTurrets).toBe(0);
    expect(eq.length).toBe(3);
    expect(eq.every((i) => catOf(i) === "Mining")).toBe(true);
    expect(poolsReconcile(pools, eq)).toBe(true);
  });

  // The game's own per-stat count is the check on `rating()`. Large 3 + Small 1.425 × 2 = 5.85.
  it("its size ratings sum to the count the game reports", () => {
    expect(eq.reduce((n, i) => n + rating(i), 0)).toBeCloseTo(pools.equivalentTurretsMining as number, 4);
  });

  it("scores its battery off the mining pool", () => {
    const [tier, value] = setRank(eq, background(pools, eq));
    expect(tier).toBe(1);
    expect(value).toBeGreaterThan(0);
  });

  // The screenshot case: the tab offered `Cutter Mk.XVI` 3,224 in place of the fitted 3,271. Under the mining
  // objective EVERY same-size candidate in the armory is worse, so the set optimizer never proposed it — the
  // proposal came from the fallback path, which ranks with a combat damage score.
  it("refuses every armory candidate for the fitted Small slot", () => {
    const bg = background(pools, eq);
    const cur = eq[2];
    const others = [eq[0], eq[1]];
    const base = setPower([...others, cur], bg, "Mining");
    const cands = owned.filter((i) => i.category === "Turret" && i.name === cur.name && i.size === cur.size);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) expect(setPower([...others, c], bg, "Mining")).toBeLessThan(base);
  });
});

// The per-ITEM score must not apply a combat damage model to a non-combat gun.
describe("mining ship (Maul): per-item ranking is activity-aware", () => {
  const owned2 = read<{ stores: { items: Item[] }[] }>("inventories.json").stores.flatMap((s) => s.items ?? []);
  const smallMining = owned2.filter((i) => i.category === "Turret" && catOf(i) === "Mining" && i.size === "Small");

  // The screenshot case: a 3,036 Mining Power autocannon (1.43 attacks/sec, +25% damage aspects) was ordered above
  // a 3,262 Cutter (0.5 attacks/sec). Fire rate and aspect DAMAGE are combat terms; mining reads neither.
  it("orders mining guns by their headline, not by fire rate or aspect damage", () => {
    const eff = (i: Item) => effectiveMainVal(i) ?? 0;
    const ranked = [...smallMining].sort((a, b) => rankValue(b, "expanded", CRIT) - rankValue(a, "expanded", CRIT));
    // Ranking is a permutation of the effective-headline order, so a faster gun cannot jump a stronger one.
    for (let i = 1; i < ranked.length; i++) expect(eff(ranked[i - 1])).toBeGreaterThanOrEqual(eff(ranked[i]));
  });

  it("still uses the damage model for combat guns", () => {
    const combat = owned2.filter((i) => i.category === "Turret" && catOf(i) === "Combat");
    expect(combat.length).toBeGreaterThan(0);
    // A combat gun's expanded score folds in rate/crit/aspects, so it is NOT merely its headline.
    expect(combat.some((i) => Math.abs(rankValue(i, "expanded", CRIT) - (effectiveMainVal(i) ?? 0)) > 1)).toBe(true);
  });
});

// per-layer throughput. A mining gun reaches only the layer it is built for, so a battery's Core and Surface
// figures are different numbers — and the Maul is the case that shows it (one Core Large, two Surface Smalls).
describe("mining ship (Maul): power splits by target layer", () => {
  const st = read<Status>("maul-status.json");
  const lay = read<ShipLayout>("maul-ship-layout.json");
  const pools = poolsFromStatus(st) as ShipPools;
  const eq = lay.hardpoints.map((h) => h.equipped).filter((x): x is Item => !!x);
  const bg = background(pools, eq);

  it("splits the battery across the layers its guns can reach", () => {
    expect(eq.map((i) => i.targetLayer)).toEqual(["Core", "Surface", "Surface"]);
    const core = setPowerByLayer(eq, bg, "Mining", "Core") as number;
    const surf = setPowerByLayer(eq, bg, "Mining", "Surface") as number;
    expect(core).toBeGreaterThan(0);
    expect(surf).toBeGreaterThan(0);
    // The layers partition the battery, so they sum to its whole mining figure.
    expect(core + surf).toBeCloseTo(setPower(eq, bg, "Mining"), 3);
    // Core is one Large (3) against two Smalls (2 x 1.425), so it holds the larger share — but the split is no
    // longer the pure rating ratio. Each gun also keeps its OWN main power (0.8.1.23), and the Large one's
    // headline is more than 3/2.85 of the battery's, so the Core side pulls further ahead than its rating alone
    // would put it. Ratings still decide the SHARED remainder, which is why Core is ahead at all.
    expect(core).toBeGreaterThan(surf);
    expect(core / surf).toBeGreaterThan(3 / 2.85);
    expect(core / surf).toBeCloseTo(1.0737, 3);
  });

  it("reports nothing for a layer no gun can reach", () => {
    const coreOnly = [eq[0]];
    expect(setPowerByLayer(coreOnly, bg, "Mining", "Core")).toBeGreaterThan(0);
    expect(setPowerByLayer(coreOnly, bg, "Mining", "Surface")).toBeNull();
    // And nothing at all for an activity the battery does not serve.
    expect(setPowerByLayer(eq, bg, "Salvage", "Core")).toBeNull();
  });
});

// planning for a ship you are not flying. `other-ship-layout.json` is `Salvager (old)` fetched by guid — an
// UNFITTED hull, which is the case that motivated the route.
describe("another owned ship, by guid", () => {
  const other = read<ShipLayout>("other-ship-layout.json");
  const roster = read<{ ships: { shipGuid: string; name: string; hardpoints: Item[]; hardpointSlots?: number }[] }>("ships.json").ships;
  const cur = read<Status>("status.json");

  it("is a different ship from the one being flown", () => {
    expect(other.shipGuid).not.toBe(cur.shipGuid);
    expect(roster.some((s) => s.shipGuid === other.shipGuid)).toBe(true);
  });

  // The whole reason the route takes a guid. /ships reports FITTED items, so an unfitted hull's hardpoints array
  // is empty and `hardpointSlots` gives a count with no sizes — nothing that says what would fit.
  it("knows empty hardpoints' sizes, which /ships cannot", () => {
    const fromRoster = roster.find((s) => s.shipGuid === other.shipGuid) as { hardpoints: Item[]; hardpointSlots?: number };
    expect(fromRoster.hardpoints).toHaveLength(0);
    expect(fromRoster.hardpointSlots).toBe(other.hardpoints.length);
    expect(other.hardpoints.every((h) => !h.equipped)).toBe(true);
    expect(other.hardpoints.map((h) => h.size)).toEqual(["Large", "Small", "Small"]);
  });

  // With sizes in hand the existing fit predicate works on it unchanged, which is what makes planning possible.
  it("can be planned against the shared armory", () => {
    for (const h of other.hardpoints) {
      const fits = owned.filter((g) => turretFits(g, h.size, ALL, {}));
      expect(fits.length).toBeGreaterThan(0);
      expect(fits.every((g) => g.size === h.size)).toBe(true);
    }
  });
});

// The layer choice rides the existing activity filter (`Mining` / `Mining-surface` / `Mining-core`) rather than
// adding a second control, so the persisted per-ship filters and the "Set all to…" bulk write reach it for free.
// That makes `parseActivity` the one owner of the encoding: `turretFits` restricts candidates with it and the
// optimizer derives each slot's layer role from it, and those disagreeing is how a slot gets offered a gun the
// plan then rejects.
describe("bridge capture: activity filters carry the layer (V31)", () => {
  const sizeOf = (act: string) => (ownedOf(act, "Large").length ? "Large" : "Medium");

  it("splits an activity into mixed / surface / core", () => {
    expect(parseActivity("Mining")).toEqual({ act: "Mining", layer: null });
    expect(parseActivity("Mining-surface")).toEqual({ act: "Mining", layer: "Surface" });
    expect(parseActivity("Salvage-core")).toEqual({ act: "Salvage", layer: "Core" });
    // A bare value is "mixed": the slot stays open and the meta search picks its layer.
    expect(parseActivity(undefined)).toEqual({ act: "", layer: null });
  });

  it("restricts candidates to one layer, and `mixed` restricts to none", () => {
    const size = sizeOf("Salvage");
    const all = owned.filter((i) => i.category === "Turret" && catOf(i) === "Salvage" && i.size === size);
    expect(all.length).toBeGreaterThan(1);
    const pick = (v: string) => all.filter((i) => turretFits(i, size, { mode: "activity", value: v }, {}));
    const mixed = pick("Salvage");
    const surface = pick("Salvage-surface");
    const core = pick("Salvage-core");
    expect(mixed.length).toBe(all.length);
    expect(surface.every((i) => i.targetLayer === "Surface" || i.targetLayer === "Both")).toBe(true);
    expect(core.every((i) => i.targetLayer === "Core" || i.targetLayer === "Both")).toBe(true);
    // Every gun lands in at least one of the two, so the split loses nothing.
    expect(surface.length + core.length).toBeGreaterThanOrEqual(mixed.length);
  });

  it("keeps the activity check — a layer filter never admits another activity's gun", () => {
    const size = sizeOf("Mining");
    const salvage = owned.filter((i) => i.category === "Turret" && catOf(i) === "Salvage" && i.size === size);
    for (const g of salvage) {
      expect(turretFits(g, size, { mode: "activity", value: "Mining-surface" }, {})).toBe(false);
      expect(turretFits(g, size, { mode: "activity", value: "Mining-core" }, {})).toBe(false);
    }
  });
});
