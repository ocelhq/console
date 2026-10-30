import { Role } from "@console/connectors";
import { describe, expect, it } from "vitest";
import { administers, highestRole } from "./roles";

describe("highestRole", () => {
  it("takes the highest of the roles a member holds at once", () => {
    expect(highestRole("member")).toBe(Role.MEMBER);
    expect(highestRole("member, owner")).toBe(Role.OWNER);
    expect(highestRole("admin,member")).toBe(Role.ADMIN);
  });

  it("gives an unknown role nothing", () => {
    expect(highestRole("visitor")).toBe(Role.UNSPECIFIED);
    expect(highestRole("")).toBe(Role.UNSPECIFIED);
  });
});

describe("administers", () => {
  it("is reaching the admin role", () => {
    expect(administers("owner")).toBe(true);
    expect(administers("member,admin")).toBe(true);
    expect(administers("member")).toBe(false);
    expect(administers("")).toBe(false);
  });
});
