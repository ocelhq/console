"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { labelType } from "@/lib/type";
import { type Answer, changeProductionBranch, linkRepo, reposOf, unlinkRepo } from "./actions";
import { block, field, hint, readOnly } from "./shared";

type Repo = { id: string; fullName: string; defaultBranch: string };

function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(name: string, action: () => Promise<Answer<T>>): Promise<T | undefined> {
    setPending(name);
    setError(null);
    const answer = await action();
    setPending(null);
    if (!answer.ok) {
      setError(answer.message);
      return undefined;
    }
    router.refresh();
    return answer.result;
  }
  return { pending, error, run };
}

function Linked({
  projectId,
  administers,
  linked,
}: {
  projectId: string;
  administers: boolean;
  linked: { fullName: string; account: string; productionBranch: string };
}) {
  const [branch, setBranch] = useState(linked.productionBranch);
  const { pending, error, run } = useAction();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("branch", () => changeProductionBranch(projectId, branch));
  }

  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Repository</dt>
        <dd>
          <a
            href={`https://github.com/${linked.fullName}`}
            className="font-mono text-xs underline-offset-4 hover:underline"
          >
            {linked.fullName}
          </a>
        </dd>
        <dt className="text-muted-foreground">Installation</dt>
        <dd>{linked.account}</dd>
      </dl>
      <form onSubmit={save} className="flex flex-col gap-2" noValidate>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Production branch</span>
          <div className="flex max-w-md gap-2">
            <Input
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              disabled={!administers || pending !== null}
              spellCheck={false}
            />
            {administers && (
              <Button
                type="submit"
                variant="outline"
                disabled={pending !== null || branch.trim() === linked.productionBranch}
              >
                {pending === "branch" ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
        </label>
        <span className={hint}>A push to it deploys to production.</span>
      </form>
      {administers ? (
        <div className="flex flex-col items-start gap-2">
          <Button
            type="button"
            variant="destructive"
            disabled={pending !== null}
            onClick={() => run("unlink", () => unlinkRepo(projectId))}
          >
            {pending === "unlink" ? "Unlinking…" : "Unlink repository"}
          </Button>
          <span className={hint}>
            Pull requests and pushes stop reaching this project, and the pipeline the link trusts
            goes with it.
          </span>
        </div>
      ) : (
        <p className={hint}>{readOnly}</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

function Unlinked({
  projectId,
  installations,
}: {
  projectId: string;
  installations: { id: string; account: string }[];
}) {
  const [installationId, setInstallationId] = useState("");
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [repoId, setRepoId] = useState("");
  const [branch, setBranch] = useState("");
  const { pending, error, run } = useAction();

  async function pickInstallation(id: string) {
    setInstallationId(id);
    setRepos(null);
    setRepoId("");
    setBranch("");
    if (!id) return;
    const listed = await run("repos", () => reposOf(projectId, id));
    setRepos(listed ?? []);
  }

  function pickRepo(id: string) {
    setRepoId(id);
    setBranch(repos?.find((repo) => repo.id === id)?.defaultBranch ?? "");
  }

  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run("link", () =>
      linkRepo(projectId, { installationId, repoId, productionBranch: branch }),
    );
  }

  return (
    <form onSubmit={link} className="flex max-w-md flex-col gap-4" noValidate>
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Installation</span>
        <select
          className={field}
          value={installationId}
          onChange={(event) => pickInstallation(event.target.value)}
          disabled={pending !== null}
        >
          <option value="">Choose an installation</option>
          {installations.map((installation) => (
            <option key={installation.id} value={installation.id}>
              {installation.account}
            </option>
          ))}
        </select>
      </label>
      {pending === "repos" && <p className={hint}>Asking GitHub for its repositories…</p>}
      {repos && (
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Repository</span>
          <select
            className={field}
            value={repoId}
            onChange={(event) => pickRepo(event.target.value)}
            disabled={pending !== null || repos.length === 0}
          >
            <option value="">
              {repos.length === 0
                ? "The installation reaches no repository"
                : "Choose a repository"}
            </option>
            {repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.fullName}
              </option>
            ))}
          </select>
        </label>
      )}
      {repoId && (
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Production branch</span>
          <Input
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            disabled={pending !== null}
            spellCheck={false}
          />
          <span className={hint}>A push to it deploys to production.</span>
        </label>
      )}
      <div>
        <Button type="submit" disabled={pending !== null || !repoId}>
          {pending === "link" ? "Linking…" : "Link repository"}
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

export function Repository({
  projectId,
  administers,
  linked,
  installations,
}: {
  projectId: string;
  administers: boolean;
  linked: { fullName: string; account: string; productionBranch: string } | undefined;
  installations: { id: string; account: string }[];
}) {
  return (
    <section className={block}>
      <h2 className={labelType}>Repository</h2>
      {linked ? (
        <Linked projectId={projectId} administers={administers} linked={linked} />
      ) : installations.length === 0 ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          No GitHub installation is connected to this organization. Install a GitHub App on the{" "}
          <Link href="/git" className="text-foreground underline underline-offset-4">
            Git Integration
          </Link>{" "}
          page, then link a repository here.
        </p>
      ) : administers ? (
        <Unlinked projectId={projectId} installations={installations} />
      ) : (
        <p className="text-sm text-muted-foreground">
          No repository is linked. Only owners and admins can link one.
        </p>
      )}
    </section>
  );
}
