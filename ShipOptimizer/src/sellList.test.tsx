// @vitest-environment jsdom
//
// The sell list is the surface that spends money, so the two things tested here are the two that cost
// something when wrong: a rule the player wrote must reach the rule set, and NOTHING may sell that the
// player struck off the review list. Everything else about a rule is covered in sellRules.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SellList from "./SellList";
import type { Cats, Kind, Rule, SellListFile } from "./sellRules";
import type { Item } from "./types";

const item = (over: Partial<Item>): Item => ({
  key: 1, slot: 1, identifier: "x", name: "Cutter Mk.X", rarity: "Standard", level: 10,
  size: "Small", slotType: "Hardpoint", type: "Mining Laser", category: "Turret", sellValue: 100,
  aspects: [], stats: [], substats: [], count: 1, location: "armory",
  ...over,
} as unknown as Item);

const ITEMS: Item[] = [
  item({ key: 1, name: "Cutter Mk.X", level: 10, sellValue: 100 }),
  item({ key: 2, name: "Cutter Mk.XI", level: 20, sellValue: 200 }),
  item({ key: 3, name: "Favourite Laser", level: 15, sellValue: 500, favourite: true }),
];
const CATS: Cats = { "mining tools": ["Mining Laser"] };
// Sell anything at level 20 or below: both Cutters, and the favourite only if the guard failed.
const RULE: Rule = {
  id: "r1", where: { l: { min: null, max: 20 } }, group: [],
  order: { f: "l", dir: "asc" }, take: null, having: null,
};

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function render(rules: Rule[], onChange: (n: { defaultKind: Kind; rules: Rule[] }) => void = vi.fn(),
                lists: Record<string, SellListFile> = {},
                onLists: (n: Record<string, SellListFile>) => void = vi.fn(),
                onCats: (c: Cats) => void = vi.fn()) {
  act(() => {
    root.render(<SellList open onClose={() => {}} conn={{ host: "h", port: 1, token: "t" } as never}
      docked items={ITEMS} cats={CATS} myLevel={20} defaultKind="keep" rules={rules}
      onChange={onChange} lists={lists} onLists={onLists} onCats={onCats} onSold={() => {}} />);
  });
}

const buttons = () => [...host.querySelectorAll("button")];
const button = (text: string) =>
  buttons().find((b) => b.textContent?.trim() === text) ?? buttons().find((b) => b.textContent?.includes(text));
const click = (el: Element | undefined, what: string) => {
  if (!el) throw new Error(`no ${what}. buttons: ${buttons().map((b) => b.textContent).join(" | ")}`);
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};
const ticks = () => [...host.querySelectorAll<HTMLInputElement>(".sl-rlist input[type=checkbox]")];

describe("writing a rule", () => {
  it("hands the new rule to the owner of the rule set", () => {
    const onChange = vi.fn();
    render([], onChange);
    click(button("add sell rule"), "the add button");
    click(button("Add rule"), "the commit button");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].rules).toHaveLength(1);
  });

  it("keeps the editor open on discard and leaves the rule set alone", () => {
    const onChange = vi.fn();
    render([], onChange);
    click(button("add sell rule"), "the add button");
    click(button("discard"), "the discard button");
    expect(onChange).not.toHaveBeenCalled();
    expect(button("add sell rule")).toBeTruthy(); // the adder is back, so no draft is left behind
  });
});

describe("the review step", () => {
  it("lists what the rules propose, and never a protected item", () => {
    render([RULE]);
    expect(ticks()).toHaveLength(2);
    expect(host.querySelector(".sl-rlist")!.textContent).not.toContain("Favourite Laser");
    expect(button("Sell 2")).toBeTruthy();
  });

  it("drops a struck-off item from the count, the credits and the sale", () => {
    render([RULE]);
    click(ticks()[0], "the first tick");
    expect(button("Sell 1")).toBeTruthy();
    // 100 + 200 proposed, the 100 struck off
    expect(host.querySelector(".sl-strip")!.textContent).toContain("200 cr");
    expect(host.querySelector(".sl-strip")!.textContent).toContain("1 struck off");
  });

  it("strikes every row off at once, which disables the sale", () => {
    render([RULE]);
    click(button("tick none"), "tick none");
    expect(ticks().every((t) => !t.checked)).toBe(true);
    expect(button("Sell 0")?.hasAttribute("disabled")).toBe(true);
  });

  it("brings a struck-off item back", () => {
    render([RULE]);
    click(ticks()[0], "the first tick");
    click(button("tick all"), "tick all");
    expect(ticks().every((t) => t.checked)).toBe(true);
    expect(button("Sell 2")).toBeTruthy();
  });
});

describe("saved lists (V38)", () => {
  // React reads a controlled input through its OWN value descriptor, so assigning `el.value` and firing an
  // event leaves state untouched — the box shows the text and the component never hears about it.
  const type = (el: HTMLInputElement, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const nameBox = () => host.querySelector<HTMLInputElement>(".sl-lists input:not([type=file])")!;

  it("saves what is on screen under a name, carrying the categories the rules use", async () => {
    const onLists = vi.fn();
    const catRule: Rule = { ...RULE, where: { cat: { values: ["mining tools"], not: false } } };
    render([catRule], vi.fn(), {}, onLists);
    type(nameBox(), "scrap");
    click(button("save"), "save");
    await act(async () => {}); // the save path is async: it may have to ask about an overwrite first
    expect(onLists).toHaveBeenCalledTimes(1);
    const saved = onLists.mock.calls[0][0].scrap as SellListFile;
    expect(saved.rules).toHaveLength(1);
    expect(saved.cats).toEqual({ "mining tools": ["Mining Laser"] }); // self-contained, or it breaks silently
  });

  it("refuses to save an empty rule set or a nameless list", () => {
    render([]);
    expect(button("save")?.hasAttribute("disabled")).toBe(true); // no name yet
    type(nameBox(), "scrap");
    expect(button("save")?.hasAttribute("disabled")).toBe(true); // named, but nothing to save
  });

  it("loads a saved list, replacing the stance and the rules", async () => {
    const onChange = vi.fn();
    const file: SellListFile = {
      v: 1, name: "keep-good", defaultKind: "sell",
      rules: [{ ...RULE, id: "r9" }], cats: {},
    };
    render([], onChange, { "keep-good": file });     // no current rules ∴ no confirm to clear
    click(button("keep-good"), "the saved list");
    await act(async () => {});
    expect(onChange).toHaveBeenCalledWith({ defaultKind: "sell", rules: file.rules });
  });

  it("merges an imported list's categories without overwriting the player's own", async () => {
    const onCats = vi.fn(), onChange = vi.fn();
    const file: SellListFile = {
      v: 1, name: "shared", defaultKind: "keep",
      rules: [{ ...RULE, where: { cat: { values: ["EMP"], not: false } } }],
      cats: { EMP: ["Ion Cannon"], "mining tools": ["Something Else"] },
    };
    render([], onChange, { shared: file }, vi.fn(), onCats);
    click(button("shared"), "the saved list");
    await act(async () => {});
    expect(onCats).toHaveBeenCalledWith({ "mining tools": ["Mining Laser"], EMP: ["Ion Cannon"] });
    expect(host.querySelector(".sum-msg")!.textContent).toContain("EMP");
  });
});
