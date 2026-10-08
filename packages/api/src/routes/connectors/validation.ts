import { z } from "zod";

export const heartbeatSchema = z.object({
  version: z.string().min(1).max(64),
  capabilities: z.array(z.string().min(1).max(128)).max(32),
});
