import type { Executor } from "@console/db";
import { sql } from "drizzle-orm";

export interface Rate {
  burst: number;
  perHour: number;
}

export type Spent = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const PRUNE_AFTER = "1 day";
const PRUNE_BATCH = 100;

export async function spend(executor: Executor, key: string, rate: Rate): Promise<Spent> {
  const perSecond = rate.perHour / 3600;
  const burst = sql`${rate.burst}::double precision`;
  const refill = sql`${perSecond}::double precision`;
  const available = sql`least(${burst}, bucket.tokens + extract(epoch from (now() - bucket.refilled_at))::double precision * ${refill})`;

  const spent = await executor.execute<{ inserted: boolean | null; available: number | null }>(sql`
    with spent as (
      insert into rate_limit_bucket as bucket (key, tokens, refilled_at)
      values (${key}, ${burst} - 1, now())
      on conflict (key) do update
        set tokens = ${available} - 1, refilled_at = now()
        where ${available} >= 1
      returning (xmax = 0) as inserted
    )
    select
      spent.inserted,
      (select ${available} from rate_limit_bucket as bucket where key = ${key}) as available
    from (values (1)) as one
    left join spent on true`);
  const [row] = spent.rows;
  if (!row || row.inserted === null) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - (row?.available ?? 0)) / perSecond)),
    };
  }
  if (row.inserted) {
    await prune(executor);
  }
  return { allowed: true };
}

export async function refund(executor: Executor, key: string, rate: Rate): Promise<void> {
  await executor.execute(sql`
    update rate_limit_bucket
    set tokens = least(${rate.burst}::double precision, tokens + 1)
    where key = ${key}`);
}

async function prune(executor: Executor): Promise<void> {
  await executor.execute(sql`
    delete from rate_limit_bucket where key in (
      select key from rate_limit_bucket
      where refilled_at < now() - ${PRUNE_AFTER}::interval
      limit ${PRUNE_BATCH}
    )`);
}
