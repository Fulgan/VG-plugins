// @vitest-environment jsdom
//
// `loadConn` reads `location` and localStorage, so this file needs a document.
import { describe, it, expect } from "vitest";
import { baseUrl, hostForUrl, loadConn } from "./api";

// URL building, which is invisible until the host is an IPv6 literal and then breaks every single call.
describe("hostForUrl", () => {
  it("leaves names and IPv4 alone", () => {
    expect(hostForUrl("127.0.0.1")).toBe("127.0.0.1");
    expect(hostForUrl("192.168.1.110")).toBe("192.168.1.110");
    expect(hostForUrl("gaming.tail1234.ts.net")).toBe("gaming.tail1234.ts.net");
  });

  it("brackets an IPv6 literal, however location reported it", () => {
    // Browsers disagree about whether `location.hostname` keeps the brackets, so both must normalise the same.
    expect(hostForUrl("fd7a:115c:a1e0::e137:5b56")).toBe("[fd7a:115c:a1e0::e137:5b56]");
    expect(hostForUrl("[fd7a:115c:a1e0::e137:5b56]")).toBe("[fd7a:115c:a1e0::e137:5b56]");
    expect(hostForUrl("::1")).toBe("[::1]");
  });

  it("builds a fetchable base URL for both families", () => {
    expect(baseUrl({ host: "100.76.91.86", port: "8777", token: "" })).toBe("http://100.76.91.86:8777");
    expect(baseUrl({ host: "fd7a:115c:a1e0::e137:5b56", port: "8777", token: "" }))
      .toBe("http://[fd7a:115c:a1e0::e137:5b56]:8777");
    // A double-bracketed host would make every request fail with a bare "network error".
    expect(baseUrl({ host: "[::1]", port: "8777", token: "" })).toBe("http://[::1]:8777");
  });
});

// WHERE THE BRIDGE IS, when nothing has been stored. The old dev default was a hardcoded loopback address,
// which is correct only while the browser and the game are the same machine: opened from a phone, or from
// another desk over the tailnet, it aims every request at THAT device's loopback and the app simply never
// loads. Both builds now answer "wherever this page came from": in production the bridge served it, and
// under Vite the dev server proxies it (`vite.config.ts`), so the origin speaks for the bridge either way.
describe("loadConn, the default when nothing is stored", () => {
  it("is the origin the page was served from, not a hardcoded loopback", () => {
    localStorage.clear();
    const c = loadConn();
    expect(c.host).toBe(location.hostname);
    expect(c.port).toBe(location.port || "8777");
    // Empty on purpose: the dev server attaches the bridge token in node, so it never reaches the client, and
    // a device talking to the bridge directly gets its own by pairing.
    expect(c.token).toBe("");
  });

  it("a stored conn still wins, so anyone pointed at another bridge stays pointed there", () => {
    localStorage.setItem("shipoptimizer.conn", JSON.stringify({ host: "10.0.0.5", port: "9999", token: "t" }));
    expect(loadConn()).toEqual({ host: "10.0.0.5", port: "9999", token: "t" });
    localStorage.clear();
  });
});
