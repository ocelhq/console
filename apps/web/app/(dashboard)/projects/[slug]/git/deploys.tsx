"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { labelType } from "@/lib/type";
import { cn } from "@/lib/utils";
import { deployFrom } from "./actions";
import { block, hint, readOnly } from "./shared";

type Mode = "runners" | "ci";

const modes: { mode: Mode; label: string; describe: (repo: string) => string }[] = [
  {
    mode: "runners",
    label: "Console runners",
    describe: (repo) =>
      `A push to the production branch or a pull request on ${repo} queues a deploy a runner picks up.`,
  },
  {
    mode: "ci",
    label: "Your CI",
    describe: (repo) =>
      `Git events queue nothing. Your GitHub Actions workflows on ${repo} deploy, and what they report reaches the pull request as comments, statuses and deployments.`,
  },
];

export function DeploysIn({
  projectId,
  administers,
  linked,
  audience,
}: {
  projectId: string;
  administers: boolean;
  linked: { fullName: string; deploys: Mode } | null;
  audience: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(mode: Mode) {
    if (!linked || mode === linked.deploys) return;
    setPending(mode);
    setError(null);
    const answer = await deployFrom(projectId, mode);
    setPending(null);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    router.refresh();
  }

  return (
    <section className={block}>
      <h2 className={labelType}>Deploys run in</h2>
      {linked ? (
        <>
          <fieldset className="grid gap-3 md:grid-cols-2">
            <legend className="sr-only">Deploys run in</legend>
            {modes.map(({ mode, label, describe }) => {
              const chosen = linked.deploys === mode;
              return (
                <label
                  key={mode}
                  className={cn(
                    "flex cursor-pointer flex-col items-start gap-1 border px-4 py-3 transition-colors has-focus-visible:border-ring has-focus-visible:ring-1 has-focus-visible:ring-ring/50 has-disabled:cursor-default",
                    chosen ? "border-foreground" : "border-border hover:bg-muted",
                    !chosen && !administers && "opacity-60",
                  )}
                >
                  <input
                    type="radio"
                    name="deploys"
                    value={mode}
                    checked={chosen}
                    disabled={!administers || pending !== null}
                    onChange={() => choose(mode)}
                    className="sr-only"
                  />
                  <span className="text-sm font-semibold">
                    {pending === mode ? "Switching…" : label}
                  </span>
                  <span className="text-xs text-muted-foreground">{describe(linked.fullName)}</span>
                </label>
              );
            })}
          </fieldset>
          {linked.deploys === "ci" && (
            <p className={hint}>
              The workflow requests its OIDC token with{" "}
              <span className="font-mono">permissions: id-token: write</span> and the audience{" "}
              <span className="font-mono">{audience}</span>. Switching to your CI cancels deploys
              still waiting for a runner and trusts {linked.fullName}’s pipeline below, which you
              can narrow but not remove while deploys run in your CI; switching back stops trusting
              it.
            </p>
          )}
          {!administers && <p className={hint}>{readOnly}</p>}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Link a repository to choose where its deploys run.
        </p>
      )}
    </section>
  );
}
