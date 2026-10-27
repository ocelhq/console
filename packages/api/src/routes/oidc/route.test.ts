import { generateKeyPairSync } from "node:crypto";
import { createIssuer, keySigner } from "@console/targets";
import { describe, expect, it } from "vitest";
import { oidcRoutes } from "./route";

const issuer = createIssuer("https://console.example.com", {
  signer: keySigner(
    generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString(),
  ),
  previous: [],
});

describe("the issuer's discovery routes", () => {
  const routes = oidcRoutes(() => Promise.resolve(issuer));

  it("describe an ES256 id_token issuer at <origin>/oidc, cached for five minutes", async () => {
    const response = await routes.configuration();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await response.json()).toEqual({
      issuer: "https://console.example.com/oidc",
      jwks_uri: "https://console.example.com/oidc/jwks",
      id_token_signing_alg_values_supported: ["ES256"],
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      claims_supported: expect.arrayContaining(["sub", "aud", "org", "target", "tier", "project"]),
    });
  });

  it("publish the public keys, and nothing private", async () => {
    const response = await routes.jwks();

    expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    const { keys } = (await response.json()) as { keys: Record<string, string>[] };
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(keys[0]).not.toHaveProperty("d");
  });

  it("are not found while the console has no issuer key", async () => {
    const unset = oidcRoutes(() => undefined);

    expect((await unset.configuration()).status).toBe(404);
    expect((await unset.jwks()).status).toBe(404);
  });

  it("answer unavailable, uncached, when the key cannot be reached", async () => {
    const failing = oidcRoutes(() => Promise.reject(new Error("KMS is down")));

    const response = await failing.jwks();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
