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
| **the app** | **whenever its owner installs a build** — the whole client is compiled into the native binary, and it downloads no interface, ever | nothing |
| a daemon | whenever its owner runs `deploy.sh` | `DAEMON_VERSION`, on the tunnel handshake and `GET /health` — and which build of each agent CLI it would launch, `AGENT_CLIS_HEADER`, on the handshake only |
| **an agent CLI** | **whenever `deploy/agents.sh` runs — daily, by the daemon, with nobody pressing anything** | nothing of its own; the daemon announces it beside its version |

**Nobody can push a client any more, and that is the fact that decides everything
else here.** It used to ride the control plane's image (`dist` in the Dockerfile,
`REEMOAT_CP_WEB` to point at one), so a weekly deploy handed a new client to every
user at once while their daemons stayed wherever they were: skew ran **one way**,
*new client against old daemon*, and it was the normal state of the fleet between
Tuesday and whenever somebody updated their laptop. That is gone. The image carries
`dist-gate` alone — sign-up, the mailed-link screens, the legal documents and the
handoff page — and the app is a binary somebody installs.

So **both ends now move on their own owner's schedule, skew runs in either
direction, and neither direction has a bound on it.** The direction that used to be
nearly impossible is the ordinary one now: a months-old app against a daemon updated
this morning, because the person who updated the daemon is the same person who has
not opened the app's updater. It is exactly what rule 2 was written for — an unknown
value must fail toward *keep working* — with the difference that there is no longer a
weekly deploy quietly retiring the oldest clients in the fleet. ⚠ The one skew that
is still *not* survivable is the relay protocol's, because a daemon that cannot dial
in has no second door; that is rule 1's range, and raising its floor is rule 4's
inventory.

**The daemon still asks the control plane nothing** (Q1.9, Q1.10). Everything
below is announced on a connection the daemon opens anyway, or read off a reply it
was already getting. Nothing here adds a request, and nothing may — `src/` holds
three `fetch` calls, each named in `plugins.md`, and that count is the property.

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

**The mirror is swept, field for field, and until recently nothing swept it.**
`webcheck` compared the four plugin *unions* — a union member is a value that
turns up in a `switch` — and compared no **interface** at all. A field added to
`SessionSnapshot` on the daemon and not copied into `wire.ts` compiles on both
sides, ships, and is `undefined` at runtime on the screen that reads it. The sweep
is over every interface declared in `wire.ts` **whose daemon declaration lives in
one of the files the sweep reads** — not simply every interface declared in both:
a mirrored type from a file absent from that list hits the sweep's `continue` and
is never compared, which has now swallowed a feature four times. Adding a mirrored
type from a new daemon file means adding that file to the source list. Currently 54
with a floor of 52 that `webcheck` moves *with* the corpus, and asserts **`daemon ⊆
client`, never equality**: a field added after the first release is *optional* on
this side on purpose, because an older daemon does not send it. What is refused is
the client knowing *less* than the daemon says. ⚠ Its first run reported two
drifts and both were the sweep's own bugs — a prefix match (`Me` against
`MemoryEventStore`) and `extends` it did not follow. A checker that cries wolf is
turned off in a week, so it anchors the name and resolves inheritance, and the
count has a floor under it: finding nothing to compare must not read as finding no
drift. Two more, both from the same argument: an `extends` naming something the
reader cannot find is a **refusal**, never a silent shortfall — an interface that
reads as smaller than it is makes the sweep compare fewer fields and report no
drift about the half it could not read. And the anchor has a **negative control**:
a name that is only a prefix of real declarations must match nothing, beside an
assertion that the real one still reads. Without it, "the anchor works" is a
belief — unanchored, `Session` returns `SessionResumeState`'s fields and every
other line here passes anyway. ⚠ **And two defences under one assertion is either
redundancy or two *properties* sharing a name — only knocking them out one at a
time says which.** Here it was the second: the depth counter holds a nested object
and the paren counter holds a parameter list, and neither covers the other. Each
is driven on a fixture written in the shape where it is the only thing holding,
because a reader correct only for the input it has been shown is not correct. The
parameter case was a real hole found this way — no mirrored file uses that shape
today, so nothing was wrong, which is exactly why it was worth finding before
somebody adds one.

**2. An unknown value fails toward "keep working".** The client is allowed to be
behind the wire — `wire.ts` is a hand mirror and says so — so every narrowing in
it degrades rather than throws. The one that was wrong was `endedWithDaemon`,
which asked "is this a daemon reason?" and answered *no* for a reason it had never
heard of: the session fell into `showsAsEnded` and `Composer.tsx` **took the
composer off the screen for a conversation that was coming back**. It asks "is
this a *final* reason?" now, so an unknown one keeps the composer. Same shape as
`reemoat-enc` on the tunnel: an unrecognised value is one refused *stream*, never
a dropped tunnel — which is the property that let the encryption seam be spent
with no protocol break at all. ⚠ **The flag day that *was* taken is a different
thing and is the one exception to the rollout below**: `RELAY_PROTOCOL_MIN_VERSION`
went straight to 2, because v2 is the version on which a stream is always
encrypted and no range can span "plaintext HTTP" and "ciphertext". Q7.143.

**3. The control plane's schema grows and never changes shape.**
`applyControlPlaneSchema` is schema + `checkSchemaVersion` + `migrate`, in that
order, and **`migrate()` may only add**. `CP_SCHEMA_VERSION` does not move for an
addition — a nullable column an older build never selects is invisible to it, so
yesterday's image still starts against today's database. Bumping it makes
`checkSchemaVersion` refuse the file, `main.ts` exit 2, and the unit restart into
a crash loop that takes the relay and the whole fleet's reachability with it. **A
rollback is what you do when a release is broken; it must not be the thing that
breaks everything else.**

⚠ **One rollback re-opens what was closed: the relay's, past 0.12.0.** A link
capability lives 90 days and its revocation is the relay reading `machine_links` at
every connection (Q7.150); an older relay ignores `lnk` and admits the token on the
owner's grant alone. So every link revoked by a switch, an isolation or a revoked
machine connects again until it expires. A daemon's own policy still refuses where
it was delivered; nothing refuses for a revoked machine. Switch agent messaging off
on each account first. The same release adds a fifth skew, **daemon to daemon** over
`/peer/*`: two of one owner's machines update apart, so every field those parsers
require is one no later daemon may drop.

⚠ Every driver used to build its database with `exec(readFileSync(schema.sql))`
and nothing else — eight sites in `relaycheck` alone — which tested a schema
production never has. That is why applying the schema is a function now.

**4. Raise a floor only against the inventory.** `cpctl admin fleet` /
`GET /v1/admin/fleet` report what every machine last dialled in as, offline ones
included, because the machine that decides whether `RELAY_PROTOCOL_MIN_VERSION`
can move is the one that has been dark for a month. The numbers come off the
handshake, not from asking a daemon anything.

**The same surface carries the agent CLIs, under rule 1's label half.**
`AGENT_CLIS_HEADER` announces which build of each built-in harness's CLI the
daemon would launch — `claude=2.1.259;codex=0.153.1;kimi=-`, read off the same
`agentCli` a launch resolves through, so it names the build a session would get
and not a copy that happens to be installed. The relay records it in
`machines.daemon_agents` on dial, the fleet route answers it parsed (`agents`,
harness → version, `null` for a binary that would not say), and `cpctl admin
fleet` prints it per machine, which is what makes *"which machines are running a
July claude"* answerable without opening a shell on any of them. **Announced,
never negotiated, and optional on the reader**: a daemon older than the header
dials, enrolls and is listed with `agents: null`, and so is one whose value
`parseAgentClis` refused — refused **whole** to `null`, never cut, because a list
cut mid-entry is a false version where a cut label is still a label; and a
daemon with no CLI for any harness sends no header rather than an empty one, so
those three are one silence on purpose, the only way to tell them apart being a
comparison on `DAEMON_VERSION` that rule 1 forbids. It is **exactly as fresh as
the machine's last dial**, and that is a decision rather than a gap: the daily
agent update clears the daemon's ten-minute CLI cache and does not redial,
because a redial drops every live stream on the machine — every browser socket —
for a report nobody is blocked on. The row therefore says what the machine
would have launched when it last connected; a relay deploy, a network blip or a
daemon update refreshes it, and one machine's live answer is its own
`GET /agents/capabilities`. Still a report, in the same direction as the version
above, and nothing here moves a CLI — that is `deploy/agents.sh` on the host.

## Which side ships first

**Whoever has to be able to *answer* ships first. Whoever will *ask* ships
second.** One rule, and the two orders it produces read as contradictory advice
until you notice which way the call goes:

| The change | Who answers | Ships first |
|---|---|---|
| A new relay protocol version | the relay, on the tunnel handshake | **control plane** |
| A new route on the daemon (`/plugins`, …) | the daemon | **the daemons** |
| **A new route or field the app will ask a daemon for** | the daemon | **the daemons** |
| **A new field the app reads off the control plane** (`machine.key`, `legal.documents`, …) | the control plane | **control plane** |

The last two are the same rule as the first two and are written out because the app
is now a separately shipped artifact, which makes them a real question rather than a
consequence of one deploy. An app build that asks for something no daemon answers
yet is not broken — that is what rule 2 buys — but it is a feature every user is
offered and nobody can use.

⚠ **"New client against old daemon is the normal state of the fleet" is a
statement about what this system *tolerates*, and not a recommendation about what
to choose.** Tolerating a skew and electing to create one are different acts, and
reading the first as the second is how a release ships an app build ahead of the
daemons that would have to answer it. The cost of getting it backwards is not
breakage, because the client degrades by design: it is every user being offered a
feature that answers *"update your machine"* for as long as the slowest owner takes
to do it — and now, with no weekly deploy behind the client, for as long as **that
app build is installed**, which is a window nobody at this end can close.

Where **both** apply in one release the protocol half forces control-plane-first,
and that is not a tie being broken by preference: a relay that cannot accept what
a daemon offers is a daemon that cannot dial in **at all**, while a route that is
not there yet is a screen with a sentence on it. The hard requirement wins and the
soft degrade is the price. Q4.105.

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

## The open question: the inner frame protocol has no version between its two ends

**`packages/protocol/src/frames.ts` is spoken between two artifacts that ship
independently, and nothing on the wire says which version either of them is.** The
app and the daemon are the two ends of a Noise session; the frame table
(`HELLO`, `REQUEST`, `RESPONSE_BODY`, `SOCKET_MESSAGE`, …) is the whole vocabulary
inside it. Both compile the same source file — at whatever commit each happened to
be built from, which the section at the top of this page has just established can
now be months apart in either direction.

**There *is* a version string, and it is written by the party that speaks none of
this protocol.** `STREAM_ENCRYPTION_NOISE_IK` is
`noise-ik-25519-chachapoly-blake2s/1`, and `protocol.ts` argues correctly that the
suite and the inner framing belong in one string, because a change to either is a
disagreement about what the bytes mean. But that header is stamped onto the h2
CONNECT by the **relay** (`relay/proxy.ts`), from the constant the *control plane's*
image was built with, and the daemon refuses a value it does not know with a 501 on
that one stream. So the pair it actually versions is relay ↔ daemon. The app never
sends it, is never asked for it, and could not be refused by it.

⚠ **And an unknown frame type is fatal in both directions**, which is this file's
rule 2 pointing the other way. `src/e2ee.ts` answers `fail(400, "unexpected frame
N")`, which ends the session; `packages/web/src/e2ee.ts`'s `default:` arm answers
`fail(new Error(...))`, which ends the channel. Neither skips the frame it did not
recognise — and that is *right* at this layer, because a frame carries a length and
a body rather than a named field to ignore, and carrying on past one you cannot
parse is a stream that has lost its own boundaries. The rule is not wrong here; it
simply does not reach.

**What is not decided is what to do about it, and this file does not decide.**
Nothing is broken today: the union has only ever grown by addition, the app and the
daemon in the field were built within a release of each other, and the frame table
has never lost a member. What is written down here is the shape of the hole — one
protocol, two independently shipped speakers, a version label owned by a third party,
and a fail-closed reader at each end — so that whoever first adds a frame type is
looking at it rather than discovering it. **Do not invent a negotiation for this on
the strength of this section.** Rule 1 is the standing constraint on any answer: a
version is negotiated or it is a label, never both, and something that sat unused
would be neither.

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
