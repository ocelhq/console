"use server";

import { db } from "@console/db";
import { project } from "@console/db/schema";
import {
  addPipeline,
  type GitRuntime,
  narrowPipeline,
  parseBranches,
  parseRepository,
  parseWorkflow,
  publicRepoIds,
  type Repo,
  removePipeline,
} from "@console/git";
import { deployIn } from "@console/jobs";
import { jobChanged } from "@console/jobs/tasks";
import { and, eq } from "drizzle-orm";
import { requireOrganization } from "@/lib/access";
import { git } from "@/lib/git";
import { organizationOf } from "@/lib/organization";

export type Answer<T = null> = { ok: true; result: T } | { ok: false; message: string };

const done = { ok: true, result: null } as const;

function failed(message: string): Answer<never> {
  return { ok: false, message };
}

interface Administered {
  userId: string;
  organizationId: string;
  projectId: string;
  runtime: GitRuntime;
}

async function administered(projectId: string): Promise<Answer<Administered>> {
  const session = await requireOrganization();
  const runtime = git();
  if (!runtime) return failed("Git integrations aren’t configured on this console.");
  const organization = await organizationOf(session.userId, session.activeOrganizationId);
  if (!organization?.administers) {
    return failed("Only owners and admins can change a project’s git integration.");
  }
  const [found] = await db
    .select({ id: project.id })
    .from(project)
    .where(
      and(eq(project.organizationId, session.activeOrganizationId), eq(project.id, projectId)),
    );
  if (!found) return failed("That project isn’t in this organization.");
  return {
    ok: true,
    result: {
      userId: session.userId,
      organizationId: session.activeOrganizationId,
      projectId: found.id,
      runtime,
    },
  };
}

async function providerFor(runtime: GitRuntime, gitAppId: string) {
  const app = await runtime.store.loadApp(gitAppId);
  return app ? runtime.providerFor(app) : undefined;
}

async function installationOf(reached: Administered, installationId: string) {
  const installations = await reached.runtime.store.installationsFor(reached.organizationId);
  return installations.find((installation) => installation.id === installationId);
}

async function attempt<T>(run: () => Promise<Answer<T>>): Promise<Answer<T>> {
  try {
    return await run();
  } catch (thrown) {
    return failed(thrown instanceof Error ? thrown.message : String(thrown));
  }
}

export async function reposOf(projectId: string, installationId: string): Promise<Answer<Repo[]>> {
  return attempt(async () => {
    const reached = await administered(projectId);
    if (!reached.ok) return reached;
    const installation = await installationOf(reached.result, installationId);
    if (!installation) return failed("That installation isn’t this organization’s.");
    const provider = await providerFor(reached.result.runtime, installation.gitAppId);
    if (!provider) return failed("The GitHub App behind that installation is gone.");
    const repos = await provider.listRepos({ externalId: installation.externalId });
    return { ok: true, result: repos.sort((a, b) => a.fullName.localeCompare(b.fullName)) };
  });
}

export async function linkRepo(
  projectId: string,
  input: { installationId: string; repoId: string; productionBranch: string },
): Promise<Answer> {
  return attempt(async () => {
    const reached = await administered(projectId);
    if (!reached.ok) return reached;
    const installation = await installationOf(reached.result, input.installationId);
    if (!installation) return failed("That installation isn’t this organization’s.");
    const provider = await providerFor(reached.result.runtime, installation.gitAppId);
    if (!provider) return failed("The GitHub App behind that installation is gone.");
    const repo = await provider.findRepo({ externalId: installation.externalId }, input.repoId);
    if (!repo) return failed("The installation doesn’t reach that repository.");
    const branch = input.productionBranch.trim();
    if (/\s/.test(branch)) return failed("A branch name has no spaces.");
    await reached.result.runtime.store.linkProjectRepo({
      projectId: reached.result.projectId,
      organizationId: reached.result.organizationId,
      installationId: installation.id,
      repo,
      productionBranch: branch || repo.defaultBranch,
    });
    return done;
  });
}

export async function unlinkRepo(projectId: string): Promise<Answer> {
  return attempt(async () => {
    const reached = await administered(projectId);
    if (!reached.ok) return reached;
    await reached.result.runtime.store.unlinkProjectRepo(reached.result.projectId);
    return done;
  });
}

export async function changeProductionBranch(projectId: string, branch: string): Promise<Answer> {
  return attempt(async () => {
    const reached = await administered(projectId);
    if (!reached.ok) return reached;
    const named = branch.trim();
    if (!named || /\s/.test(named)) return failed("Name one branch, with no spaces.");
    await reached.result.runtime.store.setProductionBranch(reached.result.projectId, named);
    return done;
  });
}

export async function deployFrom(projectId: string, mode: "runners" | "ci"): Promise<Answer> {
  return attempt(async () => {
    const reached = await administered(projectId);
    if (!reached.ok) return reached;
    await deployIn(reached.result.projectId, { mode, by: reached.result.userId }, jobChanged);
    return done;
  });
}

function narrowing(input: { workflow: string; environment: string; branches: string }) {
  const workflow = parseWorkflow(input.workflow);
  if (workflow === undefined) return undefined;
  return {
    workflow,
    environment: input.environment.trim() || null,
    branches: parseBranches(input.branches),
  };
}

const WORKFLOW_PATH = "Name the workflow by its path, like .github/workflows/deploy.yml.";

export async function trustPipeline(
  projectId: string,
  input: { repository: string; workflow: string; environment: string; branches: string },
): Promise<Answer> {
  return attempt(async () => {
    const reached = await administered(projectId);
    if (!reached.ok) return reached;
    const repository = parseRepository(input.repository);
    if (!repository) return failed("Name the repository as owner/name.");
    const narrowed = narrowing(input);
    if (!narrowed) return failed(WORKFLOW_PATH);
    const ids = await publicRepoIds(repository);
    await addPipeline({
      projectId: reached.result.projectId,
      repository,
      repositoryId: ids?.repositoryId ?? null,
      repositoryOwnerId: ids?.repositoryOwnerId ?? null,
      ...narrowed,
      origin: "manual",
      createdBy: reached.result.userId,
    });
    return done;
  });
}

export async function distrustPipeline(projectId: string, pipelineId: string): Promise<Answer> {
  return attempt(async () => {
    const reached = await administered(projectId);
    if (!reached.ok) return reached;
    switch (await removePipeline(reached.result.projectId, pipelineId)) {
      case "missing":
        return failed("That pipeline is already gone.");
      case "linked":
        return failed(
          "The linked repository’s pipeline stays while deploys run in your CI. Narrow it instead, or switch back to the console runners.",
        );
      case "removed":
        return done;
    }
  });
}

export async function narrowTrustedPipeline(
  projectId: string,
  pipelineId: string,
  input: { workflow: string; environment: string; branches: string },
): Promise<Answer> {
  return attempt(async () => {
    const reached = await administered(projectId);
    if (!reached.ok) return reached;
    const narrowed = narrowing(input);
    if (!narrowed) return failed(WORKFLOW_PATH);
    if (!(await narrowPipeline(reached.result.projectId, pipelineId, narrowed))) {
      return failed("That pipeline is gone.");
    }
    return done;
  });
}
