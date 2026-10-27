import { Code, ConnectError } from "@connectrpc/connect";
import type { Executor } from "@console/db";
import type { TrustedPipeline } from "@console/db/schema";
import {
  claimPipeline,
  GITHUB_ACTIONS_ISSUER,
  pipelinesOf,
  spendPipelineToken,
} from "@console/git";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import { z } from "zod";

export type ReportTier = "preview" | "production";

const claim = z.string().min(1);

const githubActionsClaims = z.object({
  jti: claim,
  exp: z.number(),
  repository: claim,
  repository_id: claim,
  repository_owner_id: claim,
  job_workflow_ref: claim,
  event_name: claim,
  ref: claim,
  head_ref: z.string().optional(),
  environment: z.string().optional(),
  actor: claim,
  run_id: claim,
  run_attempt: claim,
});

export type GithubActionsClaims = z.infer<typeof githubActionsClaims>;

export interface AdmittedPipeline {
  pipeline: TrustedPipeline;
  claims: GithubActionsClaims;
  pr?: number;
}

export interface PipelineKeys {
  keys: JWTVerifyGetKey;
  audience: string;
}

const PULL_REQUEST_EVENTS = new Set(["pull_request", "pull_request_target"]);

let githubKeys: JWTVerifyGetKey | undefined;

export function githubActionsKeys(): JWTVerifyGetKey {
  githubKeys ??= createRemoteJWKSet(new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`));
  return githubKeys;
}

function unauthenticated(why: string): ConnectError {
  return new ConnectError(`The GitHub Actions token is not valid: ${why}`, Code.Unauthenticated);
}

function denied(why: string): ConnectError {
  return new ConnectError(`This run may not report to the project: ${why}`, Code.PermissionDenied);
}

async function verified(token: string, deps: PipelineKeys): Promise<GithubActionsClaims> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, deps.keys, {
      issuer: GITHUB_ACTIONS_ISSUER,
      audience: deps.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "jti"],
    }));
  } catch (error) {
    throw unauthenticated(error instanceof Error ? error.message : String(error));
  }
  const parsed = githubActionsClaims.safeParse(payload);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw unauthenticated(`its ${issue?.path.join(".") ?? "claims"} claim is ${issue?.message}`);
  }
  return parsed.data;
}

interface Run {
  pullRequest: boolean;
  branch?: string;
  pr?: number;
}

function runOf(claims: GithubActionsClaims): Run {
  if (PULL_REQUEST_EVENTS.has(claims.event_name)) {
    const pr = /^refs\/pull\/(\d+)\/merge$/.exec(claims.ref)?.[1];
    return {
      pullRequest: true,
      branch: claims.head_ref || undefined,
      pr: pr === undefined ? undefined : Number(pr),
    };
  }
  const branch = /^refs\/heads\/(.+)$/.exec(claims.ref)?.[1];
  return { pullRequest: false, branch };
}

export function branchMatches(pattern: string, branch: string): boolean {
  const source = pattern
    .split("*")
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(branch);
}

function workflowOf(claims: GithubActionsClaims): string | undefined {
  const [at] = claims.job_workflow_ref.split("@");
  const prefix = `${claims.repository}/`;
  return at?.toLowerCase().startsWith(prefix.toLowerCase()) ? at.slice(prefix.length) : undefined;
}

type Verdict = { ok: true } | { ok: false; repository: boolean; why: string };

function judge(pipeline: TrustedPipeline, claims: GithubActionsClaims, run: Run): Verdict {
  if (pipeline.repositoryId === null) {
    if (pipeline.repository.toLowerCase() !== claims.repository.toLowerCase()) {
      return {
        ok: false,
        repository: false,
        why: `repository ${claims.repository} is not the pipeline's: ${pipeline.repository}`,
      };
    }
  } else if (pipeline.repositoryId !== claims.repository_id) {
    return {
      ok: false,
      repository: false,
      why: `repository ${claims.repository} (repository_id ${claims.repository_id}) is not the pipeline's: ${pipeline.repository} (repository_id ${pipeline.repositoryId})`,
    };
  } else if (pipeline.repositoryOwnerId !== claims.repository_owner_id) {
    return {
      ok: false,
      repository: false,
      why: `repository_owner_id ${claims.repository_owner_id} is not the pipeline's: ${pipeline.repositoryOwnerId}`,
    };
  }

  const fail = (why: string): Verdict => ({ ok: false, repository: true, why });
  if (pipeline.workflow !== null) {
    const workflow = workflowOf(claims);
    if (workflow !== pipeline.workflow) {
      return fail(
        `workflow ${workflow ?? claims.job_workflow_ref} is not the pipeline's: ${pipeline.workflow}`,
      );
    }
  }
  if (pipeline.environment !== null && claims.environment !== pipeline.environment) {
    return fail(
      `environment ${claims.environment || "(none)"} is not the pipeline's: ${pipeline.environment}`,
    );
  }
  const { branch } = run;
  if (branch === undefined) {
    return fail(`ref ${claims.ref} of a ${claims.event_name} run names no branch`);
  }
  if (!pipeline.branches.some((pattern) => branchMatches(pattern, branch))) {
    return fail(
      `branch ${branch} matches none of the pipeline's branches: ${pipeline.branches.join(", ")}`,
    );
  }
  return { ok: true };
}

function chosen(pipelines: TrustedPipeline[], claims: GithubActionsClaims, run: Run) {
  let closest: Extract<Verdict, { ok: false }> | undefined;
  for (const pipeline of pipelines) {
    const verdict = judge(pipeline, claims, run);
    if (verdict.ok) return pipeline;
    if (!closest || (verdict.repository && !closest.repository)) closest = verdict;
  }
  throw denied(closest?.why ?? "the project trusts no pipeline");
}

export async function admitPipeline(
  token: string,
  request: { projectId: string; tier: ReportTier },
  deps: PipelineKeys,
): Promise<AdmittedPipeline> {
  const claims = await verified(token, deps);
  const run = runOf(claims);
  const pipeline = chosen(await pipelinesOf(request.projectId), claims, run);
  if (run.pullRequest && request.tier === "production") {
    throw denied(`a ${claims.event_name} run may report only a preview`);
  }
  return { pipeline, claims, ...(run.pr === undefined ? {} : { pr: run.pr }) };
}

export async function claimAdmission(tx: Executor, admitted: AdmittedPipeline): Promise<void> {
  const { claims, pipeline } = admitted;
  const expiresAt = new Date(claims.exp * 1000);
  if (!(await spendPipelineToken(tx, GITHUB_ACTIONS_ISSUER, claims.jti, expiresAt))) {
    throw unauthenticated(`token ${claims.jti} was already used`);
  }
  const claimed = await claimPipeline(tx, pipeline.id, {
    repositoryId: claims.repository_id,
    repositoryOwnerId: claims.repository_owner_id,
  });
  if (!claimed) {
    throw denied(`pipeline ${pipeline.id} is gone or was pinned to another repository`);
  }
}
