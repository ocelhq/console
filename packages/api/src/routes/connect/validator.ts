import { createRegistry } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { file_common_environment_v1_environment } from "@console/connectors/gen/common/environment/v1/environment_pb";
import { file_console_v1_connector } from "@console/connectors/gen/console/v1/connector_pb";
import { file_console_v1_console } from "@console/connectors/gen/console/v1/console_pb";
import { file_console_v1_deployment } from "@console/connectors/gen/console/v1/deployment_pb";
import { file_console_v1_project } from "@console/connectors/gen/console/v1/project_pb";

export const validator = createValidator({
  registry: createRegistry(
    file_console_v1_deployment,
    file_console_v1_project,
    file_console_v1_connector,
    file_console_v1_console,
    file_common_environment_v1_environment,
  ),
});
