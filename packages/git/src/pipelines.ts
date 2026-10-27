import { db } from "@console/db";
import { pipelineToken, type TrustedPipeline, trustedPipeline } from "@console/db/schema";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";

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

export async function removePipeline(projectId: string, id: string): Promise<boolean> {
  const removed = await db
    .delete(trustedPipeline)
    .where(and(eq(trustedPipeline.projectId, projectId), eq(trustedPipeline.id, id)))
    .returning({ id: trustedPipeline.id });
  return removed.length > 0;
}

export async function pinPipeline(
  id: string,
  ids: { repositoryId: string; repositoryOwnerId: string },
): Promise<TrustedPipeline | undefined> {
  const [pinned] = await db
    .update(trustedPipeline)
    .set(ids)
    .where(and(eq(trustedPipeline.id, id), isNull(trustedPipeline.repositoryId)))
    .returning();
  return pinned;
}

export async function pipelineUsed(id: string): Promise<void> {
  await db
    .update(trustedPipeline)
    .set({ lastUsedAt: sql`now()` })
    .where(eq(trustedPipeline.id, id));
}

export async function spendPipelineToken(
  issuer: string,
  jti: string,
  expiresAt: Date,
): Promise<boolean> {
  const spent = await db
    .insert(pipelineToken)
    .values({ issuer, jti, expiresAt })
    .onConflictDoNothing()
    .returning({ jti: pipelineToken.jti });
  return spent.length > 0;
}

export async function forgetExpiredPipelineTokens(): Promise<void> {
  await db.delete(pipelineToken).where(lt(pipelineToken.expiresAt, sql`now()`));
}
