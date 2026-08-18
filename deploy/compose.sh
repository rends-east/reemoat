#!/bin/sh
# `docker compose` for the control plane, already pointed at the right stack.
#
# Everything after the script name is handed to compose unchanged, so
# `deploy/compose.sh logs -f`, `deploy/compose.sh ps`, `deploy/compose.sh config`
# and `deploy/compose.sh exec control-plane sh` all work. A passthrough rather
# than a set of verbs, because an operator who cannot run an arbitrary compose
# command against their own stack is stuck at exactly the moment they need not
# to be.
#
# Standalone for the same reason as run-daemon.sh: it must work when the
# environment is at its strangest, so it sources nothing from lib.sh.
set -eu

DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

# The same file the process reads, and the same file install.sh writes. Compose
# reads it twice — as --env-file for `${...}` interpolation of the published
# ports, and as the service's `env_file:` for the process's own environment —
# which is what keeps one artifact the operator re-reads.
REEMOAT_CP_ENV_FILE=${REEMOAT_CP_ENV_FILE:-$HOME/.reemoat/control-plane.env}
export REEMOAT_CP_ENV_FILE
# **Absolute, because compose resolves this path twice against two different
# directories.** `--env-file` is relative to the working directory; the
# service-level `env_file:` is relative to `--project-directory`, which is pinned
# below to deploy/docker. Measured: `REEMOAT_CP_ENV_FILE=cp.env` passes the
# `[ -f ]` test here using the cwd and then fails inside compose naming
# `deploy/docker/cp.env`, a path the operator never typed. install.sh always
# writes an absolute one; this is for a hand-set override.
case "$REEMOAT_CP_ENV_FILE" in
  /*) ;;
  *)
    echo "REEMOAT_CP_ENV_FILE must be an absolute path, got \"$REEMOAT_CP_ENV_FILE\"" >&2
    echo "  compose resolves it against two different directories otherwise." >&2
    exit 2
    ;;
esac
if [ ! -f "$REEMOAT_CP_ENV_FILE" ]; then
  echo "no environment file at $REEMOAT_CP_ENV_FILE" >&2
  echo "  run: $DEPLOY_DIR/install.sh control-plane" >&2
  exit 2
fi

# Pinned, never derived. Measured: `docker compose` run from /Users/rends/reemoat
# names the project `reemoat` — the basename of the working directory — so a
# checkout moved from ~/reemoat to ~/srv/reemoat silently becomes a *second*
# project against a second volume, while the first is still running and still
# holding the fleet's signing key. That is not a tidiness argument.
COMPOSE_PROJECT_NAME=${REEMOAT_CP_PROJECT:-reemoat-cp}
export COMPOSE_PROJECT_NAME

# A value here and a `${...}` in the compose file, so moving from "built on this
# host" to "pulled from a registry" is one variable and no edit to anything else.
REEMOAT_CP_IMAGE=${REEMOAT_CP_IMAGE:-reemoat/control-plane:current}
export REEMOAT_CP_IMAGE

# **`--project-directory` is this directory, NOT the repository root**, and that
# is a security line rather than a style one. Compose loads a `.env` from its
# project directory by default; the repository root's `.env` is the *daemon's*
# environment file and holds REEMOAT_TOKEN. Pointed here, there is no `.env` to
# find, and `--env-file` below names the only file we mean. `--env-file` also
# replaces the default rather than adding to it, so the two together mean the
# daemon's token is never a value compose can interpolate.
#
# The build context is still the repository root — see the `build.context` in
# compose.yml and the four `COPY src/*.ts` lines in the Dockerfile.
exec "${REEMOAT_DOCKER:-docker}" compose \
  --project-directory "$DEPLOY_DIR/docker" \
  -f "$DEPLOY_DIR/docker/compose.yml" \
  --env-file "$REEMOAT_CP_ENV_FILE" \
  "$@"
