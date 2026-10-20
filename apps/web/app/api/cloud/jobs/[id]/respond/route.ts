import { respondCloudJob } from "@console/api";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return respondCloudJob(request, id);
}
