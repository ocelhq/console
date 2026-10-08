import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import type { TierScope } from "@/lib/tier";
import { CommandPane } from "../../../command-pane";
import { noticeBody } from "../../../page-shell";
import { DeploymentsHead, deploymentColumns } from "./columns";

export function Frame({ withProject, children }: { withProject: boolean; children: ReactNode }) {
  return (
    <div className="border border-border">
      <Table className="min-w-[64rem] text-sm/5">
        <DeploymentsHead withProject={withProject} />
        {children}
      </Table>
    </div>
  );
}

function Notice({
  withProject,
  heading,
  children,
  role,
}: {
  withProject: boolean;
  heading: string;
  children: ReactNode;
  role?: "alert";
}) {
  return (
    <TableBody>
      <TableRow className="hover:bg-transparent">
        <TableCell
          colSpan={deploymentColumns(withProject).length}
          className="p-0 whitespace-normal"
        >
          <div className="flex max-w-2xl flex-col items-start gap-5 px-5 py-8 md:px-8" role={role}>
            <h2 className="text-lg font-semibold tracking-tight text-balance">{heading}</h2>
            {children}
          </div>
        </TableCell>
      </TableRow>
    </TableBody>
  );
}

export function NeverDeployed({ scope, withProject }: { scope: TierScope; withProject: boolean }) {
  const command = scope === "preview" ? "ocel preview up" : "ocel deploy";
  const where = scope === "all" ? "" : ` to ${scope}`;
  return (
    <Notice withProject={withProject} heading={`Nothing deployed${where} yet`}>
      <p className={noticeBody}>
        Run this in a project directory. Each deployment reports here when it finishes, and the
        history stays even after your cloud prunes old promotions.
      </p>
      <CommandPane command={command} />
    </Notice>
  );
}

export function NothingOlder({ href, withProject }: { href: string; withProject: boolean }) {
  return (
    <Notice withProject={withProject} heading="No older deployments">
      <p className={noticeBody}>
        The console only knows about deployments since it was first told of one.
      </p>
      <Button variant="outline" nativeButton={false} render={<Link href={href} />}>
        Back to newest
      </Button>
    </Notice>
  );
}

export function LoadError({ href, withProject }: { href: string; withProject: boolean }) {
  return (
    <Notice withProject={withProject} heading="Deployments didn’t load" role="alert">
      <p className={noticeBody}>Nothing in your cloud is affected. Try again in a moment.</p>
      <Button variant="outline" nativeButton={false} render={<a href={href} />}>
        Try again
      </Button>
    </Notice>
  );
}
