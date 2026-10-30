import { create } from "@bufbuild/protobuf";
import { JobCommand, JobRequestSchema } from "@console/connectors/gen/runner/v1/runner_pb";
import { describe, expect, it } from "vitest";
import { requestOf, uploadedSpecOf } from "./request";

describe("a build's tier values", () => {
  it("go from the request the CLI uploaded to the request its runner starts", () => {
    const spec = uploadedSpecOf(
      create(JobRequestSchema, {
        command: JobCommand.BUILD,
        source: { case: "sourceId", value: "a".repeat(64) },
        tierValues: true,
      }),
    );
    if (!spec) throw new Error("an uploaded request records a spec");

    expect(spec.tierValues).toBe(true);
    expect(requestOf({ kind: "build" }, spec).tierValues).toBe(true);
  });

  it("are left out of a build that reads none", () => {
    const spec = uploadedSpecOf(
      create(JobRequestSchema, {
        command: JobCommand.BUILD,
        source: { case: "sourceId", value: "a".repeat(64) },
      }),
    );
    if (!spec) throw new Error("an uploaded request records a spec");

    expect(spec).not.toHaveProperty("tierValues");
    expect(requestOf({ kind: "build" }, spec).tierValues).toBe(false);
  });
});

describe("a job's config file", () => {
  it("goes from the request the CLI uploaded to the request its runner starts", () => {
    const uploaded = create(JobRequestSchema, {
      command: JobCommand.DEPLOY,
      source: { case: "sourceId", value: "a".repeat(64) },
      configFile: "configs/ocel.staging.config.ts",
    });

    const spec = uploadedSpecOf(uploaded);
    if (!spec) throw new Error("an uploaded request records a spec");

    expect(spec.configFile).toBe("configs/ocel.staging.config.ts");
    expect(requestOf({ kind: "deploy" }, spec).configFile).toBe("configs/ocel.staging.config.ts");
  });

  it("is left empty for a job dispatched from git, and for an upload that names none", () => {
    const fromGit = requestOf(
      { kind: "deploy" },
      { source: { git: { cloneUrl: "https://git.example.com/web.git", commit: "c".repeat(40) } } },
    );
    const uploaded = uploadedSpecOf(
      create(JobRequestSchema, {
        command: JobCommand.DEPLOY,
        source: { case: "sourceId", value: "a".repeat(64) },
      }),
    );

    expect(fromGit.configFile).toBe("");
    expect(uploaded).not.toHaveProperty("configFile");
  });
});
