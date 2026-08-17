// @vitest-environment jsdom
//
// A WITHHELD score has to be legible. When the reactor budget the ranking model holds and the one the ship reports
// straddle a bracket edge, the set objective is switched off — and a tab that quietly stops applying it looks
// exactly like one that examined the build and found nothing worth changing. Measured pair: the panel read 5,829 of
// 11,858 (49%) while the scorer held 10,857 of 21,229 (51%).
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import GearTotals from "./GearTotals";
import { pairBudget, poolsFromStatus, reactorBudgetOf } from "./fleetDps";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
});

const LIVE = {
  poolCombatPower: 100_000, poolCombatPowerMult: 1.2, precisionDivisor: 3_430,
  poolPrecision: 1_000, equivalentTurrets: 3, critChance: 0.2, critChanceMult: 1, critDamage: 1, megaCrit: 0,
  energyUsed: 5_829, energyCapacity: 11_858, energyUsage: 5_829 / 11_858, reactorBonus: 0.2,
};
// The same ship one bracket down — the reading a cache is holding after a reactor swap.
const HELD = { ...LIVE, energyUsed: 10_857, energyCapacity: 21_229, reactorBonus: 0.1, poolCombatPowerMult: 1.1 };

const render = (node: React.ReactElement) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host.textContent ?? "";
};

describe("the panel when the budget cannot be paired", () => {
  it("names both loads and the bracket they are worth, instead of showing nothing", () => {
    const { pools, note } = pairBudget(poolsFromStatus(HELD), poolsFromStatus(LIVE)!.energy!);
    expect(pools).toBeNull();
    const text = render(
      <GearTotals pools={pools} reactor={reactorBudgetOf(poolsFromStatus(LIVE))} ranking="expanded"
                  budgetNote={note} curTurrets={[]} nextTurrets={[]} curOther={[]} nextOther={[]} />);
    expect(text).toContain("51%");
    expect(text).toContain("49%");
    expect(text).toContain("headline stat");
  });

  it("still shows the player their own load, which is the game's figure and decided nothing", () => {
    const { pools, note } = pairBudget(poolsFromStatus(HELD), poolsFromStatus(LIVE)!.energy!);
    const text = render(
      <GearTotals pools={pools} reactor={reactorBudgetOf(poolsFromStatus(LIVE))} ranking="expanded"
                  budgetNote={note} curTurrets={[]} nextTurrets={[]} curOther={[]} nextOther={[]} />);
    expect(text).toContain("11'858");   // the live capacity, not the held 21,229
    expect(text).not.toContain("21'229");
  });

  it("says nothing at all when the two readings agree", () => {
    const { pools, note } = pairBudget(poolsFromStatus(LIVE), poolsFromStatus(LIVE)!.energy!);
    expect(note).toBeNull();
    const text = render(
      <GearTotals pools={pools} reactor={reactorBudgetOf(pools)} ranking="expanded"
                  budgetNote={note} curTurrets={[]} nextTurrets={[]} curOther={[]} nextOther={[]} />);
    // No reassuring variant: a paired budget is drawn as an ordinary panel, never as a clean verdict.
    expect(text).not.toContain("different brackets");
    expect(text).toContain("11'858");
  });
});
