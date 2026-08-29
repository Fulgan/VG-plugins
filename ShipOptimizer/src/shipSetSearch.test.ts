// ONE search over BOTH halves of the ship.
//
// The two single-block passes share the objective and the ascent but not the SEARCH: `optimizeModuleSet` holds
// the battery still and `optimizeTurretSet` holds the modules still, so the coupling that runs between them is
// invisible to both. The case that proves it, and the reason this entry point exists: a bigger reactor raises
// capacity, which relaxes the bracket, which makes a THIRSTIER gun affordable. Each half alone refuses its own
// step — the reactor pays for nothing while the old gun is fitted, and the gun cannot be afforded while the old
// reactor is — so the player can only reach it by pressing the two buttons in the right order, twice.
import { describe, it, expect } from "vitest";
import {
  background, goalReadingOf, goalRefuses, moduleBetter, optimizeGearSet, optimizeModuleSet, optimizeShipSet,
  optimizeTurretSet, poolsWithModules, powerReadingOf, rankSub, setRank, rankGt,
  type Rank, type ShipPools,
} from "./fleetDps";
import type { Item } from "./types";

const gun = (name: string, cp: number, draw: number, key: number, over: Partial<Item> = {}): Item => ({
  key, slot: key, name, rarity: "Exotic", level: 64, size: "Medium", type: "Railgun",
  category: "Turret", gameplayType: "Combat", damageType: "Kinetic", sellValue: 0,
  mainStat: { name: "Combat Power", amount: String(cp) },
  powerUsage: draw, powerUsageBase: draw,
  fireDelayRaw: 0.4, reloadDelayRaw: 2, magSizeRaw: 10, burstAmount: 1, burstDelay: 0,
  aspects: [], stats: [], substats: [], bonus: null, bonusStat: null, ...over,
} as unknown as Item);

const mod = (slotType: string, name: string, draw: number, key: number,
             lines: { stat: string; amount?: number; multiplier?: number }[] = []): Item => ({
  key, slot: key, name, rarity: "Standard", level: 60, size: "Large", type: slotType, slotType,
  category: "Module", gameplayType: null, sellValue: 0,
  mainStat: { name: "Armor HP", amount: "1000" },
  powerUsage: draw, powerUsageBase: draw,
  stats: lines.map((l) => ({ amount: 0, multiplier: 1, ...l })),
  aspects: [], substats: [], bonus: null, bonusStat: null,
} as unknown as Item);

// A ship inside the TOP band: 9,000 of 20,000 is 45%, so every power pool carries +20%. `Energy` on a module
// raises CAPACITY (`capacityWith`), which is the mechanism the unlock runs through.
const CAP = 20_000;
const pools = (used: number, capacity = CAP): ShipPools => ({
  poolCombatPower: 40_000, poolPrecision: 12_300, equivalentTurrets: 4,
  precisionDivisor: 5_000, critDamage: 1, megaCrit: 0, critChance: 0.2, critChanceMult: 1,
  energy: { used, capacity, mod: 0.2 },
});

describe("optimizeShipSet", () => {
  // The fitted pair draws 9,000 of 20,000 — 45%, the +20% band. The upgrade pair: a reactor that adds 16,000
  // capacity and buys nothing by itself (the band is already the top one), and a gun worth +40% more power for
  // NINE times the draw — which on the old capacity takes the load to 85% and costs the +20% on every pool.
  const smallReactor = mod("Reactor", "small-reactor", 1_000, 1);
  const bigReactor = mod("Reactor", "big-reactor", 1_000, 2, [{ stat: "Energy", amount: 16_000 }]);
  const modestGun = gun("modest", 10_000, 1_000, 3);
  const thirstyGun = gun("thirsty", 14_000, 9_000, 4);
  const fitted = [modestGun];

  const worth = (mods: (Item | null)[], turrets: Item[]) =>
    setRank(turrets, background(poolsWithModules(pools(9_000), [smallReactor], mods), fitted));

  it("the two halves each refuse the step the other unlocks", () => {
    // The reactor alone: more capacity, nothing using it — the same battery on a lighter load. It is not a LOSS,
    // but it buys nothing on its own, and the thirsty gun alone is what the bracket cannot afford.
    const gunAlone = worth([smallReactor], [thirstyGun]);
    const both = worth([bigReactor], [thirstyGun]);
    const now = worth([smallReactor], [modestGun]);
    expect(rankGt(both, now)).toBe(true);          // together they pay
    expect(rankGt(both, gunAlone)).toBe(true);     // and the capacity is what makes the gun worth its draw

    // Each single-block pass, run against the other half as FITTED — which is what the two buttons do.
    const modulesFirst = optimizeModuleSet(
      [{ key: "m:Reactor", current: smallReactor, candidates: [smallReactor, bigReactor] }],
      pools(9_000), fitted, { role: "Combat" });
    const bgNow = background(pools(9_000), fitted);
    const turretsFirst = optimizeTurretSet(
      [{ key: "t:0", current: modestGun, candidates: [modestGun, thirstyGun] }], bgNow);
    // Neither reaches the pair: the turret pass cannot see the capacity it would need.
    expect(turretsFirst.get("t:0")).toBe(modestGun);
    expect(modulesFirst.get("m:Reactor") === bigReactor && turretsFirst.get("t:0") === thirstyGun).toBe(false);
  });

  it("finds the pair in ONE pass", () => {
    const chosen = optimizeShipSet({
      turretSlots: [{ key: "t:0", current: modestGun, candidates: [modestGun, thirstyGun] }],
      moduleSlots: [{ key: "m:Reactor", current: smallReactor, candidates: [smallReactor, bigReactor] }],
      pools: pools(9_000), fittedTurrets: fitted, ctx: { role: "Combat" },
    });
    expect(chosen.get("m:Reactor")).toBe(bigReactor);
    expect(chosen.get("t:0")).toBe(thirstyGun);
  });

  it("is never worse than what is fitted", () => {
    // Every candidate is a loss, so the ascent keeps the incumbents — the one guarantee a suggest button owes.
    const worseGun = gun("worse", 4_000, 9_000, 5);
    const worseMod = mod("Reactor", "worse-reactor", 9_000, 6, [{ stat: "Combat Power", amount: -2_000 }]);
    const chosen = optimizeShipSet({
      turretSlots: [{ key: "t:0", current: modestGun, candidates: [modestGun, worseGun] }],
      moduleSlots: [{ key: "m:Reactor", current: smallReactor, candidates: [smallReactor, worseMod] }],
      pools: pools(9_000), fittedTurrets: fitted, ctx: { role: "Combat" },
    });
    expect(chosen.get("t:0")).toBe(modestGun);
    expect(chosen.get("m:Reactor")).toBe(smallReactor);
  });

  it("asks moduleBetter where the objective is silent, and leaves turret ties to the objective", () => {
    // Two hull kits the objective cannot separate — no pooled lines, same draw — so the countable tie-breaks
    // decide, and the joint search must reach the same answer `moduleBetter` gives on its own.
    const plain = { ...mod("Hull", "plain", 500, 7), aspectSlots: 0 } as Item;
    const roomy = { ...mod("Hull", "roomy", 500, 8), aspectSlots: 2 } as Item;
    expect(moduleBetter(roomy, plain, { pools: pools(9_000), turrets: fitted, role: "Combat" })).toBe(true);
    const chosen = optimizeShipSet({
      turretSlots: [{ key: "t:0", current: modestGun, candidates: [modestGun] }],
      moduleSlots: [{ key: "m:Hull", current: plain, candidates: [plain, roomy] }],
      pools: pools(9_000), fittedTurrets: fitted, ctx: { role: "Combat" },
    });
    expect(chosen.get("m:Hull")).toBe(roomy);
  });

  it("stays interactive when both halves are wide", () => {
    // The cost is the SUM over slots per pass, not the product of the candidate sets — but every module change
    // re-derives the pools, so the background is memoised on the module vector. This pins that it holds.
    const guns = Array.from({ length: 500 }, (_, i) => gun(`g${i}`, 9_000 + i * 10, 500 + (i % 30) * 100, 100 + i));
    const mods = Array.from({ length: 500 }, (_, i) =>
      mod("Reactor", `r${i}`, 500 + (i % 20) * 100, 1_000 + i, [{ stat: "Energy", amount: (i % 25) * 400 }]));
    const started = performance.now();
    const chosen = optimizeShipSet({
      turretSlots: [
        { key: "t:0", current: modestGun, candidates: [modestGun, ...guns] },
        { key: "t:1", current: modestGun, candidates: [modestGun, ...guns] },
      ],
      moduleSlots: [
        { key: "m:Reactor", current: smallReactor, candidates: [smallReactor, ...mods] },
        { key: "m:Hull", current: null, candidates: mods.map((m) => ({ ...m, type: "Hull", slotType: "Hull" } as Item)) },
      ],
      pools: pools(9_000), fittedTurrets: fitted, ctx: { role: "Combat" },
    });
    const took = performance.now() - started;
    expect(chosen.get("t:0")).toBeDefined();
    expect(took).toBeLessThan(10_000);
    console.log(`joint search over 2 hardpoints + 2 module slots × ~500 candidates each: ${Math.round(took)}ms`);
  });

  // A RANKED READING IS A FIGURE OF THE SHIP.
  //
  // The objective reads the battery against a background the modules alone decide, because `setDps` adds each
  // candidate gun's own contribution and folding the guns into that background counts them twice. A GOAL KEY is
  // a whole-ship figure and needs the opposite: every slot the plan touches, hardpoints included. Read it off the
  // modules alone and a plan buying a module's `Power` line with a hardpoint's own power reads as pure gain on
  // the very key the player ranked first.
  describe("the ranked reading folds in the hardpoints", () => {
    const cutter = (name: string, power: number, draw: number, key: number,
                    layer: "Surface" | "Core"): Item => ({
      key, slot: key, name, rarity: "Exotic", level: 74, size: "Large", type: "Salvage Cutter",
      category: "Turret", gameplayType: "Salvage", targetLayer: layer, damageType: "Kinetic", sellValue: 0,
      mainStat: { name: "Salvage Power", amount: String(power) },
      powerUsage: draw, powerUsageBase: draw,
      fireDelayRaw: 0.4, reloadDelayRaw: 2, magSizeRaw: 10, burstAmount: 1, burstDelay: 0,
      aspects: [], stats: [], substats: [], bonus: null, bonusStat: null,
    } as unknown as Item);

    // The pair that was proposed on the live ship: a strictly weaker cutter for the fitted one. Both loads sit
    // inside the top reactor bracket (20% and 18% of capacity), so nothing here is a bracket effect.
    const strongCutter = cutter("Salvage Cutter Mk.XIX", 10_376, 2_615, 30, "Surface");
    const weakCutter = cutter("Salvage Cutter Mk.XVI", 4_188, 1_040, 31, "Surface");
    // The CORE bottleneck, and the reason the objective has no opinion about the surface swap: the balanced
    // target is `min(surface, core)`, so surface power above the core figure is slack the search may spend for
    // nothing. This is the shape a synthetic tie cannot reproduce by making the two guns equal.
    const coreCutter = cutter("Core Cutter", 500, 300, 32, "Core");
    const plainKit = mod("Hull", "plain-kit", 0, 33);
    const hullKit = mod("Hull", "hull-kit", 0, 34, [{ stat: "Power", amount: 2_265 }]);
    const fittedBattery = [strongCutter, coreCutter];

    const salvagePools = (): ShipPools => ({
      poolCombatPower: 0, poolSalvagePower: 231_565, poolPrecision: 12_300, equivalentTurrets: 4,
      precisionDivisor: 5_000, critDamage: 1, megaCrit: 0, critChance: 0.2, critChanceMult: 1,
      energy: { used: 20_000, capacity: 100_000, mod: 0.2 },
    });

    it("the objective is silent on the swap, so only the reading can refuse it", () => {
      const bg = background(poolsWithModules(salvagePools(), [plainKit], [plainKit]), fittedBattery);
      const now = setRank(fittedBattery, bg, "balanced", "Salvage");
      const swapped = setRank([weakCutter, coreCutter], bg, "balanced", "Salvage");
      expect(swapped[0]).toBe(now[0]);
      // Not worse: the surface layer had slack, so throwing 6,188 of it away costs the objective nothing.
      expect(rankSub(swapped, now)).toBeGreaterThanOrEqual(0);
    });

    it("reads the swap on the layer that actually moved, and stays silent on the one that did not", () => {
      // The activity keys are LAYER throughput off the candidate battery rather than a projected pool,
      // which is what makes this plan legible: it spends SURFACE power, and the surface key is the one that moves.
      const withKit = poolsWithModules(salvagePools(), [plainKit], [hullKit]);
      const bg = background(withKit, fittedBattery);
      const fitted = goalReadingOf(salvagePools(), undefined, undefined,
                                   powerReadingOf(fittedBattery, background(salvagePools(), fittedBattery)));
      const swapped = goalReadingOf(withKit, undefined, undefined,
                                    powerReadingOf([weakCutter, coreCutter], bg));

      // Surface is what the swap gives up, and an order naming it refuses.
      expect(swapped.salvageSurface!).toBeLessThan(fitted.salvageSurface!);
      expect(goalRefuses(["salvageSurface"], fitted, swapped)).toBe("salvageSurface");

      // Balanced is `min(surface, core)` and the CORE cutter is the bottleneck, so the surface loss does not
      // reach it — the kit's `Power 2,265` does, and it points UP. ∴ the two keys disagree about this plan by
      // design: surface refuses it, balanced accepts it, and which of them the player put first is the answer.
      // That is the whole reason the split exists rather than one `mining`/`salvage` key.
      expect(swapped.salvageBalanced!).toBeGreaterThan(fitted.salvageBalanced!);
      expect(goalRefuses(["salvageBalanced"], fitted, swapped)).toBeNull();
    });

    it("keeps the fitted cutter and takes the kit alone", () => {
      // `alone` scores a battery of one at `min(surface, 0) = 0`, so both cutters tie there and the seed starts
      // this hardpoint on the FIRST candidate — the weaker gun. The plan must still come back with the incumbent.
      const chosen = optimizeShipSet({
        turretSlots: [
          { key: "t:0", current: strongCutter, candidates: [weakCutter, strongCutter] },
          { key: "t:1", current: coreCutter, candidates: [coreCutter] },
        ],
        moduleSlots: [{ key: "m:Hull", current: plainKit, candidates: [plainKit, hullKit] }],
        pools: salvagePools(), fittedTurrets: fittedBattery, ctx: { role: "Salvaging" }, act: "Salvage",
        goal: {
          order: ["salvageSurface"],
          // The fitted side carries the same reading shape as a candidate's, or the key is absent on one side and
          // orders nothing (`goalUnread`).
          fitted: goalReadingOf(salvagePools(), undefined, undefined,
                                powerReadingOf(fittedBattery, background(salvagePools(), fittedBattery))),
        },
      });
      expect(chosen.get("m:Hull")).toBe(hullKit);
      expect(chosen.get("t:0")).toBe(strongCutter);
    });

    it("refuses a swap the objective WANTS, where the key it spends is a hardpoint's own power", () => {
      // The two quantities pulled apart: the objective is a DPS index and a ranked key is a POOL figure. What the
      // index rewards is `speedRatio`, the cadence a gun achieves over the divisor the game charges it — a single
      // shot behind a long reload collects the whole of the 0.8 reload discount, where a big magazine spreads it
      // thin. So a gun worth 1,000 less Combat Power can still raise the index, and settling cannot catch the
      // swap because it earns its place on the objective. Only a reading that folds the hardpoints in sees what
      // it spent. Equal draw on both, so no bracket moves.
      const steadyGun = gun("steady", 12_000, 1_000, 50,
        { fireDelayRaw: 0.2, reloadDelayRaw: 1, magSizeRaw: 20 });
      const burstGun = gun("single-shot", 11_000, 1_000, 51,
        { fireDelayRaw: 0.1, reloadDelayRaw: 5, magSizeRaw: 1 });
      const bg = background(pools(9_000), [steadyGun]);
      expect(rankSub(setRank([burstGun], bg), setRank([steadyGun], bg))).toBeGreaterThan(0);

      const fitted = goalReadingOf(pools(9_000));
      const chosen = optimizeShipSet({
        turretSlots: [{ key: "t:0", current: steadyGun, candidates: [burstGun, steadyGun] }],
        moduleSlots: [],
        pools: pools(9_000), fittedTurrets: [steadyGun], ctx: { role: "Combat" },
        goal: { order: ["combat"], fitted },
      });
      expect(chosen.get("t:0")).toBe(steadyGun);
    });
  });

  // EVERY SWAP IN THE ANSWER EARNS ITS OWN PLACE.
  //
  // Incumbency inside a pass is not incumbency in the ANSWER: a slot seeded from `alone` starts on a candidate,
  // and a coordinate the objective is indifferent to is never moved back off it, so the winning seed carries
  // swaps it was never asked to justify. That needs the SEEDED plan to win, which needs a gain no single
  // coordinate can reach — pinned here at `optimizeGearSet`'s own boundary, where the objective is a parameter.
  // A whole-ship fixture cannot hold the shape still: `optimizeShipSet` hands the module slots `moduleBetter` as
  // their tie-break, which bridges a neutral reactor step, so the fitted seed reaches the pair too and the two
  // seeds tie — and a tie is decided for the incumbent, which is the thing this pass exists to do by measurement.
  describe("the answer is settled slot by slot", () => {
    const pairGun = gun("pair-gun", 14_000, 9_000, 40);
    const pairMod = mod("Reactor", "pair-reactor", 1_000, 41, [{ stat: "Energy", amount: 16_000 }]);
    const twinA = gun("twin-a", 8_000, 700, 42);
    const twinB = gun("twin-b", 8_000, 700, 43);          // indistinguishable to the objective, another object
    const plainHull = { ...mod("Hull", "plain-hull", 500, 44), aspectSlots: 0 } as Item;
    const roomyHull = { ...mod("Hull", "roomy-hull", 500, 45), aspectSlots: 2 } as Item;

    // The pair pays and neither half does: one step alone is a LOSS, so the ascent from what is fitted stays
    // where it is however many passes it takes, and only a seed that starts on both reaches the gain.
    const scored = (chosen: ReadonlyMap<string, Item>): Rank => {
      const both = chosen.get("t:0") === pairGun && chosen.get("m:Reactor") === pairMod;
      const half = (chosen.get("t:0") === pairGun) !== (chosen.get("m:Reactor") === pairMod);
      return [2, both ? 100 : half ? 80 : 90];
    };
    const chosen = optimizeGearSet({
      slots: [
        { key: "m:Reactor", current: smallReactor, candidates: [smallReactor, pairMod] },
        { key: "m:Hull", current: plainHull, candidates: [plainHull, roomyHull] },
        { key: "t:0", current: modestGun, candidates: [pairGun, modestGun] },
        { key: "t:1", current: twinA, candidates: [twinB, twinA] },
      ],
      score: scored,
      // The per-slot answer, which is what seeds the second run: it likes the pair's gun, and it cannot separate
      // the twins — so that slot starts on a candidate for no reason the objective can state.
      alone: (it, at) => (at.startsWith("t:") ? [2, it === pairGun ? 99 : 90] : null),
      // Modules only, exactly as `optimizeShipSet` wires it: the roomy hull wins where the objective is silent,
      // and a hardpoint tie is left to the objective.
      tie: (cand, _best, at) => !at.startsWith("t:") && cand === roomyHull,
    });

    it("keeps the coupled pair, so the winning plan is the seeded one", () => {
      expect(chosen.get("m:Reactor")).toBe(pairMod);
      expect(chosen.get("t:0")).toBe(pairGun);
    });

    it("reverts the rank-neutral gun the seed started on", () => {
      expect(chosen.get("t:1")).toBe(twinA);
    });

    it("keeps the module swap the tie-break earns, where the objective is silent", () => {
      expect(chosen.get("m:Hull")).toBe(roomyHull);
    });
  });
});
