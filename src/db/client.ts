import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export const db = drizzle(pool, { schema, casing: "snake_case" });
export type Db = typeof db;
/** A transaction or the root db: functions that write should accept either. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Apply pending SQL migrations from `backend/drizzle/`. */
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder });
}
