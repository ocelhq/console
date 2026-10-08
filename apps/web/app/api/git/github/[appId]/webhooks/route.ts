import { githubWebhooks } from "@console/api";

export async function POST(request: Request, { params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  return githubWebhooks(request, appId);
}
