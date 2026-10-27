import { db, type Executor } from "@console/db";
import {
  type CredentialGrant,
  pipelineToken,
  projectRepo,
  type TrustedPipeline,
  trustedPipeline,
} from "@console/db/schema";
import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const WORKFLOW = /^\.github\/workflows\/[^@\s]+\.ya?ml$/;

export function parseRepository(input: string): string | undefined {
  const repository = input
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  return REPOSITORY.test(repository) && !repository.endsWith("/..") ? repository : undefined;
}

export function parseWorkflow(input: string): string | undefined | null {
  const workflow = input.trim();
  if (workflow === "") return null;
  return WORKFLOW.test(workflow) ? workflow : undefined;
}

export function parseBranches(input: string): string[] {
  const branches = input
    .split(/[\s,]+/)
    .map((branch) => branch.trim())
    .filter(Boolean);
  return branches.length === 0 ? ["*"] : [...new Set(branches)];
}

export interface NewPipeline {
  projectId: string;
  repository: string;
  repositoryId: string | null;
  repositoryOwnerId: string | null;
  workflow: string | null;
  environment: string | null;
  branches: string[];
  origin: TrustedPipeline["origin"];
  createdBy: string | null;
}

export async function pipelinesOf(projectId: string): Promise<TrustedPipeline[]> {
  return db
    .select()
    .from(trustedPipeline)
    .where(eq(trustedPipeline.projectId, projectId))
    .orderBy(asc(trustedPipeline.createdAt), asc(trustedPipeline.id));
}

export async function addPipeline(input: NewPipeline): Promise<TrustedPipeline> {
  const [added] = await db
    .insert(trustedPipeline)
    .values({ id: crypto.randomUUID(), kind: "github-actions", ...input })
    .returning();
  if (!added) throw new Error("the trusted pipeline was not stored");
  return added;
}

export type Removal = "removed" | "missing" | "linked";

const deploysFromCi = (projectId: string) =>
  sql`exists (select 1 from ${projectRepo} where ${projectRepo.projectId} = ${projectId} and ${projectRepo.deploys} = 'ci')`;

export async function removePipeline(projectId: string, id: string): Promise<Removal> {
  const mine = and(eq(trustedPipeline.projectId, projectId), eq(trustedPipeline.id, id));
  const removed = await db
    .delete(trustedPipeline)
    .where(
      and(mine, or(ne(trustedPipeline.origin, "linked"), sql`not ${deploysFromCi(projectId)}`)),
    )
    .returning({ id: trustedPipeline.id });
  if (removed.length > 0) return "removed";
  const [kept] = await db.select({ id: trustedPipeline.id }).from(trustedPipeline).where(mine);
  return kept ? "linked" : "missing";
}

export interface PipelineNarrowing {
  workflow: string | null;
  environment: string | null;
  branches: string[];
}

export async function narrowPipeline(
  projectId: string,
  id: string,
  narrowing: PipelineNarrowing,
): Promise<boolean> {
  const narrowed = await db
    .update(trustedPipeline)
    .set(narrowing)
    .where(and(eq(trustedPipeline.projectId, projectId), eq(trustedPipeline.id, id)))
    .returning({ id: trustedPipeline.id });
  return narrowed.length > 0;
}

export async function grantCredentials(
  projectId: string,
  id: string,
  credentials: CredentialGrant,
): Promise<boolean> {
  const granted = await db
    .update(trustedPipeline)
    .set({ credentials })
    .where(and(eq(trustedPipeline.projectId, projectId), eq(trustedPipeline.id, id)))
    .returning({ id: trustedPipeline.id });
  return granted.length > 0;
}

export async function syncLinkedPipeline(
  tx: Executor,
  projectId: string,
  createdBy: string | null = null,
): Promise<void> {
  const linkedRows = and(
    eq(trustedPipeline.projectId, projectId),
    eq(trustedPipeline.origin, "linked"),
  );
  const [link] = await tx
    .select({
      deploys: projectRepo.deploys,
      repoId: projectRepo.repoId,
      repoOwnerId: projectRepo.repoOwnerId,
      fullName: projectRepo.fullName,
      productionBranch: projectRepo.productionBranch,
    })
    .from(projectRepo)
    .where(eq(projectRepo.projectId, projectId));
  if (link?.deploys !== "ci" || link.repoOwnerId === null) {
    await tx.delete(trustedPipeline).where(linkedRows);
    return;
  }

  await tx
    .delete(trustedPipeline)
    .where(
      and(
        linkedRows,
        or(isNull(trustedPipeline.repositoryId), ne(trustedPipeline.repositoryId, link.repoId)),
      ),
    );
  const ids = {
    repository: link.fullName,
    repositoryId: link.repoId,
    repositoryOwnerId: link.repoOwnerId,
  };
  const [kept] = await tx
    .update(trustedPipeline)
    .set({
      ...ids,
      credentials: sql`case when ${trustedPipeline.credentials} -> 'production' is null
        then ${trustedPipeline.credentials}
        else jsonb_set(${trustedPipeline.credentials}, '{production,branches}', jsonb_build_array(${link.productionBranch}::text)) end`,
    })
    .where(and(linkedRows, eq(trustedPipeline.repositoryId, link.repoId)))
    .returning({ id: trustedPipeline.id });
  if (kept) return;
  await tx.insert(trustedPipeline).values({
    id: crypto.randomUUID(),
    projectId,
    kind: "github-actions",
    origin: "linked",
    createdBy,
    ...ids,
    credentials: {
      production: { branches: [link.productionBranch] },
      preview: { branches: ["*"] },
    },
  });
}

export async function claimPipeline(
  tx: Executor,
  id: string,
  ids: { repositoryId: string; repositoryOwnerId: string },
): Promise<TrustedPipeline | undefined> {
  const [claimed] = await tx
    .update(trustedPipeline)
    .set({
      repositoryId: sql`coalesce(${trustedPipeline.repositoryId}, ${ids.repositoryId})`,
      repositoryOwnerId: sql`coalesce(${trustedPipeline.repositoryOwnerId}, ${ids.repositoryOwnerId})`,
      lastUsedAt: sql`now()`,
    })
    .where(
      and(
        eq(trustedPipeline.id, id),
        or(
          isNull(trustedPipeline.repositoryId),
          and(
            eq(trustedPipeline.repositoryId, ids.repositoryId),
            eq(trustedPipeline.repositoryOwnerId, ids.repositoryOwnerId),
          ),
        ),
      ),
    )
    .returning();
  return claimed;
}

export async function spendPipelineToken(
  tx: Executor,
  issuer: string,
  jti: string,
  expiresAt: Date,
): Promise<boolean> {
  const spent = await tx
    .insert(pipelineToken)
    .values({ issuer, jti, expiresAt })
    .onConflictDoNothing()
    .returning({ jti: pipelineToken.jti });
  return spent.length > 0;
}

export async function forgetExpiredPipelineTokens(): Promise<void> {
  await db.delete(pipelineToken).where(lt(pipelineToken.expiresAt, sql`now()`));
}
