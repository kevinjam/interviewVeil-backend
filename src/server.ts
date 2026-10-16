import { start } from "./index.js";

await start().catch((err) => {
  console.error("[boot] failed to start:", err);
  process.exit(1);
});
