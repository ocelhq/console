import { create } from "@bufbuild/protobuf";
import { Profile, ResourceEstimate_Status } from "@console/connectors/gen/common/cost/v1/cost_pb";
import { DeploymentSchema } from "@console/connectors/gen/console/v1/deployment_pb";
import { describe, expect, it } from "vitest";
import { deploymentRecord } from "../../test/connect-harness";
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

describe("deploymentValues with an estimate", () => {
  const estimate = {
    currency: "USD",
    profile: Profile.MODERATE,
    resources: [
      {
        resource: "aws:lambda/function:web",
        status: ResourceEstimate_Status.PRICED,
        monthlyFixed: "0.00",
        monthlyUsage: "3.10",
      },
    ],
    coverage: { supported: 1, noPrice: 2 },
    monthlyFixed: "12.40",
    monthlyUsage: "3.10",
  };

  it("stores the estimate with its profile and statuses named", () => {
    const values = deploymentValues(
      "project",
      "id",
      create(DeploymentSchema, deploymentRecord({ estimate })),
    );
    expect(values.estimate).toEqual({
      currency: "USD",
      profile: "moderate",
      monthlyFixed: "12.40",
      monthlyUsage: "3.10",
      resources: [
        {
          resource: "aws:lambda/function:web",
          status: "priced",
          monthlyFixed: "0.00",
          monthlyUsage: "3.10",
        },
      ],
      coverage: { supported: 1, free: 0, unsupported: 0, noPrice: 2 },
      notes: [],
    });
  });

  it("stores nothing for a deployment reported with no estimate", () => {
    const values = deploymentValues("project", "id", create(DeploymentSchema, deploymentRecord()));
    expect(values.estimate).toBeNull();
  });

  it("names every resource status", () => {
    const values = deploymentValues(
      "project",
      "id",
      create(
        DeploymentSchema,
        deploymentRecord({
          estimate: {
            ...estimate,
            resources: [
              ResourceEstimate_Status.FREE,
              ResourceEstimate_Status.UNSUPPORTED,
              ResourceEstimate_Status.NO_PRICE,
            ].map((status) => ({ resource: "r", status })),
          },
        }),
      ),
    );
    expect(values.estimate?.resources.map((resource) => resource.status)).toEqual([
      "free",
      "unsupported",
      "no-price",
    ]);
  });

  it("refuses an estimate with no profile or a resource with no status", () => {
    const reported = (overrides: object) =>
      create(DeploymentSchema, deploymentRecord({ estimate: { ...estimate, ...overrides } }));
    expect(() =>
      deploymentValues("project", "id", reported({ profile: Profile.UNSPECIFIED })),
    ).toThrow(/estimate profile: 0/);
    expect(() =>
      deploymentValues("project", "id", reported({ resources: [{ resource: "r" }] })),
    ).toThrow(/resource estimate status: 0/);
  });
});
