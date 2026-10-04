---
paths:
  - deploy/*
  - deploy/docker/*
  - deploy/launchd/*
  - deploy/systemd/*
  - .github/*
  - .github/actions/*/action.yml
  - scripts/deploycheck.ts
  - scripts/imagecheck.ts
---

## Commands

```bash
curl -fsSL https://github.com/rends-east/reemoat/releases/latest/download/install.sh | sh
                                     # a machine, nothing to enrolled; ASKS which control plane
  … | sh -s -- --url https://cp.example  # or names it (REEMOAT_CONTROL_PLANE too)
  … | sh -s -- --enroll-code ec_…    # a code already minted, no account credential
  … | sh -s -- --uninstall [--purge] # remove the unit, delete nothing; --purge deletes DB, checkout,
                                     #   worktrees and ~/.reemoat/servers, naming them first (Q7.148)
deploy/agents.sh --check | --only kimi | --refresh-only | --fail-if-locked
                                     # preview; one harness (a press); fetch nothing (deploy.sh,
                                     #   daily); exit 3 if another run holds the lock
deploy/agents.sh --source npm | --channel stable   # REEMOAT_AGENT_SOURCE / REEMOAT_AGENT_CHANNEL (Q4.115)
deploy/install.sh control-plane      # one-time: settings → image → start → admin key → first user
deploy/install.sh daemon [--non-interactive]  # enrolls to a local CP if any; flag: env file only
deploy/deploy.sh [--ref <sha>] [--service daemon]  # update; --ref is also the rollback
deploy/backup.sh [--schedule] [--dir <d>]  # control-plane DB: `VACUUM INTO` via a read-only handle,
                                     #   `PRAGMA integrity_check`, 0600, fourteen kept, daily 04:17. Stays on
                                     #   this host without --dir. It holds the signing key: losing it
                                     #   re-enrolls every machine by hand
deploy/compose.sh up -d              # control plane and relay; no unit; recreates both
deploy/compose.sh up -d --no-deps relay   # a relay deploy
deploy/compose.sh logs -f control-plane   # only place the admin key survives; any verb passes
```

## The one-liner

**`deploy/bootstrap.sh` is served at `/install.sh`; the names differ on purpose.** It
gets a machine from nothing and **hands off to `install.sh`** (which configures a
service on a checkout) rather than reimplementing unit rendering, `runtime_path` or
the probe. An env file in place makes the install non-interactive: interview and
refusal-to-start are gated on `cmp -s "$ENV_FILE" "$ENV_EXAMPLE"`.
`services/premium`'s cloud-init relies on it.

**Which control plane: `--url`/`REEMOAT_CONTROL_PLANE`, else the origin `GET /install.sh`
substituted, else it asks, with no default.** `deploycheck` asserts real hosts are
named only inside `resolve_control_plane`, the hosted one is never the menu's first
row and is assigned only behind its answer. The README downloads a release asset,
never a control plane, so a download URL never picks the fleet; `ci-release.sh`'s
`publish` uploads `deploy/bootstrap.sh` as `install.sh`, and `docscheck` pins the
README's URL to `SOURCE_URL` plus that name. Q4.112.

**The substituted origin is `installOrigin`, not `publicUrl(c)`**, which answers
`http://` behind Traefik (a 301 `bootstrap.sh` will not follow). It reads
`x-forwarded-proto` gated on `trustedProxyHops`, as `callerAddressOf` does; the four
code-minting routes answer `controlPlaneUrl` through it; `relaycheck` pins both.
Q1.627. The value is caller-influenced (a `Host` of ``a`id`b`` survives
`URL.origin`), so `app.ts` quotes it with its own `shellQuote`; `webcheck` runs all
three copies over a hostile table and `imagecheck` sends a hostile `Host` through a
real container.

**One `main "$@"` on the last line**, so a truncated download runs nothing;
`deploycheck` asserts it. **stdin is the download**: questions go to `/dev/tty`;
`interactive()` (`[ -t 0 ] && [ -t 2 ]`) is not taught to redirect, which would break
every caller and `deploycheck`'s EOF-driven `ask` cases. **`PNPM_VERSION` and
`NODE_MAJOR` are tied to the root manifest by `deploycheck`**; `pincheck` does not
know them. **The machine is created before the clone**, so `409 machine_limit` is
cheap. **Only the enrollment code reaches disk**: an API key stays in memory; a minted
session is revoked with `DELETE /v1/me/sessions/current` (the `:id` form is below
`requirePasswordCurrent` and would 403).

**`--agent-source vendor|npm` and `--agent-channel stable|latest` go to the
bootstrap's `deploy/agents.sh` and into the env file** (`REEMOAT_AGENT_SOURCE=npm`,
`REEMOAT_AGENT_CHANNEL=stable`; defaults write nothing), so every refresh agrees. `parse_flags` refuses other
values; `existing_install` refuses both and names the env setting. The refresh
re-applies the channel with `claude install "$CHANNEL"`, never `claude update`, which
follows whatever the last install wrote. Q4.115. **`svc_uninstall`** (in
`lib.sh`) refuses a docker-backed service.

## Deployment

**Two deployments, three services.** One repository because `packages/control-plane`
imports the root `src/`; the control plane is per fleet and holds the signing key, the
daemon per host. `install.sh` takes **one** service per run; `control-plane` brings
the relay up too. Q4.1, Q4.101. **`relay` shares the control plane's image, env file,
database and compose project, not its restart**: `deploy.sh` recreates it only when
the image moved **and** `RELAY_INPUTS` matched the diff. `deploycheck` fails on any
file in `packages/control-plane/src/relay/main.ts`'s import closure that
`RELAY_INPUTS` misses; `schema.sql` is listed because the relay holds prepared
statements. Q4.33, Q4.34. A bare `deploy/compose.sh up -d` recreates both; `svc_*`
verbs name services through `compose_service`. Q4.100. The control plane is a
container and the daemon is not. Q4.2.

**`install.sh` is a wizard with a tty on stdin and stderr**, and without one still
writes the env file, renders the unit and refuses to start unconfigured. Q4.22. A
scraped marker carries its value: `admin password: ` never appears without it, both
scrapes are anchored `[^ ]+$`, the loop waits for key and password. Q4.31. **It asks
about every listener and route it creates**: `REEMOAT_CP_RELAY_HOST` defaults to
`0.0.0.0`; relay-only writes `REEMOAT_HOST=127.0.0.1` and `REEMOAT_PORT=0`; the dialled
URL derives from `$_rhost`, `lan_address` only on a wildcard bind. Q4.6, Q4.102.

**Env files.** Every value is **single-quoted** (`run-daemon.sh` `.`-sources them, so
unquoted is code run as the daemon), and replacement avoids `awk -v`, which
escape-processes. The control plane's file also **refuses an apostrophe** (`set_env`
exits 2; compose's dotenv rejects `'\''` and fails the whole file), keyed on the
resolved path: `_cpenv=$(env_file control-plane)` sits beside the `*control-plane.env`
patterns, which `REEMOAT_CP_ENV_FILE=/etc/reemoat/cp.env` passes. Q7.57. Nothing in
`deploy/` knows this machine (root from the script, tools from `command -v`, paths
overridable); `render_unit` substitutes `@ENV_FILE@`, so an override must be in
`deploy.sh`'s environment too. Q4.9, Q4.32. compose prefers the shell environment over
`--env-file` for `${...}`.

**The unit's PATH puts system directories first** (`/opt/homebrew/bin` is admin-writable
and would shadow `/usr/bin/git`, which `src/git.ts` spawns bare). `runtime_path` states
a disagreement and moves that tool's directory first, never refuses;
`REEMOAT_UNIT_PATH` overrides. Q4.8.

**Restart is gated on what changed.** The control plane's costs every tunnel; the
daemon's **every in-flight turn and pending approval**, so check for a session
mid-turn or blocked first. `src/**` hits both, `packages/control-plane/**` one,
`scripts/daemon.ts` the other; **`RESTART_DEPS` is the root `package.json` alone**,
the image's input list wider, `pnpm-lock.yaml` no trigger. Q4.10, Q4.14. `cp_image_fingerprint` decides the
recreate from layers and config, never `.Id` (a containerd index digest, new every
build). Q4.13. `^deploy/` is a trigger, and reloading is its own verb: launchd
`bootstrap` errors on a loaded label and `kickstart` re-reads nothing; systemd
`enable --now` no-ops on a running unit. Q4.15.

**`deploy.sh`** collects failures (`wait_healthy`, `svc_restart`) instead of stopping
half-way under `set -e`, Q4.16;
refuses a dirty tree (`git reset --hard`), resolves tools first, says what it runs,
honours `REEMOAT_DEPLOY_REQUIRE_SIGNATURE`, Q4.17, Q4.23; and ends at `/health`, with
the address from the service's env file, `REEMOAT_PORT=0` reported skipped, and a
probe that is not `curl` alone. Q4.19, Q4.24. **A unit that will not start is staged in `~/.reemoat/`**, never in
`~/Library/LaunchAgents` (bootstrapped at login, crash-looping under
`RunAtLoad`/`KeepAlive`) nor renamed there, a plist need not end in `.plist`; the test is "env file byte-for-byte the example", and the
interview writes a copy moved in after the last question. Q4.20, Q4.21.
**`UV_THREADPOOL_SIZE` is exported before `node` starts** by `run-daemon.sh` and the
`daemon` script; `scripts/daemon.ts`'s assignment runs after its imports. Q4.18.

## CI

**No workflow decides anything; a `ci-*.sh` script does, driven by `deploycheck`
through seams.**

- **Deploy** is control plane only, `workflow_dispatch` only:
  `.github/workflows/deploy.yml` runs
  `deploy/deploy.sh --ref <sha> --service control-plane` over ssh. `deploy/ci-deploy.sh`
  refuses missing secrets, a non-green `check` and **refuses a daemon** (seams `SSH`, `GH`). Host key
  pinned from `DEPLOY_KNOWN_HOSTS`, never scanned; the ssh is unmeasured. The script is the workflow's own
  commit's; the ref travels as `DEPLOY_REF` alone. Q7.94.
- **Release** is a tag push: `deploy/ci-release.sh` verbs `plan`, `image`, `manifest`, `app`,
  `publish`, **each re-running every gate**. Refused: a tag the **six** version sites
  disagree with (both manifests, the root, `app.ts`'s `VERSION`, `src/version.ts`'s `DAEMON_VERSION`, the
  newest `CHANGELOG` heading), each naming its file; a non-green `check` (including
  `image`); a tag with a release **or an image**; an empty changelog section. A running
  `check` is waited for (`RELEASE_CHECK_WAIT_SECONDS`, 420s), no run refuses at once;
  `ci-deploy.sh` waits the same. Escapes `RELEASE_SKIP_CHECK_GATE`,
  `RELEASE_ALLOW_RETAG`; seams `GH`, `DOCKER`, `RELEASE_ROOT`.
- **`org.opencontainers.image.*` labels are derived from files** (`deploycheck` mutates
  the fixture). `source` is `SOURCE_URL`, not `repository.url`; with `GET /v1/instance`
  it is the only place the URL surfaces, so keep `SOURCE_URL`.
- **Native apps** ride the tag via `app` (`native-packaging.md` owns platforms). A leg
  per desktop target plus an android job (the only one reading a signing key; the four
  `RELEASE_ANDROID_*` names appear there alone). The matrix is `plan`'s JSON
  (`app_runner`, `app_triple`, `app_profile`, `app_artifacts`) via `fromJSON`: a target
  is `RELEASE_APP_TARGETS` plus a `check.yml` leg. `publish` puts all on one
  `gh release create` and **refuses a release missing a named artifact**, by name, never by count. `deploycheck` reads `release.yml`
  against the script's `case` both ways.
- **The default server is a repository variable**, forwarded as `${{ vars.… }}` by both
  app jobs and printed to the summary; not a secret (`option_env!` embeds it). Unset is
  empty, no default; `nativecheck` asserts it. Q4.127.
- **`RELEASE_APP_TARGETS` names five, each with a `check.yml` leg building the same
  bundle** (`native`'s four legs, `android-apk`; `deploycheck`); spelled `${VAR-…}`, an explicit empty being a request. The
  Linux packages are one composite action both jobs use.
- **Empty skips both app jobs** via three lines `deploycheck` reads: `plan`'s empty
  matrix, an `if:` on each app job (an empty matrix fails), an `if:` on `publish` (a
  job needing a skipped one is skipped). **`manifest` waits for every app**, so a
  failed release pushes no tag; its `if:` counts `skipped` done, `failure` not.
- `plan` appends the §6 offer naming the **tag**, from `SOURCE_URL`, since
  `bundle.licenseFile` reaches no `.app`. `publish` does not ask image-exists; the
  release build has no `--load`. **`linux/amd64` only** (`RELEASE_PLATFORMS`); arm64
  needs an entry there and in `check.yml`.
- **Freshness**: `deploy/ci-freshness.sh` reads `@agentclientprotocol/*-acp` pins off
  `package.json` by shape, three questions each through `NPM_VIEW`. Behind is exit 0
  plus a row (`FRESHNESS_MAX_BEHIND` makes it a refusal), unlisted exit 2, unreachable
  exit 3. Weekly plus dispatch; `deploycheck` drives all five outcomes and reads
  `freshness.yml` back. `renovate.json`: proposals, `rangeStrategy: pin`, no
  automerge.

**`REEMOAT_CP_IMAGE` is the one image variable**: registry-qualified pulls, bare builds
(`cp_image_source`, overridden by `REEMOAT_CP_SOURCE`); `install.sh` only builds. One
resolver in `lib.sh` serves every script, and `deploycheck` refuses a second copy of
the default. Pull mode skips `CP_IMAGE_INPUTS`; `cp_image_fingerprint`,
`CP_IMAGE_MOVED` and `RELAY_INPUTS` read the local image either way.

## Layout

| File | Holds |
|---|---|
| `deploy/lib.sh` | The **only** place that knows one machine from another: `service_backend`, `compose_service`, tools, units and their rendering and reload, `service_origin`, `health_probe_path` |
| `deploy/deploy.sh` | On the daemon runs `deploy/agents.sh` **before** deciding the restart: source off the env file, prunes withheld, **`--refresh-only`**; an unfinished script is a stderr line, never a failed deploy |
| `deploy/run-daemon.sh` | What the supervisor runs; standalone |
| `deploy/run-cp.sh` | On no code path, **kept until the last host migrates**: rendered units' `@EXEC@` point here |
| `deploy/agents.sh` | The agent CLIs (none vendored, Q4.114). `--source vendor` is vendor installers for three and npm for kimi; `npm` is all four under `~/.reemoat/toolchain`, a choice, never a fallback, deciding only how an *absent* harness installs — a present one refreshes through its own door (`provenance`). Callers: the bootstrap (`--install-agents`), `deploy.sh` and `src/agentupdate.ts` (`--refresh-only`), `src/agentinstall.ts` (`--only`). Exit 0 whatever vendors say, **3 only under `--fail-if-locked`**. `--only` is checked against `AGENTS` (= `AGENT_IDS`, `deploycheck`); `--skip` is not. `step: <agent> <phase>` is read only by `readStep`. A `mkdir` lock serialises callers; SIGPIPE ignored; the replaced npm build is kept one run, `--skip` being sampled at start. Writes `MANAGED_CLI_DIRS`, imported by `deploycheck`. `--skip <agent>` per live harness |
| `deploy/launchd/*.in`, `deploy/systemd/*.in` | One template per init system |
| `deploy/compose.sh` | Project, directory, env file and tag pinned; **not** the repo root, which would load the daemon's `.env` |
| `deploy/docker/*` | Filtered install, web bundle built in, reachability prune; **two services from one image**, sharing a volume, no `depends_on` |
