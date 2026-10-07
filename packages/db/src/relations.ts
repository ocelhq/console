import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  user: {
    sessions: r.many.session(),
    accounts: r.many.account(),
    members: r.many.member(),
    invitations: r.many.invitation(),
  },
  session: {
    user: r.one.user({ from: r.session.userId, to: r.user.id, optional: false }),
  },
  account: {
    user: r.one.user({ from: r.account.userId, to: r.user.id, optional: false }),
  },
  organization: {
    members: r.many.member(),
    invitations: r.many.invitation(),
  },
  member: {
    organization: r.one.organization({
      from: r.member.organizationId,
      to: r.organization.id,
      optional: false,
    }),
    user: r.one.user({ from: r.member.userId, to: r.user.id, optional: false }),
  },
  invitation: {
    organization: r.one.organization({
      from: r.invitation.organizationId,
      to: r.organization.id,
      optional: false,
    }),
    user: r.one.user({ from: r.invitation.inviterId, to: r.user.id, optional: false }),
  },
  connector: {
    organization: r.one.organization({
      from: r.connector.organizationId,
      to: r.organization.id,
      optional: false,
    }),
  },
  project: {
    organization: r.one.organization({
      from: r.project.organizationId,
      to: r.organization.id,
      optional: false,
    }),
    createdByUser: r.one.user({ from: r.project.createdBy, to: r.user.id }),
  },
  deployment: {
    project: r.one.project({ from: r.deployment.projectId, to: r.project.id, optional: false }),
  },
  environmentEvent: {
    project: r.one.project({
      from: r.environmentEvent.projectId,
      to: r.project.id,
      optional: false,
    }),
  },
}));
