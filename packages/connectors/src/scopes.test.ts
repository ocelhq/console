import { describe, expect, it } from "vitest";
import { Role, Scope } from "./gen/common/scope/v1/scope_pb";
import { ConsoleService } from "./gen/console/v1/console_pb";
import { ProviderService } from "./gen/provider/contract/v1/contract_pb";
import { VariableStoreService } from "./gen/provider/variablestore/v1/variablestore_pb";
import { JobCommand, JobCommandSchema, RunnerService } from "./gen/runner/v1/runner_pb";
import {
  claimOf,
  isUserScope,
  leastRoleOf,
  refusedScope,
  requiredScope,
  roleClaimOf,
  scopeClaimed,
  scopeForCall,
  USER_SCOPES,
} from "./scopes";

describe("requiredScope", () => {
  it("reads the scope each call declares", () => {
    expect(requiredScope(VariableStoreService.method.listValues)).toBe(Scope.VARIABLES_READ);
    expect(requiredScope(VariableStoreService.method.setValue)).toBe(Scope.VARIABLES_WRITE);
    expect(requiredScope(VariableStoreService.method.revealValues)).toBe(Scope.VARIABLES_REVEAL);
    expect(requiredScope(ProviderService.method.rollback)).toBe(Scope.APPS_WRITE);
    expect(requiredScope(RunnerService.method.startJob)).toBe(Scope.JOB);
  });

  it("is undefined for a call that declares none", () => {
    expect(requiredScope(ConsoleService.method.describe)).toBeUndefined();
  });
});

describe("user scopes", () => {
  it("are exactly the scopes with a least role", () => {
    expect(USER_SCOPES).toEqual([
      Scope.APPS_READ,
      Scope.APPS_WRITE,
      Scope.VARIABLES_READ,
      Scope.VARIABLES_WRITE,
      Scope.VARIABLES_REVEAL,
    ]);
    expect(isUserScope(Scope.JOB)).toBe(false);
    expect(isUserScope(Scope.TARGET_CREDENTIAL)).toBe(false);
    expect(isUserScope(Scope.UNSPECIFIED)).toBe(false);
  });

  it("name their claims, and only they are claimed", () => {
    expect(claimOf(Scope.VARIABLES_REVEAL)).toBe("variables.reveal");
    expect(scopeClaimed("apps.write")).toBe(Scope.APPS_WRITE);
    expect(scopeClaimed("job")).toBeUndefined();
    expect(scopeClaimed("")).toBeUndefined();
  });
});

describe("refusedScope", () => {
  it("says which wanted scope is refused, and why", () => {
    expect(refusedScope(Role.OWNER, USER_SCOPES, [Scope.JOB])).toEqual({
      scope: Scope.JOB,
      because: "not-user",
    });
    expect(
      refusedScope(Role.MEMBER, USER_SCOPES, [Scope.APPS_READ, Scope.VARIABLES_WRITE]),
    ).toEqual({ scope: Scope.VARIABLES_WRITE, because: "role" });
    expect(refusedScope(Role.OWNER, [Scope.APPS_READ], [Scope.APPS_WRITE])).toEqual({
      scope: Scope.APPS_WRITE,
      because: "endpoint",
    });
  });

  it("refuses nothing the role reaches and the endpoint allows", () => {
    expect(refusedScope(Role.ADMIN, USER_SCOPES, [Scope.VARIABLES_WRITE])).toBeUndefined();
    expect(refusedScope(Role.MEMBER, USER_SCOPES, [])).toBeUndefined();
  });
});

describe("scopeForCall", () => {
  it("is the scope the call declares, when the role reaches it and the endpoint allows it", () => {
    expect(scopeForCall(Role.MEMBER, USER_SCOPES, RunnerService.method.cancelJob)).toBe(
      Scope.APPS_WRITE,
    );
    expect(scopeForCall(Role.OWNER, USER_SCOPES, VariableStoreService.method.revealValues)).toBe(
      Scope.VARIABLES_REVEAL,
    );
  });

  it("is undefined for a call the role, the endpoint or the call's declaration refuses", () => {
    expect(
      scopeForCall(Role.ADMIN, USER_SCOPES, VariableStoreService.method.revealValues),
    ).toBeUndefined();
    expect(
      scopeForCall(Role.OWNER, [Scope.APPS_READ], VariableStoreService.method.setValue),
    ).toBeUndefined();
    expect(scopeForCall(Role.OWNER, USER_SCOPES, RunnerService.method.startJob)).toBeUndefined();
    expect(scopeForCall(Role.OWNER, USER_SCOPES, ConsoleService.method.describe)).toBeUndefined();
  });
});

describe("leastRoleOf", () => {
  it("reads a command's least role", () => {
    expect(leastRoleOf(JobCommandSchema.value[JobCommand.DEPLOY])).toBe(Role.MEMBER);
    expect(leastRoleOf(JobCommandSchema.value[JobCommand.PROJECTS_DESTROY])).toBe(Role.ADMIN);
  });
});

describe("roleClaimOf", () => {
  it("names each role as its token claims it, and no role as nothing", () => {
    expect(roleClaimOf(Role.MEMBER)).toBe("member");
    expect(roleClaimOf(Role.ADMIN)).toBe("admin");
    expect(roleClaimOf(Role.OWNER)).toBe("owner");
    expect(roleClaimOf(Role.UNSPECIFIED)).toBe("");
  });
});
