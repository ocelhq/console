"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { GrantInput } from "@/lib/credential-grant";
import { labelType } from "@/lib/type";
import { block, hint, readOnly } from "../git/shared";
import { grantPipelineCredentials } from "./actions";

export type GrantRow = {
  id: string;
  repository: string;
  workflow: string | null;
  origin: "linked" | "manual";
  production: { branches: string[]; environment: string | null } | null;
  preview: { branches: string[] } | null;
};

const none = <span className="text-muted-foreground">none</span>;

function GrantForm({
  projectId,
  pipeline,
  productionBranch,
  onDone,
}: {
  projectId: string;
  pipeline: GrantRow;
  productionBranch: string | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const follows = pipeline.origin === "linked" && productionBranch !== null;
  const [input, setInput] = useState<GrantInput>({
    production: {
      enabled: pipeline.production !== null,
      branches: pipeline.production?.branches.join(", ") ?? (follows ? productionBranch : ""),
      environment: pipeline.production?.environment ?? "",
    },
    preview: {
      enabled: pipeline.preview !== null,
      branches: pipeline.preview?.branches.join(", ") ?? "*",
    },
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const answer = await grantPipelineCredentials(projectId, pipeline.id, input);
    setPending(false);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    onDone();
    router.refresh();
  }

  const production = (over: Partial<GrantInput["production"]>) =>
    setInput((current) => ({ ...current, production: { ...current.production, ...over } }));
  const preview = (over: Partial<GrantInput["preview"]>) =>
    setInput((current) => ({ ...current, preview: { ...current.preview, ...over } }));

  return (
    <form
      onSubmit={save}
      className="flex max-w-md flex-col gap-4 border-t border-border pt-4"
      noValidate
    >
      <p className="text-sm">
        Credentials for <span className="font-mono text-xs">{pipeline.repository}</span>
      </p>
      <fieldset className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={input.production.enabled}
            onChange={(event) => production({ enabled: event.target.checked })}
            disabled={pending}
          />
          Production
        </label>
        {input.production.enabled && (
          <>
            {follows ? (
              <p className={hint}>
                Runs on the production branch, <span className="font-mono">{productionBranch}</span>
                , and it follows a change of production branch.
              </p>
            ) : (
              <label className="flex flex-col gap-2">
                <span className="text-sm">Branches</span>
                <Input
                  value={input.production.branches}
                  onChange={(event) => production({ branches: event.target.value })}
                  placeholder="main"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={pending}
                />
              </label>
            )}
            <label className="flex flex-col gap-2">
              <span className="text-sm">GitHub environment (optional)</span>
              <Input
                value={input.production.environment}
                onChange={(event) => production({ environment: event.target.value })}
                placeholder="production"
                spellCheck={false}
                autoComplete="off"
                disabled={pending}
              />
              <span className={hint}>
                When set, only jobs that run in this environment get production credentials, so its
                protection rules gate them.
              </span>
            </label>
          </>
        )}
      </fieldset>
      <fieldset className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={input.preview.enabled}
            onChange={(event) => preview({ enabled: event.target.checked })}
            disabled={pending}
          />
          Preview
        </label>
        {input.preview.enabled && (
          <label className="flex flex-col gap-2">
            <span className="text-sm">Branches</span>
            <Input
              value={input.preview.branches}
              onChange={(event) => preview({ branches: event.target.value })}
              placeholder="*"
              spellCheck={false}
              autoComplete="off"
              disabled={pending}
            />
          </label>
        )}
      </fieldset>
      <p className={hint}>
        Patterns separated by commas, where <span className="font-mono">*</span> matches any run of
        characters. A pull request run is matched by its head branch and gets only preview
        credentials; a pull_request_target run gets none.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save grant"}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

export function CredentialGrants({
  projectId,
  administers,
  pipelines,
  productionBranch,
}: {
  projectId: string;
  administers: boolean;
  pipelines: GrantRow[];
  productionBranch: string | null;
}) {
  const [editing, setEditing] = useState<GrantRow | null>(null);

  return (
    <section className={block}>
      <h2 className={labelType}>Credential grants</h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        Which runs of each trusted pipeline the console mints cloud credentials for. A grant is
        separate from the branches a pipeline may report from, and narrower.
      </p>
      {pipelines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This project trusts no pipeline. Add one on its Git Integration page.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Repository</TableHead>
              <TableHead>Workflow</TableHead>
              <TableHead>Production</TableHead>
              <TableHead>Preview</TableHead>
              {administers && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pipelines.map((pipeline) => (
              <TableRow key={pipeline.id}>
                <TableCell className="font-mono text-xs">{pipeline.repository}</TableCell>
                <TableCell className="font-mono text-xs">{pipeline.workflow ?? "any"}</TableCell>
                <TableCell className="font-mono text-xs">
                  {pipeline.production
                    ? `${pipeline.production.branches.join(", ")}${pipeline.production.environment ? ` in ${pipeline.production.environment}` : ""}`
                    : none}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {pipeline.preview ? pipeline.preview.branches.join(", ") : none}
                </TableCell>
                {administers && (
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing(pipeline)}
                    >
                      Edit
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {administers && editing ? (
        <GrantForm
          key={editing.id}
          projectId={projectId}
          pipeline={editing}
          productionBranch={productionBranch}
          onDone={() => setEditing(null)}
        />
      ) : (
        !administers && <p className={hint}>{readOnly}</p>
      )}
    </section>
  );
}
