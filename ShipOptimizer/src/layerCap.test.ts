import { describe, it, expect } from "vitest";
import { layerRefuses, projectLayer, DEFAULT_LAYER_CAP, LAYER_LABEL, type LayerReading } from "./fleetDps";
import type { Item } from "./types";

// HOW MUCH OF A LAYER A PLAN MAY SPEND — the one defensive rule that is not an exchange rate.
//
// The complaint this answers: "it wants me to cut the shields and hull in half for a small DPS gain". A ranked
// ORDER cannot answer it, because an order with Combat first never reads the hull key on a plan whose combat
// power went UP. What a player can state without inventing a rate between damage and survival is a refusal to be
// wrecked: whatever the gain, not more than this share of a layer.
//
// PER LAYER, never a summed effective HP: shields absorb first, armor has its own weak/resist table, and hull is
// what is left. A total hides one layer emptying while another rises.

const kit = (name: string, stat: string, add: number, mul = 1): Item => ({
  key: 1, slot: 1, name, rarity: "Exotic", level: 64, size: "Large", type: "Hull", slotType: "Hull",
  category: "Module", sellValue: 0, powerUsage: 0, powerUsageBase: 0,
  stats: mul !== 1 ? [{ stat, amount: 0, multiplier: mul }] : [{ stat, amount: add, multiplier: 1 }],
  aspects: [], substats: [], bonus: null, bonusStat: null,
} as unknown as Item);

const now: LayerReading = { hull: 4_246_217, armor: 25_202, shield: 6_274_451 };

describe("the defensive cap", () => {
  it("refuses the plan the player objected to, and names the layer and the size of the loss", () => {
    const halved = layerRefuses(now, { ...now, shield: 3_137_225 });
    expect(halved).not.toBeNull();
    expect(halved!.layer).toBe("shield");
    expect(halved!.drop).toBeCloseTo(0.5, 3);
    expect(LAYER_LABEL[halved!.layer]).toBe("Shield");
  });

  it("allows a loss inside the cap — it is a cap, not a ban on ever spending a layer", () => {
    // The plan actually applied on the live Monsoon: hull 4,246,217 -> 3,872,747, a 8.8% loss.
    expect(layerRefuses(now, { ...now, hull: 3_872_747 })).toBeNull();
    expect(DEFAULT_LAYER_CAP).toBe(0.10);
  });

  it("guards each layer on its own — a rising shield does not buy an emptied armor", () => {
    const r = layerRefuses(now, { hull: now.hull, armor: 10_000, shield: 9_000_000 });
    expect(r?.layer).toBe("armor");
  });

  it("reports the WORST layer when several fall, so the note names the one that decided", () => {
    const r = layerRefuses(now, { hull: 3_000_000, armor: 5_000, shield: 6_000_000 });
    expect(r?.layer).toBe("armor");          // -80% beats hull's -29%
  });

  it("orders nothing where a layer has no reading — absent is not destroyed", () => {
    // A ship with no armor module, and a bridge that has not served vitals at all.
    expect(layerRefuses({ hull: 1_000, armor: null, shield: null }, { hull: 1_000, armor: null, shield: null })).toBeNull();
    expect(layerRefuses({}, {})).toBeNull();
    expect(layerRefuses({ hull: 0 }, { hull: 0 })).toBeNull();   // no reading to take a fraction of
  });

  it("ignores a gain — a layer going UP is never a refusal", () => {
    expect(layerRefuses(now, { ...now, hull: 8_000_000 })).toBeNull();
  });

  it("projects a layer through the game's own figure rather than re-summing item lines", () => {
    // The reported total already carries the game's scaling passes (rank x escalation x hpBalance, measured at
    // x8.57 on a Legendary level-60 unit), so only the RATIO between two builds is ours to compute. Swapping a
    // x149 hull kit for a x75 one halves the reading; adding the raw lines instead would move it by ~2,000.
    const before = [kit("Hull Kit Mk.XVIII", "Hull HP", 0, 149)];
    const after = [kit("Hull Kit Mk.X", "Hull HP", 0, 74.5)];
    const projected = projectLayer(4_246_217, "Hull HP", before, after)!;
    expect(projected).toBeCloseTo(4_246_217 / 2, 0);
    expect(layerRefuses({ hull: 4_246_217 }, { hull: projected })?.layer).toBe("hull");
  });

  it("leaves the reading alone when no line for that layer moves", () => {
    const same = [kit("Hull Kit", "Hull HP", 0, 149)];
    expect(projectLayer(4_246_217, "Hull HP", same, same)).toBe(4_246_217);
  });
});
