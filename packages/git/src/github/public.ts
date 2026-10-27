export interface RepoIds {
  repositoryId: string;
  repositoryOwnerId: string;
}

export async function publicRepoIds(
  fullName: string,
  options: { fetch?: typeof fetch } = {},
): Promise<RepoIds | undefined> {
  const response = await (options.fetch ?? fetch)(`https://api.github.com/repos/${fullName}`, {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(
      `GitHub answered ${response.status} when asked for ${fullName}, so its ids are unknown; try again`,
    );
  }
  const repo = (await response.json()) as { id: number; owner: { id: number } };
  return { repositoryId: String(repo.id), repositoryOwnerId: String(repo.owner.id) };
}
