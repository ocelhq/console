import { runJobOfRow } from "@console/api";
import type { Job } from "@console/db/schema";
import Link from "next/link";
import { activityHref, activityTitle } from "@/lib/job-activity";
import { stateOf } from "@/lib/job-run";
import { labelType } from "@/lib/type";
import { Stamp } from "../../../stamp";

export function JobActivity({ rows, slug, now }: { rows: Job[]; slug: string; now: string }) {
  if (rows.length === 0) return null;
  return (
    <section
      aria-label="Jobs that deploy nothing"
      className="flex flex-col border-b border-border bg-background px-5 py-2 md:px-8"
    >
      <ul className="flex flex-col gap-1">
        {rows.map((row) => {
          const state = stateOf(runJobOfRow(row).state);
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-x-3 text-sm">
              <Link
                href={activityHref(slug, row.id)}
                className="font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
              >
                {activityTitle(row)}
              </Link>
              <span className={state.tone === "warn" ? "text-warn" : "text-muted-foreground"}>
                {state.word}
              </span>
              <span className={labelType}>
                <Stamp at={(row.finishedAt ?? row.createdAt).toISOString()} now={now} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
