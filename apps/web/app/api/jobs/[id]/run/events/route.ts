import { listJobRunEvents } from "@console/api";
import { jobDeps } from "@console/jobs/tasks";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return listJobRunEvents(request, id, jobDeps());
}
