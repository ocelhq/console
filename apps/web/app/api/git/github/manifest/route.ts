import { startManifest } from "@console/api";
import { git } from "@/lib/git";

export async function POST(request: Request) {
  return startManifest(request, git());
}
