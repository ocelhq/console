import { type Job, JobState } from "@console/connectors/gen/cloud/v1/job_pb";
import { DeploymentSchema } from "@console/connectors/gen/console/v1/deployment_pb";
import { recordDeployment } from "../deployments/report";
import { validator } from "../validator";
import type { CloudCaller } from "./caller";

const terminal = new Set([JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELED]);

export async function recordJobReport(
  caller: Pick<CloudCaller, "userId" | "organizationId">,
  job: Job,
): Promise<void> {
  const { report } = job;
  if (!report || !terminal.has(job.state) || !job.projectId) {
    return;
  }
  try {
    const checked = validator.validate(DeploymentSchema, report);
    if (checked.kind !== "valid") {
      console.error("cloud: a finished job's deployment report is not valid", {
        jobId: job.id,
        error: checked.error.message,
      });
      return;
    }
    const recorded = await recordDeployment(caller.organizationId, job.projectId, report, {
      kind: "session",
      userId: caller.userId,
    });
    if (recorded?.recording === "differs") {
      console.error("cloud: a finished job reports a deployment already recorded differently", {
        jobId: job.id,
        deploymentId: report.id,
      });
    }
  } catch (thrown) {
    console.error("cloud: a finished job's deployment report was not recorded", {
      jobId: job.id,
      error: thrown instanceof Error ? thrown.message : String(thrown),
    });
  }
}
