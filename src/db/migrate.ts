import { pool, runMigrations } from "./client.js";

await runMigrations();
await pool.end();
console.log("Migrations applied.");
