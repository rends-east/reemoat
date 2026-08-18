---
paths:
  - src/version.ts
  - src/relay/protocol.ts
  - packages/control-plane/src/store.ts
  - packages/control-plane/src/schema.sql
  - packages/web/src/wire.ts
---

## What may skew from what

Three things ship on three schedules, and nothing coordinates them:

| Ships | When | Says what it is |
|---|---|---|
| control plane + relay | weekly, from a tag | `VERSION` in `app.ts`, on `GET /v1/instance` |
| **the web client** | **with the control plane** — it is built into that image | nothing |
| a daemon | whenever its owner runs `deploy.sh` | `DAEMON_VERSION`, on the tunnel handshake and `GET /health` |

**The web client shipping inside the control plane's image is the fact that
decides everything else here.** A weekly deploy hands a new browser client to
every user at once, while their daemons stay wherever they were. So *new client
against old daemon* is not an edge case, it is the normal state of the fleet
between Tuesday and whenever somebody updates their laptop. The rarer direction —
a tab left open across a daemon update — is the one that was destructive.

**The daemon still asks the control plane nothing** (Q1.9, Q1.10). Everything
below is announced on a connection the daemon opens anyway, or read off a reply it
was already getting. Nothing here adds a request, and nothing may — `src/` holds
exactly one `fetch`, in `enroll.ts`, and that count is the property.

⚠ **Updating a daemon is its owner's act, and nothing here is a step toward
changing that.** A daemon does not update itself, is not told to update, and is
never sent a version to move to; `deploy/deploy.sh` on the host is the whole
mechanism, and fleet rollout is a stated non-goal (Q7.42). What the version
carries is the opposite direction — the daemon *reports* what it is, so a person
deciding whether a change is safe can see the fleet instead of guessing. `cpctl
admin fleet` is a report. If it ever grows a verb that acts on a machine, that is
a different decision than this one and Q7.42 is what it has to argue with.

## The four rules

**1. A version is negotiated or it is a label. Never both.**
`RELAY_PROTOCOL_VERSION`/`RELAY_PROTOCOL_MIN_VERSION` are a **range**, and
`negotiateProtocolVersion` takes the newest both ends know — so a daemon ahead of
the relay is negotiated *down* and one behind keeps working until the floor is
deliberately raised. `DAEMON_VERSION` is the label: recorded, reported, and
**branched on by nothing**. The moment anything behaves differently for `0.1.0`
than for `0.2.0`, every daemon is back in lockstep with the control plane, which
is the thing the range exists to prevent.

⚠ This was `!==` and therefore a **flag day**: a relay moved to v2 refused every
v1 daemon, and the relay is the only way in, so that is not degradation, it is the
fleet switched off until the last machine is touched by hand. `relaycheck` asserts
the negotiation in both directions, including a daemon that predates the header
entirely.

**2. An unknown value fails toward "keep working".** The client is allowed to be
behind the wire — `wire.ts` is a hand mirror and says so — so every narrowing in
it degrades rather than throws. The one that was wrong was `endedWithDaemon`,
which asked "is this a daemon reason?" and answered *no* for a reason it had never
heard of: the session fell into `showsAsEnded` and `Composer.tsx` **took the
composer off the screen for a conversation that was coming back**. It asks "is
this a *final* reason?" now, so an unknown one keeps the composer. Same shape as
`reemoat-enc` on the tunnel: an unrecognised value is one refused *stream*, never
a dropped tunnel.

**3. The control plane's schema grows and never changes shape.**
`applyControlPlaneSchema` is schema + `checkSchemaVersion` + `migrate`, in that
order, and **`migrate()` may only add**. `CP_SCHEMA_VERSION` does not move for an
addition — a nullable column an older build never selects is invisible to it, so
yesterday's image still starts against today's database. Bumping it makes
`checkSchemaVersion` refuse the file, `main.ts` exit 2, and the unit restart into
a crash loop that takes the relay and the whole fleet's reachability with it. **A
rollback is what you do when a release is broken; it must not be the thing that
breaks everything else.**

⚠ Every driver used to build its database with `exec(readFileSync(schema.sql))`
and nothing else — eight sites in `relaycheck` alone — which tested a schema
production never has. That is why applying the schema is a function now.

**4. Raise a floor only against the inventory.** `cpctl admin fleet` /
`GET /v1/admin/fleet` report what every machine last dialled in as, offline ones
included, because the machine that decides whether `RELAY_PROTOCOL_MIN_VERSION`
can move is the one that has been dark for a month. The numbers come off the
handshake, not from asking a daemon anything.

## Making a breaking change, in order

Q7.71 wrote this shape down before there was any mechanism for it — *"accept-both
first, send-new second, with every host updated in between"*. There is now:

1. Ship a control plane whose relay **accepts** the new protocol version and still
   accepts the old (`MIN` unchanged, `VERSION` raised).
2. Ship a daemon that **offers** the new one. It negotiates down against relays
   that have not moved, so it is safe to release in any order.
3. Watch `cpctl admin fleet` until nothing is below the new version.
4. Only then raise `RELAY_PROTOCOL_MIN_VERSION`, which is the act that cuts off
   whatever is left.

## What is still a flag day, and is not fixed here

- **`cpctl admin rotatekey` darks every enrolled daemon.** A daemon captures the
  key set once at enrollment and never asks again, and `activeSigningKey` signs
  with the **newest** — so a mint immediately produces tokens whose `kid` no
  existing daemon holds. `schema.sql` and `keys.ts` both describe an overlapping
  rotation ("publish both, retire later"); the publishing half is real and the
  signing half is not. Rotation therefore still means re-enrolling every machine
  by hand. Not changed here because which key signs is a security decision, not a
  compatibility one.
- **The token header is exact.** `alg` must be `EdDSA` and `typ` must be
  `reemoat+jwt`, compared before anything else. Claims are additive-safe — an
  unknown one is ignored — but changing either header field breaks every deployed
  daemon at once.
- **`REEMOAT_CP_RELAY_URL` is captured at enrollment.** Changing it costs a
  re-enrollment of every machine (Q1.23, Q7.92).
