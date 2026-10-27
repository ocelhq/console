import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { type ActiveOrganizationSession, administers, roleOf } from "@console/auth";
import type { TargetService } from "@console/connectors/gen/console/v1/target_pb";
import { db } from "@console/db";
import {
  accountProblem,
  audienceOf,
  bindProject,
  boundTarget,
  CREDENTIAL_LIFETIME_SECONDS,
  ISSUER_UNCONFIGURED,
  type Issuer,
  identityProblem,
  issue,
  isVendor,
  missingGrants,
  normalizedGrant,
  prepareTarget,
  projectInOrganization,
  recordTier,
  subjectPrefixOf,
  targetOf,
  unsupportedVendor,
} from "@console/targets";
import { tierNamed } from "../../deployments/record";
import {
  admitCredential,
  claimAdmission,
  type PipelineKeys,
  runUrlOf,
} from "../../pipelines/admit";
import { callerOf } from "./caller";
import { required } from "./required";

export interface TargetServiceDeps {
  issuer: () => Promise<Issuer> | undefined;
  pipelineKeys: () => PipelineKeys;
}

const LISTED_GRANTS = 10;

async function administered(context: HandlerContext): Promise<ActiveOrganizationSession> {
  const caller = callerOf(context);
  if (caller.kind !== "session") {
    throw new ConnectError(
      "Bootstrapping a target takes an admin's session",
      Code.PermissionDenied,
    );
  }
  const { session } = caller;
  if (!administers(await roleOf(session.userId, session.activeOrganizationId))) {
    throw new ConnectError(
      "Only an owner or admin of the organization can bootstrap a target",
      Code.PermissionDenied,
    );
  }
  return session;
}

async function ownedProject(organizationId: string, projectId: string): Promise<void> {
  if (projectId && !(await projectInOrganization(organizationId, projectId))) {
    throw new ConnectError(`No project ${projectId} in the session's organization`, Code.NotFound);
  }
}

function lacking(missing: string[]): string {
  const listed = missing.slice(0, LISTED_GRANTS).join(", ");
  const more = missing.length - LISTED_GRANTS;
  return more > 0 ? `${listed} and ${more} more` : listed;
}

export function targetService(deps: TargetServiceDeps): ServiceImpl<typeof TargetService> {
  async function issuer(): Promise<Issuer> {
    const configured = deps.issuer();
    if (!configured) {
      throw new ConnectError(ISSUER_UNCONFIGURED, Code.FailedPrecondition);
    }
    return configured;
  }

  return {
    async prepare(request, context) {
      const session = await administered(context);
      const { url } = await issuer();
      const { vendor } = request;
      if (!isVendor(vendor)) {
        throw new ConnectError(unsupportedVendor(vendor), Code.InvalidArgument);
      }
      const problem = accountProblem(vendor, request.account);
      if (problem) throw new ConnectError(problem, Code.InvalidArgument);
      const organizationId = session.activeOrganizationId;
      await ownedProject(organizationId, request.projectId);
      const target = await prepareTarget(organizationId, {
        vendor,
        account: request.account,
        region: request.region,
      });
      return {
        targetId: target.id,
        organizationId,
        issuer: url,
        audience: audienceOf(target.id),
        subjectPrefix: subjectPrefixOf(organizationId, target.id),
      };
    },

    async recordTier(request, context) {
      const session = await administered(context);
      const { url } = await issuer();
      const organizationId = session.activeOrganizationId;
      const target = await targetOf(organizationId, request.targetId);
      if (!target) {
        throw new ConnectError(
          `No target ${request.targetId} in the session's organization`,
          Code.NotFound,
        );
      }
      const { identityProvider, principal } = required(request.identity, "identity");
      const identity = { identityProvider, principal };
      const problem = identityProblem(target, identity, url);
      if (problem) throw new ConnectError(problem, Code.InvalidArgument);
      await ownedProject(organizationId, request.projectId);
      const tier = tierNamed(request.tier);
      await db.transaction(async (tx) => {
        await recordTier(tx, {
          targetId: target.id,
          tier,
          identity,
          grants: request.grants.map((grant) => normalizedGrant(target.vendor, grant)),
          cliVersion: request.cliVersion,
        });
        if (request.projectId) {
          await bindProject(tx, { projectId: request.projectId, tier, targetId: target.id });
        }
      });
      return {};
    },

    async issueCredential(request, context) {
      const caller = callerOf(context);
      if (caller.kind !== "pipeline-token") {
        throw new ConnectError(
          "Credentials are issued only to a trusted pipeline's GitHub Actions token",
          Code.PermissionDenied,
        );
      }
      const minter = await issuer();
      const tier = tierNamed(request.tier);
      const admitted = await admitCredential(
        caller.token,
        { projectId: request.projectId, tier },
        deps.pipelineKeys(),
      );

      const bound = await boundTarget(request.projectId, tier);
      if (!bound) {
        throw new ConnectError(
          `No target is bound to ${request.projectId} ${tier}: an admin runs \`ocel bootstrap ${tier}\` from a checkout linked to the project, or binds a target on its Targets page`,
          Code.NotFound,
        );
      }
      const { target } = bound;
      if (target.vendor !== request.vendor) {
        throw new ConnectError(
          `The project's ${tier} deploys to ${target.vendor} account ${target.account} (${target.region}), not to ${request.vendor}`,
          Code.FailedPrecondition,
        );
      }
      if (!bound.tier) {
        throw new ConnectError(
          `${target.vendor} account ${target.account} has no ${tier} identity recorded: an admin runs \`ocel bootstrap ${tier}\``,
          Code.FailedPrecondition,
        );
      }
      const missing = missingGrants(
        request.grants.map((grant) => normalizedGrant(target.vendor, grant)),
        bound.tier.grants,
      );
      if (missing.length > 0) {
        throw new ConnectError(
          `The ${tier} identity of ${target.vendor} account ${target.account} lacks ${missing.length} grant(s) this deploy needs: ${lacking(missing)}. ocel ${bound.tier.cliVersion} recorded it; to grant them, an admin runs \`ocel bootstrap ${tier}\` with ocel ${request.cliVersion}`,
          Code.FailedPrecondition,
        );
      }

      const minted = await db.transaction(async (tx) => {
        await claimAdmission(tx, admitted);
        return issue(tx, minter, {
          target,
          tier,
          lifetimeSeconds: CREDENTIAL_LIFETIME_SECONDS,
          purpose: "deploy",
          projectId: request.projectId,
          principal: {
            kind: "pipeline",
            pipelineId: admitted.pipeline.id,
            jti: admitted.claims.jti,
            runUrl: runUrlOf(admitted.claims),
          },
        });
      });
      return {
        token: minted.token,
        expiresAt: timestampFromDate(minted.expiresAt),
        targetId: target.id,
        account: target.account,
        region: target.region,
        sessionName: minted.sessionName,
        identity: {
          identityProvider: bound.tier.identityProvider,
          principal: bound.tier.principal,
        },
      };
    },
  };
}
