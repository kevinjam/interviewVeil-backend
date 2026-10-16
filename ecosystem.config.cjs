/** PM2 process file for production (native Linux). Run from `backend/`: pm2 start ecosystem.config.cjs */
const fs = require("node:fs");
const path = require("node:path");

const backendDir = __dirname;

/** Minimal .env parser so PM2 gets DATABASE_URL and keys (node_args --env-file is unreliable with reload). */
function loadEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i < 1) continue;
    const key = trimmed.slice(0, i).trim();
    let val = trimmed.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = loadEnvFile(path.join(backendDir, ".env"));

module.exports = {
  apps: [
    {
      name: "interviewveil-api",
      cwd: backendDir,
      script: "dist/server.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "400M",
      env: { ...fileEnv, NODE_ENV: "production" },
    },
  ],
};
