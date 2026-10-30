import { sessionMember } from "@console/api";
import type { ActiveOrganizationSession } from "@console/auth";
import type { DescMethod, Endpoint, Refusal } from "@console/connectors";
import { endpointServing, type ResolvedEndpoint, reachOf, recordDenied } from "@console/endpoints";
import type { Ability } from "@ocelhq/variables-ui";
import { abilityOf } from "./endpoint-grant";

export interface Reach {
  endpoint: Endpoint;
  ability: Ability;
  serves(call: DescMethod): boolean;
  denied(verb: string, refusal: Refusal): Promise<void>;
}

export const barred: Ability = { write: false, reveal: false };

type Session = Pick<ActiveOrganizationSession, "userId" | "activeOrganizationId">;

export async function sessionReach(
  session: Session,
  endpoint: ResolvedEndpoint,
): Promise<Reach | null> {
  const reach = reachOf(await sessionMember(session), endpoint);
  if (!reach) return null;
  return {
    endpoint: reach.at,
    ability: abilityOf(reach),
    serves: reach.serves,
    denied: (verb, refusal) => recordDenied(endpoint, verb, refusal),
  };
}

export async function endpointFor(session: Session, target: string | null): Promise<Reach | null> {
  if (!target) return null;
  const endpoint = await endpointServing(session.activeOrganizationId, target);
  return endpoint ? sessionReach(session, endpoint) : null;
}
