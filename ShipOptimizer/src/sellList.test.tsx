// @vitest-environment jsdom
//
// The sell list is the surface that spends money, so the two things tested here are the two that cost
// something when wrong: a rule the player wrote must reach the rule set, and NOTHING may sell that the
// player struck off the review list. Everything else about a rule is covered in sellRules.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import SellList from "./SellList";
import { api, ApiError } from "./api";
import type { Cats, Kind, Rule, SellListFile } from "./sellRules";
import { emptyView, type ViewState } from "./sellView";
import type { Item } from "./types";

const item = (over: Partial<Item>): Item => ({
  key: 1, slot: 1, identifier: "x", name: "Cutter Mk.X", rarity: "Standard", level: 10,
  size: "Small", slotType: "Hardpoint", type: "Mining Laser", category: "Turret", sellValue: 100,
  aspects: [], stats: [], substats: [], count: 1, location: "armory",
  ...over,
} as unknown as Item);

const ITEMS: Item[] = [
  item({ key: 1, name: "Cutter Mk.X", level: 10, sellValue: 100 }),
  // Large, so one field tells the two proposed rows apart: a view control is only offered where it says
  // something, and every other fact about these two is identical.
  item({ key: 2, name: "Cutter Mk.XI", level: 20, sellValue: 200, size: "Large" }),
  item({ key: 3, name: "Favourite Laser", level: 15, sellValue: 500, favourite: true }),
];
const CATS: Cats = { "mining tools": ["Mining Laser"] };
// Sell anything at level 20 or below: both Cutters, and the favourite only if the guard failed.
const RULE: Rule = {
  id: "r1", where: { l: { min: null, max: 20 } }, group: [],
  order: { f: "l", dir: "asc" }, take: null, having: null,
};

let host: HTMLDivElement, root: Root;
// The view is the component's own layout state, held here the way the app holds it: a control that changes it
// re-renders with the new value, so a test can click a header and read what moved.
let view: ViewState;
beforeEach(() => { view = emptyView(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

type Args = [Rule[], (n: { defaultKind: Kind; rules: Rule[] }) => void, Record<string, SellListFile>,
             (n: Record<string, SellListFile>) => void, (c: Cats) => void];

// The view is state the app owns, so the harness owns it too: a view control re-renders with the new value
// in place, which is what lets a test click a column header and read what moved.
const tree = (...[rules, onChange, lists, onLists, onCats]: Args) => (
  <SellList open onClose={() => {}} conn={{ host: "h", port: 1, token: "t" } as never}
    docked items={ITEMS} cats={CATS} myLevel={20} defaultKind="keep" rules={rules}
    onChange={onChange} lists={lists} onLists={onLists} onCats={onCats} onSold={() => {}}
    view={view} onView={(v) => { view = v; root.render(tree(rules, onChange, lists, onLists, onCats)); }} />
);

function render(rules: Rule[], onChange: (n: { defaultKind: Kind; rules: Rule[] }) => void = vi.fn(),
                lists: Record<string, SellListFile> = {},
                onLists: (n: Record<string, SellListFile>) => void = vi.fn(),
                onCats: (c: Cats) => void = vi.fn()) {
  act(() => { root.render(tree(rules, onChange, lists, onLists, onCats)); });
}

const buttons = () => [...host.querySelectorAll("button")];
const button = (text: string) =>
  buttons().find((b) => b.textContent?.trim() === text) ?? buttons().find((b) => b.textContent?.includes(text));
const click = (el: Element | undefined, what: string) => {
  if (!el) throw new Error(`no ${what}. buttons: ${buttons().map((b) => b.textContent).join(" | ")}`);
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};
const ticks = () => [...host.querySelectorAll<HTMLInputElement>(".sl-rlist input[type=checkbox]")];
// React reads a controlled input through its OWN value descriptor, so assigning `el.value` and firing an
// event leaves state untouched — the box shows the text and the component never hears about it.
const type = (el: HTMLInputElement, v: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("writing a rule", () => {
  it("hands the new rule to the owner of the rule set", () => {
    const onChange = vi.fn();
    render([], onChange);
    click(button("add sell rule"), "the add button");
    click(button("Add rule"), "the commit button");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].rules).toHaveLength(1);
  });

  it("the adder writes the same sentence the chip reads back", () => {
    const onChange = vi.fn();
    render([], onChange);
    click(button("add sell rule"), "the add button");
    click(button("narrow it down"), "the picker");
    click(button("level vs mine"), "the field");
    type(host.querySelector<HTMLInputElement>(".sl-pkrow input[type=number]")!, "10");
    click(button("add"), "the adder");            // defaults: at least / below
    expect(host.querySelector(".sl-chip")!.textContent).toContain("levels");
    click(button("Add rule"), "the commit button");
    const rules = onChange.mock.calls.at(-1)![0].rules as Rule[];
    expect(rules.at(-1)!.where.lrel).toEqual({ min: null, max: -10 });
  });

  it("keeps an edited rule IN EFFECT until the edit is added", () => {
    // Taking it out of the set while it was open in the editor was a trap with money attached: the rule row
    // vanished, the draft said "not applied yet", and a sale run in that state ignored the rule entirely.
    const onChange = vi.fn();
    render([RULE], onChange);
    click(button("edit"), "the edit button");
    expect(onChange).not.toHaveBeenCalled();                 // the rule set is untouched by opening an editor
    expect(host.querySelector(".sl-rule.editing")).toBeTruthy();
    click(button("Add rule"), "the commit button");
    const rules = onChange.mock.calls.at(-1)![0].rules as Rule[];
    expect(rules).toHaveLength(1);                           // replaced in place, not appended beside itself
    expect(rules[0].id).toBe(RULE.id);
  });

  it("leaves the original alone when the edit is discarded", () => {
    const onChange = vi.fn();
    render([RULE], onChange);
    click(button("edit"), "the edit button");
    click(button("discard"), "discard");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("flips a comparison in place, since the picker can only ever ADD a bound", () => {
    const onChange = vi.fn();
    render([{ ...RULE, where: { v: { min: null, max: 500 } } }], onChange);
    click(button("edit"), "the edit button");        // pulls the rule into the draft
    click(button("or less"), "the comparison word");
    click(button("Add rule"), "the commit button");
    const rules = onChange.mock.calls.at(-1)![0].rules as Rule[];
    expect(rules.at(-1)!.where.v).toEqual({ min: 500, max: null });
  });

  it("reads a relative level as a direction and a distance, with every word a control", () => {
    // "-10, or less, vs mine" is arithmetic. "at least 10 levels below mine" is the rule.
    render([{ ...RULE, where: { lrel: { min: null, max: -10 } } }]);
    click(button("edit"), "the edit button");
    const chip = host.querySelector(".sl-chip")!;
    const sels = [...chip.querySelectorAll<HTMLSelectElement>("select")].map((s) => s.value);
    expect(sels).toEqual(["at least", "below"]);
    expect(chip.querySelector<HTMLInputElement>("input")!.value).toBe("10");
    expect(chip.textContent).toContain("mine");
    expect(host.querySelector(".sl-abs")!.textContent).toBe("= Lv 10 or less");   // myLevel 20
  });

  it("says the distance-free readings whole: no number to type for 'at or below mine'", () => {
    render([{ ...RULE, where: { lrel: { min: null, max: 0 } } }]);
    click(button("edit"), "the edit button");
    const chip = host.querySelector(".sl-chip")!;
    expect(chip.querySelector("input")).toBeNull();
    expect([...chip.querySelectorAll("select")].map((x) => (x as HTMLSelectElement).value)).toEqual(["at or below"]);
    expect(host.querySelector(".sl-abs")!.textContent).toBe("= Lv 20 or less");   // myLevel 20
  });

  it("says MY OWN LEVEL as its own reading, with no number and no direction", () => {
    // A distance of zero in both directions is what "exactly mine" means, and typing 0 twice is not a thing
    // anyone should have to know.
    render([{ ...RULE, where: { lrel: { min: 0, max: 0 } } }]);
    click(button("edit"), "the edit button");
    const chip = host.querySelector(".sl-chip")!;
    expect(chip.querySelector("input")).toBeNull();
    expect([...chip.querySelectorAll("select")].map((x) => (x as HTMLSelectElement).value)).toEqual(["exactly"]);
    expect(chip.textContent).toContain("mine");
    expect(host.querySelector(".sl-abs")!.textContent).toBe("= Lv 20");   // myLevel 20
  });

  it("the adder can write it without a number at all", () => {
    const onChange = vi.fn();
    render([], onChange);
    click(button("add sell rule"), "the add button");
    click(button("narrow it down"), "the picker");
    click(button("level vs mine"), "the field");
    const q = host.querySelector<HTMLSelectElement>(".sl-pkrow select")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(q, "exactly");
      q.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelector(".sl-pkrow input")).toBeNull();   // nothing to type
    click(button("add"), "the adder");
    click(button("Add rule"), "the commit button");
    const rules = onChange.mock.calls.at(-1)![0].rules as Rule[];
    expect(rules.at(-1)!.where.lrel).toEqual({ min: 0, max: 0 });
  });

  it("says a draft is not applied yet, and offers the same control at the head", () => {
    render([]);
    click(button("add sell rule"), "the add button");
    expect(host.querySelector(".sl-editor .cfg-head")!.textContent).toContain("not applied yet");
    expect(host.querySelectorAll(".sl-editor button.apply")).toHaveLength(2);
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

describe("the sale", () => {
  it("goes out as ONE request for the whole list, not one per row", async () => {
    // A round trip and a main-thread hop per row is minutes of waiting on a long playthrough's armory.
    const batch = vi.spyOn(api, "sellBatch").mockResolvedValue({ sold: 2, credits: 300, failed: 0, failures: [], boughtBack: 2 });
    const single = vi.spyOn(api, "sell");
    render([RULE]);
    click(button("Sell 2"), "the sell button");
    click(button("Sell"), "the confirmation");
    await act(async () => {});
    expect(single).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][1]).toHaveLength(2);
    expect(batch.mock.calls[0][1][0]).toMatchObject({ store: "armory", expectName: "Cutter Mk.X" });
    batch.mockRestore(); single.mockRestore();
  });

  it("falls back to one request per row against a bridge that has no batch form", async () => {
    const batch = vi.spyOn(api, "sellBatch").mockRejectedValue(new ApiError(400, "missing item key (slot)"));
    const single = vi.spyOn(api, "sell").mockResolvedValue({ sold: 1, credits: 100 });
    render([RULE]);
    click(button("Sell 2"), "the sell button");
    click(button("Sell"), "the confirmation");
    await act(async () => {});
    expect(single).toHaveBeenCalledTimes(2);
    batch.mockRestore(); single.mockRestore();
  });
});

describe("what a notice does after it is read", () => {
  it("can be dismissed, rather than sitting there until a reload", async () => {
    vi.spyOn(api, "sellBatch").mockResolvedValue({ sold: 2, credits: 300, failed: 0, failures: [] });
    render([RULE]);
    click(button("Sell 2"), "the sell button");
    click(button("Sell"), "the confirmation");
    await act(async () => {});
    expect(host.querySelector(".sum-msg")).toBeTruthy();
    click(host.querySelector(".sum-msg-x")!, "the dismiss button");
    expect(host.querySelector(".sum-msg")).toBeNull();
    vi.restoreAllMocks();
  });
});

describe("what became of the goods", () => {
  it("says when the station cannot sell them back — the sale is final and only this says so", async () => {
    vi.spyOn(api, "sellBatch").mockResolvedValue({
      sold: 2, credits: 300, failed: 0, failures: [], boughtBack: 0,
      buybackNote: "this station has no shop",
    });
    render([RULE]);
    click(button("Sell 2"), "the sell button");
    click(button("Sell"), "the confirmation");
    await act(async () => {});
    expect(host.querySelector(".sum-msg")!.textContent).toContain("Nothing can be bought back");
    expect(host.querySelector(".sum-msg")!.textContent).toContain("this station has no shop");
    vi.restoreAllMocks();
  });
});

describe("what the skips were", () => {
  it("groups the refusals by reason, over ALL of them", async () => {
    // "6 skipped" with two example names says nothing about the other four. The reason is the actionable part.
    vi.spyOn(api, "sellBatch").mockResolvedValue({
      sold: 2, credits: 300, failed: 6, boughtBack: 2,
      failures: [{ key: 1, name: "A", error: "inventory changed" }],
      failureCounts: { "inventory changed": 4, "item is not sellable": 2 },
    });
    render([RULE]);
    click(button("Sell 2"), "the sell button");
    click(button("Sell"), "the confirmation");
    await act(async () => {});
    const text = host.querySelector(".sum-msg")!.textContent!;
    expect(text).toContain("6 skipped");
    expect(text).toContain("4× inventory changed");
    expect(text).toContain("2× item is not sellable");
    vi.restoreAllMocks();
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
    click(button("sell none"), "sell none");
    expect(ticks().every((t) => !t.checked)).toBe(true);
    expect(button("Sell 0")?.hasAttribute("disabled")).toBe(true);
  });

  it("brings a struck-off item back", () => {
    render([RULE]);
    click(ticks()[0], "the first tick");
    click(button("sell all"), "sell all");
    expect(ticks().every((t) => t.checked)).toBe(true);
    expect(button("Sell 2")).toBeTruthy();
  });
});

describe("saved lists (V38)", () => {
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

describe("the split, as the editor's evidence", () => {
  // Keeps the Lv 10 Cutter and turns the Lv 20 one away, so the rule has a row in every bucket.
  const NARROW: Rule = { ...RULE, where: { l: { min: null, max: 15 } } };
  const edit = () => click(host.querySelector(".sl-rhead")!, "the rule header");
  const rows = () => [...host.querySelectorAll(".sl-split .sl-grid tbody tr")].filter((r) => !r.classList.contains("sl-cut"));
  const names = () => rows().map((r) => r.querySelector("td.nm")?.textContent?.trim() ?? "");

  // A saved rule is prose and a count. Its own rows answer "did that clause say what I meant", which is a
  // question about a rule being WRITTEN — the list that decides what sells is the one at the foot.
  it("is drawn only while the rule is being edited", () => {
    render([NARROW]);
    expect(host.querySelector(".sl-split")).toBeNull();
    edit();
    expect(host.querySelector(".sl-split")).toBeTruthy();
  });

  it("lists the rows no clause selected, each naming the clause that turned it away", () => {
    render([NARROW]);
    edit();
    const away = rows().find((r) => r.textContent?.includes("Cutter Mk.XI"));
    expect(away).toBeTruthy();                                  // it is ON SCREEN, not just counted
    expect(away!.textContent).toContain("no match: level");     // and it says WHY, without amputating a clause
  });

  it("folds a bucket away on request, and starts with none folded", () => {
    render([NARROW]);
    edit();
    expect(names()).toContain("Cutter Mk.XI");
    click([...host.querySelectorAll(".sl-sh-box")].at(-1)!, "the not-selected box");
    expect(names()).not.toContain("Cutter Mk.XI");
  });
});

describe("the review list, as the grid the player drives (V58)", () => {
  const rows = () => [...host.querySelectorAll(".sl-rlist .sl-grid tbody tr")].filter((r) => !r.classList.contains("sl-cut"));
  const names = () => rows().map((r) => r.querySelector("td.nm")?.textContent?.trim() ?? "");
  const header = (label: string) =>
    [...host.querySelectorAll(".sl-rlist .sl-grid th")].find((th) => th.textContent?.toLowerCase().startsWith(label));
  const groupHead = () => host.querySelector(".sl-rlist .sl-branch .sl-group");

  it("sorts on a column header without changing what will sell", () => {
    render([RULE]);
    expect(names()).toEqual(["Cutter Mk.X", "Cutter Mk.XI"]);   // the order the rules produced
    click(header("sell value"), "the value header");
    expect(names()).toEqual(["Cutter Mk.XI", "Cutter Mk.X"]);   // the biggest loss first
    expect(button("Sell 2")).toBeTruthy();                      // and the sale is the same two rows
  });

  it("groups the rows the way the player asks, and strikes a whole group off", () => {
    render([RULE]);
    click(button("+ group by…"), "the group picker");
    click(button("size"), "the group field");
    expect(groupHead()!.textContent).toContain("Large");        // sorted by label, so the Mk.XI's group leads
    expect(groupHead()!.textContent).toContain("1 of 1 selling");
    click([...groupHead()!.querySelectorAll("button")].find((b) => b.textContent === "sell none"), "the group's sell none");
    expect(button("Sell 1")).toBeTruthy();                     // the other group is untouched
    expect(groupHead()!.textContent).toContain("0 of 1 selling");
  });

  // V52: an armory is as big as the playthrough. Every row stays in the list and in the sale; only the slice
  // the scroller can show is in the DOM, which is what a `show all` over 10,000 rows cannot be.
  it("holds a 10,000-row proposal without drawing 10,000 rows", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => item({ key: i + 100, name: `Gun ${i}`, sellValue: 10 + i }));
    act(() => {
      root.render(
        <SellList open onClose={() => {}} conn={{ host: "h", port: 1, token: "t" } as never}
          docked items={many} cats={CATS} myLevel={20} defaultKind="keep" rules={[RULE]}
          onChange={vi.fn()} lists={{}} onLists={vi.fn()} onCats={vi.fn()} onSold={() => {}}
          view={view} onView={vi.fn()} />);
    });
    // The thousands separator follows the browser locale, so the label is built the way the app builds it.
    expect(button(`Sell ${(10_000).toLocaleString()}`)).toBeTruthy();   // the sale is the whole proposal
    expect(rows().length).toBeLessThan(200);             // the DOM is not
    expect(rows().length).toBeGreaterThan(0);            // and a window that draws nothing looks broken
  });

  // A column that reads the same on every row says nothing about them, and the two SHOP-FLOOR fields read a
  // constant over an armory: `price` was a column of zeros, which reads as a broken number.
  it("offers no column that cannot tell these rows apart, and drops one that is stored", () => {
    view = { ...emptyView(), cols: ["l", "p"] };
    render([RULE]);
    const heads = [...host.querySelectorAll(".sl-rlist .sl-grid th")].map((th) => th.textContent?.trim());
    expect(heads).toContain("level");
    expect(heads).not.toContain("price");
    click(button("columns…"), "the column picker");
    const offered = [...host.querySelectorAll(".sl-vcol")].map((l) => l.textContent?.trim());
    expect(offered).toContain("level");
    expect(offered).not.toContain("copies owned");
  });
});
