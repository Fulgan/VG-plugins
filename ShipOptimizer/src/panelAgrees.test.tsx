// @vitest-environment jsdom
//
// THE PANEL MAY NOT COMPUTE WHAT THE OBJECTIVE ALREADY COMPUTES.
//
// One figure derived twice is the second family of defect this objective keeps producing, and it has cost five
// bugs: (a module's pooled contribution missing from every projected figure), and (a plan's
// bracket projected from the draw alone, the verdict disagreeing with the panel beside it), (the panel
// reading `/status` while the scorer held a cached pool), (`Combat power` summing module contributions
// through `contributionOf`, which answers 0 for a module, while `DPS index` went through `poolsWithModules`).
//
// Every one was the same shape: two code paths for one number, agreeing on the fixtures and disagreeing on a real
// build. Nothing asserted they matched, so each was found by a player noticing an impossible pair of rows.
//
// This asserts it directly: render the panel, read the figures OFF THE DOM, and compare them to what the
// objective's own owners return for the same inputs. It does not re-derive anything — a third derivation would be
// the very defect — it only demands that what is drawn equals what is scored.
import { describe, expect, it, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import GearTotals from "./GearTotals";
import {
  background, poolsWithModules, reactorBudgetOf, setRank, type ShipPools,
} from "./fleetDps";
import { energyDraw, reactorModifier, repowered } from "./reactor";
import type { Item } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
});

/** The projected figure the panel DREW for a row, parsed back out of the DOM. */
const drawn = (label: string): number | null => {
  const rows = [...host!.querySelectorAll(".gt-row")];
  const hit = rows.find((r) => r.querySelector(".gt-label")?.textContent === label);
  const cell = hit?.querySelector(".gt-next") ?? hit?.querySelector(".gt-cur");
  const txt = cell?.textContent ?? "";
  const n = Number(txt.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) && txt !== "" ? n : null;
};

// A ship near the bracket edge, so a plan that moves the load exercises the term that has broken most often.
const POOLS: ShipPools = {
  poolCombatPower: 214_280, poolCombatPowerMult: 2.1329,
  poolPrecision: 23_924, poolPrecisionMult: 1,
  poolMiningPower: 19_279, poolMiningPowerMult: 1.4586,
  critChance: 0.552, critChanceMult: 1, critDamage: 0.4, megaCrit: 3,
  precisionDivisor: 3_200, equivalentTurrets: 7, combatReactorBonus: 0.1,
  energy: { used: 19_075, capacity: 30_534, mod: 0.1 },
};

const gun = (n: number, cp: number, draw: number): Item => ({
  name: `gun${n}`, size: "Medium", damageType: "Kinetic", gameplayType: "Combat", category: "Turret",
  mainStat: { name: "Combat Power", amount: String(cp) }, powerUsage: draw, powerUsageBase: draw,
  stats: [{ stat: "Combat Power", amount: cp, multiplier: 1 }], substats: [], aspects: [],
} as unknown as Item);

const mod = (name: string, cp: number, draw: number, energy = 0): Item => ({
  name, size: "Large", type: "Scanner", slotType: "Scanner", category: "Module",
  mainStat: { name: "Combat Power", amount: String(cp) }, powerUsage: draw, powerUsageBase: draw,
  stats: [{ stat: "Combat Power", amount: cp, multiplier: 1 },
          ...(energy ? [{ stat: "Energy", amount: energy, multiplier: 1 }] : [])],
  substats: [], aspects: [],
} as unknown as Item);

const turrets = [gun(1, 16_810, 0), gun(2, 20_970, 0), gun(3, 10_617, 2_080)];

const render = (curOther: Item[], nextOther: Item[]) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<GearTotals pools={POOLS} reactor={reactorBudgetOf(POOLS)} ranking="expanded"
      curTurrets={turrets} nextTurrets={turrets} curOther={curOther} nextOther={nextOther} />);
  });
};

describe("the panel agrees with the objective", () => {
  // The case: modules carrying real Combat Power, which one derivation counted and the other did not.
  const out = mod("fitted", 8_000, 3_294, 30_534);
  const inn = mod("planned", 2_000, 1_000, 23_265);

  it("draws the Combat power the objective's own projection holds", () => {
    render([out], [inn]);
    const proj = poolsWithModules(POOLS, [out], [inn]);
    const usedNext = POOLS.energy!.used + (energyDraw([inn]) - energyDraw([out]));
    const modNext = reactorModifier(usedNext / proj.energy!.capacity);
    const expected = repowered(proj.poolCombatPower, POOLS.energy!.mod, modNext);
    // Rounded as the panel rounds; the point is the two derivations, not the last digit.
    expect(drawn("Combat power")).toBe(Math.round(expected));
  });

  it("draws the Precision the objective's own projection holds", () => {
    render([out], [inn]);
    expect(drawn("Precision")).toBe(Math.round(poolsWithModules(POOLS, [out], [inn]).poolPrecision));
  });

  it("moves the Combat power row at all when only MODULES change", () => {
    // The exact regression: `contributionOf(module).combatPower` is 0, so a module-only plan moved this row
    // by nothing while the DPS index counted every one of them.
    render([out], [inn]);
    const cur = drawn("Combat power");
    render([out], [out]);
    const same = drawn("Combat power");
    expect(cur).not.toBe(same);
  });

  it("agrees with setRank on whether the plan is better", () => {
    render([out], [inn]);
    const proj = poolsWithModules(POOLS, [out], [inn]);
    const objective = setRank(turrets, background(proj, turrets))[1]
      - setRank(turrets, background(POOLS, turrets))[1];
    const shown = (drawn("DPS index") ?? 0) - Math.round(setRank(turrets, background(POOLS, turrets))[1]);
    // Same SIGN: a panel that shows a gain where the objective scores a loss is the pair a player cannot read.
    expect(Math.sign(shown)).toBe(Math.sign(Math.round(objective)));
  });
});

// HP PROJECTS IN THE SPACE THE GAME BUILDS IT IN, which is not the space it is reported in.
//
// MEASURED on the Varyag (0.8.1.23): `GetStat(HullHP)` = 2,623,856 = `(1,409 + 8,338) × 269.176`, where the Hull
// Kit contributes `Hull HP ×162.948` and two modules 4,575 and 3,763 flat. And `/ship/vitals` reports the SAME
// number to the digit for hull, armor and shield alike — one figure, two routes, no ambiguity about which is
// "armor". Subtracting a raw additive line from that multiplied total and adding the candidate's back moves the
// row by the line's flat value where the game moves it by the line × the product.
describe("HP rows project through the product", () => {
  const VITALS = { hull: { cur: 2_623_856, max: 2_623_856 }, armor: { cur: 1, max: 1 }, shield: { cur: 1, max: 1 } };
  const kit = (mul: number, name: string): Item => ({
    name, size: "Large", type: "Hull Kit", slotType: "Hull", category: "Module",
    mainStat: { name: "Hull HP", amount: "0" }, powerUsage: 0, powerUsageBase: 0,
    stats: [{ stat: "Hull HP", amount: 0, multiplier: mul, percent: true }], substats: [], aspects: [],
  } as unknown as Item);
  const flat = (add: number, name: string): Item => ({
    name, size: "Large", type: "Engine", slotType: "Engine", category: "Module",
    mainStat: { name: "Hull HP", amount: String(add) }, powerUsage: 0, powerUsageBase: 0,
    stats: [{ stat: "Hull HP", amount: add, multiplier: 1 }], substats: [], aspects: [],
  } as unknown as Item);

  const renderV = (curOther: Item[], nextOther: Item[]) => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(<GearTotals pools={POOLS} reactor={reactorBudgetOf(POOLS)} ranking="expanded"
        vitals={VITALS as never} curTurrets={[]} nextTurrets={[]} curOther={curOther} nextOther={nextOther} />);
    });
  };

  it("moves Hull by the additive line TIMES the product, not by the line", () => {
    // Fitted: ×162.948 and 8,338 flat, reproducing the measured reading. Planned: 1,000 more flat.
    const cur = [kit(162.948288, "kit"), flat(8_338, "eng")];
    const next = [kit(162.948288, "kit"), flat(9_338, "eng2")];
    renderV(cur, next);
    // base = 2,623,856/162.948 − 8,338 = 7,764.6 ; new = (7,764.6 + 9,338) × 162.948
    expect(drawn("Hull")).toBe(Math.round((2_623_856 / 162.948288 - 8_338 + 9_338) * 162.948288));
    // and that is ~163,000 more, not the 1,000 the old arithmetic produced
    expect((drawn("Hull") ?? 0) - 2_623_856).toBeGreaterThan(100_000);
  });

  it("moves Hull by the RATIO when a multiplier line changes", () => {
    const cur = [kit(162.948288, "kit"), flat(8_338, "eng")];
    const next = [kit(81.474144, "half-kit"), flat(8_338, "eng")];
    renderV(cur, next);
    // The additive side is untouched, so halving the product halves the total.
    expect(drawn("Hull")).toBe(Math.round(2_623_856 / 2));
  });

  it("leaves the row alone when nothing touches the stat", () => {
    const same = [kit(162.948288, "kit"), flat(8_338, "eng")];
    renderV(same, same);
    expect(drawn("Hull")).toBe(2_623_856);
  });
});
