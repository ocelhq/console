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
import { labelType } from "@/lib/type";
import { Stamp } from "../../../stamp";
import { distrustPipeline, narrowTrustedPipeline, trustPipeline } from "./actions";
import { block, hint, readOnly } from "./shared";

export type PipelineRow = {
  id: string;
  repository: string;
  pending: boolean;
  workflow: string | null;
  environment: string | null;
  branches: string[];
  origin: "linked" | "manual";
  lastUsedAt: string | null;
};

const any = <span className="text-muted-foreground">any</span>;

type Narrowing = { workflow: string; environment: string; branches: string };

function PipelineForm({
  projectId,
  editing,
  onDone,
}: {
  projectId: string;
  editing?: PipelineRow;
  onDone: () => void;
}) {
  const router = useRouter();
  const [repository, setRepository] = useState("");
  const [workflow, setWorkflow] = useState(editing?.workflow ?? "");
  const [environment, setEnvironment] = useState(editing?.environment ?? "");
  const [branches, setBranches] = useState(editing?.branches.join(", ") ?? "*");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const narrowing: Narrowing = { workflow, environment, branches };
    const answer = editing
      ? await narrowTrustedPipeline(projectId, editing.id, narrowing)
      : await trustPipeline(projectId, { repository, ...narrowing });
    setPending(false);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    onDone();
    router.refresh();
  }

  return (
    <form
      onSubmit={save}
      className="flex max-w-md flex-col gap-4 border-t border-border pt-4"
      noValidate
    >
      {editing ? (
        <p className="text-sm">
          Narrowing <span className="font-mono text-xs">{editing.repository}</span>
        </p>
      ) : (
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Repository</span>
          <Input
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            placeholder="owner/name"
            spellCheck={false}
            autoComplete="off"
            disabled={pending}
          />
          <span className={hint}>
            The console reads a public repository’s ids now. A private one is pinned to the ids of
            the first token that names it, and holds to them from then on.
          </span>
        </label>
      )}
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Workflow (optional)</span>
        <Input
          value={workflow}
          onChange={(event) => setWorkflow(event.target.value)}
          placeholder=".github/workflows/deploy.yml"
          spellCheck={false}
          autoComplete="off"
          disabled={pending}
        />
        <span className={hint}>Only runs of this workflow file, when set.</span>
      </label>
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Environment (optional)</span>
        <Input
          value={environment}
          onChange={(event) => setEnvironment(event.target.value)}
          placeholder="production"
          spellCheck={false}
          autoComplete="off"
          disabled={pending}
        />
        <span className={hint}>Only jobs that run in this GitHub environment, when set.</span>
      </label>
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Branches</span>
        <Input
          value={branches}
          onChange={(event) => setBranches(event.target.value)}
          placeholder="*"
          spellCheck={false}
          autoComplete="off"
          disabled={pending}
        />
        <span className={hint}>
          Patterns separated by commas. <span className="font-mono">*</span> matches any run of
          characters, slashes included, and everything else matches itself:{" "}
          <span className="font-mono">*</span> takes every branch,{" "}
          <span className="font-mono">release/*</span> takes release/1.2 and release/a/b, and{" "}
          <span className="font-mono">main</span> takes only main. A pull request run is matched by
          its head branch and may report only previews; production needs a push or another run
          outside a pull request. A tag has no branch and is refused.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : editing ? "Save pipeline" : "Add pipeline"}
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

export function Pipelines({
  projectId,
  administers,
  deploysFromCi,
  pipelines,
  now,
}: {
  projectId: string;
  administers: boolean;
  deploysFromCi: boolean;
  pipelines: PipelineRow[];
  now: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState<"add" | PipelineRow | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: string) {
    setRemoving(id);
    setError(null);
    const answer = await distrustPipeline(projectId, id);
    setRemoving(null);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    router.refresh();
  }

  return (
    <section className={block}>
      <h2 className={labelType}>Trusted pipelines</h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        CI runs whose GitHub Actions token one of these covers may report this project’s
        deployments, with no one signed in.
      </p>
      {pipelines.length === 0 ? (
        <p className="text-sm text-muted-foreground">This project trusts no pipeline.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>Repository</TableHead>
              <TableHead>Workflow</TableHead>
              <TableHead>Environment</TableHead>
              <TableHead>Branches</TableHead>
              <TableHead>Origin</TableHead>
              <TableHead>Last used</TableHead>
              {administers && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {pipelines.map((pipeline) => (
              <TableRow key={pipeline.id}>
                <TableCell>GitHub Actions</TableCell>
                <TableCell>
                  <span className="font-mono text-xs">{pipeline.repository}</span>
                  {pipeline.pending && (
                    <span className="block text-xs text-warn">ids pinned on first use</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{pipeline.workflow ?? any}</TableCell>
                <TableCell>{pipeline.environment ?? any}</TableCell>
                <TableCell className="font-mono text-xs">{pipeline.branches.join(", ")}</TableCell>
                <TableCell className="capitalize">{pipeline.origin}</TableCell>
                <TableCell>
                  {pipeline.lastUsedAt ? <Stamp at={pipeline.lastUsedAt} now={now} /> : "never"}
                </TableCell>
                {administers && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={removing !== null}
                        onClick={() => setForm(pipeline)}
                      >
                        Edit
                      </Button>
                      {!(pipeline.origin === "linked" && deploysFromCi) && (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={removing !== null}
                          onClick={() => remove(pipeline.id)}
                        >
                          {removing === pipeline.id ? "Removing…" : "Remove"}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {administers ? (
        form ? (
          <PipelineForm
            key={form === "add" ? "add" : form.id}
            projectId={projectId}
            editing={form === "add" ? undefined : form}
            onDone={() => setForm(null)}
          />
        ) : (
          <div>
            <Button type="button" variant="outline" onClick={() => setForm("add")}>
              Add pipeline
            </Button>
          </div>
        )
      ) : (
        <p className={hint}>{readOnly}</p>
      )}
    </section>
  );
}
