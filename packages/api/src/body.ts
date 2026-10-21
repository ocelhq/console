import type { ZodType } from "zod";

export type Read<T> = { ok: true; data: T } | { ok: false; refusal: Response };

function refuse(error: string, status: number): { ok: false; refusal: Response } {
  return { ok: false, refusal: Response.json({ error }, { status }) };
}

async function readText(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? "0") > limit) {
    return null;
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson(
  request: Request,
  limit = Number.POSITIVE_INFINITY,
): Promise<Read<unknown>> {
  const text = await readText(request, limit);
  if (text === null) {
    return refuse("The request body is too large", 413);
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return refuse("Invalid request body", 400);
  }
}

export async function readBody<T>(request: Request, schema: ZodType<T>): Promise<Read<T>> {
  const read = await readJson(request);
  if (!read.ok) {
    return read;
  }
  const parsed = schema.safeParse(read.data);
  if (!parsed.success) {
    return {
      ok: false,
      refusal: Response.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 },
      ),
    };
  }
  return { ok: true, data: parsed.data };
}
