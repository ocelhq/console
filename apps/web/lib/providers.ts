export const OCEL_CLOUD = "Ocel Cloud";

const ocelCloudProvider = "ocel";
const ocelCloudVendor = "ocel";
const ocelCloudEdge = "ocel-cloud";

export function isOcelCloud(provider: string | null | undefined): boolean {
  return provider?.toLowerCase() === ocelCloudProvider;
}

export function providerLabel(provider: string): string {
  return isOcelCloud(provider) ? OCEL_CLOUD : provider;
}

export function isOcelCloudEdge(edge: string): boolean {
  return edge.toLowerCase() === ocelCloudEdge;
}

export function edgeLabel(edge: string): string {
  return isOcelCloudEdge(edge) ? OCEL_CLOUD : edge;
}

export function connectorLabel(row: { vendor: string; target: string }): string {
  return row.vendor.toLowerCase() === ocelCloudVendor ? OCEL_CLOUD : row.target;
}
