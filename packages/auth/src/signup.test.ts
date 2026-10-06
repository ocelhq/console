import { describe, expect, it } from "vitest";
import { maySignUp, type SignupStore } from "./signup";

function store(users: number, invited: string[] = []): SignupStore {
  return {
    hasUsers: async () => users > 0,
    hasPendingInvitation: async (email) => invited.includes(email.toLowerCase()),
  };
}

describe("maySignUp", () => {
  it("lets anyone sign up when sign-up is open", async () => {
    expect(await maySignUp("stranger@example.test", "open", store(3))).toBe(true);
  });

  it("lets the first user sign up when sign-up is by invitation", async () => {
    expect(await maySignUp("first@example.test", "invite", store(0))).toBe(true);
  });

  it("lets an invited email sign up, whatever its case", async () => {
    expect(
      await maySignUp("Invited@Example.test", "invite", store(1, ["invited@example.test"])),
    ).toBe(true);
  });

  it("refuses an uninvited email once a user exists", async () => {
    expect(await maySignUp("stranger@example.test", "invite", store(1))).toBe(false);
  });
});
