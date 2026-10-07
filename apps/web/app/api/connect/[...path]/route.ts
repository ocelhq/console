import { connect } from "@console/api";

export async function POST(request: Request) {
  return connect(request);
}
