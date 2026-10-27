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

function denied(refused: string, why: string): ConnectError {
  return new ConnectError(`${refused}: ${why}`, Code.PermissionDenied);
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

interface Gate {
  refused: string;
  problem(pipeline: TrustedPipeline, claims: GithubActionsClaims, run: Run): string | undefined;
}

function branchProblem(
  patterns: readonly string[],
  claims: GithubActionsClaims,
  run: Run,
  whose: string,
): string | undefined {
  const { branch } = run;
  if (branch === undefined) {
    return `ref ${claims.ref} of a ${claims.event_name} run names no branch`;
  }
  if (!patterns.some((pattern) => branchMatches(pattern, branch))) {
    return `branch ${branch} matches none of ${whose}: ${patterns.join(", ")}`;
  }
  return undefined;
}

function reporting(tier: ReportTier): Gate {
  return {
    refused: "This run may not report to the project",
    problem(pipeline, claims, run) {
      return (
        branchProblem(pipeline.branches, claims, run, "the pipeline's branches") ??
        (run.pullRequest && tier === "production"
          ? `a ${claims.event_name} run may report only a preview`
          : undefined)
      );
    },
  };
}

const CREDENTIAL_EVENTS: Record<ReportTier, ReadonlySet<string>> = {
  production: new Set(["push", "workflow_dispatch"]),
  preview: new Set(["pull_request", "push", "workflow_dispatch"]),
};

function credentials(tier: ReportTier): Gate {
  return {
    refused: "This run may not get credentials for the project",
    problem(pipeline, claims, run) {
      if (!CREDENTIAL_EVENTS[tier].has(claims.event_name)) {
        return `a ${claims.event_name} run gets no ${tier} credentials`;
      }
      const grant = pipeline.credentials[tier];
      if (!grant) {
        return `the pipeline holds no ${tier} credential grant`;
      }
      const branch =
        branchProblem(pipeline.branches, claims, run, "the pipeline's branches") ??
        branchProblem(grant.branches, claims, run, `the pipeline's ${tier} credential branches`);
      if (branch) return branch;
      if (grant.environment && claims.environment !== grant.environment) {
        return `environment ${claims.environment || "(none)"} is not the one the ${tier} credential grant names: ${grant.environment}`;
      }
      return undefined;
    },
  };
}

type Verdict = { ok: true } | { ok: false; repository: boolean; why: string };

function judge(
  pipeline: TrustedPipeline,
  claims: GithubActionsClaims,
  run: Run,
  gate: Gate,
): Verdict {
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
  const problem = gate.problem(pipeline, claims, run);
  return problem === undefined ? { ok: true } : fail(problem);
}

function chosen(pipelines: TrustedPipeline[], claims: GithubActionsClaims, run: Run, gate: Gate) {
  let closest: Extract<Verdict, { ok: false }> | undefined;
  for (const pipeline of pipelines) {
    const verdict = judge(pipeline, claims, run, gate);
    if (verdict.ok) return pipeline;
    if (!closest || (verdict.repository && !closest.repository)) closest = verdict;
  }
  throw denied(gate.refused, closest?.why ?? "the project trusts no pipeline");
}

async function admit(
  token: string,
  projectId: string,
  gate: Gate,
  deps: PipelineKeys,
): Promise<AdmittedPipeline> {
  const claims = await verified(token, deps);
  const run = runOf(claims);
  const pipeline = chosen(await pipelinesOf(projectId), claims, run, gate);
  return { pipeline, claims, ...(run.pr === undefined ? {} : { pr: run.pr }) };
}

export function admitPipeline(
  token: string,
  request: { projectId: string; tier: ReportTier },
  deps: PipelineKeys,
): Promise<AdmittedPipeline> {
  return admit(token, request.projectId, reporting(request.tier), deps);
}

export function admitCredential(
  token: string,
  request: { projectId: string; tier: ReportTier },
  deps: PipelineKeys,
): Promise<AdmittedPipeline> {
  return admit(token, request.projectId, credentials(request.tier), deps);
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
    throw new ConnectError(
      `Pipeline ${pipeline.id} is gone or was pinned to another repository`,
      Code.PermissionDenied,
    );
  }
}
