// @vitest-environment jsdom
//
// A currency shown as its own art, with the WORD as the fallback.
//
// The fallback is the whole point of testing this: the art comes from `/item/icon?id=`, which an older bridge does
// not serve and which answers 404 for a currency a build retired. A broken image where the wallet's unit should be
// is worse than the word it replaced, and nothing else in the app would notice.
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CurrencyMark } from "./Price";
import { pluralName, CREDIT_MARK } from "./format";
import type { Conn } from "./api";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const conn = { host: "h", port: "1", token: "" } as Conn;
let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  host = null; root = null;
});

const render = (node: React.ReactNode) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root!.render(node); });
};

describe("CurrencyMark", () => {
  it("draws the game's own art, named for a screen reader", () => {
    render(<CurrencyMark id="VanguardMark" conn={conn} name="Vanguard Marks" />);
    const img = host!.querySelector("img")!;
    expect(img.getAttribute("src")).toContain("/item/icon?id=VanguardMark");
    expect(img.getAttribute("alt")).toBe("Vanguard Marks");
  });

  it("falls back to the WORD when the art cannot be fetched", () => {
    render(<CurrencyMark id="RetiredCurrency" conn={conn} name="Retired Currencies" fallback="Retired Currency" />);
    act(() => { host!.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(host!.querySelector("img")).toBeNull();
    expect(host!.textContent).toBe("Retired Currency");
  });
});

describe("the wallet's words", () => {
  it("pluralises a currency name for the tooltip, since the DTO reports the singular", () => {
    expect(pluralName("Vanguard Mark")).toBe("Vanguard Marks");
    expect(pluralName("Canisec Commendation")).toBe("Canisec Commendations");
    expect(pluralName("marks")).toBe("marks");        // already plural — no "markss"
  });

  it("has ONE credit mark, so the wallet and the item card cannot disagree", () => {
    expect(CREDIT_MARK).toBe("¢");
  });
});
