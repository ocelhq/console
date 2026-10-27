"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { labelType } from "@/lib/type";
import { Stamp } from "../stamp";
import { removeOrganizationTarget, testConnection } from "./actions";

export type TierView = {
  tier: string;
  principal: string;
  cliVersion: string;
  recordedAt: string;
  lastIssuedAt: string | null;
};

export type TargetView = {
  id: string;
  vendor: string;
  account: string;
  region: string;
  tiers: TierView[];
};

type Outcome = { ok: boolean; text: string };

function TargetCard({
  target,
  administers,
  now,
}: {
  target: TargetView;
  administers: boolean;
  now: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [error, setError] = useState<string | null>(null);

  async function test(tier: string) {
    setPending(tier);
    const answer = await testConnection(target.id, tier);
    setPending(null);
    setOutcomes((current) => ({
      ...current,
      [tier]: answer.ok ? { ok: true, text: answer.result } : { ok: false, text: answer.message },
    }));
    router.refresh();
  }

  async function remove() {
    setPending("remove");
    setError(null);
    const answer = await removeOrganizationTarget(target.id);
    setPending(null);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    router.refresh();
  }

  return (
    <li className="flex flex-col gap-4 px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="font-medium">
            <span className="uppercase">{target.vendor}</span>{" "}
            <span className="font-mono text-sm">{target.account}</span>
          </p>
          <p className={labelType}>{target.region}</p>
        </div>
        {administers && (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={pending !== null}
            onClick={remove}
          >
            {pending === "remove" ? "Removing…" : "Remove target"}
          </Button>
        )}
      </div>
      {target.tiers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tier recorded yet: bootstrap stopped before it recorded the identity it made.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tier</TableHead>
              <TableHead>Deploys as</TableHead>
              <TableHead>Recorded by</TableHead>
              <TableHead>Last issued</TableHead>
              {administers && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {target.tiers.map((tier) => (
              <TableRow key={tier.tier}>
                <TableCell className="capitalize">{tier.tier}</TableCell>
                <TableCell className="font-mono text-xs break-all whitespace-normal">
                  {tier.principal}
                </TableCell>
                <TableCell>
                  ocel {tier.cliVersion}, <Stamp at={tier.recordedAt} now={now} />
                </TableCell>
                <TableCell>
                  {tier.lastIssuedAt ? <Stamp at={tier.lastIssuedAt} now={now} /> : "never"}
                </TableCell>
                {administers && (
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending !== null}
                      onClick={() => test(tier.tier)}
                    >
                      {pending === tier.tier ? "Testing…" : "Test connection"}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {Object.entries(outcomes).map(([tier, outcome]) => (
        <p
          key={tier}
          role={outcome.ok ? "status" : "alert"}
          className={outcome.ok ? "text-sm" : "text-sm text-destructive"}
        >
          <span className="capitalize">{tier}</span>: {outcome.ok ? "connected, " : ""}
          <span className="break-all">{outcome.text}</span>
        </p>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

export function Targets({
  targets,
  administers,
  now,
}: {
  targets: TargetView[];
  administers: boolean;
  now: string;
}) {
  return (
    <ul className="flex flex-col divide-y divide-border border border-border">
      {targets.map((target) => (
        <TargetCard key={target.id} target={target} administers={administers} now={now} />
      ))}
    </ul>
  );
}
