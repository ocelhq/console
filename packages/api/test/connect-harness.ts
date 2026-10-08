import type { DescService, MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { Lifecycle, Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  AppOutcome,
  ComputeKind,
  DeploymentKind,
  DeploymentOutcome,
  type DeploymentSchema,
  DeploymentService,
  TriggerKind,
} from "@console/connectors/gen/console/v1/deployment_pb";
import { db } from "@console/db";
import { project } from "@console/db/schema";
import { CONNECT_PREFIX, connect } from "../src/routes/connect/route";

export const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";

export function serviceClient<S extends DescService>(service: S, bearer: string | null) {
  const interceptors: Interceptor[] = bearer
    ? [
        (next) => (req) => {
          req.header.set("Authorization", `Bearer ${bearer}`);
          return next(req);
        },
      ]
    : [];
  return createClient(
    service,
    createConnectTransport({
      baseUrl: `http://localhost${CONNECT_PREFIX}`,
      interceptors,
      fetch: (input, init) => connect(new Request(input, init)),
    }),
  );
}

export function connectClient(bearer: string | null) {
  return serviceClient(DeploymentService, bearer);
}

export async function projectIn(organizationId: string, slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(project).values({ id, organizationId, name: "My Project", slug });
  return id;
}

export function deploymentRecord(
  overrides: MessageInitShape<typeof DeploymentSchema> = {},
): MessageInitShape<typeof DeploymentSchema> {
  const record: MessageInitShape<typeof DeploymentSchema> = {
    id: TRACE_ID,
    kind: DeploymentKind.DEPLOY,
    outcome: DeploymentOutcome.SUCCEEDED,
    environment: { tier: Tier.PRODUCTION, lifecycle: Lifecycle.PERSISTENT },
    provider: { name: "aws", region: "us-east-1" },
    target: "aws/123456789012/us-east-1/main",
    startedAt: timestampFromDate(new Date("2025-12-31T23:58:00.000Z")),
    finishedAt: timestampFromDate(new Date("2026-01-01T00:00:00.000Z")),
    cliVersion: "0.0.2",
    promotion: { id: "prm-1", seq: 3n, tag: "v1" },
    edge: { kind: "cloudfront" },
    trigger: { kind: TriggerKind.CI, actor: "victor" },
    source: { commit: "0123456789abcdef", branch: "main" },
    ci: { name: "github", repo: "ocelhq/app", runUrl: "https://github.com/ocelhq/app/runs/1" },
    apps: [
      {
        name: "web",
        runtime: { name: "nodejs22.x", arch: "arm64" },
        framework: "next",
        compute: ComputeKind.SERVERLESS,
        buildId: "build-1",
        release: "rel-1",
        urls: ["https://web.example.com"],
        hostnames: ["web.example.com"],
        outcome: AppOutcome.SUCCEEDED,
        variables: [{ key: "DATABASE_URL", class: 3, folders: ["/web", "/api"] }],
      },
    ],
    resources: [
      { name: "main", type: "postgres", binding: { name: "main", propertyKeys: ["host"] } },
    ],
    links: [{ app: "web", resource: "main", grants: [{ label: "read", actions: ["select"] }] }],
    usages: [{ app: "web", resource: "main", files: ["app/page.tsx"] }],
  };
  return { ...record, ...overrides } as MessageInitShape<typeof DeploymentSchema>;
}
