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
control plane that issues identity and relays every request to them, and a web UI
that supervises all of it from a phone.

**One person, one machine, many agents, and no sandbox.** The daemon runs on your
own machine and spawns agents as children of itself, as you — the same thing that
happens when you type `claude` in a terminal, except that you can be somewhere
else. Several at once, each in its own git worktree, each able to bring up a dev
server and run what it just wrote. Multi-user moved to the control plane: several
people, each with their own machine and a grant on it. The daemon accepts any
token whose `aud` is its own machine id and stops asking who the subject is.

It spawns `claude`, `kimi` or `codex` over ACP (Agent Client Protocol), normalizes
all three into one event union, and puts that behind a network layer built on the
assumption that **clients are unreliable**: a laptop lid closes, a phone drops to
LTE, a tab is discarded. The daemon is the source of truth and the agent must
never notice a client leaving.

Node >= 24, ESM, TypeScript strict. Everything in `src/`, `scripts/` and
`packages/control-plane` runs straight off `tsx` with no build step;
`packages/web` is bundled by Vite, inside the control plane's image — the only
thing here that compiles anything.

**No test framework.** `typecheck`, `authcheck`, `daemoncheck`, `relaycheck`,
`webcheck`, `pincheck`, `deploycheck`, `docscheck`, `imagecheck` and `harness`
are the whole automated safety net, and they are drivers rather than unit tests
on purpose. Eight run offline in one process with no fleet, no agent and no
deploy — `docscheck` is the newest and the only one whose subject is prose: it
holds this file to a budget, because the last time it was cut nothing checked
the result and it was larger six days later.
`harness` drives a real agent and needs a login CI cannot hold. `imagecheck`
builds and starts a container, so it is a separate CI job — and it earns that:
the control plane reaches into the repository root for a file list written down
**twice**, in `.dockerignore` and in `deploy/docker/Dockerfile`'s COPY lines, and
an import missing from either passes `typecheck` and all seven other drivers while
breaking only the image. Measured while adding `src/http.ts`: missing from
`.dockerignore` it fails at COPY with `"/src/http.ts": not found` (the build
context never carried it), and missing from the Dockerfile it fails later with
`Cannot find module`. Adding an import means editing both.

Deploying is a *separate* act from checking, and nothing does it on a push.

> **Why any of this is the way it is lives in `docs/DECISIONS.md`** — 725 entries
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
pnpm authcheck                       # token verification and enrollment
pnpm daemoncheck                     # the daemon's HTTP surface and durable state: routes,
                                     #   the v6 migration, the login pty, the WS, subagent lineage,
                                     #   permissions, stopping a turn, the SQLite log, changes/diff,
                                     #   uploads — and the bounds an agent can push against:
                                     #   a permission's title and options, `locations` in the
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
                                     #   same bytes answered to both over HTTP
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
                                     #   and what N settings panes add up to when they disagree
                                     #   And the newest: that a transcript missing its beginning
                                     #   *says so* — `transcriptNotice` as a total partition over
                                     #   720 states, its pair with `loadStop`, and the one string
                                     #   feeding both the line and the live region — plus a retry
                                     #   schedule long enough to outlast a daemon redialling
pnpm pincheck                        # every place a version is written down. The agents':
                                     #   three copies each, and the adapters actually installed.
                                     #   And five of this release's six — the root and both
                                     #   manifests, `src/version.ts` and the CHANGELOG's newest
                                     #   dated heading; `app.ts`'s VERSION is relaycheck's, off the
                                     #   served response. **None of them says a bump happened** —
                                     #   they agree with each other, never with a tag — plus
                                     #   SOURCE_URL against the repository package.json names,
                                     #   which is the §13 offer's other half and was checked nowhere
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
pnpm daemon                          # needs REEMOAT_TOKEN; see .env.example
pnpm harness --agent codex --prompt "hi"  # drives a bare Session locally, with no daemon

pnpm cp                              # the control plane + relay in one process (own package, own SQLite).
                                     #   REEMOAT_CP_RELAY_MODE=embedded is the default and is what this is;
                                     #   the deployed shape is two containers, see compose.sh below
pnpm web                             # the web UI in dev; Vite proxies /v1 to the control plane
pnpm web:build                       # → packages/web/dist, which `pnpm cp` then serves at /
```

State lives in one SQLite file (`REEMOAT_DB`, default `~/.reemoat/reemoat.db`)
and each session gets its own git worktree under `~/.reemoat/worktrees/…`. A
daemon restart leaves every session it did not stop on purpose `interrupted` and
puts an agent back on each by itself — see `.claude/rules/daemon-sessions.md`.

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
honest description of what the daemon guarantees, which is nothing.

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
| `daemon-sessions.md` | `src/registry.ts`, `src/session.ts`, `src/events.ts`, `src/store/` | What a restart brings back and what it does not · the two verbs for stopping · what the agent says after the turn ends · the log's invariants · the daemon's bounds |
| `acp-agents.md` | `src/acp/`, `src/session.ts`, `packages/web/src/ui/tail.ts` | What claude, kimi and codex actually send, measured · asking you a question · ultracode · subagents, commands and the snapshot · every gotcha that is a fact about an agent |
| `agent-login.md` | `src/agentauth.ts`, `src/runtime/`, `packages/web/src/ui/login.ts` | How a credential reaches the host with no terminal · the pty and the two `script`s · what each CLI's status probe prints and on which stream |
| `files-paths-git.md` | `src/changes.ts`, `src/worktree.ts`, `src/uploads.ts`, `src/stall.ts`, `src/paths.ts`, `src/git.ts` | Attachments in, files out · containment, symlinks and the one `rmSync` · why no synchronous filesystem call may touch a path this daemon did not create · how git is parsed |
| `code-import.md` | `src/archive.ts`, `packages/web/src/ui/ImportCode.tsx`, `packages/web/src/importSkill.ts` | Bringing a codebase onto a machine · why containment had to be rebuilt for a path somebody else wrote · what each archive format costs, measured · the one thing the target may not notice |
| `relay.md` | `src/relay/`, `src/server.ts`, `packages/control-plane/src/relay/`, `packages/web/src/stream.ts` | Why there is no direct path in · what the tunnel carries and what it must never parse · a socket's lifetime, rotation and cursor · the h2 and flow-control measurements |
| `http-and-routes.md` | `src/server.ts`, `src/http.ts`, `src/cors.ts`, `packages/web/src/http.ts`, `packages/control-plane/src/app.ts` | The error envelope every service answers in · which non-2xx is not an error · what a route retry may replay · every `pnpm client` verb |
| `auth-and-tokens.md` | `src/auth.ts`, `src/token.ts`, `src/enroll.ts`, `packages/control-plane/src/keys.ts` | What a signature proves and what it does not · why the daemon makes exactly one control-plane request, ever · every credential this fleet mints and how each stops being one |
| `cp-accounts.md` | `packages/control-plane/src/app.ts`, `settings.ts`, `registration.ts`, `packages/web/src/ui/gate/` | Who may exist and who may sign up · disable against delete · the settings table and which side won · every `cpctl` verb |
| `cp-credentials.md` | `packages/control-plane/src/password.ts`, `sessions.ts`, `throttle.ts`, `net.ts` | The positional gate · what a password change must prove · what a guessing counter is keyed on and what the address half is worth · which 401 signs you out |
| `cp-machines.md` | `packages/control-plane/src/machines.ts`, `quota.ts`, `packages/web/src/quota.ts` | Who owns a machine and what a name may collide with · the ceiling against the limit · what a revoke gives back · adding a daemon for somebody else |
| `cp-mail.md` | `packages/control-plane/src/mail/`, `emails.ts` | Why a mail outage must never become a sign-in outage · what sits in the outbox and for how long · what a mailed link may carry |
| `web-shell.md` | `packages/web/src/ui/AppShell.tsx`, `SessionBrowser.tsx`, `groups.ts`, `overlay.ts`, `settings/`, `packages/web/src/store.ts` | The one question this screen is shaped around, and the rules that keep it answerable · who owns Escape · what a folder is · what a client may not draw optimistically |
| `web-transcript.md` | `packages/web/src/ui/tail.ts`, `EventList.tsx`, `DiffView.tsx`, `AskCard.tsx`, `packages/web/src/diff.ts` | What a conversation may leave out and what it must say instead · what folds into a run and what may never · how a diff is drawn, and what refuses to draw one |
| `web-composer.md` | `packages/web/src/ui/Composer.tsx`, `CommandMenu.tsx`, `AgentConfigBar.tsx`, `packages/web/src/keys.ts` | Which key sends · what a `/` opens · why a control never leaves the strip · what a chip may claim before the daemon has answered |
| `plugins.md` | `src/plugins/`, `plugins/`, `packages/web/src/wire.ts` | What a plugin may add and where it may appear · the two axes of authorization, and which applies inside a hook · what an update keeps and what a failed one puts back · why `src/` now holds three `fetch` calls |
| `plugin-ui.md` | `packages/web/src/plugins.ts`, `catalogue.ts`, `install.ts`, `ui/plugins/`, `PluginView.tsx` | What the browser draws for a plugin and what it refuses to draw · where a plugin is installed from and what somebody agreed to · the one client that fails *closed* · what a draft of a fleet is |
| `deployment.md` | `deploy/`, `.github/workflows/` | Two deployments and three services · what a restart costs and what decides one · every rule about writing a value into an env file |
| `compatibility.md` | `src/version.ts`, `src/relay/protocol.ts`, `packages/control-plane/src/store.ts`, `schema.sql`, `packages/web/src/wire.ts` | What ships with what, and why the web client riding the control plane's image decides the rest · negotiated against announced · which way an unknown value must fail · how to make a breaking change without a flag day · what is still one |

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

**Nothing in `src/` writes to stdout or stderr**, with two sanctioned exceptions.
`store/sqlite.ts`'s v6 migration prints when it destroys something (a dropped
forge account, a collapsed credential, sessions cut by a cap that used to be
per-person). Those happen inside `openStores`, before any callback the daemon
could have wired, so it is the only moment anybody can be told. And
`src/plugins/runner.ts` is the *child* process's entry point rather than the daemon's:
its `unhandledRejection` handler writes to the stderr `runtime.ts` already
captures into the ring shown on the plugin's failure row, which is the whole of
what a process holding none of the daemon's callbacks can say. Everything else
reports through an injected callback (`onDegraded`, `onWarning`); only `scripts/`
print.

An empty `catch` always carries a comment saying why. **Comments explain *why*,
often naming the empirical behaviour that motivated the code** — and a correction
belongs at the code it is about, not in this file.

## Next

Deferred work, open decisions and the inventory of what is asserted are group
**Q7** of `docs/DECISIONS.md` ("Open questions and deliberate non-goals"). The
short version of what is knowingly not built: no sandbox (the seam is
`SessionRuntime`), no end-to-end
encryption through the relay (the seam is `reemoat-enc: none` on the CONNECT
handshake), no fleet rollout, no access log on the control plane, and
no `@file` mentions. **Plugins have no market** — a registry would be a second
control-plane request and a way for code to arrive on a machine nobody named it on
(Q7.104) — and no plugin draws in the transcript or adds a slash command, both
with their seams written down rather than half-built (Q7.105). **CD stops half-way on purpose**: nothing deploys on a push,
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

Agents are a **three**-member union now, and adding the third answered the
question Q7.31 was holding open — not by refactoring the type, but by finding that
the work is per-agent measurement rather than per-agent code. Codex cost one arm in
`resolveAgent`, one row in `AGENT_LOGIN`, one arm in `vendoredCli`, one literal in
`wire.ts`'s hand-mirrored union, and a second entry in `pincheck`'s adapter list;
everything else — questions, permissions, commands, config, resume, context usage
— arrived through capabilities that were already read by `category` and by shape
rather than by name. What each new agent *does* cost is the measuring: the two
fields that were wrong on the first attempt (`OPENAI_API_KEY`, and reading a status
command's stdout) were both facts about a CLI that no amount of type work would
have surfaced. A registry is still not built, and the reason is now weaker than it
was: what would justify one is a fourth agent, not a cleaner second.
