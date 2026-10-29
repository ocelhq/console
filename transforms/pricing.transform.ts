import { defineTransform } from "@ocel/transforms";
import { buildEnv } from "ocel/config";
import { z } from "zod";

const target = buildEnv({
  CONSOLE_PRICING_AWS_POLICY_ARN: z
    .string()
    .regex(/^arn:aws[\w-]*:iam::\d{12}:policy\/.+$/)
    .optional(),
});

export default defineTransform({
  aws: target.CONSOLE_PRICING_AWS_POLICY_ARN
    ? {
        function: {
          role: { managedPolicyArns: [target.CONSOLE_PRICING_AWS_POLICY_ARN] },
        },
      }
    : {},
});
