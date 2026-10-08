import { manifestCallback } from "@console/api";
import { git } from "@/lib/git";

export async function GET(request: Request) {
  return manifestCallback(request, git());
}
