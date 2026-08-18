# The control plane, in a container

**Two containers, one image.** `control-plane` serves `/v1` and the web UI;
`relay` holds every daemon's tunnel. They share the image, the env file, the
database volume and the compose project — what they do not share is a restart,
and that is the whole reason they are two.

Recreating the API is ordinary: a web bundle moved, a route changed. Recreating
the relay costs every tunnel in the fleet — ~10–45s of "reconnecting" per open
session, every in-flight request, and any approval tapped in the window. As one
container the first paid for the second, every deploy. `deploy/deploy.sh` is what
keeps them apart; **a bare `deploy/compose.sh up -d` recreates both**, which is
fine as a deliberate act and is not what a deploy does. To touch one:

```sh
deploy/compose.sh up -d --no-deps control-plane   # the API alone; tunnels stay up
deploy/compose.sh up -d --no-deps relay           # the relay alone
```

There is no `depends_on` between them, deliberately: the relay authorizes from
live rows and never asks the API anything, so it must serve while the API is
down. On a first boot whichever starts first applies the schema; only the API
ever mints the signing key.

The daemon is not here and must not be. It spawns agents as children of itself,
as you, with your `HOME`, your keys and your repositories — that reversal is the
design, and the container runtime this repository used to have was the per-tenant
*agent* sandbox, deleted along with the tenancy model it belonged to.

This service is the opposite kind of process, which is why it containerizes
cleanly: it spawns nothing (`grep -rn "child_process\|spawn(" src/` in
`packages/control-plane` is empty), it touches one SQLite file, one `schema.sql`
beside its own module and one read-only directory of static assets, and its only
native dependency is esbuild, arriving under `tsx`.

Everything is driven through one wrapper, which pins the four things that must
not vary:

```sh
deploy/compose.sh ps
deploy/compose.sh logs -f control-plane   # name one, or get both interleaved
deploy/compose.sh logs -f relay
deploy/compose.sh config          # the fully interpolated file that will run
deploy/compose.sh exec control-plane node --import tsx scripts/cpctl.ts admin users
```

It is a passthrough, so anything `docker compose` takes works. Running plain
`docker compose` instead is refused with the reason.

## Configuration

One file, `~/.reemoat/control-plane.env`, read twice: as `--env-file` for the
published ports and as the service's `env_file:` for the process. Seeded from
`packages/control-plane/.env.example`, which documents every key.

Three keys behave differently from the rest, and the difference matters because
each one fails without a symptom.

| key | what happens to it |
|---|---|
| `REEMOAT_CP_HOST`, `REEMOAT_CP_RELAY_HOST` | **Pinned to `0.0.0.0` by `compose.yml`, so setting them here does nothing.** Inside a namespace a loopback bind is reachable by nobody, and a leftover LAN address is an `EADDRNOTAVAIL` that `serve()` reports **asynchronously** — after the one-time admin key has printed. Use `REEMOAT_CP_PUBLISH` instead |
| `REEMOAT_CP_DB` | **Pinned by `compose.yml`**, and the image `ENV` alone was not enough: `env_file:` beats an image `ENV`, so a value here used to win. Relocating the database is not an error — a fresh one is created and a **new signing key** is minted, after which every enrolled daemon rejects every token and nothing says why |
| `REEMOAT_CP_ISSUER` | **Not pinned — carried**, deliberately. A fleet whose daemons enrolled against a non-default issuer needs exactly that value passed through, so `compose.yml` stays out of the way. The flip side is that a typo here is one typo from a fleet that rejects every token, and nothing will catch it. **Both containers read it**, and they must agree: a relay on a different issuer answers 401 to every request |
| `REEMOAT_CP_RELAY_MODE` | **Pinned to `external` by `compose.yml`.** This file *is* the split. A control plane here that started its own relay would bind a port nothing publishes and then answer `relayOnline` from a map no daemon ever dials into — every machine offline, two relays' worth of code running, and no error anywhere. `embedded` remains the default in `main.ts` and is what `pnpm cp` runs |

`REEMOAT_CP_PUBLISH` is the lever that `REEMOAT_CP_HOST` used to be. Default
`127.0.0.1`, exactly as `main.ts` defaults, for exactly its stated reason.

**On Linux, publishing a port bypasses ufw and firewalld.** Docker writes DNAT
rules into `nat/PREROUTING`, evaluated before the `filter/INPUT` chain where
those tools write theirs, so `ufw deny 7888` does not deny the port carrying
`/v1/admin/*`. Naming one interface address in `REEMOAT_CP_PUBLISH` is the fix
and needs no firewall cooperation — the DNAT rule then matches one destination
and nothing else reaches it. To restrict the relay, rules go in `DOCKER-USER`,
which Docker never flushes. On macOS none of this applies: ports are published by
an ordinary listening socket on the host.

## The first start, and the key that is printed once

The first start with no users mints an admin and prints its key **once**, to
stdout; only the hash is kept. Recovery is deleting the database, which is the
signing key, which is the fleet.

**`deploy/install.sh control-plane` handles this for you**, and it does it with
`up -d` rather than the foreground run below: it polls `docker compose logs` for
the key with a bound, writes `~/.reemoat/cpctl.env` at 0600, and says out loud
that the container's log does not outlive the container. That is the supported
path and the one the rest of `deploy/` is built around.

The manual alternative is worth knowing for a host where you want to watch the
first start, and the two must not be combined — `run --service-ports` collides
with an already-published stack:

```sh
deploy/compose.sh build
deploy/compose.sh run --rm --service-ports control-plane
```

`run` rather than `up`, for three reasons that are all about that key:

- it ignores `restart: unless-stopped`, so a crash cannot loop through a
  mint-then-die cycle;
- it allocates a TTY, and Node's writes to a TTY are synchronous — writes to a
  **pipe** are not, and `process.exit()` does not flush them, so a `console.log`
  shortly before an `exit(2)` can be lost from `docker logs` entirely;
- `--rm` deletes the container *and its log*, so the key never lingers in
  `/var/lib/docker`. That is strictly better than the launchd path, where
  `install.sh` has to scrape the key back out of a log it then `chmod 600`s and
  warns you to redact.

Save it before Ctrl-C, with `umask` around the write rather than `chmod` after
it — the redirect would otherwise create the file 0644 with the fleet's admin key
already in it:

```sh
( umask 077
  printf "REEMOAT_CP_URL='http://127.0.0.1:7888'\nREEMOAT_CP_KEY='rk_…'\n" \
    > ~/.reemoat/cpctl.env )
```

Then Ctrl-C and `deploy/compose.sh up -d`.

One hazard the container **removes**, worth knowing because it inverts a
documented trap: every configuration check in `main.ts` — port ranges, the relay
URL, port equality, the TTL floor, opening the database — happens *above* the
bootstrap block, and the only failure below it is the relay listener's
asynchronous `EADDRINUSE`. In a namespace nothing else is on that port, so a
host-side conflict is detected by the engine at container create, before node
runs at all, with `users` still empty and nothing minted.

One hazard it **adds**: `deploy/compose.sh down` deletes the container's log
while the volume keeps the user that makes the key unmintable. A launchd log file
outlived the process; this does not. `~/.reemoat/cpctl.env` is the durable copy,
not a second one.

## State

A named volume, `reemoat-cp-state`, not a bind mount of `~/.reemoat`. Three
reasons, and the second is the one that would degrade silently:

1. On Linux a bind mount preserves host ownership and this image runs as uid 1000
   — so any host user whose uid differs gets `EACCES` creating the database, on
   the only kind of host a control plane is meant to live on. macOS papers over
   ownership, so it would work on the development machine and fail on the
   deployment target.
2. `store.ts` chmods the directory 0700 and the file 0600 and **tolerates failure
   on both, silently** — "a filesystem without POSIX modes is not a reason to
   refuse to start". A mount that cannot hold modes therefore leaves the fleet's
   signing key at whatever the sharing layer decided.
3. `store.ts` opens with `PRAGMA journal_mode = WAL` and *throws* if it does not
   take. WAL needs a shared-memory mapping of a `-shm` file beside the database,
   which is exactly the operation with a history of not working over virtiofs.

The cost, stated because it is real: **on macOS the database is inside the VM.**
It is no longer at `~/.reemoat/control-plane.db`, Time Machine does not see it,
and `pnpm cp` on the host cannot open the same file. Back it up with SQLite's own
consistent snapshot rather than by tarring a live WAL:

```sh
deploy/compose.sh exec control-plane node -e \
  "const {DatabaseSync}=require('node:sqlite');
   new DatabaseSync('/var/lib/reemoat/control-plane.db',{readOnly:true})
     .exec(\"VACUUM INTO '/tmp/backup.db'\")"
deploy/compose.sh cp control-plane:/tmp/backup.db ./cp-backup-$(date +%F).db
chmod 600 ./cp-backup-*.db
```

That file is the key that signs every token in the fleet. Put it where you would
put a signing key.

## Migrating an existing control plane

A daemon records `machine_id`, `issuer`, `keys_json`, `tunnel_key` and
`relay_url` at enrollment and **never refreshes any of them**. So four things
must survive the move or every enrolled daemon stops working and all of them need
re-enrolling: the database file itself, `REEMOAT_CP_ISSUER`,
`REEMOAT_CP_RELAY_URL`, and the address and port the relay is reachable at.

**Step 0, before touching anything: prove you hold an admin key.** After the
cutover the database is non-empty, so no key is printed, and if you hold none the
only way back is deleting the database — which destroys the signing key and
un-enrolls the fleet. `~/.reemoat/cpctl.env` is where `install.sh` would have
put one; the web UI keeps one in `localStorage`. Confirm with a 200 from
`cpctl admin users`, and write it into `cpctl.env` at 0600 while you are there.

1. `deploy/compose.sh build` — while the old service still runs. Nothing is
   committed.
2. `cp ~/.reemoat/control-plane.db ~/.reemoat/control-plane.db.pre-docker` and
   `chmod 600` it. This is the rollback.
3. Stop the old service *properly*: `launchctl bootout
   gui/$(id -u)/com.reemoat.control-plane`, or `systemctl --user stop`. Not a
   kill — the plist has `KeepAlive` and `ThrottleInterval 10`. Two control planes
   on one database is the worst state available. Verify with `lsof -nP
   -iTCP:7888,7889 -sTCP:LISTEN` returning nothing.
4. Confirm the WAL checkpointed: `control-plane.db-wal` should be 0 bytes after a
   clean stop. If it is not, copy it alongside the `.db`; never copy `-shm`.
5. Load the volume, and **chown it** — a root-owned copy makes `store.ts` exit 2
   at "could not open … Set REEMOAT_CP_DB to a writable path":

   ```sh
   docker volume create reemoat-cp-state
   docker run --rm -v reemoat-cp-state:/state -v "$HOME/.reemoat:/src:ro" \
     node:24-slim sh -c 'cp /src/control-plane.db /state/ \
       && chown 1000:1000 /state/control-plane.db \
       && chmod 600 /state/control-plane.db && chmod 700 /state'
   ```
   From here on every `deploy/compose.sh` command prints `volume
   "reemoat-cp-state" already exists but was not created by Docker Compose`.
   That is expected on a migrated host — you created the volume by hand in this
   step — and its suggested fix (`external: true`) must not be taken, because it
   would make compose refuse on every *fresh* install instead.
6. `deploy/compose.sh up -d`, then **check the signing kid first**:
   `deploy/compose.sh logs | head` against what the old service printed. A
   different `signing key:` means the database did not carry and you are one
   restart from an un-enrolled fleet. Then `/health`, then `cpctl admin machines`
   for the same machine ids, then the daemon's own log for its tunnel
   reconnecting, then the UI on a phone.

Rollback, and it has two steps people miss. The old unit's `ExecStart` is
`deploy/run-cp.sh`, which this change **deleted** — so going back means checking
the tree out first: `git checkout <pre-docker-sha>`. And the database in the
volume is owned by uid 1000; copying it back out leaves it owned by that uid, so
on a host whose operator is not 1000 the native service exits 2 on open. In full:

```sh
deploy/compose.sh down
docker run --rm -v reemoat-cp-state:/state -v "$HOME/.reemoat:/out" \
  node:24-slim sh -c 'cp /state/control-plane.db /out/control-plane.db'
chown "$(id -u):$(id -g)" ~/.reemoat/control-plane.db
chmod 600 ~/.reemoat/control-plane.db
git -C <repo> checkout <pre-docker-sha>
# then bootstrap the old unit
```

The `control-plane.db.pre-docker` snapshot from step 2 is the other way back, and
it is correctly owned already — at the cost of whatever happened while the
container was serving.

## Two things worth knowing before choosing a host

**A clock boundary appears on macOS and not on Linux.** Tokens live 300s with 60s
of leeway, and `/health` returns `time` precisely because "short-lived tokens make
skew a real way to be locked out". Native, the control plane and the daemon share
one clock. In a VM they do not, and a Mac sleep/wake is where that shows up: every
daemon rejects every token and nothing says why. On Linux the container shares the
host clock and this does not exist.

**`x-forwarded-for` degrades to a constant.** With the userland proxy — the
default, and the only option on macOS — every client appears as the bridge
gateway. `app.ts` calls this "best effort, for the audit trail only. Never used
for a decision", so nothing breaks; but the audit trail stops distinguishing
clients, and the header the daemon receives becomes a lie rather than absent. On
Linux, `"userland-proxy": false` restores real source addresses.
