import { deploymentRuns, listRunEvents } from "../../../../../runs/relay";

export const listDeploymentRunEvents = listRunEvents(deploymentRuns);
