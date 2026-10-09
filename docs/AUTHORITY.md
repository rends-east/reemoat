# The Authority

One service holds *who somebody is and what they may reach*. Every other service
holds *the work*. This document is that division, what each side owns, and what
stops the line moving by accident.

The service is `packages/control-plane`. **The directory keeps its name**, which
is worth saying first: renaming it would touch the Dockerfile and its
`.dockerignore` twin, `RELAY_INPUTS`, `compose.yml`, every deploy script, a dozen
`.claude/rules/` globs and every relative import in two packages — the exact
blanket sweep `CLAUDE.md`'s `remoslop` warning is about, for no behaviour. What
this document adds is not a name. It is that the boundary is now **checked**.

## Who holds what

| | The Authority | A daemon |
|---|---|---|
| Users, passwords, sessions | ✅ | — |
| **Devices** — the installations somebody signs in from | ✅ | — |
| Machines, enrollment, ownership, grants | ✅ | — |
| The Ed25519 key that signs every token in the fleet | ✅ | — |
| Agents, and the CLIs they run | — | ✅ |
| Conversations, prompts, responses, diffs | — | ✅ |
| Worktrees, source, shell, running processes | — | ✅ |
| Approvals, permissions, elicitations | — | ✅ |
| Plugins and what they keep | — | ✅ |

The relay is a fourth thing and is neither: it moves bytes for a caller the
Authority has already vouched for, and parses none of them. `.claude/rules/relay.md`
is its area.

## Three properties this division buys

**An outage here cannot reach work already running.** A daemon verifies tokens
against public keys it already holds and never asks this service anything —
`.claude/rules/auth-and-tokens.md` states it as an invariant and `src/enroll.ts` is
the one and only request a daemon ever makes. A later key set is *announced* on the
tunnel dial, signed by a root the daemon pinned, and one that is absent or refused
changes nothing (`src/keyset.ts`). So an Authority that is down stops new sign-ins,
new tokens and new machines, and stops nothing that is already open.

**Nobody's source is in the same process as the fleet's signing key.** That key
mints every token in the fleet and lives in one SQLite file, 0600 inside a 0700
directory, wrapped under `REEMOAT_CP_KEY_SECRET` where one is set. What it must not
also hold is anybody's work.

**The reachability cost is paid knowingly.** The relay is permanently on the data
path, so an outage here costs *all* reachability to remote machines — Q1.24. The
desktop app reaching a daemon on the same computer over loopback is the one
exception, and `.claude/rules/relay.md` bounds it with four rules.

## What holds the line

⚠ **Two ratchets in `relaycheck`, under "what the Authority may reach".** They
compare against what the tree already is, so widening either is a diff rather than
a discovery.

1. **What it imports.** `packages/control-plane/src/**` reaches the repository
   root for exactly five files — `src/{token,auth,cors,http}.js` and
   `src/relay/protocol.js` — all of them wire vocabulary. The same five are what
   `deploy/docker/Dockerfile` COPYs into the runtime stage, which is what stops
   the two lists drifting; a sixth import is a change to both, or an image that
   fails at runtime inside a container. Anything under `src/session`,
   `src/registry`, `src/acp/` or `src/runtime/` is refused by construction.
2. **What it answers.** No route path names an agent's work — no `sessions`,
   `prompts`, `agents`, `worktrees`, `files`, `diffs` or `events`. The four
   `/v1/me/sessions` routes are named as the exception rather than pattern-matched
   around: a *sign-in* is a credential with an expiry, which is precisely this
   service's business, and it collides with the daemon's *agent session* on one
   English word and nothing else.

Neither is a security boundary and neither pretends to be — `plugins.md` makes the
same disclaimer about `manifest.scopes`. What they buy is that the shape stays
legible, which for a division of responsibility is the whole of what a check can
buy.

**`packages/control-plane` may import from `src/`; nothing in `src/` may ever
import from it.** The dependency points one way and always has.

## Lightweight facts the Authority does keep

Three things look like work and are not, so they are named rather than left to be
argued about:

- **Tunnel presence.** `relay_tunnels` and `machine_last_seen` — whether a machine
  is connected and when it last was. Written by the relay, read to answer "is this
  machine online". No content, and `relay.md` explains why only the *fact* of a
  connection is writable at all.
- **What a daemon reports about itself.** `machines.daemon_version`,
  `daemon_protocol`, `daemon_agents` — announced on the tunnel handshake, never
  asked for. `cpctl admin fleet` is what reads them, and it is a report:
  `compatibility.md` states that nothing here ever acts on a machine.
- **Mail waiting to go out.** A registration link is this service's own.

What would be over the line, stated so the next idea can be measured against it: a
session title, a transcript index, a file listing, a count of turns. Each reads as
convenient, and each ends with somebody's work in the process that holds the
signing key.

## Clients

**The Reemoat app is the production client** and reaches this service as an
ordinary API client — `packages/native` compiles `packages/web` into its binary
and never downloads one.

**A browser reaches the gate, and only the gate.** Nine addresses served by this
same process: the five sign-up and recovery screens, the three legal documents,
and `/app`, the page that hands somebody over to the app. Not a separate service —
same port, same container — and not an SPA fallback: the list is **closed**, so
`/` and every address belonging to the app answer the error envelope, and the
product is not in the image to be served at all.

The gate is here because its flows have nowhere else to begin: `/confirm`,
`/reset` and `/verify` are opened by a **mail client**, in a browser, and
`POST /v1/forgot` is the only remedy this service has for a forgotten password.
That is also why it has no off switch — a variable that could disable it would be
a variable that breaks account recovery.

⚠ **Nothing serves the app, and there is no variable that would.** A browser holds
no device key, so it cannot open the encrypted channel a daemon is reached through —
it could load the client and reach no machine at all, which is worse than not
offering it. `docs/API.md` has the shape; Q1.649 is the decision.

Authentication is a bearer token and **never a cookie**: `src/cors.ts` answers
`Access-Control-Allow-Origin: *` and deliberately never sends
`Access-Control-Allow-Credentials`, and that wildcard is only safe while no
credential is ever ambient. There is nothing browser-shaped in the auth model to
undo for a native client.

## Users, devices, machines, grants

```
user ──< device        one person, several installations
user ──< machine       ownership, and the label they call it
user ──< grant >── machine    who may reach what
```

**A grant is `(user, machine)` and stays that way.** A device authenticates *as* a
user and is never an authorization subject, so every device of one person reaches
exactly the same fleet — which is the requirement, and is why
`relay/authorize.ts` reads no device row. `.claude/rules/cp-devices.md` carries
what that costs and what it buys.

**A grant is full access to the machine.** There is one person's work on a machine
and anybody granted it sees all of it. That is the whole authorization model, not
a footnote.
