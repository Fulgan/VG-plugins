// @vitest-environment jsdom
//
// Preferences belong to a SAVE. These pin the boundary that keeps one playthrough's settings out of
// another's — the sell rules being the reason it matters: a rule set written by a rich character is a
// shredder in the hands of a new one.
import { describe, it, expect, beforeEach } from "vitest";
import { clearCachedPrefs, load, save } from "./storage";

beforeEach(() => localStorage.clear());

describe("cached preferences do not outlive their playthrough", () => {
  it("drops every preference key", () => {
    save("shipoptimizer.sellRules", [{ id: "r1" }]);
    save("shipoptimizer.sellDefault", "sell");
    save("shipoptimizer.turretCategories", { mining: ["Cutter"] });

    clearCachedPrefs();

    expect(load("shipoptimizer.sellRules", null)).toBe(null);
    expect(load("shipoptimizer.sellDefault", null)).toBe(null);
    expect(load("shipoptimizer.turretCategories", null)).toBe(null);
  });

  // Losing these does not reset a preference, it loses the bridge: the app would come back up unable to
  // reach the very store the real settings live in.
  it("keeps the keys that address the bridge", () => {
    localStorage.setItem("shipoptimizer.conn", JSON.stringify({ host: "127.0.0.1", port: "8777", token: "t" }));
    localStorage.setItem("shipoptimizer.playthrough", "abc");

    clearCachedPrefs();

    expect(localStorage.getItem("shipoptimizer.conn")).not.toBe(null);
    expect(localStorage.getItem("shipoptimizer.playthrough")).toBe("abc");
  });

  it("leaves keys belonging to other apps alone", () => {
    localStorage.setItem("someoneelse.thing", "1");
    clearCachedPrefs();
    expect(localStorage.getItem("someoneelse.thing")).toBe("1");
  });
});
