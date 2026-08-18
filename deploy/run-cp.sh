#!/bin/sh
# What the supervisor actually runs for the control plane.
#
# **Kept deliberately, and it must not be deleted until every host has migrated.**
# The control plane ships as a container now (deploy/docker/), and this wrapper is
# no longer on any path `install.sh` or `deploy.sh` takes. It stays because a host
# that still has a rendered unit has `@EXEC@` pointing at *this file*: delete it
# from the checkout and the unit survives, launchd execs a missing program at the
# next reboot, and — with `KeepAlive` and `ThrottleInterval 10` — retries it every
# ten seconds for ever, taking the fleet's identity, relay and web UI down with no
# warning at the time and nothing to attribute it to later.
#
# Measured, not theorised: deleting it produced exactly that on the development
# machine at the first reboot, `last exit code = 78: EX_CONFIG`.
#
# `deploy.sh` now refuses to run while a legacy unit is present, which closes the
# deploy path. This closes the reboot path. Remove it in the commit that removes
# the last unit.
#
# Standalone for the same reason as run-daemon.sh: it must work when nothing else
# is set up. A separate file rather than one wrapper taking a service argument —
# the env file, the working directory and the command all differ, and a branch
# here would hide the difference in the one place an init system cannot show you
# when it goes wrong.
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)

# Unlike the daemon, this service starts with no environment at all: every one of
# its variables has a default. That is exactly why the file is still required —
# the defaults bind the API to 127.0.0.1 and leave the relay off, so a control
# plane started with an empty environment comes up looking healthy and reachable
# by nobody.
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

# The threadpool, out here for the reason run-daemon.sh states at length: libuv
# reads it once, lazily, at the first piece of pool work, which under `tsx`
# happens during module loading. Password verification is scrypt on that pool and
# `serveStatic` draws from it too, so a small pool lets a spray against the login
# endpoint queue the login page behind it. The container sets this in its own ENV;
# this is the same value for the hosts still starting from a rendered unit.
#
# Only when unset: an operator who has tuned it has a reason.
UV_THREADPOOL_SIZE=${UV_THREADPOOL_SIZE:-64}
export UV_THREADPOOL_SIZE

# The working directory `pnpm cp` would use. It matters for exactly one setting:
# a relative REEMOAT_CP_WEB is resolved against the current directory. The web
# root's *default* is resolved from the source file's own URL instead, so the
# built UI is found either way.
cd "$REPO_ROOT/packages/control-plane"

# Its own tsx: this is a separate workspace package with its own node_modules.
# Mirrors the `cp` script in packages/control-plane/package.json.
exec "$REPO_ROOT/packages/control-plane/node_modules/.bin/tsx" src/main.ts
