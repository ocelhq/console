import { db } from "@console/db";
import { sql } from "drizzle-orm";

export function healthCheck(reachDatabase: () => Promise<unknown>) {
  return async (): Promise<Response> => {
    try {
      await reachDatabase();
      return Response.json({ status: "ok" });
    } catch {
      return Response.json({ status: "unavailable" }, { status: 503 });
    }
  };
}

export const health = healthCheck(() => db.execute(sql`select 1`));
