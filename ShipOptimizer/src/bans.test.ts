import { describe, it, expect } from "vitest";
import { itemSignature, officerBanKey } from "./bans";
import type { Item } from "./types";

const item = (over: Partial<Item> = {}): Item => ({
  key: 1, slot: null, name: "Reactor Mk.XVI", rarity: "HighGrade", level: 64, size: "Large",
  type: "Reactor", category: "Module", sellValue: 0, aspects: [], stats: [],
  substats: [{ stat: "Hull HP", amount: 1611 }], bonus: null, bonusStat: null,
  aspectSlots: 1, mainStat: { name: "Energy", amount: "20,000" },
  ...over,
} as unknown as Item);

// The signature is what makes an item THIS item: name, type, main stat, substats and slots. Where it happens to
// sit is not part of it — an earlier key carried the store handle, and refusing one copy of an offer simply
// promoted the next into the same row.
describe("an item's signature", () => {
  it("ignores where the item sits, so two copies are one item", () => {
    expect(itemSignature(item({ location: "armory", key: 42 })))
      .toBe(itemSignature(item({ location: "shop:hangar", key: 7 })));
  });

  it("separates two rolls of one name by their substats", () => {
    const a = item({ substats: [{ stat: "Hull HP", amount: 1611 }] as never });
    const b = item({ substats: [{ stat: "Hull HP", amount: 1899 }] as never });
    expect(itemSignature(a)).not.toBe(itemSignature(b));
  });

  // The game states substats in whatever order it rolled them, and a player does not read them as ordered.
  it("does not care what order the substats arrive in", () => {
    const one = [{ stat: "Hull HP", amount: 1611 }, { stat: "Precision", amount: 22 }] as never;
    const other = [{ stat: "Precision", amount: 22 }, { stat: "Hull HP", amount: 1611 }] as never;
    expect(itemSignature(item({ substats: one }))).toBe(itemSignature(item({ substats: other })));
  });

  // A station stocked one name in three sizes, all sharing the type "Reactor": size is the only thing that
  // separated them, and it decides which slot the item can go in at all.
  it("separates one name in three sizes", () => {
    const sizes = ["Small", "Medium", "Large"].map((size) => itemSignature(item({ size })));
    expect(new Set(sizes).size).toBe(3);
  });

  it("takes in the type, level, rarity, main stat, aspects and slot count", () => {
    const base = itemSignature(item());
    expect(itemSignature(item({ type: "Engine" }))).not.toBe(base);
    expect(itemSignature(item({ level: 63 }))).not.toBe(base);
    expect(itemSignature(item({ rarity: "Legendary" }))).not.toBe(base);
    expect(itemSignature(item({ mainStat: { name: "Energy", amount: "21,000" } }))).not.toBe(base);
    expect(itemSignature(item({ aspects: [{ name: "Solar Powered", description: "" }] as never }))).not.toBe(base);
    expect(itemSignature(item({ aspectSlots: 2 }))).not.toBe(base);
    expect(itemSignature(item({ bonus: 20 }))).not.toBe(base);   // workshop quality
  });

  it("keeps an officer's key clear of an item's", () => {
    expect(officerBanKey({ guid: "abc" })).toBe("o:abc");
    expect(officerBanKey({ guid: "abc" })).not.toBe(itemSignature(item({ name: "abc" })));
  });
});
