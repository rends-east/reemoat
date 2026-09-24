---
paths:
  - src/agentauth.ts
  - src/runtime/*
  - packages/web/src/ui/login.ts
  - packages/web/src/ui/agentCard.ts
  - packages/web/src/ui/settings/AgentsPanel.tsx
  - packages/web/src/ui/settings/MachineSystemsSection.tsx
  - packages/web/src/ui/settings/SystemsPanel.tsx
  - src/acp/agents.ts
  - src/acp/client.ts
  - src/agentinstall.ts
  - src/agentscript.ts
  - src/agentupdate.ts
  - src/transcript.ts
  - packages/web/src/ui/agentInstall.ts
  - packages/web/src/ui/NewSession.tsx
  - packages/web/src/ui/settings/MachineAgentsSection.tsx
  - deploy/agents.sh
---

## What a request may name, and what a probe must have seen

- **The login command is a table lookup, never a request field.** There is no route,
  body field or header anywhere that names a program to run — so "a caller cannot
  run code of their choosing as the daemon" is a property of there being nothing to
  pass. This daemon is reachable from the internet through the relay.
- **The login probe runs with the pasted credential in its environment.** The whole
  asymmetry rests on it: a clean `false` from `claude auth status` is believed over
  a pasted token, and "cannot tell" falls back to it — only honest if the CLI has
  *seen* the token. Without it a wrong token reports `loggedIn: true` and the first
  session answers `502 agent_auth_required`. Q5.67.

⚠ **And the third of these arrived with grok, which is the one agent whose
credential is spent by neither of the doors above.** `AGENT_LOGIN[*].envNames` is a
variable the CLI reads for itself — measured on all four — and grok's `XAI_API_KEY`
is **not**: on a machine with no other credential, `session/new` refuses with it
set exactly as it does without (`-32000 "Authentication required"`, `data: "no auth
method id provided"`). What spends it is ACP's `authenticate`, sent from
`AcpClient.launch`, and the id it sends is in `ACP_AUTH_METHOD` rather than read
off the agent.

⚠ **Reading `authMethods` to *pick* an id is how a client gets this wrong**, which
is this repository's usual rule inverted and so is worth stating. On a signed-out
machine `initialize` advertises exactly one method, `grok.com`: calling
`authenticate` with it prints `https://accounts.x.ai/oauth2/device?user_code=…` to
**stderr** and then *blocks* until somebody authorizes it in a browser — not
something a daemon may do on the prompt path. `xai.api_key` works, answers at once,
and is advertised nowhere; setting `XAI_API_KEY` does not add it either, measured
both ways. So the table is written down, in `ROUTED_MODEL_ENV`'s shape, and an id
an agent does not know is a clean `-32602` rather than a silence.

⚠ **But the call is gated on there being a key, and the sentence that used to sit
here is the defect.** It read *"it answers `{}` for a bogus key, so it proves the
shape and never the credential"* — true of the answer, false of the effect, and
the false half is the one that shipped. Measured 2026-09-21 on 1.0.40, on a machine
signed in by `grok login` and holding no `XAI_API_KEY`:

| sent | `session/prompt` |
|---|---|
| `authenticate({methodId: "xai.api_key"})` → `{}` | `-32603 "Internal error"`, `Unauthorized (401) … auth_kind=none … reason=no auth context`, with `Auth: Oidc` in the same payload |
| nothing | `stopReason: "end_turn"` |

The call **selects** an auth mode. With no key behind it grok stops reaching the
OIDC token in `~/.grok/auth.json` and calls its own backend unauthenticated — so
the harmless-looking `{}` is followed one call later by a refusal in the least
explicable place there is, inside the transcript. `SessionRuntime.authMethod` is
the gate, and it lives in the runtime because that is the only layer that can see
the merged spawn environment. Its failure is still **carried rather than thrown**:
`session/new` is the next call and refuses by itself. Q6.110.

⚠ **Q6.20's premise was half a measurement, and the other half is the reason this
went unnoticed.** *"grok refuses `session/new` until an `authenticate` has been
sent"* was taken signed out and generalised. Signed in, `authMethods` carries
`cached_token` beside `grok.com`, `_meta.defaultAuthMethodId` is `"cached_token"`,
and `session/new` answers normally with four models and two `configOptions`. The
refusal is a fact about *holding no credential* — which is exactly the state a
pasted key is for, and exactly the state the gate lets the call through in.

## Logging an agent in

Four of the five authenticate out of band — opencode nowhere at all: it reaches its
own gateway anonymously, and every other provider it knows is a key you hand it —
and for those four the daemon can only inherit credentials from disk. **grok is the
exception and it is the section above**: a machine holding a *pasted* key needs
ACP's `authenticate` for that key to be spent at all, so there the daemon does make
the call, with an id it writes down rather than reads — and on a machine signed in
by `grok login` it makes none, because there the credential is already on disk like
everybody else's. Either way something has to put a credential where the agent will
look, and from a phone there is no terminal.

**Path A — paste a token.** `agent_credentials(agent, env_name, secret,
updated_at)`, merged into the agent's environment at spawn. What a credential *is*
is the name of the variable the CLI reads it from — `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY`, `KIMI_API_KEY`, `CODEX_API_KEY` — so the name is stored
beside the value, and secrets merge **last**, so a pasted token beats an ambient
one: the Settings screen says "set" and has to be telling the truth. Each name is
measured rather than assumed: codex's is `CODEX_API_KEY` and **not**
`OPENAI_API_KEY`, and a pasted key there does not by itself start a session
(Q2.200); kimi's `KIMI_API_KEY` applies according to that installation's
`~/.kimi-code/config.toml` rather than according to kimi (Q2.201).

**Path B — the wizard**, which needs a pty: every login flow is an interactive
terminal program and a daemon's stdin is never a tty. `hostLoginArgs` allocates
one with `script` and is pure, so `daemoncheck` asserts both platforms from a
machine that is only one of them — util-linux takes a shell string
(`script -qec "<cmd>" /dev/null`), BSD takes argv. Three things follow: the
command is an absolute path that may contain spaces and must be shell-quoted;
macOS `script` has no `-e` and does not propagate exit status, so the wizard
re-probes rather than trusting the code; and `script` may not be installed, which
`SessionRuntime.loginSupported` reports so no button answers 503. Whether the flow
can be driven is a question about the *agent* too, answered before the button is
drawn: `loginSupport(agent)` folds three facts into one — `script` on PATH, that
agent's CLI resolving (a different binary from the adapter), and whether its flow
reads stdin at all. `loginSupported` answers only the first and is still sent, for
an older client. Q2.202.

**Signing *out* is a third question and the answer is not the same set.**
`AGENT_LOGIN[agent].logoutArgs` is `["auth","logout"]` for claude, `["logout"]`
for codex and **`null` for kimi, which has no such verb at all**, so the button is
drawn from `loginSupport().canSignOut`. Signed in, the screen offers exactly one
control, Sign out; switching accounts is sign out then sign in. Q2.203.
`POST /agent-auth/:agent/logout` clears that agent's pasted credentials **first**
and then runs the CLI, because the probe runs *with* a pasted credential in its
environment: a sign-out that left one behind would re-probe, find a token, and
report `loggedIn: true`. No pty; the same `exec` seam as the status probe.

**`AGENT_LOGIN[agent].interactiveStdin` decides two things at once**, which is why
it is in the table rather than in either reader: whether the client draws an input
box, and whether `loginStdio` gives the pty a stdin pipe. `claude auth login`
waits on a paste prompt; `kimi login` and `codex login --device-auth` are
device-code flows whose box is never used. On **BSD** a non-interactive flow is
spawned `stdio: ["ignore", …]`, the fix for the macOS defect below; **Linux keeps
its pipe unconditionally**, because Linux is where this deploys and util-linux
`script` works with one. `POST /agent-auth/login/:id/input` answers `400
login_not_interactive` for a run with no stdin (Q2.211). `--device-auth` is
codex's own advice and `daemoncheck` pins it: dropped, the login still *starts*
and then times out, indistinguishable from a network fault. Q2.204.

**The binary a login drives is not the binary the daemon launches.** `available`
is about the adapter; `loggedIn` and `login` are about the CLI under it — and
nothing vendors that CLI any more, for any of the four (Q4.114): `deploy/agents.sh`
installs it, and the adapters this repository pins cannot run without one. **Which
build runs is `LocalRuntime.agentCli`'s answer, and login, logout, the status probe
and the session all consume it** — so a credential is always written by the build a
session runs. It reads the agent's `executableEnv` first, **from the table rather
than written out**, because two of the four have such a variable:
`CLAUDE_CODE_EXECUTABLE` and codex's `CODEX_PATH`, both read by the adapter's own
`startAcpServer()`, and an override wins outright; else the **first** copy
`findOnPath` finds — PATH in order, then `MANAGED_CLI_DIRS`, which is where that
script installs — so an operator's own copy outranks the one the daemon keeps
current, which is the rule the script applies from its side: `ensure_npm` names a
copy outside the toolchain and the vendors' directories — *installed outside
reemoat, not updated from here* — and does not move it, while a copy in the
vendors' directories is refreshed by the vendor's own updater under `--source
vendor` and named as un-refreshable under `npm`; `--source` decides only how an
absent harness is installed. Nothing is compared by `--version` any more; the
number is read only for the report on `GET /agents/capabilities`, and a copy that
will not say still runs. Cached ten minutes (`AGENT_CLI_TTL_MS`), because
`deploy/agents.sh` moves the file under the running daemon, and cleared at once by
`forgetAvailability()` when it has — and a held choice is weighed against the file
behind its path on every use (`probeBuild`, bounded by `stall.ts`), so a build that
moved *without* this daemon — the CLI's own updater, another daemon, `deploy.sh` —
is re-chosen at its next use; "could not tell" keeps it, and the hit is fenced on
`probeGeneration` like the decision. ⚠ A running agent is still the build it was
started on: its model list moves only when a new process publishes one. Q6.112.
`resolveLoginBinary` answers only whether any binary exists at all — an override
counts, a copy on PATH or in `MANAGED_CLI_DIRS` counts — and its two synchronous
callers compare it to `null` and nothing else. `daemoncheck` pins the pair by name.
Q2.205, Q6.106, Q4.114. `CODEX_HOME` is **not** that variable — it names where
credentials live, so offering it as the remedy for "cannot find the CLI" sends
somebody to move their credentials.

**A status probe is read from the stream its CLI answers on, and that is a field
rather than an assumption.** `claude auth status` prints JSON on **stdout**;
`codex login status` prints a sentence on **stderr** and writes nothing to stdout.
Reading the wrong one costs no error anywhere: the probe sees an empty string and
answers "cannot tell" for ever. Neither is read by its exit code, which cannot be
told from a crash or a missing binary. `readLoginAnswer` is pure and owns both
formats, so `daemoncheck` reaches branches no CI machine could — including that
"Logged in" is a substring of "Not logged in", which is why the negative pattern
is tested first. Q2.206.

⚠ **grok's is a third format on a third shape: one command, three answers, all on
stdout.** `grok models` exits 0 with an empty stderr in every state and says which
credential it is about to use on its first line — `You are logged in with
grok.com.`, `You are using XAI_API_KEY.`, or `You are not authenticated.` — above
the model list it prints regardless. So `signedIn` takes an alternation of the
first two: both are true answers to the question the field asks, *will a session
open*, and they differ only in which credential answers it. The pair must stay a
partition, which is why it is not `You are ` plus a lookahead — `signedOut` is
tested against the same text.

⚠ **It says `using` for a key that does not work**, measured with a fabricated
value, so this probe proves a credential is *present* and never that it is good —
`AGENT_LOGIN.codex`'s gap arriving from the other direction. It is the survivable
way round: `admit` refuses on `loggedIn === false` and never on a refusal record,
so a present-but-wrong key becomes `lastStartRefusal` — *would not start* — rather
than a harness nothing will spawn again. This row was `null` for a release with a
docblock saying the signed-in string had not been seen on any machine here; it has
now, and all three were taken on one machine against one binary.

**No new WebSocket.** Output is polled; input is an HTTP request whose response
confirms it landed. A login code is sent once and unrecoverable if it evaporates,
which is exactly what `ws.send()` into a half-open socket does.

**The transcript's 64 KiB bound runs after every mutation, carry included**, and
the carry is scrubbed like everything else: the flush goes through `scrub()` — the
replacement chain lifted out of `sanitize`, which now calls it — and is appended
**after** the body text, so a transcript reads in stream order. A
`LoginRun.append` returning early on an empty body is the shape that puts a chunk
which is entirely an unterminated `\x1b]` past the one statement bounding the
buffer. Q2.207.

**Every control on the agent screen has to be true in the state it is drawn in** —
the failure is not a crash but the screen stating something it cannot know, and
`agentEnv` merges pasted secrets **last**, so a card reading "Signed in" may be
describing a credential the agent is not using (Q2.203). **The login itself is
drawn as steps, and the transcript is the fallback rather than the interface**:
`ui/login.ts` reads the pty bytes into a page to open, a device code and a
recognised failure, with the raw `<pre>` behind a disclosure that opens **by
itself** when nothing was recognised — the worst case being exactly the screen
this replaced, which is what licenses a parse that no agent negotiated and any
vendor may reword. `transcriptIsTheAnswer` is the predicate, exported so
`webcheck` asserts the rule and not a copy. The input box is drawn only where the
daemon says the flow reads one, and pasting a token sits behind "Paste a token
instead".

**opencode has no row to speak of, and that is the finding.** Measured
2026-08-27 against an empty `XDG_DATA_HOME` with no provider variables of any
kind: `session/new` succeeds, publishes six OpenCode Zen models, and
`session/prompt` completes with `end_turn`. Its own gateway has an anonymous free
tier, and the other 200-odd providers it knows are ones you hand a key to. There
is nothing to sign in to.

So `args` is **`null`** — a fourth state beside the three argument lists, and the
same shape `logoutArgs` already had for kimi. `loginBlockedReason` reads it
**first** and answers `no_flow`, which is the one reason here that is not a
limitation: the other three say a wizard could not be run *on this host* and each
has a remedy, while this one says none is wanted. Ordering it after them would
tell a machine with no `script` that it cannot run a wizard that should not exist.

| Field | Value |
|---|---|
| `args` | `null`. `auth login` exists and is an arrow-key provider picker this wizard could not drive anyway — but that is not the reason. A wizard here would be a control that fixes nothing in front of an agent that already runs |
| `interactiveStdin` | `false`. No flow, so no stdin and no pty |
| `logoutArgs` | `null`, and **not** for kimi's reason: `auth logout <provider>` exists and is non-interactive. A sign-out button beside no sign-in button is a control whose whole meaning is the pair, and what it would remove is a key this daemon did not put there. The paste box has its own clear |
| `status` | `null`, though `auth list` works and all four of its states were read — `0 credentials`, `1 credentials`, and a *separate* `1 environment variable` section. Using it would let this agent report `false`, and `AgentAskRuns.admit` refuses on exactly that: the model list would be unreadable on any machine without a key, for an agent that runs fine |
| `credentialPath` | `.local/share/opencode/auth.json`. Presence proves a provider was configured; absence proves nothing. ⚠ It moves with `XDG_DATA_HOME` — measured — which is survivable here and not for codex: a relocated directory reads as a missing file and falls to `pasted ? true : null`, never a false "signed out" |
| `envNames` | **two**, and they are two *providers* rather than two forms of one credential: `OPENROUTER_API_KEY` and `OPENCODE_API_KEY` |

**And the screen has to say so — by saying nothing.** `AgentStance` gained a fifth
member, `no_login`, which outranks the credential axis entirely: a stored key
changes what such an agent can *reach* and never whether it runs. `agentBadge`
moved into `agentCard.ts` to make that assertable — it decided four states inside
the panel, where `webcheck` drives nothing, and the fifth would have fallen into
`cannot check`, a sentence about a probe that failed under an agent that had just
completed a turn.

⚠ **The fifth badge then read `no sign-in needed` and that was still wrong.** Every
other badge here names a state somebody may have to act on; this one named the
absence of one, and under a tile beside three agents that were each reporting
something it answered a question nobody had asked. `agentBadge` returns **`null`**
for it — no badge, not a quieter one — and it is the only stance that does, which
`webcheck` pins so that "say nothing" cannot spread to `unchecked`, where the gap is
real. Whether the state *could* have been probed is deliberately not distinguished.
The sentence stayed: `stanceLine` still says, where there is room for one, that
nothing is missing and what the key box is for. Q3.509.

⚠ **Two screens draw it, and for a release only one of them did.** `NewSession.tsx`
kept a private four-state ladder of its own — no fifth member, and `state unknown`
where this card said `cannot check` — so the tile that *picks* an agent said the
one thing this stance exists to stop being said. It is gone; the tile calls
`agentStance` with `login?.blocked` exactly as the panel does, and `webcheck`
asserts that as source text because a placement is not a value. What made it
possible is that `login` now rides `GET /agents` as well as `GET /agent-auth`,
built once in `loginSupportOf` — and folding the two together turned up a live
inversion, a handler that overwrote `no_flow` with `no_script` on any daemon with
no login-run store. Q3.508.

The key box stays. It is the one state where that box is **not** a remedy, and the
one sentence above it says what it is for instead: this agent needs no sign-in, and
a key adds the models it can reach.

⚠ **One sentence, and the card was three.** It carried a stance line, a divider
reading `Sign in with a key instead` — over an agent with no first option for a key
to be instead *of* — and a per-slot caveat repeating the stance line under each of
two keys. `dividerWord` answers `null` for this stance, the caveat is deleted, and
a card mounted for a **system** (`keyEnv`) draws that system's key and nothing
else: opencode reads two variables, so the screen headed `OpenRouter` was offering
a box for somebody's OpenCode Zen account. Q3.513.

## A harness that would not start

**Signing in is one question and *would this open a session* is another, and for
four of the five agents they were close enough to be the same one.** `readLoginState` answers
`pasted ? true : null` for every harness with no status command — opencode, and
every harness a plugin adds — so `loggedIn` is permanently "cannot tell", and
`agentStance` reads that as `no_login`. A tile was drawn for a harness that had
just refused, and each press cost a worktree, a branch and a session row, because
the refusal comes **after** the spawn. Reported with a screenshot. Q2.221.

**`AgentAvailability.lastStartRefusal` is its own field and may never become
`loggedIn: false`.** That is not fastidiousness: `AgentAskRuns.admit` refuses on
`loggedIn === false`, and `admit` guards `claim` — the one thing that ever spawns
such a harness again. `GET /agents/capabilities` performs a real `session/new` and
caches only successes, so it is the only live re-measurement a harness with no
probe gets. Writing the refusal onto `loggedIn` would block the spawn that would
have discovered the harness was fixed. The narrower argument holds too: ACP's
`auth_required` comes from the *adapter*, and Q7.65 is the measured disagreement —
a `CODEX_API_KEY` the model's API accepted while `codex-acp` went on refusing.

**Two writers, and the third is refused on purpose.** `Session.start` and
`Session.openResumed`, both on `isAuthRequired` — the **typed** JSON-RPC code, not
a message match. Not the event pump's `errorKind: "authentication_failed"`: Q7.99
measured that against a token with 1.4 hours left on it, so `onAgentUnusable`
replaces the process and carries a comment saying why it writes nothing here.

**`routed` stops one refusal condemning a pairing it never tested.** `applySystem`
returns whether it actually routed — a native pairing configures nothing, the agent
already reaching its vendor on its own credential. Routed-and-refused has survived
`providers/set` and condemns every way of starting the harness; refused **bare**
says nothing about a start on somebody else's key, which is the signed-out Claude
Code on OpenRouter this repository documents as working. `registry.create` fences
on `refusal.routed || customAgent == null`, before `createWorkspace`.

**It expires, and the expiry is what makes the clearings not have to be
exhaustive.** `START_REFUSAL_TTL_MS` is `MODELS_TTL_MS`'s number and its argument —
the same fact re-measured by the same spawn — and emphatically not
`LOGIN_PROBE_TTL_MS`, which fronts a question this daemon may ask at will. In
memory, never persisted: Q7.99 is this fact written down and believed afterwards.
Somebody who signs in by running the CLI on the machine tells this process nothing,
so the record has to stop being believed by itself. The early clears: a successful
start, `PUT /agent-auth/:agent`, a login run reaching `done`, a plugin lifecycle
event, and `POST /agent-auth/:agent/recheck`.

⚠ **Two of the five `forgetAvailability` sites clear it and three must not**, and
`daemoncheck` asserts that **per handler** rather than by counting the file — a
count stayed green while the call was moved from the `PUT` into the *logout*
handler, which is the exact inversion. The two are a credential arriving: pasted,
or a wizard that ran to the end. The three are a credential going *away* — a key
deleted, a sign-out, a login abandoned — and the first would erase the record of
the refusal the deleted key was pasted against. The login-run arm was missing for a
draft and the cost is worth keeping: `start_refused` outranks `signed_in`, so
somebody who signed in **inside the app** kept the badge, kept no tile, and lost
the sign-in door itself, since `signInOffered` wants `loggedIn === false`.

**`AgentStance` gained a sixth member rather than a reordered ladder**, below
`not_installed` and above `no_flow`. Moving `loggedIn === false` up instead makes
three sentences false and `webcheck` drives none of them: `stanceLine` would blame
the *host* for an absence present on every platform and foreclose the terminal
remedy the hint offers first, `dividerWord` would draw "Sign in with a key instead"
with nothing above it (Q3.513 again), and `storedChip` would report a probe that
never ran. The badge is **"would not start"** — what was observed, diagnosing
nothing, since these harnesses have no status to probe and a key is only one of the
two remedies. `tokenBlockFor` stays `editable`, where here the box is the strongest
thing on the card. ⚠ **`offersTile` had to become an exhaustive `switch` first**:
as a pair of `!==` tests it answered a silent `true` for a member it had not heard
of, which is the `AgentGlyph` lesson one file over. Q3.537.

⚠ **Every sentence here takes the listing row, not the id.** `agentLabel` answers
the bare id for anything this product does not ship, so this card has been drawing
`byo:gemini needs no sign-in.` since contributed harnesses landed. `stanceLine` and
`storedChip` and `multiSlotLine` go through `harnessName` — the repair `hostable`
and `choiceRefusal` already took. The jargon sweep still iterates `AGENT_IDS` only,
so a contributed name reaches it pointwise rather than by sweep.

⚠ **And the card carries the control, not only the sentence.** `AgentDetail` draws
**Check again** for this stance, because the machine's agent list — where the other
copy lives — excludes every harness `startsBare` is false for, which is opencode
and every one a plugin added. Those are precisely the harnesses that
live on presets, whose refusals are the routed ones, and they had a card saying
*would not start* with nothing beside it.

## Layout

| File | Holds |
|---|---|
| `src/agentauth.ts` | Interactive agent logins: one run per agent, a capped transcript (the cap is re-applied after **every** mutation, carry included), pty output sanitised into something a `<pre>` can show — `scrub` is the replacement chain, shared by `sanitize` and by the carry flush |
| `src/runtime/types.ts` | `SessionRuntime`, `AgentProcess`, `Liveness`. Where an agent runs, as an interface — the seam a confining runtime would fill |
| `src/runtime/local.ts` | The only runtime: the agent as a child of this daemon. Also `hostLoginArgs` and the signed-in probe |
| `packages/web/src/ui/login.ts` | A login transcript as steps: the page to open, the code to read, the failures worth naming — and `transcriptIsTheAnswer`, the rule that a reading which recognised nothing shows the raw bytes |

## Bounds

| | |
|---|---|
| Agent login | one run per agent, 64 KiB transcript, 10 min TTL. Pasted credentials 8 KiB. Input refused with `400 login_not_interactive` for a run spawned with no stdin |

## Known gotchas

- **A daemon's stdin is never a TTY, so a login needs `script`**, and the two
  differ: util-linux takes a shell string after `-qec`, BSD takes argv after the
  typescript file, and getting it wrong does not fail loudly. `claude auth login`
  needs the input box and **no inbound port**. A lone `\r` becomes a newline — it
  means "redraw this line", and dropping it concatenates every spinner frame into
  one. Q2.210.
- **On macOS the wizard runs for kimi and codex and not for claude.** BSD `script`
  reads its *own* stdin's termios to copy onto the new pty, so a pipe there exits
  1 with `script: tcgetattr/ioctl: Operation not supported on socket`; `loginStdio`
  puts `/dev/null` there for the flows that read no input. claude's flow needs
  that pipe, so what it gets instead is a sentence — `ui/login.ts` recognises that
  string and says "paste a token instead". Q2.208. Whether BSD `script` survives a
  15-minute device flow on `/dev/null` is still unverified: Q7.63.
- **The login probe parses `claude auth status`'s JSON, not its exit code**, and
  `available` only ever meant "on PATH" — a logged-out agent reporting
  `available: true` is found out at `502 agent_auth_required`, after a worktree
  has been made. Q2.209.
