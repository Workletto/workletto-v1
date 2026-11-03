# Builds Workletto into a small image that runs as a non-root user.
# Used by Render (render.yaml) and by Docker Compose (compose.yaml).

# ---- Build: install everything, build, then drop development packages ----
FROM node:24.22.0-trixie-slim AS build
WORKDIR /app

# Prisma's migration engine needs OpenSSL, and checks for it when it is installed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

ENV CHECKPOINT_DISABLE=1 NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# ---- Runtime: only what `npm start` needs ----
FROM node:24.22.0-trixie-slim
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# CHECKPOINT_DISABLE stops the Prisma CLI from checking for updates, and the npm
# setting stops npm from doing the same, so the app never contacts anyone.
ENV NODE_ENV=production \
  PORT=3000 \
  CHECKPOINT_DISABLE=1 \
  NPM_CONFIG_UPDATE_NOTIFIER=false

# Files stay owned by root, so the running app cannot change its own code.
COPY --from=build /app/package.json /app/package-lock.json /app/prisma.config.ts /app/CHANGELOG.md ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000

# Applies any new database migrations, then starts the server.
CMD ["npm", "start"]
