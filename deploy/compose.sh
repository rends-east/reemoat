#!/bin/sh
# `docker compose` for the control-plane stack; arguments pass through unchanged.
set -eu

DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

REEMOAT_CP_ENV_FILE=${REEMOAT_CP_ENV_FILE:-$HOME/.reemoat/control-plane.env}
export REEMOAT_CP_ENV_FILE
# Absolute: compose resolves --env-file against the cwd and env_file: against the project directory.
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

# Pinned, never derived: compose names the project after the cwd, so a moved checkout would start a second project on a second volume.
COMPOSE_PROJECT_NAME=${REEMOAT_CP_PROJECT:-reemoat-cp}
export COMPOSE_PROJECT_NAME

# Resolved by lib.sh's cp_image_ref, never a default of its own: an export here beats --env-file in compose interpolation.
# shellcheck source=lib.sh
. "$DEPLOY_DIR/lib.sh"
REEMOAT_CP_IMAGE=$(cp_image_ref)
export REEMOAT_CP_IMAGE

# --project-directory is deploy/docker, not the repository root, whose .env is the daemon's and holds REEMOAT_TOKEN.
exec "${REEMOAT_DOCKER:-docker}" compose \
  --project-directory "$DEPLOY_DIR/docker" \
  -f "$DEPLOY_DIR/docker/compose.yml" \
  --env-file "$REEMOAT_CP_ENV_FILE" \
  "$@"
