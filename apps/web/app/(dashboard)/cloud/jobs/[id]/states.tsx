import Link from "next/link";
import { Button } from "@/components/ui/button";
import { noticeBody, PageNotice, PageShell } from "../../../page-shell";

export function JobGone() {
  return (
    <PageShell title="Ocel Cloud job">
      <PageNotice heading="No job with this id">
        <p className={noticeBody}>
          It may belong to another organization, or the link is stale. If a teammate sent it, switch
          to their organization and open it again.
        </p>
        <Button variant="outline" nativeButton={false} render={<Link href="/" />}>
          All projects
        </Button>
      </PageNotice>
    </PageShell>
  );
}

export function JobSignedOut({ href }: { href: string }) {
  return (
    <PageShell title="Ocel Cloud job">
      <PageNotice heading="You’re signed out">
        <p className={noticeBody}>
          Your session ended, so this page stopped following the job. The job carries on either way.
          Sign in again to pick it back up.
        </p>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href={`/sign-in?redirect=${encodeURIComponent(href)}`} />}
        >
          Sign in
        </Button>
      </PageNotice>
    </PageShell>
  );
}

export function JobLoadError({ href, message }: { href: string; message: string }) {
  return (
    <PageShell title="Ocel Cloud job">
      <PageNotice heading="Ocel Cloud didn’t answer" role="alert">
        <p className={noticeBody}>
          The job carries on either way; this page only reads it. Try again in a moment.
        </p>
        <p className="max-w-prose font-mono text-xs text-muted-foreground">{message}</p>
        <Button variant="outline" nativeButton={false} render={<a href={href} />}>
          Try again
        </Button>
      </PageNotice>
    </PageShell>
  );
}
