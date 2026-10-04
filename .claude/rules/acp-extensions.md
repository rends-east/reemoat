---
paths:
  - src/acp/xai.ts
  - src/acp/cursor.ts
  - src/acp/client.ts
  - scripts/daemoncheck.grok-extensions.ts
  - scripts/daemoncheck.cursor-extensions.ts
---

# An agent's own requests

**grok sends three `_`-prefixed extension methods to the client**, whatever the client
declares: `_x.ai/ask_user_question`, `_x.ai/exit_plan_mode`, `_x.ai/mcp/elicit`.
Unregistered, grok fails the tool (and, for the plan, the turn). `src/acp/xai.ts` is the
one place their shapes are known, as measured on grok 1.0.40. Q6.113, Q2.235.

**Each is routed onto a door every agent already uses**, so parking, the log, the card,
Stop and the four ways a request ends (Q2.232) are the existing ones:

| grok sends | becomes | answered |
|---|---|---|
| `{sessionId, toolCallId, questions: [{question, options: [{label, description}], multiSelect}], mode}` | an elicitation in claude's bridge shape — `question_<n>` plus its own-answer `question_<n>_custom`, marked with the agent-neutral `_askUserQuestionCustomAnswer` — through `toElicitationForm` | `{outcome: "accepted", answers: {<question text>: label \| [labels] \| typed text}}`; Skip and every cancel `{outcome: "cancelled"}` |
| `{sessionId, toolCallId, planContent}` | a permission titled *Approve plan*, `rawInput: {plan}`, options `approved`/`abandoned` | `{outcome: "approved"}`, `{outcome: "abandoned"}`; a cancel `{outcome: "cancelled"}` |
| `{sessionId, toolCallId, serverName, message, mode: "form", requestedSchema}` | an elicitation, the message prefixed with the server's name | `{outcome: "accept", content}`, `{outcome: "decline"}`, `{outcome: "cancel"}` |

- **The answer keys are grok's, none guessed**: `outcome` is a tagged enum (`accepted`,
  `chat_about_this`, `skip_interview`, `cancelled`), `answers` a map of `StringOrVec`, and
  anything but the plan's two words reads as "revise the plan". So decline and cancel are
  one word here (`cancelled`), and a plan's ✕ is the revise `revising` wants.
  `chat_about_this`, `skip_interview` and `annotations` are never sent.
- **The question is its field's title** (no short header; answers are logged under it);
  the card draws no heading equal to its title.
- **A plan is also written onto grok's own call** (`tool_call_update`, `rawInput.plan`):
  its arguments are `{}` and the snapshot clamps a permission at 8 KiB, so the card
  recovers a clamped plan from the log.
- **grok withdraws a request by saying it is resolved**, never by `$/cancel_request`:
  `_x.ai/session_notification {update: {sessionUpdate: "interaction_resolved",
  tool_call_id}}` follows every answer and timeout. `Session.withdrawable` aborts the
  request's signal; the registry settles it `agent_withdrew`. **The handler's position is
  the rule**: each handler costs a message one `await` in the SDK's dispatch, and the
  resolution of the call's own permission step arrives just before the question, so it
  sits second, after `session/update`, or it withdraws the question on arrival.
  `daemoncheck` sends the pair in that order.
- **grok's own question timeout is off**: `GROK_ASK_USER_QUESTION_TIMEOUT_ENABLED=false`
  in `GROK_SPAWN_ENV` (else after 30 minutes grok answers itself "declined", Q2.232's
  defect). The environment outranks `config.toml`, losing only to an organisation's
  `requirements.toml`, which the withdrawal covers.
- **With questions off grok is not handed the tool**: `sessionMetaFor` sends
  `_meta.askUserQuestion: false` on `session/new`; one arriving anyway answers `-32601`.
  A plan is a permission, always asked.
- **Everything else fails loudly**: malformed params `-32602` before anything is parked or
  logged; a question past the card's 4096-character message cap refused, not cut (its
  text keys the answer); `url` mode refused as Q2.20; every other `_` method,
  `_x.ai/folder_trust/request` included, the SDK's `-32601` (`compatibility.md`).

## Cursor's

**Five requests, none carrying a `sessionId`**: `cursor/ask_question`,
`cursor/create_plan`, `cursor/update_todos`, `cursor/task`, `cursor/generate_image` — all
JSON-RPC requests with an id, so an unanswered one sits in cursor's pending map for the
process's life. One process serves one session, so `AcpClient`'s `sole` answers on the
only registered session and refuses otherwise. `src/acp/cursor.ts` holds the shapes;
Q6.117 has the table.

- **An error is an answer here, and the wrong one**: an errored `create_plan` makes
  cursor write the plan file itself and report success; an errored `ask_question` falls
  back to per-question permissions and drops multiple-choice ones. So refusals go back in
  cursor's words — `rejected`, `skipped`, `cancelled` — and the one error sent is
  `-32601` for a question with questions off. `create_plan` sends none:
  `answerCursorPlan` parses in the handler (unreadable or a throw → `rejected`; no single
  session, as during a load's replay → `cancelled`); `sole` answers `-32602` for the
  others.
- **No free text**: cursor reads option ids only, so no own-answer box.
- **`cursor/ask_question` has never arrived** (no `AskQuestion` in four client modes), so the
  `reemoat` MCP server hands cursor `ask_question` — same shape and card, its permission
  answered by the daemon off `readMcpToolCall`. The call waits for the answer; past
  `ASK_WAIT_MS` (under cursor's 60 s MCP cut) it tells the model to end its turn, and the
  answer goes as the next message, marked `answers` so it is not drawn twice. The card
  takes the call's id (`claimPosedCall`). Q2.250, Q2.251.
- **A todo update is the session's plan**, merged by id on `merge`, `cancelled` items left
  off (ACP has no such status). A subagent's is ignored (Q6.6).
- **Its subagents speak on session ids nobody opened.** Declared as `_meta.subagents` in
  `clientCapabilities` (the SDK strips a top-level key); announced on the parent by
  `subagent_spawned`, diverted below the SDK beside the async-task drafts.
  `Router.delegations` maps the id home; `Session.onUpdate` parents its calls to the
  spawning call and drops its words (Q6.4); its permissions route home too. Bounded at
  `MAX_DELEGATED_SESSIONS`; an unannounced id is dropped.
- **`parameterizedModelPicker`**, declared to cursor alone (`clientMetaFor`), yields a
  bare-id `model` control plus effort as `thought_level`. Every control but the mode is the
  model's and only a live agent publishes it: a model tapped on a parked cursor session
  wakes it, and a deferred model choice drops the old model's controls rather than replay
  them (`modelScopesControls`, Q2.249).

## Layout

`src/acp/xai.ts` and `src/acp/cursor.ts` are pure: method names, parsers, answers (and
cursor's todo merge, subagent announcement reader and client `_meta`); `daemoncheck`
drives them as tables. `src/acp/client.ts`: the registrations and their order, `sole`, the
delegation map. `src/session.ts`: `onXaiQuestion`/`onXaiPlan`/`onXaiMcpElicit` and
`onCursorQuestion`/`onCursorPlan`/`onCursorTodos`/`onCursorImage` onto
`onElicitation`/`onPermission`, and `withdrawable`. `scripts/daemoncheck.grok-extensions.ts`
holds the measured requests verbatim, run through the real client with a stub grok;
`scripts/daemoncheck.cursor-extensions.ts` cursor's five, a subagent routed home, and a
`session/load` whose replay reaches nothing.
