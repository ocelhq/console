import { createConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { createValidateInterceptor } from "@connectrpc/validate";
import { consoleOrigin } from "@console/auth";
import { ConnectorService } from "@console/connectors/gen/console/v1/connector_pb";
import { ConsoleService } from "@console/connectors/gen/console/v1/console_pb";
import { DeploymentService } from "@console/connectors/gen/console/v1/deployment_pb";
import { ProjectService } from "@console/connectors/gen/console/v1/project_pb";
import { TargetService } from "@console/connectors/gen/console/v1/target_pb";
import type { Job } from "@console/db/schema";
import type { GitRuntime } from "@console/git";
import { configuredIssuer, type Issuer } from "@console/targets";
import { githubActionsKeys, type PipelineKeys } from "../../pipelines/admit";
import { validator } from "../../validator";
import { callerInterceptor } from "./caller";
import { connectorService } from "./connector-service";
import { consoleService } from "./console-service";
import { deploymentService } from "./deployment-service";
import { projectService } from "./project-service";
import { targetService } from "./target-service";

export const CONNECT_PREFIX = "/api/connect";

export interface ConnectDeps {
  notify: (changed: Job) => Promise<void>;
  git: () => GitRuntime | undefined;
  pipelineKeys?: PipelineKeys;
  issuer?: () => Promise<Issuer> | undefined;
}

export function connectHandler(deps: ConnectDeps): (request: Request) => Promise<Response> {
  const pipelineKeys = () =>
    deps.pipelineKeys ?? { keys: githubActionsKeys(), audience: consoleOrigin() };
  const handlers = createConnectRouter({
    interceptors: [
      callerInterceptor({
        open: [
          ConsoleService.method.describe,
          ConsoleService.method.issueCloudToken,
          ConnectorService.method.heartbeat,
        ],
        pipelines: [
          DeploymentService.method.report,
          DeploymentService.method.recordEnvironmentEvent,
          TargetService.method.issueCredential,
        ],
      }),
      createValidateInterceptor({ validator }),
    ],
  })
    .service(
      DeploymentService,
      deploymentService({
        notify: deps.notify,
        git: deps.git,
        pipelineKeys,
      }),
    )
    .service(
      TargetService,
      targetService({
        issuer: deps.issuer ?? (() => configuredIssuer(consoleOrigin())),
        pipelineKeys,
      }),
    )
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
