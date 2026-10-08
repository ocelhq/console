import { gitRuntime } from "@console/git";
import { notFound } from "next/navigation";
import { requireOrganization } from "@/lib/access";
import { organizationOf } from "@/lib/organization";
import { labelType } from "@/lib/type";
import { noticeBody, PageNotice, PageShell } from "../../page-shell";
import { RegisterGithubApp } from "./register";

const failures: Record<string, string> = {
  session: "Your session ended before GitHub sent you back. Sign in and register again.",
  state: "That registration expired or wasn’t started by you. Start it again.",
  forbidden: "Only owners and admins can register a GitHub App.",
  github: "GitHub refused the registration. Start it again.",
  stored: "That GitHub App is already registered.",
  unconfigured: "Git integrations aren’t configured on this console.",
};

export default async function OrganizationGitPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireOrganization();
  const [{ error }, organization] = await Promise.all([
    searchParams,
    organizationOf(session.userId, session.activeOrganizationId),
  ]);
  if (!organization) {
    notFound();
  }

  const runtime = gitRuntime();
  if (!runtime) {
    return (
      <PageShell title="Git">
        <PageNotice heading="Git integrations are off">
          <p className={noticeBody}>
            Set <span className="font-mono text-[13px]">CONSOLE_ENCRYPTION_KEY</span> to 32 random
            bytes, base64 encoded, and restart the console. It seals the GitHub Apps’ private keys
            and secrets before they reach the database.
          </p>
        </PageNotice>
      </PageShell>
    );
  }

  const [apps, installations] = await Promise.all([
    runtime.store.appsFor(session.activeOrganizationId),
    runtime.store.installationsFor(session.activeOrganizationId),
  ]);

  return (
    <PageShell
      title="Git"
      description="Connect GitHub so pull requests and pushes reach the console."
    >
      {error && (
        <p role="alert" className="max-w-2xl text-sm text-destructive">
          {failures[error] ?? "The registration didn’t finish."}
        </p>
      )}

      <section className="flex max-w-2xl flex-col gap-3">
        <h2 className={labelType}>GitHub Apps</h2>
        {apps.length === 0 ? (
          <p className={noticeBody}>No GitHub App is available to this organization yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border border border-border">
            {apps.map((app) => (
              <li
                key={app.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
              >
                <div className="flex flex-col gap-1">
                  <p className="font-medium">{app.slug}</p>
                  <p className={labelType}>
                    {app.organizationId
                      ? "registered by this organization"
                      : "provided by the console"}
                  </p>
                </div>
                <a
                  href={`https://github.com/apps/${app.slug}/installations/new`}
                  className="text-sm underline-offset-4 hover:underline focus-visible:underline"
                >
                  Install on GitHub
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex max-w-2xl flex-col gap-3">
        <h2 className={labelType}>Installations</h2>
        {installations.length === 0 ? (
          <p className={noticeBody}>Nothing installed yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border border border-border">
            {installations.map((installation) => (
              <li key={installation.id} className="px-5 py-4 text-sm">
                {installation.account}
              </li>
            ))}
          </ul>
        )}
      </section>

      {organization.administers ? (
        <section className="flex max-w-2xl flex-col gap-3">
          <h2 className={labelType}>Bring your own</h2>
          <p className={noticeBody}>
            Register a GitHub App you own. GitHub asks you to confirm, then sends you back here with
            the app’s keys, which the console seals before storing.
          </p>
          <RegisterGithubApp />
        </section>
      ) : (
        <p className={noticeBody}>Only owners and admins can register a GitHub App.</p>
      )}
    </PageShell>
  );
}
