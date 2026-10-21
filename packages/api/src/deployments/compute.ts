import { ComputeKind } from "@console/connectors/gen/console/v1/deployment_pb";
import type { ComputeKind as ComputeKindName } from "@console/db/schema";

export const computeKinds: Partial<Record<ComputeKind, ComputeKindName>> = {
  [ComputeKind.SERVERLESS]: "serverless",
  [ComputeKind.CONTAINER]: "container",
};

const computeKindsByName: Record<ComputeKindName, ComputeKind> = {
  serverless: ComputeKind.SERVERLESS,
  container: ComputeKind.CONTAINER,
};

export function computeKindOf(name: ComputeKindName | null): ComputeKind {
  return name === null ? ComputeKind.UNSPECIFIED : computeKindsByName[name];
}
