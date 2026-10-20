import { cancelCloudJob } from "@console/api";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return cancelCloudJob(request, id);
}
