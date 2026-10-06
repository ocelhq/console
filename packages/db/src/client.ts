import { pg } from "@console/infra";
import { drizzle } from "drizzle-orm/node-postgres";
import { relations } from "./relations";

export const db = drizzle({ client: pg, relations });
