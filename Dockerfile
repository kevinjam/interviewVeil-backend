# InterviewVeil API — production image.
# Build:  docker build -t interviewveil-api .
# Run:    docker run --env-file .env -p 8787:8787 interviewveil-api

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Install scripts aren't needed to compile (esbuild is only used by dev tools).
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
# Amazon RDS CA bundle, for DATABASE_URL=...?sslmode=verify-full&sslrootcert=/app/rds-ca.pem
ADD --chown=node:node https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-ca.pem
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1
# Migrations run on startup.
CMD ["node", "dist/server.js"]
