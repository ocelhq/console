import { answered, reachJobs } from "../reach";

export async function cancelCloudJob(request: Request, id: string): Promise<Response> {
  const reached = await reachJobs(request, id);
  if (!reached.ok) {
    return reached.refusal;
  }
  return answered(await reached.jobs.cancel(id));
}
