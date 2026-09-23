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

**Nothing puts a coding-agent CLI on a machine but a press.** That is a change of
posture rather than a feature: `deploy/agents.sh` used to install all five on the
bootstrap, on every `deploy.sh`, and daily — so a harness added to this repository
arrived on every machine in the fleet by itself, offering a sign-in for a program
nobody had asked for. The bootstrap installs **none** now
(`--install-agents a,b` is the door for a provisioner with nobody to press
anything), the other two pass `--refresh-only`, and `src/agentinstall.ts` runs
`--only <agent>` behind a `machine:admin` press.

⚠ **`installable` is a strict subset of `!available`, and reading it as a synonym
is the defect the field exists to prevent.** `AgentUnavailableError` is thrown for
four absences and the installer repairs exactly one — a built-in's *CLI* missing
from PATH and `MANAGED_CLI_DIRS`. A missing ACP adapter is a `pnpm install`
problem; an unknown id and a contributed harness whose program is gone are
somebody's decision. The bit has ridden the error since the auto-resume pass
needed it and `availability()` threw it away; `server.ts` then folds in whether
this daemon installs at all, as `loginSupportOf` folds `logins === null` into
`blocked`, because a row that says yes to one and no to the other is a button that
answers `503`. ⚠ **On the client it is read `=== true`, never `!== false`** — the
opposite of `login.canSignOut` twelve lines away, and deliberately: that refusal
is a `503` carrying the route's own sentence, this one is a bare `404` with no
envelope and nothing to render.

⚠ **The verdict is a measurement, never the exit status.** `deploy/agents.sh`
exits 0 having printed `install failed; this machine has no copy of it until the
next run` — it must, because three of its four callers contract that it never
fails. So `installed` against `failed` is decided by asking the machine again,
and `daemoncheck` asserts the pair `outcome: "failed"` **with** `exit.code === 0`.
⚠ **And the asking comes after the invalidation, as a sequence**: `findOnPath`
caches misses for 30 s, so probing first reads the miss recorded when the tile was
drawn and calls a successful install a failure. A set-shaped assertion passes on
the one ordering that is wrong.

⚠ **One run daemon-wide, and a second start is refused rather than superseded.**
Both are the inverse of a login. The script holds a single `mkdir` lock, so a
per-agent map would let five runs start of which four are answered by that lock
with a warning and `exit 0` — four transcripts that end, look finished, and
installed nothing. And a login supersedes because its commonest end is a closed
tab leaving a pty on stdin; an install waits on nobody, and killing a half-done
`npm i -g` is the corruption the lock exists to prevent. ⚠ **The TTL runs from
`endedAt`**, or a copy of `LoginRun.expired` kills a legitimate download on a slow
link at minute ten.

⚠ **And Stop is refused from the checkpoint that announces a write, which for
several releases it was not refused at all.** The paragraph above states a rule
the supersede refusal and `shutdown()` both kept and
`DELETE /agent-install/runs/:id` broke: it SIGKILLs the whole process group on
demand. `ensure_npm` stages and repoints, so the npm door survives a kill at any
instant, but claude's, codex's and opencode's vendor installers write straight into
`~/.local/bin` and `~/.local/share/claude` with no staging — and `MANAGED_CLI_DIRS`
means `LocalRuntime.agentCli` then *executes* whatever file is left there. So
`MID_WRITE_PHASES` names the two phases a Stop may not signal into (`install` and
`link`, both printed immediately before a write outside `$TMP`), and
`InstallRunView.cancellable` carries that answer to the client so the button can be
withdrawn rather than answer. ⚠ **The refusal starts at the checkpoint and not at
the write, so it leaves a window one line of stdout wide**: the script prints the
phase and *then* writes, and `InstallRun.append` moves the phase only for a line
that has arrived whole, so a Stop landing before that newline reaches the daemon is
still signalled. *Refused from the checkpoint onwards* is the guarantee somebody
may rely on; *refused whenever a write is in flight* is not.

⚠ **`RUN_TIMEOUT_MS` is deliberately exempt**: a run hung for the whole budget
will not finish the write either, and the script's own
lock comment is written for that kill — a pid that no longer answers `kill -0` has
its lock taken over. The route's one refusal is `404 install_not_found`, which for a
run that plainly exists is a false sentence and is the wart the view's bit exists to
keep nobody from meeting.

⚠ **`AgentScriptGate` and `--fail-if-locked` are two layers and neither subsumes
the other.** The gate is a field in this process, so it catches the two runs this
daemon starts. The flag catches what no gate here can see: an orphan a
previous daemon left running, since runs are spawned detached and shutdown
deliberately does not kill one. ⚠ **The gate is taken *above* `runOnce`'s first
line**, which sets `ran` and disarms `nudge()` for the process; and a refused tick
**re-arms short**, or a refresh skipped because somebody installed for three
minutes silently costs the fleet a day.

⚠ **The gate is first come, first served, and the sentence that used to sit here —
*an install wins, the daily refresh yields* — was false of the code in both
copies.** `tryHold` refuses whoever arrives second, whichever kind that is, so an
install pressed while the daily tick holds the gate is the **refused** side and
`server.ts` answers it `409 install_busy`. ⚠ **What `daemoncheck` pins is the two
halves and not the pair** — `tryHold` refusing an install under a held `update`,
and the route's `409 install_busy` driven with an *install* holding — so the
`update` arm and the sentence it draws are reached by no driver. What is
asymmetric is the **cost of losing**: a refused install is a 409 in front of
somebody who can press it again, while a refused refresh has nobody watching, so
it re-arms `FIRST_RUN_DELAY_MS` rather than another day. Preemption is deliberately
not built — the loser of that race would be a script killed mid-write, which is the
corruption both layers exist to prevent.

⚠ **`agentUpdates.nudge()` is gone from the resume pass, and that is not an
oversight.** Its purpose was pulling the five-minute first run forward when a pass
found a harness with no CLI; a `--refresh-only` run installs nothing, so honouring
it would be a subprocess, a log line and a cache flush that cannot repair what the
pass reported — every boot, on exactly the machines already missing something.
What closes that loop now is a person, and `AgentInstallRuns` runs
`resumeInterrupted` itself when an install finishes.

⚠ **`step: <agent> <phase>` is a private grammar, and it is legal only because
both ends are ours.** `ui/login.ts` parses a *vendor's* sentences, which is what
licenses a guess there and a raw-transcript fallback under it. Here
`deploy/agents.sh` prints the line and `readStep` reads it, with `deploycheck`
importing the parser to drive the emitter. It exists because `attempt` and
`ensure_npm` send every installer's output to `/dev/null`: a run is otherwise one
header line and then minutes of silence, so a progress indicator had nothing to
move.

⚠ **New session has no door, and the card is the only surface that starts a
run.** `agentDoor` and `doorLabel` chose and labelled a disclosure under an empty
strip — *Install X* or *Sign in to X*, the whole card unfolded in place — and both
are deleted (Q3.640): that screen says why nothing can start and offers **Agent
settings**, and a row there offers **Set up**, which opens the card as a leaf. The
repair `agentDoor` carried survives where it belongs — `primaryControl` tests
`available` before the credential axis, so a missing harness is never offered
*"Sign in to X"* onto a slot that computes `login.supported && agent.available`
and renders nothing. The Agents list's own Install, which ran with no output, went
in the same change; the list only **adopts** a run through `liveInstall`, which is
what keeps `Installing… · 42s` under a row after a ◀ from a card mid-install.

⚠ **And the card owes a sentence the strip cannot say.** `offersTile` keeps both
`not_installed` *and* `signed_out` off the New session row, so a freshly installed
harness still has no tile — somebody installs, sees nothing, and concludes it
failed. `installResultLine`'s `installed` arm names the sign-in for exactly that
reason, and the Sign-in button it names is on the same card.

## Layout

| File | Holds |
|---|---|
| `src/agentinstall.ts` | One install run: the script, its transcript, `readStep`, and the verdict taken by asking the machine rather than reading a status |
| `src/agentscript.ts` | Who may run `deploy/agents.sh` between the two things in this process that do. First come, first served; what differs is the cost of losing |
| `src/transcript.ts` | `readFrom`, shared by both runs — exported precisely because an asserted *copy* is drift nothing can see, which has already happened here once |
| `packages/web/src/ui/agentInstall.ts` | Which control the card's one slot draws (`primaryControl`), and the sentences a run ends on. The strip owes no door any more (Q3.640) |
