import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signState, verifyState } from "./state";

const secret = "state-secret-at-least-32-characters";
const now = new Date("2026-10-08T12:00:00Z");
const claims = { organizationId: "org_1", userId: "user_1", appRowId: "app_1" };

describe("state", () => {
  it("round-trips its claims", () => {
    expect(
      verifyState("manifest", signState("manifest", claims, secret, now), secret, now),
    ).toEqual(claims);
  });

  it("refuses a state signed under another secret", () => {
    const state = signState("manifest", claims, "other-secret-other-secret-other-secret", now);
    expect(verifyState("manifest", state, secret, now)).toBeUndefined();
  });

  it("refuses a state whose claims were changed", () => {
    const [, signature] = signState("manifest", claims, secret, now).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...claims, organizationId: "org_2", exp: Number.MAX_SAFE_INTEGER }),
    ).toString("base64url");
    expect(verifyState("manifest", `${forged}.${signature}`, secret, now)).toBeUndefined();
  });

  it("refuses a state older than an hour", () => {
    const later = new Date(now.getTime() + 61 * 60 * 1000);
    expect(
      verifyState("manifest", signState("manifest", claims, secret, now), secret, later),
    ).toBeUndefined();
  });

  it("refuses a state signed for another step", () => {
    const authorize = signState("authorize", { ...claims, installation: "99" }, secret, now);
    expect(verifyState("manifest", authorize, secret, now)).toBeUndefined();
  });

  it("never signs with the session secret itself", () => {
    const payload = Buffer.from(
      JSON.stringify({ ...claims, exp: now.getTime() + 60_000 }),
    ).toString("base64url");
    const signature = createHmac("sha256", secret).update(payload).digest("base64url");
    expect(verifyState("manifest", `${payload}.${signature}`, secret, now)).toBeUndefined();
  });

  it("refuses what is not a state", () => {
    expect(verifyState("manifest", "garbage", secret, now)).toBeUndefined();
    expect(verifyState("manifest", "bm90IGpzb24.c2ln", secret, now)).toBeUndefined();
  });
});
