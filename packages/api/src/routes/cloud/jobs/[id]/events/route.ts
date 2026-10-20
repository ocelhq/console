import { answered, reachJobs } from "../reach";

const SEQ = /^(0|[1-9][0-9]{0,15})$/;

export async function listCloudJobEvents(request: Request, id: string): Promise<Response> {
  const after = new URL(request.url).searchParams.get("after") ?? "0";
  if (!SEQ.test(after) || !Number.isSafeInteger(Number(after))) {
    return Response.json(
      { error: "after is the seq of the last event already shown, a whole number" },
      { status: 400 },
    );
  }
  const reached = await reachJobs(request, id);
  if (!reached.ok) {
    return reached.refusal;
  }
  return answered(await reached.jobs.events(id, Number(after)));
}
