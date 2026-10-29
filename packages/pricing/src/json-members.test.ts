import { describe, expect, it } from "vitest";
import { decodeText, type JsonMemberEvent, jsonMembers } from "./json-members";

const document = {
  formatVersion: "v1.0",
  products: {
    A: { sku: "A", attributes: { usagetype: 'odd "quoted" {brace} [bracket] \\ value' } },
    'Bé\\"': { sku: "B", nested: [[{ deep: { products: { X: {} } } }], "]"] },
  },
  terms: {
    Reserved: { A: { ignored: true } },
    OnDemand: { A: { "A.T": { priceDimensions: {} } }, B: { "B.T": {} } },
  },
  attributesList: { products: { Z: {} } },
};

async function* chunks(text: string, size: number): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

async function collect(
  text: string,
  size: number,
  want?: (path: number, key: string) => boolean,
): Promise<JsonMemberEvent[]> {
  const events: JsonMemberEvent[] = [];
  for await (const event of jsonMembers(
    chunks(text, size),
    [["products"], ["terms", "OnDemand"]],
    want,
  )) {
    events.push(event);
  }
  return events;
}

describe("jsonMembers", () => {
  const text = JSON.stringify(document, null, 2);

  it.each([1, 2, 3, 7, 64, text.length])(
    "yields each member of the named objects whole, in chunks of %i",
    async (size) => {
      const events = await collect(text, size);
      expect(
        events.map((event) =>
          event.kind === "end" ? event : { ...event, json: JSON.parse(event.json ?? "null") },
        ),
      ).toEqual([
        { kind: "member", path: 0, key: "A", json: document.products.A },
        { kind: "member", path: 0, key: 'Bé\\"', json: document.products['Bé\\"'] },
        { kind: "end", path: 0 },
        { kind: "member", path: 1, key: "A", json: document.terms.OnDemand.A },
        { kind: "member", path: 1, key: "B", json: document.terms.OnDemand.B },
        { kind: "end", path: 1 },
      ]);
    },
  );

  it("skips the text of a member it does not want", async () => {
    const events = await collect(text, 5, (path, key) => path === 0 || key === "B");
    const terms = events.filter((event) => event.kind === "member" && event.path === 1);
    expect(terms).toEqual([
      { kind: "member", path: 1, key: "A", json: undefined },
      {
        kind: "member",
        path: 1,
        key: "B",
        json: JSON.stringify(document.terms.OnDemand.B, null, 2).replaceAll("\n", "\n      "),
      },
    ]);
  });

  it("asks whether it wants a member only after the members before it were consumed", async () => {
    const seen = new Set<string>();
    const kept: string[] = [];
    for await (const event of jsonMembers(
      chunks(text, text.length),
      [["products"], ["terms", "OnDemand"]],
      (path, key) => path === 0 || seen.has(key),
    )) {
      if (event.kind !== "member") continue;
      if (event.path === 0) seen.add(event.key);
      else if (event.json !== undefined) kept.push(event.key);
    }
    expect(kept).toEqual(["A"]);
  });

  it("refuses a document that ends early", async () => {
    await expect(collect(text.slice(0, text.length - 3), 10)).rejects.toThrow(/ends before/);
  });
});

describe("decodeText", () => {
  it("decodes a character split across chunks", async () => {
    const bytes = new TextEncoder().encode('{"k":"é€"}');
    async function* split() {
      for (const byte of bytes) yield new Uint8Array([byte]);
    }
    let text = "";
    for await (const chunk of decodeText(split())) text += chunk;
    expect(text).toBe('{"k":"é€"}');
  });
});
