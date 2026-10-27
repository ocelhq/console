import { pg } from "@console/infra";
import { drizzle } from "drizzle-orm/node-postgres";
import { relations } from "./relations";

export const db = drizzle({ client: pg, relations });

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type Executor = typeof db | Transaction;
