import { beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase } from "../../../test/db";
import { health, healthCheck } from "./route";

beforeAll(async () => {
  await setupTestDatabase();
});

describe("GET /api/health", () => {
  it("answers 200 when the database answers", async () => {
    const response = await health();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("answers 503 when the database does not", async () => {
    const response = await healthCheck(async () => {
      throw new Error("connection refused");
    })();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });
});
