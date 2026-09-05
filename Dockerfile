# The web app is built here, so the image that runs carries no toolchain.
FROM oven/bun:1.3.2-alpine AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.2-alpine
WORKDIR /app
# The database lives on the volume, not in the image: a restart keeps the tape.
ENV FOMOPULSE_DB=/data/fomopulse.db PORT=8080
# Only what runs: the same lockfile without the dev tools, so wrangler and its workerd
# binary from the worker workspace stay out of the image that serves the tape.
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN bun install --frozen-lockfile --production
COPY --from=build /app/apps/server apps/server
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/config config
RUN mkdir -p /data && chown -R bun:bun /data
USER bun
VOLUME /data
EXPOSE 8080
# Nothing here signs anything; the process only reads the chain and serves what it read.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/api/status > /dev/null || exit 1
CMD ["bun", "run", "apps/server/src/index.ts"]
