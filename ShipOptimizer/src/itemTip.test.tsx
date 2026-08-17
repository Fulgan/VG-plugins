// @vitest-environment jsdom
//
// The tooltip is the densest renderer in the app — headline, substats, aspects, per-stat deltas — so it is where
// a formatting change surfaces as a crash rather than as a wrong number. A render throw here used to blank the
// whole page, which is why this mounts it for real instead of testing the formatters alone.
import { describe, expect, it, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ItemCard, ItemTip } from "./ItemCard";
import type { Item } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
});

const conn = { host: "127.0.0.1", port: "8777", token: "" };

// Shaped like the bridge's own output for a fitted turret, percentage flags included.
const spitter = (attackSpeed: number, cp: number, extra: Partial<Item> = {}): Item => ({
  name: "Plasma Spitter Mk.XVI", rarity: "Exotic", level: 64, size: "Small", type: "Plasma Repeater",
  category: "Turret", slotType: "Hardpoint", damageType: "Energy", gameplayType: "Combat", targetLayer: "Surface",
  manufacturer: "Haleco Systems", sellValue: 149401, volume: 8, aspectSlots: 1,
  fireRate: 1.60975611, powerUsage: 415.47, emp: 149.53241, range: 10.32,
  mainStat: { name: "Combat Power", amount: String(cp) },
  stats: [
    { stat: "Combat Power", amount: cp, multiplier: 1, percent: false },
    { stat: "Precision", amount: 710.897034, multiplier: 1, percent: false },
    { stat: "Attack Speed", amount: attackSpeed, multiplier: 1, percent: true },
  ],
  substats: [
    { stat: "Precision", amount: 710.897034, multiplier: 1, percent: false },
    { stat: "Attack Speed", amount: attackSpeed, multiplier: 1, percent: true },
  ],
  aspects: [{ id: "TurretAddHeatDamage", name: "Firestarter",
              description: "Deals an additional 15% Heat damage over 6 seconds.", stats: [] }],
  ...extra,
} as unknown as Item);

const mount = (node: React.ReactNode) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
};

describe("the item tooltip renders", () => {
  it("a single card, with a percentage substat shown as a percentage", () => {
    const h = mount(<ItemCard it={spitter(0.0140774129, 2991)} conn={conn} imgUrl={null} />);
    expect(h.textContent).toContain("+1.41% Attack Speed");
    expect(h.textContent).toContain("+710.9 Precision");
  });

  it("a comparison card, whose Δ block mixes percentage and absolute rows", () => {
    const a = spitter(0.02944012, 2689);
    const b = spitter(0.0140774129, 2991);
    const h = mount(<ItemCard it={a} conn={conn} imgUrl={null} cmp={b} cmpLabel="Δ vs hovered" />);
    // The Attack Speed delta is 1.54 percentage points. Rendered absolutely it read "+0" and the noise filter
    // discarded it outright, which is how the roll that decided a swap became invisible.
    expect(h.textContent).toContain("1.54%");
    expect(h.textContent).toContain("Δ vs hovered");
  });

  it("the full cursor tooltip with a hovered item, a slot item and other hardpoints", () => {
    const h = mount(
      <ItemTip it={spitter(0.0294, 2689)} x={10} y={10} conn={conn} imgUrl={null}
               vs={spitter(0.0141, 2991)}
               others={[{ it: spitter(0.0068, 3031), label: "slot 1" }]}
               rel={() => ({ pct: 97.4, note: "of best ship DPS", metric: "DPS" })} />,
    );
    expect(h.textContent).toContain("Plasma Spitter Mk.XVI");
    expect(h.textContent).toContain("97.4%");
  });

  it("an item whose stat lines carry no percentage flag at all (older bridge)", () => {
    const bare = spitter(0.0141, 2991, {
      stats: [{ stat: "Attack Speed", amount: 0.0141, multiplier: 1 }],
      substats: [{ stat: "Attack Speed", amount: 0.0141, multiplier: 1 }],
    } as unknown as Partial<Item>);
    const h = mount(<ItemCard it={bare} conn={conn} imgUrl={null} />);
    // No flag means the absolute formatter, which is what it was before — wrong-looking, but not a crash.
    expect(h.textContent).toContain("Attack Speed");
  });

  it("an item with no stats, no substats and no aspects", () => {
    const empty = { name: "Empty", rarity: "Standard", level: 1, category: "Turret", stats: [] } as unknown as Item;
    const h = mount(<ItemCard it={empty} conn={conn} imgUrl={null} />);
    expect(h.textContent).toContain("Empty");
  });
});

//: the Δ panel lists lines the objective CANNOT act on beside ones it can, and a player weighing
// "+3,892 Torpedo Power" against "−1,220 Precision" has no way to know which of the two the app scored.
describe("which Δ lines the objective prices", () => {
  const module_ = (name: string, lines: { stat: string; amount: number }[]): Item => ({
    key: 1, name, rarity: "HighGrade", level: 63, size: "Medium", type: "Hangar Bay", slotType: "HangarBay",
    category: "Module", mainStat: { name: "Hangar Slots", amount: "5" },
    stats: lines.map((l) => ({ ...l, multiplier: 1 })), substats: lines.map((l) => ({ ...l, multiplier: 1 })),
    aspects: [], aspectSlots: 0,
  } as unknown as Item);

  it("marks the unscored ones and says so once", () => {
    const a = module_("a", [{ stat: "Precision", amount: 1_220 }, { stat: "Torpedo Power", amount: 3_892 }]);
    const b = module_("b", [{ stat: "Precision", amount: 0 }, { stat: "Torpedo Power", amount: 0 }]);
    mount(<ItemCard it={a} cmp={b} conn={conn as never} />);
    const rows = [...host!.querySelectorAll(".git-cmp-row")].map((r) => [r.textContent, r.className]);
    const torpedo = rows.find(([t]) => t?.includes("Torpedo Power"))!;
    const precision = rows.find(([t]) => t?.includes("Precision"))!;
    expect(torpedo[1]).toContain("unpriced");     // MODULE_POOLS has no Torpedo Power
    expect(precision[1]).not.toContain("unpriced");
    expect(host!.textContent).toContain("not scored — your call");
  });

  it("says nothing of the sort when every line is scored", () => {
    const a = module_("a", [{ stat: "Precision", amount: 1_220 }]);
    const b = module_("b", [{ stat: "Precision", amount: 10 }]);
    mount(<ItemCard it={a} cmp={b} conn={conn as never} />);
    expect(host!.querySelector(".git-cmp-row.unpriced")).toBeNull();
    expect(host!.textContent).not.toContain("not scored");
  });
});

// Resonance on the card, because it was nowhere a player reads an item: the booster tab put the bonus in a
// TOOLTIP on a chip, so "what does this resonance actually give me" had no answer on the item itself.
describe("resonance on the card", () => {
  const withRes = (r: Item["resonance"]) =>
    mount(<ItemCard it={spitter(0.014, 1000, { category: "Booster", type: "Booster", resonance: r })} conn={conn} imgUrl={null} />);

  it("states the bonus, and how much of it is being paid", () => {
    const el = withRes({ unlocked: false, progress: 25, threshold: 100, unit: "kills",
                         bonus: "+2.22% Reload Speed", bonusStat: "Reload Speed" });
    // No `bonusNow` from this (older) bridge ∴ the full bonus with the fraction said in words.
    expect(el.textContent).toContain("+2.22% Reload Speed");
    expect(el.textContent).toContain("paying 25% of it");
    expect(el.textContent).toContain("25 / 100 kills");
  });

  it("says a finished one is finished rather than showing 100% of something", () => {
    const el = withRes({ unlocked: true, progress: 100, threshold: 100, unit: "ore",
                         bonus: "+180 Cargo Capacity", bonusStat: "Cargo Capacity" });
    expect(el.textContent).toContain("+180 Cargo Capacity");
    expect(el.textContent).toContain("resonance finished");
  });

  // The game's own tooltip shows both figures, and so does this: what it pays today comes from the game
  // (`GetScaledUnlockBonus`), because a percent line is stored fractionally and cannot be rescaled from its text.
  it("shows what it pays now beside the max, when the bridge sends both", () => {
    const el = withRes({ unlocked: false, progress: 221, threshold: 5864, unit: "ore",
                         bonus: "+4.72% Mining Power", bonusNow: "+0.18% Mining Power",
                         bonusAmount: 0, bonusMultiplier: 1.0472, bonusStat: "Mining Power" });
    expect(el.textContent).toContain("+0.18% Mining Power");
    expect(el.textContent).toContain("max +4.72% Mining Power");
    expect(el.textContent).toContain(`221 / ${(5864).toLocaleString()} ore`);
    // and it says WHICH pool a multiplier lifts, which is the whole ship's, not this booster's own
    expect(el.textContent).toContain("scales the ship's whole Mining Power pool");
  });

  it("says nothing at all about resonance on an item that has none", () => {
    const el = mount(<ItemCard it={spitter(0.014, 1000)} conn={conn} imgUrl={null} />);
    expect(el.querySelector(".git-res")).toBeNull();
  });
});
