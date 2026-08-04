import { describe, expect, it } from "vitest";
import { REACTOR_BRACKETS, energyDraw, reactorBracket, reactorModifier, repowered } from "./reactor";

describe("reactorModifier", () => {
  it("matches the game's table", () => {
    expect(reactorModifier(0)).toBe(0.2);
    expect(reactorModifier(0.49)).toBe(0.2);
    expect(reactorModifier(0.6)).toBe(0.1);
    expect(reactorModifier(0.9)).toBe(0);
    expect(reactorModifier(1.1)).toBe(-0.25);
    expect(reactorModifier(1.4)).toBe(-0.5);
    expect(reactorModifier(2)).toBe(-0.75);
    expect(reactorModifier(999)).toBe(-0.75);
  });

  // The game compares with `usage <= key`, so a boundary belongs to the BETTER bracket. Off by one here and
  // the panel would tell the player a 50%-exactly build had lost its +20%.
  it("treats a threshold as the top of the better bracket", () => {
    expect(reactorModifier(0.5)).toBe(0.2);
    expect(reactorModifier(0.75)).toBe(0.1);
    expect(reactorModifier(1)).toBe(0);
    expect(reactorModifier(1.25)).toBe(-0.25);
    expect(reactorModifier(1.5)).toBe(-0.5);
  });

  it("covers every usage with a bracket", () => {
    expect(REACTOR_BRACKETS[REACTOR_BRACKETS.length - 1].upTo).toBe(Infinity);
  });
});

describe("reactorBracket", () => {
  it("names the next threshold so a swap can be warned about", () => {
    expect(reactorBracket(0.3)).toEqual({ mod: 0.2, nextAt: 0.5, nextMod: 0.1 });
    expect(reactorBracket(0.8)).toEqual({ mod: 0, nextAt: 1, nextMod: -0.25 });
  });

  it("has nothing worse to warn about in the last bracket", () => {
    expect(reactorBracket(3)).toEqual({ mod: -0.75, nextAt: null, nextMod: null });
  });
});

describe("energyDraw", () => {
  it("sums effective draw and tolerates items without one", () => {
    expect(energyDraw([{ powerUsage: 100 }, { powerUsage: 42.5 }, {}, { powerUsage: null }])).toBe(142.5);
    expect(energyDraw([])).toBe(0);
  });
});

describe("repowered", () => {
  // The pool arrives with its bracket already applied, so a projection must remove it first. Multiplying the
  // new modifier straight onto the reported pool would compound the two.
  it("rebases a pool from one bracket to another", () => {
    expect(repowered(120, 0.2, 0.2)).toBeCloseTo(120);
    expect(repowered(120, 0.2, 0)).toBeCloseTo(100);
    expect(repowered(120, 0.2, -0.25)).toBeCloseTo(75);
    expect(repowered(100, 0, 0.2)).toBeCloseTo(120);
  });

  it("leaves a pool alone when the old modifier would divide by zero", () => {
    expect(repowered(50, -1, 0.2)).toBe(50);
  });
});
