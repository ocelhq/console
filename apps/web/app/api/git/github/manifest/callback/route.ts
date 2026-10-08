import { manifestCallback } from "@console/api";

export async function GET(request: Request) {
  return manifestCallback(request);
}
