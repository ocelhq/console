import { scopeName } from "@console/connectors";
import { endpointsOf, type Liveness, liveness } from "@console/endpoints";
import { requireOrganization } from "@/lib/access";
import { targetOf } from "@/lib/providers";
import { labelType } from "@/lib/type";
import { CommandPane } from "../../command-pane";
import { ProviderMark } from "../../marks";
import { noticeBody, PageNotice, PageShell } from "../../page-shell";
import { Stamp } from "../../stamp";

const tones: Record<Liveness, string> = {
  online: "bg-go",
  offline: "bg-destructive",
  never: "bg-faint",
};

function serviceName(service: string): string {
  return (
    service
      .split(".")
      .at(-1)
      ?.replace(/Service$/, "") ?? service
  );
}

const says: Record<Liveness, string> = {
  online: "Online",
  offline: "Not answering",
  never: "Never connected",
};

export default async function OrganizationConnectorsPage() {
  const session = await requireOrganization();
  const rows = await endpointsOf(session.activeOrganizationId);
  const now = new Date().toISOString();

  if (rows.length === 0) {
    return (
      <PageShell title="Connectors">
        <PageNotice heading="Nothing connected yet">
          <p className={noticeBody}>
            A connector is a small server you run in your own account. The console asks it for the
            things it must never store itself, such as variable values. One whose config enables the
            runner role also runs your projects’ jobs there.
          </p>
          <CommandPane command="ocel connector add" />
        </PageNotice>
      </PageShell>
    );
  }

  return (
    <PageShell title="Connectors">
      <div className="flex flex-col border border-border">
        {rows.map((row) => {
          const live: Liveness = liveness(row);
          const target = targetOf(row.vendor);
          return (
            <div
              key={row.id}
              className="flex flex-wrap items-start gap-x-6 gap-y-3 border-b border-border px-5 py-4 last:border-b-0"
            >
              <span className="mt-1 shrink-0">
                <ProviderMark provider={row.vendor} size={18} />
              </span>
              <div className="flex min-w-56 flex-1 flex-col gap-1">
                <p className="font-medium">{row.name}</p>
                <p className="font-mono text-xs break-all text-muted-foreground">
                  {row.target ?? (target.own ? "serves no target" : target.label)}
                </p>
                <p className="font-mono text-xs break-all text-muted-foreground">
                  {row.url ?? "no address published"}
                </p>
                <p className={labelType}>{row.compute ?? "compute unset"}</p>
              </div>
              <div className="flex min-w-40 flex-col gap-1">
                <p className="flex items-center gap-2 text-sm">
                  <span aria-hidden className={`size-2 shrink-0 ${tones[live]}`} />
                  {says[live]}
                </p>
                <p className={labelType}>
                  {row.lastSeenAt ? (
                    <>
                      seen <Stamp at={row.lastSeenAt.toISOString()} now={now} />
                    </>
                  ) : (
                    "no contact"
                  )}
                </p>
              </div>
              <div className="flex min-w-52 flex-col gap-2">
                <ul className="flex flex-wrap gap-1" aria-label="Services">
                  {row.services.map((service) => (
                    <li
                      key={service}
                      title={service}
                      className={`border border-border px-1.5 py-0.5 ${labelType}`}
                    >
                      {serviceName(service)}
                    </li>
                  ))}
                </ul>
                <ul className="flex flex-wrap gap-1" aria-label="Allowed scopes">
                  {row.allowedScopes.map((scope) => (
                    <li key={scope} className="font-mono text-xs text-muted-foreground">
                      {scopeName(scope)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })}
      </div>
      <PageNotice heading="Adding another">
        <p className={noticeBody}>
          One connector per bootstrapped target, under that target’s own credentials. It serves only
          the services its config enables, and admits only the scopes it allows.
        </p>
        <CommandPane command="ocel connector add" />
      </PageNotice>
    </PageShell>
  );
}
