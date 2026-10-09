---
paths:
  - src/version.ts
  - src/relay/protocol.ts
  - packages/control-plane/src/store.ts
  - packages/control-plane/src/schema.sql
  - packages/web/src/wire.ts
  # The frame table, for the open question at the bottom of this file: it is the
  # one vocabulary in the tree spoken between two independently shipped artifacts,
  # and the section only does its job if it arrives when somebody opens the file
  # they are about to add a frame type to.
  - packages/protocol/src/frames.ts
---

## What may skew from what

Four things ship on four schedules, and nothing coordinates them:

| Ships | When | Says what it is |
|---|---|---|
| control plane + relay | weekly, from a tag | `VERSION` in `app.ts`, on `GET /v1/instance` |
| **the app** | **whenever its owner installs a build**; the whole client is in the native binary and it downloads no interface | nothing |
| a daemon | whenever its owner runs `deploy.sh` | `DAEMON_VERSION` on the tunnel handshake and `GET /health`; `AGENT_CLIS_HEADER` on the handshake only |
| **an agent CLI** | **whenever `deploy/agents.sh` runs, daily, unattended** | nothing; the daemon announces it |

**Nobody can push a client, and that decides the rest.** The control plane's image carries
`dist-gate` alone, so the app and the daemons each move on their owner's schedule: **skew runs
in either direction with no bound**, a months-old app against this morning's daemon being
ordinary. Rule 2 is what survives it. The one unsurvivable skew is the relay protocol's (a
daemon that cannot dial in has no second door): rule 1's range, and rule 4's inventory.

**The daemon still asks the control plane nothing** (Q1.9, Q1.10): everything below is
announced on a connection it opens anyway or read off a reply it already gets. `src/` holds
three `fetch` calls, each named in `plugins.md`, and that count is the property.

**Updating a daemon is its owner's act**: never self-updated, told to update or sent a version;
`deploy/deploy.sh` on the host is the mechanism and fleet rollout is a non-goal (Q7.42). The
daemon *reports* what it is; `cpctl admin fleet` is a report, and a verb that acts on a machine
would have to argue with Q7.42.

## The four rules

**1. A version is negotiated or it is a label. Never both.**
`RELAY_PROTOCOL_VERSION`/`RELAY_PROTOCOL_MIN_VERSION` are a **range**;
`negotiateProtocolVersion` takes the newest both ends know, so a daemon ahead is negotiated down
and one behind works until the floor is deliberately raised. `DAEMON_VERSION` is a label,
**branched on by nothing**, or every daemon is back in lockstep with the control plane.
`relaycheck` asserts the negotiation both ways, including a daemon predating the header.

**The `wire.ts` mirror is swept, field for field**, since a field missing there compiles on
both sides and is `undefined` at runtime. `webcheck` compares every interface in
`wire.ts` **whose daemon declaration is in a file the sweep reads**; a mirrored type from an
unlisted file hits the sweep's `continue` and is never compared, so a mirrored type from a new
daemon file means adding that file to the source list. It asserts **`daemon ⊆ client`, never
equality**: a field added after the first release is optional here, since an older daemon omits
it. Currently 71 with a floor of 64 that moves with the corpus. The reader anchors names (`Me`
must not match `MemoryEventStore`), resolves `extends`, refuses an `extends` it cannot find, and
keeps a negative control (a bare prefix such as `Session` matches nothing). Its depth counter
(nested objects) and paren counter (parameter lists) are separate properties, each driven on a
fixture where it alone holds.

**2. An unknown value fails toward "keep working".** `wire.ts` is a hand mirror allowed to be
behind, so every narrowing degrades rather than throws. `endedWithDaemon` asks "is this a
*final* reason?", so an unknown reason keeps `Composer.tsx`'s composer. `reemoat-enc` on the
tunnel likewise: an unrecognised value refuses one *stream*, never the tunnel. The one flag day
taken: `RELAY_PROTOCOL_MIN_VERSION` went straight to 2, the version on which every stream is
encrypted, since no range spans plaintext and ciphertext. Q7.143.

**3. The control plane's schema grows and never changes shape.** `applyControlPlaneSchema` is
schema + `checkSchemaVersion` + `migrate`, in that order, and **`migrate()` may only add**.
`CP_SCHEMA_VERSION` does not move for an addition (an older build never selects a new nullable
column), so yesterday's image still starts on today's database. Bumping it makes
`checkSchemaVersion` refuse, `main.ts` exit 2, and the unit crash-loop with the relay and the
fleet's reachability. **A rollback must not break everything else.** Drivers build their
databases through that function, never `exec(readFileSync(schema.sql))`.

**One rollback re-opens what was closed: the relay's, past 0.12.0.** A link capability lives 90
days and is revoked by the relay reading `machine_links` at every connection (Q7.150); an older
relay ignores `lnk`, so every revoked link connects again until expiry (a daemon's own policy
still refuses where delivered). Switch agent messaging off on each account first. That release
also adds a fifth skew, **daemon to daemon** over `/peer/*`: no later daemon may drop a field
those parsers require.

**4. Raise a floor only against the inventory.** `cpctl admin fleet` / `GET /v1/admin/fleet`
report what every machine last dialled in as, offline ones included, off the handshake.

**The agent CLIs ride the same surface, under rule 1's label half** (Q1.628).
`AGENT_CLIS_HEADER` (`claude=2.1.259;codex=0.153.1;kimi=-`) names the build of each built-in
harness's CLI a launch would resolve (the same `agentCli`). The relay records it in
`machines.daemon_agents` on dial; the fleet route answers it parsed as `agents` (harness →
version, `null` for a binary that would not say); `cpctl admin fleet` prints it. **Announced,
never negotiated, optional on the reader**: an older daemon, a value `parseAgentClis` refused
(**whole** to `null`, never cut), and a daemon with no CLI at all (no header, never an empty
one) are one silence on purpose. **Exactly as fresh as the last dial**: the daily update clears
the ten-minute CLI cache and does not redial, which would drop every live stream; a machine's
live answer is `GET /agents/capabilities`. Nothing here moves a CLI.

## Which side ships first

**Whoever *answers* ships first; whoever *asks* ships second.** One rule, two orders:

| The change | Who answers | Ships first |
|---|---|---|
| A new relay protocol version | the relay, on the handshake | **control plane** |
| A new daemon route (`/plugins`, …) | the daemon | **the daemons** |
| **A new route or field the app will ask a daemon for** | the daemon | **the daemons** |
| **A new field the app reads off the control plane** (`machine.key`, `legal.documents`, …) | the control plane | **control plane** |

An app asking for what no daemon answers yet degrades (rule 2) but offers every user a feature
answering *"update your machine"*, for as long as **that app build is installed**, a window
nobody here can close. Tolerating skew is not electing it. Where both apply, the protocol half
forces control-plane-first: a daemon that cannot dial in at all beats a screen with a sentence.
Q4.105.

## Making a breaking change, in order

Q7.71's shape, *accept-both first, send-new second*:

1. Ship a control plane whose relay **accepts** the new protocol version and the old (`MIN`
   unchanged, `VERSION` raised).
2. Ship a daemon that **offers** it; it negotiates down, so release order is free.
3. Watch `cpctl admin fleet` until nothing is below the new version.
4. Only then raise `RELAY_PROTOCOL_MIN_VERSION`, which cuts off whatever is left.

## The open question: the inner frame protocol has no version between its two ends

**`packages/protocol/src/frames.ts` is spoken between the app and the daemon, which ship
independently, and nothing on the wire versions it.** `STREAM_ENCRYPTION_NOISE_IK`
(`noise-ik-25519-chachapoly-blake2s/1`) versions the suite and the framing together, but the
**relay** stamps it (`relay/proxy.ts`) from the control plane's build, and the daemon answers an
unknown value with a 501 on that stream: it versions relay ↔ daemon. The app never sends it.

**An unknown frame type is fatal in both directions**: `src/e2ee.ts` answers
`fail(400, "unexpected frame N")`, `packages/web/src/e2ee.ts`'s `default:` arm
`fail(new Error(...))`. Right at this layer: a frame is a length and a body, and skipping one
you cannot parse loses the stream's boundaries.

**Not decided, and this file does not decide.** Nothing is broken: the union has only grown and
never lost a member. **Do not invent a negotiation on the strength of this section**; rule 1
constrains any answer.

## What is still a flag day, and is not fixed here

- **A daemon too old to take a key-set statement is darkened by `retirekey`**, and only by
  that: the oldest active key signs (`tokenSigningKey`), so `rotatekey` publishes and changes
  nothing for anybody, and a daemon new enough takes the statement on its dial or within a
  ping. `cpctl admin fleet` shows who has been offered it (`daemon_keyset`), and the retire
  is refused while one dialled in has not been, unless forced. Q1.659.
- **The token header is exact**: `alg` `EdDSA`, `typ` `reemoat+jwt`, compared first. Unknown
  claims are ignored; changing either header field breaks every daemon at once.
- **`REEMOAT_CP_RELAY_URL` is captured at enrollment**: changing it re-enrolls every machine
  (Q1.23, Q7.92).
