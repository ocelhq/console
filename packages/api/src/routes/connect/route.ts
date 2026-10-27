import type { DescMethod } from "@bufbuild/protobuf";
import { createConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { createValidateInterceptor } from "@connectrpc/validate";
import { consoleOrigin } from "@console/auth";
import { ConnectorService } from "@console/connectors/gen/console/v1/connector_pb";
import { ConsoleService } from "@console/connectors/gen/console/v1/console_pb";
import { DeploymentService } from "@console/connectors/gen/console/v1/deployment_pb";
import { ProjectService } from "@console/connectors/gen/console/v1/project_pb";
import type { Job } from "@console/db/schema";
import { githubActionsKeys, type PipelineKeys } from "../../pipelines/admit";
import { validator } from "../../validator";
import { callerInterceptor, type PipelineReport } from "./caller";
import { connectorService } from "./connector-service";
import { consoleService } from "./console-service";
import { deploymentService, environmentEventTier, reportTier } from "./deployment-service";
import { projectService } from "./project-service";

export const CONNECT_PREFIX = "/api/connect";

export interface ConnectDeps {
  notify?: (changed: Job) => Promise<void>;
  pipelineKeys?: PipelineKeys;
}

export function connectHandler(deps: ConnectDeps = {}): (request: Request) => Promise<Response> {
  const handlers = createConnectRouter({
    interceptors: [
      callerInterceptor({
        open: [
          ConsoleService.method.describe,
          ConsoleService.method.issueCloudToken,
          ConnectorService.method.heartbeat,
        ],
        pipelines: new Map<DescMethod, PipelineReport>([
          [DeploymentService.method.report, reportTier],
          [DeploymentService.method.recordEnvironmentEvent, environmentEventTier],
        ]),
        pipelineKeys: () =>
          deps.pipelineKeys ?? { keys: githubActionsKeys(), audience: consoleOrigin() },
      }),
      createValidateInterceptor({ validator }),
    ],
  })
    .service(DeploymentService, deploymentService({ notify: deps.notify ?? (async () => {}) }))
    .service(ProjectService, projectService)
    .service(ConnectorService, connectorService)
    .service(ConsoleService, consoleService)
    .handlers.map((handler) => ({
      path: handler.requestPath,
      handle: createFetchHandler(handler),
    }));

  return async (request) => {
    const path = new URL(request.url).pathname.slice(CONNECT_PREFIX.length);
    const found = handlers.find((handler) => handler.path === path);
    if (!found) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return found.handle(request);
  };
}
