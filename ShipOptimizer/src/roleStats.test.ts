// What a stat is worth on a ship that cannot use it: nothing, and the comparator must not count it.
import { describe, it, expect } from "vitest";
import { statApplies } from "./roleStats";

describe("statApplies", () => {
  it("drops a drone stat on a hull with no drone bay", () => {
    expect(statApplies("Drone Power", { hasDroneBay: false })).toBe(false);
    expect(statApplies("Drone Power", { hasDroneBay: true })).toBe(true);
  });

  it("drops an activity's stats only when the ship neither has the role NOR carries the gun", () => {
    expect(statApplies("Salvage Power", { role: "Combat", activities: ["Combat"] })).toBe(false);
    expect(statApplies("Salvage Power", { role: "Salvaging", activities: ["Combat"] })).toBe(true);
    // A combat hull with a mining laser fitted DOES mine — the fit decides, not the hull's label.
    expect(statApplies("Mining Power", { role: "Combat", activities: ["Combat", "Mining"] })).toBe(true);
  });

  it("keeps everything it has no reason to drop", () => {
    expect(statApplies("Hull HP", { role: "Combat", activities: ["Combat"] })).toBe(true);
    expect(statApplies("Combat Power", { role: "Mining", activities: ["Mining"] })).toBe(true);
    expect(statApplies("Drone Power", null)).toBe(true);   // nothing known about the ship: assume it counts
  });
});
