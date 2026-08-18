#!/bin/sh
# What the supervisor actually runs for the daemon.
#
# Deliberately standalone — it does not source lib.sh. This is the one file that
# has to work when the environment is at its strangest: launchd and systemd start
# it with almost nothing set, no profile is read, and if it fails there is no
# terminal to explain it, only a log nobody is watching yet. Whatever it depends
# on is another thing that can be missing at that moment.
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)

# Nothing in this repository reads a `.env` file on its own — there is no dotenv
# dependency and no `--env-file` anywhere in `src/` or `scripts/`. The daemon
# refuses to start without REEMOAT_TOKEN (exit 2) unless REEMOAT_AUTH=signed,
# so the environment is not optional and this is where it comes from.
ENV_FILE=${REEMOAT_ENV_FILE:-$HOME/.reemoat/daemon.env}
if [ ! -f "$ENV_FILE" ]; then
  echo "no environment file at $ENV_FILE" >&2
  echo "  run: $REPO_ROOT/deploy/install.sh daemon" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090  # a deployment path, not input
. "$ENV_FILE"
set +a

cd "$REPO_ROOT"

# **The threadpool size has to be set out here, not in the daemon.**
#
# libuv reads UV_THREADPOOL_SIZE once, lazily, when it creates the pool for the
# first piece of work handed to it — and under `tsx` that happens during module
# loading, before the entry module's own first statement runs. Setting it from
# JavaScript at the top of `scripts/daemon.ts` therefore did nothing at all:
# measured 2026-08-03, 16 concurrent `pbkdf2` jobs took 236ms with the in-module
# assignment against 234ms with the pool forced to 4, and 142ms with the variable
# already in the environment. The pool was 4 the whole time.
#
# It matters because every `node:fs/promises` call in this daemon draws from that
# pool, and a hard NFS mount whose server has paused blocks inside the kernel and
# keeps its slot for the life of the process. At 4 slots, two stalled directories
# stop every later `await` on the filesystem while `/health`, which touches no
# files, goes on reporting the daemon up. `src/browse.ts` bounds how often that
# cost is paid; this is what makes the budget large enough to absorb it.
#
# Only when unset: an operator who has tuned it has a reason.
UV_THREADPOOL_SIZE=${UV_THREADPOOL_SIZE:-64}
export UV_THREADPOOL_SIZE

# `tsx` directly rather than `pnpm daemon`, which is the same command with one
# more process in front of it. Two reasons, both about shutdown: the supervisor's
# SIGTERM should reach the daemon itself, because it has a real graceful stop (a
# 20s budget to close sessions, then a hard exit at 25s), and a package manager
# in the middle is one more thing that has to forward a signal correctly. This
# mirrors the `daemon` script in the root package.json; they must move together.
exec "$REPO_ROOT/node_modules/.bin/tsx" scripts/daemon.ts
