---
paths:
  - src/acp/agents.ts
  - scripts/daemoncheck.after-the-turn-and-config.ts
---

# The tools a harness brings, and the ones this daemon takes away

**Every harness ships tools written for its own terminal or its vendor's cloud.**
Under this daemon some do nothing, some do the wrong thing, and all of them cost
context. Q6.118 is the census, measured per harness, and the place to add a row.

## What decides

A tool is withdrawn for what it **is**, never for whether today's build has it:

- it answers to another session of the same harness, or to its remote control;
- it draws into the harness's own terminal — a feedback form, an onboarding card;
- it moves something this daemon owns, which today is the session's worktree;
- it publishes to the vendor's cloud, on the owner's word.

**What stays is named, in `daemoncheck`, beside what goes.** `SendMessage` is how
claude continues a subagent (Q2.242); `Workflow` and `Monitor` are work this daemon
already tracks (Q2.228). ⚠ **Scheduling is left exactly as each harness ships it**
— claude's `Cron*`, `ScheduleWakeup` and `RemoteTrigger`, grok's `scheduler_*`,
kimi's `Cron*` — on the owner's word, though `parkable` cannot see a pending
schedule. Do not withdraw one in passing: the replacement is planned, not built.

## The door, per harness

| Harness | Door | Where |
|---|---|---|
| claude | `disallowedTools`: gone from the model's context | `CLAUDE_WITHDRAWN_TOOLS`, sent by `sessionMetaFor` |
| codex | a `[features]` key through `CODEX_CONFIG` | `CODEX_WITHDRAWN_FEATURES`, `codexConfigEnv` |
| grok | none for a single tool, three tried | — |
| kimi, cursor, opencode | none | — |

- ⚠ **Canonical names only on claude's list.** The CLI resolves aliases first —
  `Task`, `KillShell`, `RunWorkflow`, `Brief` — so an alias withdraws the tool it
  stands for, and two of those stay. A name the build lacks is ignored, which is
  what lets the list name a tool a server-side flag has not switched on yet.
- **Never `settings`** for a withdrawal: the adapter drops its own model settings
  whenever any are passed (Q2.242).
- **`allowedTools` is the other half of the same `_meta`**, and holds exactly this
  daemon's own `send_file` (Q2.252). Nothing of the harness's goes on it.
- **A person's own `CODEX_CONFIG` keeps every key it sets.** `codexConfigEnv`
  merges under it and leaves alone a value that is not a JSON object — codex-acp
  parses the variable bare at startup, so a broken one is its failure to show.
  Nested keys only: measured, codex reads `features: {…}` over a dotted
  `features.<name>` beside it. Nothing is written into a harness's config on disk.
- **A door is used only once it is measured to remove the tool.** grok's three —
  an environment switch, its config overlay, a profile on `session/new` — each left
  the tool listed, so none is sent.

## Measuring

claude: the SDK's `system/init` message, opened with the options the adapter
builds. Everyone else: `pnpm harness --agent <id> --prompt` asking for the tool
names. Before and after — the second run is the proof a tool went. The list ages:
`deploy/agents.sh` moves claude daily, so repeat it at a release.
