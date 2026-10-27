import { issuancesOf, readIssuerSettings, targetsOf } from "@console/targets";
import { notFound } from "next/navigation";
import { requireOrganization } from "@/lib/access";
import { organizationOf } from "@/lib/organization";
import { issuanceView, issuerAddress } from "@/lib/targets";
import { labelType } from "@/lib/type";
import { noticeBody, PageNotice, PageShell } from "../page-shell";
import { Issuances } from "./issuances";
import { Targets } from "./targets";

const mono = "font-mono text-[13px]";

export default async function TargetsPage() {
  const session = await requireOrganization();
  const organization = await organizationOf(session.userId, session.activeOrganizationId);
  if (!organization) {
    notFound();
  }

  if (!readIssuerSettings()) {
    return (
      <PageShell title="Targets">
        <PageNotice heading="The console issues no credentials">
          <p className={noticeBody}>
            Set <span className={mono}>CONSOLE_ISSUER_KMS_KEY_ID</span> to an AWS KMS{" "}
            <span className={mono}>ECC_NIST_P256</span> signing key, or{" "}
            <span className={mono}>CONSOLE_ISSUER_KEY</span> to a P-256 private key, and restart the
            console. It signs the tokens a cloud account exchanges for deploy credentials, with a
            key of its own, apart from the sessions’.
          </p>
        </PageNotice>
      </PageShell>
    );
  }

  const [targets, issuances] = await Promise.all([
    targetsOf(session.activeOrganizationId),
    issuancesOf({ organizationId: session.activeOrganizationId }),
  ]);
  const now = new Date().toISOString();

  return (
    <PageShell
      title="Targets"
      description="The cloud accounts that trust this console to vouch for your trusted pipelines, so CI deploys with short-lived credentials instead of stored keys."
    >
      <section className="flex max-w-3xl flex-col gap-3">
        <h2 className={labelType}>Issuer</h2>
        <p className={`${mono} break-all`}>{issuerAddress()}</p>
        <p className={noticeBody}>
          To add a target, an owner or admin runs{" "}
          <span className={mono}>ocel bootstrap production</span> (or{" "}
          <span className={mono}>preview</span>) from a checkout linked to this console. Bootstrap
          makes the account trust this issuer, creates the tier’s deploy identity and records it
          here.
        </p>
      </section>

      <section className="flex max-w-3xl flex-col gap-3">
        <h2 className={labelType}>Targets</h2>
        {targets.length === 0 ? (
          <p className={noticeBody}>No cloud account trusts this console yet.</p>
        ) : (
          <Targets
            administers={organization.administers}
            now={now}
            targets={targets.map((target) => ({
              id: target.id,
              vendor: target.vendor,
              account: target.account,
              region: target.region,
              tiers: target.tiers.map((tier) => ({
                tier: tier.tier,
                principal: tier.principal,
                cliVersion: tier.cliVersion,
                recordedAt: tier.recordedAt.toISOString(),
                lastIssuedAt: tier.lastIssuedAt?.toISOString() ?? null,
              })),
            }))}
          />
        )}
        <p className="text-xs text-muted-foreground">
          {organization.administers
            ? "Removing a target stops the console minting tokens for it and unbinds its projects. The account keeps trusting the issuer until an admin runs ocel bootstrap --remove there. Test connection mints a one-minute token for the reserved project connection-test, exchanges it at the cloud’s STS and discards what comes back."
            : "Only owners and admins can remove or test a target."}
        </p>
      </section>

      <section className="flex max-w-3xl flex-col gap-3">
        <h2 className={labelType}>Recent issuances</h2>
        <Issuances issuances={issuances.map(issuanceView)} now={now} showProject />
      </section>
    </PageShell>
  );
}
