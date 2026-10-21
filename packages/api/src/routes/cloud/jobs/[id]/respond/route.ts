import { fromJson, type JsonObject, type JsonValue } from "@bufbuild/protobuf";
import {
  type RespondJobRequest,
  RespondJobRequestSchema,
} from "@console/connectors/gen/cloud/v1/job_pb";
import { readJson } from "../../../../../body";
import { validator } from "../../../../../validator";
import { answered, reachJobs } from "../reach";

export const RESPOND_BODY_LIMIT = 512 * 1024;

export interface VariableAnswer {
  key: string;
  folder: string;
  value: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protoJsonOf(body: unknown): JsonObject | null {
  if (!isObject(body)) {
    return null;
  }
  const { inputId = null, answer, ...extra } = body;
  if (!isObject(answer) || Object.keys(extra).length > 0) {
    return null;
  }
  const { kind, ...given } = answer;
  switch (kind) {
    case "variables":
      return { inputId, variables: given };
    case "confirmation":
      return Object.keys(given).length === 1
        ? { inputId, confirmed: given.confirmed ?? null }
        : null;
    default:
      return null;
  }
}

function requestOf(jobId: string, body: unknown): RespondJobRequest | null {
  const json = protoJsonOf(body);
  if (!json) {
    return null;
  }
  try {
    return fromJson(RespondJobRequestSchema, { ...json, jobId } satisfies JsonValue);
  } catch {
    return null;
  }
}

function refuse(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

export async function respondCloudJob(request: Request, id: string): Promise<Response> {
  const reached = await reachJobs(request, id);
  if (!reached.ok) {
    return reached.refusal;
  }
  const read = await readJson(request, RESPOND_BODY_LIMIT);
  if (!read.ok) {
    return read.refusal;
  }
  const answer = requestOf(id, read.data);
  if (!answer) {
    return refuse("Invalid request");
  }
  const checked = validator.validate(RespondJobRequestSchema, answer);
  if (checked.kind !== "valid") {
    return refuse(checked.error.message);
  }
  return answered(await reached.jobs.respond(answer));
}
