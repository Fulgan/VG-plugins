// @vitest-environment jsdom
//
// Dropping an item on a slot is a GESTURE over an operation that already exists, so what is worth pinning is
// the wiring: that a slot only becomes a target while a drag is in flight, that the drop hands the caller the
// item that was picked up, and that a card given no handler stays inert however hard it is dragged over.
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SlotCard from "./SlotCard";
import { beginDrag, endDrag } from "./dragItem";
import type { Item } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => { endDrag(); });
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
  endDrag();
});

const mount = (node: React.ReactNode) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
};

const booster = (name: string): Item =>
  ({ name, rarity: "Exotic", level: 60, category: "Booster", stats: [], substats: [], aspects: [] } as unknown as Item);

// jsdom has no DataTransfer, and React reads `dataTransfer` off the native event, so the drag events carry a
// stand-in with only the two members the card touches.
const dragEvent = (type: string) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { dropEffect: "none", setData: () => {}, getData: () => "" } });
  return e;
};

const card = (props: Partial<React.ComponentProps<typeof SlotCard>> = {}) =>
  <SlotCard title="Slot 1" current={<i>cur</i>} next={<i>next</i>} {...props} />;

describe("a slot card as a drop target", () => {
  it("is not a target until something is actually being dragged", () => {
    const dropped: Item[] = [];
    const h = mount(card({ onDropItem: (it) => dropped.push(it) }));
    const panel = h.querySelector(".gear-panel")!;
    expect(panel.className).not.toContain("dropready");

    act(() => beginDrag(booster("Combat R-Booster")));
    // Every slot says so at once, so the player can see where the thing can go before aiming at one.
    expect(panel.className).toContain("dropready");

    act(() => endDrag());
    expect(panel.className).not.toContain("dropready");
  });

  it("hands the caller the item that was picked up, and clears the drag", () => {
    const dropped: Item[] = [];
    const h = mount(card({ onDropItem: (it) => dropped.push(it) }));
    const panel = h.querySelector(".gear-panel")!;
    const b = booster("Combat R-Booster");

    act(() => beginDrag(b));
    act(() => { panel.dispatchEvent(dragEvent("dragover")); });
    expect(panel.className).toContain("droptgt");

    act(() => { panel.dispatchEvent(dragEvent("drop")); });
    expect(dropped).toEqual([b]);
    // The highlight and the held item both go, so a drop that ends outside a list cannot leave a slot armed.
    expect(panel.className).not.toContain("droptgt");
    expect(panel.className).not.toContain("dropready");
  });

  it("stays inert on a card whose caller has no list to drag from", () => {
    const h = mount(card());                       // no onDropItem
    const panel = h.querySelector(".gear-panel")!;
    act(() => beginDrag(booster("Combat R-Booster")));
    expect(panel.className).not.toContain("dropready");
    act(() => { panel.dispatchEvent(dragEvent("dragover")); });
    expect(panel.className).not.toContain("droptgt");
  });
});
