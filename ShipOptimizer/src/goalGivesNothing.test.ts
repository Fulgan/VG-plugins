import { describe, it, expect } from "vitest";
import { goalGivesNothing, type Rank } from "./fleetDps";

// A plan that improves nothing is not a compromise. Reported on a salvage hull whose role stat is not a pool the
// game serves: no ranked key could move, so a plan giving up 56% of the hull scored the same as one giving up
// nothing, and the tab offered it with a warning.
describe("a plan that gains nowhere", () => {
  const rank = (v: number): Rank => [1, v];
  const base = { hull: 1000, armor: 1000, combat: 500 } as unknown as Parameters<typeof goalGivesNothing>[0];

  it("is refused when something is worse and nothing is better", () => {
    const worse = { hull: 440, armor: 900, combat: 500 } as never;
    expect(goalGivesNothing(base, worse, rank(100), rank(100))).toBe(true);
  });

  it("is allowed as a TRADE the moment one key gains", () => {
    const traded = { hull: 440, armor: 900, combat: 900 } as never;
    expect(goalGivesNothing(base, traded, rank(100), rank(100))).toBe(false);
  });

  // The battery's own value is a gain like any other: a plan can leave every pool alone and still be better.
  it("is allowed when the ranked value itself rises", () => {
    const worse = { hull: 440, armor: 1000, combat: 500 } as never;
    expect(goalGivesNothing(base, worse, rank(120), rank(100))).toBe(false);
  });

  // Flat everywhere is a TIE, and a tie is `worthSwitching`'s question, not this one.
  it("says nothing about a plan that changes nothing", () => {
    expect(goalGivesNothing(base, { hull: 1000, armor: 1000, combat: 500 } as never, rank(100), rank(100))).toBe(false);
  });

  // A key only one side can state is an absence, not a loss.
  it("ignores a key missing from either reading", () => {
    const partial = { hull: 1000, armor: undefined, combat: 500 } as never;
    expect(goalGivesNothing(base, partial, rank(100), rank(100))).toBe(false);
  });
});
