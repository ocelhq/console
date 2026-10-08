import { db } from "@console/db";
import { type Job, job, organization, project, runner } from "@console/db/schema";
import { setupTestDatabase } from "@console/db/testing";
import { pg } from "@console/infra";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobQueue } from "./queue";

const suffix = crypto.randomUUID();
const orgA = `org-a-${suffix}`;
const orgB = `org-b-${suffix}`;
const projA = `pa-${suffix}`;
const projA2 = `pa2-${suffix}`;
const projB = `pb-${suffix}`;
const managed = `r-managed-${suffix}`;
const selfA = `r-self-a-${suffix}`;
const boxed = `r-boxed-${suffix}`;

const notified: Job[] = [];
let refusals = 0;
const queue = jobQueue({
  notify: async (changed) => {
    if (refusals > 0) {
      refusals -= 1;
      throw new Error("trigger refused");
    }
    notified.push(changed);
  },
});

let serial = 0;
async function enqueued(over: Partial<typeof job.$inferInsert> & { projectId: string }) {
  serial += 1;
  const [row] = await db
    .insert(job)
    .values({
      id: `job-${suffix}-${serial}`,
      kind: "deploy",
      dedupeKey: `d-${serial}`,
      eventAt: new Date(),
      createdAt: new Date(Date.now() + serial),
      ...over,
    })
    .returning();
  if (!row) throw new Error("not inserted");
  return row;
}

async function lapse(id: string) {
  await db.update(job).set({ leaseUntil: sql`now() - interval '1 second'` }).where(eq(job.id, id));
}

async function stored(id: string) {
  const [row] = await db.select().from(job).where(eq(job.id, id));
  if (!row) throw new Error("gone");
  return row;
}

beforeAll(async () => {
  await setupTestDatabase();
  await db.insert(organization).values([
    { id: orgA, name: "A", slug: orgA, createdAt: new Date() },
    { id: orgB, name: "B", slug: orgB, createdAt: new Date() },
  ]);
  await db.insert(project).values([
    { id: projA, organizationId: orgA, name: "A", slug: "a" },
    { id: projA2, organizationId: orgA, name: "A2", slug: "a2" },
    { id: projB, organizationId: orgB, name: "B", slug: "b" },
  ]);
  await db.insert(runner).values([
    {
      id: managed,
      organizationId: null,
      kind: "managed",
      name: "m",
      labels: ["managed"],
      publicKey: "k",
    },
    { id: selfA, organizationId: orgA, kind: "self-hosted", name: "s", labels: [], publicKey: "k" },
    {
      id: boxed,
      organizationId: null,
      kind: "managed",
      name: "b",
      labels: ["managed", "target:vps-box-1"],
      publicKey: "k",
    },
  ]);
});

beforeEach(async () => {
  await db.delete(job).where(inArray(job.projectId, [projA, projA2, projB]));
  notified.length = 0;
  refusals = 0;
});

afterAll(async () => {
  await db.delete(organization).where(inArray(organization.id, [orgA, orgB]));
  await db.delete(runner).where(inArray(runner.id, [managed, selfA, boxed]));
  await pg.end();
});

describe("claim", () => {
  it("hands out the oldest queued job under a lease and remembers who holds it", async () => {
    const first = await enqueued({ projectId: projA });
    await enqueued({ projectId: projA2 });

    const claimed = await queue.claim(selfA);

    expect(claimed).toMatchObject({ id: first.id, status: "claimed", runnerId: selfA, claims: 1 });
    expect((claimed?.leaseUntil?.getTime() ?? 0) - (claimed?.claimedAt?.getTime() ?? 0)).toBe(
      60_000,
    );
  });

  it("reports the claim, so the pull request stops saying it waits for a runner", async () => {
    const queued = await enqueued({ projectId: projA });

    await queue.claim(selfA);

    expect(notified.map((n) => [n.id, n.status])).toEqual([[queued.id, "claimed"]]);
  });

  it("hands out nothing when nothing is queued", async () => {
    expect(await queue.claim(managed)).toBeUndefined();
    expect(notified).toEqual([]);
  });

  it("records that the runner was seen", async () => {
    await db.update(runner).set({ lastSeenAt: null }).where(eq(runner.id, managed));
    await queue.claim(managed);
    const [seen] = await db.select().from(runner).where(eq(runner.id, managed));
    expect(seen?.lastSeenAt).toBeInstanceOf(Date);
  });

  it("refuses a runner it does not know", async () => {
    await expect(queue.claim("nobody")).rejects.toThrow(/runner/);
  });

  it("gives a job to a runner holding every label the job asks for, and no other", async () => {
    const routed = await enqueued({ projectId: projA, labels: ["managed", "target:vps-box-1"] });
    const strange = await enqueued({ projectId: projA2, labels: ["managed", "gpu"] });

    expect(await queue.claim(managed)).toBeUndefined();
    expect((await queue.claim(boxed))?.id).toBe(routed.id);
    expect(await queue.claim(boxed)).toBeUndefined();
    expect((await stored(strange.id)).status).toBe("queued");
  });

  it("gives an organization's runner any of its projects' jobs whose labels it holds, none asked for included", async () => {
    const other = await enqueued({ projectId: projB });
    const own = await enqueued({ projectId: projA });

    expect((await queue.claim(selfA))?.id).toBe(own.id);
    expect(await queue.claim(selfA)).toBeUndefined();
    expect((await stored(other.id)).status).toBe("queued");
  });

  it("gives a managed runner only a job that asks for one, in any organization", async () => {
    const unasked = await enqueued({ projectId: projA });
    const asked = await enqueued({ projectId: projB, labels: ["managed"] });

    expect((await queue.claim(managed))?.id).toBe(asked.id);
    expect(await queue.claim(managed)).toBeUndefined();
    expect((await stored(unasked.id)).status).toBe("queued");
  });

  it("refuses a managed runner that belongs to an organization, and a self-hosted one that belongs to none", async () => {
    const runner_ = (id: string, kind: "managed" | "self-hosted", organizationId: string | null) =>
      db.insert(runner).values({ id, organizationId, kind, name: id, publicKey: "k" });

    await expect(runner_(`r-bad-m-${suffix}`, "managed", orgA)).rejects.toThrow();
    await expect(runner_(`r-bad-s-${suffix}`, "self-hosted", null)).rejects.toThrow();
  });

  it("runs one job at a time for a project's production or for one pull request", async () => {
    const first = await enqueued({ projectId: projA });
    const second = await enqueued({ projectId: projA });
    const preview = await enqueued({ projectId: projA, kind: "preview-up", pr: 4 });

    expect((await queue.claim(selfA))?.id).toBe(first.id);
    expect((await queue.claim(selfA))?.id).toBe(preview.id);
    expect(await queue.claim(selfA)).toBeUndefined();

    await queue.finish(first.id, selfA, { outcome: "succeeded" });
    expect((await queue.claim(selfA))?.id).toBe(second.id);
  });

  it("gives a job to one runner when several ask at once", async () => {
    await enqueued({ projectId: projA, labels: ["managed"] });
    await enqueued({ projectId: projA, labels: ["managed"] });

    const claims = await Promise.all([
      queue.claim(managed),
      queue.claim(selfA),
      queue.claim(boxed),
      queue.claim(managed),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});

describe("start", () => {
  it("marks a claimed job running, once, for the runner that holds it", async () => {
    await enqueued({ projectId: projA });
    const claimed = await queue.claim(selfA);
    if (!claimed) throw new Error("not claimed");
    notified.length = 0;

    expect(await queue.start(claimed.id, managed)).toBeUndefined();
    const running = await queue.start(claimed.id, selfA);

    expect(running?.status).toBe("running");
    expect(running?.startedAt).toBeInstanceOf(Date);
    expect(notified.map((n) => n.status)).toEqual(["running"]);
    expect(await queue.start(claimed.id, selfA)).toBeUndefined();
  });
});

describe("heartbeat", () => {
  it("extends the lease and says whether a cancel was asked for", async () => {
    const queued = await enqueued({ projectId: projA });
    await queue.claim(selfA);
    await lapse(queued.id);

    expect(await queue.heartbeat(queued.id, selfA)).toEqual({ cancelRequested: false });
    expect((await stored(queued.id)).leaseUntil?.getTime()).toBeGreaterThan(Date.now() + 50_000);

    await db.update(job).set({ cancelRequested: true }).where(eq(job.id, queued.id));
    expect(await queue.heartbeat(queued.id, selfA)).toEqual({ cancelRequested: true });
  });

  it("tells a runner that lost its job so", async () => {
    const queued = await enqueued({ projectId: projA });
    await queue.claim(selfA);

    expect(await queue.heartbeat(queued.id, managed)).toBeUndefined();
    await queue.finish(queued.id, selfA, { outcome: "succeeded" });
    expect(await queue.heartbeat(queued.id, selfA)).toBeUndefined();
  });
});

describe("finish", () => {
  it("links the deployment the job made and ends done", async () => {
    const queued = await enqueued({ projectId: projA });
    await queue.claim(selfA);
    notified.length = 0;

    const finished = await queue.finish(queued.id, selfA, {
      outcome: "succeeded",
      deploymentId: "dep-1",
    });

    expect(finished).toMatchObject({ status: "done", deploymentId: "dep-1", leaseUntil: null });
    expect(finished?.finishedAt).toBeInstanceOf(Date);
    expect(notified.map((n) => n.id)).toEqual([queued.id]);
  });

  it("ends failed with the reason, still linking a deployment that failed", async () => {
    const queued = await enqueued({ projectId: projA });
    await queue.claim(selfA);

    const finished = await queue.finish(queued.id, selfA, {
      outcome: "failed",
      deploymentId: "dep-2",
      error: "build failed",
    });

    expect(finished).toMatchObject({
      status: "failed",
      deploymentId: "dep-2",
      error: "build failed",
    });
  });

  it("ends canceled when the runner failed after being asked to stop", async () => {
    const queued = await enqueued({ projectId: projA });
    await queue.claim(selfA);
    await db.update(job).set({ cancelRequested: true }).where(eq(job.id, queued.id));

    expect((await queue.finish(queued.id, selfA, { outcome: "failed" }))?.status).toBe("canceled");
  });

  it("ignores a runner that does not hold the job, and a job already finished", async () => {
    const queued = await enqueued({ projectId: projA });
    await queue.claim(selfA);

    expect(await queue.finish(queued.id, managed, { outcome: "succeeded" })).toBeUndefined();
    await queue.finish(queued.id, selfA, { outcome: "succeeded" });
    expect(await queue.finish(queued.id, selfA, { outcome: "failed" })).toBeUndefined();
    expect((await stored(queued.id)).status).toBe("done");
  });
});

describe("sweep", () => {
  it("requeues a claimed job whose lease ran out before it started", async () => {
    const queued = await enqueued({ projectId: projA });
    await queue.claim(selfA);
    await lapse(queued.id);
    notified.length = 0;

    const swept = await queue.sweep();

    expect(swept.map((s) => s.id)).toEqual([queued.id]);
    expect(await stored(queued.id)).toMatchObject({
      status: "queued",
      runnerId: null,
      leaseUntil: null,
      claimedAt: null,
    });
    expect(notified.map((n) => n.status)).toEqual(["queued"]);
  });

  it("fails a job claimed three times that no runner ever started", async () => {
    const queued = await enqueued({ projectId: projA });
    for (let claim = 1; claim <= 3; claim++) {
      expect((await queue.claim(selfA))?.claims).toBe(claim);
      await lapse(queued.id);
      await queue.sweep();
    }

    expect(await stored(queued.id)).toMatchObject({
      status: "failed",
      error: "no runner started it",
      leaseUntil: null,
    });
  });

  it("fails a running job whose lease ran out, never requeuing a deploy", async () => {
    const queued = await enqueued({ projectId: projA });
    await queue.claim(selfA);
    await queue.start(queued.id, selfA);
    await lapse(queued.id);
    notified.length = 0;

    await queue.sweep();

    expect(await stored(queued.id)).toMatchObject({
      status: "failed",
      error: "the runner stopped reporting",
    });
    expect(notified.map((n) => n.status)).toEqual(["failed"]);
  });

  it.each([
    ["nobody started", false],
    ["stopped reporting", true],
  ])("cancels a job %s that a newer event asked to stop", async (_, started) => {
    const queued = await enqueued({ projectId: projA });
    await queue.claim(selfA);
    if (started) await queue.start(queued.id, selfA);
    await db.update(job).set({ cancelRequested: true }).where(eq(job.id, queued.id));
    await lapse(queued.id);

    await queue.sweep();

    expect((await stored(queued.id)).status).toBe("canceled");
  });

  it("leaves a job whose lease holds, and queued and finished jobs", async () => {
    const live = await enqueued({ projectId: projA });
    await queue.claim(selfA);
    await enqueued({ projectId: projA2 });
    notified.length = 0;

    expect(await queue.sweep()).toEqual([]);
    expect((await stored(live.id)).status).toBe("claimed");
    expect(notified).toEqual([]);
  });

  it("reports every job it moved even when reporting one fails, and then fails", async () => {
    const first = await enqueued({ projectId: projA });
    const second = await enqueued({ projectId: projA2 });
    await queue.claim(selfA);
    await queue.claim(selfA);
    await lapse(first.id);
    await lapse(second.id);
    notified.length = 0;
    refusals = 1;

    await expect(queue.sweep()).rejects.toThrow("trigger refused");

    expect(notified).toHaveLength(1);
    expect((await stored(first.id)).status).toBe("queued");
    expect((await stored(second.id)).status).toBe("queued");
  });
});

describe("resync", () => {
  it("reports again a change whose report was lost, and not one already reported", async () => {
    const lost = await enqueued({ projectId: projA });
    const reported = await enqueued({ projectId: projA2 });
    await queue.claim(selfA);
    await queue.claim(selfA);
    await queue.synced(reported.id, (await stored(reported.id)).revision);
    await db
      .update(job)
      .set({ changedAt: sql`now() - interval '2 minutes'` })
      .where(inArray(job.id, [lost.id, reported.id]));
    notified.length = 0;

    await queue.resync();

    expect(notified.map((n) => [n.id, n.status])).toEqual([[lost.id, "claimed"]]);
  });

  it("leaves a change young enough that its own report may still be on its way", async () => {
    await enqueued({ projectId: projA });
    await queue.claim(selfA);
    notified.length = 0;

    await queue.resync();

    expect(notified).toEqual([]);
  });

  it("counts a job reported only up to the revision a sync saw", async () => {
    const queued = await enqueued({ projectId: projA });
    const before = (await stored(queued.id)).revision;
    await queue.claim(selfA);

    await queue.synced(queued.id, before);

    const after = await stored(queued.id);
    expect(after.syncedRevision).toBe(before);
    expect(after.revision).toBeGreaterThan(before);
  });
});
