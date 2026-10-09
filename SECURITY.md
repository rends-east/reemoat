# Security

This project runs coding agents as your own user, with no sandbox, and makes them
reachable from a phone through a relay. That combination is the product rather
than an oversight, so this file has two halves: how to report something that is
wrong, and an honest list of the things that are **known and accepted**. Reading
the second half first is the better use of your time — most of what looks like a
vulnerability here is written down below, on purpose, with the reason it was
accepted.

## Reporting

**Report privately rather than in a public issue**, for the ordinary reason: a
report is more useful before it becomes instructions somebody else can follow
against other people's machines. This is one person rather than a team with a
rotation, so the window between a public issue and a fix is measured in whatever
time that person happens to have.

> **Report it through GitHub, privately:**
> [**Security → Report a vulnerability**](https://github.com/rends-east/reemoat/security/advisories/new).

There is deliberately **no email address here.** A GitHub advisory opens a private
thread attached to the repository itself, which is where the fix has to happen
anyway: the patch is developed in a private fork off that thread and published
with the advisory in one act, rather than travelling as a diff through somebody's
inbox. It also means there is no address to rotate, filter or lose, and nothing
for a scraper to collect off this file.

Please include what you did, what happened, and which of the three parts it
touches — the daemon (`src/`, on your own machine), the control plane
(`packages/control-plane`, which holds the fleet's signing key), or the web UI
(`packages/web`). A reproduction against the drivers (`pnpm daemoncheck`,
`pnpm relaycheck`, `pnpm authcheck`) is the most useful form a report can take,
because that is where a fix will end up being asserted.

A CVE is available where one is warranted — GitHub is a CVE Numbering Authority,
so an advisory raised through the link above can request an identifier without
anybody leaving this repository. That is the whole of the process: there is **no
bounty and no response-time commitment.** Saying otherwise would be inventing a
promise nobody has made.

## Scope

**In scope**, roughly: anything that lets somebody reach a machine they hold no
grant on; anything that gets a plugin's code, or anything it returns, *executing*
in the browser rather than being drawn as data; anything that lets a token minted for one machine verify at another;
anything that lets a caller past the control plane's password, session, throttle
or grant checks; a way to make the relay parse, log or leak what it carries; a
credential written somewhere it should not be (a log line, an image layer, a
transcript, a mail body); and any place a daemon's own containment checks can be
walked out of by a path, a symlink or an upload name.

**Out of scope**, because they are the design and are described below: an agent
reading or writing anything your user can; an agent pushing to a remote with your
credentials; a git hook running during a checkout; anything that follows from
somebody legitimately holding a grant on your machine; anything that follows
from `~/.claude/settings.json` already answering a question the permission
machinery would have asked; and anything a plugin does with the authority it was
installed with, since a plugin is code somebody chose to run on their own
machine.

**Also out of scope, and said here so it is not anybody's first report: there is a
private key committed to this repository on purpose.** `scripts/relaycheck.ts`
carries a self-signed `CN=localhost` TLS key, because the mail half is driven
against a fake SMTP server that has to present something. It expires in 2126, it
signs nothing, nothing trusts it, and the only thing that ever offers it is a
listener bound to 127.0.0.1 by the process checking it. Generating one per run
would need an X.509 library this tree does not have; shelling out to `openssl`
would make the driver skip itself wherever that binary is absent, which is a
driver that is green because it did nothing. It is declared in `.gitleaks.toml`
by its key material rather than by its filename, so a real credential in that same
file still fires — that narrowness is measured, not assumed.

## Supported versions

The latest release and `main`. There is no long-term-support branch and no
backport policy, for the same reason there is no response-time commitment below:
one person cannot staff either, and publishing a table implying otherwise would be
inventing a promise nobody has made.

Fixes land on `main` and go out in the next release. If you are running an older
tag, the upgrade *is* the fix.

## Known and accepted

Each of these was a measurement before it was a position, and each is written up
at length in `docs/DECISIONS.md` — group **Q7** is where the open ones live. What
follows is the summary, not the argument.

**There is no sandbox, and the agent runs as you.** It is a child of the daemon
process, with your uid, your `HOME`, your files, your `~/.ssh`, your browser
profile and your other repositories. `cwd` is not confined, `REEMOAT_ROOTS`
narrows the directory *picker* and nothing else, and the ACP `fs` capabilities are
granted because declining them would confine nothing — the agent could make the
same read itself. This is the trade every coding agent on a laptop already makes.
What this daemon adds is that it can be driven from a phone, over a relay, by
anybody holding a grant on the machine. The seam for a sandbox, if one is ever
wanted, is `SessionRuntime`.

**A plugin runs as you, and it is somebody else's code.** It arrives as a file
whoever owns the machine chose, and it runs as a child process of the daemon with
your uid, your `HOME`, your files and your keys — the same trade the agent already
makes, through a different door. The scope list in its manifest is declared, shown
at install and refused when exceeded, and it is **hygiene rather than a fence**:
the child can `import("node:fs")` and read everything the daemon can. What it does
buy is that the blast radius is named before somebody consents to it, that a
plugin which hangs or crashes cannot take the daemon's single event loop with it,
and that a plugin never holds the daemon's token or its database handle.

**"Before" is load-bearing, and it is why the manifest is read by whoever is
installing rather than by the machine.** The archive is not sent until its scopes,
the hosts it named and the events it asks to be told about have been drawn and
agreed to — in the browser by `packages/web/src/pluginArchive.ts`, and at a
terminal by `pnpm client plugin install`, which prints the same list and waits.
Neither is a validator: the daemon still refuses authoritatively on arrival. They
exist because the alternative was what this used to do — unpack the archive, write
the row, start the plugin, and *then* show somebody the scopes of something already
running, on a screen whose own copy told them to read it first. A disclosure after
the fact is not consent. Where the archive cannot be read locally at all, that is
said plainly and the way through is a separate, named press; it is never guessed at.

**What is a real boundary is that the browser executes none of it.** A plugin
returns a *description* of a screen and the web client draws it with its own
components, so the origin holding `reemoat.credential` runs nothing a plugin
author wrote. There is no plugin bundle, no sandboxed frame and no `postMessage`
bridge, because there is nothing of theirs to run.

`net.fetch` is a **tap rather than a fence**, for the reason everything else here
is: the daemon makes the request, against the host names the manifest listed, over
https, following no redirects — but a name somebody controls can resolve to a
private address, and the plugin could open its own socket regardless. It exists so
that a plugin which stays inside the API is auditable, not so that one which
leaves it is stopped.

Nothing downloads a plugin, nothing updates one by itself, and there is no
registry. Install one you would run in your own terminal.

**The environment strip is hygiene, not a fence.** `agentEnv()` removes
`REEMOAT_*` and the session-scoped `CLAUDE_*` names, and an agent running as this
uid can still read `/proc/<pid>/environ`, the env file and the database. What the
strip prevents is three accidents, not an attacker.

**The installer is `curl | sh`, and that is code execution by design.** `GET
/install.sh` serves a shell script people pipe into a shell, so whoever can serve
that path on that origin runs code as the person installing. What bounds it:
TLS to an origin the person chose and already trusts with their sign-in; the
script is served as `text/plain` so it renders in a browser rather than
downloading, which is what makes "read it first" advice somebody can take;
nothing in it runs as root or asks for a password; and everything it writes is
under `~/.reemoat` and the checkout it is told to make. Its one caller-influenced
input — the origin, which comes from the request's own `Host` header — is
single-quoted through `shellQuote`, and `imagecheck` sends a hostile `Host`
through a real container to prove the quoting is on the path a request takes
rather than merely present in three files.

What does **not** bound it, said plainly rather than argued away: **nothing pins
the script's content.** There is no signature and no checksum a first-time
installer could check it against, because the only thing they would check it with
is the thing being installed. `services/premium`'s cloud-init provisioner has a
digest because cloud-init verifies it out of band; a one-liner has no equivalent,
and inventing one that the same origin serves would be theatre. The honest
statement is that trusting the control plane's origin is a precondition of using
this at all — it is where the browser client comes from, and it mints every token
the fleet verifies.

**Git hooks run, deliberately.** `GIT_NO_EXEC_CONFIG` is deleted, so
`git worktree add` runs the repository's own `post-checkout` and its LFS smudge
filters, and an agent pushes with your `~/.gitconfig`, your credential helper and
your keys. Cloning a hostile repository is exactly as dangerous here as in your
own terminal, and no more. Neutralising it was tried and cost a silent failure:
a blanked `GIT_CONFIG_GLOBAL` checks out LFS pointer files instead of content.

**`~/.claude/settings.json` can bypass the permission machinery entirely.** Where
it blanket-allows `Bash`, `Edit` or `Write`, the inner CLI decides for itself and
the daemon's permission state machine never sees a request — so a switch in the UI
saying "ask me every time" would be a lie next to a config that already answered.
The settings screen reads that file and says so. Testing the permission path needs
`kimi`, or an isolated `CLAUDE_CONFIG_DIR`.

**The control plane's database is the signing key, unless it is told otherwise.** It
holds the Ed25519 private key that signs every token for every machine, and by default
it holds it as a PEM: a leak of that file, or of any backup `deploy/backup.sh` took of
it, is then a key that mints a token for any machine and any grant. Two things narrow
that, and each is stated with what it leaves.

- **`REEMOAT_CP_KEY_SECRET` wraps the private keys at rest.** With it set the file and
  its backups hold ciphertext, and so does the relay, which shares the database and is
  never given the secret. ⚠ It does nothing against somebody on the Authority's own host
  while it runs: that process holds the secret and signs. It is off until it is set,
  and the secret is then the thing to keep: lost, the keys are lost with it.
- **A rotation reaches the fleet without a visit.** A root key signs a statement of the
  signing keys in force, the relay announces it on every tunnel dial, and a daemon
  replaces its key set with it; one on a live tunnel redials for it within a ping. So
  `cpctl admin rotatekey`, then `retirekey` on the old one, stops a leaked key at every
  daemon new enough to take a statement, in under a minute. The relay only carries
  those strings: a daemon checks each against a root it already holds, or, holding
  none, against a signing key it already holds.

⚠ **What the rotation leaves, each stated rather than discovered.**

- **A daemon older than this takes no statement**, and is the one case that still needs
  a visit: retiring the key it holds darkens it.
- **By default the root is in the same database** (wrapped, with the secret set). Then
  whoever takes the server takes the root too, and rotation only buys back a leak that
  was a copy. `cpctl root new` and `cpctl admin root adopt` hand the root to a key kept
  off the host; after that a taken server yields a signing key until the next statement
  and no way to make that last. The root made at first start stays in older backups.
- **A daemon holding no root yet takes one from any signing key it holds**, the leaked
  one included. Somebody with that key who can also write the dial's response can give
  such a daemon a root of their own. The window closes at a daemon's first dial after it
  updates.
- **Rotation does nothing about an operator.** It is the remedy for a theft. A machine
  whose owner locked it to its own devices, further down, is the remedy that does not
  depend on who holds the key.

**An admin credential no longer reaches a machine on its own, and that is a much
smaller claim than it sounds.** Three routes were the whole of it and are gone or
narrowed: `PUT`/`DELETE /v1/admin/grants` (deleted — sharing is the owner's `PUT
/v1/machines/:id/grants`), `PUT /v1/admin/machines/:id/owner` (refuses a transfer
away from a live owner, and refuses adopting an ownerless machine somebody holds a
grant on unless they are the one being handed it — so it adopts rows nobody
depends on and re-labels for the owner a machine already has), `POST
/v1/admin/machines/:id/enrollments` (refuses a machine that is enrolled and has an
owner *or grantees*, because redeeming a code retires the running daemon's tunnel
key and so replaces the machine rather than reading it). `INSERT INTO grants`
appears in `app.ts` twice and in `machines.ts` once, and no route under
`/v1/admin` adds or widens a grant, on a machine that already has an owner, for
anybody other than that owner.

That string is quoted without `db.prepare(` in front of it on purpose, because an
invariant nobody can check by hand is not one: both `app.ts` writers break the line
after `db.prepare(`, so the longer form greps to **one** of the three and reads as
though the other two do not exist. `relaycheck` matches
`/db\.prepare\(\s*"INSERT INTO grants/` for that reason and says so.

⚠ **Read "ownerless" as "nobody depends on it", which is the correction rather
than the claim.** Both guards were written keyed on ownership alone, which quietly
reads *no owner* as *no users*: a machine registered before ownership existed can
be enrolled, online and carrying other people's grants, and an admin could adopt
it with every scope or re-enroll it out from under those people, both answering
200. They key on owner-or-grantee now. A genuinely orphan row — enrolled, owned by
nobody, granted to nobody — has nobody to ask and stays the operator's, which is
the only case they were ever justified by.

**Read that as narrowly as it is written: it is a statement about the HTTP
surface and about admin *credentials*, and it is not a boundary.** Whoever
operates this control plane still holds `signing_keys.private_pem` and can sign a
token for any machine with any `sub` — the daemon checks the signature, the issuer
and the audience, and never compares the subject to anything — so the operator's
reach is unchanged and no route deletion can change it. They also serve the web
client from their own image, terminate TLS at the relay, and hold the database.
(⚠ Terminating TLS there no longer means *reading* what passes through it — see
the end-to-end encryption note below — but the other two clauses are untouched,
and serving the client is the one that matters most: whoever ships the code that
holds the keys does not need to read the wire.)
What the deletions buy is that an admin account, on its own, is no longer one
request from somebody else's computer; **an operator is still trusted completely,
and self-hosting is the only version of "not trusted" this system has** — with one
exception an owner can choose per machine, described under the end-to-end note
below: a machine locked to its own list of devices does not take the operator's
signature as a way in.

**Machine substitution is open, and is disclosed rather than refused.** An admin
can revoke your machine, register a new one for you under the name that frees, and
enroll it on their own hardware — your list then draws the name you lost, owned
and online, and it is their computer. Every step has to stay: revoking is the
denial side, and registering a machine for somebody is what `install.sh`'s wizard
does. Both obvious refusals restore bugs already fixed. So `GET /v1/machines`
carries **`enrolledBy`**, which names whose enrollment code a machine enrolled with
when that was not yours — drawn on the machine row in the web UI and printed
by `cpctl machines`, because a disclosure only a `curl` reader sees is not one.

It is read off `machines.enrolled_by`, written at the redemption it describes.
Derived from `enrollment_codes` instead — which is what shipped first — it was
wrong four ways and **every one of them answered `null`, which the route reports
as "you enrolled this yourself"**: that table is swept seven days after a code is
used; `created_by` is deliberately left dangling when an account is deleted, so an
inner join dropped the row with the account; `POST /v1/provision` writes a
provisioning key's id that matches no user at all; and `used_at` is stamped by
four *burn* paths as well as by redemption, so the owner pressing "new enrollment
code" twice — the likeliest reaction to noticing something odd — overwrote the
name with their own. A column written once, at the moment that knows, has none of
those states.

⚠ **A name is not by itself a substitution, and that is this field's real limit.**
`install.sh`'s daemon wizard registers the machine and enrolls it on an admin's
code, so *every* wizard-installed machine names the admin who ran the installer,
and a substitution draws the same row as a normal install. What the field buys is
that you can tell *this enrolled with somebody else's code* from *with mine*, and
recognise the name or not. The remedy for a name you do not recognise is to
re-enroll the machine yourself, which sets it back to you.

⚠ **Three further things it does not cover, stated because a disclosure nobody has
bounded is trusted past what it says.**

It names who **minted** the code, never who **redeemed** it. `POST /v1/enroll` is
public — the credential *is* the body, and a daemon presents no account — so there
is no redeemer to record; `used_from` keeps the address and is forensic rather than
shown. A code **you** minted that leaks and is redeemed on somebody else's hardware
therefore reports you, which draws nothing. Minting again supersedes the old code,
which is the remedy for that shape; this field is not evidence about it.

It is **not retroactive.** The column is written at redemption, so every machine
that enrolled before it shipped has no value — which on the day of the upgrade is
all of them. Those rows say *somebody this control plane did not record* rather
than nothing, because folding them into the reassuring answer is the exact failure
the column was built to end. There is no backfill: the table it would read from is
swept seven days after a code is used, and the four defects below apply to a
backfill identically.

And it moves when the machine list is **read**, not on the four-second poll — a
wake, or a reload. `packages/web/src/machine.ts` says so at the fold.

**A daemon makes exactly one control-plane request, ever** — the enrollment
exchange. That is what makes a control-plane outage cost reachability rather than
work in flight, and it is the same property that makes revocation slow: nothing is
re-checked, no revocation list is fetched, and a grant revoked at the control
plane stops new requests at the *relay* rather than at the daemon.

**Tokens are not replay-tracked, and they are bound to a device.** They live
300 s with 60 s of clock leeway either side, verification is local and stateless,
and nothing remembers a `jti`. What changed is that a leaked one is no longer
*bearer*: every capability names the requesting device's X25519 public key in an
RFC 7800 `cnf.jkt` claim, and the daemon refuses one whose key is not the key the
encrypted handshake just authenticated. So a capability out of a log or a proxy
cannot be spent from another machine — the holder would have to produce a private
key that never left the operating system's keyring on the device it was minted
for.

Two honest limits on that. A capability carrying **no** `cnf` at all is refused
rather than treated as unbound, so the binding cannot be opted out of — but it is
enforced by the *daemon*, on the encrypted path, so a stolen capability spent
against a daemon on the same computer over loopback is still a bearer token for
its remaining life. And `?token=` still exists on exactly one hop: the app's
WebSocket handshake to the relay, because a browser cannot set a header on one.
It no longer appears on the daemon's own loopback dial, which is made by Node and
carries a header.

**Traffic through the relay is end-to-end encrypted, and that is the only mode.**
The app and the daemon run `Noise_IK_25519_ChaChaPoly_BLAKE2s` between themselves:
the app's static is its device key, the daemon's is a machine key it generates on
first start and announces on its tunnel dial, and the Authority reports that key
on the same call that says where the machine is. The relay authorizes the
connection and then moves bytes it holds no key for — prompts, diffs, file
contents and terminal output are ciphertext to it. There is no plaintext mode to
negotiate: the constant naming one was deleted, `RELAY_PROTOCOL_MIN_VERSION` was
raised past every build that spoke it, and a daemon that cannot speak the
encrypted mode is reported unreachable rather than reached another way.

⚠ **What this does and does not buy.** It removes the **relay** from the trusted
payload path — a compromised carrier, a hostile TLS terminator or anyone reading
that host's memory gets ciphertext. It does **not** defend against a malicious
Authority: that service mints every capability and holds
`signing_keys.private_pem`, so it can issue one naming a device key of its
choosing and talk to your daemon as you. It does not make the operator untrusted;
they still serve the client from their own image. E2EE narrows one party's reach,
and the paragraph above about operators is unchanged — **for a machine nobody has
locked**, which is every machine until its owner does.

**A machine can be locked to the devices it knows, and that is the one thing here an
operator's signature does not open.** The daemon keeps its own list of every key that
has opened an encrypted channel to it — in its own database, written and read only
inside the channel, so the control plane neither sees it nor edits it. Unlocked, the
list is a journal: who connected, under what name they gave, first and last. Locked
(*Only these devices*, under the machine's *Device access*), a key that is not on it is
refused whatever was signed for it, and waits there until somebody already inside lets
it in, or somebody at the machine does with `pnpm client devices approve`. Before
letting one in, the owner compares a ten-character code on both screens; it is derived
from the asking key alone, so it says which device is asking and nothing about the
machine. That the machine key a new device was handed is the machine's is the key
fingerprint's to say, compared the same way.

What that buys: on a locked machine, holding the signing key — as the operator, or as
whoever took the database — no longer gets anybody in. The Authority is reduced to
routing, and to refusing to route.

⚠ **What it does not buy, each one stated because a lock is trusted past what it says.**

- **It is off by default**, and an unlocked machine is exactly as open as the paragraphs
  above describe. Turning it on is the owner's choice and has a price: a new device needs
  one already let in, or a terminal on the machine, and with every device lost only the
  terminal is left.
- **Turning it on keeps every key already on the list.** A key planted while the machine
  was unlocked is therefore inside. The list is drawn above the switch for that reason:
  read it, and remove what you do not recognise, before or after.
- **Whoever is inside can edit it.** An agent runs as you and can open the daemon's
  database, so the journal catches the careless rather than the careful, and the lock is
  as good as the devices on it.
- **Loopback is outside it.** A request from the same computer has no channel and no key;
  that is the door `pnpm client` uses. What holds it to this computer is the daemon
  itself: it binds `127.0.0.1`, refuses any request whose `Origin` is a web page other
  than the app's own (a browser writes that header, a page cannot forge it), and refuses
  a `Host` that is a name rather than this computer, which is how a page rebound to
  loopback arrives. A daemon bound beyond loopback will not take the lock. **What is
  left is a program already running on that computer**, as any user: it sends no
  `Origin`, and a signed token in its hands is a way in.
- **The operator still ships the client and the installer.** A locked machine does not
  survive a release that was tampered with, or an `install.sh` served to a *new* machine.
  What changes is that a compromised **server** is no longer a compromised fleet: the app
  carries its interface inside the binary and nothing here updates it from the server.
- **The code is 50 bits over the asking device's key alone, compared by eye.** Matching
  somebody's code means finding a key with the same fifty bits, about 2^50 key
  generations. An earlier form hashed the machine's key in as well, which let one party
  choose a key on each side and brought that down to minutes; it never shipped. A
  device's own name is stripped of anything shaped like a code before it is drawn. Not
  a proof, and worth nothing to somebody who presses *Let in* without looking.

**The app remembers the key it first reached a machine with.** The control plane names a
machine's key on every token it mints, and used to be believed every time. Now the first
answer is kept on the device, and a different key named later is never dialled: the held
one is, and only if it no longer answers is anybody asked — *this machine's key changed*,
with the new fingerprint, trusted by a confirmation. ⚠ On its own this is a small claim.
It covers a server compromised **after** this device first reached this machine, and
only against being read; it does nothing about a server that mints itself a way in,
which is the lock's subject. A new device, and a new machine, believe the first answer.
The machine's fingerprint is printed by the daemon at start and shown on the machine's
screen for whoever wants to compare the two by eye; the lock's code does the same job
without being asked. Pins are per device and are not synced.

**A relayed stream's authorization is checked at open and not re-checked.** A
grant revoked mid-stream does not tear down a live WebSocket; the daemon's own
expiry re-check on the ping tick closes it when the token dies. Every ordinary
request is refused immediately.

**Retiring a device is a control-plane act, and it does not reach a token already
minted.** A *device* is the installation somebody signs in from — the computer or
the phone — and retiring one ends every session bound to it and refuses any future
sign-in that offers its id. What it deliberately does **not** do is enter the
token-verifying half of the system: `relay/authorize.ts` reads users, machines and
grants live and reads no device row, because permissions belong to the **person**
and a device authenticates as one. So per-device revocation is a grouping key over
sessions plus a bind refusal, not a new boundary, and the windows are the ones
above:

| Path | When a retired device stops |
|---|---|
| Any control-plane request | next request |
| Minting a machine token | next request |
| A machine token already minted, **over the relay** | ≤ 300 s + 60 s leeway, from the last mint — and only from *that* device, because the capability names its key |
| A WebSocket already open | that, plus one 20 s ping tick |
| Loopback to a local daemon | the same ≤ 360 s, with no control-plane hop at all — and here the capability **is** a bearer token, because a loopback request has no channel to be bound to |

⚠ **Two rows changed with end-to-end encryption and the rest did not.** Device
retirement still bites at the *next mint* and nowhere deeper — nothing in the
token-verifying half reads a device row, and it must not learn to. What the key
adds is that the window on an already-minted capability is now a window **for one
device**: it cannot be spent from anywhere else over the relay, because the daemon
compares the key inside it against the key the handshake authenticated. The
loopback row is the exception and is stated rather than glossed: there is no
channel there, so there is no key to compare, so a capability on that path is what
it always was for its remaining life. That is the same trade `.claude/rules/relay.md`
already bounds, taken by a process running as the uid that owns `~/.reemoat`.

⚠ **And a device id is not a credential.** It is an identifier this service hands
back, stored unhashed and returned in full: holding one authorizes nothing,
because every request still carries the session token and the id is read only
*after* that token has resolved. That is why the client keeps it in ordinary
configuration rather than an OS keyring — which also means it is **not** protected
at rest on the client, and does not need to be.

⚠ **A caller on an API key has no device**, so nothing that came in on one appears
in a device list and nothing there revokes one. An API key is retired by its
holder, from the keys screen or `cpctl keys --revoke`, and by nobody else — an
admin has no verb over anybody's keys (Q1.631). The Devices screen says so rather
than implying it is the complete inventory of what can reach an account.

**Registration is a user-enumeration oracle, knowingly** (Q7.78). A taken name
answers `409`, because a name is the login and a form nobody can complete is not a
form. What bounds it: every branch of the route costs the same scrypt, so it is
not *also* a timing oracle; each probe takes one of two fleet-wide public-lane
slots; and a probing host is blocked after five. What is deliberately not
conceded: an **address** is not something the person at the keyboard chooses, so a
taken one answers the same `200` as a fresh one, and `POST /v1/forgot` answers
byte-identically for known, unknown and unverified.

**The body-cancel discipline under the middlewares above a streaming route is
now enforced, and measured in one process rather than through a relay** (Q7.62).
The three streaming routes reason carefully about cancelling a body they refuse,
but the auth gate and the scope check sit *above* them, so a 401 or a 403 used to
answer without releasing the upload the client was still sending. The obligation
now hangs off the same guard that grants the exemption from the ordinary body
bound, so every answer produced below that line releases the body — measured
against all three routes, with a stream that records whether anybody cancelled it.

What is still not established is the half that needs a relay: whether an
unreleased body really does park a sender and trip the tunnel valve, and how much
of one it takes. Two gaps remain in the guard itself, both stated rather than
fixed: `cors()` answers an OPTIONS preflight *above* it, and a handler that took a
`getReader()` and abandoned it would leave the stream locked, which `cancelBody`
swallows. Neither is reachable today — a preflight carries no body worth parking,
and every streaming handler reads with `for await`.

**The first admin's password and API key are printed to the container log**, and
that is the contract rather than an accident: `main.ts` writes them on the one
start that bootstraps an admin, and `deploy/install.sh` gets them by scraping the
log, because there is nowhere else a fresh container can hand them over. What
follows is that both live in the Docker log driver's history — which is not the
database, is not covered by `deploy/backup.sh`, and outlives the sign-in that used
them. **Rotate after the first sign-in, or avoid the print**: setting
`REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD` makes that line name the variable instead of
the value. The API key has no such door — it is minted with `cpctl key` and
retired with `cpctl keys --revoke <keyId>`, so rotating it is two commands and the
old one stops working.

**The mail outbox holds rendered messages, including live one-time links**, until
it is swept.

**What the control plane keeps about people**, so that it is stated rather than
inferred from the schema: a login name, a password hash, an optional email
address, and — per sign-in — the IP address and `User-Agent` the session arrived
with (`user_session_origins`), which are recorded for recognition and are never
used to authorize anything. **And now a name per registered device**: what
somebody calls the computer or phone they signed in from, plus the platform it
reported. Both are caller-supplied and clamped at ingest, neither authorizes
anything, and the name is usually a host name — which on a personal machine is
frequently a person's own. It is listed to its owner, it is retired by them, and
`DELETE /v1/admin/users/:id` sweeps every device row of a deleted account by hand,
because nothing in this database cascades. Sessions and their origins are swept 7
days after revocation; a retired device is swept after 30 — longer because that
list is read *after* something has gone wrong rather than as a live inventory, and
a list one row shorter cannot say whether a laptop was retired or never registered.
Email tokens and unconfirmed sign-ups are swept on expiry.

**What a machine keeps, which is not the control plane's to hold or to sweep**: its own
list of the devices that reached it — a key, the name the device gave for itself, the
platform it reported, the account id its capability carried, and when it was first and
last seen. It is in that machine's database, shown to whoever holds `machine:admin` on
it, bounded at 256 rows while unlocked, and removed a row at a time by its owner.
`enrollment_codes` is swept 7 days after a code is used or expires, whichever
applies — `used_from` is the only forensic trail here, so a code is not dropped on
the tick of expiry.

⚠ **`machines.enrolled_by` is the one fact here that outlives every sweep and
every deletion, and it names a person.** It holds whoever minted the code a
machine enrolled with, and it is deliberately not cascaded: deleting an account
leaves the id behind, and the machine's owner is shown "a deleted account" rather
than the reassuring nothing an inner join gave. That is the point of it — the
disclosure above is worthless if the person it discloses can erase it — but it is
a record about somebody that survives them asking to be forgotten, so it is
written down here rather than left to the schema. It is scoped: only somebody who
can already see the machine can read it, and it is a display name rather than an
id or an address.

There is **no access log**:
nothing writes a row per request or per relay CONNECT, so there is no record of
who reached which machine when.

## What this file is not

It is not a threat model for a multi-tenant service, because this is not one. One
person, one machine, many agents, and the machine is yours. If that sentence is
not true of your deployment, the list above is the list of things you are relying
on somebody else not to do.
