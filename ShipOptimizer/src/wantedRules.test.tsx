// @vitest-environment jsdom
//
// The shopping list's editor. What is tested is what a player would notice being wrong: the rule reads back as
// the sentence it selects, the count beside it is what it claims HERE, and a fresh rule claims nothing — the
// alternative being the whole shop floor arriving on the rail with buy buttons the moment one is added.
// The clauses themselves are covered in wantRules.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import WantedRules from "./WantedRules";
import type { FieldCtx } from "./sellRules";
import type { WantRule } from "./wantRules";
import type { Item } from "./types";

const item = (over: Partial<Item>): Item => ({
  key: 1, slot: 1, identifier: "x", name: "Rail Cannon", rarity: "Legendary", level: 42,
  size: "Large", slotType: "Hardpoint", type: "Rail Cannon", category: "Turret", sellValue: 100,
  cost: 100_000, location: "shop:general", aspects: [], stats: [], substats: [], count: 1,
  ...over,
} as unknown as Item);

const OFFERS: Item[] = [
  item({ key: 1, name: "Rail Cannon", rarity: "Legendary" }),
  item({ key: 2, name: "Cutter Mk.XI", rarity: "Standard", type: "Mining Laser" }),
];
const CTX: FieldCtx = { cats: {}, myLevel: 40, owned: { "Rail Cannon": 1 } };

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function render(rules: WantRule[], onChange: (n: WantRule[]) => void = vi.fn()) {
  act(() => {
    root.render(<WantedRules rules={rules} onChange={onChange} offers={OFFERS} vocabulary={OFFERS} ctx={CTX} />);
  });
}

const buttons = () => [...host.querySelectorAll("button")];
const button = (text: string) => buttons().find((b) => b.textContent?.includes(text));
const click = (el: Element | undefined, what: string) => {
  if (!el) throw new Error(`no ${what}. buttons: ${buttons().map((b) => b.textContent).join(" | ")}`);
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};

describe("the shopping list editor", () => {
  it("reads a rule back as the sentence it selects, with what it claims here", () => {
    render([{ id: "w1", where: { r: { values: ["Legendary"] }, own: { max: 1 } } }]);
    expect(host.textContent).toContain("Flag everything Legendary that I already own at most 1 of.");
    // One of the two offers is Legendary, and one copy is owned, so the clause still holds.
    expect(host.textContent).toContain("1 on offer here");
  });

  it("says a fresh rule matches nothing, rather than claiming the shop", () => {
    render([{ id: "w1", where: {} }]);
    expect(host.textContent).toContain("no filters yet — matches nothing");
    expect(host.textContent).not.toContain("on offer here");
  });

  // A clause the player cannot change is a clause they have to delete and rebuild, and the picker used to hide
  // any field — and any ticked value — the items in front of it did not happen to vary by. A rule written at
  // another station is exactly that case.
  it("lets a clause be edited even when nothing on offer varies by its field or carries its value", () => {
    // Both offers are Large, so `size` varies by nothing; and neither is a Mining Laser of Exotic quality.
    render([{ id: "w1", where: { s: { values: ["Small"] } } }]);
    const chip = host.querySelector(".sl-chip button.sl-vals-edit");
    expect(chip?.textContent).toBe("Small");

    click(chip ?? undefined, "the clause's values");
    const pop = host.querySelector(".sl-pop");
    expect(pop, "clicking the values opens the picker").toBeTruthy();
    // The field is offered despite not varying, it is the one selected, and the ticked value is listed even
    // though no offer has it — so it can be seen and cleared.
    expect([...pop!.querySelectorAll(".sl-field.sel")].map((b) => b.textContent)).toEqual(["size"]);
    const ticked = [...pop!.querySelectorAll(".sl-val.on")].map((b) => b.textContent?.replace("✓ ", ""));
    expect(ticked).toEqual(["Small"]);
  });

  // Two clauses over one field are an AND of two lists, which one tick list cannot say: "any of these AND any
  // of those" is the shape a shopping list is written in.
  it("writes a SECOND clause about a field the rule already names", () => {
    const onChange = vi.fn();
    render([{ id: "w1", where: { r: { values: ["Legendary"] } } }], onChange);
    click(host.querySelector(".sl-chip button.sl-vals-edit") ?? undefined, "the clause's values");
    const slots = [...host.querySelectorAll(".sl-slot")].map((b) => b.textContent?.trim());
    expect(slots).toEqual(["1. Legendary", "＋ another quality filter"]);

    click(button("another quality filter"), "the second clause");
    click([...host.querySelectorAll(".sl-val")].find((b) => b.textContent?.includes("Standard")), "a value");
    expect(onChange).toHaveBeenCalledWith([
      { id: "w1", where: { r: { values: ["Legendary"] }, "r#2": { values: ["Standard"], not: false } } },
    ]);
  });

  // A shopping list is written about what you do NOT own, so its value lists cannot come from the rows in front
  // of it: with two offers on the rail, `type` offered two of the game's types.
  it("offers every type the GAME has, not the ones this station stocks", () => {
    const catalog = {
      values: { t: ["Rail Cannon", "Ion Cannon", "Reactor"], dt: ["Kinetic", "Ion"] },
      slotOfType: { "Rail Cannon": "Hardpoint", "Ion Cannon": "Hardpoint", Reactor: "Reactor" },
    };
    act(() => {
      root.render(<WantedRules rules={[{ id: "w1", where: { s: { values: ["Large"] } } }]} onChange={vi.fn()}
                               offers={OFFERS} vocabulary={OFFERS} catalog={catalog} ctx={CTX} />);
    });
    click(host.querySelector(".sl-chip button.sl-vals-edit") ?? undefined, "the clause's values");
    click([...host.querySelectorAll(".sl-field")].find((b) => b.textContent === "type"), "the type field");
    const vals = [...host.querySelectorAll(".sl-val")].map((b) => b.textContent?.replace("✓ ", "").trim());
    expect(vals).toContain("Ion Cannon");       // nothing here has one, and that is the point
    expect(vals).toContain("Rail Cannon");      // on offer, listed once
    expect(vals.filter((v) => v === "Rail Cannon")).toHaveLength(1);
    // What is NOT in stock says so, rather than reading like part of the shop floor.
    const away = [...host.querySelectorAll(".sl-val.away")].map((b) => b.textContent?.trim());
    expect(away).toContain("Ion Cannon");
    expect(away).not.toContain("Rail Cannon");
    // And a type nobody owns still lands under the slot it mounts in.
    const groups = [...host.querySelectorAll(".sl-sub")].map((d) => d.textContent);
    expect(groups).toContain("Hardpoint");
    expect(groups).toContain("Reactor");
  });

  it("offers a field the catalog can vary even when nothing here does", () => {
    // Both offers are Kinetic ∴ the vary test hides `damage` — right for a sell rule, wrong for a want.
    const catalog = { values: { dt: ["Kinetic", "Ion", "Thermal"] } };
    act(() => {
      root.render(<WantedRules rules={[{ id: "w1", where: {} }]} onChange={vi.fn()}
                               offers={OFFERS} vocabulary={OFFERS} catalog={catalog} ctx={CTX} />);
    });
    click(button("narrow it down"), "the picker");
    const fields = [...host.querySelectorAll(".sl-field")].map((b) => b.textContent);
    expect(fields).toContain("damage");
  });

  it("adds and drops rules through the caller", () => {
    const onChange = vi.fn();
    render([], onChange);
    click(button("add a want"), "add button");
    expect(onChange).toHaveBeenCalledWith([{ id: "w1", where: {} }]);

    onChange.mockClear();
    render([{ id: "w1", where: { r: { values: ["Legendary"] } } }], onChange);
    click(button("×"), "drop button");
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
