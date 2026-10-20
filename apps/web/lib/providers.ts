export const OCEL_CLOUD = "Ocel Cloud";

const ocelCloudProvider = "ocel";
const ocelCloudVendor = "ocel";
const ocelCloudEdge = "ocel-cloud";
const noEdge = "none";

export function isOcelCloud(provider: string | null | undefined): boolean {
  return provider?.toLowerCase() === ocelCloudProvider;
}

export function providerLabel(provider: string): string {
  return isOcelCloud(provider) ? OCEL_CLOUD : provider;
}

export function isOcelCloudEdge(edge: string, provider?: string | null): boolean {
  const kind = edge.toLowerCase();
  return kind === ocelCloudEdge || (kind === noEdge && isOcelCloud(provider));
}

export function edgeLabel(edge: string, provider?: string | null): string {
  return isOcelCloudEdge(edge, provider) ? OCEL_CLOUD : edge;
}

export function connectorLabel(row: { vendor: string; target: string }): string {
  return row.vendor.toLowerCase() === ocelCloudVendor ? OCEL_CLOUD : row.target;
}
