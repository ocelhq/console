import { afterEach, describe, expect, it, vi } from "vitest";

const keys = ["CONSOLE_CLOUD_URL", "CONSOLE_CLOUD_PROVIDER_URL", "CONSOLE_CLOUD_AUDIENCE"] as const;

async function offerWith(values: Partial<Record<(typeof keys)[number], string>>) {
  for (const key of keys) vi.stubEnv(key, values[key]);
  vi.resetModules();
  const { readCloudOffer } = await import("./cloud");
  return readCloudOffer();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readCloudOffer", () => {
  it("offers nothing when CONSOLE_CLOUD_URL is unset", async () => {
    expect(await offerWith({})).toBeUndefined();
  });

  it("offers the configured URLs and audience", async () => {
    expect(
      await offerWith({
        CONSOLE_CLOUD_URL: "https://cloud.example.test/api",
        CONSOLE_CLOUD_PROVIDER_URL: "https://provider.cloud.example.test",
        CONSOLE_CLOUD_AUDIENCE: "ocel-cloud",
      }),
    ).toEqual({
      apiUrl: "https://cloud.example.test/api",
      providerUrl: "https://provider.cloud.example.test",
      audience: "ocel-cloud",
    });
  });

  it("takes the origin of CONSOLE_CLOUD_URL as the audience when none is set", async () => {
    expect(await offerWith({ CONSOLE_CLOUD_URL: "https://cloud.example.test/api" })).toEqual({
      apiUrl: "https://cloud.example.test/api",
      providerUrl: "",
      audience: "https://cloud.example.test",
    });
  });

  it("refuses a CONSOLE_CLOUD_URL that is not a URL", async () => {
    await expect(offerWith({ CONSOLE_CLOUD_URL: "cloud" })).rejects.toThrow("CONSOLE_CLOUD_URL");
  });
});
