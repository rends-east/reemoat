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
                                     # a machine, from nothing to enrolled. Neutral source;
                                     #   it ASKS which control plane to join
  … | sh -s -- --url https://cp.example  #   or say it outright (REEMOAT_CONTROL_PLANE too)
  … | sh -s -- --enroll-code ec_…    #   with a code already minted, and no account credential
  … | sh -s -- --uninstall           #   stop it and take the unit away; names your data, deletes none
  … | sh -s -- --uninstall --purge   #   and delete it, after naming the database, checkout and worktrees it would take
                                     #   — and the desktop app's other servers, under ~/.reemoat/servers (Q7.148)
deploy/agents.sh --check             # what the agent CLIs would install or refresh, changing nothing
deploy/agents.sh --only kimi         #   that harness alone. What `src/agentinstall.ts` passes when
                                     #   somebody presses Install; its value is checked, --skip's is not
deploy/agents.sh --refresh-only      #   move what is here, fetch nothing new. What `deploy.sh` and the
                                     #   daemon's daily run pass — **nothing installs a harness but a
                                     #   press**, so a new one does not arrive on the fleet by itself
deploy/agents.sh --fail-if-locked    #   exit 3 rather than 0 when another run holds the lock, so a
                                     #   press can tell a contended run from a successful no-op
deploy/agents.sh --source npm        #   the same five from the npm registry rather than the vendors'
                                     #   hosts — what the daemon passes under REEMOAT_AGENT_SOURCE=npm
deploy/agents.sh --channel stable    #   claude from its stable channel rather than latest, the default —
                                     #   what the daemon passes under REEMOAT_AGENT_CHANNEL=stable, and
                                     #   re-applied by every refresh, not only the install (Q4.115)
deploy/ci-freshness.sh               # the adapter pins against the registry: behind is a report,
                                     #   unpublished is exit 2, unreachable is exit 3. Needs the network

deploy/install.sh control-plane      # one-time, interactive: settings → image → start → admin key → first user
deploy/install.sh daemon             #   same; enrolls itself against a local control plane if there is one
deploy/install.sh daemon --non-interactive  # writes the env file and stops, for scripts
deploy/deploy.sh                     # update: fetch, reset, install, rebuild, restart only what changed
deploy/deploy.sh --ref <sha>         #   pin a commit; this is also the rollback
deploy/deploy.sh --service daemon    #   default is whatever is installed on this machine

deploy/backup.sh                     # a consistent snapshot of the control plane's database:
                                     #   `VACUUM INTO` through a read-only handle, `PRAGMA
                                     #   integrity_check`, 0600, fourteen kept. That volume holds the key
                                     #   that mints every token in the fleet, and losing it is not a
                                     #   restore — it is an enrollment code typed on every machine, by hand
deploy/backup.sh --schedule          #   daily at 04:17 through this host's own init. ⚠ snapshots land on
                                     #   the host they came from, which is not a backup — `--dir` is what
                                     #   points it at whatever you sync

deploy/compose.sh up -d              # the control plane *and* the relay; there is no unit for either.
                                     #   ⚠ recreates both — `deploy.sh` is what keeps them apart
deploy/compose.sh up -d --no-deps relay      # just the relay, which is what a relay deploy is
deploy/compose.sh logs -f control-plane      # the only place the one-time admin key survives
deploy/compose.sh ps | down | config #   a passthrough, so any compose command reaches the stack
```

## The one-liner

**`deploy/bootstrap.sh` is served at `/install.sh`, and the two names differ on
purpose.** `install.sh` configures a service on a checkout somebody already has;
`bootstrap.sh` gets a machine from *nothing* — no repository, possibly no node —
and then **hands off to `install.sh`** rather than reimplementing unit rendering,
`runtime_path` or the health probe. Two files called `install.sh` in one
repository is a trap, and the one people grep for is the wrong one.

**The hand-off works because writing the env file first is what makes the install
non-interactive**, and that is a property of `install.sh` rather than of its flag:
both its interview and its refusal-to-start are gated on `cmp -s "$ENV_FILE"
"$ENV_EXAMPLE"`. A real file in place, `--non-interactive` renders the unit,
starts it and probes it. `services/premium`'s cloud-init provisioner has done
exactly this in production since before this script existed.

**Three provenances, one order, no fallback constant.** `--url` /
`REEMOAT_CONTROL_PLANE` wins; else the origin `GET /install.sh` substituted into
the placeholder (`publicUrl(c)` corrected by `x-forwarded-proto` — see below);
else it **asks**, with no default. `deploycheck` asserts that the only lines naming a
real control-plane host are inside `resolve_control_plane`, that the hosted
instance is offered there and never as the menu's first row, and that it is
assigned only behind that menu's answer — the property is "nothing arrives there
without being chosen", which an assignment behind a choice satisfies and a
default does not.

**⚠ The README downloads from a release asset, not from a control plane, and that
is Q4.112.** A download URL answers *where the software is*; letting it also
answer *which fleet this machine joins* is how somebody who wanted their own
control plane enrols into the author's by pressing Enter. `ci-release.sh`'s
`publish` uploads `deploy/bootstrap.sh` as `install.sh`, and `docscheck` pins the
README's URL to `SOURCE_URL` plus that asset name. The **route** stays for the
in-app case, where you are already signed in to the control plane in question and
there is nothing ambiguous about it.

**`publicUrl` alone is wrong behind a TLS proxy.** `@hono/node-server` takes the
scheme from `socket.encrypted`, and this service runs plain HTTP behind Traefik —
so it answers `http://`, and `http://app.reemoat.com/v1/instance` is a **301**
that `bootstrap.sh` deliberately does not follow. `installOrigin` reads
`x-forwarded-proto`, gated on `trustedProxyHops` exactly as `callerAddressOf` is.
The four code-minting routes answer `controlPlaneUrl` through the same function
now — Q1.627. `relaycheck` pins both directions offline; on a stand whose
plaintext port did not answer, the raw `publicUrl` was a daemon that could never
enroll.

⚠ **The substituted value is caller-influenced and is shell-quoted for a measured
reason.** A `Host` of ``a`id`b`` reaches `URL.origin` intact; unquoted, sourcing
the result *executes* it. `app.ts` holds the third copy of `shellQuote` in this
repository — `webcheck` runs all three over a hostile table, and `imagecheck`
sends a hostile `Host` through a real container, because agreeing in three files
is not the same as being called.

**Everything runs from one `main "$@"` on the last line.** `curl … | sh` executes
bytes as they arrive, so a truncated download runs a *prefix* — with `set -e`
silent, because nothing failed. Wrapped, it defines a function and exits.
`deploycheck` asserts the shape.

**stdin is the download, so nothing in it reads stdin.** Every question is asked
on `/dev/tty`. `lib.sh`'s `interactive()` is `[ -t 0 ] && [ -t 2 ]` and stdin here
is a pipe on a perfectly good terminal — teaching that function to redirect was
refused, because it would change every existing caller and make `deploycheck`'s
EOF-driven `ask` cases unreachable.

**`PNPM_VERSION` and `NODE_MAJOR` are pinned in the file and tied to the root
manifest by `deploycheck`.** Nothing else in this tree reads those two lines:
`pincheck` compares the six *version* sites to each other and has never heard of
this one, so a bootstrap installing pnpm 10 against a lockfile written by 11.17.0
would fail on a stranger's laptop and be green here.

**The machine is created before the clone**, so `409 machine_limit` costs seconds
rather than a clone, a ~220 MB `pnpm install` and ~700 MB of agent CLIs. **Only
the enrollment code reaches disk** — an API key is used in memory and dropped, a
minted session is revoked with `DELETE /v1/me/sessions/current` (the `:id` form
is below `requirePasswordCurrent` and would 403 for exactly the account most
likely to be running this).

**`--agent-source npm` is one flag for two runs.** `parse_flags` refuses anything
but `vendor` or `npm`; the value is passed to the bootstrap's own `deploy/agents.sh`
run and written into the env file as `REEMOAT_AGENT_SOURCE=npm`, so the install and
every daily refresh after it agree about where the four come from. `vendor` is the
default and writes nothing. On a machine that is already set up neither run happens
here, so `existing_install` refuses the flag and names the env file setting
instead of accepting a flag that changes nothing. **`--agent-channel stable|latest`
is the same shape for claude's release channel** — `REEMOAT_AGENT_CHANNEL`, written
only when it is `stable`, refused the same way on a machine already set up — with
one difference in what the daily run does with it: the script's refresh *re-applies*
the channel (`claude install "$CHANNEL"`, never `claude update`, which follows
whichever channel the last install wrote into claude's own settings), so the env
file decides the channel for the machine's life and not only for its first install.
Q4.115 is the measurement.

**`svc_uninstall` lives in `lib.sh`, not in the bootstrap.** That file is the only
one that knows one machine from another, and a script issuing `launchctl`
directly would be the second. It refuses a docker-backed service outright.

## Deployment

**It is two deployments, not one, and the split is the design** — they share a
repository because `packages/control-plane` imports the root `src/`, and nothing
else: one is per fleet and holds the signing key, the other per host and runs
agents on it. So `install.sh` takes **one** service per run, `control-plane`
bringing the relay up beside it and asking no new questions. Q4.1, Q4.101.

**Three *services*, though — `relay` is the third**, sharing the control plane's
image, env file, database and compose project and not sharing a restart.
`deploy.sh` recreates it only when the image moved **and** `RELAY_INPUTS` matched
the diff, so a `packages/web` or `app.ts` deploy leaves every tunnel up: the image
alone recreates the relay for a CSS change, the path list alone is a regex
deciding what a build produced. `deploycheck` walks
`packages/control-plane/src/relay/main.ts`'s import closure and fails on any file
`RELAY_INPUTS` does not cover, too narrow being the silent direction — a relay
left running code the deploy replaced everywhere else. `schema.sql` is on that
list for a reason no closure shows: the relay holds prepared statements against
tables the API may have migrated. Q4.33, Q4.34.

**A bare `deploy/compose.sh up -d` recreates both**, which is the operator's own
act rather than what a deploy does — every `svc_*` verb names its compose service
through `compose_service`. Q4.100.

**The control plane is a container and the daemon is not**, which is what **What
is not confined** answers. `deploy/compose.sh` is the one way in and there is no
unit for it. Q4.2.

**`install.sh` is a wizard on a terminal and an installer without one**, the test
being a tty on **stdin and stderr**. Without one it still writes the env file,
renders the unit and refuses to start an unconfigured service. Q4.22.

**A marker line scraped out of a log has to promise something.** `admin
password: ` must never appear on a line that does not carry the password, both
scrapes are anchored `[^ ]+$`, and the loop waits for the key **and** the
password, which is written nowhere else. Q4.31.

**It asks about every listener and every route it creates**, the defaults being
wider than the question they follow: `REEMOAT_CP_RELAY_HOST` defaults to
`0.0.0.0`, and relay-only writes `REEMOAT_HOST=127.0.0.1` and `REEMOAT_PORT=0`,
clearing `baseUrl` not being the lever. **A default offered over a prompt is still
a decision** — the URL daemons will dial derives from `$_rhost` and falls through
to `lan_address` only on a wildcard bind. Q4.6, Q4.102.

**A value written into an env file is single-quoted.** Those files are `.`-sourced
by `run-daemon.sh`, so an unquoted value is shell *source* rather than data:
measured, `REEMOAT_ENROLL_CODE=xy$(touch PWNED)` created the file on source, and
the ceiling is arbitrary code as the daemon that runs your agents. The replacement
path does not use `awk -v`, which escape-processes its value.

**The control plane's file additionally refuses an apostrophe, and that guard
follows the resolved path rather than the filename.** compose's dotenv parser
rejects the POSIX `'\''` escape and fails the *whole file* before any verb, so
`set_env` exits 2 on one. `_cpenv=$(env_file control-plane)` is an arm of its own
*beside* the `*control-plane.env` suffix patterns rather than instead of them,
because `REEMOAT_CP_ENV_FILE=/etc/reemoat/cp.env` walks straight past those.
Q7.57.

**The unit's PATH puts the system directories first**, because a package-manager
prefix such as `/opt/homebrew/bin` is group-writable by every administrator
account and ahead of `/usr/bin` shadows `/usr/bin/git`, which `src/git.ts` spawns
bare against your own repositories with your own hooks running. `runtime_path`
re-resolves every tool under the PATH it built, **states** a disagreement and puts
that tool's directory back in front; it does not refuse. `REEMOAT_UNIT_PATH`
overrides the computation. Q4.8.

**Nothing in `deploy/` knows this machine** — repo root from the script's own
location, `node`/`git` from `command -v`, env paths overridable, since launchd and
systemd read no profile. The supervised process inherits nothing from the
installing shell either, so `@ENV_FILE@` is a placeholder in both templates,
substituted by `render_unit` at render time: a host installed with an override
needs the variable in `deploy.sh`'s environment too. Q4.9, Q4.32.

**Restart is gated on what changed**, the control plane's costing every relay
tunnel and the daemon's **every in-flight turn and every pending approval** — so
what to check before a deploy is whether a session is mid-turn or blocked on you,
not whether one is open. `src/**` affects both, `packages/control-plane/**` only
one, `scripts/daemon.ts` only the other; **`RESTART_DEPS` is the root
`package.json` alone**, the *image's* input list is deliberately wider, and
`pnpm-lock.yaml` is no trigger at all, moving as it does for any package in the
workspace. Q4.10, Q4.14.

**What decides the recreate is what the image *is*, not the path list.**
`cp_image_fingerprint` reads the layers and the config and deliberately **not**
`.Id`, which on a containerd image store is the OCI *index* digest and moves on
every build. Q4.13.

**`deploy/` is not exempt from its own gating.** `^deploy/` is a trigger,
`render_unit` lives in `lib.sh` rather than `install.sh`, and reloading is its own
verb: launchd's `bootstrap` errors on an already-bootstrapped label and neither
`kickstart` form re-reads the plist, while systemd's `enable --now` is a no-op
against a running unit. Q4.15.

**A failing service does not abort the deploy half-way** — `wait_healthy` and
`svc_restart` return non-zero, and as bare statements under `set -e` they end the
loop, so failures are collected and decide the exit status at the end. Q4.16.

**`deploy.sh` refuses a dirty working tree** (it runs `git reset --hard`), resolves
its tools *before* touching the checkout, says what it is about to run, and
honours `REEMOAT_DEPLOY_REQUIRE_SIGNATURE`. Q4.17, Q4.23.

**A unit that is not going to be started is not written where the supervisor
looks.** launchd bootstraps every plist in `~/Library/LaunchAgents` at login and
the template carries `RunAtLoad`/`KeepAlive`, so one rendered there under a
printed "Not starting" is a ten-second crash loop at the next reboot. It is staged
in `~/.reemoat/`, outside the scanned directory rather than under a non-`.plist`
name, because `launchd.plist(5)` says a plist is only *expected* to end in
`.plist`. The condition is "the env file is still byte-for-byte the example", and
the interview writes to a copy moved into place after the last question. Q4.20,
Q4.21.

**A deploy ends at `/health`, not at the supervisor** — every startup failure
happens *after* the unit is accepted. The address comes from the service's own env
file, `REEMOAT_PORT=0` is reported as skipped, and the probe is not `curl` alone.
Q4.19, Q4.24.

**The threadpool size is set twice and the shell one is the reliable half.** libuv
reads `UV_THREADPOOL_SIZE` once, lazily, and `scripts/daemon.ts` assigns it in a
module body that ESM runs *after* every `import` above it — one future import
reading a file at load time latches the pool at 4, silently. `run-daemon.sh` and
the `daemon` script export it before `node` starts. Q4.18.

**CD exists for the control plane, is manual, and deliberately does not cover the
daemon.** `.github/workflows/deploy.yml` calls `deploy/deploy.sh --ref <sha>
--service control-plane` over ssh — the script, never a reimplementation of it —
on `workflow_dispatch` and nothing else, refusing a commit whose `check` run is
not green and **refusing to deploy a daemon**. **The workflow file decides
nothing**: every decision is in `deploy/ci-deploy.sh`, driven by `deploycheck`
through the `SSH` and `GH` seams. The ssh itself is unmeasured. Q7.94.

**A release is a tag push, and `release.yml` decides nothing either.** Everything
is in `deploy/ci-release.sh`, five verbs — `plan`, `image`, `manifest`, `app`, `publish`
— **each of which re-runs every gate**, because a workflow is a graph somebody can
re-run one job of. It refuses a tag the **six** version sites disagree with (both
manifests, the root, `app.ts`'s `VERSION`, `src/version.ts`'s `DAEMON_VERSION`,
the newest `CHANGELOG` heading), each refusal naming its own file; a commit whose `check` run is not green, which here
means the `image` job too and is therefore stronger than the deploy gate; a tag
that already has a release **or an image**, GHCR moving a tag being silent; and an
empty changelog section. A `check` still **running** is waited for rather than
refused (`RELEASE_CHECK_WAIT_SECONDS`, 420s) — both workflows fire on the same
tag push, so reading the verdict once always read an unfinished run; a commit with
no run at all still refuses instantly, that being the shape of a missing
`actions: read`. `ci-deploy.sh` carries the same gate and the same wait.
`RELEASE_SKIP_CHECK_GATE` and `RELEASE_ALLOW_RETAG` are the two escapes. `deploycheck` drives all of it through `GH`, `DOCKER` and
`RELEASE_ROOT`, the last pointing at a synthetic tree so six different
disagreements are reachable.

**Every `org.opencontainers.image.*` label is derived from a file rather than
written down**, and `deploycheck` proves it by mutating the fixture and watching
the label follow — string equality would pass on a transcribed constant.
`source` comes from `SOURCE_URL` specifically, not from `repository.url`: they are
equal in a healthy tree, `pincheck` keeps them so, and `app.ts` is what instructs a
fork to change its §13 source, so a fork that obeys the licence gets a correct
image label for free — and since the web client stopped drawing a source notice,
this label and `GET /v1/instance` are the only two places the URL surfaces at all.
Neither is a reason to change `SOURCE_URL`; both are reasons not to delete it.

**The native app rides the same tag, and `app` is the verb for it.**
`.claude/rules/native-packaging.md` owns which platform carries a daemon and which
carries a client; this half is what a *release* does with the answer. One matrix
leg per desktop target and a job of its own for android, each building and naming
one artifact; `publish` puts every one of them on the same `gh release create`
call as the installer, and **refuses a release missing an artifact its own list
named** — by name, never by count. `manifest`'s "a silently-skipped matrix leg"
argument, one act over and sharper: a page missing the Windows build looks
finished to everybody except the people it was missing for.

**The matrix is `plan`'s output, not a list in the YAML.** `app_runner` joins
`app_triple`, `app_profile` and `app_artifacts` as the fourth column of one table;
`plan` emits it as JSON and `release.yml` reads it through `fromJSON`, so adding a
target is `RELEASE_APP_TARGETS` plus a `check.yml` leg and **no** workflow edit.
Android is a job rather than a leg because it is the only target that reads a
signing key and a matrix cannot scope a secret to one entry — the four
`RELEASE_ANDROID_*` names appear in that job and nowhere else, which is `plan`'s
whole reason for not checking them. ⚠ `deploycheck` reads `release.yml` against
the script's `case` in **both** directions now: the `app` verb shipped with nine
refusals, ~125 lines and no caller, and four documents described the wiring
anyway.

⚠ **`RELEASE_APP_TARGETS` names five, and each has a `check.yml` leg building the
same bundle** — `native`'s four-leg matrix bundles for real, `android-apk` is
android's. It is the one knob spelled `${VAR-…}`, an explicit empty being a
request. `deploycheck` asserts every name has a leg: the first build of a platform
may not happen on the release path. ⚠ *The same* is literal — the Linux packages
are one composite action both jobs use, because v0.10.0's release job lacked the
list its check leg had and died on `gobject-2.0`.

⚠ **Empty means both app jobs are *skipped*, and three lines are what make that
safe.** `plan` emits an empty matrix; each app job carries an `if:`, because an
empty matrix in GitHub Actions is a job that **fails** rather than one that skips;
and `publish` carries an `if:`, because GitHub skips a job whose `needs` includes
a skipped one. Without that third line, wiring the app jobs up would have stopped
every release creating a release page at all. `deploycheck` reads all three back.

⚠ **`manifest` waits for every app, so a failed release publishes nothing.** It
creates the tags people pull and used to need `image` alone — so v0.10.0's Linux
leg died and `:v0.10.0` and `:latest` were pushed anyway, a public image the
re-release gate will never let be rebuilt. Now an app failure leaves no tag: fix,
move the git tag, run again. Its `if:` counts `skipped` as done and `failure` as
not, both halves asserted.

**And the §6 offer rides the notes.** `bundle.licenseFile` is read by the `dmg`
and `nsis` bundlers and by nothing that builds a macOS `.app`, so the artifact most
people download would carry no licence and no source offer. `plan` appends one
naming this **tag** — `main` is routinely ahead of every tag — derived from
`SOURCE_URL` so a fork gets a correct offer for free.

⚠ Two traps, both measured. **`publish` deliberately does not ask the
image-exists question** — `manifest` has just created that tag, so asking would
make the last step of a successful release refuse it. And **the release build
carries no `--load`**: that flag is `imagecheck`'s requirement for a *local* build
under the docker-container driver, and beside `push` it is a contradiction.

**`linux/amd64` only.** `check.yml`'s image job runs on `ubuntu-latest`, so
`imagecheck` has never built or started this image on arm64, and the Dockerfile's
own argument against alpine applies word for word. `RELEASE_PLATFORMS` is the one
variable, the way `REEMOAT_CP_IMAGE` is the one variable for pulled-against-built;
earning arm64 costs one more matrix entry there **and** one in `check.yml`.

**Freshness is a third `ci-*` script, and `freshness.yml` decides nothing
either.** `deploy/ci-freshness.sh` reads every `@agentclientprotocol/*-acp` pin
off `package.json` — the shape, never a copy of `pincheck`'s list — and asks the
registry three questions per adapter through `NPM_VIEW`, which is the question
`pincheck` cannot ask offline. **Behind is a report, not a failure**: exit 0 with
the count of releases and a row in the job summary, because a weekly red for a
pin somebody has chosen not to move yet teaches people to ignore red;
`FRESHNESS_MAX_BEHIND` is the documented margin that turns it into a refusal. A
pin the registry no longer lists is exit 2 — it fails `pnpm install
--frozen-lockfile` on the next machine the one-liner sets up — and a registry
that could not be asked is exit 3 with a sentence, so an outage never reads as a
verdict about the tree. Weekly on `schedule` plus `workflow_dispatch`, a checkout
and one call; `deploycheck` drives all five outcomes through the seams and reads
the YAML back for the one property a workflow can be checked for offline. It is
the first of the three workflows whose file is asserted to decide nothing; the
other two state the rule in their headers and are read by nobody. `renovate.json`
is the other half: proposals only, `rangeStrategy: pin`, no automerge — a person
merges, and each machine still takes it through `deploy.sh`.

**`deploy.sh` now does either, and `install.sh` still only builds.**
`REEMOAT_CP_IMAGE` is the one variable: a registry-qualified ref pulls, a bare one
builds, `cp_image_source` derives it and `REEMOAT_CP_SOURCE` overrides. There is
nothing left to "not mix" — one resolver in `lib.sh` answers for `compose.sh`,
`deploy.sh` and `cp_image_fingerprint` alike, and `deploycheck` asserts no script
holds a second copy of the default. That was not tidiness: two copies meant a pull
could move the digest while the fingerprint inspected a different name, report
**"unchanged"**, and recreate nothing — a green deploy of bytes that were not
running. ⚠ And the env-file recipe `deploy/README.md` carried from the day the
published image existed was **inert**: compose gives the shell environment
precedence over `--env-file` for `${...}`, and `compose.sh` exported its default
first. In pull mode `CP_IMAGE_INPUTS` does not apply — a git diff is a guess at
what a build produces, and a registry ref names exact bytes — while
`cp_image_fingerprint`, `CP_IMAGE_MOVED` and the `RELAY_INPUTS` recreate rule are
untouched, because that function inspects the *local* image either way.

## Layout

| File | Holds |
|---|---|
| `deploy/lib.sh` | The **only** place that knows one machine from another: `service_backend`, `compose_service` (so no verb writes a compose service name by hand), where the tools are, what a unit is called, where it lives and how one is rendered and reloaded, `service_origin` and `health_probe_path` |
| `deploy/install.sh` | One-time setup for **one** service. A wizard on a terminal, a plain installer without one |
| `deploy/ci-deploy.sh` | What a runner does before `deploy.sh`: the secrets it must have, the daemon it may not touch, the CI verdict it will not go around. A script rather than YAML so `deploycheck` can drive every branch, through `SSH` and `GH` as seams |
| `deploy/ci-release.sh` | What a runner does to publish one: the six versions that must agree, the CI verdict it will not go around, the tag it will not move, the labels it derives rather than writes, and the app artifacts it names. Five verbs, five seams, and every gate re-run by each |
| `deploy/ci-freshness.sh` | What a runner does once a week to say how stale the adapter pins are: the pins read off `package.json` by shape, three registry questions per adapter through `NPM_VIEW`, and five outcomes with the exit code each earns written in its header — behind reports, unpublished refuses, unreachable is its own code. Driven by `deploycheck` with no network |
| `deploy/deploy.sh` | The update path. Refuses a dirty tree, builds the image once, then restarts only what the diff touched — with `RELAY_INPUTS` as the one list that decides whether the fleet's tunnels drop. On the daemon it runs `deploy/agents.sh` **before** deciding the restart, with the source read off the env file, every prune withheld and **`--refresh-only`** — so an update moves the copies a machine already has and installs nothing new, which is what stops a harness added to this repository appearing on every machine in the fleet; a script that did not finish is a line on stderr, never a failed deploy |
| `deploy/run-daemon.sh` | What the supervisor runs. Standalone by design — it must work when the environment is at its strangest |
| `deploy/run-cp.sh` | ⚠ On no code path, and **kept until the last host has migrated**: a rendered unit's `@EXEC@` points here, so deleting it takes the fleet down at the next reboot rather than the next deploy |
| `deploy/agents.sh` | The coding-agent CLIs — the only copies there are, since `pnpm install` vendors none (Q4.114): install what is missing, refresh what is there. `--source vendor` (the default) is each vendor's own installer into the vendors' own directories for three of them and the npm registry for kimi; `--source npm` is all four from the npm registry with everything under `~/.reemoat/toolchain`, and is what the daemon passes when `REEMOAT_AGENT_SOURCE=npm` — a choice, never a fallback. `--source` decides how an *absent* harness is installed and nothing about one that is present, which is refreshed through the door it came in by — `provenance` reads where the file is; the one case a switch cannot refresh, a vendor-installed copy under `npm`, is named on stderr until it is removed. `--channel stable\|latest` is which of claude's release channels the vendor arm installs *and* re-applies on every refresh (`claude install "$CHANNEL"`, since `claude update` follows whichever channel the last install wrote into claude's own settings), what the daemon passes under `REEMOAT_AGENT_CHANNEL` and `latest` by default (Q4.115). One script, **four** callers — the bootstrap once and only for harnesses `--install-agents` named, `deploy.sh` on every update and `src/agentupdate.ts` daily (both `--refresh-only`), and `src/agentinstall.ts` `--only <agent>` when somebody presses Install. `--check` to preview and `--skip <agent>` per live harness; exit 0 whatever the vendors said, so one being down is a line on stderr rather than a failed install — and **exit 3 only under `--fail-if-locked`**, which exists because `exit 0` with nothing installed cannot be told from a run that found nothing to do, and a screen would draw that as installed. `--only`'s value is validated against the script's own `AGENTS` list (`deploycheck` compares it with `AGENT_IDS` as a set) where `--skip`'s is not: a bad `--skip` withholds a prune that did not matter, a bad `--only` is a run that touches nothing and reports success. `step: <agent> <phase>` is the one machine-readable line it prints, read by `readStep` in `src/agentinstall.ts` and by nothing else — it exists because `attempt` and `ensure_npm` send every installer's output to `/dev/null`, so a run is otherwise silent for minutes. Holds a `mkdir` lock under the toolchain so any two of those callers — or an orphan a previous daemon left running — serialise rather than prune each other's staging; ignores SIGPIPE so a run outlives the daemon that spawned it; and keeps the npm build it just replaced for one run, because the daemon's `--skip` list is sampled once at run start and a session that started mid-run resolved the launcher to the old build. The directories it writes into are `MANAGED_CLI_DIRS`, which `deploycheck` imports rather than restates |
| `deploy/compose.sh` | `docker compose` with the project name, directory, env file and tag pinned. **Not** the repo root as project directory — compose would load the daemon's `.env` |
| `deploy/docker/*` | The control plane as an image: a filtered install, the web bundle built in, a reachability walk that prunes what the root workspace dragged in — and **two services from that one image**, sharing a volume, with no `depends_on` between them |
| `deploy/launchd/*.in`, `deploy/systemd/*.in` | One template per init system |
| `scripts/deploycheck.ts` | The only driver whose subject is shell. What it drives is **enumerated in its own header** rather than described |
