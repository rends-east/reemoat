---
paths:
  - src/agentauth.ts
  - src/runtime/*
  - packages/web/src/ui/login.ts
  - packages/web/src/ui/agentCard.ts
  - packages/web/src/ui/settings/AgentsPanel.tsx
  - packages/web/src/ui/settings/MachineSystemsSection.tsx
  - packages/web/src/ui/settings/SystemsPanel.tsx
---

## Logging an agent in

All three agents authenticate out of band and the daemon can only inherit
credentials from disk — it never calls ACP's `session/authenticate`. So something
has to put credentials on that disk, and from a phone there is no terminal.

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
is about the adapter; `loggedIn` and `login` are about the CLI under it, and the
three vendor it differently — claude inside a platform-specific SDK package with
no `bin` entry, `@openai/codex` an ordinary one, kimi not at all — so
`vendoredCli` is a `switch` with **no `default` arm**. `resolveLoginBinary` reads the agent's `executableEnv` first, **from the table
rather than written out**, because two of the three have such a variable:
`CLAUDE_CODE_EXECUTABLE` and codex's `CODEX_PATH`, both read by the adapter's own
`startAcpServer()` and therefore deciding which binary *sessions* run.
`daemoncheck` pins the pair by name. Q2.205. `CODEX_HOME` is **not** that
variable — it names where credentials live, so offering it as the remedy for
"cannot find the CLI" sends somebody to move their credentials.

**A status probe is read from the stream its CLI answers on, and that is a field
rather than an assumption.** `claude auth status` prints JSON on **stdout**;
`codex login status` prints a sentence on **stderr** and writes nothing to stdout.
Reading the wrong one costs no error anywhere: the probe sees an empty string and
answers "cannot tell" for ever. Neither is read by its exit code, which cannot be
told from a crash or a missing binary. `readLoginAnswer` is pure and owns both
formats, so `daemoncheck` reaches branches no CI machine could — including that
"Logged in" is a substring of "Not logged in", which is why the negative pattern
is tested first. Q2.206.

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
