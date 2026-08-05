// @vitest-environment jsdom
//
// Preferences belong to a SAVE. These pin the boundary that keeps one playthrough's settings out of
// another's — the sell rules being the reason it matters: a rule set written by a rich character is a
// shredder in the hands of a new one.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearCachedPrefs, clearStorageFailure, load, onStorageFailure, save, SNAPSHOT_KEY, type StorageFailure } from "./storage";

beforeEach(() => { localStorage.clear(); clearStorageFailure(); });

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

// A cache that cannot fit must not be reported as if a setting had been lost. The armory that provoked this
// holds 85k items, whose snapshot serialises past the whole origin quota — so the write can never succeed,
// and the only thing the player could learn from the banner is that the app has a cache.
describe("a disposable cache is refused quietly; a preference is not", () => {
  const failures: StorageFailure[] = [];
  let stop: () => void;
  beforeEach(() => { failures.length = 0; stop = onStorageFailure((f) => failures.push(f)); });
  afterEach(() => { stop(); vi.restoreAllMocks(); });

  it("refuses an oversized snapshot without a failure, and drops the stale one", () => {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ inv: "previous" }));

    expect(save(SNAPSHOT_KEY, { items: "x".repeat(1_000_001) })).toBe(false);

    expect(localStorage.getItem(SNAPSHOT_KEY)).toBe(null); // booting from a stale cache is worse than none
    expect(failures).toEqual([]);
  });

  it("still caches a snapshot of ordinary size", () => {
    expect(save(SNAPSHOT_KEY, { items: "x".repeat(1000) })).toBe(true);
    expect(load<{ items: string } | null>(SNAPSHOT_KEY, null)?.items.length).toBe(1000);
    expect(failures).toEqual([]);
  });

  it("says nothing when a full quota rejects a disposable key", () => {
    const quota = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw quota; });

    expect(save(SNAPSHOT_KEY, { small: true })).toBe(false);
    expect(failures).toEqual([]);
  });

  it("reports a full quota that rejects a PREFERENCE", () => {
    const quota = Object.assign(new Error("full"), { name: "QuotaExceededError" });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw quota; });

    expect(save("shipoptimizer.sellRules", [{ id: "r1" }])).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0].quota).toBe(true);
    expect(failures[0].key).toBe("shipoptimizer.sellRules");
  });
});
