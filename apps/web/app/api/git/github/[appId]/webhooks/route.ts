import { githubWebhooks } from "@console/api";
import { webhookEvents } from "@console/jobs/tasks";
import { git } from "@/lib/git";

export async function POST(request: Request, { params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  return githubWebhooks(request, appId, git(), webhookEvents);
}
