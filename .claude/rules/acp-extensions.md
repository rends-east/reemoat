---
paths:
  - src/acp/xai.ts
  - src/acp/cursor.ts
  - src/acp/client.ts
  - scripts/daemoncheck.grok-extensions.ts
  - scripts/daemoncheck.cursor-extensions.ts
---

# An agent's own requests

**ACP reserves every `_`-prefixed method for extensions, and grok sends three to
the client.** Its question tool, its plan approval and an MCP server's form arrive
as `_x.ai/ask_user_question`, `_x.ai/exit_plan_mode` and `_x.ai/mcp/elicit` — not
as `elicitation/create` or `session/request_permission`, whatever the client
declares. Unregistered they answered `-32601` and grok failed the tool: *"Failed to
reach the client for user question"*, *"Plan approval could not be completed
because the client disconnected"* (and the turn ended), and a silent `cancel` to
the MCP server. `src/acp/xai.ts` is the one place their shapes are known, parsed
and answered as measured on grok 1.0.40 over a raw ACP client. Q6.113, Q2.235.
cursor sends five of its own with no underscore at all — the section below.

**Each is routed onto a door every agent already uses**, so parking, the log, the
card, Stop and the four ways a request ends (Q2.232) are the existing ones:

| grok sends | becomes | answered |
|---|---|---|
| `{sessionId, toolCallId, questions: [{question, options: [{label, description}], multiSelect}], mode}` | an elicitation in claude's bridge shape — `question_<n>` plus its own-answer `question_<n>_custom`, marked with the agent-neutral `_askUserQuestionCustomAnswer` — through `toElicitationForm` | `{outcome: "accepted", answers: {<question text>: label \| [labels] \| typed text}}`; Skip and every cancel `{outcome: "cancelled"}` |
| `{sessionId, toolCallId, planContent}` | a permission titled *Approve plan*, `rawInput: {plan}`, options `approved`/`abandoned` | `{outcome: "approved"}`, `{outcome: "abandoned"}`; a cancel `{outcome: "cancelled"}` |
| `{sessionId, toolCallId, serverName, message, mode: "form", requestedSchema}` | an elicitation, the message prefixed with the server's name | `{outcome: "accept", content}`, `{outcome: "decline"}`, `{outcome: "cancel"}` |

⚠ **The answer keys are grok's and none is a guess.** `outcome` is an internally
tagged enum whose serde error named its variants (`accepted`, `chat_about_this`,
`skip_interview`, `cancelled`) and demanded `answers`, a map of `StringOrVec`; the
plan's two words were found by the tool result each produced, since grok reads
*anything* else as "revise the plan". So **decline and cancel are one word on this
wire** — `cancelled` reads to the model as *"User declined to answer"* — and a
plan's ✕ is a revise, which is exactly what the composer's `revising` send wants.
`chat_about_this`, `skip_interview` and `annotations` are never sent: nothing on
the card asks for them.

**The question is the title of its field.** grok has no short header, and the
title is what an answer is logged under when the transcript cannot join it back to
the call's own arguments (a typed answer, several labels). The card draws no
heading equal to its title, so nothing appears twice.

**A plan is also written onto grok's own call** as a `tool_call_update` carrying
`rawInput.plan`: grok's `exit_plan_mode` call has `{}` for arguments, the snapshot
clamps a permission's blob at 8 KiB, and the card recovers a clamped payload from
the log — which would otherwise hold no copy.

**grok withdraws a request by saying it is resolved, never by cancelling it.**
`_x.ai/session_notification {update: {sessionUpdate: "interaction_resolved",
tool_call_id}}` follows every answer and every timeout; no `$/cancel_request` is
ever sent. `Session.withdrawable` aborts the request's signal on it, so the
registry settles it `agent_withdrew`. ⚠ **Where that handler is registered is the
rule**: each handler costs a message one `await` in the SDK's dispatch, and the
resolution closing grok's own permission step for a call arrives just before the
question on that call — registered after the request handlers, it overtook the
question and withdrew it on arrival. It sits second, after `session/update`, and
`daemoncheck` sends the pair in that order.

**grok's own question timeout is switched off at the spawn.**
`GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED=false` is in `GROK_SPAWN_ENV`; the default
is 30 minutes, after which grok answers itself *"declined"* and moves on — the
same defect as Q2.232 from the other side. Measured: with `…_SECS=5` it gave up at
5s; with the flag off beside it, an answer at 20s was taken. The environment
outranks the user's `config.toml` and loses only to an organisation's
`requirements.toml`, which is what the withdrawal above is for.

**With questions off, grok is not handed the tool.** It keeps `ask_user_question`
whatever the client declares, so `sessionMetaFor` sends `_meta.askUserQuestion:
false` on `session/new` — measured to remove it — and a question that arrives
anyway still answers `-32601`, as `elicitation/create` does. A plan is a permission
and is always asked.

**Everything else fails loudly.** Malformed params are `-32602` from the parser,
before anything is parked or logged; a question past the card's 4096-character
message cap is refused rather than drawn cut, its text being the answer's key; `url`
mode is refused as Q2.20 refuses it; every other `_` method —
`_x.ai/folder_trust/request` included — is still the SDK's `-32601`. Unknown must
stay a failure the agent reports (`compatibility.md`).

## Cursor's

**cursor sends five, and none of them carries a `sessionId`.** `cursor/ask_question`,
`cursor/create_plan`, `cursor/update_todos`, `cursor/task` and
`cursor/generate_image` are all JSON-RPC *requests* — the last three are
"notifications" in cursor's own vocabulary and still carry an id, so an unanswered
one sits in cursor's pending map for the life of the process. One process serves one
session here, so `AcpClient`'s `sole` answers on the only session registered and
refuses otherwise. `src/acp/cursor.ts` holds the shapes; Q6.117 has the table.

⚠ **On this wire an error is an answer, and the wrong one.** A `create_plan`
answered with any JSON-RPC error makes cursor write the plan file itself and report
success; an `ask_question` answered with one falls back to a permission per
single-choice question and silently drops the multiple-choice ones. So every refusal
a person makes goes back in cursor's own word — `rejected`, `skipped`, `cancelled` —
and the one error this client sends is `-32601` for a question with questions
switched off, where cursor's fallback is the behaviour wanted.

**No free text.** cursor reads option ids and nothing else, so its question has no
own-answer box — the field kimi's and claude's cards carry would take text cursor
throws away.

⚠ **`cursor/ask_question` has never arrived.** Cursor's server gave its model no
`AskQuestion` in any of four measured client modes, so the `reemoat` MCP server hands
cursor `ask_question` instead: the same shape and card, its permission answered by
the daemon off `readMcpToolCall`. **The call waits for the answer** and returns it, as
every other harness's question does; cursor's MCP client cuts any call at 60 s, so
past `ASK_WAIT_MS` (50 s) it returns telling the model to end its turn, and the answer
goes as the person's next message, marked `answers` so it is not drawn twice. The card
takes the call's id (`claimPosedCall`), so the transcript folds the call into it.
Q2.250, Q2.251.

**A todo update is the session's plan**, merged by id when cursor says `merge`, with
a `cancelled` item left off: ACP's plan has no such status and `pending` would be a
lie. A subagent's todo update is ignored, for Q6.6's reason.

**Its subagents are the one place a frame arrives on a session id nobody opened.**
Declared as `_meta.subagents` in `clientCapabilities` (a top-level key is stripped by
the SDK's schema before cursor reads it), each is announced on its parent with
`subagent_spawned` — diverted below the SDK beside the async-task drafts, since the
union is closed — and then speaks on its own id. `Router.delegations` maps that id
to the session that spawned it, and `Session.onUpdate` takes the spawning call as the
parent of every call the subagent makes, dropping what it says (Q6.4). A permission
it asks on its own id — its web fetches — is routed home the same way. Bounded at
`MAX_DELEGATED_SESSIONS`; a frame on an id nobody announced is dropped.

**`parameterizedModelPicker`** is the other `_meta` key, and it is declared to cursor
alone (`clientMetaFor`): it turns one list of every model variant into a bare-id
`model` control plus effort as `thought_level`. ⚠ **So every control but the mode is
the model's**, arriving and leaving with it, and only a live agent can publish a
model's: a model tapped on a *parked* cursor session wakes it, and a deferred model
choice drops the old model's controls rather than replay them onto the new one
(`modelScopesControls`, Q2.249).

## Layout

| File | Holds |
|---|---|
| `src/acp/xai.ts` | The method names, the three parsers, the request-to-door and answer-to-grok mappings, the notification reader. Pure: `daemoncheck` drives it as tables |
| `src/acp/cursor.ts` | cursor's five methods, their parsers and answers, the todo merge, the subagent announcement reader and the client `_meta` only cursor is sent. Pure |
| `src/acp/client.ts` | The registrations, the order that makes grok's withdrawal safe, `sole`, and the delegation map |
| `src/session.ts` | `onXaiQuestion`/`onXaiPlan`/`onXaiMcpElicit` and `onCursorQuestion`/`onCursorPlan`/`onCursorTodos`/`onCursorImage` onto `onElicitation`/`onPermission`, and `withdrawable` |
| `scripts/daemoncheck.grok-extensions.ts` | The measured requests verbatim, the tables, and all three through the real client with a stub grok |
| `scripts/daemoncheck.cursor-extensions.ts` | cursor's five as tables and through the real client, a subagent's frames and permission routed home, and a `session/load` whose replay reaches nothing |
