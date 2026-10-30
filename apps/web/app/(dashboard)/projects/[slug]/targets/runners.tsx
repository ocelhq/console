"use client";

import { useState } from "react";
import { labelType } from "@/lib/type";
import { block, hint, readOnly } from "../git/shared";
import { bindProjectRunner } from "./actions";
import { type Choice, TierPicker } from "./tier-picker";

export type RunnerChoice = Choice;

export type RunnerBound = { runnerId: string; credentials: boolean };

function TierRunner({
  projectId,
  tier,
  bound,
  runners,
  administers,
}: {
  projectId: string;
  tier: string;
  bound: RunnerBound | null;
  runners: RunnerChoice[];
  administers: boolean;
}) {
  const [credentials, setCredentials] = useState(bound?.credentials ?? false);
  const current = runners.find((runner) => runner.id === bound?.runnerId);
  return (
    <TierPicker
      tier={tier}
      noun="Runner"
      choices={runners}
      bound={bound?.runnerId ?? null}
      administers={administers}
      shown={
        current ? `${current.label}${bound?.credentials ? ", with credentials" : ""}` : "No runner"
      }
      save={(chosen) => bindProjectRunner(projectId, tier, chosen, credentials)}
      changed={(chosen) => chosen !== "" && credentials !== (bound?.credentials ?? false)}
      extra={(chosen, pending) =>
        chosen && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={credentials}
              onChange={(event) => setCredentials(event.target.checked)}
              disabled={pending}
            />
            Its jobs get {tier} credentials
          </label>
        )
      }
    />
  );
}

export function Runners({
  projectId,
  administers,
  runners,
  bound,
}: {
  projectId: string;
  administers: boolean;
  runners: RunnerChoice[];
  bound: Record<string, RunnerBound | undefined>;
}) {
  return (
    <section className={block}>
      <h2 className={labelType}>Runs jobs on</h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        Each tier’s jobs run on the one runner bound to it, and get credentials for the tier’s
        target only when the binding says so. A project that names no provider runs only on Ocel
        Cloud’s runner, which needs no binding.
      </p>
      {runners.length === 0 && (
        <p className={hint}>
          No connector of this organization serves a runner yet. Enable the runner role in a
          connector’s config, and it appears here once its heartbeat reports it.
        </p>
      )}
      {(["production", "preview"] as const).map((tier) => (
        <TierRunner
          key={tier}
          projectId={projectId}
          tier={tier}
          bound={bound[tier] ?? null}
          runners={runners}
          administers={administers}
        />
      ))}
      {!administers && <p className={hint}>{readOnly}</p>}
    </section>
  );
}
