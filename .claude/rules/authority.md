---
paths:
  - packages/control-plane/src/app.ts
  - packages/control-plane/src/main.ts
  - packages/control-plane/src/store.ts
  - packages/control-plane/src/schema.sql
---

<!--
⚠ `docs/AUTHORITY.md` is deliberately **not** in the globs above. `docscheck`
matches them against a corpus walked from `SOURCE_DIRS`, which does not include
`docs/` — so naming a file there would be a dead glob and a red build, which is
that assertion working rather than a limitation to route around. This rule loads
on the files somebody is editing when they need it; the document is the thing it
points at.
-->


# The Authority, and the line it may not cross

`packages/control-plane` is the **Authority**: who somebody is, which devices they
signed in from, which machines exist, who owns them, and who may reach them. It is
not where the work is. `docs/AUTHORITY.md` is the document; this is the rule.

**The directory keeps its name.** Renaming it to match the role would touch the
Dockerfile and its `.dockerignore` twin, `RELAY_INPUTS`, `compose.yml`, every
deploy script, a dozen `paths:` globs and every relative import in two packages —
the blanket sweep `CLAUDE.md`'s `remoslop` warning is about, for no behaviour.
What changed is that the boundary is **checked** rather than believed.

## What may not arrive here

Agents, conversations, prompts, responses, diffs, worktrees, source, shell,
running processes, approvals, plugins. Each of those is the daemon's, on the
machine it belongs to.

⚠ **The reason is not tidiness, and it is worth being able to state.** A daemon
verifies tokens against a public key it captured once at enrollment and never asks
this service anything again (Q1.9, Q1.10), so an Authority that is down stops new
sign-ins and stops nothing already running — a property that survives exactly as
long as nothing running *needs* a read from here. And this process holds the
Ed25519 key that mints every token in the fleet; what it must not also hold is
anybody's source.

**Three lightweight facts it does keep, named so the next idea can be measured
against them**: tunnel presence (`relay_tunnels`, `machine_last_seen`), what a
daemon announced about itself on the handshake (`machines.daemon_*`), and mail
waiting to go out. Each is about *reachability* or is this service's own. A
session title, a transcript index, a file listing or a count of turns would not
be — each reads as convenient and each ends with somebody's work in the process
that holds the signing key.

## The two ratchets

In `relaycheck`, under **"what the Authority may reach"**. They compare against
what the tree already is, so widening either is a diff rather than a discovery.
Neither is a security boundary and neither pretends to be — `plugins.md` makes the
same disclaimer about `manifest.scopes`.

1. **Imports.** `packages/control-plane/src/**` reaches the repository root for
   exactly five files: `src/{token,auth,cors,http}.js` and `src/relay/protocol.js`.
   ⚠ **That list is also `deploy/docker/Dockerfile`'s COPY lines**, which is what
   keeps the two from drifting — a sixth import is a change to both, or an image
   that passes every offline driver and fails at runtime inside a container. A
   negative control asserts nothing under `src/session`, `src/registry`,
   `src/acp/` or `src/runtime/` is in it.
2. **Route paths.** No path names `sessions`, `prompts`, `agents`, `worktrees`,
   `files`, `diffs` or `events`. ⚠ **The four `/v1/me/sessions` routes are the
   exception and are *named* rather than pattern-matched around**: a sign-in is a
   credential with an expiry, which is precisely this service's business, and it
   collides with the daemon's *agent session* on one English word. Listing them is
   what keeps `/v1/sessions` refused — the exemption is strings somebody would
   have to add to, on a line that says what it is.

**`packages/control-plane` may import from `src/`; nothing in `src/` may ever
import from it.** The dependency points one way and always has.

## The Authority serves the gate, and never the app

Nine addresses, from `packages/web/dist-gate`, by this same process: the five gate
screens, the three legal documents, and `/app`. **Not an SPA fallback** — a closed
list, so `/` and every address belonging to the app answer the error envelope, and
the product is not in the image at all.

⚠ **The gate has no off switch, deliberately.** `/confirm`, `/reset` and
`/verify` are opened by a *mail client*, and `POST /v1/forgot` is the only remedy
this service has for a forgotten password — so a variable that could disable these
would be a variable that breaks account recovery. `main.ts` resolves the directory
and nothing reads an environment value for it.

⚠ **There is no variable that serves the app, and `REEMOAT_CP_WEB` is deleted.**
It named a built copy for a checkout or a mounted directory to serve. A browser
holds no device key, so it cannot open an encrypted channel to a daemon — it could
load the app and reach no machine at all, which is worse than not offering it.
The Reemoat app compiles `packages/web` into its own binary and never downloads
one. The gate is the only bundle, and it is served with no switch.

`REEMOAT_CP_INSTALL` is the one variable of that shape left — *either* a boolean
*or* a path — and `deploycheck` reads its three spellings of **off** and three of
**the default** off `main.ts`. It has a default to mean because
`deploy/bootstrap.sh` really is in the image; the deleted one did not, which is
why `=1` resolved to a directory called `1` and 404ed for ever.

⚠ **`mail.public_url` must name whatever serves the gate.** Every confirmation,
reset, verify and invitation link is built from it and opened by a *mail client*,
so pointed at something that does not answer those nine addresses they land on the
error envelope — with `POST /v1/forgot` being the only remedy this service has for
a forgotten password. `mailConfigured` reports it as a **non-blocking** problem,
worded without the words *"is not set"* because `isMissing` keys on those and a
sentence carrying them would stop the instance sending mail at all. The comparison
needs the API's own origin, which is a property of the *request* rather than of
this process, so `GET /v1/admin/settings` is the one caller that can make it. It
passes one only while this process serves no gate bundle (`servesGate` in `app.ts`),
since a control plane serving its gate is where the links belong.

And the gate itself takes a **pasted link or code**, which is the remedy for the
other half of the same problem: a mail client that rewrites the URL and drops the
`#` the token rides on.

## Migrations

**`migrate()` may only add, and `CP_SCHEMA_VERSION` may not move for an
addition.** A nullable column an older build never selects is invisible to it, so
yesterday's image still starts against today's database. Bumping the version makes
`checkSchemaVersion` refuse the file, `main.ts` exit 2, and the unit restart into a
crash loop that takes the relay — and the whole fleet's reachability — with it.

⚠ **Each table this function touches needs its own `table_info` reader.** Reaching
for `has()`, which asks `machines`, is the wrong-table bug this function already
records shipping once: the guard is then false for ever, the `ALTER` is attempted
on every open by both processes rather than once, and the only thing between that
and `exit(2)` is `addColumn`'s duplicate-name clause — measured as a **one-shot**
window and not a licence to re-roll the race at every restart.

⚠ **An index over a migrated column cannot live in `schema.sql`.** That file runs
*before* this function, so an index naming a column migrate has not added yet
fails with `no such column` against every database that already exists.
`idx_user_sessions_device` is that index, in `migrate()` one statement after its
`ALTER` — and it is why `deploycheck` allows a third statement shape here,
`CREATE INDEX IF NOT EXISTS`, named explicitly rather than by loosening to a
wildcard.

⚠ **`deploycheck` reads this function's whole body, comments included, and refuses
the two destructive keywords anywhere in it.** Prose has to route around them too.
