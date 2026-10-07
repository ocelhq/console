import { create } from "@bufbuild/protobuf";
import { DeploymentSchema } from "@console/connectors/gen/console/v1/deployment_pb";
import { describe, expect, it } from "vitest";
import { deploymentRecord } from "../../../test/connect-harness";
import { deploymentValues } from "./record";

describe("deploymentValues", () => {
  it("stores the framework the CLI reports", () => {
    const values = deploymentValues("project", "id", create(DeploymentSchema, deploymentRecord()));
    expect(values.topology.apps[0]?.framework).toBe("next");
  });

  it("refuses a framework the console does not know", () => {
    const reported = create(DeploymentSchema, deploymentRecord());
    const [app] = reported.apps;
    if (app) {
      app.framework = "elm";
    }
    expect(() => deploymentValues("project", "id", reported)).toThrow(/framework: elm/);
  });

  it("refuses a resource type the console does not know", () => {
    const reported = create(DeploymentSchema, deploymentRecord());
    const [resource] = reported.resources;
    if (resource) {
      resource.type = "queue";
    }
    expect(() => deploymentValues("project", "id", reported)).toThrow(/resource type: queue/);
  });
});
