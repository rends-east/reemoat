#!/bin/sh
# Standalone on purpose (no lib.sh): the supervisor starts it with an almost empty environment.
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)

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

# Set here, not in the daemon: libuv sizes its threadpool before the entry module's first statement runs.
UV_THREADPOOL_SIZE=${UV_THREADPOOL_SIZE:-64}
export UV_THREADPOOL_SIZE

# tsx directly so the supervisor's SIGTERM reaches the daemon; keep in step with the root package.json daemon script.
exec "$REPO_ROOT/node_modules/.bin/tsx" scripts/daemon.ts
