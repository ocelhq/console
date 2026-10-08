import { db } from "@console/db";
import {
  type GitInstallation,
  type GitKind,
  gitApp,
  gitInstallation,
  project,
} from "@console/db/schema";
import { and, eq, isNull, or } from "drizzle-orm";
import type { KeyStore } from "./keystore";
import { openSecret, sealSecret } from "./secrets";

export const SYSTEM_APP_ID = (kind: GitKind) => `system-${kind}`;

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

export interface OpenedApp extends GitAppSummary, AppCredentials {}

async function seal(keys: KeyStore, credentials: AppCredentials) {
  return {
    appId: credentials.appId,
    slug: credentials.slug,
    clientId: credentials.clientId,
    privateKeyEnc: await sealSecret(keys, credentials.privateKey),
    webhookSecretEnc: await sealSecret(keys, credentials.webhookSecret),
    clientSecretEnc: await sealSecret(keys, credentials.clientSecret),
  };
}

const summary = {
  id: gitApp.id,
  organizationId: gitApp.organizationId,
  kind: gitApp.kind,
  appId: gitApp.appId,
  slug: gitApp.slug,
};

export function gitStore(keys: KeyStore) {
  return {
    async createOrganizationApp(
      input: { id: string; organizationId: string; kind: GitKind } & AppCredentials,
    ): Promise<GitAppSummary> {
      const [created] = await db
        .insert(gitApp)
        .values({
          id: input.id,
          organizationId: input.organizationId,
          kind: input.kind,
          ...(await seal(keys, input)),
        })
        .returning(summary);
      if (!created) throw new Error("the app was not stored");
      return created;
    },

    async upsertSystemApp(kind: GitKind, credentials: AppCredentials): Promise<GitAppSummary> {
      const sealed = await seal(keys, credentials);
      const [stored] = await db
        .insert(gitApp)
        .values({ id: SYSTEM_APP_ID(kind), organizationId: null, kind, ...sealed })
        .onConflictDoUpdate({ target: gitApp.id, set: sealed })
        .returning(summary);
      if (!stored) throw new Error("the system app was not stored");
      return stored;
    },

    async loadApp(id: string): Promise<OpenedApp | undefined> {
      const [row] = await db.select().from(gitApp).where(eq(gitApp.id, id));
      if (!row) return undefined;
      return {
        id: row.id,
        organizationId: row.organizationId,
        kind: row.kind,
        appId: row.appId,
        slug: row.slug,
        clientId: row.clientId,
        privateKey: await openSecret(keys, row.privateKeyEnc),
        webhookSecret: await openSecret(keys, row.webhookSecretEnc),
        clientSecret: await openSecret(keys, row.clientSecretEnc),
      };
    },

    async appsFor(organizationId: string): Promise<GitAppSummary[]> {
      return db
        .select(summary)
        .from(gitApp)
        .where(or(isNull(gitApp.organizationId), eq(gitApp.organizationId, organizationId)));
    },

    async recordInstallation(input: {
      gitAppId: string;
      organizationId: string;
      externalId: string;
      account: string;
    }): Promise<GitInstallation> {
      const [stored] = await db
        .insert(gitInstallation)
        .values({ id: crypto.randomUUID(), ...input })
        .onConflictDoUpdate({
          target: [gitInstallation.gitAppId, gitInstallation.externalId],
          set: { account: input.account },
        })
        .returning();
      if (!stored) throw new Error("the installation was not stored");
      return stored;
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
      await db.transaction(async (tx) => {
        const [found] = await tx
          .select({ id: gitInstallation.id })
          .from(gitInstallation)
          .where(
            and(eq(gitInstallation.gitAppId, gitAppId), eq(gitInstallation.externalId, externalId)),
          );
        if (!found) return;
        await tx
          .update(project)
          .set({ repoInstallationId: null, repoFullName: null, repoId: null })
          .where(eq(project.repoInstallationId, found.id));
        await tx.delete(gitInstallation).where(eq(gitInstallation.id, found.id));
      });
    },

    async linkProjectRepo(input: {
      projectId: string;
      organizationId: string;
      installationId: string;
      repo: { id: string; fullName: string };
    }): Promise<void> {
      const [installation] = await db
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

      const linked = await db
        .update(project)
        .set({
          repoInstallationId: input.installationId,
          repoFullName: input.repo.fullName,
          repoId: input.repo.id,
        })
        .where(
          and(eq(project.id, input.projectId), eq(project.organizationId, input.organizationId)),
        )
        .returning({ id: project.id });
      if (linked.length === 0) throw new Error("the project was not found");
    },

    async projectsForRepo(installationId: string, repoId: string) {
      return db
        .select({ id: project.id, organizationId: project.organizationId })
        .from(project)
        .where(and(eq(project.repoInstallationId, installationId), eq(project.repoId, repoId)));
    },
  };
}

export type GitStore = ReturnType<typeof gitStore>;
