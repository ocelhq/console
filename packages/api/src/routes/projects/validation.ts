import { FRAMEWORKS } from "@console/db/schema";
import { z } from "zod";

export const updateProjectSchema = z.object({
  frameworks: z
    .array(z.enum(FRAMEWORKS))
    .max(FRAMEWORKS.length)
    .transform((values) => [...new Set(values)]),
});
