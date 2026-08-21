# Deploying Reemoat

Two **deployments** ship from this repository, and three *services*: the control
plane is two containers from one image. Install the deployment — or the
deployments — a given machine should run; `install.sh control-plane` brings the
relay up beside the API and asks no extra questions.

| | `control-plane` | `relay` | `daemon` |
|---|---|---|---|
| How many | one per fleet | one, beside it | one per host that runs agents |
| Typically lives | a Linux box with a public address | the same box | wherever the code you work on lives, usually behind NAT |
| Runs as | **a container**, under Docker | the same image, second container | a launchd / systemd *user* unit |
| Needs | Docker with the compose plugin, git, node (for `deploy/`'s own probes) | — | Node ≥ 24, pnpm and git |
| Builds on update | its image, which contains `packages/web` → `dist` | the same image | nothing |
| Holds | the Ed25519 key that signs every token | every daemon's tunnel, and nothing durable | your sessions, their worktrees, your agents' logins |
| Restart costs | nothing anyone is holding | **every tunnel in the fleet**: ~10–45s of reconnecting per open session, every in-flight request | **every live session becomes `interrupted`** |

**More than one relay is possible and is its own document** —
[`RELAYS.md`](RELAYS.md). Read it *before* the first daemon enrolls rather than
when you need it: two values are baked into every daemon at enrollment and
changing either costs a visit to every machine.

That last row is the whole reason the first two are separate. The API's inputs
move constantly and the relay's move rarely, so as one container the cheap deploy
paid the expensive price every time.

They share a repository because `packages/control-plane` imports the root `src/`
(`../../../src/token.js` and friends), so neither can be checked out alone.
That is the whole of what they have in common.

Neither has a build step *in the checkout*: both run from source under `tsx`. The
control plane's image builds `packages/web` into itself, which is the one thing
either service compiles and the reason a control-plane host needs no pnpm, no
`node_modules` and no particular Node version — see
[`docker/README.md`](docker/README.md), which is where everything about that
service's deployment now lives.

**The control plane has no unit.** `install.sh control-plane` builds an image and
brings up a compose stack; there is one way to run it, and `deploy/compose.sh` is
the wrapper everything goes through. `deploy/run-cp.sh` is on no code path any more but is deliberately still here:
a rendered unit's `ExecStart` points at it, so removing it from the checkout
takes the service down at the next *reboot* — measured, `EX_CONFIG` and a
ten-second crash loop. It goes in the commit that removes the last unit.

A launchd or systemd unit left over from an
earlier install is not migrated automatically, and `deploy.sh` **refuses to run**
while one is present: the reset would delete the program that unit execs, and
nothing would fail until the next reboot. `install.sh control-plane` refuses too
when there is a populated `~/.reemoat/control-plane.db` and no volume to read
instead — starting there would mint a new signing key and un-enroll the fleet
while looking perfectly healthy. Follow the migration runbook in
`docker/README.md`; the database holds the fleet's signing key and has to be
carried across by hand.

## Install

The two roles need different things from the host, so they are two blocks
rather than one. **The control plane needs no `pnpm install`** — its
dependencies, its Node and its web bundle are all built into the image, and a
checkout with an empty `node_modules` installs it perfectly well. Verified by
doing exactly that from a fresh clone.

```sh
# the machine that will be the control plane — docker, git and node, no pnpm
git clone https://github.com/rends-east/reemoat.git ~/srv/reemoat
cd ~/srv/reemoat
deploy/install.sh control-plane
```

```sh
# each machine that will run agents — this one does need the workspace
git clone https://github.com/rends-east/reemoat.git ~/srv/reemoat
cd ~/srv/reemoat
pnpm install --frozen-lockfile
deploy/install.sh daemon
```

Run it once per role. **From a terminal it is a wizard** and walks the whole way;
run by a script it is a plain installer (see below).

`install.sh control-plane` no longer offers to build the web UI: the bundle is
built inside the image on every build, so there is no state in which this service
starts without one. The corollary is worth knowing — running `pnpm web:build` on
the host changes nothing that is served, because `.dockerignore` denies `dist`
and nothing mounts it. It asks who should be able to reach the service,
**including where the relay is published**, which is a second listener separate from the API: leaving that
to its `0.0.0.0` default is how an operator who chose "this machine only" ended up
publishing one anyway. It writes the answers, starts it, and catches the admin API
key the control plane prints exactly once on its first start, saving it to
`~/.reemoat/cpctl.env`. That key is stored only as a hash, so if nobody catches
it the only way back is deleting the database — and it is still in the service's
log afterwards, which the installer now says out loud and chmods accordingly. It
then offers to create the first person and prints their API key, which is what
they paste into the web UI.

`install.sh daemon` asks how the daemon should decide who is asking. If a control plane was installed on
the same machine, the first option registers this host and mints an enrollment
code **for you** — the two `cpctl` calls that used to be a checklist. Otherwise it
takes a control-plane URL and a code you minted there, or generates a shared
secret for a single machine with no control plane at all.

It no longer asks **how browsers will reach this daemon**, because there is one
answer: through the control plane's relay. That question existed while a machine's
`baseUrl` was its routing policy, and the defect it was written to fix — a wizard
registering a machine as relay-only while the daemon went on listening on
`0.0.0.0:7887`, a listener on every interface that the registry said did not
exist — is now unreachable rather than fixed. `.env.example` binds `127.0.0.1`,
which is the setting that actually makes the relay the only entrance.

`install.sh control-plane` no longer asks whether to **enable** the relay either.
It is required: every daemon dials it and every request goes through it, so a
control plane without one is a fleet nobody can reach, and `pnpm cp` refuses to
start rather than pretend otherwise.

So both roles on one machine is two commands, and a split fleet is two commands
plus one `cpctl admin enroll` on the control plane, whose output the daemon's
wizard asks for.

**A separate clone is the right shape**, as above, rather than deploying from the
directory you edit in. `deploy.sh` moves the checkout with `git reset --hard`; it
refuses to run against a dirty working tree, but a clone you never edit is the
version of that rule you cannot trip over.

### Without a terminal

With stdin or **stderr** not a tty — or with `--non-interactive` — nothing is
asked. The environment file is written from the matching `.env.example`, the
daemon's unit is rendered into `~/.reemoat/<label>.pending` (the control plane
has none — nothing is created, so nothing can start it), and the service is
**not** started,
because starting an unconfigured one means a supervisor retrying it every ten
seconds. Fill the file in and run it again; that run installs the unit, removes the
staged copy, and starts it.

Four details, each of which was once wrong:

* The tty test is stdin and **stderr**, not stdout. Every prompt is written to
  stderr and only `ask`'s return value goes to stdout, so testing stdout meant
  `install.sh control-plane | tee install.log` silently became the plain installer.
* The condition is "the environment file is still byte-for-byte the example", not
  "this run created it". Otherwise a wizard interrupted at a prompt left the raw
  example in place, and the next run took the "existing, left alone" branch —
  skipping the interview and this guard with it.
* The interview writes to a copy and moves it into place only after the last
  question. `cmp` alone was not enough: the control-plane wizard writes the bind
  address and *then* asks for the port, so an interrupt in between left a file that
  differed from the example and the next run skipped everything again — this time
  starting a half-configured service.
* The unit is **staged outside `~/Library/LaunchAgents`**, in `~/.reemoat/`.
  launchd bootstraps every plist in that directory at login and the template carries
  `RunAtLoad` and `KeepAlive`, so writing it there and printing "not started"
  produced exactly the ten-second crash-loop the message exists to avoid, beginning
  at the next reboot. `launchd.plist(5)` says a plist is only *expected* to end in
  `.plist`, which is a convention rather than a promise, so a `.plist.pending`
  sibling is not a safe place to leave one either. systemd does not autostart an
  un-enabled unit, so the same code path behaved oppositely on its two halves.

A non-interactive run against an **already configured** file does start the
service. That is the update path, and it is what keeps `install.sh` callable from a
script.

### The environment files

Nothing in this repository reads a `.env` file on its own. There is no dotenv
dependency and no `--env-file` anywhere, so the environment is whatever the
supervisor was given, and these files are where the wrappers read it from:

| Service | File | Seeded from | Override with |
|---|---|---|---|
| `daemon` | `~/.reemoat/daemon.env` | `.env.example` | `REEMOAT_ENV_FILE` |
| `control-plane` | `~/.reemoat/control-plane.env` | `packages/control-plane/.env.example` | `REEMOAT_CP_ENV_FILE` |
| `relay` | the control plane's, exactly | — | `REEMOAT_CP_ENV_FILE` |

**One file for both containers, deliberately.** They are two processes of one
deployment and the database path, the relay port and the issuer have to agree
between them or the pair does not work at all — a second file would be a second
place for them to disagree, silently, with a relay answering 401 to every request
because its `iss` no longer matches.

Two more overrides exist and are install-time rather than runtime.
`REEMOAT_CPCTL_ENV` moves the admin-key file. `REEMOAT_UNIT_PATH` replaces the
`PATH` baked into the unit outright — needed only on a machine with two copies of
`node` or `git`, where the resolved one is put ahead of the system
directories and `install.sh` says so, naming the directory's mode if it is writable
by more than its owner.

Both are created `0600` inside a `0700` directory, beside the databases.

The daemon exits 2 without `REEMOAT_TOKEN` (or `REEMOAT_AUTH=signed`), and the
control plane exits 2 without `REEMOAT_CP_RELAY_URL`. Everything else on the
control plane has a default, which is exactly why its file is still worth
reading: the API is published on `127.0.0.1`, so out of the box it is a control
plane nothing outside that machine can reach.

Two settings decide whether a fleet works at all:

* `REEMOAT_CP_PUBLISH` — `127.0.0.1` by default, deliberately: this process
  holds the signing key, so exposing it should be a decision. It is the host side
  of the published port; `REEMOAT_CP_HOST` is the *in-container* bind and is
  pinned to `0.0.0.0` by `deploy/docker/compose.yml`, so editing it has no
  effect. Put a TLS terminator in front rather than publishing wide and
  unencrypted; browsers hold API keys against this origin. On Linux a published
  port is a DNAT rule evaluated before the chain `ufw` writes to, so name one
  interface address rather than `0.0.0.0`.
* `REEMOAT_CP_RELAY_URL` — the address daemons will dial, and it is **required**:
  every request to every machine goes down the tunnel its daemon holds, so a
  control plane without a relay is a fleet nobody can reach, and `pnpm cp`
  refuses to start rather than pretend otherwise. It must be the URL clients use,
  not the bind address: derived from the latter you get `http://0.0.0.0:7889`,
  which works nowhere.

## Update

```sh
deploy/deploy.sh                          # to origin/main, whatever this host runs
deploy/deploy.sh --ref v1.2.3             # or any commit-ish
deploy/deploy.sh --service daemon         # just one, on a host running both
deploy/deploy.sh --force                  # redo the current commit
```

With no `--service` it acts on whatever is installed here, so the same command is
correct on a control-plane VPS and on a daemon host.

It fetches, refuses a dirty tree, resets to the ref, installs dependencies if the
manifests moved, and then does per-service work based on **what actually
changed**:

| Changed | Effect |
|---|---|
| any `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | `pnpm install`, **only on a host running the daemon**. No restart on its own |
| `src/**`, `packages/control-plane/**`, `packages/web/**`, `deploy/docker/**`, `.dockerignore`, the manifests | the image rebuilds, **once**, for both containers |
| the rebuilt image having a **different id** | control plane recreates |
| that **and** `src/relay/**`, `src/{token,auth,http,cors}.ts`, `packages/control-plane/src/relay/**`, `store.ts`, `keys.ts`, `schema.sql`, the manifests | relay recreates — and *only* then |
| `deploy/docker/compose.yml`, `deploy/compose.sh` | both recreate |
| no relay container existing yet | relay is created, whatever the diff says |
| `src/**`, `scripts/daemon.ts`, root `package.json`, `deploy/run-daemon.sh` | daemon restarts |
| `deploy/launchd/**`, `deploy/systemd/**` | the daemon's unit re-rendered and reloaded, which restarts it |

Two things in that table are worth reading twice.

**A web-only change costs a recreate of the API and nothing else.** The control
plane re-reads `index.html` from disk on every request, and `deploy.sh` used to
restart *nothing* for a change under `packages/web` because of it. With the
bundle inside the image that became a rebuild and a recreate — which, while the
relay lived in the same container, dropped every tunnel in the fleet. It does not
any more: the relay is recreated only when the image moved **and** something the
relay is actually built from moved with it, so a `packages/web` deploy leaves
every session connected. The rebuild itself is unchanged, and the alternative to
baking the bundle in is still worse: bind-mounting `dist` from the host would
keep the old behaviour and mean the image is no longer the deployment.
There is **no escape hatch today**, and an earlier draft of this paragraph
claimed one. `REEMOAT_CP_WEB` can point the process at another directory, but
`compose.yml` declares a single volume and `read_only: true` and `compose.sh`
execs one fixed `-f`, so there is no way to get a host directory into the
container through the environment — an absolute host path simply does not exist
in there, and `app.ts` then answers `/` with a plain 404 whose only trace is one
line in `docker logs`. Making the trade available means adding a
`${REEMOAT_CP_WEB}:/srv/web:ro` volume, which nobody has done.

**The recreate is decided by what the image is, not by the paths.** A rebuild
whose layers all came from cache produces byte-identical layers and config and
nothing is recreated, so the path list above is what triggers a *build*; the
measurement is what triggers a restart. It errs safely — a cold cache says
"changed" when nothing did, and `compose up -d` is idempotent, so a wrong guess
costs a log line.

The measurement is `cp_image_fingerprint` and deliberately not `.Id`. With the
containerd image store `.Id` is the OCI index digest, which buildkit re-exports
on every build: three cached builds of an unchanged tree gave three ids while
`.RootFS` and `.Config` were byte-identical, so this used to recreate the control
plane on every deploy that rebuilt.

`src/**` still affects both, because both use it — but now it means "rebuild the
image" on one side and "restart the process" on the other, from one diff.

**Installing a dependency and restarting a service are separate rows, and that
is deliberate.** Only the *root* `package.json` names what the daemon loads, so
only it restarts one. `packages/web/package.json` and `pnpm-lock.yaml` trigger
the install and nothing else: they were once part of the restart test, which
meant a lucide-react bump turned every live session `interrupted` to deliver a
change to a bundle the daemon does not serve. The cost of the narrower rule is
stated rather than hidden — a transitive dependency of the daemon that moves in
the lockfile alone reaches the running process at its *next* restart, which is
what a running process does with its already-loaded modules regardless.

**`deploy/` is not exempt from its own gating.** A changed wrapper restarts the
service that runs it, and a changed unit template is re-rendered here rather than
waiting for somebody to run `install.sh` again. Before those two rows existed, a
new `KeepAlive` or `TimeoutStopSec` was checked out and took effect never.

Finally it waits for `GET /health` on each service and exits non-zero if one does
not answer, so "deployed" means more than "the supervisor did not complain". Every
target is probed even when an earlier one failed: they used to abort the loop, so
on a host running both, a daemon that failed its probe left the control plane
un-restarted and unmentioned, after the checkout had already moved.

Three cases report `skipped` rather than failing, and none of them fails the
deploy: no environment file, an environment file that will not source, and a
relay-only daemon with `REEMOAT_PORT=0`, which has no port to probe and no way to
learn one. The probe uses `curl` where it exists and node where it does not, so a
slim image without curl does not report every service as dead.

### Rolling back

`deploy/deploy.sh --ref <older-sha>`. There is no separate mechanism: a deployment
is a checkout, and pinning the commit is the whole of it.

On a host running the **published** image instead of a built one, the equivalent is
the image tag. Every release publishes `sha-<12>` alongside the version tag, and
that one is stable by construction — point `REEMOAT_CP_IMAGE` at the older of the
two and `deploy/compose.sh pull && deploy/compose.sh up -d`. The recreate is
decided the same way it always is, by `cp_image_fingerprint`, which reads what the
image *is* rather than where it came from.

## Operating

| | launchd (macOS) | systemd (Linux) |
|---|---|---|
| Unit | `~/Library/LaunchAgents/com.reemoat.<service>.plist` | `~/.config/systemd/user/reemoat-<service>.service` |
| Logs | `~/Library/Logs/reemoat/<service>.log` | `journalctl --user -u reemoat-<service>` |
| Restart | `launchctl kickstart -k gui/$(id -u)/com.reemoat.<service>` | `systemctl --user restart reemoat-<service>` |
| Stop | `launchctl bootout gui/$(id -u)/com.reemoat.<service>` | `systemctl --user stop reemoat-<service>` |

**This table is the daemon's.** The control plane has no unit, no plist and no
journal; its equivalents are `deploy/compose.sh ps`, `logs`, `up -d` and `down`.

The daemon is a **user** service: everything it stores lives under `$HOME`, and it
must not run as root, or every agent it spawns runs as root.

That has one setup consequence per platform, and neither is optional:

* **systemd** — `sudo loginctl enable-linger <user>`, or the service stops when
  your last session ends, which on a headless host is the moment you disconnect
  after installing it. `install.sh` checks and warns.
* **launchd** — a `gui/` agent needs a logged-in session, so a headless Mac needs
  automatic login enabled. Otherwise nothing comes back after a reboot.

Neither applies to the control plane any more, and that is one of the clearer
wins in moving it into a container: a stack under `restart: unless-stopped` is
supervised by the system Docker daemon, so it survives logout and reboot with no
lingering and no automatic login.

### If you put a proxy in front

Nothing here ships one, and `install.sh` recommends one twice: for TLS in front of
a service bound to loopback, and because `x-forwarded-for` is only worth believing
when something you control wrote it. If you have one, **it needs one setting**.

**Raise the body limit, or uploads break and nothing here can tell you.** An
attachment may be 100 MiB, and it streams straight through the relay to the daemon
— no service in this repository buffers it or caps it below that. A proxy that
does refuses with a 413 of its own, *before* the daemon sees the request, so the
chip in the composer shows a failure the daemon has no record of.

| | |
|---|---|
| nginx | `client_max_body_size 110m;` — the default is **1 MB**, which refuses almost every attachment |
| Caddy | no limit by default; only set `request_body { max_size }` if you want one |
| Cloudflare | 100 MB on the free and Pro plans, and **not configurable** — an attachment at the cap will not fit through it |

110m rather than 100m: `Content-Length` counts the whole request, and the file is
not the whole request.

Also give it a generous read timeout on `POST /sessions/:id/uploads`. The client
allows a slow upload up to 45 minutes and gives up on **stalling** rather than on
duration; a proxy that times out on duration will cut a transfer that is working.

### Backing up the control plane

**One command, and it is not optional.**

```sh
deploy/backup.sh --schedule        # daily at 04:17, via this host's own init
deploy/backup.sh                   # or take one now
```

The volume holds `signing_keys.private_pem` — the Ed25519 key that mints every
token in the fleet — plus every user, password hash, machine, grant, and the SMTP
password. A daemon writes `keys_json` at enrollment and **never refetches it**, so
losing this file is not a service to restore: it is a fresh enrollment code typed
on every machine in the fleet, by whoever owns it. `deploy/docker/README.md` says
so under *Migrating*, and until `backup.sh` existed the only thing this repository
offered was the five-line `VACUUM INTO` in that same file — a technique, never a
schedule, sitting inside a section about Time Machine.

`VACUUM INTO` rather than a copy, because the database runs in WAL mode and the
file on disk is not the database. It runs against the live service and needs no
downtime; each snapshot is verified with `PRAGMA integrity_check` before it counts
as one, kept 0600, and fourteen are retained.

⚠ **`--schedule` puts snapshots on the host they came from, which is not a
backup.** It removes the failure where nobody ever takes one; copying them off is
still yours. `--dir` points it at whatever you sync.

### Rotating the fleet's signing key

```sh
pnpm cpctl admin signingkeys     # what exists, and which one signs
pnpm cpctl admin rotatekey       # mint a new one; both stay published
pnpm cpctl admin retirekey <kid> # once every daemon has re-enrolled
```

**Three acts, spread over as long as the fleet takes**, and collapsing them is
the one arrangement that cannot work: a daemon captures the key set once at
enrollment and never asks again, so retiring the old key before every machine has
re-enrolled leaves them verifying against a key that no longer signs. The control
plane refuses to retire the last active key for the mirror reason — with none it
can neither sign nor mint a replacement, because `ensureSigningKey` runs at
startup and nothing here restarts itself.

Rotation is **not** revocation of what the old key already signed: tokens live
300 s and daemons verify locally, so a compromised key keeps working at the edge
until each host is re-enrolled. Which is also to say: this is the remedy for a
leaked database, and the visit to every machine is the part it does not remove.

### Another init system

Not required, and less required than it was. The **control plane** needs none at
all — it is a container. For the **daemon**, `deploy/run-daemon.sh` is an ordinary
program that reads the environment file and `exec`s the service; point anything
at it. `install.sh daemon` and the restart half of `deploy.sh` are what will not
work there, and they say so rather than guess.

## Continuous deployment

**Nothing deploys on a push, deliberately.** `.github/workflows/check.yml` runs
the checks and stops there. Beside it, `.github/workflows/deploy.yml` is a
`workflow_dispatch` and nothing else — no push trigger, no schedule — and it
deploys the **control plane only**. The workflow itself decides nothing: it
checks out the ref and calls `deploy/ci-deploy.sh`, which is where the secret
guard, the CI gate and the ssh live so that `deploycheck` can drive every branch
of them with no host and no secrets.

**That script refuses to deploy a daemon**, rather than merely not offering to,
and the reason is the daemon's restart cost: on a machine where you develop and
run agents at once, a deploy interrupts every turn in flight and drops every
pending approval. The sessions come back `interrupted` and resume; the
half-finished work in them does not. So a daemon stays `deploy/deploy.sh
--service daemon`, run by a person on the host, in front of the work it costs.

## Releasing

**A release is a tag push, and that is the one thing here that a push does start.**
It is not a contradiction of the section above: *when to deploy* is a judgement
about somebody's running work, and it stays manual; *what v0.1.0 is* was decided
the moment a person typed `git tag`. The tag is the record of that decision, so it
is also the trigger.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` decides nothing, the same way `deploy.yml` does
not. `deploy/ci-release.sh` holds every gate, in four verbs — `plan`, `image`,
`manifest`, `publish` — and each of them re-runs all of them, because a workflow is
a graph somebody can re-run one job of. It refuses:

- a tag the **six** places the version is written disagree with — the root
  manifest, both packages, `app.ts`'s `VERSION` and the newest dated heading in
  `CHANGELOG.md` — naming the file that disagrees;
- a commit whose `check` run is not green. Stronger than the deploy gate: the
  `check` workflow is green only if the `image` job is, so the image about to be
  pushed is the one `imagecheck` already built and started;
- a tag that already has a release **or an image**. The second matters more —
  GitHub refuses to create a release twice, and GHCR moves a tag without a word;
- an empty `CHANGELOG.md` section, since the release page is that section.

`RELEASE_SKIP_CHECK_GATE=1` and `RELEASE_ALLOW_RETAG=1` are the escapes, and both
are deliberately awkward to type. `deploycheck` drives all of it with no registry
and no forge.

**What it publishes:** a GitHub Release whose notes are the changelog section, and
`ghcr.io/rends-east/reemoat/control-plane` under three tags — the version, a
`sha-<12>`, and `latest`. No rolling `0.1` or `0`: under SemVer a 0.x minor is the
breaking one, so those names would promise stability they cannot keep. Build
provenance is attested, verifiable with `gh attestation verify`.

**`linux/amd64` only**, and the reason is the same one the Dockerfile gives against
alpine: `check.yml`'s image job runs on `ubuntu-latest`, so nothing has ever built
or started this image on arm64, and the release path is the wrong place for a
first. `RELEASE_PLATFORMS` is the one variable that changes it — and the price of
admission is a matching matrix entry in `check.yml`, so `imagecheck` gets there
first.

### Running the published image

`deploy/deploy.sh` and `install.sh` always **build**, and that is unchanged. To run
the published image instead, point the variable at it and use compose directly:

```bash
# in the control plane's env file
REEMOAT_CP_IMAGE=ghcr.io/rends-east/reemoat/control-plane:v0.1.0
```

```bash
deploy/compose.sh pull && deploy/compose.sh up -d
```

⚠ **Do not mix the two on one host.** `deploy.sh` would rebuild over what you
pulled and tag the result with the same name, which looks like a successful deploy
and is not the image you meant to be running. A host that pulls updates with
`compose.sh`; a host that builds updates with `deploy.sh`.
