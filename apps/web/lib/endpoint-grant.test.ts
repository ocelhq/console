import { type DescMethod, Role, Scope, scopeForCall, USER_SCOPES } from "@console/connectors";
import { describe, expect, it } from "vitest";
import { abilityOf } from "./endpoint-grant";

const reachAs = (role: Role, allowed: readonly Scope[] = USER_SCOPES) => ({
  serves: (call: DescMethod) => scopeForCall(role, allowed, call) !== undefined,
});

describe("the variables ability a reach gives", () => {
  it.each([
    [Role.OWNER, { write: true, reveal: true }],
    [Role.ADMIN, { write: true, reveal: false }],
    [Role.MEMBER, { write: false, reveal: false }],
    [Role.UNSPECIFIED, { write: false, reveal: false }],
  ])("gives role %s what it reaches", (role, ability) => {
    expect(abilityOf(reachAs(role))).toEqual(ability);
  });

  it("takes no ability the endpoint does not allow", () => {
    expect(abilityOf(reachAs(Role.OWNER, [Scope.VARIABLES_READ]))).toEqual({
      write: false,
      reveal: false,
    });
  });
});
