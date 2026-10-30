import { cancelJobRun } from "@console/api";
import { jobDeps } from "@console/jobs/tasks";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return cancelJobRun(request, id, jobDeps());
}
