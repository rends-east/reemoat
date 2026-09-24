# Reemoat

> **The rename to `reemoat` is complete, and every `remoslop` left in this tree
> names something that is not this product.** One of them is load-bearing:
> `LEGACY_STORAGE` in `packages/web/src/cp.ts` holds `remoslop.credential` and
> `remoslop.apiKey`, which name what is **already sitting in somebody's browser**,
> so that a rename does not sign the fleet out. They are read once, adopted and
> swept, and they get deleted rather than updated once no tab has been signed in
> since before the rename — `webcheck` pins both halves. A blanket rename caught
> them once and the failure was total: `setSession` writes the credential and then
> sweeps that list, so with the same string in both it deleted what it had just
> written. The rest are history rather than behaviour: Q7.71 records what the
> migration had to move by hand, and a few comments quote measured paths from the
> machine this was developed on (`/Users/rends/remoslop…`), which are still the
> paths that were measured. **None of them may be swept by a rename.**


A daemon that owns coding-agent sessions and exposes them over HTTP + WS, a
control plane that issues identity and relays requests to them, and a desktop app
— the same client a phone loads in a browser — that supervises all of it. *Relays
requests* rather than *every request*: the app reaches a daemon on its own computer
over loopback, which is the one exception and is `.claude/rules/relay.md`'s.

**One person, one machine, many agents, and no sandbox.** The daemon runs on your
own machine and spawns agents as children of itself, as you — the same thing that
happens when you type `claude` in a terminal, except that you can be somewhere
else. Several at once, each in its own git worktree, each able to bring up a dev
server and run what it just wrote. Multi-user moved to the control plane: several
people, each with their own machine and a grant on it. The daemon accepts any
token whose `aud` is its own machine id and stops asking who the subject is.

It spawns `claude`, `kimi`, `codex`, `opencode` or `grok` over ACP (Agent Client
Protocol), normalizes all five into one event union, and puts that behind a network layer built on the
assumption that **clients are unreliable**: a laptop lid closes, a phone drops to
LTE, a tab is discarded. The daemon is the source of truth and the agent must
never notice a client leaving.

Node >= 24, ESM, TypeScript strict. Everything in `src/`, `scripts/` and
`packages/control-plane` runs straight off `tsx` with no build step. `packages/web`
is bundled by Vite **twice, into two directories**: `dist` is the app and goes into
the Reemoat binary, `dist-gate` is sign-up, the mailed-link screens, the legal
documents and the handoff page, and goes into the control plane's image. **The app
carries no gate screen** — it links out to the control plane's own, so there is one
sign-up form in the fleet rather than two; `GateCard` is the one shared box and
`webcheck` walks both import closures to hold that line. The
Authority serves the second at **nine addresses** and the app at none — a closed
list rather than an SPA fallback, so the product is not in the image to be served
— and **there is no variable that would serve it**: a browser holds no device key,
so it could load the app and reach no machine at all. Q4.118, Q1.649,
`docs/AUTHORITY.md`.

**No test framework.** `typecheck`, `protocolcheck`, `authcheck`, `daemoncheck`,
`relaycheck`, `webcheck`, `nativecheck`, `pincheck`, `deploycheck`, `docscheck`,
`imagecheck` and `harness` are the whole automated safety net, and they are drivers
rather than unit tests on purpose. Ten run offline in one process with no fleet, no
agent and no deploy — `docscheck` is the one whose subject is prose: it
holds this file to a budget, because the last time it was cut nothing checked
the result and it was larger six days later. `nativecheck`'s
subject is a *shell configuration*, which is the one thing no other driver can see:
`typecheck` compiles no Rust, `webcheck` is scoped to `packages/web`, and the
`cargo` build that would catch the rest is a separate job.
`protocolcheck` is the newest and the only one whose subject is a specification
**somebody else wrote** — the Noise handshake, driven byte-for-byte against the
published cross-implementation vectors in both roles, because an implementation that
only ever talks to itself round-trips perfectly while interoperating with nothing,
and would go on doing so through a nonce written the wrong way round.
`harness` drives a real agent and needs a login CI cannot hold. `imagecheck`
builds and starts a container, so it is a separate CI job — and it earns that:
the control plane reaches into the repository root for a file list written down
**twice**, in `.dockerignore` and in `deploy/docker/Dockerfile`'s COPY lines, and
an import missing from either passes `typecheck` and all nine other drivers while
breaking only the image. Measured while adding `src/http.ts`: missing from
`.dockerignore` it fails at COPY with `"/src/http.ts": not found` (the build
context never carried it), and missing from the Dockerfile it fails later with
`Cannot find module`. Adding an import means editing both.

Deploying is a *separate* act from checking, and nothing does it on a push.

> **Why any of this is the way it is lives in `docs/DECISIONS.md`** — 1059 entries
> as question → decision, with the measurement behind each and the alternatives
> that were tried and taken back out. **The count is asserted by `docscheck`
> rather than restated here from memory**, which is the whole reason it is right:
> it said 453, then 294, because it was re-derived by hand from `### Q…` alone
> while Q3 and Q5 — the two largest groups — sit at `####`. This file states rules
> as they stand and names the symbol that enforces each; that one answers *why*,
> and is where to look before reversing anything.

## Commands

```bash
pnpm typecheck                       # tsc --noEmit, both packages
pnpm protocolcheck                   # packages/protocol: the Noise handshake against the published
                                     #   cross-implementation vectors, in both roles, with the ephemerals
                                     #   pinned — plus the two things the specification says nothing about,
                                     #   the reserved top of the nonce range and this repository's own frame
                                     #   table. The only driver whose subject somebody else wrote
pnpm authcheck                       # token verification and enrollment
pnpm daemoncheck                     # the daemon's HTTP surface and durable state: routes,
                                     #   the v6 migration, the login pty, the WS, subagent lineage,
                                     #   permissions, stopping a turn, the SQLite log, changes/diff,
                                     #   uploads, installing a harness on a press, and letting an idle
                                     #   agent go — the refusals one
                                     #   at a time, that a released session reads as neither
                                     #   stopped nor interrupted, and the sweep on a fake clock —
                                     #   and the bounds an agent can push against,
                                     #   all of them refusals now: a permission's title and
                                     #   options weighed as one 8 KiB thing rather than clipped,
                                     #   a form's prose carried whole against one 32 KiB
                                     #   backstop, `locations` in the
                                     #   byte accounting, a `.git` reached through a symlink,
                                     #   and an upgrade target `new URL` refuses. Plus importing
                                     #   a codebase: both archive readers against archives it
                                     #   builds itself, every member there is a refusal for, and
                                     #   the second half of each — that nothing at all was created.
                                     #   Plus plugins: every manifest refusal, the scope gate swept over
                                     #   the whole method table, the seven routes under both axes, and the
                                     #   lifecycle a real `fork` cannot be made to walk — a start that
                                     #   never completes, an answer that never comes, an exhausted
                                     #   restart budget — plus what an update keeps and what a failed
                                     #   one puts back, and the two surfaces a plugin draws on: every
                                     #   block and every field kind on each, always in pairs, and the
                                     #   same bytes answered to both over HTTP. Plus editing an
                                     #   assembled agent: every refusal on `PATCH` in two halves, one
                                     #   malformed-body table driven through `POST` and `PATCH` and
                                     #   compared — and, against a **real** store, that a second save
                                     #   replaces the row and leaves its age alone, which the route
                                     #   section cannot reach because it stands a `Map` in, and a
                                     #   `Map` upserts. Plus a message sent while the
                                     #   agent works: two stubs, one advertising steering and one not,
                                     #   plus the one that advertises and then refuses — pinning that
                                     #   the message is never lost and never doubled, no second prompt
                                     #   on the wire and no second `prompt` event on delivery
pnpm relaycheck                      # framing, flow control, authorization, tunnel supersede,
                                     #   tunnel presence as a row and the relay's own health route,
                                     #   live-row revocation, the control plane's routes,
                                     #   signing in, sessions, passwords, the login throttle,
                                     #   guessing under concurrency, owned machines, API-key
                                     #   revocation, proving your own account — and the whole
                                     #   mail half: the SMTP client against a fake server *and*
                                     #   over a real TLS socket, the outbox, a message as bytes,
                                     #   an address as a string, settings and where each value
                                     #   came from, registration, recovery and the mail that
                                     #   carries them — plus what a stolen session may not do,
                                     #   how much of x-forwarded-for is believed, a daemon
                                     #   that takes a stream and never answers — and the machine
                                     #   limit: which machine a lowering switches off, that
                                     #   raising it back un-suspends with the same token, that
                                     #   revoking one promotes the next, that a same-millisecond
                                     #   tie still ranks, and that unset still means fifty —
                                     #   at the four places that enforce it rather than only in
                                     #   the function: the dial (403, and not the 401 that
                                     #   invites a pointless re-enrollment), `POST /v1/tokens`
                                     #   *and its after-the-grant ordering*, the enrollment
                                     #   code, and the listing's own `overLimit`/`ownerDisabled`
                                     #   pair. Plus the provisioning key: that a refused
                                     #   provision changes nothing, that a name two accounts
                                     #   share bar case is refused rather than guessed, and
                                     #   that guessing the key is counted and blocked
pnpm webcheck                        # packages/web: the cursor, rotation, replay, the tail,
                                     #   the credential, the settings routes, admin visibility,
                                     #   the password rules, the gate (registration, confirmation
                                     #   and recovery), server settings and how stuck somebody is,
                                     #   who owns Escape, the machine limit's three states and
                                     #   the sentence each draws — and the enrollment paste,
                                     #   against cpctl's own function body. Plus the transcript's
                                     #   two newest rules: what a diff says (hunks, the counts,
                                     #   the LCS bound, and the refusal to draw one over an event
                                     #   the log clipped) and which rows a run may stand for —
                                     #   never a permission, never a subagent, never one call.
                                     #   And the import flow: that an old daemon is known by the
                                     #   shape of its refusal rather than by its version, and that
                                     #   the export skill asks for what the extractor accepts. And
                                     #   where a plugin's settings are — their own screen, scoped to
                                     #   the machines somebody ticked and carrying them in the URL,
                                     #   narrowed to three controls, drawn with this app's own picker
                                     #   rather than the platform's — read off the files that place
                                     #   them, since nothing typed can hold a placement. Plus the
                                     #   machine table those machines are ticked on: what one row may
                                     #   offer and what the bar may, both swept; that the bar sits
                                     #   outside the scroller and the scroller ends no scroll chain;
                                     #   and what N settings panes add up to when they disagree.
                                     #   Then: that a transcript missing its beginning
                                     #   *says so* — `transcriptNotice` as a total partition over
                                     #   720 states, its pair with `loadStop`, and the one string
                                     #   feeding both the line and the live region — plus a retry
                                     #   schedule long enough to outlast a daemon redialling.
                                     #   And a repair rather than a subject: **two**
                                     #   sentences for a pairing failure where one was pinned — a
                                     #   spelling and a protocol may not read alike, and the check
                                     #   asserting they must is what kept the false one shipping.
                                     #   The newest are four, and the sharpest is the one that was
                                     #   green over a card nobody could reach: the plan-mode
                                     #   curation was measured against an adapter two versions
                                     #   back, so its fixture was the only request it still
                                     #   matched. Now every shape the *pinned* adapter builds,
                                     #   each with the order and the words this app puts on it,
                                     #   plus the mixture of two that must match neither. Beside
                                     #   it: that a `/clear` leaves the command and the words and
                                     #   nothing offers the conversation back, asserted as an
                                     #   absence on three files; that the parked card measures
                                     #   itself and the transcript reserves the room, pinned on
                                     #   both sides because either half alone is silent; and that
                                     #   a question says how many of its answers you may pick —
                                     #   a box or a circle, with the role claimed only where a
                                     #   button keeps it, on both halves of one form.
                                     #   Newest again, and it is about a fact this app was
                                     #   asserting against itself: that a plan card offers the
                                     #   two grants and *which* two it drops, by name, so
                                     #   dropping a third cannot pass as "still two buttons".
                                     #   That driver was green for months over code nothing
                                     #   could reach.
                                     #   And the Telegram-shaped shell: that the rail is two
                                     #   columns on one `--rail-w` with the bounds asserted by
                                     #   subtraction, that the machine strip is one data source
                                     #   drawn on two axes and the vertical one carries none of the
                                     #   horizontal one's three cues, that the menu drawer covers
                                     #   the app rather than docking beside it — `"sheet"`, never
                                     #   `"menu"`, or `j`/`k` walk the list behind it — and that
                                     #   the version is read from the manifest through a `typeof`
                                     #   guard a Vite-less import survives.
                                     #   Newest: devices — the three shapes a pasted mailed link may
                                     #   take and everything it refuses locally rather than sending,
                                     #   that signing out **keeps** the device while a retirement
                                     #   gives it up, that the two storage keys are different names
                                     #   and neither is a swept legacy one, and that the id is kept
                                     #   in the shell's config rather than its keyring — read off
                                     #   both languages, since nothing typed can hold it.
                                     #   And the dark palette: a twin for every token and the
                                     #   contrast both owe, computed in both; no colour outside
                                     #   the palette; one key for the two writers of `data-theme`;
                                     #   and the drawer's switch as its last row
pnpm nativecheck                     # packages/native: the Boot payload's keys against NativeBoot's,
                                     #   which is the census a missing `serde(rename)` slips past in
                                     #   five checkers at once; that the frontend is a path inside the
                                     #   binary and not a URL, that OS file drops still reach the
                                     #   webview (the assertion with no other symptom), that the
                                     #   capability list is empty and no plugin the Rust side drives
                                     #   is reachable from the page, the command census in both
                                     #   directions, the scheme allowlist against `links.ts`'s own,
                                     #   the CSP's directives against the ones the control plane
                                     #   sends, the two version fields that are **not** release
                                     #   sites, and the one workspace line three deploy behaviours
                                     #   depend on. Offline, and deliberately **no cargo**
pnpm pincheck                        # every place a version is written down. The agents':
                                     #   three copies each, and the adapters actually installed.
                                     #   And six of this release's seven — the root and all three
                                     #   manifests, `src/version.ts` and the CHANGELOG's newest
                                     #   dated heading; `app.ts`'s VERSION is relaycheck's, off the
                                     #   served response. **None of them says a bump happened** —
                                     #   they agree with each other, never with a tag — plus
                                     #   SOURCE_URL against the repository package.json names,
                                     #   which is the §13 offer's other half and was checked nowhere.
                                     #   And one number that is not a version: the API-key ceiling,
                                     #   written once on each side of the wire
pnpm deploycheck                     # deploy/: quoting, env files, PATH, a unit for both init systems,
                                     #   and RELAY_INPUTS against the relay entry's own import closure
pnpm docscheck                       # the documentation, held to what it claims about itself: this
                                     #   file's size budget, that every Q<n>.<m> citation resolves,
                                     #   that every symbol DECISIONS.md cites still greps to source,
                                     #   that its index count is the real one, and that every
                                     #   .claude/rules/ glob still matches a file — the one failure
                                     #   here with no symptom, since a rule scoped to a renamed path
                                     #   silently stops arriving
pnpm imagecheck                      # the control plane's image, and both services it runs.
                                     #   NOT offline: needs docker + network
deploy/ci-freshness.sh               # the adapter pins against the npm registry, weekly in CI: how
                                     #   far behind each is. Report-only; exits non-zero only for a pin
                                     #   the registry no longer serves. NOT offline; changes nothing
pnpm daemon                          # needs REEMOAT_TOKEN; see .env.example
deploy/agents.sh --check             # what the agent CLIs would install or refresh, changing nothing.
                                     #   `--only <agent>` is what a press in the app runs;
                                     #   `--refresh-only` is what `deploy.sh` and the daily timer run.
                                     #   **Nothing installs a harness but a press**
curl -fsSL 'https://<control-plane>/install.sh' | sh   # a machine, from nothing to enrolled.
                                     #   `deploy/bootstrap.sh` served by `GET /install.sh` with the
                                     #   requesting origin quoted in — so an instance hands out an
                                     #   installer that joins *it*, and a checkout copy refuses rather
                                     #   than picking one. Hands off to `install.sh daemon
                                     #   --non-interactive` once the env file exists
pnpm harness --agent codex --prompt "hi"  # drives a bare Session locally, with no daemon

pnpm cp                              # the control plane + relay in one process (own package, own SQLite).
                                     #   REEMOAT_CP_RELAY_MODE=embedded is the default and is what this is;
                                     #   the deployed shape is two containers, see compose.sh below
pnpm web                             # the web UI in dev; Vite proxies /v1 to the control plane
pnpm web:build                       # → packages/web/dist, the whole app — for `pnpm native:build` to
                                     #   compile into the binary. Nothing serves it over HTTP: the control
                                     #   plane has no switch for one and the image never carried it
pnpm --dir packages/web build:gate   # → packages/web/dist-gate, the nine addresses a browser may reach.
                                     #   This one IS in the image and is served with no switch: /confirm,
                                     #   /reset and /verify are opened by a mail client and have nowhere
                                     #   else to land

pnpm --dir packages/native install   # the native shell's own node_modules. **The root install does
                                     #   not do this** — `packages/native` is under `packages/` and
                                     #   excluded from the workspace, so the Tauri CLI never lands on
                                     #   a daemon host and a Tauri bump never moves the root lockfile
pnpm native                          # tauri dev: Vite on 5173, the window over it
pnpm native:build                    # → a macOS .app with packages/web inside the binary.
                                     #   REEMOAT_DEFAULT_SERVER is the only build-time input, and no
                                     #   file here gives it a value — release.yml forwards a repository
                                     #   variable — so a fork inherits no address; docs/NATIVE.md. **No .dmg**:
                                     #   `bundle.targets` is `["app"]`, because tauri's `bundle_dmg.sh`
                                     #   drives Finder over AppleScript and times out anywhere nobody is
                                     #   logged in — `docs/NATIVE.md` has the measurement and the one-line
                                     #   `--bundles dmg` escape.
                                     #   Ad-hoc signed: no identity is committed, and none is needed
                                     #   for a development build. arm64 only on a checkout with no
                                     #   rustup; `docs/NATIVE.md` has the rest
```

State lives in one SQLite file per daemon (`REEMOAT_DB`, default
`$REEMOAT_HOME/reemoat.db`; `REEMOAT_HOME` is `~/.reemoat` unless set) and each
session gets its own git worktree under that root's `worktrees/`. One database is
one machine for one account on one server, so the desktop app runs one daemon per
account it holds — a server's first account keeps `~/.reemoat` (for the server its
`daemon.env` names) or `~/.reemoat/servers/<server>/`, and each further account on
that server gets `~/.reemoat/servers/<server>@<user id>/` — starts every one that is
set up when it launches, and stops them all when it quits (Q7.148, Q7.149). A daemon restart leaves every session it did not stop on purpose `interrupted` and
puts an agent back on each by itself — see `.claude/rules/daemon-sessions.md`.

**Traffic to a remote daemon is end-to-end encrypted and there is no other
mode.** The app and the daemon run `Noise_IK` between themselves; the relay
authorizes the connection and then carries bytes it holds no key for. The app's
static is a **device key** in the OS keyring, the daemon's is a **machine key** it
announces on its dial, and every capability names the device it was minted for —
so one stolen off the wire is worth nothing elsewhere. `RELAY_PROTOCOL_MIN_VERSION`
was raised past every build that spoke plaintext, which is a deliberate flag day:
a daemon that has not been updated stops dialling in until `deploy/deploy.sh` runs
on its host. `.claude/rules/e2ee.md` is the area; Q7.37 and Q7.143 are the
argument. ⚠ It removes the **relay** from the trusted path and defends against
nothing else — the Authority still mints every capability and still ships the
client.

**The daemon's config is env only** (`.env.example`; the client's
`REEMOAT_URL`/`REEMOAT_MACHINE` are printed by `pnpm client` with their live
values). `REEMOAT_TOKEN` is required.

The control plane lives in `packages/control-plane`, with its own SQLite and
entry point. It signs tokens, holds users, machines and grants, mints single-use
enrollment codes, and relays. **Nothing in `src/` may ever import from it.**

## What is not confined

`REEMOAT_AUTH` decides *who* is asking. Nothing decides what they can reach.

**An agent runs as you.** It is a child of this process, with your uid, your
`HOME`, your files, your `~/.ssh`, your browser profile and your other
repositories. `cwd` is not confined, `REEMOAT_ROOTS` narrows the directory
*picker* and nothing else, and the ACP `fs` capabilities are granted because
declining them would confine nothing — the agent could make the same read itself.

That is the trade every coding agent on a laptop already makes. What this daemon
adds is that it can be driven from a phone, over a relay, by anybody holding a
grant on the machine.

**Codex confines itself, and that is codex's doing rather than a feature of this
daemon.** Measured 2026-08-07: a codex session runs its commands under a sandbox
(`CODEX_SANDBOX=seatbelt` on macOS) with the network off, and its default `agent`
mode escalates to a `session/request_permission` when a command needs more —
which is how the permission machinery gets exercised at all wherever
`~/.claude/settings.json` blanket-allows Bash. Nothing here asks for that and
nothing here can rely on it: it is a per-agent default, `agent-full-access` is one
of the three modes the session offers, and the paragraph above is still the
honest description of what the daemon guarantees, which is nothing. ⚠ And the
escalation half has already moved under it: measured 2026-09-04 on codex 0.153.1
under codex-acp 1.8.0, a `curl` the sandbox had refused was re-run **with
network** after a `Guardian Review` tool call of codex's own approved it, and no
`session/request_permission` ever reached this daemon. So on a current codex the
permission machinery may not be exercised at all, and "test it with kimi" below is
the only reliable route — `acp-agents.md` records the shape.

Three specifics, each a measurement before it was a policy, each of which reads
as a bug if you find it without this section:

**The agent inherits this process's environment.** `agentEnv()` strips the
session-scoped `CLAUDE_*` names and everything `REEMOAT_*`, and that is
**hygiene, not a fence** — the agent runs as this uid and can read
`/proc/<pid>/environ`, the env file and `REEMOAT_DB` itself. What the strip
prevents is three accidents: an agent running `env` and pasting the output into a
transcript; an agent running `pnpm daemon` and colliding on the daemon lock; and
`REEMOAT_TOKEN` reaching a subagent's context window.

**Git hooks run as you, and that is the intent.** `GIT_NO_EXEC_CONFIG` is
deleted, so `git worktree add` runs the repository's own `post-checkout` and its
LFS smudge filters. Cloning a hostile repository is exactly as dangerous here as
in your own terminal — and no more. Neutralising it cost a silent failure: a
blanked `GIT_CONFIG_GLOBAL` checks out LFS pointer files instead of content.

**A plugin also runs as you, and it is somebody else's code.** It is a child
process of this daemon with your uid and your files — the same trade the agent
makes, arriving by a different door. `manifest.scopes` is declared, shown at
install and refused when exceeded, and that is **hygiene, not a fence**: the child
can `import("node:fs")`. What it buys is a named blast radius, a hang that cannot
take the daemon's event loop, and a plugin that never holds the daemon's token.
The one real boundary is that **the browser executes none of it** — a plugin sends
a description and the app draws it, so the origin holding `reemoat.credential`
runs nothing a plugin author wrote. `docs/PLUGINS.md` is the author's document;
Q1.612 is the argument.

**This daemon downloads and executes third-party installer scripts, as you — but
a harness arrives on a machine only when somebody presses Install, and the timer
only *refreshes*.** That is the narrower posture, and it is narrower than it was:
`deploy/agents.sh` used to install all five on the bootstrap, on every
`deploy.sh`, and daily — so a harness added to this repository landed on every
machine in the fleet by itself, offering a sign-in for a program nobody asked
for. Now `deploy/bootstrap.sh` installs **none** (`--install-agents a,b` is the
door for a provisioner with nobody to press anything), `deploy/deploy.sh` and
`src/agentupdate.ts` pass `--refresh-only`, and `src/agentinstall.ts` runs
`--only <agent>` behind a `machine:admin` press. A refresh moves what is there
through the door it came in by — a copy installed outside both is named and not
moved — and fetches nothing new. What bounds the download is unchanged and
narrow: no `sudo` and no
system package manager (`deploycheck` asserts the first over the script), no shell
profile is edited, the script runs under `agentEnv()`, not this daemon's
environment, an installer is downloaded whole before running, a build a live
session may be on is kept, and a failure is a warning rather than a stop. Nothing
is vendored under it any more (Q4.114): a harness with no CLI is refused with a
sentence rather than started, and `AgentAvailability.installable` is what puts a
button under that sentence; `REEMOAT_AGENT_SOURCE=npm`, all five from the npm
registry into that toolchain, is a firewalled machine's choice, never a fallback,
and decides only how an absent CLI is installed — **two take that door under either
value**, kimi because its own updater exits 0 having installed nothing without a
TTY, and grok because its vendor installer edits shell profiles and this script
edits none (Q4.125); `REEMOAT_AGENT_CHANNEL` is which
of claude's release channels the fleet follows, `latest` by default, and unlike the
source it moves a copy that is already there: re-applied on every refresh (Q4.115).
`REEMOAT_AGENT_UPDATES=off` (or `0`) switches off both the timer and the button.
What runs is
`CLAUDE_CODE_EXECUTABLE`/`CODEX_PATH` outright, else the **first** copy on PATH,
then in the directories the script installs into — so a file an agent drops into
`~/.local/bin` is the build the daemon runs within ten minutes, as the same uid
(Q6.106). **Why it exists at all is a measurement, not a preference**: none of the
five self-updates when a *daemon* drives it, every updater being gated on a
terminal an ACP-spawned agent never has (Q4.113) — grok is the one that *would*,
in the background, which is why it is spawned with `--no-auto-update`: when a
build moves on this fleet is `src/agentupdate.ts`'s decision, not the agent's.

**`~/.claude/settings.json` can bypass the permission machinery entirely.** Where
it blanket-allows `Bash`, `Edit` or `Write`, the inner CLI decides for itself and
the permission state machine never sees a request — so a permission path that
looks untested may simply never have been reached. Test it with `kimi`, or an
isolated `CLAUDE_CONFIG_DIR`.
The settings screen now **reads that file and says so**, because a switch below
called "ask me every time" is a lie next to a config that already answered.

If a sandbox is wanted again, the seam is `SessionRuntime` — kept as an interface
with one implementation for exactly that reason.

## Pushing

There is no forge feature. An agent pushes with your `~/.gitconfig`, your
credential helper and your keys, exactly as you would — `GIT_NO_EXEC_CONFIG` had
to go for that to be true, since it cleared `credential.helper` and
`core.sshCommand` on every invocation. Whether that is right or alarming is the
same answer as everything in **What is not confined**.

## Where the rest of this lives

The rest of this file is in `.claude/rules/`, one file per area, each scoped by
`paths:`. **A rule arrives when a file matching its globs is read, and it does not
come back after `/compact`.** So if you are planning without opening anything, or
the conversation has been compacted, read the rule for the area you are in before
deciding anything. The third column is a list of questions, never their answers —
the answers are only in the rule, which is what keeps this table from becoming a
second copy that drifts.

Dependencies point one way: `server` → `registry` → `session` → `acp/*`, with
`events.ts` as the shared vocabulary underneath.

The invariants are spread across these by subject, and they are load-bearing: each
was a real defect before it was a rule, and **none is enforced by the compiler**.

| Rule | Loads on | Answers |
|---|---|---|
| `daemon-sessions.md` | `src/registry.ts`, `src/session.ts`, `src/events.ts`, `src/store/` | What a restart brings back and what it does not · the two verbs for stopping · what the agent says after the turn ends · what ends a turn the agent never answers, and the three traps in doing it · the log's invariants |
| `daemon-bounds.md` | the same globs | Every number the daemon holds and what moves each · what the log is bounded by and what it is not · what a ceiling releases rather than refuses · why this is a file of its own |
| `mid-turn-messages.md` | `src/registry.ts`, `src/session.ts`, `src/acp/client.ts`, `packages/web/src/ui/Composer.tsx`, `packages/web/src/attach.ts`, `packages/web/src/wire.ts` | Sending while the agent is working · which door a message goes through, and who decides · what an injection does to the turn, measured · what the queue costs and what a stop does to it · Stop or Send, and what whitespace is worth |
| `acp-agents.md` | `src/acp/`, `src/session.ts`, `packages/web/src/ui/tail.ts` | What claude, kimi and codex actually send, measured · asking you a question · ultracode · subagents, commands and the snapshot · every gotcha that is a fact about an agent |
| `acp-extensions.md` | `src/acp/xai.ts`, `src/acp/client.ts` | The three requests grok sends that ACP has no method for, measured · which door each is routed onto and how each is answered · how grok withdraws one, and why a handler's position decides it · its own question timeout, and the tool withdrawn when questions are off |
| `agent-login.md` | `src/agentauth.ts`, `src/runtime/`, `packages/web/src/ui/login.ts` | How a credential reaches the host with no terminal · the pty and the two `script`s · what each CLI's status probe prints and on which stream |
| `agent-install.md` | `src/agentinstall.ts`, `agentscript.ts`, `transcript.ts`, `packages/web/src/ui/agentInstall.ts`, `settings/AgentsPanel.tsx`, `deploy/agents.sh` | Why nothing puts a CLI on a machine but a press · `installable` against `!available` · why the verdict is a measurement and never an exit status · one run daemon-wide, and the two phases a Stop may not signal into · the two lock layers, and which one is first come, first served |
| `files-paths-git.md` | `src/changes.ts`, `src/worktree.ts`, `src/uploads.ts`, `src/stall.ts`, `src/paths.ts`, `src/git.ts` | Attachments in, files out · containment, symlinks and the one `rmSync` · why no synchronous filesystem call may touch a path this daemon did not create · how git is parsed |
| `code-import.md` | `src/archive.ts`, `packages/web/src/ui/ImportCode.tsx`, `packages/web/src/importSkill.ts` | Bringing a codebase onto a machine · why containment had to be rebuilt for a path somebody else wrote · what each archive format costs, measured · the one thing the target may not notice |
| `relay.md` | `src/relay/`, `src/server.ts`, `packages/control-plane/src/relay/`, `packages/web/src/stream.ts`, `machine.ts`, `localRoute.ts`, `src/announce.ts` | Why there is no direct path in, and the one exception · what bounds it, and how a daemon says where it is · what the tunnel carries and what it must never parse · a socket's lifetime, rotation and cursor · the h2 and flow-control measurements |
| `http-and-routes.md` | `src/server.ts`, `src/http.ts`, `src/cors.ts`, `packages/web/src/http.ts`, `packages/control-plane/src/app.ts` | The error envelope every service answers in · which non-2xx is not an error · what a route retry may replay · every `pnpm client` verb |
| `auth-and-tokens.md` | `src/auth.ts`, `src/token.ts`, `src/enroll.ts`, `packages/control-plane/src/keys.ts` | What a signature proves and what it does not · why the daemon makes exactly one control-plane request, ever · every credential this fleet mints and how each stops being one |
| `authority.md` | `packages/control-plane/src/app.ts`, `main.ts`, `store.ts`, `schema.sql` | What this service is responsible for and what may never arrive in it · the two ratchets that hold that line, and the one exception named by literal · why it serves no browser UI by default · the three rules a migration owes |
| `cp-devices.md` | `packages/control-plane/src/devices.ts`, `sessions.ts`, `packages/web/src/ui/settings/DevicesSection.tsx`, `packages/native/src-tauri/src/config.rs` | What a device is and what it deliberately decides nothing about · why a retired id is ignored rather than refused · why the device check is a second statement and never a join · where the id lives on the client, why not the keyring, and why per account |
| `cp-accounts.md` | `packages/control-plane/src/app.ts`, `settings.ts`, `registration.ts`, `packages/web/src/ui/gate/` | Who may exist and who may sign up · disable against delete · the settings table and which side won · every `cpctl` verb |
| `cp-credentials.md` | `packages/control-plane/src/password.ts`, `sessions.ts`, `throttle.ts`, `net.ts` | The positional gate · what a password change must prove · what a guessing counter is keyed on and what the address half is worth · which 401 signs you out |
| `cp-machines.md` | `packages/control-plane/src/machines.ts`, `quota.ts`, `packages/web/src/quota.ts` | Who owns a machine and what a name may collide with · the ceiling against the limit · what a revoke gives back · adding a daemon for somebody else |
| `cp-mail.md` | `packages/control-plane/src/mail/`, `emails.ts` | Why a mail outage must never become a sign-in outage · what sits in the outbox and for how long · what a mailed link may carry |
| `web-shell.md` | `packages/web/src/ui/AppShell.tsx`, `SessionBrowser.tsx`, `groups.ts`, `overlay.ts`, `settings/`, `packages/web/src/store.ts` | The one question this screen is shaped around, and the rules that keep it answerable · who owns Escape · what a folder is · what a client may not draw optimistically |
| `web-transcript.md` | `packages/web/src/ui/tail.ts`, `EventList.tsx`, `DiffView.tsx`, `packages/web/src/diff.ts` | What a conversation may leave out and what it must say instead · what folds into a run and what may never · how a diff is drawn, and what refuses to draw one · what a `/clear` leaves behind |
| `ask-card.md` | `packages/web/src/ui/AskCard.tsx`, `PermissionCard.tsx`, `ElicitationCard.tsx`, `packages/web/src/permission.ts`, `ask.ts`, `elicitation.ts` | The one card for "the agent is waiting on you" · where it sits and what it may cover · which plan-mode requests are curated and which are drawn as sent · what may be picked, how many, and why nothing you typed is ever erased |
| `web-composer.md` | `packages/web/src/ui/Composer.tsx`, `CommandMenu.tsx`, `AgentConfigBar.tsx`, `packages/web/src/keys.ts` | Which key sends · what a `/` opens · why a control never leaves the strip · what a chip may claim before the daemon has answered |
| `legal-pages.md` | `packages/web/src/legal.ts`, `legal/`, `ui/legal/`, `ui/gate/Gate.tsx`, `GateCard.tsx` | Why the documents are a route rather than a sixth gate screen · why a policy is data and never markdown · whose terms a fork serves · what the consent box gates and what it deliberately does not record |
| `native-shell.md` | `packages/native/src-tauri/`, `packages/web/src/native.ts`, `cp.ts`, `ui/ChooseServer.tsx`, `scripts/nativecheck.ts` | Which one leg of this client leaves the webview, and the four reasons the others may not · what crosses the bridge and what a join does not check · why a credential is keyed on a server and an account · the synchronous read, and the two answers that were refused · why the server picker is a phase rather than a route · one rule, three copies, and what compares them · the one workspace line three deploy behaviours depend on |
| `native-accounts.md` | `packages/native/src-tauri/src/accounts.rs`, `seats.rs`, `commands.rs`, `config.rs`, `daemon.rs`, `packages/web/src/slot.ts`, `native.ts`, `store.ts`, `ui/MenuDrawer.tsx`, `ChooseServer.tsx`, `SignIn.tsx` | What an account is on this computer, and why its key is the server *and* the user · why the host decides which account a call is about and the page never names one · the bridge contract, in one table · a document rather than a label, and what a generation refuses · a webview per account on macOS, a rebind and a reload everywhere else · what adding, switching and signing out each keep and give up · a daemon per account, and which one keeps `~/.reemoat` · what the first launch after the update moves, and only on proof |
| `native-packaging.md` | `packages/native/src-tauri/tauri.*.conf.json`, `packages/native/scripts/`, `deploy/ci-release.sh` | Which platforms carry a daemon inside them and which carry a client · the one JSON file a profile is, and the measurement that made it one rather than a cargo feature · what an overlay may say, and why the list is that short · why the staging script refuses a Windows triple by name |
| `web-typography.md` | `packages/web/src/index.css`, `ui/bits.tsx`, `paths.ts`, `ui/settings/` | Which strings are monospace and which are prose · the one surface where a path is a name instead · the scale, and the single arbitrary size that is allowed to exist · one caps idiom, three constants, and why the choice between them is a colour · what the landing page shares and what nothing can check |
| `dark-theme.md` | `packages/web/src/index.css`, `theme.ts`, `public/theme.js`, both HTML shells, `ui/MenuDrawer.tsx` | What a dark token owes its light twin · what may not hold a colour, and the three traps · which palette is on, who writes `data-theme`, and why before the first paint · why light until the switch says dark, and whose choice it is |
| `docked-panels.md` | `packages/web/src/ui/paneWidth.ts`, `rail.ts`, `taskWidth.ts`, `PaneHandle.tsx`, `leaving.ts`, `TaskPanel.tsx` | How wide a draggable pane is, and which custom property the panel actually spends · who owns the separator's keyboard path · how a layer leaves |
| `machine-gestures.md` | `packages/web/src/machineOrder.ts`, `ui/machineDrag.ts`, `machineSwipe.ts`, `MachineColumn.tsx`, `SessionBrowser.tsx` | What orders the machines until a reader drags one, and why this computer's leads · what this computer's own is called, and on which screens · why the reorder is a hook and not a component · where the merge is applied and which memo is load-bearing · swiping between machines, on the list and not on the strip · the tabs' own numbers |
| `native-panels.md` | `packages/web/src/ui/NewSession.tsx`, `download.ts`, `packages/web/src/native.ts`, `packages/native/src-tauri/src/commands.rs`, `packages/web/scripts/webcheck.native-bridge.ts`, `local-route.ts` | Why a cancel is neither a failure nor an answer · `(async)` as a rule and now a mechanism · why the folder panel is the one thing here that is per *machine* · what this loosens and what it does not · the browser arm, which is not a gap |
| `plugins.md` | `src/plugins/`, `plugins/`, `packages/web/src/wire.ts` | What a plugin may add and where it may appear · the two axes of authorization, and which applies inside a hook · what an update keeps and what a failed one puts back · why `src/` now holds three `fetch` calls |
| `plugin-contributions.md` | `src/plugins/contributions.ts`, `manifest.ts`, `src/acp/`, `src/runtime/local.ts`, `packages/web/src/ui/agentCard.ts` | A plugin that adds an *agent* or a *provider* · which id is checked for membership and which only for shape, and what each costs to get wrong · where a base URL may point now · what a machine's ceiling is and why it is a refusal |
| `plugin-ui.md` | `packages/web/src/plugins.ts`, `catalogue.ts`, `install.ts`, `ui/plugins/`, `PluginView.tsx` | What the browser draws for a plugin and what it refuses to draw · where a plugin is installed from and what somebody agreed to · the one client that fails *closed* · what a draft of a fleet is |
| `agent-systems.md` | `src/acp/systems.ts`, `src/agentask.ts`, `packages/web/src/agents.ts`, `ui/AgentBuilder.tsx` | Why a harness is not a system · which pairs of them exist, and who answers that · how a model is named to a harness that has never heard of it · what a session records and what it resolves at every launch |
| `agent-strip.md` | `packages/web/src/agentStrip.ts`, `agentPick.ts`, `ui/NewSession.tsx`, `ui/settings/MachineAgentsSection.tsx` | Which agents the New session row offers and in what order · what a stored position may name and what it may never be validated against · why hiding is not a refusal · reordering with no library · why a cut row has to look cut |
| `agent-catalogue.md` | `packages/web/src/openrouter.ts`, `agents.ts`, `ui/AgentBuilder.tsx`, `src/acp/systems.ts` | The three places a model's name can come from, and which one the browser fetches · the one system whose two spellings are the same models · what the reader drops and why greying it would be worse · what has been tried in a heading and taken back out, twice |
| `deployment.md` | `deploy/`, `.github/workflows/` | Two deployments and three services · what a restart costs and what decides one · every rule about writing a value into an env file |
| `compatibility.md` | `src/version.ts`, `src/relay/protocol.ts`, `packages/control-plane/src/store.ts`, `schema.sql`, `packages/web/src/wire.ts`, `packages/protocol/src/frames.ts` | What ships with what, and why a client nobody can push decides the rest · negotiated against announced · which way an unknown value must fail · which side ships first, and the one rule that produces both orders · how to make a breaking change without a flag day · what is still one |
| `e2ee.md` | `packages/protocol/`, `src/e2ee.ts`, `machinekey.ts`, `packages/web/src/e2ee.ts`, `packages/control-plane/src/machinekeys.ts`, `packages/native/src-tauri/src/device.rs` | What the relay can read and what it cannot · which static key each end holds, where it is kept and who may touch it · why the capability may not ride the handshake · what a tag failure may not do, and the one refusal that cannot say why · what the device binding proves, and the two paths it deliberately does not reach |

**Keeping this file small is `docscheck`'s job, not a preference.** It fails the
build past a ceiling this file deliberately does not restate — the number lives in
`scripts/docscheck.ts` and is read from there, for the reason `SETTING_KEYS`
already gives one section down. What belongs here is what is true wherever you are
working; a measurement, a post-mortem or a correction belongs in
`docs/DECISIONS.md`, and the last time that rule had no check the file tripled in
six days.

## Conventions

Relative imports end in `.js`; builtins use the `node:` prefix; type-only imports
use `import type` (`verbatimModuleSyntax` is on). Stateful classes use a private
constructor plus a static async factory (`Session.start`, `AcpClient.launch`);
teardown is returned as an unsubscribe function; idempotent shutdown is
`this.x ??= this.doX()`. Validation is hand-written — no zod.

**Nothing in `src/` writes to stdout or stderr**, with two sanctioned files.
`store/sqlite.ts` prints three times, when a migration destroys something (a
dropped forge account, a collapsed credential) or a repair retires a machine
key. All three run inside `openStores`, before any callback the daemon could
have wired, so it is the only moment anybody can be told. And
`src/plugins/runner.ts` is the *child* process's entry point rather than the daemon's:
its `unhandledRejection` handler writes to the stderr `runtime.ts` already
captures into the ring shown on the plugin's failure row, which is the whole of
what a process holding none of the daemon's callbacks can say. Everything else
reports through an injected callback (`onDegraded`, `onWarning`); only `scripts/`
print.

## Comments

- Default to no comment. Write one only when a reader would get the code wrong without it: hidden constraint, invariant, workaround, surprising behaviour. One line, two at most.
- The why, with its measurements and alternatives, lives in docs/DECISIONS.md. In code, cite it as Q<group>.<n> instead of retelling it.
- No history of past versions, no restating code, no banners, no ⚠ or bold emphasis, no commented-out code, no TODO without a ticket.
- An empty catch carries a one-line reason.
- When you change code, fix or delete the comment next to it.

## Next

Deferred work, open decisions and the inventory of what is asserted are group
**Q7** of `docs/DECISIONS.md` ("Open questions and deliberate non-goals"). The
short version of what is knowingly not built: no sandbox (the seam is
`SessionRuntime`), no fleet rollout, no access log on the control plane, and
no `@file` mentions, and **a background task's end is on the wire for one agent
only** — claude reports it behind a declared capability, which is what stops the
sweep releasing an agent mid-build; the other four still say nothing, and so does
claude about a backgrounded *subagent*, which was the measured case (Q2.228,
Q7.113).
**The daemon still has no registry** — it discovers nothing and polls
nothing — but there *is* a market, and the half of Q7.104 that survived is which
process reads it: a catalogue on its own host, read **by the browser**, with
`POST /plugins/source` handing the daemon a repository and a pinned commit. A
machine still installs only what somebody named it on. **What a plugin may now add
is an agent and an inference provider**, which is the thing Q7.31 and Q7.125 twice
declined a registry for and named as the only case that would justify one — an ACP
binary this repository does not vendor and cannot measure. It arrives as two
declarative blocks in `plugin.json` rather than as `REEMOAT_AGENTS`, so it is chosen
by a person, disclosed before it is sent, and switched off with one control;
`AGENT_IDS` and `SYSTEMS` are still the five and the eight this repository *ships*,
and what a machine *offers* is those merged with what is installed on it. And no plugin draws in the
transcript or adds a slash command, both with their seams written down rather than
half-built (Q7.105). **CD stops half-way on purpose**: nothing deploys on a push,
and the one automated path is a manual `workflow_dispatch` that deploys the
*control plane* only, refuses a commit whose `check` run is not green, and calls
`deploy/ci-deploy.sh` rather than reimplementing it. **The daemon is still
refused** — recreating one interrupts every turn in flight and drops every pending
approval on the machine you also develop on, which is the half of the old "no CD"
reason that never expired (Q7.94). **Q7.61 is closed by deletion rather than by
measurement** — it asked whether an admin password reset should burn the
account's enrollment codes, and there is no admin password reset any more; the
mailed reset that replaced it deliberately leaves codes alone, because proving
control of your own address is not evidence that a daemon you enrolled is
compromised. **Q7.62 is closed too, and by the plugin work rather than by a
measurement** — it asked whether the upload route's body-cancel discipline
survived the auth and scope middlewares above it, and the answer was that the
handlers were never the gap: the middlewares were. The cancel now hangs off the
`isStreamingRoute` exemption that creates the obligation, so all three streaming
routes inherit both halves and Q7.96 closes with it.

Three are open because the *measurement* is missing rather than the code, and all
three are settled by the same run: one real device-code login on
macOS from a signed-out agent. Whether BSD `script` survives a 15-minute flow with
`/dev/null` on stdin, which is what `loginStdio`'s macOS fix rests on and which is
measured only as far as the spawn succeeding (Q7.63). What those flows actually
print, since `ui/login.ts`'s device-code patterns are conservative guesses while
its one failure string is measured — the fallback makes a miss cost the old screen
rather than a blank one (Q7.64). And whether `codex login --with-api-key`, which
exists and reads stdin, closes the gap recorded at `AGENT_LOGIN.codex`, where a
pasted `CODEX_API_KEY` reaches the model's API and still leaves `session/new`
answering -32000 (Q7.65).

Agents are a **five**-member union now, and the fourth met the precondition Q7.31
set for itself — *"a fourth agent, to show the pattern is a pattern rather than two
coincidences"* — and left the answer unchanged. opencode cost the five edits codex
cost (`resolveAgent`, `AGENT_LOGIN`, the vendored-CLI resolver (gone),
`wire.ts`'s hand-mirrored union, `pincheck`'s list) plus one the compiler was *claiming* to force and was
not: `AgentGlyph` answers `ReactNode`, `undefined` inhabits it, and a `switch`
falling off the end returns exactly that — so a blank tile would have compiled
clean for four releases. It ends in a `never` arm now — and grok is what paid for
it, the first harness added since.

**The fifth is a different shape rather than a fifth coincidence, and it is the
cheapest yet.** `grok agent stdio` is xAI's own ACP entry point, so it is the first
built-in with **no adapter this repository pins** — `pincheck` has nothing to add,
and `AgentCapabilities.cli` records the build as it does for kimi and opencode. Its
two controls are doors already driven (`category: "model"`, and `thought_level` in
opencode's spelling), and it declares no `providers`, so `hostable` refuses it every
foreign system with nothing written. What it *did* cost is **Q6.20, open since the
first release**: grok refuses `session/new` until ACP's `authenticate` has been sent
— with a key in its environment too — and the method id that works is advertised
nowhere, while the only advertised one blocks on a browser. So `ACP_AUTH_METHOD` is
written down and `AcpClient.launch` is the one call site. Q6.109, Q6.110.
Everything else — questions, permissions, commands, config, resume, context usage —
arrived through capabilities already read by `category` and by shape rather than by
name.

What each new agent *does* cost is the measuring, and opencode is the sharpest case
yet (Q6.105): the upstream issue closing "per-session model selection" as **not
planned** is about `session/set_config`, a method this daemon has never sent, while
`session/set_config_option` — the one `pinNativeModel` does send — works. Reading
the tracker instead of running the binary would have bought a whole new environment
door, a new arm in `hostable`, and a system credential in a spawn environment, none
of which is needed. A registry is still not built; what would justify one is now an
agent this repository cannot vendor and cannot measure, which is a different
feature from a tidier union (Q7.125).
