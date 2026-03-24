# Clawroll services.
#
# One Dockerfile, two services. `SERVICE` picks which entry point runs, because the engine
# and the wallet worker share the same workspace, the same dependencies, and almost all of
# the same code — two near-identical Dockerfiles would drift, and the drift would show up as
# a worker running against a different version of the ledger than the engine.
#
#   docker build --build-arg SERVICE=engine .
#   docker build --build-arg SERVICE=wallet-worker .
#
# Multi-stage so the runtime image carries no compiler, no source maps and no dev
# dependencies. The build stage installs everything; the runtime stage takes only what is
# needed to run.

# ---------------------------------------------------------------------------
# deps — resolved once, cached until a manifest changes
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable

# Only the manifests, so a source-only change does not invalidate the dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/poker/package.json      packages/poker/
COPY packages/shuffle/package.json    packages/shuffle/
COPY packages/protocol/package.json   packages/protocol/
COPY packages/db/package.json         packages/db/
COPY packages/solana/package.json     packages/solana/
COPY apps/engine/package.json         apps/engine/
COPY apps/wallet-worker/package.json  apps/wallet-worker/

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — typecheck everything, then compile
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/engine/ apps/engine/
COPY apps/wallet-worker/ apps/wallet-worker/

# A type error must fail the build here rather than at runtime in production. The repo's
# strict settings make this a real gate, not a formality.
RUN pnpm -r --filter '!@clawroll/web' typecheck

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ARG SERVICE=engine
ENV SERVICE=${SERVICE} \
    NODE_ENV=production \
    PORT=8080

# No corepack in the runtime image. Leaving it in means every task launch shells out to
# npmjs to fetch pnpm — slow on every scale-out, and a hard failure in a VPC without egress.
# The tsx binary is already in node_modules from the build stage, so pnpm is a build-time
# tool only.
RUN apk add --no-cache tini

COPY --from=build /app /app

# Never root. A container escape from a process that only needs to read a socket and talk to
# Postgres should not start with the ability to write its own image.
RUN addgroup -S clawroll && adduser -S clawroll -G clawroll && chown -R clawroll:clawroll /app
USER clawroll

EXPOSE 8080

# tini as PID 1 so SIGTERM reaches Node. Without it the process is killed rather than shut
# down, and an ECS deployment would drop live WebSocket connections mid-hand instead of
# closing them.
ENTRYPOINT ["/sbin/tini", "--"]

# Run TypeScript directly via tsx rather than compiling to JavaScript.
#
# Every workspace package points `main` at `src/*.ts`, so emitting JS would mean rewriting
# eight manifests and threading a build step through all of them — a larger change than this
# milestone warrants, for a startup cost measured in tens of milliseconds and no runtime
# difference. The typecheck in the build stage is what catches type errors; tsx only strips
# types, it does not check them.
#
# Invoked as a plain binary, not through a package manager: nothing at runtime should need
# the network to start.
CMD ["sh", "-c", "exec node_modules/.bin/tsx apps/${SERVICE}/src/main.ts"]
