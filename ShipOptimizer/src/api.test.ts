import { describe, it, expect } from "vitest";
import { baseUrl, hostForUrl } from "./api";

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
