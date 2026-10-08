import { githubSetup } from "@console/api";
import { git } from "@/lib/git";

export async function GET(request: Request, { params }: { params: Promise<{ appId: string }> }) {
  const { appId } = await params;
  return githubSetup(request, appId, git());
}
