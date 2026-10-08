import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { privateKey } from "./private-key";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
}) as string;

function parses(value: string): boolean {
  try {
    createPrivateKey(privateKey(value));
    return true;
  } catch {
    return false;
  }
}

describe("privateKey", () => {
  it("hands a pem with real newlines over intact", () => {
    expect(privateKey(pem)).toBe(pem);
    expect(parses(pem)).toBe(true);
  });

  it("restores a pem whose newlines became literal backslash-n", () => {
    expect(parses(pem.replace(/\n/g, "\\n"))).toBe(true);
  });

  it("restores a pem whose newlines became spaces", () => {
    expect(parses(pem.replace(/\n/g, " "))).toBe(true);
  });

  it("restores a pem flattened to one line with no separators", () => {
    expect(parses(pem.replace(/\n/g, ""))).toBe(true);
  });

  it("leaves what is not a pem alone", () => {
    expect(privateKey("not a key")).toBe("not a key");
  });
});
