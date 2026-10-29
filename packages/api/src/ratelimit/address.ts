import { isIP } from "node:net";

function withoutPort(entry: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
  if (bracketed?.[1]) {
    return bracketed[1];
  }
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(entry);
  return v4?.[1] ?? entry;
}

export function clientAddress(forwardedFor: string | null, trustedHops: number): string | null {
  const entries = (forwardedFor ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const entry = entries[Math.max(0, entries.length - trustedHops)];
  if (entry === undefined) {
    return null;
  }
  const address = withoutPort(entry);
  return isIP(address) === 0 ? null : address;
}

function hextetsOf(part: string): number[] {
  if (part === "") {
    return [];
  }
  return part.split(":").flatMap((group) => {
    if (!group.includes(".")) {
      return [Number.parseInt(group, 16)];
    }
    const [a = 0, b = 0, c = 0, d = 0] = group.split(".").map(Number);
    return [(a << 8) | b, (c << 8) | d];
  });
}

function hextets(address: string): number[] {
  const [head = "", tail] = address.split("%")[0]?.split("::") ?? [];
  const left = hextetsOf(head);
  if (tail === undefined) {
    return left;
  }
  const right = hextetsOf(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

export function addressKey(address: string): string {
  if (isIP(address) === 4) {
    return `ip:${address}`;
  }
  const groups = hextets(address);
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    const [high = 0, low = 0] = groups.slice(6);
    return `ip:${[high >> 8, high & 0xff, low >> 8, low & 0xff].join(".")}`;
  }
  return `ip:${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}
