import { env } from "@console/infra/env";
import { deployment } from "ocel/env";

export function consoleOrigin(): string {
  return new URL(env.BETTER_AUTH_URL ?? deployment.url).origin;
}
