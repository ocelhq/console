import { create } from "@bufbuild/protobuf";
import { type Outcome, statusOf, ValueError } from "@console/connectors";
import {
  SupplyVariablesRequestSchema,
  VariableValueSchema,
} from "@console/connectors/gen/runner/v1/runner_pb";
import { db } from "@console/db";
import { deployment, job, project } from "@console/db/schema";
import type { Member } from "@console/endpoints";
import type { JobDeps } from "@console/jobs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { readJson } from "../body";
import { memberOf } from "../endpoints/member";
import { validator } from "../validator";
import { type JobRun, runOfDeployment, runOfJob, type ShownRun, STALE_INPUT } from "./run";

export interface RunSubject {
  organizationOf(id: string): Promise<string | undefined>;
  runOf(id: string, member: Member, deps: JobDeps): Promise<ShownRun | undefined>;
}

export const deploymentRuns: RunSubject = {
  async organizationOf(id) {
    const [found] = await db
      .select({ organizationId: project.organizationId })
      .from(deployment)
      .innerJoin(project, eq(project.id, deployment.projectId))
      .where(eq(deployment.id, id));
    return found?.organizationId;
  },
  runOf: runOfDeployment,
};

export const jobRuns: RunSubject = {
  async organizationOf(id) {
    const [found] = await db
      .select({ organizationId: project.organizationId })
      .from(job)
      .innerJoin(project, eq(project.id, job.projectId))
      .where(eq(job.id, id));
    return found?.organizationId;
  },
  runOf: runOfJob,
};

export type Reached = { ok: true; run: JobRun } | { ok: false; refusal: Response };

export function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

async function reachRun(
  subject: RunSubject,
  request: Request,
  id: string,
  deps: JobDeps,
): Promise<Reached> {
  if (!ID.test(id)) {
    return { ok: false, refusal: notFound() };
  }
  const organizationId = await subject.organizationOf(id);
  const reach = await memberOf(request.headers, organizationId ?? null);
  if (reach.state === "signed-out") {
    return { ok: false, refusal: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const run =
    organizationId && reach.state === "member" && (await subject.runOf(id, reach.member, deps));
  return run ? { ok: true, run: run.run } : { ok: false, refusal: notFound() };
}

const reasons: Record<number, string> = { 400: "invalid", 409: "stale" };

async function answered<T>(asked: () => Promise<Outcome<T>>): Promise<Response> {
  let answer: Outcome<T>;
  try {
    answer = await asked();
  } catch (thrown) {
    if (!(thrown instanceof ValueError)) throw thrown;
    if (thrown.status === 404) return notFound();
    return Response.json(
      {
        error: thrown.status === 409 ? STALE_INPUT : thrown.message,
        reason: reasons[thrown.status] ?? "invalid",
      },
      { status: thrown.status },
    );
  }
  if (answer.done) {
    return Response.json(answer.result, { status: 200 });
  }
  return Response.json(
    { error: answer.refusal.message, reason: answer.refusal.reason },
    { status: statusOf(answer.refusal) },
  );
}

export type RunRoute = (request: Request, id: string, deps: JobDeps) => Promise<Response>;

const SEQ = /^(0|[1-9][0-9]{0,15})$/;

export function listRunEvents(subject: RunSubject): RunRoute {
  return async (request, id, deps) => {
    const after = new URL(request.url).searchParams.get("after") ?? "0";
    if (!SEQ.test(after) || !Number.isSafeInteger(Number(after))) {
      return Response.json(
        { error: "after is the seq of the last event already shown, a whole number" },
        { status: 400 },
      );
    }
    const reached = await reachRun(subject, request, id, deps);
    if (!reached.ok) return reached.refusal;
    return answered(() => reached.run.events(Number(after)));
  };
}

export function cancelRun(subject: RunSubject): RunRoute {
  return async (request, id, deps) => {
    const reached = await reachRun(subject, request, id, deps);
    if (!reached.ok) return reached.refusal;
    return answered(() => reached.run.cancel());
  };
}

export const RESPOND_BODY_LIMIT = 512 * 1024;

export interface VariableAnswer {
  key: string;
  folder: string;
  value: string;
}

export type JobAnswer = { variables: { values: VariableAnswer[] } } | { confirmed: boolean };

const INPUT_ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const answerBody = z.union([
  z.object({ inputId: INPUT_ID, confirmed: z.boolean() }).strict(),
  z
    .object({
      inputId: INPUT_ID,
      variables: z
        .object({
          values: z.array(
            z
              .object({ key: z.string(), folder: z.string().default(""), value: z.string() })
              .strict(),
          ),
        })
        .strict(),
    })
    .strict(),
]);

const invalid = (error: string) => Response.json({ error }, { status: 400 });

export function respondToRun(subject: RunSubject): RunRoute {
  return async (request, id, deps) => {
    const reached = await reachRun(subject, request, id, deps);
    if (!reached.ok) return reached.refusal;
    const read = await readJson(request, RESPOND_BODY_LIMIT);
    if (!read.ok) return read.refusal;
    const parsed = answerBody.safeParse(read.data);
    if (!parsed.success) return invalid("Invalid request");
    if ("confirmed" in parsed.data) {
      const { inputId, confirmed } = parsed.data;
      return answered(() => reached.run.answerConfirmation(inputId, confirmed));
    }
    const { inputId } = parsed.data;
    const values = parsed.data.variables.values.map((value) => create(VariableValueSchema, value));
    const checked = validator.validate(
      SupplyVariablesRequestSchema,
      create(SupplyVariablesRequestSchema, { jobId: "job", inputId, variables: { values } }),
    );
    if (checked.kind !== "valid") return invalid(checked.error.message);
    return answered(() => reached.run.supplyVariables(inputId, values));
  };
}
