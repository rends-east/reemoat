#!/bin/sh
# Legacy: only an old host's unit still execs this; delete it together with the last such unit.
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)

ENV_FILE=${REEMOAT_CP_ENV_FILE:-$HOME/.reemoat/control-plane.env}
if [ ! -f "$ENV_FILE" ]; then
  echo "no environment file at $ENV_FILE" >&2
  echo "  run: $REPO_ROOT/deploy/install.sh control-plane" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090  # a deployment path, not input
. "$ENV_FILE"
set +a

# Must be set before node starts: libuv reads it once.
UV_THREADPOOL_SIZE=${UV_THREADPOOL_SIZE:-64}
export UV_THREADPOOL_SIZE

cd "$REPO_ROOT/packages/control-plane"

exec "$REPO_ROOT/packages/control-plane/node_modules/.bin/tsx" src/main.ts
