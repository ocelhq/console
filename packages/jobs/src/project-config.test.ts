import { describe, expect, it } from "vitest";
import { configuredProvider } from "./project-config";

const reading = (files: Record<string, string>) => async (path: string) => files[path];

describe("configuredProvider", () => {
  it("reads the provider an ocel.json names, by id or as the one key of its options", async () => {
    expect(await configuredProvider(reading({ "ocel.json": '{ "provider": "aws" }' }), "")).toEqual(
      {
        ok: true,
        provider: "aws",
      },
    );
    expect(
      await configuredProvider(
        reading({
          "ocel.json":
            '{\n  // the box\n  "provider": { "vps": { "host": "box.example.com" } },\n}',
        }),
        "",
      ),
    ).toEqual({ ok: true, provider: "vps" });
  });

  it("reads YAML configs, in the order the CLI looks for them", async () => {
    expect(
      await configuredProvider(
        reading({ "ocel.yaml": "provider:\n  gcp: {}\n", "ocel.yml": "provider: aws\n" }),
        "",
      ),
    ).toEqual({ ok: true, provider: "gcp" });
  });

  it("names no provider for a config without one, or for no config at all", async () => {
    expect(await configuredProvider(reading({ "ocel.json": '{ "slug": "web" }' }), "")).toEqual({
      ok: true,
      provider: "",
      slug: "web",
    });
    expect(await configuredProvider(reading({}), "")).toEqual({ ok: true, provider: "" });
  });

  it("reads the config at the project's path in the repository", async () => {
    expect(
      await configuredProvider(
        reading({ "apps/web/ocel.json": '{ "provider": "aws" }' }),
        "apps/web",
      ),
    ).toEqual({ ok: true, provider: "aws" });
  });

  it("refuses, saying why, a config it cannot read", async () => {
    expect(
      await configuredProvider(reading({ "ocel.config.ts": "export default {}" }), ""),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("ocel.config.ts"),
    });
    expect(await configuredProvider(reading({ "ocel.json": "{ provider" }), "")).toMatchObject({
      ok: false,
      message: "ocel.json is not valid JSON",
    });
    expect(
      await configuredProvider(
        reading({ "ocel.json": '{ "provider": { "aws": {}, "gcp": {} } }' }),
        "",
      ),
    ).toMatchObject({ ok: false });
  });
});
