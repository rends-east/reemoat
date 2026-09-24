---
paths:
  - src/acp/xai.ts
  - src/acp/client.ts
  - scripts/daemoncheck.grok-extensions.ts
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

## Layout

| File | Holds |
|---|---|
| `src/acp/xai.ts` | The method names, the three parsers, the request-to-door and answer-to-grok mappings, the notification reader. Pure: `daemoncheck` drives it as tables |
| `src/acp/client.ts` | The four registrations, and the order that makes the withdrawal safe |
| `src/session.ts` | `onXaiQuestion`/`onXaiPlan`/`onXaiMcpElicit` onto `onElicitation`/`onPermission`, and `withdrawable` |
| `scripts/daemoncheck.grok-extensions.ts` | The measured requests verbatim, the tables, and all three through the real client with a stub grok |
