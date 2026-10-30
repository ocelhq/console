"use client";

import type { Tier } from "@console/db/schema";
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CommandPane } from "../../../../command-pane";
import { rollBackTo } from "./rollback";

function Deferred({
  label,
  Icon,
  command,
  why,
  planned,
}: {
  label: string;
  Icon: typeof ArrowsClockwiseIcon;
  command: string;
  why: string;
  planned: string;
}) {
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" />}>
        <Icon data-icon="inline-start" />
        {label}
      </PopoverTrigger>
      <PopoverContent className="w-96 max-w-[calc(100vw-2rem)] gap-3 p-4">
        <PopoverHeader>
          <PopoverTitle>Runs from your terminal</PopoverTitle>
          <PopoverDescription>{why}</PopoverDescription>
        </PopoverHeader>
        <CommandPane command={command} />
        <p className="text-xs text-muted-foreground">{planned}</p>
      </PopoverContent>
    </Popover>
  );
}

function RollBack({
  projectId,
  deploymentId,
  slug,
  command,
}: {
  projectId: string;
  deploymentId: string;
  slug: string;
  command: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; needsRunner: boolean } | null>(null);

  async function rollBack() {
    setPending(true);
    setError(null);
    const rolled = await rollBackTo(projectId, deploymentId);
    setPending(false);
    if (!rolled.ok) {
      setError(rolled);
      return;
    }
    router.push(`/projects/${slug}/deployments/${rolled.id}`);
  }

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" />}>
        <ArrowCounterClockwiseIcon data-icon="inline-start" />
        Roll back to this
      </PopoverTrigger>
      <PopoverContent className="w-96 max-w-[calc(100vw-2rem)] gap-3 p-4">
        <PopoverHeader>
          <PopoverTitle>Roll production back</PopoverTitle>
          <PopoverDescription>
            Points production at this promotion again, without a rebuild, through the endpoint in
            the target. The rollback is recorded here as its own deployment.
          </PopoverDescription>
        </PopoverHeader>
        <Button type="button" disabled={pending} onClick={rollBack}>
          {pending ? "Rolling back…" : "Roll back now"}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error.needsRunner
              ? "The endpoint can’t do this one without a runner. Run it from your terminal instead:"
              : error.message}
          </p>
        )}
        <p className="text-xs text-muted-foreground">Or from your terminal:</p>
        <CommandPane command={command} />
      </PopoverContent>
    </Popover>
  );
}

export type Rollback = {
  promotionId: string;
  served: { projectId: string; deploymentId: string; slug: string } | null;
};

export function DeploymentActions({
  url,
  tier,
  environmentIdentity,
  own,
  rollback,
}: {
  url: string | null;
  tier: Tier;
  environmentIdentity: string;
  own: boolean;
  rollback: Rollback | null;
}) {
  const preview = tier === "preview";
  const planned = own
    ? "A runner bound to this tier will let the console do this. Planned."
    : "Starting this from the console is planned.";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        disabled={!url}
        title={url ? undefined : "This deployment reported no url"}
        nativeButton={!url}
        render={
          // biome-ignore lint/a11y/useAnchorContent: Base UI renders the button children inside the anchor
          url ? <a href={url} target="_blank" rel="noreferrer" /> : undefined
        }
      >
        <ArrowSquareOutIcon data-icon="inline-start" />
        Visit
      </Button>
      {rollback &&
        (rollback.served ? (
          <RollBack {...rollback.served} command={`ocel rollback --to ${rollback.promotionId}`} />
        ) : (
          <Deferred
            label="Roll back to this"
            Icon={ArrowCounterClockwiseIcon}
            command={`ocel rollback --to ${rollback.promotionId}`}
            why="Points production at this promotion again, without a rebuild. The rollback reports here as its own deployment."
            planned={
              own
                ? "No endpoint the console can reach rolls back this target, so it runs from your terminal."
                : "Starting this from the console is planned."
            }
          />
        ))}
      <Deferred
        label="Redeploy"
        Icon={ArrowsClockwiseIcon}
        command={preview ? `ocel preview up ${environmentIdentity}`.trim() : "ocel deploy"}
        why={
          own
            ? "Builds and ships the current tree from your machine into your own cloud."
            : "Uploads the current tree from your machine; Ocel Cloud builds and ships it."
        }
        planned={planned}
      />
    </div>
  );
}
