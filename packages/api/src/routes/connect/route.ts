import { createConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { createValidateInterceptor } from "@connectrpc/validate";
import { ConnectorService } from "@console/connectors/gen/console/v1/connector_pb";
import { ConsoleService } from "@console/connectors/gen/console/v1/console_pb";
import { DeploymentService } from "@console/connectors/gen/console/v1/deployment_pb";
import { ProjectService } from "@console/connectors/gen/console/v1/project_pb";
import { connectorService } from "./connector-service";
import { consoleService } from "./console-service";
import { deploymentService } from "./deployment-service";
import { projectService } from "./project-service";
import { sessionInterceptor } from "./session";
import { validator } from "./validator";

export const CONNECT_PREFIX = "/api/connect";

const handlers = createConnectRouter({
  interceptors: [
    sessionInterceptor([ConsoleService.method.describe, ConnectorService.method.heartbeat]),
    createValidateInterceptor({ validator }),
  ],
})
  .service(DeploymentService, deploymentService)
  .service(ProjectService, projectService)
  .service(ConnectorService, connectorService)
  .service(ConsoleService, consoleService)
  .handlers.map((handler) => ({
    path: handler.requestPath,
    handle: createFetchHandler(handler),
  }));

export async function connect(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.slice(CONNECT_PREFIX.length);
  const found = handlers.find((handler) => handler.path === path);
  if (!found) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return found.handle(request);
}
