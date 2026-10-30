import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../../auth/src/settings");
  vi.resetModules();
});

describe("the tasks module", () => {
  it("reads none of the console's auth settings when imported, as Ocel's discovery requires", async () => {
    const read = vi.fn(() => {
      throw new Error("the auth settings were read at import");
    });
    vi.resetModules();
    vi.doMock("../../../auth/src/settings", () => ({ readAuthSettings: read }));

    await expect(import("./tasks")).resolves.toHaveProperty("jobSweep");
    expect(read).not.toHaveBeenCalled();
  });
});
