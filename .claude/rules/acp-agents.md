---
paths:
  - src/acp/*
  - src/session.ts
  - packages/web/src/ui/tail.ts
  - packages/web/src/ui/EventList.tsx
  - packages/web/src/ui/PermissionCard.tsx
  - packages/web/src/ui/ElicitationCard.tsx
  - packages/web/src/elicitation.ts
  - packages/web/src/permission.ts
  - packages/web/src/ask.ts
  - scripts/pincheck.ts
---

## Ultracode

**One setting this daemon asks for that ACP has no field for**, and the only place
a control on screen is not something an agent published. `ultracode` is claude's
own — *"xhigh effort plus standing dynamic-workflow orchestration"* — and reachable
only through `_meta`: `claude-agent-acp` reads `params._meta.claudeCode.options` on
the session-opening request. `sessionMetaFor` in `src/acp/agents.ts` is the one
place that shape is written, and `SessionOptions` takes a **boolean** rather than a
blob so no call site can invent a vendor shape. Q2.43.

**It is a row on the agent's own effort control, added on the way to the snapshot
only.** `withUltracode` never touches the state `setConfigOption` validates
against, which is the split that keeps the value from ever reaching the agent, and
it reports the choice as the selection while it is on **because the agent cannot
report this state at all** — a session running with the flag on still publishes
`effort=default`. There is therefore no ACP-visible confirmation that it took, and
what this daemon can prove is what it *sent*, which `daemoncheck` asserts by
standing in as the agent and reading the `session/new` it received.
`ultracodeOptionId` places the row **by category and never by id**, refusing when
the agent is not claude, has no effort control, or offers no `xhigh` — the last a
capability test read off the agent's own answer. An agent that ships its own
`ultracode` choice takes the row back.

**Choosing it restarts the agent, and that is the setting's nature rather than an
implementation detail** — it is read when a conversation is opened, so turning it
*off* means opening one without it. `applyUltracode` writes the choice, then
`stop("config_changed")` and `resume()` on the same `agentSessionId`. Three
consequences: `config_changed` is a **daemon** exit (`interrupted`, auto-resumed on
both triggers); a turn in flight refuses `409 turn_in_flight`, the one refusal on
`/config` that really is about a turn; and the choice is written *before* the
restart, so one that fails leaves a session that knows what it was asked for.

**The choice is three-valued and the column is nullable** — "nobody has chosen"
follows `REEMOAT_CLAUDE_ULTRACODE` at every launch and "chosen off" outranks it for
ever — and the default is read through a thunk, for the reason `elicitationAllowed`
is one: `restore()` runs before `daemon.ts` reads the environment. **The client never puts the word `ultracode`
into a message**: it works as a keyword typed by a person (the adapter stamps
`origin: {kind: "human"}` on every ACP prompt precisely so that gate accepts one),
and typing it for somebody would be putting words in the operator's mouth inside
the model's context.

## Asking you a question

**The elicitation capability must be declared or claude deletes its own
ask-the-user tool** — `disallowedTools` strips `AskUserQuestion` unless
`clientCapabilities.elicitation.form` is present, and the model's only move when it
needs a decision is then to guess. One capability and one handler; no MCP tool,
because a second way to ask on one agent is worse than none. Q2.14.

**kimi asks through the permission channel instead**, surfacing its own
`AskUserQuestion` as a `session/request_permission` titled `AskUserQuestion`.
**Nothing detects that, and nothing should** — recognising a permission as a
question by its title, or by "every option is `allow_once` bar one", is the id-keyed
guessing this codebase refuses everywhere. What is unified is the *chrome*, by
**sharing a component rather than resembling one**: `ui/AskCard.tsx` is the frame,
`PermissionCard`/`ElicitationCard` are two bodies. Q2.15, Q2.16.

**codex sends `elicitation/create`, the method `AcpClient` already registers, and
its keys are different from claude's** — `<question>__other` against
`<question>_custom`, plus a `_meta.codex` block on every property. `toElicitationForm`
projects both onto the same two fields, which is what makes the difference invisible
to a card. `_meta` is
dropped at ingest and the suffix is never parsed, because a client keyed on either
name would render one agent's question and refuse the other's; both fixtures sit in
`daemoncheck` beside each other. codex's model-initiated question is behind its own
`default_mode_request_user_input` feature flag, which is off and which this daemon
does **not** flip; `tool_call_mcp_elicitation` is stable and on, so MCP tool
approvals arrive as elicitations with no flag at all. Q6.54.

**It is gated rather than merely undeclared.** `LaunchOptions.elicitation` is
required with no default, the handler is registered unconditionally and answers
`methodNotFound` when declined, and `REEMOAT_ELICITATION=0` withdraws it. Unlike
the `fs` gate this one changes what the *model* does. Q2.18.

**Absence is the only way to say no**, and that is a third capability shape read a
third way: `promptCapabilities.image` is a declared boolean (`=== true`),
`sessionCapabilities.resume` an empty-object marker (`!= null`), and
`ElicitationCapabilities.form` a marker with **no `false`** — the key must be
omitted entirely, and `{form: false}` is `TS2559`.

**`url` mode and request scope are refused**, both `invalidParams` and never
`methodNotFound`, which would claim the whole capability is absent. Opening a URL
means launching a program named by an agent-chosen string on a host driven from a
phone; request scope has no session to block and no row to find it on. Q2.20.

**An unrenderable request is a JSON-RPC error, never a fabricated user action** —
`{action: "decline"}` is a lie, nobody declined — and `handleAskUserQuestion` turns
that error into `{behavior: "deny", message: …}`, so the model is told why and
carries on. Q2.21.

**The tag chooses the arm and each arm validates only what it reads**: strict about
what is used, lenient about what is ignored. The SDK's
`ElicitationPropertySchema.is*` guards are refused here, because they validate the
whole payload rather than the tag and an unexpected field then refuses the form for
an unrelated reason. Q2.22.

**Structure is refused and prose is carried whole** — too many fields or options,
an over-long option value, an unknown property type or an over-large projected total
refuses the whole elicitation naming the cap. A form missing a question is not a
smaller form (its answer *means something different*) and an option value
round-trips to the agent. ⚠ **Prose used to be clipped and is not any more**: with
several questions on one form the adapter puts each *question* in its field's
`description`, so a 300-character cap was a cap on the sentence somebody is being
asked to answer — measured, one real option description was 318 characters and was
being cut. The 32 KiB byte total is the only bound left. `pattern` is dropped at
ingest: an agent-chosen regex run here is a ReDoS on the event loop, and carrying it
only moves the hazard into a tab. Q2.23, Q2.214.

**The form does not ride the snapshot**, and is therefore not on the *event*
either: the snapshot carries `message` and a field count, and
`GET /sessions/:id/elicitations/:id` serves the fields when a card opens. A pending
permission earns its 8 KiB because a blocked session has to be answerable *from the
list*; a question is not. Q2.24.

**A resolution is self-describing.** `ElicitationResolvedEvent` carries the answer
as `label`/`value` pairs — the field's title and the option's *title*, never its
wire value — so a transcript draws it with no join back to the request.
(`PermissionResolvedEvent` carries only an `optionId`, which is how a refused
command came to be drawn with a check mark.) Each `value` is clipped **for the log
alone**; what reaches the agent is verbatim. Q2.25.

**One counter mints both kinds of id**, `perm-N-salt` and `elic-N-salt` from the
same `askSeq`/`askSalt`, and `looksLikeOurs` takes the prefix — so *"too old to
report must never come back as never existed"* is one rule with two callers. The
SQL columns are still `perm_seq`/`perm_salt` (SQLite cannot rename without
rewriting a table holding every transcript on disk); in TypeScript the type is
`AnswerResolvedBy` and the fields are `askSeq`/`askSalt`. Q2.26.

**`decline` and `cancel` are different acts and the route offers both.** Declining
runs the tool with empty answers and the turn *carries on*; cancelling throws and
the tool call dies. The card offers Skip and Send; cancel is what every sweep sends
— stopping the session, and now also stopping the *turn*.

**Nothing answers on your behalf.** `Session.onPermission` falls back to allow-once
with no resolver because that is a defensible default; a question has none, so a
session with no resolver never declares the capability and the agent is never
handed the tool. Q2.28.

## Invariants

**Subagents**

- **A subagent is a tool call that started other tool calls, and the daemon never
  reorders to prove it.** The parent link is carried and nothing else: no depth, no
  synthesised parent, no buffering of a child until its parent is seen, no "seen
  ids" set. Arrival order stays seq order stays delivery order.
- Three rules for the reader, written into `wire.ts` because nothing enforces them:
  a parent may be absent and that is **normal**; a child may arrive first; and
  **every traversal must be cycle-safe**. `MAX_DEPTH` bounds *indent*, not hops, and
  a **visited set per walk** is the actual requirement. Q5.42.
- The parent id is **bounded at ingest** (`MAX_PARENT_ID_CHARS`), because
  `truncateEvent` spreads the field through untouched on both arms by design. Q5.43.
- **Layout is decided by whether a call has children** — never `kind === "think"`,
  never a title match. What the agent's own `subagent` flag decides is whether the
  card is *drawn* as a delegation, read from the `tool_call` and never merged from
  an update, because claude drops it on the spawn's own completing update.

**Config, commands and the snapshot**

- **The agent's controls are complete state on the snapshot, never a delta and
  never only in the log.** ACP's `current_mode_update` carries just the new mode id,
  so `session.ts` merges before emitting `agent_config`. They ride `SessionSnapshot`
  because they are **state with one current version**, out of a log that evicts a
  *prefix*, and because a **restored** session has no live agent to have published
  them at all.
- **Snapshot is not the same as poll.** `unsubWatch` pushes a snapshot frame to
  every attached client on every `touchSafe()`, so "snapshot-only" costs nothing in
  latency and keeps state that does not belong in a transcript out of the log.
  `title`, `pinned` and `contextUsage` are snapshot-only for that reason.
- **A streaming measurement is fanned out on the value a client can see.**
  `usage_update` comes out of the `message_delta` handler, i.e. essentially every
  output token, and `touchSafe()` builds a snapshot and enqueues a frame *per
  client* on the agent's synchronous emit path. `applyContextUsage` assigns every
  time and calls `touchSafe` only when the whole percent, window or cost changed.
- **A config option is found by `category`, never by `id`.** claude publishes effort
  as `effort`, kimi as `thinking`; they share nothing but `category`, so an unknown
  one renders as a plain labelled control. The *values* are not hardcoded either.
  That rule decides *names* too: `/model`, `/effort` and `/mode` are built from the
  controls, and the name is ours precisely because the id is not portable.
- **A command list is state, is replaced whole, and does not ride the poll.**
  Replaced whole because ACP defines the update as a full list; not appended to the
  log, because it is superseded whole and the log evicts a prefix. Only
  `commandsRevision` rides the snapshot, and a client refetches on `!==` and never
  on `>`, since a restart puts the revision back to 0.
- **Neither switch over `SessionEvent["type"]` has a `default` arm**, and that is
  load-bearing rather than tidy: with one, a new event type carrying agent-chosen
  prose is charged a flat 192 bytes against the byte budget and never truncated,
  silently and with the compiler agreeing. Do not reintroduce a `default` to quiet
  the error that adding a member causes; add the arm. Q5.65.
- **The login command is a table lookup, never a request field.** There is no route,
  body field or header anywhere that names a program to run — so "a caller cannot
  run code of their choosing as the daemon" is a property of there being nothing to
  pass. This daemon is reachable from the internet through the relay.
- **The login probe runs with the pasted credential in its environment.** The whole
  asymmetry rests on it: a clean `false` from `claude auth status` is believed over
  a pasted token, and "cannot tell" falls back to it — only honest if the CLI has
  *seen* the token. Without it a wrong token reports `loggedIn: true` and the first
  session answers `502 agent_auth_required`. Q5.67.

**The client**

- **The ACP `fs` capability is granted, and the gate that could decline it stays.**
  There is no sandbox, so refusing would confine nothing. But **declaring a
  capability is a statement to a party we do not trust, and a statement is not a
  gate**: `AcpClient` answers `methodNotFound` when declined and
  `LaunchOptions.fileIo` is **required**, so deleting the argument is a type error
  rather than a silent grant. Q5.37, Q5.38.

## Layout

| File | Holds |
|---|---|
| `src/acp/agents.ts` | How each agent is launched, how each logs in, how to ask whether it already has. Strips the parent's session env and everything `REEMOAT_*`. The only place PATH is walked |
| `src/acp/subagents.ts` | Which tool call a tool call ran inside. One of the **two** places claude's `_meta.claudeCode` shape is known — this is the inbound one, projected to two scalars; `acp/agents.ts`'s `sessionMetaFor` is the outbound one |
| `src/acp/client.ts` | JSON-RPC over an agent's stdio, routed by `sessionId`. Takes an `AgentProcess` rather than spawning — which is what lets a driver stand two `PassThrough`s in for an agent |
| `scripts/pincheck.ts` | Each ACP adapter's version: exact, agreed across files, and matching what is *actually installed* — and that the CLI platform packages each adapter declares are the ones `pnpm-workspace.yaml` excludes, since no CLI is vendored (Q4.114). A loop over a list, because written around one constant it pinned the second adapter nowhere |

## Bounds

| | |
|---|---|
| Permission payload | 8 KiB each for `rawInput` and `content`, and **8 KiB over `{title, options}` together** (`MAX_PERMISSION_SNAPSHOT_BYTES`) — far below the per-event cap because all of it rides the snapshot. **24 options**, `optionId` 256. **Every one is a refusal now** (`invalidParams` to the agent): an `optionId` round-trips verbatim, so a clipped one is an answer the agent cannot recognise, and the two 200-character clips on `title` and an option `name` went in 0.3.0 — that name is a model-written *answer* wherever kimi asks a question down this channel, and clipping it broke `askedQuestion`'s identity match against the unclipped `rawInput`. Q7.82, Q2.214 |
| Tool call locations | 64 per event, 1024 chars each, **and counted** — `estimateBytes` must charge for `locations` and `toolCallId`, since the per-event cap, the per-session byte budget and `MAX_QUEUE_BYTES` all read that number rather than the payload. Q7.83 |
| Agent commands | 256 per session; 64 chars of name, 200 of description, 100 of hint, clamped at **ingest**. **The name cap is a refusal and the other two are truncations** — a command is invoked by *sending* `/<name>`, so a clipped name is broken rather than shorter. What is cut is *counted* into `dropped`, and the menu draws that count. Off the snapshot; only `commandsRevision` rides the poll. The hint cap sits *above* the longest real hint on purpose: a bound set to the largest thing you have seen clips the next one. Q6.18 |
| Elicitation form | 24 fields, 24 options per field, **32 KiB** projected total, option value 512 — all four **refusals**, and now the only bounds there are. **Prose is carried whole**: the 512/100/300 clips on `message`, a title and a description went in 0.3.0, because with several questions on one form the *question* is the field's description. 32 KiB rather than a permission's 8 because the form does **not** ride the snapshot. An answer over 2048 chars is refused on the route, never cut. Q2.214 |

## Known gotchas

- **`session_started` lands in the log when the agent is adopted** and nothing draws
  it (`TRANSCRIPT_SILENT`) — a fact about the log rather than a screen, with
  `daemoncheck` pinning the first five rows. The registry still appends its own
  `status` at seq 1 and carries `agent`/`cwd`/`agentSessionId` on the snapshot.
  Q6.1.
- **A pending permission's command is in `content`, not `rawInput`.**
  `PendingPermissionSnapshot` carries both, clamped to 8 KiB; treating text blocks
  as decoration is the trap. Q6.2.
- **A codex permission carries no title and no `kind`**, so
  `title = toolCall.title ?? toolCall.toolCallId` would put a uuid in the heading —
  `permissionHeadline` infers the verb from `command` when `kind` is null, and
  `webcheck` pins that the uuid never reaches it. Two of its four options are
  `kind: "allow_always"`, the first duplicate kind any agent has sent, and its
  `rawInput.command` is **double-quoted**, drawn as sent because trimming would be
  this client editing a command somebody is about to approve. Q6.55.
- **codex emits `session_info_update` about five times a turn**, which becomes an
  `other` event — invisible rather than wrong, and still written to a log that is
  never truncated. Q6.100.
- **The permission diff branch's text block is nested**,
  `{type: "content", content: {type: "text", …}}`, so a renderer matching a flat
  `{type: "text"}` walks straight past the description. `oldText`/`newText` are the
  changed **fragments, not whole files**. Q7.29.
- **One tool call is five events, and every useful field is on a different one.**
  `EventList` resolves each separately: newest non-null status and title, newest
  **non-empty** arguments (an empty object is not null), every content block that
  says something of its own, and the markdown fence around output stripped. Q6.10.
- **The model also types its arguments into the output channel one token at a
  time**, so one `Write` is a `tool_call` plus hundreds of growing drafts.
  `supersedes` and `restatesInput` in `tail.ts` fold them — strictly extended by the
  next, or parsing to the call's own `rawInput` — and neither reads an id, a title
  or a vendor name, so a tool whose blocks are *incremental* rather than cumulative
  matches neither and is untouched. Q6.10a.
- **The daemon holds those drafts back rather than writing them.**
  `Session.toolDraft` sends the held update when the run ends — flushed by the next
  event for any call, by `turn_end`, by `error` and by `doDispose`. **Held, not
  dropped**: the last block is the only complete one, and a tool whose output really
  is cumulative would lose it. Anything carrying news — status, title, arguments,
  locations, images — goes out at once, which keeps `in_progress` from being held
  behind a thirty-second write. ⚠ **The same rule as `tail.ts`'s `supersedes`,
  written twice**, since `packages/web` cannot import from `src/`; they need not
  agree, because the client's fold is the guarantee and the daemon's an optimisation
  on top — suppressing *less* costs bytes, suppressing more than the client can fold
  loses content. Q6.10a.
- **A tool's output arrives on `tool_call_update.content` — except on codex**, which
  sends no content block at all and puts stdout on `rawOutput.formatted_output`.
  `rawToolOutput` reads that key **only where the blocks carried nothing**, which
  keeps claude (which sends both) from printing one command twice.
  `type: "terminal"` is still dropped, being a live handle rather than a value; the
  exit code stays out of the prose, since `status: "failed"` already says it; and
  the streaming half is deliberately not taken, because it changes what *claude*
  sends. Q6.11, Q6.58.
- **A tool card opens only to what its row is not already showing** —
  `opensToAnything` in `tail.ts`, because `toolSummary` answers one string as both
  `summary` and `detail` whenever the arguments yield a command. The row clips at
  `SUMMARY_CHARS` **in this file rather than in CSS**, so "was anything cut off" is
  a question the code can answer; and the row does not draw the headline when it
  **is** the title. Q6.101.
- **An agent may *refine* its arguments rather than fill them in once, so "newest
  wins" has to mean the call too** — codex puts a placeholder object on the
  `tool_call` (four keys, so `hasInput` is true) and the real query on the update
  that follows. Both directions must hold at once: claude sends `{}` on the call,
  where a plain `??` picks the empty object and no command ever appears. Q6.102.
- **An `Edit` emits `file_change` twice, and only the first carries a
  `toolCallId`** (`source: "diff"`, then `source: "fs_write"` with null). Anything
  deduplicating by path has to expect the pair. Q6.12.
- **Subagent lineage rides `_meta` and is not on every event that has it**, and the
  spawn loses `subagent: true` on its own completing update — so absence means "this
  event did not say", never "top level", and both must be read **first-non-null**.
  Keyed on the flag a renderer flickers off at the end of every subagent; read as
  top-level a daemon scatters half the steps back into the transcript,
  intermittently. Q6.3.
- **A subagent's own text and thinking are not forwarded**, gated on
  `clientCapabilities._meta["subagent-transcript"]`, which we do not send. Budget,
  not trust: what survives is what the subagent *did* and what it *concluded*. Q6.4.
- **`Task*` is not the Task tool.** `isTaskTool` matches
  `TaskCreate|TaskUpdate|TaskList|TaskGet`, so `shouldEmitToolCall("Task")` is true.
  On claude 2.1.220 the tool is named `Agent`; the adapter maps both. Q6.5.
- **A subagent's `TodoWrite` would clobber the main agent's plan and cannot reach it
  today** — subagents have no `TodoWrite`, and a main-agent `plan` carries no `_meta`
  to attribute, which is why `PlanEvent` has no parent field. One `TodoWrite` emits
  a `plan` per streaming refinement, each a full replacement. Q6.6.
- **A subagent emits no heartbeat**: a running spawn sits at `pending` until it
  completes. Q6.7.
- **Nested delegation exists but is flat** — every other call comes back parented to
  the **outermost** spawn, so no third level is reachable. Q6.8.
- **`usage_update` fires on every output token, and `turn_end.usage` is a different
  quantity**: `{used, size}` occupancy *right now*, state, riding the snapshot as
  `contextUsage`, against cumulative counts for one turn that are narrative and stay
  in the log. Merging them would be wrong in both directions. Q6.9.
- **kimi never reports context usage at all** and no client change fixes it, so the
  popover names the agent and points at `/usage`. **Asking for it ourselves is not
  possible** — ACP has no request for usage, and sending `/usage` as a *prompt*
  spends the session's one turn. Q7.26, Q7.27.
- **`usage_update._meta` is dropped, and it carries `_claude/rateLimit`** — the
  field that answers "why has this stalled". `_meta` is an unbounded agent-shaped
  blob and `contextUsage` rides a snapshot returned sixty at a time. Q7.25.
- **`available_commands_update` always arrives outside a turn**, scheduled
  `setTimeout(…, 0)` after `session/new`, so it lands before any prompt exists to
  drain `EventQueue` and becomes an `other` event nothing renders — `onStarted`
  reads once before subscribing. A second window is `AcpClient`'s
  `router.sessions.get(id)?.onUpdate(...)`, which **drops** an update for a session
  not yet registered: a real pipe hides it, a `PassThrough` in one process loses
  every time, hence `daemoncheck` pushing on a delay. Q6.15.
- **Two different commands can share a name.** `toCommands` keeps the first and
  counts the second into `dropped`; typing `/review` could only ever reach one.
  Q6.16.
- **claude and kimi publish opposite things, so a client tested on one is wrong on
  the other** — codex's publishing behaviour is not measured. claude republishes
  mid-session and kimi never does, which is what `commandsRevision` exists to
  prevent; claude publishes `/model` and `/effort`, kimi neither, and neither
  publishes `/mode`. **`/clear` is filtered by the adapter, not this daemon** —
  typing it still works. Q6.17.
- **kimi intercepts an unknown slash command; claude forwards it.** This client does
  not paper over it: an unmatched `/foo` is sent as typed, because the cached list
  can lag what the agent accepts. Q6.19.
- **ACP has `session/authenticate` and this daemon never calls it.** Gemini offers
  four `authMethods` and expects the client to pick one; any future agent support
  has to decide whether to drive it. Q6.20. opencode advertises one too
  (`opencode-login`, described as "Run `opencode auth login` in the terminal"),
  and ⚠ **is not signed in at all** — `AGENT_LOGIN.opencode.args` is `null` and no
  pty is ever allocated for it, which this line claimed the opposite of for two
  releases. Q6.105 is the measurement: it completes a turn with no credential.
- **`session/set_config` and `session/set_config_option` are different methods,
  and only the second is this daemon's.** opencode answers `-32601` to the first
  and implements the second — so an upstream issue closing "per-session model
  selection" as *not planned* describes a door nothing here uses. Reading it
  instead of running the binary would have bought a whole new environment-based
  model door that is not needed. Q6.105.
- **⚠ opencode's options do *not* arrive in two waves, and the note that said so
  was an inference from one model.** `thought_level` is published for a model that
  has levels and omitted for one that does not — at `session/new` exactly as in
  every answer after it. Re-measured 2026-08-27 on 1.18.23 with one OpenRouter key,
  three probes: `set_config_option` on the **mode** of a session running
  `openai/gpt-5` returns `thought_level` untouched beside it, so an answer is a
  full option list rather than a delta about the option that was set; with a
  project `opencode.json` naming that model, **`session/new` itself carries the
  control**; and `openai/gpt-5` answers `Minimal/Low/Medium/High` while
  `minimax/minimax-m3`, `deepseek/deepseek-r1` and opencode's own default
  `opencode/big-pickle` answer with no effort control at all. So the model decides,
  exactly as it does on claude — the only difference is that opencode never
  publishes the control rather than withdrawing it. **The old wording matters
  because a client cannot tell "wave one is incomplete" from "this model has no
  levels", and it would have to refuse to say anything if the first were true.**
  Q3.518 is what the strip does with the answer. Q6.105.
- **opencode is the one agent whose control vocabulary needs reconciling twice.**
  It calls the mode control `Session Mode` where the other three call it `Mode`,
  and it publishes its mode *choices* in lower case (`build`, `plan`) where the
  others publish `Plan Mode`, `Accept Edits`, `YOLO`. Its effort levels are already
  `Minimal`/`Low`/`High` like everyone's, which is why `choiceLabel` cases `mode`
  and nothing else. Q3.516, Q3.517.
- **opencode's model list is its provider keys.** Signed out it publishes six
  OpenCode Zen models; with an `OPENROUTER_API_KEY` in its environment, 362, of
  which 356 are `openrouter/…`. A *bogus* key is enough, because the catalogue is
  enumerated before it is authenticated. Q6.105.
- **`/undo` and `/redo` are unsupported over opencode's ACP**, by its own
  documentation, while working in its terminal. Nothing here drives them.
- **`claude-agent-acp` never consults PATH for its `claude`.** `claudeCliPath()` is
  two branches — `CLAUDE_CODE_EXECUTABLE`, else a `require` of a platform-specific
  SDK package with no `bin` entry — and with neither it **throws**. That package is
  excluded now (`pnpm-workspace.yaml`'s overrides, Q4.114), so the variable is the
  only door, and `LocalRuntime.launch` writes it on **every** spawn from the copy
  `agentCli` chose — `spawnPlan` is the decision. `CLAUDE_CODE_EXECUTABLE` survives
  `agentEnv`'s strip for the same reason. Q6.21.
- ⚠ **A machine with no `claude` therefore has the harness refused by
  `resolveAgent`, never by the adapter throwing.** `cliFor` asks the override, then
  PATH, then `MANAGED_CLI_DIRS`, and `describe()` fails with a sentence naming
  `deploy/agents.sh` (and `--source npm`, and the variable) — so `GET /agents`
  draws it unavailable rather than a session dying at spawn. History, and why the
  vendored copy went: it was exactly as old as the pin. Measured 2026-09-03, adapter
  0.63.0 vendored **2.1.220** (built 2026-07-24), which publishes
  `claude-fable-5[1m]` "Fable 5", while the *same* adapter pointed at a 2.1.259
  publishes `claude-fable-5-1[1m]` "Fable 5.1". The SDK does not verify the CLI it
  drives — it announces itself into its environment as `CLAUDE_AGENT_SDK_VERSION`,
  so the compatibility burden runs SDK → CLI and a newer CLI under an older adapter
  is the forgiving direction. Driven, not reasoned: every other control came back
  identical, choice for choice (`mode`, `effort` including `xhigh`, `fast`).
  `CODEX_PATH` is the same variable one adapter over — `codex-acp`'s
  `startAcpServer()` has the same two branches, and `@openai/codex`'s platform
  builds are excluded the same way; both are documented in `.env.example` and
  asserted by `deploycheck` off `AGENT_LOGIN[*].executableEnv`. Q6.106, Q4.114.
