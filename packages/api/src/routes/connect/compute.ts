import { ComputeKind } from "@console/connectors/gen/console/v1/deployment_pb";
import type { ComputeKind as ComputeKindName } from "@console/db/schema";

export const computeKinds: Partial<Record<ComputeKind, ComputeKindName>> = {
  [ComputeKind.SERVERLESS]: "serverless",
  [ComputeKind.CONTAINER]: "container",
};

export function computeKindOf(name: ComputeKindName | null): ComputeKind {
  const found = Object.entries(computeKinds).find(([, known]) => known === name);
  return found ? (Number(found[0]) as ComputeKind) : ComputeKind.UNSPECIFIED;
}
