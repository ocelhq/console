import { timestampDate } from "@bufbuild/protobuf/wkt";
import { VariableClass } from "@console/connectors/gen/app/resources/v1/variables_pb";
import type { Environment } from "@console/connectors/gen/common/environment/v1/environment_pb";
import { Tier } from "@console/connectors/gen/common/environment/v1/environment_pb";
import {
  AppOutcome,
  type CI,
  ComputeKind,
  type Deployment,
  DeploymentKind,
  DeploymentOutcome,
  type EnvironmentEvent,
  EnvironmentEventKind,
  type Resource,
  type Source,
  TriggerKind,
} from "@console/connectors/gen/console/v1/deployment_pb";
import type { Span } from "@console/connectors/gen/opentelemetry/proto/trace/v1/trace_pb";
import { Status_StatusCode } from "@console/connectors/gen/opentelemetry/proto/trace/v1/trace_pb";
import type {
  AppOutcome as AppOutcomeName,
  ComputeKind as ComputeKindName,
  DeploymentApp,
  DeploymentCi,
  DeploymentGit,
  DeploymentKind as DeploymentKindName,
  DeploymentOutcome as DeploymentOutcomeName,
  DeploymentResource,
  DeploymentStage,
  DeploymentTrigger,
  DeploymentVariable,
  EnvironmentClass,
  EnvironmentEventKind as EnvironmentEventKindName,
  Framework,
  TriggerKind as TriggerKindName,
  VariableClass as VariableClassName,
} from "@console/db/schema";

const deploymentKinds: Partial<Record<DeploymentKind, DeploymentKindName>> = {
  [DeploymentKind.DEPLOY]: "deploy",
  [DeploymentKind.PREVIEW_UP]: "preview-up",
  [DeploymentKind.ROLLBACK]: "rollback",
};

const deploymentOutcomes: Partial<Record<DeploymentOutcome, DeploymentOutcomeName>> = {
  [DeploymentOutcome.SUCCEEDED]: "succeeded",
  [DeploymentOutcome.FAILED]: "failed",
};

const appOutcomes: Partial<Record<AppOutcome, AppOutcomeName>> = {
  [AppOutcome.SUCCEEDED]: "succeeded",
  [AppOutcome.FAILED]: "failed",
  [AppOutcome.SKIPPED]: "skipped",
};

const computeKinds: Partial<Record<ComputeKind, ComputeKindName>> = {
  [ComputeKind.SERVERLESS]: "serverless",
  [ComputeKind.CONTAINER]: "container",
};

const triggerKinds: Partial<Record<TriggerKind, TriggerKindName>> = {
  [TriggerKind.CLI]: "cli",
  [TriggerKind.CI]: "ci",
  [TriggerKind.GIT]: "git",
};

const environmentClasses: Partial<Record<Tier, EnvironmentClass>> = {
  [Tier.PREVIEW]: "preview",
  [Tier.PRODUCTION]: "production",
};

const environmentEventKinds: Partial<Record<EnvironmentEventKind, EnvironmentEventKindName>> = {
  [EnvironmentEventKind.PREVIEW_REMOVED]: "preview-removed",
  [EnvironmentEventKind.DESTROYED]: "destroyed",
};

const variableClasses: Partial<Record<VariableClass, VariableClassName>> = {
  [VariableClass.UNSPECIFIED]: "plain",
  [VariableClass.PLAIN]: "plain",
  [VariableClass.SENSITIVE]: "sensitive",
  [VariableClass.SECRET]: "secret",
  [VariableClass.DERIVED]: "derived",
};

const frameworks: Record<string, Framework> = {
  node: "node",
  next: "nextjs",
  go: "go",
  python: "python",
  rust: "rust",
};

function named<K extends number, V>(names: Partial<Record<K, V>>, key: K, what: string): V {
  const found = names[key];
  if (found === undefined) {
    throw new Error(`protovalidate let through an unnamed ${what}: ${key}`);
  }
  return found;
}

function present(value: string): string | undefined {
  return value === "" ? undefined : value;
}

export function environmentOf(environment: Environment | undefined) {
  if (!environment) {
    throw new Error("protovalidate let through a record with no environment");
  }
  return {
    environmentClass: named(environmentClasses, environment.tier, "environment tier"),
    environmentIdentity: environment.identity,
  };
}

export function gitOf(source: Source | undefined): DeploymentGit | null {
  if (!source) {
    return null;
  }
  return { sha: present(source.commit), branch: present(source.branch), dirty: source.dirty };
}

export function ciOf(ci: CI | undefined): DeploymentCi | undefined {
  if (!ci) {
    return undefined;
  }
  return {
    provider: ci.name,
    repo: present(ci.repo),
    url: present(ci.runUrl),
    pr: ci.pr === 0 ? undefined : ci.pr,
  };
}

const NANOS_PER_MS = BigInt(1_000_000);

function stageOf(span: Span): DeploymentStage {
  const failed = span.status?.code === Status_StatusCode.ERROR;
  return {
    name: span.name,
    startedAt: new Date(Number(span.startTimeUnixNano / NANOS_PER_MS)).toISOString(),
    finishedAt: new Date(Number(span.endTimeUnixNano / NANOS_PER_MS)).toISOString(),
    status: failed ? "failed" : "succeeded",
    error: failed ? present(span.status?.message ?? "") : undefined,
    log: [],
  };
}

function appsOf(deployment: Deployment): DeploymentApp[] {
  return deployment.apps.map((app) => ({
    name: app.name,
    folder: present(app.folder),
    runtime: app.runtime && { name: app.runtime.name, arch: present(app.runtime.arch) },
    framework: app.framework === "" ? undefined : frameworks[app.framework],
    compute: named(computeKinds, app.compute, "compute kind"),
    deploymentId: present(app.release),
    buildId: present(app.buildId),
    urls: app.urls,
    hostnames: app.hostnames,
    healthPath: present(app.healthPath),
    outcome: named(appOutcomes, app.outcome, "app outcome"),
    error: present(app.error),
    variables: app.variables.flatMap((variable): DeploymentVariable[] =>
      (variable.folders.length === 0 ? [""] : variable.folders).map((folder) => ({
        key: variable.key,
        class: named(variableClasses, variable.class, "variable class"),
        folder,
        description: present(variable.description),
        group: present(variable.group),
        required: variable.required,
      })),
    ),
  }));
}

function resourcesOf(deployment: Deployment): DeploymentResource[] {
  return deployment.resources.map((resource: Resource) => {
    const grants = deployment.links
      .filter((link) => link.resource === resource.name)
      .flatMap((link) => link.grants)
      .map((grant) => ({ verb: present(grant.label), actions: grant.actions }));
    const distinct = grants.filter(
      (grant, at) =>
        grants.findIndex(
          (other) =>
            other.verb === grant.verb && other.actions.join("\n") === grant.actions.join("\n"),
        ) === at,
    );
    return {
      name: resource.name,
      type: resource.type as DeploymentResource["type"],
      binding: {
        name: resource.binding?.name ?? resource.name,
        source: present(resource.binding?.source ?? ""),
        propertyKeys: resource.binding?.propertyKeys ?? [],
        grants: distinct,
      },
    };
  });
}

export function deploymentValues(projectId: string, id: string, deployment: Deployment) {
  const trigger: DeploymentTrigger = {
    kind: named(triggerKinds, deployment.trigger?.kind ?? 0, "trigger kind"),
    actor: present(deployment.trigger?.actor ?? ""),
    ci: ciOf(deployment.ci),
  };
  return {
    id,
    projectId,
    runId: deployment.id,
    kind: named(deploymentKinds, deployment.kind, "deployment kind"),
    ...environmentOf(deployment.environment),
    promotionId: deployment.promotion?.id ?? null,
    tag: present(deployment.promotion?.tag ?? "") ?? null,
    providerName: deployment.provider?.name ?? "",
    providerRegion: present(deployment.provider?.region ?? "") ?? null,
    target: deployment.target,
    edgeKind: deployment.edge?.kind ?? null,
    outcome: named(deploymentOutcomes, deployment.outcome, "deployment outcome"),
    error: present(deployment.error) ?? null,
    trigger,
    git: gitOf(deployment.source),
    cliVersion: present(deployment.cliVersion) ?? null,
    startedAt: deployment.startedAt ? timestampDate(deployment.startedAt) : null,
    deployedAt: deployment.finishedAt ? timestampDate(deployment.finishedAt) : new Date(),
    trace: deployment.spans.map(stageOf),
    topology: {
      apps: appsOf(deployment),
      resources: resourcesOf(deployment),
      usages: deployment.usages.map((usage) => ({
        app: usage.app,
        resource: usage.resource,
        files: usage.files,
      })),
      variableGroups: deployment.variableGroups.map((group) => ({
        key: group.key,
        required: group.required,
        description: present(group.description),
      })),
    },
  };
}

export function environmentEventValues(projectId: string, id: string, event: EnvironmentEvent) {
  return {
    id,
    projectId,
    runId: event.id,
    kind: named(environmentEventKinds, event.kind, "environment event kind"),
    ...environmentOf(event.environment),
    occurredAt: event.at ? timestampDate(event.at) : new Date(),
    git: gitOf(event.source),
    ci: ciOf(event.ci) ?? null,
  };
}
