// A REFUSAL IS ONLY TRUE OF THE RUN THAT PRODUCED IT.
//
// Reported from a screenshot: a salvage hull was told "no candidate raised Combat Power, which is first in this
// ship's goal order". Combat Power is not in a salvage hull's order at all. The player had SWITCHED to that hull,
// and the gear builder stays mounted across a ship change, so the key that had correctly refused a plan on the
// previous hull was still sitting in a ref and got printed beside the new ship.
//
// Two rules come out of that, and both are pinned here rather than argued in a comment.
import { describe, it, expect } from "vitest";
import { liveVeto, goalRefuses, type GoalKey, type GoalReading } from "./fleetDps";

describe("a refusal expires with the run that produced it", () => {
  const rec = { sig: "shipA|gearA|filtersA", key: "combat" as GoalKey };

  it("is shown while the question is unchanged", () => {
    expect(liveVeto(rec, "shipA|gearA|filtersA")).toBe("combat");
  });

  it("is dropped once the ship changes, which is the reported bug", () => {
    // The signature opens with the ship guid, so a hull change alone invalidates it. Nothing else has to
    // remember to clear anything.
    expect(liveVeto(rec, "shipB|gearA|filtersA")).toBeNull();
  });

  it("is dropped when the gear or the filters move, because the answer would be re-derived", () => {
    expect(liveVeto(rec, "shipA|gearB|filtersA")).toBeNull();
    expect(liveVeto(rec, "shipA|gearA|filtersB")).toBeNull();
  });

  it("says nothing when no run has refused anything", () => {
    expect(liveVeto(null, "shipA|gearA|filtersA")).toBeNull();
    expect(liveVeto(undefined, "shipA|gearA|filtersA")).toBeNull();
  });
});

describe("the refusing key is not necessarily the first goal", () => {
  const reading = (v: Partial<GoalReading>): GoalReading => v as GoalReading;

  it("returns a lower-ranked key when the ones above it tied", () => {
    // This is why the note no longer claims the key it names is FIRST in the order: `goalRefuses` walks the order
    // and returns the first key that FELL, and every key above it may have been untouched.
    const order: GoalKey[] = ["combat", "precision"];
    const fitted = reading({ combat: 10_000, precision: 5_000 });
    const planned = reading({ combat: 10_000, precision: 4_000 });

    expect(goalRefuses(order, fitted, planned)).toBe("precision");
  });

  it("still refuses on the first key when that is the one that fell", () => {
    const order: GoalKey[] = ["combat", "precision"];
    const fitted = reading({ combat: 10_000, precision: 5_000 });
    const planned = reading({ combat: 9_000, precision: 9_000 });

    expect(goalRefuses(order, fitted, planned)).toBe("combat");
  });

  it("stops at a key that ROSE, so nothing below it can overrule the gain", () => {
    const order: GoalKey[] = ["combat", "precision"];
    const fitted = reading({ combat: 10_000, precision: 5_000 });
    const planned = reading({ combat: 12_000, precision: 1_000 });

    expect(goalRefuses(order, fitted, planned)).toBeNull();
  });
});
