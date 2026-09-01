# The control plane, as an image.
#
# Build:  docker build -f deploy/docker/Dockerfile -t reemoat/control-plane .
#         — from the REPOSITORY ROOT. See the four `COPY src/*.ts` lines below
#         for why the context cannot be `packages/control-plane`.
# Run:    deploy/compose.sh up -d
#
# The daemon is not here and must not be. It spawns agents as children of itself,
# as you, with your HOME and your repositories — that reversal is the design, and
# the container runtime this repository used to have was the per-tenant *agent*
# sandbox, deleted along with the tenancy model it belonged to. This image
# is the opposite kind of thing: a service that spawns nothing.
#
# What is deliberately NOT installed, against the deleted agent image which
# installed all three and named a measurement for each:
#
#   * no `procps`, no `util-linux`. Those were there so the daemon could signal
#     process groups and allocate a pty inside the container. `grep -rn
#     "child_process\|spawn(" packages/control-plane/src` is empty — this process
#     has no children to signal and no login to drive.
#   * no `curl`. `deploy/lib.sh`'s `http_ok` already establishes the house answer
#     for a host without it: fall back to `node -e fetch(...)`. Installing a
#     package to run a health check is the argument that already lost there.
#   * no `git`. The control plane touches no repository; that is `src/git.ts`,
#     which is the daemon's.

# ---------------------------------------------------------------------------
# manifests — the layer that decides whether the two installs below cache
# ---------------------------------------------------------------------------
#
# `node:24-slim` rather than alpine. `engines` is >=24 because `node:sqlite`
# needs --experimental-sqlite on 22, and 24-on-glibc is the only combination
# this code has a green signal on: CI is `node-version: 24` on ubuntu-latest.
# Alpine would probably work — the lockfile carries the musl rollup binaries and
# esbuild's are static — but "probably" against "measured green" is not a trade
# worth taking on the process that holds the key signing every token in the fleet.
FROM node:24-slim AS manifests
WORKDIR /app

# Pinned to the root package.json's `packageManager`, and not through corepack:
# corepack was measured absent on the development machine (the same finding
# .github/workflows/check.yml records), it still downloads pnpm at first use so
# it buys no offline property, and it is on its way out of Node. Matching the
# field exactly is what stops pnpm's own manage-package-manager-versions from
# fetching a second copy at runtime.
RUN npm install -g --no-fund --no-audit pnpm@11.17.0

# Every manifest, not only the one being installed. `--frozen-lockfile` verifies
# pnpm-lock.yaml against *every* importer in pnpm-workspace.yaml before it
# installs the filtered subset, so a workspace missing one of them is not the
# workspace the lockfile describes and the check fails rather than passing.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/control-plane/package.json ./packages/control-plane/
COPY packages/web/package.json ./packages/web/

# ---------------------------------------------------------------------------
# web — vite, in its own stage so its toolchain never reaches the runtime image
# ---------------------------------------------------------------------------
FROM manifests AS web

# esbuild and rollup each link a prebuilt binary chosen by the *installing*
# platform, and `pnpm-workspace.yaml` has `allowBuilds: {esbuild: true}` so
# esbuild's install script runs. That is why node_modules cannot be copied from
# the host: this repository's tree holds @esbuild/darwin-arm64 and an image needs
# @esbuild/linux-{arm64,x64}. Both are in the lockfile, so --frozen-lockfile
# resolves on either.
RUN pnpm install --frozen-lockfile --filter @reemoat/web

COPY tsconfig.json ./
COPY packages/web/tsconfig.json packages/web/vite.config.ts packages/web/index.html ./packages/web/
COPY packages/web/src ./packages/web/src
# `public/` is copied to the root of `dist` by Vite, and `index.html` names both
# files in it. Its own line rather than the one above, because that COPY takes a
# file list and this is a directory — and it is the second half of the pair
# `.dockerignore` states: missing from *that* list this fails here with "not
# found", missing from *this* one the build succeeds and the page ships with two
# `<link>`s pointing at 404s. Measured, in that order.
COPY packages/web/public ./packages/web/public
RUN pnpm --filter @reemoat/web build

# What leaves this stage is smaller than what the build produced, and both halves
# are here rather than in the runtime COPY because `COPY` cannot exclude a
# pattern without `# syntax=docker/dockerfile:1.7-labs` — pruning at the source
# is the same result without pinning this file to a labs frontend.
#
# **The maps do not ship.** `vite.config.ts` sets `sourcemap: "hidden"`, so
# nothing in the bundle points at them and they exist only as build artifacts to
# hand an error tracker — which this image is not. Measured on this bundle: 4.1 MB
# across 15 files, the main one 4,017,366 bytes, served behind `/`, a route that
# needs no credential, and re-gzipped from scratch on every request at 98.7 ms of
# CPU each.
#
# **Then the compressible assets get a `.gz` sidecar, at level 9, with the
# original kept beside it** (`-k`). Compressing once at build time rather than
# per request is the other half of that measurement: the byte count on the wire
# is the same and the CPU is spent here — but only if `serveStatic` is asked for
# it, so these files are inert unless the control plane passes `precompressed`.
# Level 9 costs seconds in a stage that already runs vite and buys bytes on a
# phone on LTE. The original has to stay: a client that did not send
# `accept-encoding: gzip` still has to be served.
RUN find /app/packages/web/dist -name '*.map' -type f -delete \
 && find /app/packages/web/dist -type f \
      \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' -o -name '*.json' \) \
      -exec gzip -9 -k {} +

# ---------------------------------------------------------------------------
# deps — the control plane's node_modules, and nothing else's
# ---------------------------------------------------------------------------
FROM manifests AS deps

# **No --prod, and that is load-bearing rather than lazy.** `tsx` is a
# devDependency and it is REQUIRED at runtime: neither service in this repository
# has a build step, and running from source under tsx is what a deployment of
# this *is*. There is no `dist` to ship instead, so --prod produces an image that
# cannot start.
#
# --filter keeps the *web* toolchain out. It does NOT keep the root package's
# dependencies out, and that surprised this build: pnpm always installs the
# workspace root importer, and this repository's root is itself a workspace
# package whose dependencies are the daemon's. Measured before codex was added,
# the resulting tree was 344 MB, 260 MB of it
# `@anthropic-ai/claude-agent-sdk-linux-arm64`, in the image of a process that
# spawns no agent — and codex put a second binary of that order beside it, since
# `@openai/codex` ships a platform build per architecture. It grows per agent.
RUN pnpm install --frozen-lockfile --filter @reemoat/control-plane

# So the store is pruned to what the control plane can actually reach. The
# script says why at length and refuses rather than emptying the store if its
# entry point ever moves; `--filter='!.'`, `pnpm deploy` and `--no-optional`
# were all tried first and each is recorded there with how it failed.
COPY deploy/docker/prune-store.mjs /tmp/prune-store.mjs
RUN node /tmp/prune-store.mjs /app && rm /tmp/prune-store.mjs

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime

# The same absolute path the install ran at, and this is not cosmetic. pnpm
# writes host-absolute paths into its bin shims — measured, this repository's
# `packages/control-plane/node_modules/.bin/tsx` exports
# NODE_PATH=/Users/rends/reemoat/node_modules/.pnpm/tsx@4.23.1/... — so the
# install path and the run path have to be the same string. The module-resolution
# symlinks are relative and would survive a move; the shims would not, and "the
# loader works and cpctl does not" is worse than either working or neither.
WORKDIR /app

# The whole tree in one COPY, on purpose. pnpm's isolated linker makes
# packages/control-plane/node_modules/{hono,ws,tsx} relative symlinks into
# ../../../node_modules/.pnpm/, so copying the package's node_modules alone
# yields dangling links and an error at the first import.
COPY --from=deps /app /app

# Source, left root-owned: the process runs as `node` and cannot rewrite its own
# code. Only the state volume is writable by it.
#
# This list is the repository root's entire reach into this image, by literal
# path. A control-plane file that imports something from `src/` not named here
# passes `typecheck`, `authcheck`, `daemoncheck`, `relaycheck`, `deploycheck`,
# `webcheck` and `pincheck` — and fails only at runtime, inside a container, which
# is what `imagecheck` exists to catch. Add the file here in the same commit that
# adds the import.
COPY src/token.ts src/auth.ts src/cors.ts src/http.ts ./src/
COPY src/relay/protocol.ts ./src/relay/
COPY tsconfig.json ./
COPY packages/control-plane/src ./packages/control-plane/src

# `schema.sql` rides along inside packages/control-plane/src, and it has to:
# store.ts reads it as `new URL("./schema.sql", import.meta.url)`, so it must sit
# beside store.ts rather than wherever a build would have put it. Named here
# because a later "copy only the .ts files" tidy-up would break the first start
# with an ENOENT nobody would connect to a bundler.

# cpctl, so `deploy/compose.sh exec` can administer a control plane whose API is
# published on the loopback of a host nobody is sitting at. Pure fetch, reads no
# files, 6 KB.
COPY packages/control-plane/scripts ./packages/control-plane/scripts

# The one-line installer, served by `GET /install.sh` with the instance's own
# origin substituted in. `main.ts` resolves it as `../../../deploy/bootstrap.sh`
# from its own file URL, which is `/app/deploy/bootstrap.sh` here and
# `<repo>/deploy/bootstrap.sh` in a checkout — the same relative path in both,
# which is what makes one COPY line enough. Its twin is `!deploy/bootstrap.sh`
# in `.dockerignore`; without that this line fails with "not found".
COPY deploy/bootstrap.sh ./deploy/

COPY --from=web /app/packages/web/dist ./packages/web/dist

# --- state -----------------------------------------------------------------
#
# The mount point is created here, 0700 and owned by node, so a fresh named
# volume inherits both. store.ts chmods the directory 0700 and the file 0600
# itself but wraps *both* in try/catch and tolerates failure silently — "a
# filesystem without POSIX modes is not a reason to refuse to start" — so on a
# mount that cannot hold modes the fleet's private signing key sits in a
# directory whose permissions are whatever the sharing layer decided, and
# nothing says so. Doing it in the image means the volume is already right.
RUN install -d -m 0700 -o node -g node /var/lib/reemoat

# Explicit, never derived from homedir(). os.homedir() reads /etc/passwd or
# $HOME, so a `--user` override relocates the database — and that is not an
# error: store.ts creates a fresh one and ensureSigningKey mints a NEW signing
# key, at which point every enrolled daemon rejects every token and nothing in
# the log says why.
ENV REEMOAT_CP_DB=/var/lib/reemoat/control-plane.db

# Both listeners bind wide *in here*, which inverts main.ts's deliberate default
# for the API. The default is not discarded, it is relocated: inside a network
# namespace a loopback bind means "reachable by nobody", and who can actually
# reach this service is decided by the host side of the published port. Same
# shape as the relocation CLAUDE.md already records for the daemon — loopback
# binding is the lever, so when the listener moves, the lever moves with it.
# Set here as well as pinned in compose's `environment:` so there are two locks
# on one door: an operator's leftover REEMOAT_CP_HOST=10.x.y.z cannot make this
# bind an address the namespace does not have — a failure whose EADDRNOTAVAIL is
# asynchronous and therefore lands *after* the one-time admin key has printed.
ENV REEMOAT_CP_HOST=0.0.0.0 \
    REEMOAT_CP_RELAY_HOST=0.0.0.0

# REEMOAT_CP_ISSUER is deliberately NOT set. It defaults to "reemoat-cp" and
# every enrolled daemon checks `iss` against the value it recorded at
# enrollment, which it never refreshes. Writing it here — even to what looks
# like the same string — is one typo from a fleet that rejects every token.

ENV NODE_ENV=production TMPDIR=/tmp

# **The threadpool, and this is the placement that decides it.**
#
# libuv reads UV_THREADPOOL_SIZE once, lazily, when it creates the pool for the
# first piece of work handed to it — and under `tsx` that happens during module
# loading, before `src/main.ts`'s own first statement runs. So an assignment in
# JavaScript is a belt and this is the braces: an image ENV is in the environment
# before node starts. deploy/run-daemon.sh carries the measurement that settled
# it (2026-08-03, 16 concurrent pbkdf2 jobs: 236ms with the in-module assignment,
# 234ms with the pool forced to 4, and 142ms with the variable already set — the
# pool was 4 the whole time).
#
# It matters here because password verification is scrypt on that pool, and the
# pool is shared with the `serveStatic` that serves the web bundle. At 4 slots a
# handful of concurrent logins would queue the login page behind them, which is a
# denial of the one remedy. src/password.ts gates itself far below this number
# for the same reason.
ENV UV_THREADPOOL_SIZE=64

USER node
EXPOSE 7888 7889

# The API listener, and only it.
#
# This used to probe both, because one process held both and main.ts's
# deliberate non-fatal `uncaughtException` handler — "a backstop, not a licence"
# — meant a relay server that died on a socket error left a process still up,
# still answering /health on the API port, and carrying no tunnels. A restart
# policy cannot see that; a two-listener probe could.
#
# The relay is its own container now (compose.yml), so that shape is gone: this
# image is started twice with two commands, and each container is healthy or not
# on its own. The relay's service overrides this HEALTHCHECK with one that
# probes `/__relay/health` — a real unauthenticated route on the relay listener,
# which is what it did not have when this check was written. What that route is
# careful *not* to be is `/health`: that path belongs to the daemon on the far
# side of a tunnel and is exactly what the browser fetches to resolve a machine's
# route, so answering it at the relay would report every machine in the fleet as
# reachable.
#
# Exec form, so there is no /bin/sh between docker and the check.
HEALTHCHECK --interval=15s --timeout=6s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const p=process.env.REEMOAT_CP_PORT||'7888';fetch('http://127.0.0.1:'+p+'/health',{signal:AbortSignal.timeout(5000)}).then(x=>{if(!x.ok)throw new Error('api '+x.status)}).then(()=>process.exit(0),e=>{console.error(String(e));process.exit(1)})"]

WORKDIR /app/packages/control-plane

# `node --import tsx`, not `tsx` — and this diverges from deploy/run-cp.sh on
# purpose.
#
# tsx's CLI spawns a child: measured over its own dist/cli.mjs, one
# `child_process`, one `.spawn(`, and five `kill()`s forwarding SIGINT/SIGTERM.
# Under a supervisor that is fine. As PID 1 it means the wrapper is PID 1,
# main.ts is a grandchild, `docker stop`'s SIGTERM takes a hop through code we do
# not own before reaching the handler at main.ts:333, and a wrapper that dies
# first leaves a grandchild reparented to PID 1 with nothing reaping it.
#
# tsx's package exports "." -> "./dist/loader.mjs", which is exactly the
# --import entry point, and --import specifiers resolve against the cwd — this
# WORKDIR, which has node_modules/tsx. So main.ts runs *in* PID 1 and the signal
# lands on its own handler.
#
# --enable-source-maps because it is one of the flags tsx's CLI passes to the
# child it spawns; dropping it silently turns every stack trace in `docker logs`
# into transpiled line numbers.
#
# Exec form. A shell wrapper here would be a /bin/sh that does not forward
# signals and a shutdown that never runs.
CMD ["node", "--enable-source-maps", "--import", "tsx", "src/main.ts"]
