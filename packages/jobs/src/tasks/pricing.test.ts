import { describe, expect, it } from "vitest";
import { timeLimitedTask } from "./pricing";

describe("timeLimitedTask", () => {
  it.each([
    ["an AWS Lambda worker", { AWS_LAMBDA_FUNCTION_NAME: "console-worker" }, true],
    ["a Cloud Run worker", { K_SERVICE: "console" }, true],
    ["a VPS container or a machine running the CLI", {}, false],
  ])("for %s is %s", (_host, environment, limited) => {
    expect(timeLimitedTask(environment)).toBe(limited);
  });
});
