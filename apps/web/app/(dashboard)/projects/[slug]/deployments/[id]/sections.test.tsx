import type { DeploymentEstimate } from "@console/db/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CostBreakdown, Domains } from "./sections";

describe("Domains with no hostnames", () => {
  it("offers no `ocel domain add` on Ocel Cloud, which doesn't run it", () => {
    const html = renderToStaticMarkup(<Domains apps={[]} own={false} />);
    expect(html).toContain("Ocel Cloud assigned");
    expect(html).not.toContain("ocel domain add");
  });

  it("offers `ocel domain add` for a provider of your own", () => {
    const html = renderToStaticMarkup(<Domains apps={[]} own />);
    expect(html).toContain("ocel domain add");
  });
});

const estimate: DeploymentEstimate = {
  currency: "USD",
  profile: "moderate",
  monthlyFixed: "12.4",
  monthlyUsage: "3.1",
  resources: [],
  coverage: { supported: 0, free: 0, unsupported: 0, noPrice: 0 },
  notes: [],
};

describe("CostBreakdown", () => {
  it("lists each resource's monthly cost and the estimate's notes", () => {
    const html = renderToStaticMarkup(
      <CostBreakdown
        estimate={{
          ...estimate,
          resources: [
            { resource: "web", status: "priced", monthlyFixed: "12.4", monthlyUsage: "3.1" },
          ],
          notes: ["AWS free tiers are not applied"],
        }}
      />,
    );
    expect(html).toContain("web");
    expect(html).toContain("$12.40");
    expect(html).toContain("$3.10");
    expect(html).toContain("AWS free tiers are not applied");
  });

  it("says so when the estimate priced no resources", () => {
    const html = renderToStaticMarkup(<CostBreakdown estimate={estimate} />);
    expect(html).toContain("priced no resources");
  });
});
