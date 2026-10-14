/** PM2 process file for production (native Linux). Run from `backend/`: pm2 start ecosystem.config.cjs */
const path = require("node:path");

const backendDir = __dirname;

module.exports = {
  apps: [
    {
      name: "interviewveil-api",
      cwd: backendDir,
      script: "dist/server.js",
      interpreter: "node",
      node_args: "--env-file-if-exists=.env",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "400M",
      env: { NODE_ENV: "production" },
    },
  ],
};
