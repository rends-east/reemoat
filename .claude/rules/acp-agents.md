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

- **The one setting ACP has no field for**: claude's `ultracode`, sent as
  `params._meta.claudeCode.options` on the session-opening request. `sessionMetaFor`
  (`src/acp/agents.ts`) alone writes that shape; `SessionOptions` takes a boolean. Q2.43.
- `withUltracode` adds it as a row on the agent's effort control in the snapshot only,
  never in the state `setConfigOption` validates, and reports it selected while on (the
  agent still says `effort=default`; `daemoncheck` asserts the `session/new` sent).
  `ultracodeOptionId` places it by category, only for claude with an effort control
  offering `xhigh`; an agent's own `ultracode` choice takes the row back.
- **Choosing it restarts the agent**: `applyUltracode` writes the choice first, then
  `stop("config_changed")` and `resume()` on the same `agentSessionId` — a daemon exit
  (`interrupted`, auto-resumed); mid-turn, `409 turn_in_flight`, the one `/config` refusal
  about a turn.
- Three-valued, nullable column: unchosen follows `REEMOAT_CLAUDE_ULTRACODE` at each
  launch; chosen-off outranks it. The default is a thunk, as `elicitationAllowed` is,
  since `restore()` runs before `daemon.ts` reads the environment. The client never puts
  `ultracode` into a message: the keyword is a person's (`origin: {kind: "human"}`).

## Asking you a question

- **Declare `clientCapabilities.elicitation.form`** or `disallowedTools` strips claude's
  `AskUserQuestion`. One capability, one handler. Q2.14.
- **kimi asks via `session/request_permission` titled `AskUserQuestion`**; nothing
  detects that by title or options. The chrome is shared by component: `ui/AskCard.tsx`
  frames `PermissionCard`/`ElicitationCard`. Q2.15, Q2.16.
- **codex's `elicitation/create` keys differ** (`<question>__other` against
  `<question>_custom`, `_meta.codex` per property); `toElicitationForm` projects both and
  never parses the suffix. Both fixtures sit in `daemoncheck`.
- **From `_meta` only `customAnswerFor` is read** → `ElicitationField.alternativeTo`
  (claude `_askUserQuestionCustomAnswer`, codex `codex.isOtherAnswer`, each with a
  `questionId`): both agents use that text instead of the selection, so the card sends
  one answer. Q3.592.
- codex's own question is behind `default_mode_request_user_input`, off and never
  flipped; `tool_call_mcp_elicitation` is on, so MCP approvals arrive as elicitations.
  Q6.54.
- **Gated, not merely undeclared**: `LaunchOptions.elicitation` is required, the handler
  always registered and `methodNotFound` when declined, `REEMOAT_ELICITATION=0`
  withdraws it. Q2.18.
- **Capability shapes, each read its own way**: `promptCapabilities.image` a boolean
  (`=== true`); `sessionCapabilities.resume` a marker (`!= null`);
  `ElicitationCapabilities.form` a marker with no `false` (omit it; `{form: false}` is
  `TS2559`); steering's top-level `_meta` boolean; and the declared
  `_meta.jetbrains.air = {version, capabilities: [...]}`, whose gate silently refuses a
  version that is not a finite integer, switching background tasks off — so `pincheck`
  asks the installed adapter whether it accepts the exact object. Q2.228.
- `url` mode and request scope: `invalidParams`, never `methodNotFound`. Q2.20.
- An unrenderable request is a JSON-RPC error, never a fabricated `{action: "decline"}`;
  `handleAskUserQuestion` makes it `{behavior: "deny", message: …}`. Q2.21.
- The tag picks the arm and each arm validates only what it reads — never the SDK's
  `ElicitationPropertySchema.is*`. Q2.22.
- Structure is refused, prose carried whole (Bounds): a form missing a question is not a
  smaller form. `pattern` is dropped at ingest (ReDoS). Q2.23, Q2.214.
- The form rides neither snapshot nor event: the snapshot has `message` and a field
  count, `GET /sessions/:id/elicitations/:id` serves the fields. Q2.24.
- `ElicitationResolvedEvent` carries `label`/`value` pairs (titles, never wire values);
  `value` is clipped for the log only. Q2.25.
- One counter mints `perm-N-salt` and `elic-N-salt` (`askSeq`/`askSalt`); `looksLikeOurs`
  takes the prefix, so "too old to report must never come back as never existed" is one
  rule. SQL keeps `perm_seq`/`perm_salt`; TypeScript says `AnswerResolvedBy`. Q2.26.
- **`decline` and `cancel` differ**: decline runs the tool with empty answers and the
  turn carries on; cancel throws and the call dies. The card offers Skip and Send; every
  sweep sends cancel. grok's one word for both: `acp-extensions.md`.
- **Nothing answers on your behalf**: `Session.onPermission` falls back to allow-once with
  no resolver, but a question has no default, so with no resolver it is never declared.
  Q2.28.

## Invariants

**Subagents**

- **A subagent is a tool call that started other tool calls.** Only the parent link is
  carried — no depth, synthesised parent, buffering or seen-ids; arrival order is seq
  order is delivery order.
- Reader rules, in `wire.ts`: a parent may be absent; a child may arrive first; every
  traversal is cycle-safe (`MAX_DEPTH` bounds indent; a visited set per walk). Q5.42.
- The parent id is bounded at ingest (`MAX_PARENT_ID_CHARS`); `truncateEvent` passes it
  through. Q5.43.
- **Layout follows whether a call has children**, never `kind === "think"` or a title;
  the `subagent` flag decides delegation drawing, read from the `tool_call`, never merged
  from an update.

**Config, commands and the snapshot**

- **The agent's controls are complete state on the snapshot**, never a delta or only in
  the log: `session.ts` merges `current_mode_update` before emitting `agent_config`; a
  restored session has no agent to republish.
- `unsubWatch` pushes a snapshot on every `touchSafe()`, so snapshot-only costs no
  latency: `title`, `pinned`, `contextUsage`. `applyContextUsage` calls `touchSafe` only
  when the whole percent, window or cost changed.
- **A config option is found by `category`, never `id`**, values not hardcoded; `/model`,
  `/effort` and `/mode` are built from the controls.
- **A command list is state**, replaced whole, never logged; `commandsRevision` rides the
  snapshot, refetched on `!==`, never `>` (a restart resets it).
- **Neither switch over `SessionEvent["type"]` has a `default` arm** (a new type would be
  charged a flat 192 bytes and never truncated). Add the arm. Q5.65.
- Login command lookup and the probe's environment: `agent-login.md`. Q5.67.
- **The ACP `fs` capability is granted** (refusing confines nothing) and the gate stays:
  `AcpClient` answers `methodNotFound` when declined; `LaunchOptions.fileIo` is required.
  Q5.37, Q5.38.

Steering, and what a second `session/prompt` does: `mid-turn-messages.md`. Q6.107.

## Layout

`src/acp/agents.ts`: launch and login; strips the parent's session env and every
`REEMOAT_*`; the only PATH walk. `src/acp/asynctasks.ts`: `_meta.jetbrains.air`, both the
capability sent and the `async_task_*` drafts read. `src/acp/subagents.ts`: inbound
`_meta.claudeCode` (`sessionMetaFor` is outbound). `src/acp/client.ts`: JSON-RPC routed by
`sessionId`, over an `AgentProcess` (drivers stand `PassThrough`s in). `scripts/pincheck.ts`:
adapter versions exact, agreed and installed; CLI platform packages excluded in
`pnpm-workspace.yaml` (Q4.114).

## Bounds

| | |
|---|---|
| Permission payload | 8 KiB each for `rawInput` and `content`, 8 KiB over `{title, options}` (`MAX_PERMISSION_SNAPSHOT_BYTES`); 24 options, `optionId` 256. All refusals (`invalidParams`): an `optionId` round-trips verbatim, and a `name` may be kimi's answer, matched by `askedQuestion`. Q7.82, Q2.214 |
| Tool call locations | 64 per event, 1024 chars each, counted by `estimateBytes` with `toolCallId` (the per-event cap, session budget and `MAX_QUEUE_BYTES` read it). Q7.83 |
| Agent commands | 256 per session; name 64 (refused: it is sent as `/<name>`), description 200, hint 100 (truncated), at ingest. Cuts count into `dropped`, drawn by the menu. The hint cap sits above the longest real hint. Q6.18 |
| Elicitation form | 24 fields, 24 options each, 32 KiB projected, option value 512 — refusals. Prose on the form uncapped; `message` clipped at 4096 (`MAX_ELICITATION_MESSAGE_CHARS`). An answer over 2048 chars is refused on the route. Q2.214 |

## Known gotchas

- `session_started` is logged at adoption, drawn by nothing (`TRANSCRIPT_SILENT`);
  `daemoncheck` pins the first five rows; the registry's `status` is seq 1. Q6.1.
- A pending permission's command is in `content`, not `rawInput`;
  `PendingPermissionSnapshot` carries both. Q6.2.
- A codex permission has no title or `kind`: `permissionHeadline` infers the verb from
  `command` (`webcheck`: no uuid). Two options are `allow_always`; `rawInput.command` is
  double-quoted, drawn as sent. Q6.55.
- codex (codex-acp 1.8.0) may run a command with no permission request, a
  `guardian_assessment:<id>` tool call (`Guardian Review`) in its place, drawn as a plain
  `tool_call`. Q6.55's shape is codex-acp 1.1.9's.
- codex sends `session_info_update` ~5 times a turn → `other`. Q6.100.
- The permission diff's text block is nested,
  `{type: "content", content: {type: "text", …}}`; `oldText`/`newText` are fragments.
  Q7.29.
- One tool call is five events: `EventList` takes the newest non-null status and title,
  newest non-empty arguments, every content block with its own say, fence stripped.
  Q6.10.
- Drafts: `supersedes` and `restatesInput` in `tail.ts` fold token-by-token argument
  drafts (strictly extended, or parsing to `rawInput`), reading no id, title or vendor.
  `Session.toolDraft` holds them, never drops — the last block is the only complete one —
  flushing on the next event for any call, `turn_end`, `error`, `doDispose`; news
  (status, title, arguments, locations, images) goes at once. The client's fold is the
  guarantee: the daemon may suppress less, never more. Q6.10a.
- Output is on `tool_call_update.content`, except codex's `rawOutput.formatted_output`,
  read by `rawToolOutput` only where blocks carried nothing. `type: "terminal"` is
  dropped; the exit code stays out of the prose; the streaming half is not taken.
  Q6.11, Q6.58.
- A tool card opens only to what its row does not show (`opensToAnything`); the row clips
  at `SUMMARY_CHARS` in code, not CSS, and skips the headline when it is the title.
  Q6.101.
- "Newest wins" covers the call: codex puts a placeholder on the `tool_call`, claude
  `{}`, where a plain `??` picks the empty object. Q6.102.
- An `Edit` emits `file_change` twice; only the first (`source: "diff"`) has a
  `toolCallId`. Q6.12.
- Subagent lineage is not on every event and the spawn loses `subagent: true` on
  completion: absence means "did not say"; read first-non-null. Q6.3.
- A subagent's text and thinking are not forwarded (no
  `clientCapabilities._meta["subagent-transcript"]`): budget, not trust. Q6.4.
- `isTaskTool` matches `TaskCreate|TaskUpdate|TaskList|TaskGet`, so
  `shouldEmitToolCall("Task")` is true; the spawn is `Agent` or `Task` by build. Q6.5.
- A subagent's `TodoWrite` cannot reach the main plan, hence no parent on `PlanEvent`;
  each refinement is a full-replacement `plan`. Q6.6.
- A subagent emits no heartbeat (Q6.7). A backgrounded one completes at once
  (`async_launched` → `backgrounded`); only auto mode's `SubagentHandback` marks its end
  (`endsDelegation`). Q6.119.
- Nested delegation is flat, parented to the outermost spawn. Q6.8.
- `usage_update` (`{used, size}`, snapshot `contextUsage`) and `turn_end.usage` (one
  turn, log) never merge. Q6.9. kimi reports no context usage; the popover points at
  `/usage` (ACP has no usage request; `/usage` as a prompt spends a turn). Q7.26, Q7.27. `usage_update._meta` is
  dropped bar `_claude/origin` (Q2.233), `_claude/rateLimit` included. Q7.25.
- `available_commands_update` arrives outside a turn, so `onStarted` reads once before
  subscribing; `router.sessions.get(id)?.onUpdate(...)` drops an update for an
  unregistered session (`daemoncheck` pushes on a delay). Q6.15.
- `toCommands` keeps the first of two same-named commands, counting the second into
  `dropped`. Q6.16.
- claude republishes commands mid-session, kimi never; claude publishes `/model` and
  `/effort`, kimi neither, neither `/mode`; codex unmeasured. The adapter filters `/clear`; typing it
  works. Q6.17. kimi intercepts an unknown slash command, claude forwards it; an unmatched
  `/foo` is sent as typed. Q6.19.
- ACP `authenticate` is sent for one harness, only with a key to spend — with none it
  selects API-key mode and the first prompt fails `-32603`. `ACP_AUTH_METHOD` names the
  id, `SessionRuntime.authMethod` whether there is a key, `AcpClient.launch` is the single
  call site (Q2.215); `agent-login.md`. Q6.110, Q6.111.
- grok: `model` (`category: "model"`) and `reasoning_effort` (`thought_level`), bare ids, so `SYSTEMS.xai`
  needs no `nativeModelPrefix`; `session/load` republishes them; no `mode`
  (`web-composer.md`). Never spawn it with `--always-approve` (`--yolo`,
  `_meta.yoloMode`): permission cards would vanish silently. `--no-auto-update` is
  required; `src/agentupdate.ts` owns build moves. Q6.109, Q6.111.
- opencode: only `session/set_config_option` is this daemon's (`session/set_config`
  answers `-32601`); an answer is a full option list, `thought_level` present only for a
  model with levels (Q3.518); its mode control is `Session Mode` with lower-case
  `build`/`plan`, so `choiceLabel` cases `mode` alone (Q3.516, Q3.517); its models are its
  provider keys — six OpenCode Zen signed out, `openrouter/…` with any
  `OPENROUTER_API_KEY`; `/undo` and `/redo` are unsupported over ACP. Q6.105.
- cursor is `acp-extensions.md`'s: five requests, subagents on own session ids,
  `session/load` (Q2.248), a cwd it reads rules from, a model pin in the person's config
  (Q6.115).
- `claude-agent-acp` never consults PATH: `claudeCliPath()` takes
  `CLAUDE_CODE_EXECUTABLE`, else an excluded platform package (Q4.114), else throws. So
  `LocalRuntime.launch` sets it on every spawn from `agentCli`'s choice (`spawnPlan`),
  and it survives `agentEnv`'s strip. Q6.21.
- With no `claude`, `resolveAgent` refuses the harness: `cliFor` asks the override, PATH,
  then `MANAGED_CLI_DIRS`, and `describe()` names `deploy/agents.sh` (and `--source npm`), so `GET /agents`
  draws it unavailable. `CODEX_PATH` is the same for `codex-acp`'s `startAcpServer()` (`@openai/codex`'s
  platform builds excluded alike);
  both in `.env.example`, asserted by `deploycheck` off `AGENT_LOGIN[*].executableEnv`.
  Q6.106, Q4.114.
