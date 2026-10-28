// @vitest-environment jsdom
//
// The hover card is shared by everything that is not an item or an officer, so a change to it lands on aspects
// and skills at once. Two things are pinned here and neither is cosmetic: that a card states a WORTH only when
// there is one to state, and that a card can never open inside another one.
import { describe, expect, it, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AspectMark, { AspectMarks } from "./AspectMark";
import { InfoTip } from "./HoverCard";
import { Vig } from "./SlotCard";
import type { Aspect, Item } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
});

const conn = { host: "127.0.0.1", port: "8777", token: "" };

const mount = (node: React.ReactNode) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
};

// React synthesises enter/leave from mouseover/mouseout, so this is what a pointer arriving looks like to it.
const enter = (el: Element) => act(() => {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, clientX: 40, clientY: 40 }));
});

const asp = (name: string, description: string): Aspect =>
  ({ id: name.replace(/\s/g, ""), name, description, stats: [] } as unknown as Aspect);

describe("the hover card", () => {
  it("draws a worth line only when there is a worth", () => {
    const withWorth = mount(<InfoTip x={0} y={0} head="Firestarter" worth="+15% damage" desc="does a thing" />);
    expect(withWorth.querySelector(".skill-tip-worth")?.textContent).toBe("+15% damage");

    act(() => root!.unmount());
    root = createRoot(host!);
    act(() => root!.render(<InfoTip x={0} y={0} head="Firestarter" desc="does a thing" />));
    // NOT an empty element: a skill nothing could price and a skill priced at nothing have to be different
    // pixels, or an absent figure reads as "checked, and it comes to nothing" for the case never examined.
    expect(host!.querySelector(".skill-tip-worth")).toBeNull();
  });
});

describe("an aspect", () => {
  it("opens a card carrying the computed worth, and no native title", () => {
    const h = mount(<AspectMark conn={conn} aspect={asp("Firestarter", "Deals an additional 15% Heat damage over 6 seconds.")} />);
    const mark = h.querySelector(".asp-mark")!;
    // The native attribute is gone: the card replaces it, and both at once is one thing tooltipped twice.
    expect(mark.getAttribute("title")).toBeNull();
    expect(h.querySelector(".skill-tip")).toBeNull();

    enter(mark);
    expect(h.querySelector(".skill-tip-head")?.textContent).toBe("Firestarter");
    expect(h.querySelector(".skill-tip-worth")?.textContent).toBe("+15% damage, over time");
    expect(h.querySelector(".skill-tip-desc")?.textContent).toContain("15% Heat damage");
  });

  it("names the gap for an area effect rather than drawing it as a zero", () => {
    const h = mount(<AspectMark conn={conn} aspect={asp("Volatile Plasma",
      "5% chance on hit to trigger a plasma explosion, dealing 200% damage to nearby enemies.")} />);
    enter(h.querySelector(".asp-mark")!);
    const worth = h.querySelector(".skill-tip-worth")?.textContent ?? "";
    expect(worth).toContain("area damage");
    expect(worth).not.toContain("0%");
  });
});

describe("two cards cannot be open at once, because", () => {
  it("a vignette keeps its aspect marks outside the element that opens the item card", () => {
    const it = {
      name: "Plasma Spitter", rarity: "Exotic", level: 64, size: "Small", category: "Turret",
      aspects: [asp("Firestarter", "Deals an additional 15% Heat damage over 6 seconds.")], aspectSlots: 2,
      stats: [], substats: [],
    } as unknown as Item;
    const h = mount(
      <Vig it={it} conn={conn} sub="Energy" extra={<AspectMarks conn={conn} aspects={it.aspects} slots={it.aspectSlots} />} />,
    );
    // `vig-hov` and the name are the item card's target. A mark inside either would put an aspect card and an
    // item card under the same pointer, each convinced it is the one being asked about.
    for (const target of [".vig-hov", ".gear-vig-name"]) {
      const el = h.querySelector(target);
      expect(el, target).not.toBeNull();
      expect(el!.querySelector(".asp-mark"), target).toBeNull();
    }
    expect(h.querySelector(".gear-vig-asps .asp-mark")).not.toBeNull();
  });
});
