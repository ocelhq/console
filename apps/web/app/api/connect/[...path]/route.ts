import { connectHandler } from "@console/api";
import { configuredGit } from "@console/git";
import { jobChanged } from "@console/jobs/tasks";

const handle = connectHandler({ notify: jobChanged, git: configuredGit });

export async function POST(request: Request) {
  return handle(request);
}
