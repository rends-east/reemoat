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

- **The login command is a table lookup, never a request field.** No route, body field
  or header names a program to run, and the daemon is reachable through the relay.
- **The login probe runs with the pasted credential in its environment.** A clean
  `false` from `claude auth status` is believed over a pasted token only because the CLI
  has *seen* it; without it a wrong token reports `loggedIn: true` and the first session
  answers `502 agent_auth_required`. Q5.67.
- **grok's `XAI_API_KEY` is spent by neither door.** `AGENT_LOGIN[*].envNames` are
  variables the CLI reads itself; grok's key is spent only by ACP's `authenticate`, sent
  from `AcpClient.launch` with the id in `ACP_AUTH_METHOD`. **Never pick the id from
  `authMethods`**: signed out, the one advertised (`grok.com`) prints a device URL to
  stderr and blocks on a browser, while `xai.api_key` works at once and is advertised
  nowhere. An id an agent does not know is a clean `-32602`.
- **The call is gated on there being a key**: `SessionRuntime.authMethod`, in the
  runtime because only it sees the merged spawn environment. `authenticate` answers `{}`
  even for a bogus key but **selects an auth mode**: sent on a machine signed in by
  `grok login` with no key, grok stops reaching the OIDC token in `~/.grok/auth.json`
  and the next `session/prompt` fails `-32603` (401, `auth_kind=none`). Its failure is
  carried, not thrown; `session/new` refuses by itself. Signed in, `authMethods` has
  `cached_token` (`_meta.defaultAuthMethodId`) and `session/new` works with no call:
  Q6.20's refusal is a fact about holding no credential. Q6.110.

## Logging an agent in

Five of six authenticate out of band — opencode nowhere (its gateway is anonymous;
other providers take a key) — so the daemon inherits credentials from disk or hands
over a pasted key. cursor's `CURSOR_API_KEY` is read at startup; its only advertised
method opens a browser on this host, so `authenticate` is never sent (Q6.116). grok is
the exception above, and sends none when signed in by `grok login`.

**Path A — paste a token.** `agent_credentials(agent, env_name, secret, updated_at)`,
merged into the agent's environment at spawn, **last**, so a pasted token beats an
ambient one and "set" is true. A credential is the name of the variable the CLI reads —
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `KIMI_API_KEY`, `CODEX_API_KEY` — stored
beside the value. codex's is `CODEX_API_KEY`, not `OPENAI_API_KEY`, and does not by
itself start a session (Q2.200); kimi's applies per that installation's
`~/.kimi-code/config.toml` (Q2.201).

**Path B — the wizard** needs a pty; a daemon's stdin is never a tty. `hostLoginArgs`
allocates one with `script` and is pure, so `daemoncheck` asserts both platforms:
util-linux takes a shell string (`script -qec "<cmd>" /dev/null`), BSD takes argv. The
command is an absolute path and must be shell-quoted; macOS `script` has no `-e` and
does not propagate exit status, so the wizard re-probes; `script` may be missing, which
`SessionRuntime.loginSupported` reports. `loginSupport(agent)` folds `script` on PATH,
that agent's CLI resolving, and whether its flow reads stdin; `loginSupported` answers
only the first and is still sent for an older client. Q2.202.

**Signing out.** `AGENT_LOGIN[agent].logoutArgs` is `["auth","logout"]` for claude,
`["logout"]` for codex, `null` for kimi (no such verb); the button follows
`loginSupport().canSignOut`. Signed in, the screen offers only Sign out.
`POST /agent-auth/:agent/logout` clears pasted credentials **first**, then runs the CLI
(no pty, the status probe's `exec` seam), or the re-probe finds the token. Q2.203.

**`AGENT_LOGIN[agent].interactiveStdin`** decides both whether the client draws an input
box and whether `loginStdio` gives the pty a stdin pipe. `claude auth login` waits on a
paste; `kimi login` and `codex login --device-auth` are device-code flows. On **BSD** a
non-interactive flow gets `stdio: ["ignore", …]`; **Linux keeps its pipe**.
`POST /agent-auth/login/:id/input` answers `400 login_not_interactive` for a run with no
stdin (Q2.211). `--device-auth` is pinned by `daemoncheck`: dropped, the login starts
and times out like a network fault. Q2.204.

**Which binary.** `available` is about the adapter; `loggedIn` and `login` are about the
CLI under it, which nothing vendors (Q4.114). **`LocalRuntime.agentCli` picks the
build, and login, logout, the status probe and the session all consume it**, so a
credential is written by the build a session runs. Order: the agent's `executableEnv`,
from the table (`CLAUDE_CODE_EXECUTABLE`, codex's `CODEX_PATH`, read by the adapter's
`startAcpServer()`), wins outright; else the **first** copy `findOnPath` finds — PATH in
order, then `MANAGED_CLI_DIRS` — so an operator's copy outranks the managed one.
`deploy/agents.sh` agrees from its side: `ensure_npm` names a copy outside the toolchain
and vendors' directories (*installed outside reemoat, not updated from here*) and leaves
it; a vendor-directory copy is refreshed by the vendor's updater under `--source vendor`
and named un-refreshable under `npm`; `--source` decides only how an absent harness is
installed. Nothing compares `--version`; it is read only for `GET /agents/capabilities`.
Cached `AGENT_CLI_TTL_MS` (10 min), cleared by `forgetAvailability()`, and a held choice
is re-checked against its file on every use (`probeBuild`, bounded by `stall.ts`, fenced
on `probeGeneration`); "could not tell" keeps it. A running agent stays on the build it
started on. Q6.112. `resolveLoginBinary` answers only whether any binary exists; its two
synchronous callers compare it to `null` only, and `daemoncheck` pins the pair by name.
Q2.205, Q6.106, Q4.114. `CODEX_HOME` is never the remedy for a missing CLI — it names
where credentials live.

**A status probe is read from the stream its CLI answers on**, a field
(`LoginStatusProbe.stream`), never the exit code. `claude auth status`: JSON on
**stdout**. `codex login status`: a sentence on **stderr**. `readLoginAnswer` is pure and
owns the formats; the negative pattern is tested first, since "Logged in" is a substring
of "Not logged in". Q2.206.

- **grok**: `grok models`, stdout, exit 0 in every state; the first line is
  `You are logged in with grok.com.`, `You are using XAI_API_KEY.` or
  `You are not authenticated.` `signedIn` is an alternation of the first two, and
  `signedIn`/`signedOut` must stay a partition (never `You are ` plus a lookahead). It
  says `using` for a bad key: it proves presence, never validity, and a bad key ends as
  `lastStartRefusal`, since `admit` refuses only on `loggedIn === false`.
- **cursor**: `models`, never `status` (which says `Not logged in` beside a working
  key); stream `both`. `Available models` or `No models available for this account.` on
  stdout; `Error: Authentication required` or `Authentication failed:` on stderr, both
  exit 1. A network failure or a locked keychain reads as cannot tell. Q6.116.
- **cursor's wizard is a URL and nothing to type**: `login` opens a browser unless
  `NO_OPEN_BROWSER`, which `LOGIN_SPAWN_ENV` sets in the pty's environment only; it
  prints `…/loginDeepControl?challenge=…` and polls. Over SSH on a Mac it cannot run
  (keychain locked), and `ui/login.ts` says so.

**No new WebSocket.** Output is polled; input is an HTTP request whose response
confirms it landed, since a login code sent into a half-open socket is gone.

**The transcript's 64 KiB bound runs after every mutation, carry included.** The carry
flush goes through `scrub()` (shared with `sanitize`) and is appended after the body
text; `LoginRun.append` may not return early on an empty body. Q2.207.

**Every control on the agent screen must be true in the state it is drawn in** —
`agentEnv` merges pasted secrets last (Q2.203). **The login is drawn as steps, the
transcript the fallback**: `ui/login.ts` reads a page to open, a device code and a
recognised failure, and the raw `<pre>` opens **by itself** when nothing was recognised
(`transcriptIsTheAnswer`, exported so `webcheck` asserts the rule). The input box is
drawn only where the daemon says the flow reads one; pasting sits behind "Paste a token
instead".

## opencode: nothing to sign in to

opencode runs with no credential at all, so there is no flow.

| Field | Value |
|---|---|
| `args` | `null`, a fourth state. `loginBlockedReason` reads it **first** and answers `no_flow`, the one reason that is not a limitation |
| `interactiveStdin` | `false` |
| `logoutArgs` | `null`, not for kimi's reason: a sign-out beside no sign-in would remove a key this daemon did not put there. The paste box has its own clear |
| `status` | `null`: `auth list` would let it report `false`, and `AgentAskRuns.admit` refuses on that |
| `credentialPath` | `.local/share/opencode/auth.json`; presence proves a provider was configured, absence nothing. It moves with `XDG_DATA_HOME` and falls to `pasted ? true : null`, never a false "signed out" |
| `envNames` | two *providers*: `OPENROUTER_API_KEY`, `OPENCODE_API_KEY` |

- **`AgentStance`'s `no_login` outranks the credential axis.** `agentBadge` lives in
  `agentCard.ts` so `webcheck` drives it, and returns **`null`** for `no_login` alone —
  pinned, so "say nothing" never spreads to `unchecked`. `stanceLine` still says nothing
  is missing and what the key box is for. Q3.509.
- **`NewSession.tsx` calls `agentStance` with `login?.blocked` exactly as the panel
  does** (asserted as source text); `login` rides both `GET /agents` and
  `GET /agent-auth`, built once in `loginSupportOf`. Q3.508.
- **One sentence**: `dividerWord` answers `null` for this stance, there is no per-slot
  caveat, and a card mounted for a system (`keyEnv`) draws that system's key only.
  Q3.513.

## A harness that would not start

`readLoginState` answers `pasted ? true : null` for a harness with no status command
(opencode, every plugin harness), so a refusal after spawn needs its own record. Q2.221.

- **`AgentAvailability.lastStartRefusal` may never become `loggedIn: false`.**
  `AgentAskRuns.admit` refuses on `loggedIn === false` and guards `claim`, the only
  re-spawn; `GET /agents/capabilities` performs a real `session/new` and caches only
  successes. ACP's `auth_required` comes from the *adapter* (Q7.65).
- **Two writers**: `Session.start` and `Session.openResumed`, on `isAuthRequired`, the
  typed JSON-RPC code. Never the event pump's `errorKind: "authentication_failed"`
  (Q7.99); `onAgentUnusable` writes nothing here.
- **`routed`**: `applySystem` returns whether it routed. Routed-and-refused condemns
  every start of the harness; refused **bare** says nothing about a start on somebody
  else's key. `registry.create` fences on `refusal.routed || customAgent == null`,
  before `createWorkspace`.
- **It expires**: `START_REFUSAL_TTL_MS` is `MODELS_TTL_MS`'s number, never
  `LOGIN_PROBE_TTL_MS`. In memory, never persisted (Q7.99). Early clears: a successful
  start, `PUT /agent-auth/:agent`, a login run reaching `done`, a plugin lifecycle
  event, and `POST /agent-auth/:agent/recheck`.
- **Of the five `forgetAvailability` sites, two clear it and three must not**: a
  credential arriving (pasted, or a wizard run to the end) against one going away (a key
  deleted, a sign-out, a login abandoned). `daemoncheck` asserts it **per handler**,
  never by count. `start_refused` outranks `signed_in`, and `signInOffered` wants
  `loggedIn === false`.
- **`start_refused` is `AgentStance`'s sixth member**, below `not_installed` and above `no_flow`, never a
  reordered ladder (which would falsify `stanceLine`, `dividerWord` and `storedChip`).
  The badge is **"would not start"**; `tokenBlockFor` stays `editable`. `offersTile` is
  an exhaustive `switch`. Q3.537.
- **Every sentence takes the listing row, not the id**: `stanceLine`, `storedChip` and
  `multiSlotLine` go through `harnessName` (`agentLabel` answers the bare id for a
  harness this product does not ship). The jargon sweep iterates `AGENT_IDS` only.
- **`AgentDetail` draws Check again for this stance**, because the machine's agent list
  excludes every harness `startsBare` is false for: opencode and every plugin harness.

## Layout

| File | Holds |
|---|---|
| `src/agentauth.ts` | Interactive logins: one run per agent, a capped transcript, pty output sanitised for a `<pre>` (`scrub`, shared by `sanitize` and the carry flush) |
| `src/runtime/types.ts` | `SessionRuntime`, `AgentProcess`, `Liveness` — the seam a confining runtime would fill |
| `src/runtime/local.ts` | The only runtime: the agent as a child of this daemon; `hostLoginArgs` and the probe |
| `packages/web/src/ui/login.ts` | A login transcript as steps, and `transcriptIsTheAnswer` |

## Bounds

| | |
|---|---|
| Agent login | one run per agent, 64 KiB transcript, 10 min TTL. Pasted credentials 8 KiB. Input refused with `400 login_not_interactive` for a run spawned with no stdin |

## Known gotchas

- **util-linux `script` takes a shell string after `-qec`, BSD takes argv after the
  typescript file**, and getting it wrong does not fail loudly. `claude auth login`
  needs the input box and **no inbound port**. A lone `\r` becomes a newline, or spinner
  frames concatenate. Q2.210.
- **On macOS the wizard runs for kimi and codex, not claude.** BSD `script` copies its
  own stdin's termios, so a pipe exits 1 with
  `script: tcgetattr/ioctl: Operation not supported on socket`; `loginStdio` puts `/dev/null` there for flows reading no input.
  claude's needs the pipe, so `ui/login.ts` recognises that string and says "paste a
  token instead". Q2.208. Whether BSD `script` survives a 15-minute device flow on
  `/dev/null` is unverified: Q7.63.
- **The probe parses `claude auth status`'s JSON, not its exit code**, and `available`
  only means "on PATH": a logged-out agent is found out at `502 agent_auth_required`,
  after a worktree exists. Q2.209.
