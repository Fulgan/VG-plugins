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
