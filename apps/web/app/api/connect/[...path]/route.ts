import { connectHandler } from "@console/api";
import { jobChanged } from "@console/jobs/tasks";

const handle = connectHandler({ notify: jobChanged });

export async function POST(request: Request) {
  return handle(request);
}
