---
paths:
  - src/acp/agents.ts
  - scripts/daemoncheck.after-the-turn-and-config.ts
---

# The tools a harness brings, and the ones this daemon takes away

Some harness tools do nothing or the wrong thing here, and all cost context. Q6.118 is
the per-harness census and the place to add a row.

## What decides

A tool is withdrawn for what it is, never for whether today's build has it: it answers
to another session of the same harness or its remote control; it draws into the
harness's own terminal; it moves something this daemon owns (the session's worktree); or
it publishes to the vendor's cloud, on the owner's word.

What stays is named in `daemoncheck` beside what goes: `SendMessage` continues a claude
subagent (Q2.242); `Workflow` and `Monitor` are work already tracked (Q2.228).
Scheduling stays as shipped — claude's `Cron*`, `ScheduleWakeup`, `RemoteTrigger`, grok's
`scheduler_*`, kimi's `Cron*` — on the owner's word, though `parkable` cannot see a
pending schedule. Never withdraw one in passing; the replacement is planned, not built.

## The door, per harness

| Harness | Door | Where |
|---|---|---|
| claude | `disallowedTools`: gone from the model's context | `CLAUDE_WITHDRAWN_TOOLS`, sent by `sessionMetaFor` |
| codex | a `[features]` key through `CODEX_CONFIG` | `CODEX_WITHDRAWN_FEATURES`, `codexConfigEnv` |
| grok | none for a single tool, three tried | — |
| kimi, cursor, opencode | none | — |

- **Canonical names only on claude's list**: the CLI resolves aliases (`Task`,
  `KillShell`, `RunWorkflow`, `Brief`) first, so an alias withdraws the tool it stands
  for — two of which stay. A name the build lacks is ignored, so the list may name a tool
  a server-side flag has not yet switched on.
- **Never `settings`**: the adapter drops its own model settings whenever any are passed
  (Q2.242).
- `allowedTools`, the other half of that `_meta`, holds exactly this daemon's `send_file`
  (Q2.252).
- **A person's own `CODEX_CONFIG` keeps every key it sets**: `codexConfigEnv` merges under
  it and leaves a non-object value for codex-acp to fail on. Nested keys only (codex reads
  `features: {…}` over a dotted `features.<name>`). Nothing is written to a harness's
  config on disk.
- **A door is used only once measured to remove the tool**; grok's three (environment
  switch, config overlay, a `session/new` profile) did not, so none is sent.

## Measuring

claude: the SDK's `system/init`, opened with the adapter's options. Others:
`pnpm harness --agent <id> --prompt` asking for tool names. Before and after; repeat at a
release, since `deploy/agents.sh` moves claude daily.
