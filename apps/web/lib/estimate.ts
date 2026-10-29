import type { DeploymentEstimate, ResourceEstimateStatus } from "@console/db/schema";

export type Cost = { line: string; unpriced: string | null };

export type ResourceCost = {
  resource: string;
  status: ResourceEstimateStatus;
  fixed: string;
  usage: string;
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function dollars(decimal: string): string {
  const amount = decimal === "" ? Number.NaN : Number(decimal);
  return Number.isFinite(amount) ? usd.format(amount) : "—";
}

export function costOf(estimate: DeploymentEstimate): Cost {
  const unpriced = estimate.coverage.unsupported + estimate.coverage.noPrice;
  return {
    line: `≈ ${dollars(estimate.monthlyFixed)}/mo fixed + ${dollars(estimate.monthlyUsage)}/mo usage (${estimate.profile} profile)`,
    unpriced: unpriced === 0 ? null : `${unpriced} resource${unpriced === 1 ? "" : "s"} unpriced`,
  };
}

export function resourceCosts(estimate: DeploymentEstimate): ResourceCost[] {
  return estimate.resources.map((resource) => ({
    resource: resource.resource,
    status: resource.status,
    fixed: dollars(resource.monthlyFixed),
    usage: dollars(resource.monthlyUsage),
  }));
}
