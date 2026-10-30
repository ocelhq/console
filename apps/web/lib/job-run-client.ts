import type { JobAnswer, JobEvents, RunJob } from "@console/api";

export interface JobRef {
  of: "deployments" | "jobs";
  id: string;
}

export type Lost = "gone" | "signed-out";

export type JobReply<T> =
  | { kind: "ok"; value: T }
  | { kind: "lost"; why: Lost }
  | { kind: "stale"; message: string | null }
  | { kind: "failed"; message: string | null };

function apiURL(ref: JobRef, action: "events" | "cancel" | "respond", query = {}): string {
  const params = new URLSearchParams(query).toString();
  const path = `/api/${ref.of}/${encodeURIComponent(ref.id)}/run/${action}`;
  return params ? `${path}?${params}` : path;
}

async function call<T>(url: string, init: RequestInit): Promise<JobReply<T>> {
  try {
    const response = await fetch(url, init);
    if (response.ok) {
      return { kind: "ok", value: (await response.json()) as T };
    }
    if (response.status === 404) {
      return { kind: "lost", why: "gone" };
    }
    if (response.status === 401) {
      return { kind: "lost", why: "signed-out" };
    }
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      reason?: string;
    } | null;
    const message = body?.error ?? null;
    return response.status === 409 && body?.reason === "stale"
      ? { kind: "stale", message }
      : { kind: "failed", message };
  } catch {
    return { kind: "failed", message: null };
  }
}

export function readEvents(ref: JobRef, after: number): Promise<JobReply<JobEvents>> {
  return call(apiURL(ref, "events", { after: String(after) }), { cache: "no-store" });
}

export function cancelJob(ref: JobRef): Promise<JobReply<RunJob>> {
  return call(apiURL(ref, "cancel"), { method: "POST" });
}

export function respondToJob(
  ref: JobRef,
  inputId: string,
  answer: JobAnswer,
): Promise<JobReply<RunJob>> {
  return call(apiURL(ref, "respond"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputId, ...answer }),
  });
}
