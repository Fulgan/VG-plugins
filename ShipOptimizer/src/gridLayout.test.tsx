// @vitest-environment jsdom
//
// The inventory tab's grids, driven by the same layout bar the sell list uses.
//
// Grouping is spliced into the SAME table as header rows rather than nesting a table per group, because this grid's
// per-column filters, its selection, its draggable widths and its windowing all belong to one table — a tree would
// cost every one of them. These tests pin what a player would notice: the columns they hid stay hidden, the groups
// they asked for appear with their counts, folding one drops its rows, and nothing else about the grid changes.
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ItemGrid } from "./App";
import type { ViewState } from "./sellView";
import type { Conn } from "./api";
import type { Item } from "./types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const conn = { host: "h", port: "1", token: "" } as Conn;
let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  host = null; root = null;
  localStorage.clear();
});

const item = (over: Partial<Item>): Item => ({
  key: 1, slot: 1, name: "Gun", rarity: "Standard", level: 60, size: "Small", type: "Railgun",
  category: "Turret", slotType: "Hardpoint", sellValue: 100, location: "armory",
  mainStat: { name: "Combat Power", amount: "1000" },
  aspects: [], stats: [], substats: [], count: 1,
  ...over,
} as unknown as Item);

const ITEMS: Item[] = [
  item({ key: 1, name: "Small A", size: "Small" }),
  item({ key: 2, name: "Small B", size: "Small" }),
  item({ key: 3, name: "Large A", size: "Large" }),
];

/** This grid's own untouched layout: every column, no grouping. Deliberately NOT `sellView.emptyView()`, whose
 *  `cols` are `FIELDS` keys — the two grids share the TYPE and not the vocabulary, which is the hazard below. */
const blank = (): ViewState => ({ group: [], sort: [], cols: [], hide: [] });

const mount = (view: ViewState, onView = vi.fn()) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<ItemGrid items={ITEMS} conn={conn} gridId="test" view={view} onView={onView} />);
  });
  return host;
};

const headers = () => [...host!.querySelectorAll("thead th .th-label")].map((e) => e.textContent?.trim());
const groupRows = () => [...host!.querySelectorAll("tr.grid-group")].map((r) => r.textContent?.trim());
const names = () => [...host!.querySelectorAll("tbody tr:not(.grid-group) td.c-name")].map((e) => e.textContent?.trim());

describe("a grid the player lays out", () => {
  it("shows every column when nothing has been chosen — the state before anyone touched it", () => {
    mount(blank());
    const h = headers();
    expect(h).toContain("Item");
    expect(h).toContain("Size");
    expect(names()).toEqual(["Small A", "Small B", "Large A"]);
    expect(groupRows()).toEqual([]);
  });

  it("hides the columns left out, and never the name", () => {
    // `cols` names what SHOWS. The name leads every row, so it is not optional at any setting.
    mount({ ...blank(), cols: ["__size"] });
    const h = headers();
    expect(h).toContain("Item");
    expect(h).toContain("Size");
    expect(h).not.toContain("Lvl");
  });

  it("groups by a column, counts each group, and keeps every row in the list", () => {
    mount({ ...blank(), group: ["__size"] });
    expect(groupRows().length).toBe(2);
    expect(groupRows().some((t) => t?.startsWith("▾ Large") && t.includes("1"))).toBe(true);
    expect(groupRows().some((t) => t?.startsWith("▾ Small") && t.includes("2"))).toBe(true);
    expect(names().sort()).toEqual(["Large A", "Small A", "Small B"]);
  });

  it("folds a group away and back, without touching the others", () => {
    mount({ ...blank(), group: ["__size"] });
    const small = [...host!.querySelectorAll("tr.grid-group")].find((r) => r.textContent?.includes("Small"))!;
    act(() => { small.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(names()).toEqual(["Large A"]);                       // the other group is untouched
    const again = [...host!.querySelectorAll("tr.grid-group")].find((r) => r.textContent?.includes("Small"))!;
    act(() => { again.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(names().sort()).toEqual(["Large A", "Small A", "Small B"]);
  });

  // One TYPE, two vocabularies: a layout written for the sell list names its columns `l`|`r`|`v`, and none of
  // those exist here. Showing an empty table for that is worse than ignoring it.
  it("ignores a layout written for another grid rather than blanking itself", () => {
    mount({ ...blank(), cols: ["l", "r", "v"] });
    const h = headers();
    expect(h).toContain("Item");
    expect(h).toContain("Size");
    expect(h).toContain("Lvl");
  });

  it("offers no bar at all to a grid with no id to remember it by", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<ItemGrid items={ITEMS} conn={conn} />); });
    expect(host.querySelector(".sl-view")).toBeNull();
  });
});

// The picker has to agree with the table. On this grid an empty `cols` means EVERY column, so a fresh grid showed
// all of them with not one box ticked — and unticking one then produced `[k]`, which this grid reads as "show only
// k". A control that disagrees with what is on screen teaches the player to distrust it.
describe("the column picker", () => {
  const openCols = () => {
    const btn = [...host!.querySelectorAll<HTMLButtonElement>(".sl-view button.mini")]
      .find((b) => b.textContent?.includes("columns"))!;
    act(() => { btn.click(); });
    return [...host!.querySelectorAll<HTMLInputElement>(".sl-vpop .sl-vcol input")];
  };
  const boxFor = (label: string) =>
    [...host!.querySelectorAll<HTMLLabelElement>(".sl-vpop .sl-vcol")]
      .find((l) => l.textContent?.trim() === label)!.querySelector("input")!;

  it("ticks every box when the grid is showing every column", () => {
    mount(blank());
    const boxes = openCols();
    expect(boxes.length).toBeGreaterThan(2);
    expect(boxes.every((b) => b.checked)).toBe(true);
  });

  it("ticks exactly what a narrowed layout shows", () => {
    mount({ ...blank(), cols: ["__size"] });
    openCols();
    expect(boxFor("Size").checked).toBe(true);
    expect(boxFor("Lvl").checked).toBe(false);
  });

  // The defect: from the "everything" state, unticking one column must HIDE that one, not hide the rest.
  it("hides only the column unticked, starting from the everything state", () => {
    const onView = vi.fn();
    mount(blank(), onView);
    openCols();
    act(() => { boxFor("Size").click(); });
    const next = onView.mock.calls.at(-1)![0] as ViewState;
    expect(next.cols).not.toContain("__size");
    expect(next.cols.length).toBeGreaterThan(1);       // everything else survived
    expect(next.cols).toContain("__level");
  });

  // Ticking the last missing box goes back to the sentinel, so a column a later build adds appears by itself
  // instead of being hidden by a list written before it existed.
  it("collapses back to the everything sentinel when all are ticked again", () => {
    const onView = vi.fn();
    mount(blank(), onView);
    openCols();
    const all = [...host!.querySelectorAll<HTMLLabelElement>(".sl-vpop .sl-vcol")].map((l) => l.textContent!.trim());
    // hide one, then re-tick it against the layout that produced
    act(() => { boxFor("Size").click(); });
    const narrowed = onView.mock.calls.at(-1)![0] as ViewState;
    expect(narrowed.cols.length).toBe(all.length - 1);
    if (root) act(() => root!.unmount());
    mount(narrowed, onView);
    openCols();
    act(() => { boxFor("Size").click(); });
    expect((onView.mock.calls.at(-1)![0] as ViewState).cols).toEqual([]);
  });
});
