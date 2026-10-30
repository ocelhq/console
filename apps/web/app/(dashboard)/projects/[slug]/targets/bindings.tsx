"use client";

import { labelType } from "@/lib/type";
import { block, hint, readOnly } from "../git/shared";
import { bindProjectTier } from "./actions";
import { TierPicker } from "./tier-picker";

export type TargetChoice = { id: string; label: string; tiers: string[] };

function TierBinding({
  projectId,
  tier,
  bound,
  targets,
  administers,
}: {
  projectId: string;
  tier: string;
  bound: string | null;
  targets: TargetChoice[];
  administers: boolean;
}) {
  const current = targets.find((target) => target.id === bound);
  return (
    <TierPicker
      tier={tier}
      noun="Target"
      choices={targets.map((target) => ({
        id: target.id,
        label: target.tiers.includes(tier)
          ? target.label
          : `${target.label} (no ${tier} identity yet)`,
      }))}
      bound={bound}
      administers={administers}
      shown={current?.label ?? "No target"}
      save={(chosen) => bindProjectTier(projectId, tier, chosen)}
      notice={
        current &&
        !current.tiers.includes(tier) && (
          <p className="text-xs text-warn">
            The target has no {tier} identity: an admin runs ocel bootstrap {tier}.
          </p>
        )
      }
    />
  );
}

export function Bindings({
  projectId,
  administers,
  targets,
  bound,
}: {
  projectId: string;
  administers: boolean;
  targets: TargetChoice[];
  bound: Record<string, string | null>;
}) {
  return (
    <section className={block}>
      <h2 className={labelType}>Deploys to</h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        Each tier deploys to one of the organization’s targets. A trusted pipeline’s run gets
        credentials for the tier’s target, and for no other.
      </p>
      {(["production", "preview"] as const).map((tier) => (
        <TierBinding
          key={tier}
          projectId={projectId}
          tier={tier}
          bound={bound[tier] ?? null}
          targets={targets}
          administers={administers}
        />
      ))}
      {!administers && <p className={hint}>{readOnly}</p>}
    </section>
  );
}
