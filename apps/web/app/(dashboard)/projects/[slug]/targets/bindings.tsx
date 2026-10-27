"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { labelType } from "@/lib/type";
import { block, field, hint, readOnly } from "../git/shared";
import { bindProjectTier } from "./actions";

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
  const router = useRouter();
  const [chosen, setChosen] = useState(bound ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = targets.find((target) => target.id === bound);

  async function save(targetId: string) {
    setPending(true);
    setError(null);
    const answer = await bindProjectTier(projectId, tier, targetId);
    setPending(false);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium capitalize">{tier}</p>
      {administers ? (
        <div className="flex flex-wrap items-center gap-3">
          <select
            className={`${field} max-w-md`}
            value={chosen}
            onChange={(event) => setChosen(event.target.value)}
            disabled={pending}
            aria-label={`Target for ${tier}`}
          >
            <option value="">No target</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.label}
                {target.tiers.includes(tier) ? "" : ` (no ${tier} identity yet)`}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || chosen === (bound ?? "")}
            onClick={() => save(chosen)}
          >
            {pending ? "Saving…" : chosen ? "Bind" : "Unbind"}
          </Button>
        </div>
      ) : (
        <p className="font-mono text-xs">{current?.label ?? "No target"}</p>
      )}
      {current && !current.tiers.includes(tier) && (
        <p className="text-xs text-warn">
          The target has no {tier} identity: an admin runs ocel bootstrap {tier}.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
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
