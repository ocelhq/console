import { DEFAULT_NAMESPACE } from "@console/targets/namespace";

export function targetLabel(target: {
  vendor: string;
  account: string;
  region: string;
  namespace?: string;
}): string {
  const named =
    target.namespace && target.namespace !== DEFAULT_NAMESPACE ? `(${target.namespace})` : "";
  return [target.vendor, target.account, target.region, named]
    .filter((part) => part !== "")
    .join(" ");
}

export function noTierNote(tierForgottenAt: Date | string | null): string {
  return tierForgottenAt === null
    ? "No tier recorded yet: bootstrap stopped before it recorded the identity it made."
    : "No tier recorded: each one's identity was removed (ocel bootstrap destroy, or the console forgot it). Run ocel bootstrap <tier> to record one again.";
}

export function removalWarning(target: {
  vendor: string;
  account: string;
  region: string;
  namespace?: string;
  tiers: { tier: string }[];
  bound: string[];
}): string {
  const place = targetLabel(target);
  const tiers =
    target.tiers.length === 0
      ? "It has no recorded tier."
      : `The console forgets its ${target.tiers.map((tier) => tier.tier).join(" and ")} identity and stops issuing credentials for it.`;
  const projects =
    target.bound.length === 0
      ? "No project deploys to it."
      : `These stop deploying to it until they bind another target: ${target.bound.join(", ")}.`;
  return `Removes ${place} from this console. ${tiers} ${projects} The account keeps trusting the issuer until an admin runs ocel bootstrap --remove there.`;
}
