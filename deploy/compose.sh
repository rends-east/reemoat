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
# ⚠ **It used to source nothing from lib.sh, and that is no longer true.** The
# claim was "standalone for the same reason as run-daemon.sh: it must work when
# the environment is at its strangest", and the cost of keeping it was a second
# copy of the image default — which is what made `deploy/README.md`'s pull recipe
# inert and let a moved digest report "unchanged". `run-daemon.sh` is still
# standalone and still must be: it is what the *supervisor* runs, at boot, with
# nothing inherited. This is run by an operator from a shell that already found
# the script, so `lib.sh` being reachable is the same assumption as this file
# being reachable. One function is taken from it: `cp_image_ref`.
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
#
# **Through `cp_image_ref`, not a second copy of the default.** This file used to
# hold its own `${REEMOAT_CP_IMAGE:-reemoat/control-plane:current}` and so did
# `lib.sh`'s `cp_image_fingerprint`, which is how a pull could move the digest and
# a deploy could report "unchanged" — and how the env-file recipe in
# `deploy/README.md` came to be inert, since exporting a default here beats
# `--env-file` for compose's `${...}` interpolation. One resolver, consulted by
# everything, is what makes "a host is built or pulled" a fact rather than advice.
#
# `lib.sh` is sourced for that one function. It is `set -eu` and its only
# top-level effect is `detect_init`, which sets a variable and never exits.
# shellcheck source=lib.sh
. "$DEPLOY_DIR/lib.sh"
REEMOAT_CP_IMAGE=$(cp_image_ref)
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
