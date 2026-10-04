---
paths:
  - src/peers/**
  - src/session.ts
  - packages/web/src/peer.ts
  - packages/web/src/ui/PeerMessage.tsx
  - packages/web/src/ui/SentFile.tsx
  - scripts/daemoncheck.peer-messages.ts
  - scripts/daemoncheck.sent-files.ts
  - scripts/relaycheck.peer-e2e.ts
  - packages/web/scripts/webcheck.peer-messages.ts
  - packages/web/src/agentLinks.ts
  - packages/web/scripts/webcheck.agent-links.ts
  - packages/web/src/ui/settings/AccountMessaging.tsx
  - packages/web/scripts/webcheck.permissions.ts
  - packages/control-plane/src/permissions.ts
---

# Messages between agents

Every agent declaring an http MCP client gets one server, `reemoat`, with `list_agents`
and `send_message`, on one machine and across the owner's machines; a session elsewhere
is `name [machine/session]`. Read Q7.150 before adding a network path here.

## The door

**One MCP server per launch, injected after `initialize`.** `SessionOptions.mcpServers` is
a callback (`mcpCapabilities` is known only then), handed by `launchOptions` to all three
open sites; `/clear` reuses its process's list. `PeerMcpEndpoint` is its own `127.0.0.1`
listener on an OS-picked port whatever `REEMOAT_HOST`/`REEMOAT_PORT` say
(`REEMOAT_PORT=0` means no listener): hand-written Streamable HTTP, JSON only, no SDK.

- **A bearer per launch, never per session**: `mcpServersFor` mints one and retires the
  previous; it is also retired by token when its process ends. It names the caller and is
  hygiene, not a fence; across machines the identity is the machine key (Q7.150).
  claude's goes into `REEMOAT_MCP_BEARER` before the spawn, the header naming the variable
  (`mcpBearerEnv`), since the SDK puts MCP config in argv. Q2.236.
- `Origin` on a request is refused. `server/discover` answers `-32601` on purpose: claude
  and grok fall back to `initialize` on exactly that. Q6.114.
- An agent without an http client gets no tools (no stdio shim until a measured harness
  needs one) and can still receive.
- No claude session has its own `ListAgents`, tools handed or not (`harness-tools.md`);
  each tool carries `anthropic/alwaysLoad`, or claude defers it behind its tool search.
  Its `SendMessage` stays. Q2.242.
- `REEMOAT_PEER_MESSAGES=off` injects no messaging tools, refuses every send, takes no
  notice and pumps no outbox (`peer_outbox` keeps what it held). No switch below lifts
  it.
- **Two tools on the server are not messaging** and no messaging switch withdraws them,
  each being for the session's own person: `ask_question` for `QUESTION_TOOL_HARNESSES`
  (Q2.250) and `send_file` wherever there is an upload store (`sendsFiles`). The endpoint
  always listens, the server is injected with those alone when messaging is off, and
  `callTool` answers both before `callRefusal`. `tools/list` and the instructions are per
  caller.

## A file sent on purpose (Q2.252)

`send_file` copies the file as it stands into the session's upload store and appends
`file_sent` with a `StoredFileRef` — never a path in the log, never contained. A refusal
says what the path is, in words to the model; every answer names the path read, in the
structured half too.

- **`Uploads.keepAgentFile`'s order is the rule**: probes, an `O_NONBLOCK` open, the copy
  under a byte counter and the abort signal, then the row and `kept` in one synchronous
  block, then eviction. `kept` is where `sendFile` checks the session still runs and
  appends `file_sent`, so a Stop mid-copy keeps and evicts nothing (Q2.253). One call at a
  time per session, 45 s for the whole call including its wait, under an MCP client's
  60 s; a source call still out then is a stall (`noteStalled`).
- `f_` rows are a third budget with their own rate window (`files-paths-git.md`).
- `sentFileName` strips controls, bidi and zero-width characters (`sanitizeUploadName`
  alone lets a reversed extension through).
- **The daemon answers the permission in front of it**: claude via `allowedTools` in
  `sessionMetaFor`; cursor and grok by `allow_once` on the call `ownToolCall` recognised.
  Never `allow_always` (it writes a rule into the harness config), `ask_question`
  included; each shape read for its own harness only. Only a call the harness vouched for
  (`vouched`): for grok the `variant: "UseTool"` on the request itself (`fromRequest`), as
  `rawInput` is model-typed. A claude request that still arrives is its person's; a call
  that ended or changed identity, a subagent's, or an unrecognised one goes to the card.
  Q2.253.
- **The card stands for the call** `claimSentFileCall` names (`file_sent.toolCallId`):
  `tail.ts` drops its row and the daemon's answer via `askedThrough`. Its own slot, never
  `unclaimedPosedCall`; oldest first by path; an unclaimed call is dropped at its turn's
  end and at a `/clear`.
- The app ships before the daemons: an older app draws nothing for `file_sent`.

## Every message is acted on (Q2.243)

`send_message` wakes an idle session, steers into a running one, or queues behind an
unsteerable turn. Nothing waits for somebody else's turn, so an answer wakes its reader.
No `wait` tool.

**The idle notice is off unless asked for, and stands in for an answer.**
`notify_when_idle` wakes its sender once if the recipient goes idle or ends without
writing back; writing back cancels it (`answered`), and on the other machine the answer's
arrival forgets it. An agent restart keeps it; a daemon shutdown sends nothing.

## Delivery is the prompt route's, not a copy

- `readyForMessage` is the route's three waits (restart, workspace, released agent), in
  its order, joining a launch under way. The route and the plugin API's `sessions.prompt`
  call it as `"person"`, the hub as `"peer"` (`Waker`).
- `submit` is `prompt` then `sendMidTurn`; the route does not use it (its two `busy`s
  answer differently).
- A peer message is a `prompt` event with `from` set and `text` exactly what the agent
  received, envelope included, so an older client shows the envelope, never the person's
  words.
- `recordPrompt` names a session only from a person's or a plugin's message; only a
  person's (a `/clear` too) resets `peerTurnsSinceHuman` and `peerDepth`. A plugin's
  neither resets nor counts and logs `from: null`, its `ask_question` answer included.
- Peer entries hold at most `MAX_QUEUED_PEER_PROMPTS` of the queue, so another agent never
  makes a person's message answer 429; consecutive ones go as one turn (`deliverQueued`).

## The envelope

`peerMessage` builds it from `PeerOrigin`, the daemon's record of the sender; only `name`
derives from typed text. `defuse` breaks every tag a harness or this daemon writes
(`peer-message`, `system-reminder`, `teammate-message`, claude's `command-*` and
`task-notification`, codex's `user_instructions`, …; underscored tags listed, as `\b`
does not stop at `_`) and every `Human:`/`Assistant:` line. Attributes are escaped, and so
is a sender's name or address wherever this daemon's words carry it. A remote session
name is taken only if `isPeerName` passes. The prompt starts with `<`, so no adapter reads
a slash command. `IMITATED_TAG` also holds the `@name` note's tag
(`session-nicknames.md`).

## What stops a loop (Q2.238)

This daemon, never the model: `PEER_TURN_BUDGET` agent-caused turns without a message
from the person (refused, one line in the recipient's transcript), `MAX_PEER_HOPS`, a
token bucket per sending session, the same words to the same session within a minute,
`MAX_PEER_MESSAGE_CHARS`. Notices count against the budget; one past it is dropped.

## Who may be reached (Q2.239, Q2.245)

A live session, or one ended for a reason in `PEER_WAKE_REASONS`. A person's Stop is
theirs to undo: another agent can neither list nor wake that session, nor can it send
(`ended`). `wakesOnPrompt` is asked in the tick `resume()` starts in.

The ref settles an address; the name (the nickname, or an older daemon's `peerName` slug)
is a label. A name naming this machine resolves here. A bare name is matched against what
`list_agents` shows the caller (never itself or a stopped session) on every machine, so
it waits on those listings; a qualified address fetches none. Never by elimination: with
a listing unchecked, one match is `ambiguous_recipient`, none `unknown_recipient`, each
naming the machine.

## Who may switch it off (Q2.244, Q1.654)

Account, machine, conversation — each only narrows; all three and the env must allow.

- The first two live on the Authority (`account_permissions`, `machine_permissions`),
  reaching a daemon as the mint answer's `messaging` and `policyAt` via
  `PUT /peers/links`; off revokes the affected `machine_links` rows in the same write. A
  daemon keeps the newer `policyAt`; an absent `messaging` changes nothing; its copy is no
  fence (`machine:admin` can push one).
- The third is `peer_messages_off` (`POST /sessions/:id/meta`): not listed, refused both
  ways (`conversation_messaging_off`), no tools at the next launch.
- **Every gate reads `allowed` live**: `mcpServersFor`, `callTool`, `localRows`, `send`,
  `receive`, `receiveNotice`, the outbox pump, the idle notices. A new path needs it too.
- A running agent keeps its tool names and gets a sentence; never revoke its bearer (a
  `401` reads to claude as a sign-in).
- Off drops what waits — queued peer prompts (mid-steer too, `peerDrop`), idle-notice
  subscriptions, the outbox — with one quiet line per sender, no wake.
- Isolated (`reachesOthers`, `messaging_isolated`): local only; the Authority revokes and
  mints no links; going isolated empties the outbox.
- Link sync reads the listing's `agentMessaging`, never `me`'s, re-syncs on
  `policy_changed` (loopback-only machines too) and 30 s after a failure. A keyless
  machine takes its switch from the `machine_key_missing` refusal's `detail`, pushed with
  an empty set.

## The row

`PeerMessageRow` draws left-aligned under *Message from*, never a `UserBubble`; `peerBody`
unwraps the envelope. A notice is one faint line. Markdown; *Show all* mounts a fresh
`Markdown` (the stream throttle would hold changed text back).

## Another machine (Q7.150)

A link is a capability the target's Authority minted for this machine's key, scope
`session:message` only, written whole into `peer_links` by the owner's app
(`PUT /peers/links`). This daemon never asks a control plane for one.

- **Sending** is `peerRequest`: Noise_IK initiator with this machine's key (read per
  request; a 409 can promote another), the link in `HELLO`, one `REQUEST`, one connection
  each so the relay reads the link's row every time. One retry after `421`, never two.
- **Receiving**, `principal.link` names the sending machine from the capability's claims
  (all three or malformed); the body names only the session. `session:message` reaches
  `/peer/*` only; a person's capability never carries it.
- **A linked machine does not limit itself**: a token bucket per link; a message id
  delivered once per sending machine, in `peer_seen` for a day (a retry mid-delivery gets
  that try's answer); a code `PeerRefusal` lacks is `link_refused`, its words one line of
  `MAX_REMOTE_REFUSAL_CHARS`. A notice is taken only when expected, once
  (`expectedNotices`). `remoteRowOf` re-reads a listing row: one naming a machine is
  dropped, an unknown status is idle (`compatibility.md` rule 2).
- **Offline is not a refusal.** No tunnel, the relay's 421/502/504, the daemon's 503 or no
  answer → `peer_outbox`, retried byte-identical 30 s to 10 min apart for 24 h. Retries
  wait out `rate_limited`, `busy`, `starting`, `queue_full`; a delivery cut by shutdown
  answers `503 shutting_down`, not `ended`; `duplicate` is an earlier try that landed and
  re-arms the idle notice. Any other refusal, or expiry, wakes the sender with a notice.
  The relay queues nothing and the Authority holds none of it: only this daemon waits.
- **No link back, no reply**: the envelope says so; `send_message` promises no notice it
  cannot deliver, nor one for a held message.

## Handing machines their links (the app)

At the end of each `resume` the store runs `LinkSync.syncAll`: per owned machine
(enrolled, on the relay, not probing offline) `POST /v1/machines/:id/links`, then
`PUT /peers/links` with the answer unread. `linkSyncDecision` is the whole pure rule:
again when `linkTargets` changes (this client's count, never the control plane's), when
the earliest pushed token has under 45 days, or after a day. A failure waits
`LINK_RETRY_AFTER_MS`. A bare 404 means too old, remembered against `instanceId`, never
the version label. No toast, no line under a switch, no links screen (Q3.675, Q3.676).
