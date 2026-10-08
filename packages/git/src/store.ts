import { db } from "@console/db";
import {
  type GitInstallation,
  type GitKind,
  gitApp,
  gitInstallation,
  project,
  projectRepo,
} from "@console/db/schema";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { KeyStore } from "./keystore";
import type { Repo } from "./provider";
import { openSecret, sealSecret } from "./secrets";

export type AppSecret = "privateKey" | "webhookSecret" | "clientSecret";

export interface ProjectRepo {
  id: string;
  organizationId: string;
  productionBranch: string;
  jobLabels: string[];
}

export const systemAppId = (kind: GitKind) => `system-${kind}`;

export interface AppCredentials {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
}

export interface GitAppSummary {
  id: string;
  organizationId: string | null;
  kind: GitKind;
  appId: string;
  slug: string;
}

export interface StoredApp extends GitAppSummary {
  clientId: string;
  secret(name: AppSecret): Promise<string>;
}

const COLUMNS = {
  privateKey: "private_key",
  webhookSecret: "webhook_secret",
  clientSecret: "client_secret",
} as const satisfies Record<AppSecret, string>;

const secretContext = (rowId: string, name: AppSecret) => `git_app/${rowId}/${COLUMNS[name]}`;

async function seal(keys: KeyStore, rowId: string, credentials: AppCredentials) {
  return {
    appId: credentials.appId,
    slug: credentials.slug,
    clientId: credentials.clientId,
    privateKeyEnc: await sealSecret(
      keys,
      credentials.privateKey,
      secretContext(rowId, "privateKey"),
    ),
    webhookSecretEnc: await sealSecret(
      keys,
      credentials.webhookSecret,
      secretContext(rowId, "webhookSecret"),
    ),
    clientSecretEnc: await sealSecret(
      keys,
      credentials.clientSecret,
      secretContext(rowId, "clientSecret"),
    ),
  };
}

const summary = {
  id: gitApp.id,
  organizationId: gitApp.organizationId,
  kind: gitApp.kind,
  appId: gitApp.appId,
  slug: gitApp.slug,
};

export async function removeSystemApp(kind: GitKind): Promise<void> {
  await db.delete(gitApp).where(eq(gitApp.id, systemAppId(kind)));
}

export function gitStore(keys: KeyStore) {
  return {
    async createOrganizationApp(
      input: { id: string; organizationId: string; kind: GitKind } & AppCredentials,
    ): Promise<GitAppSummary | undefined> {
      const [created] = await db
        .insert(gitApp)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          kind: input.kind,
          ...(await seal(keys, input.id, input)),
        })
        .onConflictDoNothing()
        .returning(summary);
      return created;
    },

    async replaceSystemApp(
      kind: GitKind,
      credentials: AppCredentials,
    ): Promise<GitAppSummary | "claimed"> {
      const id = systemAppId(kind);
      const sealed = await seal(keys, id, credentials);
      return db.transaction(async (tx) => {
        const [claimed] = await tx
          .select({ id: gitApp.id })
          .from(gitApp)
          .where(
            and(eq(gitApp.kind, kind), eq(gitApp.appId, credentials.appId), ne(gitApp.id, id)),
          );
        if (claimed) return "claimed";

        await tx.delete(gitApp).where(and(eq(gitApp.id, id), ne(gitApp.appId, credentials.appId)));
        const [stored] = await tx
          .insert(gitApp)
          .values({ id, organizationId: null, kind, ...sealed })
          .onConflictDoUpdate({ target: gitApp.id, set: sealed })
          .returning(summary);
        if (!stored) throw new Error("the system app was not stored");
        return stored;
      });
    },

    async loadApp(id: string): Promise<StoredApp | undefined> {
      const [row] = await db.select().from(gitApp).where(eq(gitApp.id, id));
      if (!row) return undefined;
      const sealed: Record<AppSecret, string> = {
        privateKey: row.privateKeyEnc,
        webhookSecret: row.webhookSecretEnc,
        clientSecret: row.clientSecretEnc,
      };
      const opened = new Map<AppSecret, Promise<string>>();
      return {
        id: row.id,
        organizationId: row.organizationId,
        kind: row.kind,
        appId: row.appId,
        slug: row.slug,
        clientId: row.clientId,
        secret(name) {
          let secret = opened.get(name);
          if (!secret) {
            secret = openSecret(keys, sealed[name], secretContext(row.id, name));
            opened.set(name, secret);
          }
          return secret;
        },
      };
    },

    async appsFor(organizationId: string): Promise<GitAppSummary[]> {
      return db
        .select(summary)
        .from(gitApp)
        .where(or(isNull(gitApp.organizationId), eq(gitApp.organizationId, organizationId)));
    },

    async bindInstallation(input: {
      gitAppId: string;
      organizationId: string;
      externalId: string;
      account: string;
    }): Promise<GitInstallation | "claimed"> {
      const [bound] = await db
        .insert(gitInstallation)
        .values({ id: crypto.randomUUID(), ...input })
        .onConflictDoUpdate({
          target: [gitInstallation.gitAppId, gitInstallation.externalId],
          set: { account: input.account },
          setWhere: eq(gitInstallation.organizationId, input.organizationId),
        })
        .returning();
      return bound ?? "claimed";
    },

    async installationsFor(organizationId: string): Promise<GitInstallation[]> {
      return db
        .select()
        .from(gitInstallation)
        .where(eq(gitInstallation.organizationId, organizationId));
    },

    async findInstallation(
      gitAppId: string,
      externalId: string,
    ): Promise<GitInstallation | undefined> {
      const [found] = await db
        .select()
        .from(gitInstallation)
        .where(
          and(eq(gitInstallation.gitAppId, gitAppId), eq(gitInstallation.externalId, externalId)),
        );
      return found;
    },

    async removeInstallation(gitAppId: string, externalId: string): Promise<void> {
      await db
        .delete(gitInstallation)
        .where(
          and(eq(gitInstallation.gitAppId, gitAppId), eq(gitInstallation.externalId, externalId)),
        );
    },

    async linkProjectRepo(input: {
      projectId: string;
      organizationId: string;
      installationId: string;
      repo: Repo;
      productionBranch?: string;
      jobLabels?: string[];
    }): Promise<void> {
      await db.transaction(async (tx) => {
        const [installation] = await tx
          .select({ id: gitInstallation.id })
          .from(gitInstallation)
          .where(
            and(
              eq(gitInstallation.id, input.installationId),
              eq(gitInstallation.organizationId, input.organizationId),
            ),
          );
        if (!installation) {
          throw new Error("the installation does not belong to this organization");
        }
        const [owned] = await tx
          .select({ id: project.id })
          .from(project)
          .where(
            and(eq(project.id, input.projectId), eq(project.organizationId, input.organizationId)),
          );
        if (!owned) throw new Error("the project was not found");

        const link = {
          installationId: input.installationId,
          repoId: input.repo.id,
          fullName: input.repo.fullName,
          productionBranch: input.productionBranch ?? input.repo.defaultBranch,
          jobLabels: input.jobLabels ?? [],
        };
        await tx
          .insert(projectRepo)
          .values({ projectId: input.projectId, ...link })
          .onConflictDoUpdate({ target: projectRepo.projectId, set: link });
      });
    },

    async projectsForRepo(installationId: string, repoId: string): Promise<ProjectRepo[]> {
      return db
        .select({
          id: project.id,
          organizationId: project.organizationId,
          productionBranch: projectRepo.productionBranch,
          jobLabels: projectRepo.jobLabels,
        })
        .from(projectRepo)
        .innerJoin(project, eq(project.id, projectRepo.projectId))
        .where(and(eq(projectRepo.installationId, installationId), eq(projectRepo.repoId, repoId)));
    },
  };
}

export type GitStore = ReturnType<typeof gitStore>;
