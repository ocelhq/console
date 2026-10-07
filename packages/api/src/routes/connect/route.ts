import { createRegistry } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { createConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";
import { createValidateInterceptor } from "@connectrpc/validate";
import { file_common_environment_v1_environment } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  DeploymentService,
  file_console_v1_deployment,
} from "@console/connectors/gen/console/v1/deployment_pb";
import { deploymentService } from "./deployment-service";
import { sessionInterceptor } from "./session";

export const CONNECT_PREFIX = "/api/connect";

const validator = createValidator({
  registry: createRegistry(file_console_v1_deployment, file_common_environment_v1_environment),
});

const handlers = createConnectRouter({
  interceptors: [sessionInterceptor, createValidateInterceptor({ validator })],
})
  .service(DeploymentService, deploymentService)
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
