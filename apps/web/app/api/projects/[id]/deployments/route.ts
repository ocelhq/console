import { listDeployments } from "@console/api";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return listDeployments(request, id);
}
