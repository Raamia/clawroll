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
#
# ## This list is exactly the packages the two services need, and the build stage below
# ## copies the same set. The two must stay in step.
#
# They did not, once: `packages/sdk-ts` was added later, its manifest was never listed here,
# but the build stage copied `packages/` wholesale — so its *source* arrived without its
# dependencies and the typecheck gate failed on a missing module. The build stage now names
# the same packages rather than copying the directory, which turns any future mismatch into
# a missing import at typecheck rather than an image that builds and misbehaves.
#
# `sdk-ts` is here because `apps/bots` genuinely depends on it: the house bots talk to the
# engine over the same public SDK a stranger's bot uses, which is the point of them. It was
# absent while nothing shipped needed it, and adding the bots without adding it broke the
# build — the list going stale is the recurring failure, so anything added under apps/ needs
# its dependencies added here too.
#
# `web` stays out: it would drag Vite and React into a production container that never serves
# a page, and the runtime image copies the whole of /app.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/poker/package.json      packages/poker/
COPY packages/shuffle/package.json    packages/shuffle/
COPY packages/protocol/package.json   packages/protocol/
COPY packages/db/package.json         packages/db/
COPY packages/solana/package.json     packages/solana/
COPY packages/sdk-ts/package.json     packages/sdk-ts/
COPY apps/engine/package.json         apps/engine/
COPY apps/wallet-worker/package.json  apps/wallet-worker/
COPY apps/bots/package.json           apps/bots/

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — typecheck everything, then compile
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
# Named individually rather than `COPY packages/ packages/`, and deliberately the same set as
# the deps stage above. Copying the directory wholesale is what let a package's source into
# the image without its dependencies.
COPY packages/poker/     packages/poker/
COPY packages/shuffle/   packages/shuffle/
COPY packages/protocol/  packages/protocol/
COPY packages/db/        packages/db/
COPY packages/solana/    packages/solana/
COPY packages/sdk-ts/    packages/sdk-ts/
COPY apps/engine/        apps/engine/
COPY apps/wallet-worker/ apps/wallet-worker/
COPY apps/bots/          apps/bots/

# A type error must fail the build here rather than at runtime in production. The repo's
# strict settings make this a real gate, not a formality.
#
# No `--filter '!@clawroll/web'` any more: pnpm enumerates the workspace by which directories
# are actually present, and `web` is not one of them here. An exclusion filter naming a
# package that was never copied reads as though it were, which is how the previous gap stayed
# invisible.
RUN pnpm -r typecheck

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ARG SERVICE=engine
ENV SERVICE=${SERVICE} \
    NODE_ENV=production \
    # Resolve workspace packages to their source, matching how this image runs everything.
    #
    # `clawroll` points `main` at `dist/`, which is a published artifact this image neither
    # contains nor builds — the whole design here is to run TypeScript through tsx rather than
    # compile it, so every other workspace package already resolves to `src`. Without this the
    # container starts and dies on ERR_MODULE_NOT_FOUND for a package that is definitely
    # installed. The `development` export condition is what points at source.
    NODE_OPTIONS=--conditions=development \
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
