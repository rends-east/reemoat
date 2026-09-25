---
paths:
  - src/peers/**
  - packages/web/src/peer.ts
  - packages/web/src/ui/PeerMessage.tsx
  - scripts/daemoncheck.peer-messages.ts
  - scripts/relaycheck.peer-e2e.ts
  - packages/web/scripts/webcheck.peer-messages.ts
  - packages/web/src/agentLinks.ts
  - packages/web/src/ui/settings/MachineLinksSection.tsx
  - packages/web/scripts/webcheck.agent-links.ts
---

# Messages between agents

**Sessions can list and message each other, on one machine and across an owner's
machines.** Every agent that declares an http MCP client is handed one server,
`reemoat`, with two tools: `list_agents` and `send_message`. A
session elsewhere is addressed `name [machine/session]`, and nothing else about it
differs for the agent. Q7.150 is the argument for how another machine is reached;
read it before adding a network path here.

## The door

**One MCP server per launch, injected after `initialize`.** `SessionOptions.mcpServers`
is a callback because `mcpCapabilities` is only known then; `launchOptions` hands it
to all three open sites, and `/clear` reuses the list its process was given. The
server is `PeerMcpEndpoint`: its own `127.0.0.1` listener on a port the OS picks,
whatever `REEMOAT_HOST` and `REEMOAT_PORT` say, since `REEMOAT_PORT=0` means no
listener at all. Hand-written Streamable HTTP, JSON answers only, no SDK (zod).

- **A bearer per launch, never per session.** `mcpServersFor` mints one and
  retires the one before it, so a process the daemon replaced stops naming the
  session. It says *which* session is calling; it is **hygiene, not a fence** —
  every agent runs as the same user and can read another's bearer, exactly as it
  can read `REEMOAT_DB`. Across machines the identity is the machine key (Q7.150).
- **A request carrying `Origin` is refused.** No browser has a reason to be there.
- **`server/discover` is `-32601`, on purpose.** claude and grok send it first
  (MCP 2026-07-28) and fall back to `initialize` on exactly that answer (Q6.114).
- **No agent without an http client gets the tools**, and none is shimmed over
  stdio until a measured harness needs it. It can still receive.
- **No claude session has its own `ListAgents`**, tools handed or not —
  `disallowedTools` from `sessionMetaFor`, never `settings`, which would drop the
  adapter's own model settings — and each tool carries `anthropic/alwaysLoad`, or
  claude defers it behind its tool search and reaches for its own first. Its
  `SendMessage` stays: it is how claude continues its own subagents (Q2.242).
- `REEMOAT_PEER_MESSAGES=off` injects nothing and refuses every send.

## One verb, and every message is acted on (Q2.243)

`send_message` wakes an idle session, steers into a running one, or queues behind a
turn that cannot be steered. **Nothing waits for somebody else's turn**: there is no
note that is only read when something else wakes the session, so an answer is a
message like any other and wakes whoever it is for. There is no `wait`: Codex's
polls cost it 6.5% of a run's tokens.

**The idle notice is off unless asked for, and stands in for an answer.**
`notify_when_idle` wakes its sender once if the recipient goes idle or ends
*without writing back*; writing back cancels it (`answered`), and on the other
machine the answer's arrival forgets the notice it was expecting. On by default,
every reply would subscribe its writer to the reader, and the end of every exchange
would wake the one who answered for nothing.

## Delivery is the prompt route's, not a copy

- `readyForMessage` is the route's three waits — a restart, the workspace, a
  released agent — in the route's order. The route calls it too. The plugin API's
  `sessions.prompt` skipping them is the bug this avoids repeating.
- `submit` is `prompt` then `sendMidTurn`, for a caller with no HTTP answers to
  keep apart. **The route does not use it**: its two `busy`s answer differently.
- A peer message is a `prompt` event with `from` set, and `text` is **exactly what
  the agent received**, envelope included — so a client that predates `from`
  still shows `<peer-message from=…>` inside the bubble, never the person's words.
- `recordPrompt` names a session only from a person's message, and only a
  person's message resets `peerTurnsSinceHuman` and `peerDepth`.
- Peer entries hold at most `MAX_QUEUED_PEER_PROMPTS` of the queue, so another
  agent can never make a person's own message answer 429; consecutive ones are
  sent as one turn by `deliverQueued`.

## The envelope

`peerMessage` builds it from `PeerOrigin`, which is the daemon's own record of the
sender — only `name` is derived from what anybody typed. `defuse` breaks every
tag a harness or this daemon writes (`peer-message`, `system-reminder`,
`teammate-message`, …) and every `Human:`/`Assistant:` line, so a body cannot close
its own envelope or pass as the harness. Attributes are escaped. The prompt starts
with `<`, so no adapter reads it as a slash command.

## What stops a loop (Q2.238)

Stopped by this daemon, never by asking the model: `PEER_TURN_BUDGET` turns caused
by agents with no message from the person (refused, with one line in the
recipient's transcript), `MAX_PEER_HOPS`, a token bucket per sending session, the
same words to the same session inside a minute, and `MAX_PEER_MESSAGE_CHARS`.
Every message wakes its reader, so nothing but these and the tool's wording stops
two agents thanking each other; notices count against the budget too, and one past
it is dropped rather than refused.

## Who may be reached (Q2.239)

A live session, or one that ended for a reason in `PEER_WAKE_REASONS` — a stop
nobody chose. **A person's Stop is theirs to undo**: another agent can neither list
nor wake that session.

## The row

`PeerMessageRow` draws a peer message left-aligned under *Message from* and never
as a `UserBubble`; `peerBody` takes the body out of the envelope. A notice is one
faint line. It is markdown, because another agent wrote it, and *Show all* mounts a
fresh `Markdown` rather than changing its text, which the stream throttle would
hold back behind the label.

## Another machine (Q7.150)

**A link is a capability the target's own Authority minted for this machine's key**,
`session:message` its only scope, written into `peer_links` whole by the owner's app
(`PUT /peers/links`). This daemon never asks a control plane for one.

- **Sending** is `peerRequest`: an app's dial made by a daemon — Noise_IK initiator
  with this machine's key, read at every request because a 409 can promote another,
  the link in `HELLO`, one `REQUEST`, one connection each so the relay reads the
  link's row every time. One retry after `421`, never two.
- **Receiving**, `principal.link` names the sending machine from the capability's
  claims — all three or the token is malformed — and the body names only the session
  on it, on that daemon's word. `session:message` reaches `/peer/*` and nothing else,
  and a person's capability never carries it.
- **A linked machine is not trusted to limit itself.** Every link has its own token
  bucket here, a message id is delivered once per link, and a notice is taken only
  when this machine asked for it, once (`expectedNotices`). A remote listing row is
  re-read field by field (`remoteRowOf`) and one naming a machine is dropped.
- **Offline is not a refusal.** A message for a machine whose tunnel is down goes to
  `peer_outbox` and is retried, byte-identical so its id holds, from 30 s to 10 min
  apart for 24 h; a refusal or expiry wakes the sender with a notice saying so.
  The relay may queue nothing and the Authority may hold none of an agent's work, so
  this daemon is the only place it can wait.
- **No link back, no reply.** The envelope says so, and `send_message` does not
  promise a notice it cannot deliver.

## Handing machines their links (the app)

**The app carries every link; no daemon asks for one.** At the end of each
`resume` the store runs `LinkSync.syncAll`: for each machine you own, enrolled, on
the relay and not probing as offline, `POST /v1/machines/:id/links`, then
`PUT /peers/links` with the answer unread. `linkSyncDecision` is the whole rule and
is pure: again when `linkTargets` changes (this client's count, never the control
plane's answer, which also skips keyless machines and would read as a change on
every wake), when the earliest pushed token has under 45 days left, or when the
last sync is over a day old. A failure waits `LINK_RETRY_AFTER_MS`, since a sync
spends the write budget a token mint does. A bare 404 from the daemon means too
old, remembered against its `instanceId`, never its version label (compatibility
rule 1). Nothing toasts; the Agent links screen is where failures are read.

**Agent links is a machine's leaf**, `/settings/machines/:id/links`, for its owner,
a table — Direction · Machine · Replace. **Replace does not unlink**: the next sync
links every pair of your machines again, so it ends a link and its token and hands
the machine a new one, and the screen says so (Q7.151).
