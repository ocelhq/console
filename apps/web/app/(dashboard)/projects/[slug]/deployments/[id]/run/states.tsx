import Link from "next/link";
import { Button } from "@/components/ui/button";
import { noticeBody, PageNotice } from "../../../../../page-shell";

export function JobGone() {
  return (
    <PageNotice heading="The runner holds no record of this job">
      <p className={noticeBody}>
        It may have ended long enough ago that the runner forgot it, or the runner was replaced.
        What the deployment reported stays below.
      </p>
    </PageNotice>
  );
}

export function JobLoading() {
  return (
    <PageNotice heading="Reading the job">
      <p className={noticeBody}>Asking the runner where the job is. The page shows it here.</p>
    </PageNotice>
  );
}

export function JobSignedOut({ href }: { href: string }) {
  return (
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
  );
}

export function JobLoadError({ href, message }: { href: string; message: string }) {
  return (
    <PageNotice heading="The runner didn’t answer" role="alert">
      <p className={noticeBody}>
        The job carries on either way; this page only reads it. Try again in a moment.
      </p>
      <p className="max-w-prose font-mono text-xs text-muted-foreground">{message}</p>
      <Button variant="outline" nativeButton={false} render={<a href={href} />}>
        Try again
      </Button>
    </PageNotice>
  );
}
