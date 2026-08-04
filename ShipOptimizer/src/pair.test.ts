// @vitest-environment jsdom
//
// The pairing claim, which runs once per page load before anything renders. Its failure modes are all quiet:
// a code left in the URL gets retried and fails on reload, a conn pointed at 127.0.0.1 aims a phone at its own
// loopback, and a claim that throws would stop the app booting at all.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, loadConn } from "./api";
import { claimPairingCode } from "./pair";

const AT = "http://192.168.1.20:8777/";

function at(url: string) {
  // jsdom won't navigate, so the location is replaced wholesale. `history.replaceState` then operates on this
  // object, which is exactly what the code under test is expected to call.
  const parsed = new URL(url);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: parsed.href, hostname: parsed.hostname, port: parsed.port,
      pathname: parsed.pathname, search: parsed.search, hash: parsed.hash, origin: parsed.origin,
    },
  });
}

describe("pairing claim", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(history, "replaceState").mockImplementation((_s, _t, url) => {
      // Mirror the browser: applying the new URL is what makes "the code is gone" observable.
      if (typeof url === "string") at(new URL(url, window.location.href).href);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("does nothing when there is no code in the URL", async () => {
    at(AT);
    const spy = vi.spyOn(api, "pairClaim");
    const outcome = await claimPairingCode();
    expect(outcome).toEqual({ attempted: false, ok: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("claims the code, stores a conn for THIS origin, and strips the code", async () => {
    at(AT + "#/pair?c=ABCDEFGH");
    const spy = vi.spyOn(api, "pairClaim").mockResolvedValue({ token: "tok-123", label: "Android Chrome" });

    const outcome = await claimPairingCode();
    expect(outcome.ok).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1]).toBe("ABCDEFGH");

    // The conn must point at the host that served the page — a phone cannot reach the PC's loopback.
    const conn = loadConn();
    expect(conn.host).toBe("192.168.1.20");
    expect(conn.port).toBe("8777");
    expect(conn.token).toBe("tok-123");

    // The code is single-use, so it must not survive in the URL to be retried on reload.
    expect(location.hash).toBe("");
    expect(history.replaceState).toHaveBeenCalled();
  });

  it("strips the code even when the claim is refused, and still lets the app boot", async () => {
    at(AT + "#/pair?c=EXPIRED1");
    vi.spyOn(api, "pairClaim").mockRejectedValue(new Error("the pairing code expired"));

    const outcome = await claimPairingCode();
    expect(outcome).toMatchObject({ attempted: true, ok: false, error: "the pairing code expired" });
    // A spent or wrong code retried on every reload would report a different error the second time
    // ("no pairing session is open"), which is a worse thing to show than the real one.
    expect(location.hash).toBe("");
    expect(loadConn().token).toBe("");
  });

  it("ignores a hash that is not a pairing link", async () => {
    const spy = vi.spyOn(api, "pairClaim");
    for (const hash of ["#/gear", "#/pair", "#/pair?x=1", "#/pair?c=", "#/pair?c=%20"]) {
      at(AT + hash);
      expect((await claimPairingCode()).attempted).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends a short device label rather than the whole user-agent", async () => {
    at(AT + "#/pair?c=ABCDEFGH");
    const spy = vi.spyOn(api, "pairClaim").mockResolvedValue({ token: "t", label: "x" });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
    });

    await claimPairingCode();
    expect(spy.mock.calls[0][2]).toBe("Android Chrome");
  });
});
