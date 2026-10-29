import { describe, expect, it } from "vitest";
import { addressKey, clientAddress } from "./address";

describe("clientAddress", () => {
  it("takes the right-most X-Forwarded-For entry behind one proxy", () => {
    expect(clientAddress("203.0.113.9, 198.51.100.7", 1)).toBe("198.51.100.7");
  });

  it("takes the entry as many hops from the right as there are trusted proxies", () => {
    expect(clientAddress("203.0.113.9, 198.51.100.7, 192.0.2.1", 2)).toBe("198.51.100.7");
  });

  it("never trusts an entry left of the trusted hops", () => {
    expect(clientAddress("192.0.2.66, 203.0.113.9", 1)).toBe("203.0.113.9");
  });

  it("takes the left-most entry when there are fewer entries than trusted hops", () => {
    expect(clientAddress("203.0.113.9", 2)).toBe("203.0.113.9");
    expect(clientAddress("203.0.113.9, 198.51.100.7", 3)).toBe("203.0.113.9");
  });

  it("answers no address without the header", () => {
    expect(clientAddress(null, 1)).toBeNull();
  });

  it("answers no address for an entry that is not an IP", () => {
    expect(clientAddress("unknown", 1)).toBeNull();
  });

  it("drops a port from the entry", () => {
    expect(clientAddress("203.0.113.9:4711", 1)).toBe("203.0.113.9");
    expect(clientAddress("[2001:db8::1]:4711", 1)).toBe("2001:db8::1");
  });
});

describe("addressKey", () => {
  it("keys an IPv4 address by itself", () => {
    expect(addressKey("203.0.113.9")).toBe("ip:203.0.113.9");
  });

  it("keys every IPv6 address of a /64 alike", () => {
    expect(addressKey("2001:db8:1:2:aaaa::1")).toBe("ip:2001:db8:1:2::/64");
    expect(addressKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("ip:2001:db8:1:2::/64");
  });

  it("expands a compressed IPv6 address before taking its /64", () => {
    expect(addressKey("2001:db8::1")).toBe("ip:2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("ip:0:0:0:0::/64");
  });

  it("keys an IPv4-mapped IPv6 address as its IPv4 address", () => {
    expect(addressKey("::ffff:203.0.113.9")).toBe("ip:203.0.113.9");
  });
});
