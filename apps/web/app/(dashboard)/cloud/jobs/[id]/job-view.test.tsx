import type { CloudJob, CloudJobEvent, JobEvents } from "@console/api";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { JobPlace } from "@/lib/cloud-job-place";
import { JobView } from "./job-view";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const now = "2026-10-20T10:05:00.000Z";

function job(overrides: Partial<CloudJob> = {}): CloudJob {
  return {
    id: "job_abc",
    projectId: "project-1",
    command: "deploy",
    state: "running",
    phase: "build",
    step: "Building web",
    createdAt: "2026-10-20T10:00:00.000Z",
    startedAt: "2026-10-20T10:00:02.000Z",
    endedAt: null,
    error: null,
    result: null,
    sourceId: "a".repeat(64),
    input: null,
    ...overrides,
  };
}

function event(
  seq: number,
  message: string,
  overrides: Partial<CloudJobEvent> = {},
): CloudJobEvent {
  return {
    seq,
    time: `2026-10-20T10:00:0${seq}.000Z`,
    level: "info",
    phase: "build",
    message,
    ...overrides,
  };
}

const known: JobPlace = {
  project: { name: "Shop", slug: "shop" },
  deploymentHref: null,
  otherOrganization: null,
};

function render(shown: CloudJob, events: CloudJobEvent[] = [], place: JobPlace = known): string {
  const initial: JobEvents = { job: shown, events, more: false };
  return renderToStaticMarkup(
    <JobView organizationId="org-1" initial={initial} place={place} now={now} />,
  );
}

describe("JobView", () => {
  it("shows a running job's command, project, step and a cancel action", () => {
    const html = render(job());
    expect(html).toContain("Deploy");
    expect(html).toContain("ocel deploy");
    expect(html).toContain('href="/projects/shop"');
    expect(html).toContain("Running");
    expect(html).toContain("Building web");
    expect(html).toContain("Cancel job");
    expect(html).toContain("job_abc");
  });

  it("offers no cancel once the job has ended, and shows the error it failed with", () => {
    const html = render(
      job({
        state: "failed",
        endedAt: "2026-10-20T10:01:00.000Z",
        error: { code: "build.failed", message: "next build exited with 1" },
      }),
    );
    expect(html).toContain("Failed");
    expect(html).toContain("build.failed");
    expect(html).toContain("next build exited with 1");
    expect(html).not.toContain("Cancel job");
    expect(html).not.toContain("Building web");
  });

  it("calls out a job that needs input it cannot answer here, pointing at the terminal", () => {
    const html = render(job({ state: "input-required", step: "Waiting for DATABASE_URL" }));
    expect(html).toContain("This job needs your input");
    expect(html).toContain('data-slot="job-input"');
    expect(html).toContain("settle it from your terminal");
    expect(html).toContain("Cancel job");
  });

  it("asks for the missing variables, keys prefilled and grouped, secrets masked", () => {
    const html = render(
      job({
        state: "input-required",
        input: {
          id: "input_1",
          kind: "variables",
          tier: "production",
          variables: [
            {
              key: "DATABASE_URL",
              folder: "",
              secret: true,
              description: "The primary database",
              reason: "no value",
              group: "",
            },
            {
              key: "STRIPE_KEY",
              folder: "/apps/web",
              secret: false,
              description: "",
              reason: "set, but empty",
              group: "stripe",
            },
          ],
          groups: [{ key: "stripe", description: "Payments through Stripe" }],
        },
      }),
    );
    expect(html).toContain("Production values");
    expect(html).toContain("2 variables have no usable value");
    expect(html).toMatch(/<label for="[^"]+"[^>]*>DATABASE_URL<\/label>/);
    expect(html).toContain("The primary database");
    expect(html).toContain("no value");
    expect(html).toMatch(
      /type="password"[^>]*aria-required="true"|aria-required="true"[^>]*type="password"/,
    );
    expect(html).toContain('aria-label="Show the value of DATABASE_URL"');
    expect(html).toContain("<textarea");
    expect(html).toContain("stripe");
    expect(html).toContain("Payments through Stripe");
    expect(html).toContain("set, but empty");
    expect(html).toContain("Project root");
    expect(html).toContain("apps/web");
    expect(html).toContain("Save and continue");
    expect(html).toContain("Ocel Cloud’s variable store");
    expect(html).toContain('aria-live="polite"');
  });

  it("lists variables without folder headings when they share one folder", () => {
    const html = render(
      job({
        state: "input-required",
        input: {
          id: "input_1",
          kind: "variables",
          tier: "preview",
          variables: [
            { key: "A", folder: "", secret: false, description: "", reason: "", group: "" },
          ],
          groups: [],
        },
      }),
    );
    expect(html).toContain("Preview values");
    expect(html).toContain("1 variable has no usable value");
    expect(html).not.toContain("Project root");
    expect(html).not.toContain('type="password"');
  });

  it("asks a confirmation with the finding, to continue or not", () => {
    const html = render(
      job({
        state: "input-required",
        input: {
          id: "input_c",
          kind: "confirmation",
          finding: "3 resources will be replaced",
          question: "Deploy anyway?",
        },
      }),
    );
    expect(html).toContain("3 resources will be replaced");
    expect(html).toContain("Deploy anyway?");
    expect(html).toContain("Continue");
    expect(html).toContain("Don’t continue");
  });

  it("shows no input once the job runs again", () => {
    const html = render(job({ state: "running", input: null }));
    expect(html).not.toContain("This job needs your input");
  });

  it("links the urls, builds and the deployment a finished job reported", () => {
    const html = render(
      job({
        state: "succeeded",
        endedAt: "2026-10-20T10:02:00.000Z",
        result: {
          urls: ["https://shop.example.com"],
          deploymentId: "dep-1",
          builds: [{ app: "web", buildId: "bld-1" }],
        },
      }),
      [],
      { ...known, deploymentHref: "/projects/shop/deployments/row-1" },
    );
    expect(html).toContain('href="https://shop.example.com"');
    expect(html).toContain("bld-1");
    expect(html).toContain('href="/projects/shop/deployments/row-1"');
    expect(html).toContain("1m 58s");
  });

  it("says a reported deployment has not reached this console yet", () => {
    const html = render(
      job({
        state: "succeeded",
        result: { urls: [], deploymentId: "dep-2", builds: [] },
      }),
    );
    expect(html).toContain("dep-2");
    expect(html).toContain("Not reported to this console yet.");
  });

  it("names a project it cannot find in this organization by its id", () => {
    const html = render(job(), [], {
      project: null,
      deploymentHref: null,
      otherOrganization: null,
    });
    expect(html).toContain("Not in this organization");
    expect(html).toContain("project-1");
    expect(html).toContain("Ocel Cloud job");
  });

  it("links no project page of a job outside the active organization, naming its organization", () => {
    const html = render(
      job({
        state: "succeeded",
        endedAt: "2026-10-20T10:02:00.000Z",
        result: { urls: [], deploymentId: "dep-1", builds: [] },
      }),
      [],
      { ...known, deploymentHref: "/projects/shop/deployments/row-1", otherOrganization: "Acme" },
    );
    expect(html).not.toContain('href="/projects/');
    expect(html).toContain("Shop");
    expect(html).toContain("dep-1");
    expect(html).toContain("Acme");
    expect(html).not.toContain("Not reported to this console yet.");
  });

  it("logs each event with its level, marking where a phase begins", () => {
    const html = render(job(), [
      event(1, "checking config", { phase: "check" }),
      event(2, "compiling"),
      event(3, "slow dependency", { level: "warn" }),
      event(4, "boom", { level: "error" }),
    ]);
    expect(html).toContain("# check");
    expect(html).toContain("# build");
    expect(html).toContain("10:00:02");
    expect(html).toMatch(/text-warn[^>]*>.*?warning: <\/span>slow dependency/);
    expect(html).toMatch(/text-destructive[^>]*>.*?error: <\/span>boom/);
    expect(html).toContain("4 lines");
  });

  it("says when a job has no output yet", () => {
    expect(render(job({ state: "queued", startedAt: null }))).toContain("No output yet.");
  });
});
