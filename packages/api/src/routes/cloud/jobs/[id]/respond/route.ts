import { z } from "zod";
import { JOB_ID } from "../../../../../cloud/jobs";
import { answered, reachJobs } from "../reach";

export const RESPOND_BODY_LIMIT = 512 * 1024;

function plain(text: string): boolean {
  return [...text].every((char) => {
    const code = char.charCodeAt(0);
    return char !== "#" && code > 0x1f && code !== 0x7f;
  });
}

function isFolder(text: string): boolean {
  return (
    text === "" ||
    (text.startsWith("/") &&
      text
        .slice(1)
        .split("/")
        .every((segment) => segment !== "" && plain(segment)))
  );
}

const respondSchema = z
  .object({
    inputId: z.string().regex(JOB_ID),
    answer: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("variables"),
          values: z
            .array(
              z
                .object({
                  key: z
                    .string()
                    .min(1)
                    .max(256)
                    .refine(plain, "a key has no # or control character"),
                  folder: z
                    .string()
                    .max(1024)
                    .refine(isFolder, "a folder is empty or /-separated, starting with /"),
                  value: z.string().min(1),
                })
                .strict(),
            )
            .min(1)
            .max(1000)
            .refine(
              (values) =>
                new Set(values.map((value) => `${value.folder}#${value.key}`)).size ===
                values.length,
              "each variable is answered once",
            ),
        })
        .strict(),
      z.object({ kind: z.literal("confirmation"), confirmed: z.boolean() }).strict(),
    ]),
  })
  .strict();

function refuse(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

async function readLimited(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > RESPOND_BODY_LIMIT || !request.body) {
    return declared > RESPOND_BODY_LIMIT ? null : "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPOND_BODY_LIMIT) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function respondCloudJob(request: Request, id: string): Promise<Response> {
  const reached = await reachJobs(request, id);
  if (!reached.ok) {
    return reached.refusal;
  }

  const text = await readLimited(request);
  if (text === null) {
    return refuse("The answer is too large", 413);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("Invalid request body", 400);
  }
  const parsed = respondSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid request",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      },
      { status: 400 },
    );
  }

  return answered(await reached.jobs.respond(id, parsed.data.inputId, parsed.data.answer));
}
