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

**The control plane's database is the whole fleet.** It holds the Ed25519 private
key that signs every token for every machine. A leak of that file is a total
compromise: whoever has it can mint a token for any machine and any grant. There
is no per-machine revocation short of re-enrolling every host by hand —
`cpctl admin rotatekey` mints a new key and `retirekey` drops the old one, but a
daemon **captures the key set once at enrollment and never asks again**, so the
old key keeps verifying at the edge until each machine has been visited. Rotation
is the remedy for a leaked database; the visit to every machine is the part it
does not remove. `deploy/backup.sh` snapshots that file, which is also to say that
a backup of it is the same secret again.

**A daemon makes exactly one control-plane request, ever** — the enrollment
exchange. That is what makes a control-plane outage cost reachability rather than
work in flight, and it is the same property that makes revocation slow: nothing is
re-checked, no revocation list is fetched, and a grant revoked at the control
plane stops new requests at the *relay* rather than at the daemon.

**Tokens are not replay-tracked.** They live 300 s with 60 s of clock leeway
either side, verification is local and stateless, and nothing remembers a `jti`.
A token that leaks — out of a log, a proxy, or a `?token=` query string on a
WebSocket, which is the one place a browser cannot set a header — is usable by
whoever holds it until it expires.

**Traffic through the relay is not end-to-end encrypted.** The relay terminates
TLS and sees plaintext: prompts, diffs, file contents, everything a session
carries. It is written to route and never to parse, but that is a discipline in
the code rather than a property of the protocol. The seam for changing this is
`reemoat-enc: none` on the CONNECT handshake, and no crypto has been written.

**A relayed stream's authorization is checked at open and not re-checked.** A
grant revoked mid-stream does not tear down a live WebSocket; the daemon's own
expiry re-check on the ping tick closes it when the token dies. Every ordinary
request is refused immediately.

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
used to authorize anything. Sessions and their origins are swept 7 days after
revocation; email tokens and unconfirmed sign-ups are swept on expiry.
`enrollment_codes` is swept 7 days after a code is used or expires, whichever
applies — `used_from` is the only forensic trail here, so a code is not dropped on
the tick of expiry. There is **no access log**:
nothing writes a row per request or per relay CONNECT, so there is no record of
who reached which machine when.

## What this file is not

It is not a threat model for a multi-tenant service, because this is not one. One
person, one machine, many agents, and the machine is yours. If that sentence is
not true of your deployment, the list above is the list of things you are relying
on somebody else not to do.
