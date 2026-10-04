---
paths:
  # The install act, which is a different subject from signing in to a harness
  # once it is there — `agent-login.md` is that one, and the two deliberately
  # overlap on the panel that draws both. Split out when the install section
  # took `agent-login.md` past `MAX_RULE_CHARS`; the rules are one file per
  # area, and this is an area.
  - src/agentinstall.ts
  - src/agentscript.ts
  - src/transcript.ts
  - packages/web/src/ui/agentInstall.ts
  - packages/web/src/ui/settings/AgentsPanel.tsx
  - packages/web/src/ui/settings/MachineAgentsSection.tsx
  - scripts/daemoncheck.agent-install.ts
  - packages/web/scripts/webcheck.agent-install.ts
  - deploy/agents.sh
---

# Installing a harness

**Nothing puts a coding-agent CLI on a machine but a press.** The bootstrap installs none
(`--install-agents a,b` is a provisioner's door), `deploy.sh` and the daily timer pass
`--refresh-only`, and `src/agentinstall.ts` runs `--only <agent>` behind a
`machine:admin` press.

- **`installable` is a strict subset of `!available`, never a synonym.**
  `AgentUnavailableError` covers four absences and the installer repairs one: a
  built-in's *CLI* missing from PATH and `MANAGED_CLI_DIRS`. A missing ACP adapter is a
  `pnpm install` problem; the other two are somebody's decision. `server.ts` folds in whether this daemon installs at all, as
  `loginSupportOf` folds `logins === null` into `blocked`, or the button answers `503`.
  **The client reads it `=== true`, never `!== false`** — the opposite of
  `login.canSignOut`: this refusal is a bare `404` with nothing to render.
- **The verdict is a measurement, never the exit status.** `deploy/agents.sh` exits 0
  after `install failed; this machine has no copy of it until the next run`, because
  three of its four callers rely on it never failing. So `installed` against `failed` is
  decided by asking the machine again, and `daemoncheck` asserts `outcome: "failed"`
  **with** `exit.code === 0`. **The asking comes after the invalidation, as a
  sequence**: `findOnPath` caches misses for 30 s.
- **One run daemon-wide, and a second start is refused, never superseded** — both the
  inverse of a login. The script holds one `mkdir` lock, so parallel runs would end
  `exit 0` having installed nothing; an install waits on nobody, and killing a half-done
  `npm i -g` is the corruption the lock prevents. **The TTL runs from `endedAt`**, not
  as `LoginRun.expired` does.
- **Stop is refused from the checkpoint that announces a write.**
  `DELETE /agent-install/runs/:id` SIGKILLs the process group; claude's, codex's and
  opencode's vendor installers write unstaged into `~/.local/bin` and `~/.local/share/claude` (`ensure_npm` stages), and
  `LocalRuntime.agentCli` executes what is left. `MID_WRITE_PHASES` names `install` and `link`, each printed just
  before a write outside `$TMP`; `InstallRunView.cancellable` withdraws the button. The
  guarantee is *refused from the checkpoint onwards*, not *whenever a write is in
  flight*: `InstallRun.append` moves the phase only on a whole line. `RUN_TIMEOUT_MS` is exempt (the script's
  lock is taken over from a pid that no longer answers `kill -0`). The route's one
  refusal is `404 install_not_found`.
- **`AgentScriptGate` and `--fail-if-locked` are two layers, neither subsuming the
  other**: the gate catches the two runs this daemon starts; the flag catches an orphan a
  previous daemon left (runs are detached and shutdown does not kill one). **The gate is
  taken above `runOnce`'s first line**, which sets `ran` and disarms `nudge()`, and a
  refused tick **re-arms short**.
- **The gate is first come, first served**: `tryHold` refuses whoever arrives second, so
  an install pressed while the daily tick holds it gets `409 install_busy`. `daemoncheck`
  pins the two halves, not the pair — `tryHold` refusing an install under a held
  `update`, and the route's 409 with an *install* holding — so the `update` arm and its
  sentence are reached by no driver. A refused refresh re-arms `FIRST_RUN_DELAY_MS`.
  Preemption is not built: its loser would be a script killed mid-write.
- **The resume pass does not call `agentUpdates.nudge()`**: a `--refresh-only` run
  installs nothing. `AgentInstallRuns` runs `resumeInterrupted` itself when an install
  finishes.
- **`step: <agent> <phase>` is a private grammar, legal because both ends are ours**:
  `deploy/agents.sh` prints it, `readStep` reads it, and `deploycheck` imports the parser
  to drive the emitter. It exists because `attempt` and `ensure_npm` send installer
  output to `/dev/null`.
- **The card is the only surface that starts a run**; New session has no door
  (`agent-strip.md`, Q3.640). `primaryControl` tests `available` before the credential
  axis, so a missing harness is never offered *"Sign in to X"* onto a slot that computes
  `login.supported && agent.available` and renders nothing. The Agents list only adopts
  a run through `liveInstall`, which keeps `Installing… · 42s` under a row after a ◀.
- **`installResultLine`'s `installed` arm names the sign-in**, because `offersTile`
  keeps `signed_out` off the New session row and a freshly installed harness still has
  no tile.

## Layout

| File | Holds |
|---|---|
| `src/agentinstall.ts` | One install run: the script, its transcript, `readStep`, and the verdict taken by asking the machine |
| `src/agentscript.ts` | Who may run `deploy/agents.sh` between the two things in this process that do |
| `src/transcript.ts` | `readFrom`, shared by both runs and exported, because an asserted copy drifts unseen |
| `packages/web/src/ui/agentInstall.ts` | `primaryControl`, the card's one slot, and the sentences a run ends on |
