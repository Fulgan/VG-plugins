// @vitest-environment jsdom
//
// "NOTHING CHANGES IN THIS SLOT" HAS ONE RENDERING, AND THE CONTROL OWNS IT.
//
// The three tabs that fit something into a numbered slot had drifted into two answers: the booster tab blanked
// the target side and said `kept`, the gear tab left the item in place with a small "changes nothing" under it.
// Both are readable on their own. Together they mean one screen answers "did this slot change" two ways, and a
// grid of cards that each repeat their own current side hides the one slot that actually moved.
//
// So `unchanged` overrides the item, and these tests pin that it is the CONTROL deciding rather than each
// caller: what a caller still owns is the COMPARISON, because only it knows whether two turrets, two boosters
// or two officers are the same thing.
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SlotCard, { NewVig, KeptVig, SlotLock } from "./SlotCard";
import type { Item } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null; host = null;
});

function render(node: React.ReactNode): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const conn = { host: "127.0.0.1", port: "8777", token: "" };
const item = { key: 1, slot: 1, name: "Vindicator Railgun", rarity: "Legendary", level: 60 } as unknown as Item;

describe("the unchanged slot", () => {
  it("does NOT repeat the item, whatever it was handed", () => {
    const el = render(<NewVig it={item} unchanged conn={conn} onHover={() => {}} />);
    expect(el.textContent).toContain("kept");
    // The whole point: a target side that names the item reads as a swap at a glance.
    expect(el.textContent).not.toContain("Vindicator Railgun");
  });

  it("is not marked as a proposal, so the row's green does not claim a change", () => {
    const el = render(<NewVig it={item} unchanged conn={conn} onHover={() => {}} />);
    expect(el.querySelector(".gear-vig.best")).toBeNull();
  });

  it("still says whose decision it was, because a pin is one even when it changes nothing", () => {
    expect(render(<KeptVig mine />).textContent).toContain("locked");
    expect(render(<KeptVig />).textContent).toContain("new");
  });

  it("renders the item normally when it is a real change", () => {
    const el = render(<NewVig it={item} conn={conn} onHover={() => {}} />);
    expect(el.textContent).toContain("Vindicator Railgun");
    expect(el.querySelector(".gear-vig.best")).not.toBeNull();
  });

  it("a slot with no proposal at all is not the same state as an unchanged one", () => {
    // `keep current` means the optimizer had nothing to offer; `kept` means it offered what is already there.
    // Collapsing them would lose the difference between "no candidate" and "the candidate is what you have".
    const el = render(<NewVig it={null} conn={conn} onHover={() => {}} />);
    expect(el.textContent).toContain("keep current");
    expect(el.textContent).not.toContain("kept");
  });
});

// THE SWAP DIRECTION IS A PROPERTY OF THE CONTENT, NOT OF THE TAB.
//
// A card whose vignettes are tall (an officer's portrait over a wrapping row of skill chips) reads as two
// narrow columns side by side with the width left empty, worst where one side is a one-line `kept`. Two short
// lines (a turret, a booster) read better across. The arrow has to agree with whichever it is, or the card
// points one way and flows the other.
describe("stacked slot cards", () => {
  it("points the arrow the way the card reads", () => {
    expect(render(<SlotCard title="Slot 1" current={<i />} next={<i />} stack />).textContent).toContain("▼");
    expect(render(<SlotCard title="Slot 1" current={<i />} next={<i />} />).textContent).toContain("→");
  });

  it("marks the swap so the vignettes stop splitting the card's height", () => {
    // Without this the one-line `kept` box is stretched to match the portrait above it, which is the empty
    // box the stacking was meant to remove.
    const el = render(<SlotCard title="Slot 1" current={<i />} next={<i />} stack />);
    expect(el.querySelector(".gear-swap.stack")).not.toBeNull();
    expect(render(<SlotCard title="Slot 1" current={<i />} next={<i />} />).querySelector(".gear-swap.stack")).toBeNull();
  });
});

// ONE SWITCH, ONE WORD, EVERY TAB. The three tabs had a pin badge, a lock toggle and a lightning bolt between
// them for what is two states: the optimizer chooses this slot, or it does not. A player cannot be expected to
// tell apart controls that do the same thing under different names, so there is one control and it is called
// what people already call it.
describe("the slot lock", () => {
  it("says which state it is in, and what pressing it would do", () => {
    const on = render(<SlotLock locked onToggle={() => {}} />);
    expect(on.textContent).toContain("locked");
    expect(on.querySelector("button")?.title).toBe("Unlock: let the optimizer choose this slot");

    const off = render(<SlotLock locked={false} onToggle={() => {}} what="Reactor Mk.XIX" />);
    // Names the thing it would hold, not the mechanism.
    expect(off.querySelector("button")?.title).toBe("Lock this slot to Reactor Mk.XIX");
  });

  it("carries the lit class only when locked, so the head reads at a glance", () => {
    expect(render(<SlotLock locked onToggle={() => {}} />).querySelector(".slot-lock.on")).not.toBeNull();
    expect(render(<SlotLock locked={false} onToggle={() => {}} />).querySelector(".slot-lock.on")).toBeNull();
  });
});
