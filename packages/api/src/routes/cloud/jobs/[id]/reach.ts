import { cloudCallerOf } from "../../../../cloud/caller";
import {
  type CloudAnswer,
  type CloudJobs,
  type CloudRefusal,
  cloudJobsFor,
  JOB_ID,
} from "../../../../cloud/jobs";

export type Reached = { ok: true; jobs: CloudJobs } | { ok: false; refusal: Response };

export function notFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404 });
}

export async function reachJobs(request: Request, id: string): Promise<Reached> {
  const reach = await cloudCallerOf(request.headers, new URL(request.url).searchParams.get("org"));
  if (reach.state === "signed-out") {
    return { ok: false, refusal: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (reach.state === "not-member") {
    return { ok: false, refusal: notFound() };
  }
  const jobs = cloudJobsFor(reach.caller);
  if (!jobs || !JOB_ID.test(id)) {
    return { ok: false, refusal: notFound() };
  }
  return { ok: true, jobs };
}

const statuses: Record<CloudRefusal, number> = {
  "not-found": 404,
  forbidden: 403,
  stale: 409,
  invalid: 400,
  refused: 502,
  unreachable: 502,
  internal: 500,
};

export function answered<T>(answer: CloudAnswer<T>): Response {
  if (answer.ok) {
    return Response.json(answer.result, { status: 200 });
  }
  if (answer.reason === "not-found") {
    return notFound();
  }
  return Response.json(
    { error: answer.message, reason: answer.reason },
    { status: statuses[answer.reason] },
  );
}
