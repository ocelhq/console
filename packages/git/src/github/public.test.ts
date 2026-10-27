import { describe, expect, it } from "vitest";
import { publicRepoIds } from "./public";
import { fakeGithub } from "./test-support";

describe("publicRepoIds", () => {
  it("reads a public repository's ids without credentials", async () => {
    const github = fakeGithub();
    github.repositories.push({
      id: 1234,
      full_name: "acme/web",
      default_branch: "main",
      owner: { id: 42 },
    });

    expect(await publicRepoIds("Acme/Web", { fetch: github.fetch })).toEqual({
      repositoryId: "1234",
      repositoryOwnerId: "42",
    });
    const [call] = github.callsTo("GET", /^\/repos\//);
    expect(call?.path).toBe("/repos/Acme/Web");
  });

  it("answers nothing for a repository it cannot see", async () => {
    const github = fakeGithub();
    github.repositories.push({
      id: 1,
      full_name: "acme/secret",
      default_branch: "main",
      owner: { id: 42 },
      private: true,
    });

    expect(await publicRepoIds("acme/secret", { fetch: github.fetch })).toBeUndefined();
    expect(await publicRepoIds("acme/missing", { fetch: github.fetch })).toBeUndefined();
  });
});
