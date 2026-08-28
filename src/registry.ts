import { randomBytes } from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentUnavailableError, type AgentId } from "./acp/agents.js";
import { SYSTEMS, type SystemId } from "./acp/systems.js";
import { resolveCwd } from "./browse.js";
import {
  MemoryEventStore,
  SessionLog,
  clampBlob,
  clip,
  endedWithDaemon,
  isAuthFailure,
  oldestAvailable,
  type AgentCommands,
  type AgentConfig,
  type AgentConfigOption,
  type AgentHandle,
  type AgentModes,
  type AnswerResolvedBy,
  type ContextUsage,
  type ElicitationAnswer,
  type ElicitationField,
  type ElicitationForm,
  type EventStore,
  type ExitReason,
  type PermissionOptionSummary,
  type PersistedSession,
  type SessionEvent,
  type SessionExit,
  type SessionStatus,
  type SessionStore,
  type SessionWorkspace,
  type StoredEvent,
  type StoredFileRef,
} from "./events.js";
import { LocalRuntime } from "./runtime/local.js";
import { probeExists } from "./stall.js";
import type { SessionRuntime } from "./runtime/types.js";
import {
  isAuthRequiredMessage,
  isSessionClosed,
  ResumeUnsupportedError,
  Session,
  SessionForgottenError,
  type PendingElicitation,
  type PendingPermission,
  type SessionOptions,
} from "./session.js";
import { inlinesImage, type UploadRow } from "./uploads.js";
import {
  createWorkspace,
  resolveWorktreeRoot,
  DEFAULT_BRANCH_PREFIX,
  type WorkspaceWarning,
} from "./worktree.js";
import { describeError } from "./http.js";

/**
 * How far back to look for the `context_cleared` that would make the recorded
 * conversation a known-empty one.
 *
 * Small on purpose, and it fails in the safe direction: a marker older than this
 * is not found, so the answer is "not unused" and nothing is recreated. The only
 * case it has to reach is a clear with nothing after it but a restart's own
 * status events, which is a handful.
 */
const UNUSED_CONVERSATION_LOOKBACK = 64;
const MAX_LOOKBACK_BYTES = 1024 * 1024;

const START_TIMEOUT_MS = 45_000;
const SHUTDOWN_BUDGET_MS = 20_000;
/**
 * The belt-and-braces SIGKILL sweep after the graceful stops, bounded.
 *
 * Deliberately well inside what is left of `daemon.ts`'s hard limit (25s) once
 * `SHUTDOWN_BUDGET_MS` has been spent. The sweep is a syscall per session again
 * rather than a `docker exec`, so the bound costs nothing — and it stays, because
 * the reason a teardown is bounded does not depend on what it costs. An unbounded
 * sweep turns an orderly shutdown into a hard one at exactly the moment nobody is
 * watching.
 */
const SHUTDOWN_SWEEP_MS = 3_000;
const KILL_CONFIRM_MS = 250;

/**
 * How many sessions may be live at once, and why there is a number here at all.
 *
 * `create()` had no bound of any kind: it resolved a cwd, ran `git worktree add`
 * — a real checkout, with the repository's own hooks — and spawned an agent, once
 * per request, for ever. The only thing downstream that counted sessions was
 * `SqliteSessionStore.prune`, and that is not a bound on creation, it is a
 * **deletion**: it keeps the newest `maxSessions` rows and takes every other
 * transcript with it, at daemon boot, with one `console.error` after the fact.
 *
 * That was survivable while the daemon served one person, and `sqlite.ts` says
 * so in the comment beside the cap — "with one person there is nobody to take it
 * from". A grant makes it false. `grants` is `(user_id, machine_id)` and `POST
 * /v1/tokens` mints for any holder, so anybody sharing a machine can create
 * sessions on it; a loop then fills the newest-200 with fresh empty rows, and the
 * next restart deletes the owner's conversations. The daemon deliberately does
 * not know *who* is asking — it "stops asking who the subject is" — so the
 * remedy cannot be per-person, and does not need to be: what makes the prune
 * destructive is the rate of creation, not its origin.
 *
 * **Live, not total, and `terminal` is the test.** A session somebody stopped
 * holds no agent and no file descriptors; a worktree, yes, and that is bounded
 * separately by the prune and by the upload caps. This is the bound on what is
 * *running*.
 *
 * **Resume is deliberately outside it.** `autoResume` and `POST
 * /sessions/:id/resume` put an agent back in front of a conversation that already
 * exists; refusing there would mean a daemon that came back from a deploy holding
 * work it would not restore. The bound is on manufacturing new sessions.
 *
 * 64 is a backstop rather than a workflow limit — a machine running 64 agents at
 * once has run out of memory long before it runs out of slots — and
 * `REEMOAT_MAX_LIVE_SESSIONS` moves it.
 */
export const MAX_LIVE_SESSIONS = 64;

/**
 * Creations allowed in a burst, before the refill decides the rate.
 *
 * The live cap alone does not close the hole: stop a session and it stops being
 * live, so a loop of create-and-stop still writes rows as fast as it can ask, and
 * rows are what the prune deletes. This is the second half, and the two together
 * are what bound it — 16 immediately, then one per `SESSION_CREATE_REFILL_MS`,
 * so filling a 200-row cap takes hours rather than seconds and the owner watches
 * it happen.
 *
 * In memory, and a restart resets it. That is the same stance `throttle.ts` takes
 * one package over and for the same reason: this bounds abuse, it does not
 * account for it, and a restart is new information.
 */
export const SESSION_CREATE_BURST = 16;

/** One creation slot back per two minutes: ~30/hour once the burst is spent. */
export const SESSION_CREATE_REFILL_MS = 120_000;

/** Which bound refused, so the route can answer with the right sentence. */
export type SessionLimitReason = "too_many_sessions" | "session_rate_limited";

/**
 * A creation refused by one of the two bounds above.
 *
 * Both are 429 rather than 503: the daemon is healthy and the caller is being
 * told to slow down, which is a different sentence from `shutting_down` and from
 * `agent_unavailable`. `retryAfterSeconds` is 0 for the live cap, honestly — a
 * session ends when somebody ends it, and inventing a number there would be the
 * daemon guessing about a person.
 */
export class SessionLimitError extends Error {
  constructor(
    readonly reason: SessionLimitReason,
    readonly retryAfterSeconds: number,
    message: string,
  ) {
    super(message);
    this.name = "SessionLimitError";
  }
}

const CANCELLED: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

/**
 * A cap on the agent-chosen payload carried with a pending permission.
 *
 * Deliberately far below the 128 KiB per-event cap. This does not ride an event,
 * it rides the *snapshot* — which is returned by `GET /sessions` for every
 * session at once, by every `hello` frame, and by every action that answers with
 * a session. An unbounded `rawInput` there is multiplied by the session count on
 * a path a phone polls every few seconds.
 *
 * 8 KiB is far more than a command line and enough for a small diff; anything
 * larger is not something a human is approving off a phone screen anyway, and it
 * degrades to a visible `{truncated: true, bytes}` rather than to silence.
 */
const MAX_PERMISSION_BLOB_BYTES = 8 * 1024;

const ELICITATION_CANCELLED: acp.CreateElicitationResponse = { action: "cancel" };

/**
 * How much of one answer the *log* keeps.
 *
 * Only the log. What reaches the agent is verbatim, and an over-long answer is
 * refused on the route rather than shortened — the daemon must not hand the agent
 * a cut-down version of what somebody typed and let it act on the difference.
 * This copy is a rendering for a person to read back, and `clip` leaves its own
 * marker saying it was cut.
 */
const MAX_ELICITATION_ANSWER_CHARS = 2_048;

/**
 * Whether a person is being waited on here, whatever kind of question it is.
 *
 * One predicate rather than two `.length` reads, because the set of things that
 * can park a turn on a human went from one to two and will go to three. Every
 * place that used to ask `pendingPermissions.length > 0` asks this, so a third
 * kind is one line here rather than a search — and `daemoncheck` pins that this
 * agrees with `status === "blocked"`, which derives from the maps themselves.
 *
 * Derived from the *snapshot* rather than from the status, keeping `listRank`'s
 * own reason: the derived status could gain a state that also has something
 * outstanding, and a rank that read `status` would then stop sorting it first.
 */
export function awaitingHuman(session: SessionSnapshot): boolean {
  return session.pendingPermissions.length + session.pendingElicitations.length > 0;
}

/**
 * Whether a context-usage update is worth waking every attached client for.
 *
 * Pure and module-scope so a driver can assert it with no session — the same
 * reason `normalizeTitle` below and `containerRunArgs` elsewhere are.
 *
 * The threshold is the *rendered* value, not the raw one: a client draws a whole
 * percent, so two readings that round the same way are indistinguishable on screen
 * and a frame carrying the second is a frame nobody can perceive. `size` and
 * `cost` are compared exactly, because both change rarely and both change what is
 * drawn when they do.
 *
 * A `size` of 0 on either side counts as different. That is the "cannot tell"
 * value, and crossing into or out of it flips a client between showing a
 * percentage and showing nothing — the most visible transition there is.
 */
export function usageWorthAnnouncing(before: ContextUsage, after: ContextUsage): boolean {
  if (before.size !== after.size) return true;
  if (before.cost?.amount !== after.cost?.amount) return true;
  if (before.cost?.currency !== after.cost?.currency) return true;
  if (after.size <= 0) return before.used !== after.used;
  return Math.round((before.used / before.size) * 100) !== Math.round((after.used / after.size) * 100);
}

/** Whether a resume is being attempted because the daemon booted, or because somebody spoke. */
export type ResumeTrigger = "boot" | "prompt";

/** How many times one daemon life will try a session before it says so and stops. */
export const MAX_RESUME_ATTEMPTS = 3;
/** How many agents may be starting at once during the boot pass. */
export const RESUME_CONCURRENCY = 2;
export const RESUME_RETRY_MIN_MS = 2_000;
export const RESUME_RETRY_MAX_MS = 60_000;

/**
 * Whether the daemon should bring this session back by itself.
 *
 * The one rule behind "a session reads as stopped only when somebody stopped
 * it", and a `switch` with **no `default` arm** on purpose: adding a member to
 * `ExitReason` must be a compile error here rather than a silent `false` that
 * strands a whole class of session with nobody noticing.
 *
 * Narrower than {@link ManagedSession.resumable}, which answers the different
 * question the manual `POST /sessions/:id/resume` asks — a session somebody
 * stopped can be resumed on request, it is simply never resumed *for* them.
 *
 * **`agent_exited` splits on the trigger, and that is the one judgement call
 * here.** It means the agent quit while the daemon carried on, so the daemon did
 * not end it and the boot pass has no business resurrecting it: an agent that
 * crashed on Tuesday would otherwise be handed a fresh process by Friday's
 * deploy, for a conversation its owner watched die and moved on from. A prompt
 * is somebody explicitly asking, three days later or three seconds, and "it
 * crashed, let me carry on" is exactly the flow that should work.
 *
 * The other exclusions are settled rather than judged: `stopped` is the whole
 * point; `start_failed`/`start_timeout` never had a conversation to return to
 * (and almost never have an `agentSessionId` either); `agent_kill_failed` is
 * legacy and ambiguous — see its note in `events.ts`.
 */
export function autoResumable(
  exit: SessionExit | null,
  agentSessionId: string | null,
  trigger: ResumeTrigger,
): boolean {
  if (exit === null || agentSessionId === null) return false;
  switch (exit.reason) {
    case "daemon_shutdown":
    case "daemon_restarted":
    // The daemon took this agent away to change what it asks for at the door, so
    // the daemon owes it a fresh one — on both triggers, because a restart that
    // did not complete is precisely the state the boot pass exists to repair.
    case "config_changed":
      return true;
    case "agent_exited":
      return trigger === "prompt";
    /*
     * ⚠ **`agent_signed_out` answers `true` on a prompt, and that is a reversal.**
     *
     * It answered `false` on both triggers, because "bringing the conversation
     * back would launch a process holding a credential they have just revoked —
     * which fails at the first message, in a transcript, as an internal error".
     * Two things were wrong with that. The failure is no longer an internal
     * error: `onAgentUnusable` records it and replaces the agent instead of
     * ending the conversation, so a revoked credential now costs one error row
     * per message somebody chooses to send. And the premise held only for the *route*
     * that writes this reason — `POST /agent-auth/:agent/logout` — while the far
     * commoner writer was an expired token that the CLI had since refreshed on
     * its own, leaving a conversation nothing could revive: `reloadCredentials`
     * is the only reversal and every one of its callers is an in-app credential
     * write, so signing in from a terminal reached none of them.
     *
     * On `boot` it stays `false`, and the distinction is the same one
     * `agent_exited` draws one case up: a prompt is a person asking for this
     * conversation *now*, and by then the credential situation may be anything at
     * all. A boot pass is nobody asking, and starting an agent that cannot
     * authenticate at 4am is how a fleet spends a morning on it.
     */
    case "agent_signed_out":
      return trigger === "prompt";
    /*
     * ⚠ **A message revives one somebody stopped, and that is a reversal too.**
     *
     * `stopped` was the one reason that meant "a human ended it", and refusing it
     * on both triggers was how the daemon avoided overruling a person. It still
     * does: **a prompt is not the daemon deciding anything.** It is the same
     * person, on the same conversation, typing into it — the identical argument
     * `agent_exited` has always made one case up, and the identical one
     * `reloadCredentials` makes about a sign-in undoing a sign-out.
     *
     * What forced the question is that the composer is now unconditional: a box
     * you can type into that answers `409 session_terminal` is worse than no box,
     * and "type to start it again" is what every row on that screen already
     * implies. `boot` stays `false`, so nothing revives a stopped conversation on
     * its own — which is the whole of what the old rule was protecting.
     */
    case "stopped":
      return trigger === "prompt";
    /*
     * These two never had a conversation to return to, and the `agentSessionId`
     * guard at the top already answers for them — written out anyway, because a
     * reason that reaches here with an id somehow must not fall into an arm above.
     */
    case "start_failed":
    case "start_timeout":
    // Legacy and genuinely ambiguous: it *replaced* the caller's reason whenever a
    // kill went unconfirmed, so a row carrying it may be somebody's Stop wearing a
    // different word — and `agentConfirmedDead: false` means the old agent may
    // still hold the conversation file. Two agents on one file is worse than a
    // refusal.
    case "agent_kill_failed":
      return false;
  }
}

/**
 * How long to wait before attempt `attempt` (1-based).
 *
 * **Full** jitter — a delay drawn from `[0, capped)` rather than the capped
 * value ±20% — for the reason `relay/protocol.ts` gives about a fleet
 * reconnecting to one relay, arriving here from the other direction: a boot pass
 * retries N sessions whose attempts were started together, so a narrow band
 * keeps them synchronised and they collide again on every round.
 *
 * Deliberately not importing `reconnectDelayMs`. That constant is a statement
 * about a fleet hitting one control plane; this one is about one machine's own
 * agents, and coupling them would mean tuning either changes the other.
 */
export function resumeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const capped = Math.min(RESUME_RETRY_MIN_MS * 2 ** Math.max(attempt - 1, 0), RESUME_RETRY_MAX_MS);
  return Math.floor(random() * capped);
}

/**
 * What went wrong with a resume, in one vocabulary.
 *
 * Both callers need this and they need it to agree: `server.ts` turns it into an
 * HTTP answer for somebody who pressed a button, and the boot pass records it on
 * the snapshot for somebody who was not there. A client reads the same `code`
 * either way and draws the same sentence, so two mappings would mean the
 * automatic path and the manual path explaining the same failure differently.
 *
 * The status is here rather than in the route because it is a property of the
 * failure — 409 for "this cannot work", 502/503/504 for "it did not work this
 * time" — and splitting the two apart is how they drift.
 */
export function describeResumeFailure(error: unknown): {
  code: string;
  /** Narrow on purpose, so `server.ts` can hand it straight to `jsonError`. */
  status: 409 | 502 | 503 | 504;
  message: string;
} {
  const message = describeError(error);
  if (error instanceof ResumeUnavailableError) return { code: error.reason, status: 409, message };
  if (error instanceof SessionForgottenError) return { code: "agent_forgot_session", status: 409, message };
  if (error instanceof ResumeUnsupportedError) return { code: "resume_unsupported", status: 409, message };
  if (error instanceof AgentUnavailableError) return { code: "agent_unavailable", status: 503, message };
  if (error instanceof StartTimeoutError) return { code: "agent_start_timeout", status: 504, message };
  // The predicate lives in `session.ts`, which is where the message is written —
  // see `isAuthRequiredMessage` for why it is a string match at all, and why
  // there is one copy of that concession rather than one per caller.
  if (isAuthRequiredMessage(message)) {
    return { code: "agent_auth_required", status: 502, message };
  }
  return { code: "agent_launch_failed", status: 502, message };
}

/**
 * Whether a republished command list is the same one already held.
 *
 * `usageWorthAnnouncing` one field over, and here for the same reason: the agent
 * decides the rate, this process pays for it. See {@link ManagedSession} where it
 * is called for what a bump actually costs at both ends.
 *
 * A plain field-by-field walk rather than a hash or a JSON compare. `toCommands`
 * has already bounded the list to 256 entries of bounded strings, so the walk is
 * trivially cheap; a serialization would allocate on a path that runs inside the
 * agent's own notification handler, and a hash would have to be kept in step with
 * a shape the compiler is watching here.
 */
export function sameCommands(before: AgentCommands, after: AgentCommands): boolean {
  if (before.dropped !== after.dropped) return false;
  if (before.commands.length !== after.commands.length) return false;
  return before.commands.every((command, index) => {
    const other = after.commands[index];
    return (
      other !== undefined &&
      command.name === other.name &&
      command.description === other.description &&
      command.hint === other.hint
    );
  });
}

/**
 * Drops a choice that is an alias of another, and moves the selection onto the real one.
 *
 * Agents publish placeholder choices that duplicate a concrete one. Measured
 * 2026-07-31 against claude 0.63.0, its model list opens with `default`, named
 * `Default (recommended)`, whose description is character-for-character that of
 * `opus[1m]` — "Opus 5 with 1M context · Best for everyday, complex tasks". Offering
 * both is offering one model twice under two names, and a session left on the
 * placeholder is the whole reason the control read "Default" and answered nothing.
 *
 * Two rows carrying the *same non-empty description* are a statement by the agent
 * that they are the same thing, which is why that is the test rather than a list of
 * known ids. Where nothing duplicates — effort, whose choices have no descriptions
 * at all, and every kimi control — nothing is dropped, and that is right rather than
 * a gap: there the placeholder is the only way back to the agent's own default and
 * removing it would remove the way back.
 *
 * The later row wins because that is the order agents use: placeholder first,
 * concrete after. Rewriting `value` onto it is a *rename of an equivalent*, not an
 * invention — and it is confined to the snapshot, which is a description of state
 * for drawing. The live config `setConfigOption` validates against is untouched,
 * and a client picking a row now sends the concrete value, so the next session
 * starts on it for real.
 *
 * Here rather than in the browser because this is the only side that has every
 * description: `snapshotConfig` keeps only the selected choice's prose, so a client
 * cannot see that two rows match. It also makes the snapshot *smaller*.
 */
export function dedupeAliasChoices(option: AgentConfigOption): AgentConfigOption {
  const lastByDescription = new Map<string, string>();
  for (const choice of option.choices) {
    const description = choice.description?.trim();
    if (description !== undefined && description.length > 0) {
      lastByDescription.set(description, String(choice.value));
    }
  }

  const aliasOf = new Map<string, string>();
  for (const choice of option.choices) {
    // Only a *placeholder* is ever removed. Matching descriptions alone is a
    // heuristic over untrusted agent output, and dropping on it is destructive
    // and one-directional: an agent that reuses one blurb across two genuinely
    // distinct models would lose the earlier one from the picker for good, with
    // the daemon still happily accepting the value the UI could no longer offer —
    // invisible from the server side. `truncateEvent`'s own `agent_config` arm
    // states the rule this would break: "a picker missing a choice would silently
    // offer the agent less than it supports".
    //
    // `default` is a placeholder by construction rather than by guess: it is the
    // id an agent uses for "whatever I would pick", and no real model is named it.
    // So the measured case — claude's `default` carrying `opus[1m]`'s description
    // verbatim — still collapses, and nothing an agent offers uniquely can.
    if (!PLACEHOLDER_CHOICE_VALUES.has(String(choice.value))) continue;
    const description = choice.description?.trim();
    if (description === undefined || description.length === 0) continue;
    const keeper = lastByDescription.get(description);
    if (keeper !== undefined && keeper !== String(choice.value)) aliasOf.set(String(choice.value), keeper);
  }
  if (aliasOf.size === 0) return option;

  const selected = typeof option.value === "string" ? (aliasOf.get(option.value) ?? option.value) : option.value;
  return {
    ...option,
    value: selected,
    choices: option.choices.filter((choice) => !aliasOf.has(String(choice.value))),
  };
}

/**
 * The value that stands for claude's `ultracode` on its own effort control.
 *
 * Ours rather than the agent's, which is the one thing that makes this an
 * exception worth naming: everywhere else in this daemon a choice comes from the
 * agent and is passed through untouched. `ultracode` is a *setting* rather than
 * an ACP option — see `sessionMetaFor` — so there is nothing to pass through, and
 * the alternative to inventing this row was a switch of our own somewhere else on
 * the screen for something the agent's own interface offers in exactly this
 * place.
 *
 * It never reaches the agent: {@link ManagedSession.setConfigOption} intercepts
 * it above the ACP call, which is asserted by `daemoncheck` rather than left as a
 * property of the reading order.
 */
export const ULTRACODE_CHOICE = "ultracode";

/**
 * The level whose presence proves the model can carry ultracode at all.
 *
 * The SDK's own condition is *"requires workflows to be enabled and an
 * xhigh-capable model"*, and claude builds the effort list from
 * `supportedEffortLevels` of the model that is currently selected. So this is a
 * capability test read off the agent's own answer, not a model name we would
 * otherwise have to keep a list of — and it turns itself off on a model that
 * cannot do it, which no list of ours would.
 */
const XHIGH_CHOICE = "xhigh";

/**
 * Which control the extra row belongs on, or `null` where there is not one.
 *
 * By `category` and never by id, like everything else that reads a control here:
 * claude calls it `effort` today and the id is not portable. Four conditions, and
 * the last is the one that keeps this from being permanent — an agent that ships
 * its own `ultracode` choice takes the row back, and the value then travels to it
 * as an ordinary selection.
 */
export function ultracodeOptionId(config: AgentConfig, agent: AgentId): string | null {
  if (agent !== "claude") return null;
  const option = config.options.find((candidate) => candidate.category === "thought_level");
  if (option === undefined || option.kind !== "select") return null;
  if (!option.choices.some((choice) => choice.value === XHIGH_CHOICE)) return null;
  if (option.choices.some((choice) => choice.value === ULTRACODE_CHOICE)) return null;
  return option.id;
}

/**
 * The agent's controls with the one row it cannot publish, and the selection it
 * cannot report.
 *
 * Applied to the state on its way to the *snapshot*, never to the state
 * `setConfigOption` validates against — the same split `dedupeAliasChoices`
 * makes and for the same reason: what a client draws and what the agent accepts
 * are two different sets, and mixing them is how a picker comes to offer
 * something the daemon then refuses.
 *
 * Before `snapshotConfig` rather than after, so the extra row obeys every rule
 * the others do: its prose is clipped, and kept only while it is the selected
 * one.
 */
export function withUltracode(config: AgentConfig, agent: AgentId, on: boolean): AgentConfig {
  const optionId = ultracodeOptionId(config, agent);
  if (optionId === null) return config;
  return {
    ...config,
    options: config.options.map((option) =>
      option.id !== optionId
        ? option
        : {
            ...option,
            /*
             * The selection is ours because the agent cannot report this state at
             * all. Measured 2026-08-11 against claude-agent-acp 0.63.0: the effort
             * option's `currentValue` is built from `Settings.effortLevel`
             * (`acp-agent.js:4405`), a *different* settings key from `ultracode`,
             * so a session running with the flag on still publishes
             * `effort=default`. Passing that through would leave the row somebody
             * just chose permanently unticked — a control that answers "nothing
             * happened" every time it works.
             */
            value: on ? ULTRACODE_CHOICE : option.value,
            choices: [
              ...option.choices,
              {
                value: ULTRACODE_CHOICE,
                name: "Ultracode",
                description: "Highest effort, and every turn planned as a workflow of subagents",
                group: null,
              },
            ],
          },
    ),
  };
}

/**
 * The agent's controls, as they ride the snapshot rather than the log.
 *
 * The same argument `MAX_PERMISSION_BLOB_BYTES` makes, applied to the other
 * agent-chosen payload on a snapshot — and it was missed. `truncateEvent` drops
 * descriptions from an `agent_config` *event* when it is over the per-event cap,
 * but the copy `snapshot()` returns went out verbatim, and a snapshot is returned
 * for every session at once on a list a phone polls every four seconds with up to
 * sixty rows. The large part is a model list: claude advertises every model it can
 * reach, each with a name and usually a description.
 *
 * So the prose goes and the *identity* of every control stays — ids, names and
 * current values are never touched, which is the same trade `truncateEvent`
 * makes. The descriptions are still in the transcript for anything that wants
 * them, which is what `configProse` in the web client reads.
 *
 * The one thing that does not survive verbatim is the choice *list*, and only
 * where the agent said two rows are the same thing: see {@link dedupeAliasChoices},
 * which collapses a placeholder onto the concrete row it duplicates and moves the
 * selection with it. Nothing an agent offers uniquely is ever dropped.
 */
function snapshotConfig(config: AgentConfig, namespace: string | null): AgentConfig {
  return {
    modes:
      config.modes === null
        ? null
        : {
            current: config.modes.current,
            available: config.modes.available.map((mode) => ({
              id: mode.id,
              name: mode.name,
              description: null,
            })),
          },
    options: config.options
      .map(dedupeAliasChoices)
      .map((option) => narrowToSystem(option, namespace))
      .map((option) => ({
      ...option,
      // The option's own description is kept too, and it is short — "AI model to
      // use", "Available effort levels for this model", one per control rather
      // than one per choice. It is the only prose claude's effort control has:
      // every one of its choices (`Default`, `Low`, `High`…) carries none, so
      // without this the menu is a list of bare words with nothing saying what
      // they are levels *of*.
      description: clipChoiceDescription(option.description),
      choices: option.choices.map((choice) => ({
        ...choice,
        // The *selected* choice keeps its prose. Everything else loses it.
        //
        // This is the one description a client cannot do without, and dropping it
        // wholesale was a mistake worth naming: claude's model list always carries
        // a choice called `Default (recommended)`, and the only thing that says
        // which model that actually is — "Opus 5 with 1M context" — is its
        // description. Stripped, the control reads "Default" and answers nothing.
        //
        // Recovering it from the `agent_config` event in the transcript is not a
        // substitute, which is what was tried first: that event lands at session
        // start, so on any conversation longer than the render window it is not
        // loaded and the label silently goes back to being useless.
        //
        // The cost argument the strip was built on is untouched. What made the
        // snapshot expensive was N descriptions per option — claude advertises
        // five models, each with prose. This keeps 1 of N, clipped, which is a few
        // dozen bytes per session against the four absolute paths `workspace`
        // already carries.
        description:
          choice.value === option.value ? clipChoiceDescription(choice.description) : null,
      })),
    })),
  };
}

/**
 * A session pinned to one system is offered that system's models and no others.
 *
 * ⚠ **Reported twice from the app, the second time after a fix that only grouped
 * them.** opencode is the native side of *two* systems and publishes **one** model
 * control holding both catalogues — 356 `openrouter/…` and six `opencode/…`. A
 * session assembled as OpenRouter therefore offered six OpenCode Zen models at the
 * bottom of its own picker, and choosing one left the session running a model from
 * a system its preset does not name: the chip, the tile and the glyph all go on
 * saying OpenRouter. That is Q2.216's dishonesty reached through the model menu
 * rather than through a preset edit.
 *
 * **The namespace is the pairing's, not the current value's**, which is the whole
 * reason this is on the daemon. The browser holds an `AgentConfigOption` off a
 * snapshot and knows nothing about systems; deriving the namespace from whatever
 * model is selected right now would trap a session that had already been switched
 * to the wrong one — it would then be offered only the wrong one, for ever.
 *
 * ⚠ **The selected choice is never removed**, whatever namespace it is in. A model
 * list missing the value the control is set to makes `chipValue` fall back to a raw
 * id, and makes `pinNativeModel` refuse the next resume with "has no model called
 * …" — so a session already switched by hand keeps a way back to itself rather than
 * being cut adrift by a fix.
 *
 * Narrow twice: `category === "model"` only, since no other control's values are
 * namespaced; and only where `nativeModelPrefix` is set, which is opencode's two
 * systems and nothing else. Every other agent's list is returned by identity.
 */
export function narrowToSystem(option: AgentConfigOption, namespace: string | null): AgentConfigOption {
  if (namespace === null || option.category !== "model") return option;
  const kept = option.choices.filter(
    (choice) => choice.value === option.value || choice.value.startsWith(namespace),
  );
  return kept.length === option.choices.length ? option : { ...option, choices: kept };
}

/** Bounded, because it now rides a record `GET /sessions` returns sixty of. */
const MAX_CHOICE_DESCRIPTION_CHARS = 120;

function clipChoiceDescription(description: string | null): string | null {
  if (description === null) return null;
  const trimmed = description.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= MAX_CHOICE_DESCRIPTION_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_CHOICE_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

/**
 * The longest title this daemon will accept from a rename.
 *
 * Bounded for the same reason `MAX_PERMISSION_BLOB_BYTES` is: a title rides the
 * *snapshot*, which `GET /sessions` returns for up to sixty sessions at once on a
 * path a phone polls every four seconds. 120 characters is worst-case ~140 bytes
 * per row, a fraction of the four absolute paths `workspace` already carries —
 * but it stays a fraction only because there is a cap.
 */
/**
 * Choice values that mean "whatever the agent would pick", not a thing in itself.
 *
 * The only values {@link dedupeAliasChoices} will remove. Kept as a set rather
 * than a literal so the next agent's spelling is one entry, and deliberately tiny:
 * every addition here is permission to delete a row from somebody's picker.
 */
const PLACEHOLDER_CHOICE_VALUES = new Set(["default"]);

export const MAX_TITLE_CHARS = 120;

/**
 * The length a title derived from a prompt is clipped to.
 *
 * Shorter than what a rename may set, on purpose: a person who types a name chose
 * it and means it, while a derived one is a guess made from the first thing they
 * happened to say, and a guess that fills a rail row is worse than a short one.
 */
const DERIVED_TITLE_CHARS = 60;

/**
 * Makes an arbitrary string safe to be a session's name, or `null` if nothing is
 * left of it.
 *
 * Controls are *stripped* rather than refused, and that asymmetry is deliberate:
 * on the rename path refusing would be defensible, but the same function runs on
 * the derived path where the input is a prompt somebody wrote for an agent, and
 * there is nobody to refuse to. U+2028/U+2029 are in the class because they are
 * line breaks that `\s` in a `RegExp` without `u` does not always treat as such,
 * and a line break in a title is a row that grows by a line.
 *
 * `null` and never `""`: the store's `title` column distinguishes "never named"
 * from "named", and an empty string would be a third state that renders as a
 * blank header.
 */
export function normalizeTitle(raw: string, limit: number = MAX_TITLE_CHARS): string | null {
  // Escapes and not literals: a control character written into the source of a
  // regex is invisible in every editor and diff that will ever show this line.
  const flattened = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  const collapsed = flattened.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Names a session after the first thing its owner asked for.
 *
 * The first non-empty *line*, not the first 60 characters: a prompt that opens
 * with a one-line summary and then pastes a stack trace should be named after the
 * summary, and one that opens with the stack trace is not going to be well named
 * by anything. Breaking on a nearby space rather than mid-word costs one scan and
 * is the difference between "Fix the reconnect back" and "Fix the reconnect ba".
 */
export function deriveSessionTitle(prompt: string): string | null {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (firstLine === undefined) return null;
  const normalized = normalizeTitle(firstLine, DERIVED_TITLE_CHARS * 4);
  if (normalized === null) return null;
  if (normalized.length <= DERIVED_TITLE_CHARS) return normalized;
  const cut = normalized.slice(0, DERIVED_TITLE_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  const body = space >= DERIVED_TITLE_CHARS - 13 ? cut.slice(0, space) : cut;
  return `${body.trimEnd()}…`;
}

export interface PendingPermissionSnapshot {
  permissionId: string;
  toolCallId: string | null;
  title: string;
  options: PermissionOptionSummary[];
  raisedAt: number;
  /**
   * What is actually being approved: the tool's arguments, and the request's
   * content blocks when it is an edit.
   *
   * Here rather than left to a client-side join against the `tool_call` event,
   * because for kimi that event carries `rawInput: null` and this request is the
   * only place the command appears. Both are bounded and both may be the
   * `{truncated: true, bytes}` stand-in.
   */
  rawInput: unknown;
  content: unknown;
}

/**
 * A question the agent is waiting on, as it rides `SessionSnapshot`.
 *
 * **The form is not here, and that is the difference from a pending permission.**
 * A permission earns its 8 KiB of `rawInput`/`content` on this record because a
 * blocked session has to be answerable *from the list* — the whole "does anything
 * anywhere need me" thesis rests on approving being two taps from anywhere. A
 * question is not answerable from a list: you have to read the form and fill it
 * in. So the snapshot carries only enough to say one is waiting and to draw a
 * row, and `GET /sessions/:id/elicitations/:elicitationId` serves the fields when
 * a card opens — which is exactly where a command list lives, and for exactly the
 * same reason.
 *
 * `fieldCount` is here so a card can size a skeleton before its fetch lands, and
 * for no other reason; nothing decides anything on it.
 */
export interface PendingElicitationSnapshot {
  elicitationId: string;
  toolCallId: string | null;
  /** The agent's prompt. Always present — ACP requires it. Clipped at ingest. */
  message: string;
  fieldCount: number;
  raisedAt: number;
}

/** What a resume failure is allowed to say. Both clamped — see below. */
export const MAX_RESUME_ERROR_CODE_CHARS = 64;
export const MAX_RESUME_ERROR_MESSAGE_CHARS = 512;

/**
 * What an exit is allowed to say about why.
 *
 * `SessionExit.detail` rides two things that cannot afford an unbounded string:
 * `snapshot()`, so every `GET /sessions` poll carries it for every session, and
 * `StatusEvent`, which `estimateBytes` charges a **flat 192** because the rest of
 * that event is union literals and numbers. So a long detail is both re-sent
 * every four seconds and invisible to the per-event cap.
 *
 * It is agent-reachable: `onStartFailed` writes `describeError(error)`, and on
 * an ACP handshake failure that error's message is whatever the agent put in its
 * JSON-RPC error — the same "bounded by what the agent sent" that is not a bound
 * anywhere else in this file.
 *
 * The same 512 as a resume failure's message, deliberately: they are the same
 * kind of sentence in the same place on the same screen, and two numbers for one
 * job is how they end up disagreeing.
 */
export const MAX_EXIT_DETAIL_CHARS = MAX_RESUME_ERROR_MESSAGE_CHARS;

/**
 * What the daemon's own resume pass is doing about this session.
 *
 * On the snapshot rather than in the log, and the admission rule is the same one
 * `title`, `pinned` and `contextUsage` pass: it is state superseded whole rather
 * than something that happened, so a transcript would accumulate a line per
 * attempt for a fact that only ever has one current value. The *failure* is
 * narrative and does get one `error` event — once, on the final attempt.
 *
 * It earns its place beside those by answering *does anything anywhere need me*
 * from the list: a session the daemon gave up on is one nobody is coming for,
 * and without this field it is byte-identical to one that has not been tried
 * yet. That is also why it is bounded an order tighter than a pending
 * permission's 8 KiB — this rides `GET /sessions` for sixty sessions every four
 * seconds, and unlike a permission nothing here needs to be *acted on* from the
 * list, only recognised.
 *
 * Absent means an older daemon that does not resume at all. A client must read
 * that as "waiting", never as "failed": quietly wrong about a session that is
 * never coming back is a great deal better than a red banner on every ended
 * session in the fleet.
 */
export interface SessionResumeState {
  state: "waiting" | "running" | "failed";
  /** How many times *this daemon* has tried. Reset by a success, not persisted. */
  attempts: number;
  /** The last refusal, in the daemon's own error vocabulary. */
  error: { code: string; message: string } | null;
  at: number;
}

/**
 * Why the daemon stopped trying, when it stopped for a reason of its own.
 *
 * `workspace_missing` and `unsupported` are settled facts about the world rather
 * than attempts that ran out — the checkout is gone, or this agent build cannot
 * reattach at all — so neither consumes an attempt and neither is retried inside
 * one daemon life. `attempts_exhausted` is the ordinary one.
 */
export type ResumeGiveUp =
  | "workspace_missing"
  | "unsupported"
  | "forgotten"
  | "attempts_exhausted";

/**
 * The one give-up that outlives this daemon, and why it is the only one.
 *
 * Retry state is otherwise in memory on the argument that a restart is new
 * information — a new binary, a re-signed-in agent, a remounted disk. That
 * argument holds for every reason except this one: the agent has told us the
 * conversation does not exist, which is a fact about the world rather than about
 * an attempt, and no restart of ours changes what is on its disk.
 *
 * The others are deliberately left transient because re-checking them is cheap
 * or genuinely worth redoing. `workspace_missing` costs one `stat` and a folder
 * really can be put back. `unsupported` is a property of the agent *binary*,
 * which an upgrade changes, and the per-pass memo already reduces it to one
 * spawn per agent per boot. `attempts_exhausted` is the transient case by
 * definition.
 *
 * Measured 2026-08-04, which is why this exists at all: ten sessions whose
 * transcripts did not survive the move off containers were each costing three
 * agent spawns on every single restart, for ever.
 */
export function resumeGiveUpPersists(reason: ResumeGiveUp): boolean {
  return reason === "forgotten";
}

/** Whether a string off disk is a give-up this version knows how to honour. */
export function isPersistedGiveUp(value: string | null | undefined): value is ResumeGiveUp {
  return value === "forgotten";
}

/**
 * Everything a client needs to understand a session without replaying anything.
 *
 * This is the authoritative view. The event log is narrative: it says what
 * happened, in order, but a client that has just arrived should not have to
 * reconstruct "is this thing blocked right now" by folding over it.
 */
export interface SessionSnapshot {
  id: string;
  agent: AgentId;
  /**
   * The assembled agent this session was started as, or `null` for a bare
   * harness.
   *
   * ⚠ **An id, and nothing about what it *says*.** The name, the system and the
   * model are not here: they are the preset's, they can be edited, and a copy on
   * a snapshot fanned out per client on every output token is a copy that goes
   * stale in the one place it would be read. The client already lists the
   * presets to draw its picker; this is the join key.
   *
   * On the snapshot rather than only in the log for the same reason `agent` is: a
   * **restored** session has no live agent to have published anything, and its
   * row still has to say what it is.
   */
  customAgent: string | null;
  /** Where the agent runs. Always equal to `workspace.root`. */
  cwd: string;
  workspace: SessionWorkspace;
  status: SessionStatus;
  agentSessionId: string | null;
  agentHandle: AgentHandle | null;
  turn: number | null;
  turnStartedAt: number | null;
  /**
   * When somebody asked the agent to abandon this turn, or `null`.
   *
   * On the snapshot rather than only in the log because it is *state* and because
   * of the one property the log cannot supply: an agent may ignore a cancel. A
   * turn that ends answers with `turn_end{stopReason: "cancelled"}` and needs
   * nothing here; a turn that goes on working is the case this field exists for,
   * and a client that could not see it would redraw the button as if nothing had
   * been asked. It survives a reload for the same reason — the request was made
   * by the fleet's owner, not by a tab.
   *
   * Cleared where `turn` is, so the pair can never disagree: an agent that answers
   * is `{turn: null, cancelRequestedAt: null}` again, and asking twice is allowed.
   */
  cancelRequestedAt: number | null;
  lastEventAt: number | null;
  createdAt: number;
  /**
   * The agent's mode/model/effort controls, and what they are set to.
   *
   * On the snapshot rather than only in the log, and that is load-bearing for two
   * reasons that outlive the one it used to give. The controls are **state with one
   * current version**, so a client folding a log to find them would be re-deriving a
   * value the record already carries — and the log evicts a prefix. And a *restored*
   * session has no live agent to have published anything, so there may be nothing in
   * the log to fold.
   *
   * The reason this used to give was that `session_started` landed after the first
   * `prompt` event; it lands when the agent is adopted now, since a `ManagedSession`
   * drains the queue between turns. The conclusion did not depend on it.
   *
   * Empty options mean the agent offers none, not that we have not asked.
   */
  agentConfig: AgentConfig;
  /**
   * Moves whenever the agent republishes its command list. `0` means it never has.
   *
   * A number rather than the list, and this is the one place to read why.
   * Everything else on this record is either tiny or needed to answer *does
   * anything anywhere need me* without opening a session — a pending permission
   * earns its 8 KiB here precisely because a blocked session has to be answerable
   * **from the list**. A command list is neither: it is only ever wanted inside
   * one session's composer, by somebody who has already opened it and pressed a
   * key. claude publishes dozens with descriptions, and `GET /sessions` returns
   * this record for up to sixty sessions every four seconds, over the relay, to a
   * phone. So the list lives behind `GET /sessions/:id/commands` and this says
   * when to go and get it.
   *
   * Clamping the list to poll size instead was the tempting alternative and it is
   * worse: `truncateEvent`'s `agent_config` arm already names the failure — a
   * picker missing a row silently offers the agent less than it supports — and a
   * `/` menu with no `/compact` because it sorted seventeenth is not a smaller
   * menu, it is a wrong one.
   *
   * A client refetches on `!==` and never on `>`. A daemon restart puts this back
   * to 0 while a client still holds 5, and the right response there is to drop the
   * cache rather than conclude the daemon is behind.
   */
  commandsRevision: number;
  /**
   * What this session is called. `null` means nobody has named it, and a client
   * should draw its own fallback from the working directory rather than an empty
   * string — which is why this is never `""`.
   */
  title: string | null;
  /**
   * Sorted to the top of the list, and never dropped by a `?limit=` cut.
   *
   * Outranks liveness and never outranks a pending permission: a pin is somebody's
   * bookmark, and a blocked session is somebody being waited on.
   */
  pinned: boolean;
  /**
   * How full the model's context window is, or `null` for "cannot tell".
   *
   * Three answers and not two, for the reason `Liveness` and `loggedIn` have
   * three: kimi may never report it at all, and a restored session has no live
   * agent to ask. Rendering "cannot tell" as "0% used" would put a number on
   * screen that nobody measured, and a person would plan around it.
   */
  contextUsage: ContextUsage | null;
  firstSeq: number;
  lastSeq: number;
  dropped: number;
  pendingPermissions: PendingPermissionSnapshot[];
  /** Questions the agent is waiting on. Read through `awaitingHuman`, not directly. */
  pendingElicitations: PendingElicitationSnapshot[];
  exit: SessionExit | null;
  /**
   * Absent whenever this daemon has had no reason to think about resuming the
   * session — which is every live session, and every session it will not bring
   * back. See {@link SessionResumeState} for why absent means "waiting".
   */
  resume?: SessionResumeState;
}

export type DecisionWord = "allow" | "allow_always" | "reject" | "reject_always";
export type PermissionAnswer = { optionId: string } | { decision: DecisionWord } | { cancel: true };

export type PermissionResult =
  | {
      kind: "ok";
      permissionId: string;
      outcome: "selected" | "cancelled";
      optionId: string | null;
      seq: number | null;
      delivered: "sent" | "agent_gone";
    }
  | {
      kind: "already_answered";
      permissionId: string;
      outcome: "selected" | "cancelled";
      optionId: string | null;
      at: number;
      by: AnswerResolvedBy;
    }
  | { kind: "expired"; permissionId: string }
  | { kind: "not_found" }
  | { kind: "invalid_option"; options: PermissionOptionSummary[] }
  | { kind: "no_matching_option"; options: PermissionOptionSummary[] };

/**
 * What a client may say about a question.
 *
 * **Three forms and not two, and that is measured rather than symmetry.** Against
 * claude's adapter, `decline` runs the tool with empty answers and the turn
 * *carries on* — the model is told the person skipped — while `cancel` throws and
 * the tool call dies. They are different acts, and collapsing them would take one
 * of the two away from whoever is holding the phone.
 */
export type ElicitationAnswerBody =
  | { content: Record<string, ElicitationContentValue> }
  | { decline: true }
  | { cancel: true };

/** What a form field's answer is allowed to be on the wire. */
export type ElicitationContentValue = string | number | boolean | string[];

/** Why a `content` object was refused. Every problem is reported, never the first. */
export interface ElicitationProblem {
  key: string;
  code:
    | "unknown_field"
    | "missing"
    | "wrong_type"
    | "not_an_option"
    | "too_short"
    | "too_long"
    | "too_small"
    | "too_large"
    | "too_few"
    | "too_many"
    | "duplicate";
  detail: string;
}

export type ElicitationResult =
  | {
      kind: "ok";
      elicitationId: string;
      action: "accept" | "decline" | "cancel";
      seq: number | null;
      delivered: "sent" | "agent_gone";
    }
  | {
      kind: "already_answered";
      elicitationId: string;
      action: "accept" | "decline" | "cancel";
      at: number;
      by: AnswerResolvedBy;
    }
  | { kind: "expired"; elicitationId: string }
  | { kind: "not_found" }
  // `fields` rides along for the reason `invalid_option` returns `options`: a
  // client that is out of date can redraw rather than guess.
  | { kind: "invalid_content"; problems: ElicitationProblem[]; fields: ElicitationField[] };

/**
 * What `setConfigOption`/`setMode` can answer. Mapped onto HTTP by `server.ts`.
 *
 * `busy` is deliberately **not** "a turn is running": changing mode or model
 * mid-turn is ordinary and stays allowed. It is the one window in which the
 * agent's session id is being replaced underneath us — see `clearing`, whose
 * whole reason for existing is that nothing else may address the agent while it
 * runs. The arm is here rather than folded into `not_ready` because a client's
 * answer differs: a clear is over in ~600ms and the tap is worth repeating, where
 * `not_ready` is a session with no agent at all.
 */
export type AgentConfigResult =
  | { kind: "ok"; config: AgentConfig }
  | { kind: "busy"; status: SessionStatus }
  /**
   * A turn is running and this change cannot be made without ending it.
   *
   * Distinct from `busy`, which this file is careful to say is *not* about a turn
   * — and the distinction earns itself here for the first time: exactly one
   * control needs the agent restarted to take effect (see
   * {@link ULTRACODE_CHOICE}), so exactly one refusal on this route is honestly
   * "wait for the agent to finish". Every other option is applied live and does
   * not care.
   */
  | { kind: "turn_in_flight"; status: SessionStatus }
  | { kind: "not_ready"; status: SessionStatus }
  | { kind: "terminal"; status: SessionStatus }
  | { kind: "unknown_option"; options: AgentConfigOption[] }
  | { kind: "invalid_value"; option: AgentConfigOption }
  | { kind: "unknown_mode"; modes: AgentModes | null };

export type PromptResult =
  | { kind: "accepted"; turn: number; seq: number }
  | { kind: "busy"; status: SessionStatus }
  | { kind: "not_ready"; status: SessionStatus }
  | { kind: "terminal"; status: SessionStatus; exit: SessionExit | null };

/**
 * What a `/clear` answered with.
 *
 * Shares three of its arms with {@link PromptResult} because a clear is refused
 * for exactly the same reasons a prompt is, and `server.ts` maps them with the
 * same code. `cleared` replaces `accepted` because no turn starts: there is a
 * seq to point at and nothing to wait for.
 */
export type ClearResult =
  | { kind: "cleared"; seq: number }
  | { kind: "busy"; status: SessionStatus }
  | { kind: "not_ready"; status: SessionStatus }
  | { kind: "terminal"; status: SessionStatus; exit: SessionExit | null };

/**
 * What stopping the turn answered with.
 *
 * **`no_turn` is a success and not a refusal**, which is where this union parts
 * company with the two above it. A prompt sent to a session that cannot take one
 * has not happened; a cancel sent to a session with nothing running has already
 * got what it asked for — the agent is not working. That state is also reachable
 * by losing an ordinary race, since the tap and the turn's own end are two events
 * nobody orders, and answering a red error for "it stopped a moment before you
 * asked" would make the button look broken at exactly the moment it did its job.
 *
 * `settled` is the observation, never a promise: `false` means the agent had not
 * finished by the time we stopped watching, which happens and is not a failure —
 * the turn ends into the transcript whenever the agent gets there, with nobody
 * attached. Nothing escalates on it. See `Session.cancelTurn`.
 *
 * `busy` keeps its meaning from {@link AgentConfigResult} rather than from
 * {@link PromptResult}: a `/clear` is in flight, so the agent's session id is
 * being replaced and nothing may address it — which is emphatically not "a turn
 * is running", the one thing a cancel would be glad to hear.
 */
export type CancelResult =
  | { kind: "cancelled"; turn: number; settled: boolean }
  | { kind: "no_turn"; status: SessionStatus }
  | { kind: "busy"; status: SessionStatus }
  | { kind: "not_ready"; status: SessionStatus }
  | { kind: "terminal"; status: SessionStatus; exit: SessionExit | null };

export class StartTimeoutError extends Error {
  constructor(
    readonly sessionId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `agent did not start within ${timeoutMs / 1000}s. The session is recorded as ${sessionId}; ` +
        "it will be disposed if the agent turns up late.",
    );
    this.name = "StartTimeoutError";
  }
}

export type ResumeUnavailableReason = "session_live" | "no_agent_session_id";

/** Raised when a session cannot be resumed for a reason the caller can act on. */
export class ResumeUnavailableError extends Error {
  constructor(
    readonly sessionId: string,
    readonly reason: ResumeUnavailableReason,
  ) {
    super(
      reason === "session_live"
        ? "this session has not ended; stop it before resuming"
        : "this session has no agent session id, so there is nothing to reattach to",
    );
    this.name = "ResumeUnavailableError";
  }
}

interface PendingRecord {
  info: PendingPermissionSnapshot;
  resolve: (response: acp.RequestPermissionResponse) => void;
}

interface ResolutionRecord {
  outcome: "selected" | "cancelled";
  optionId: string | null;
  at: number;
  by: AnswerResolvedBy;
}

interface PendingElicitationRecord {
  info: PendingElicitationSnapshot;
  /**
   * The form, held here rather than on the snapshot.
   *
   * Kept because the answer is validated against it: a client is only ever shown
   * this projection, so validating a reply against anything else would refuse
   * answers it was invited to give.
   */
  form: ElicitationForm;
  resolve: (response: acp.CreateElicitationResponse) => void;
}

interface ElicitationResolutionRecord {
  action: "accept" | "decline" | "cancel";
  at: number;
  by: AnswerResolvedBy;
}

export type SessionWatcher = (snapshot: SessionSnapshot) => void;

/**
 * One session, owned by the daemon rather than by whoever is looking at it.
 *
 * Zero attached clients is a normal state. Nothing here references a connection,
 * which is what makes a client disappearing a non-event.
 */
/**
 * State a restored session is rebuilt from.
 *
 * Every field is optional and every default matches a fresh session, so the
 * normal construction path reads exactly as it did before this existed.
 */
export interface ManagedSessionInit {
  createdAt?: number;
  agentSessionId?: string | null;
  agentHandle?: AgentHandle | null;
  exit?: SessionExit | null;
  turnCounter?: number;
  lastEventAt?: number | null;
  askSeq?: number;
  askSalt?: string;
  /** The one give-up that survives a restart. See {@link resumeGiveUpPersists}. */
  resumeGaveUp?: ResumeGiveUp | null;
  title?: string | null;
  pinned?: boolean;
  /**
   * What this session was last told about ultracode, or `null` for never told.
   *
   * Three-valued for the reason `owner_subject` is nullable and `pinned` is not:
   * there is no honest default here. "Nobody has chosen" is a different state
   * from "chosen off" — the first follows `REEMOAT_CLAUDE_ULTRACODE`, the second
   * outranks it — and collapsing them would mean every session that existed
   * before the switch did, and every session created after it, permanently
   * disagreeing with the machine's own setting.
   */
  ultracode?: boolean | null;
}

export interface ManagedSessionOptions {
  sessionStore?: SessionStore | null;
  restore?: ManagedSessionInit;
  /** Where this session's agent runs. Defaults to a child of this daemon. */
  runtime?: SessionRuntime;
  /**
   * Files staged for this session's prompts.
   *
   * Optional, and absent it is simply as if nobody ever attached anything: the
   * drivers and `harness.ts` construct a registry with no upload root, and the
   * route refuses an attachment before it ever reaches here.
   */
  uploads?: UploadsPort | null;
  /**
   * Whether this session may show a person a question.
   *
   * **A thunk rather than a captured boolean**, and that is not style: `daemon.ts`
   * calls `registry.restore()` before it reads the environment, so a value taken
   * at construction would be stale for every restored session on the machine. The
   * same argument `LocalRuntimeOptions.secrets` already makes — read at launch,
   * never captured.
   *
   * Defaults to allowing it. A `Session` with no resolver never declares the
   * capability, so the drivers and `harness.ts` are unaffected either way.
   */
  elicitationAllowed?: () => boolean;
  /**
   * Whether a session nobody has decided about asks for ultracode.
   *
   * **A thunk, for exactly the reason {@link elicitationAllowed} is one**, and
   * this is the case that argument was written about: `daemon.ts` calls
   * `registry.restore()` before it reads the environment, so a boolean captured
   * at construction would be `false` for every session on the machine that the
   * daemon just brought back — which is all of them, after the restart that put
   * the setting into effect.
   */
  ultracodeDefault?: () => boolean;
  /**
   * Which assembled agent this session was started as, or `null` for a bare
   * harness.
   *
   * Carried rather than resolved: what a preset *says* — its system and its
   * model — is read at every launch through `customAgents`, so editing one
   * changes what its sessions come back as. What this holds is only the
   * reference, which is what makes it safe to be immutable.
   */
  customAgent?: string | null;
  /**
   * How to read back what an assembled agent says, by id.
   *
   * ⚠ **A function read at launch, never a value captured at construction** —
   * `LocalRuntimeOptions.secrets`' argument, and it buys the same thing: editing
   * a preset takes effect on the next start without a daemon restart, and a
   * session restored before the store existed does not hold a stale copy.
   *
   * `null` from it is not an error and must not fail the launch. A preset can be
   * deleted while a session that names it is asleep, and the honest outcome then
   * is the harness on its own — the session's `agent` column still says which
   * one — rather than a conversation that can never be resumed again.
   *
   * ⚠ **The harness is in the answer, and it is not there to be used.** It is
   * there to be *compared*: `PATCH /custom-agents/:id` accepts a change of
   * harness, so a preset can be re-pointed at a different CLI under a session
   * that was started on the old one, and `agent` is immutable. Without this
   * field the pair `{system, model}` was spread over the session's own harness
   * and produced a triple nobody chose and, half the time, one `hostable`
   * refuses — a live session that answers `502 system_not_routable` for ever.
   * See {@link ManagedSession.assembled}, which is the only reader.
   */
  resolveCustomAgent?: (id: string) => { harness: AgentId; system: SystemId; model: string } | null;
  /**
   * Where a degradation nobody else can see gets reported.
   *
   * Exists for exactly one thing today: `SessionLog`'s fan-out guard evicts a
   * listener that threw, and the listeners are **live WebSockets**. Nothing was
   * ever passed for `ListenerErrorHandler`, so a socket could stop receiving
   * events for the rest of its life with nothing anywhere saying so — the one
   * degradation path in this daemon that reported through no callback at all.
   *
   * Optional like every other seam here: absent, this is exactly the silence
   * that existed before, which is what keeps the drivers and `harness.ts`
   * constructing a registry with nothing to print to.
   */
  onWarning?: (detail: string) => void;
}

/**
 * What a session needs from the upload store, and nothing more.
 *
 * A narrow port rather than the class, so `registry.ts` does not depend on
 * `uploads.ts` — the dependency arrow in this codebase runs `server` →
 * `registry` → `session` → `acp/*`, and an upload store is a peer of the event
 * store rather than something underneath a session.
 */
export interface UploadsPort {
  blocksFor(rows: readonly UploadRow[], caps: { image: boolean }): Promise<acp.ContentBlock[]>;
  markConsumed(sessionId: string, uploadIds: readonly string[]): void;
  /** Synchronous by contract — see {@link SessionOptions.keepImage}. */
  keepAgentImage(sessionId: string, mime: string, data: string): StoredFileRef | null;
}

export class ManagedSession {
  readonly createdAt: number;
  readonly log: SessionLog;

  private session: Session | null = null;
  private startPromise: Promise<Session> | null = null;
  private startAbandoned = false;
  private stopRequested = false;
  /**
   * Whether an `authentication_failed` from the agent may replace it.
   *
   * Re-armed by every prompt and spent by {@link onAgentUnusable}, which is the
   * whole of what makes that a retry rather than a loop: a credential that really
   * has gone away fails the fresh agent the same way, and the second failure sits
   * in the transcript beside the first instead of starting a third process. What
   * drives the next attempt is somebody sending another message.
   *
   * Starts armed, so the first failure a restored session meets is answered.
   */
  private authRestartArmed = true;
  private stopping: Promise<void> | null = null;
  private exitRecord: SessionExit | null = null;
  private resuming: Promise<void> | null = null;
  /** Set while an *automatic* resume runs. See `onStartFailed`. */
  private quietResume = false;

  /*
   * What this daemon has tried about bringing the session back, and how it went.
   *
   * **In memory, deliberately, and never persisted.** It is a fact about *this
   * process's* attempts rather than about the session — the same category as
   * `agentConfigState` and `contextUsageState` above, which are not restored for
   * the same reason: a number read off disk describes a process that is not
   * running. Persisting it would also need `SCHEMA_VERSION` 6→7 for a counter
   * whose only job is to stop a loop inside one daemon life.
   *
   * So a restart resets the budget and the daemon tries again, which is the
   * wanted behaviour rather than a leak: a restart is *new information* — a new
   * binary, a re-signed-in agent, a remounted disk — and refusing to try because
   * a previous process failed three times would make the very deploy that fixes
   * the bug fix nothing. The cost is bounded and small: a session that can never
   * resume spends `maxAttempts` spawns per deploy and says so once.
   */
  private resumeAttempts = 0;
  private lastResumeFailureAt: number | null = null;
  private resumeError: { code: string; message: string } | null = null;
  private resumeGivenUp: ResumeGiveUp | null = null;

  private turn: number | null = null;
  private turnCounter: number;
  private turnStartedAt: number | null = null;
  /**
   * When somebody asked this turn to stop. Rides the snapshot; see the field there.
   *
   * In memory and not in SQLite, unlike `turnCounter` beside it, and the reason is
   * that the question it answers cannot outlive the process: after a restart there
   * is no turn to have cancelled — every session comes back idle — so a persisted
   * value could only ever describe a turn that no longer exists.
   */
  private cancelRequestedAt: number | null = null;
  private lastEventAt: number | null = null;

  /**
   * A `/clear` that has been sent and not yet come back.
   *
   * A second marker beside `turn` rather than a reuse of it, because a clear is
   * not a turn: it burns no turn number, it produces no `turn_end`, and
   * `turnStartedAt` would put a "working" timer on the snapshot for something the
   * agent is not thinking about. What it shares with a turn is the only thing
   * this field is read for — **nothing else may talk to the agent while it
   * runs**, which is every method on this class that issues an ACP request and
   * therefore all five of them: {@link prompt}, {@link clearContext},
   * {@link setConfigOption}, {@link setMode} and {@link cancelTurn}. The list is
   * written out because the rule above is a sentence and a new such method would
   * not fail to compile; it read as enforced while covering only the first two,
   * which is the `sessionOf` shape this repo names its worst defects after. The
   * fifth arrived exactly as predicted and had to be added by hand — a cancel
   * sent inside this window would notify the id `session/close` is about to
   * destroy, which stops nothing and looks from outside like an agent ignoring
   * it.
   *
   * `clearContext` re-keys the ACP session underneath us (`session/new`,
   * then `session/close` on the old id, measured at ~600ms and bounded at 15s),
   * and for that whole window `this.turn` was `null`, so a prompt arriving beside
   * a `/clear` passed every guard and was issued against the conversation about
   * to be closed: its updates went to `router.sessions.get(<old id>)`, which is
   * `undefined` and drops them silently, and the turn died with the `session/close`
   * — a message recorded in the transcript that reached no model and produced no
   * reply. A second `/clear` in the same window is the same hole with a worse
   * ending: both capture the same `previous`, both close it, and the conversation
   * the first one opened is left live inside the agent with nothing left to close
   * it.
   */
  private clearing = false;

  /**
   * A restart this daemon is performing on somebody's behalf, mid-flight.
   *
   * **The sibling `clearing` predicted, arriving on the path `clearing` does not
   * cover.** `applyUltracode` is `stop("config_changed")` → `resume()` →
   * `restoreConfig(wanted)`, which is `/clear`'s shape with a process boundary in
   * the middle: the conversation is replaced underneath a person and a snapshot
   * captured *before* the change is put back at the end. `stopRequested`,
   * `terminal` and a null `session` cover the first two steps by themselves — and
   * then `onStarted` assigns `this.session`, `armForStart` has already cleared
   * `stopRequested`, and every one of those guards goes quiet while the restore is
   * still in flight.
   *
   * What lands in that window is reverted with no error and no record. The config
   * bar is one gesture from the composer and an agent restart runs into seconds,
   * so: tap a mode, `session.setMode` succeeds, the route answers `200`, and then
   * `restoreConfig` applies the *pre-restart* mode last and the chip snaps back.
   * That is the defect `clearing`'s own docblock describes for `/clear`,
   * reproduced verbatim one method over — which is why this is a second flag
   * rather than a widening of `turn`: a restart burns no turn number either.
   *
   * Read at the same five places for the same reason, and tested beside
   * `clearing` rather than instead of it, because the two windows can be told
   * apart in a way the refusal cannot: both answer `busy`, and a caller only ever
   * needs to know that the agent is not accepting instructions yet.
   */
  private get restarting(): boolean {
    return this.restart !== null;
  }

  /**
   * Wait for a restart this daemon started, then carry on. Resolves at once when
   * there is none, and **never rejects**.
   *
   * The public half of {@link restart}, and it exists so that sending a message
   * during an ultracode change is a wait rather than a refusal. Somebody flipped a
   * setting and then typed — they did not ask for a restart and should not have to
   * know one is happening, which is the same judgement that took the spinner off
   * the strip.
   *
   * Never rejecting is the contract: a failed restart is reported by the *state*
   * that follows it — `session_terminal`, `not_ready` — through the arms the prompt
   * route already has. Rejecting here would invent a second error surface for a
   * request whose caller never mentioned a restart.
   *
   * ⚠ **Only the prompt route waits.** `setConfigOption` and `setMode` keep
   * answering `busy`, deliberately: a change that landed mid-restart would be
   * overwritten by `restoreConfig` replaying the snapshot captured before it, with
   * nothing recorded — which is the defect {@link restart} was introduced to close.
   * Waiting there would reopen it in a slower disguise.
   */
  whenRestarted(): Promise<void> {
    return this.restart?.done ?? Promise.resolve();
  }

  /**
   * The controls captured before a restart, and the whole of what makes one
   * invisible.
   *
   * {@link restarting} is *derived from* this rather than kept beside it, because
   * they are one fact: a boolean that can disagree with the config the snapshot is
   * serving would be a second place for this window to be described, and the
   * disagreement would be silent. Written in one statement and cleared in one
   * `finally`, so the window in which `snapshot()` reports controls the live agent
   * never published is **by construction** the window in which `prompt`,
   * `clearContext`, `cancelTurn`, `setConfigOption` and `setMode` all answer
   * `busy`. That is what licenses it: nothing a client does with a held value can
   * reach an agent, because nothing reaches an agent.
   */
  private restart: { readonly config: AgentConfig; readonly done: Promise<void> } | null = null;

  /**
   * Which controls the snapshot reports, which are not always the ones the agent
   * last published.
   *
   * ⭐ **Choosing `ultracode` made the mode chip flash `Manual`.** `applyUltracode`
   * is `stop("config_changed")` → `resume()` → `restoreConfig(wanted)`, and
   * `onStarted` assigns the *new* conversation's own config in the middle of it —
   * for claude, the mode it calls `Manual`. That value is not one bad frame: it is
   * read by `applyAgentConfig`'s own touch, by the usage and command reads beside
   * it, by the `idle` status touch, by `onResumed`, and again by every round trip
   * the restore then makes, so the mode reads `Manual` for the *whole* restore
   * while the controls around it correct one at a time. Nothing on a client can
   * hold against it, because it is a live, non-empty answer — which is why
   * suppressing any single fan-out fixes nothing. Serving `wanted` instead makes
   * the strip read as though nothing happened to it, which is what a restart
   * nobody asked to watch should look like.
   *
   * Composed here and **never** assigned into `agentConfigState`, which is
   * `withUltracode`'s own split one screen up, for its reason: that field is what
   * `setConfigOption` and `setMode` validate against, and `restoreConfig`
   * deliberately *withdraws* a mode or a choice the new conversation no longer
   * offers. Held there, a withdrawn value would pass validation and be sent to an
   * agent that just refused it.
   *
   * ⚠ **The empty window is left empty on purpose**, which is the gate below.
   * Between `doStop` clearing `agentConfigState` and `onStarted` refilling it there
   * is no live agent, and an empty config is how a client is told so:
   * `packages/web`'s `drawnControls` answers `stale: true` there and draws its own
   * memory of these controls, dimmed and untappable — already the pre-restart
   * values. Serving `wanted` in that window would make it non-empty and therefore
   * `stale: false`, i.e. enabled chips at `interrupted` and `starting`, onto a
   * certain `409`. So the hold starts only once the fresh agent has published,
   * which is precisely the part of the restart a client draws as live.
   */
  private get snapshotConfigSource(): AgentConfig {
    const held = this.restart?.config ?? null;
    if (held === null || held.options.length === 0) return this.agentConfigState;
    // No live agent yet: report that rather than a memory. See the ⚠ above.
    if (this.agentConfigState.options.length === 0) return this.agentConfigState;
    return held;
  }

  /**
   * What the agent's own session id and pid were before the daemon died.
   *
   * Only consulted when `session` is null. A live session always answers from
   * the real thing; these are how a restored one still knows what to resume.
   */
  private restoredAgentSessionId: string | null;
  private restoredAgentHandle: AgentHandle | null;

  /**
   * The live agent's controls, mirrored here so the snapshot can carry them.
   *
   * Deliberately *not* restored from disk. These describe what the agent will
   * accept right now — a claude that has since been pointed at a different model
   * offers different modes — so a stale copy would put a control on screen that
   * the next `set_config_option` would reject. A restored session answers with an
   * empty set until `resume` re-reads it from a live agent.
   */
  private agentConfigState: AgentConfig = { modes: null, options: [] };
  private unsubscribeConfig: (() => void) | null = null;

  /**
   * Which commands the live agent publishes, and a counter that announces them.
   *
   * Not restored from disk for the reason directly above, and one more: a
   * restored session has no agent to run a command against, so a `/compact`
   * offered from a stale list would be a menu entry that cannot be chosen.
   *
   * The counter is what rides the snapshot; the list does not. See
   * {@link SessionSnapshot.commandsRevision} for why that split, and not a clamp.
   */
  private agentCommandsState: AgentCommands = { commands: [], dropped: 0 };
  private commandsRevisionValue = 0;
  private unsubscribeCommands: (() => void) | null = null;

  /**
   * What this session is called, and whether it is kept at the top of the list.
   *
   * Restored from disk, and that is the opposite of `agentConfigState` directly
   * above on purpose. The controls describe a *live agent* and go stale the moment
   * it dies; these describe the *record*, and a name somebody typed on a phone is
   * still their name for it after a restart. `owner_subject` is the precedent —
   * set at creation and authoritative once the process that created it is gone.
   */
  private titleValue: string | null;
  private pinnedValue: boolean;

  /**
   * What somebody chose about ultracode for this session, or `null` for nobody.
   *
   * Restored from disk beside `title` and `pinned` and for the same reason: it
   * describes the *record* rather than a live agent. What it is **not** is a
   * cached answer — {@link ultracodeWanted} folds it with the machine's default
   * at the moment of a launch, so a `null` here follows the environment for ever
   * rather than freezing whatever it happened to be at construction.
   */
  private ultracodeChoice: boolean | null;
  private readonly ultracodeDefault: () => boolean;

  /**
   * How full the live agent's context window is.
   *
   * Deliberately *not* persisted and not restored, for exactly the reason
   * `agentConfigState` is not: it describes an agent that is running right now,
   * and a number read off disk describes one that is not. `null` — "cannot tell" —
   * is the honest answer for a restored session, and a stale 87% would be a lie a
   * person would act on.
   */
  private contextUsageState: ContextUsage | null = null;
  private unsubscribeUsage: (() => void) | null = null;

  private readonly sessionStore: SessionStore | null;

  private readonly pending = new Map<string, PendingRecord>();
  /**
   * Every permission this session has ever settled.
   *
   * Unbounded on purpose — it dies with the session, entries are tiny, and a
   * fixed ring would turn "you already answered that" into "that never existed"
   * for precisely the lost-response retry it exists to serve.
   *
   * Deliberately not persisted. After a restart nobody can act on any of it and
   * `expired` is the right answer for every entry, so persisting it would give an
   * unbounded-because-it-dies-with-the-session map a way to outlive what bounded
   * it. The id *shape* is persisted instead — see `askSalt`.
   */
  private readonly resolved = new Map<string, ResolutionRecord>();
  /**
   * One counter for every parked question, whatever kind it is.
   *
   * `perm-N-salt` and `elic-N-salt` are minted from this and from {@link askSalt},
   * so each kind's numbering has gaps — which nothing reads as a count. What that
   * buys is that recognising an id across a restart costs no second column, and
   * therefore no `migrate()` and no `SCHEMA_VERSION` argument. Named `ask` rather
   * than `permission` because a field called `permission*` that also counts
   * elicitations asserts a property nobody enforces.
   */
  private askSeq: number;
  /** Per session, so a transposed id from another session cannot match here. */
  private readonly askSalt: string;

  /**
   * Questions the agent is waiting on, and the ones it has stopped waiting on.
   *
   * Parallel to `pending`/`resolved` rather than merged with them — see
   * {@link resolveElicitation} for why the two cannot share a map. The
   * `resolvedElicitations` docblock is `resolved`'s: unbounded on purpose, dies
   * with the session, and a fixed ring would turn "you already answered that"
   * into "that never existed" for the one retry it exists to serve.
   */
  private readonly pendingElicitations = new Map<string, PendingElicitationRecord>();
  private readonly resolvedElicitations = new Map<string, ElicitationResolutionRecord>();

  private readonly watchers = new Set<SessionWatcher>();
  /** Where this session's agent runs. */
  private readonly runtime: SessionRuntime;
  /** Where files staged for this session live, if this daemon stages any. */
  private readonly uploads: UploadsPort | null;
  /** See {@link ManagedSessionOptions.elicitationAllowed}. Read at launch, never captured. */
  private readonly elicitationAllowed: () => boolean;

  /**
   * Where an image the agent returns is kept.
   *
   * A bound arrow rather than a method reference, because it is handed to
   * `Session` and called from inside the agent's notification handler — the emit
   * path. It must therefore stay synchronous, and it is: the store mints the id
   * and writes the bytes on its own.
   */
  private readonly keepAgentImage = (mime: string, data: string): StoredFileRef | null =>
    this.uploads?.keepAgentImage(this.id, mime, data) ?? null;

  /** See `ManagedSessionOptions.customAgent`. Immutable, like `agent`. */
  readonly customAgent: string | null;
  private readonly resolveCustomAgent: (
    id: string,
  ) => { harness: AgentId; system: SystemId; model: string } | null;

  constructor(
    readonly id: string,
    readonly agent: AgentId,
    readonly workspace: SessionWorkspace,
    store: EventStore,
    options: ManagedSessionOptions = {},
  ) {
    this.customAgent = options.customAgent ?? null;
    this.resolveCustomAgent = options.resolveCustomAgent ?? (() => null);
    // The third argument is what `SessionLog` has always taken and nobody ever
    // supplied: an evicted listener is a live socket that has silently stopped
    // receiving, and every other degradation in this codebase reports through a
    // callback rather than vanishing. `listener` itself is deliberately not in
    // the message — a function has no name worth printing and the session id is
    // what identifies the loss.
    const onWarning = options.onWarning;
    this.log = new SessionLog(
      id,
      store,
      onWarning === undefined
        ? undefined
        : (_listener, error) =>
            onWarning(`a stream listener on ${id} threw and was dropped: ${describeError(error)}`),
    );
    this.sessionStore = options.sessionStore ?? null;
    this.runtime = options.runtime ?? new LocalRuntime();
    this.uploads = options.uploads ?? null;
    this.elicitationAllowed = options.elicitationAllowed ?? (() => true);

    const init = options.restore ?? {};
    this.createdAt = init.createdAt ?? Date.now();
    this.restoredAgentSessionId = init.agentSessionId ?? null;
    this.restoredAgentHandle = init.agentHandle ?? null;
    this.exitRecord = init.exit ?? null;
    this.turnCounter = init.turnCounter ?? 0;
    this.lastEventAt = init.lastEventAt ?? null;
    this.askSeq = init.askSeq ?? 0;
    this.askSalt = init.askSalt ?? randomBytes(2).toString("hex").slice(0, 3);
    this.resumeGivenUp = init.resumeGaveUp ?? null;
    // Before the touchSafe below, or the first row written would say this session
    // has no name and no pin — which for a *restored* one would be a lie that the
    // next unrelated touch would then persist over the truth.
    this.titleValue = init.title ?? null;
    this.pinnedValue = init.pinned ?? false;
    this.ultracodeChoice = init.ultracode ?? null;
    this.ultracodeDefault = options.ultracodeDefault ?? (() => false);

    // Write the row before anything can be appended to it. `start()` does not
    // touch before its 45-second await, so without this a daemon killed during
    // agent startup would leave events belonging to no session. Zero watchers are
    // registered yet, so this is a pure write.
    this.touchSafe();
  }

  /** Records where this session lives, and anything worth warning about it. */
  recordWorkspace(warnings: readonly WorkspaceWarning[]): void {
    this.safeAppend({
      type: "workspace",
      mode: this.workspace.mode,
      root: this.workspace.root,
      requestedCwd: this.workspace.requestedCwd,
      branch: this.workspace.git?.branch ?? null,
      baseCommit: this.workspace.git?.baseCommit ?? null,
      plainReason: this.workspace.plainReason,
      warnings: warnings.map((warning) => ({ code: warning.code, message: warning.message })),
    });
    this.touchSafe();
  }

  /**
   * Rebuilds a session from disk. Never spawns — the agent died with the daemon.
   *
   * Takes the same options object the constructor does rather than a positional
   * list. It was six positionals and every new seam added a seventh, which is
   * the arrangement where two of them get transposed and the compiler agrees
   * because both are optional functions.
   */
  static restore(
    row: PersistedSession,
    store: EventStore,
    options: Omit<ManagedSessionOptions, "restore"> = {},
  ): ManagedSession {
    return new ManagedSession(row.id, row.agent, row.workspace, store, {
      ...options,
      customAgent: row.customAgent,
      restore: {
        createdAt: row.createdAt,
        agentSessionId: row.agentSessionId,
        agentHandle: row.agentHandle,
        exit: row.exit,
        turnCounter: row.turnCounter,
        lastEventAt: row.lastEventAt,
        askSeq: row.askSeq,
        askSalt: row.askSalt,
        // Validated on the way in rather than trusted: the column is a plain
        // string on disk and a row written by a future version could hold a
        // member this one does not know. An unrecognised value reads as "not
        // given up", which costs one spawn and is the safe direction — the
        // alternative is a session silently never coming back.
        resumeGaveUp: isPersistedGiveUp(row.resumeGaveUp) ? row.resumeGaveUp : null,
        title: row.title,
        pinned: row.pinned,
        ultracode: row.ultracode,
      },
    });
  }

  /** What this session is called, or `null` if nobody has named it. */
  get title(): string | null {
    return this.titleValue;
  }

  /** Whether it is kept at the top of the list. */
  get pinned(): boolean {
    return this.pinnedValue;
  }

  /** Where the agent runs. Kept as a field-shaped accessor so callers are unchanged. */
  get cwd(): string {
    return this.workspace.root;
  }

  /** What the client originally asked for. Feeds the directory picker. */
  get requestedCwd(): string {
    return this.workspace.requestedCwd;
  }

  /**
   * What this session is doing, derived on every read.
   *
   * Never stored, so it cannot drift from the pending map — a session with a
   * parked permission reports `blocked` because it *is* blocked, not because
   * something remembered to say so.
   */
  get status(): SessionStatus {
    if (this.exitRecord) {
      // Terminal like the rest, but the only one that resumes: the agent's own
      // session id outlived the process on both sides, and nobody chose this.
      // Read through `endedWithDaemon` rather than listing the reasons again —
      // the daemon's resume pass and every client ask the identical question,
      // and a second copy here is the one that drifts.
      if (endedWithDaemon(this.exitRecord)) return "interrupted";
      switch (this.exitRecord.reason) {
        case "start_failed":
        case "start_timeout":
          return "failed";
        default:
          return "exited";
      }
    }
    if (this.stopRequested) return "stopping";
    // Both maps, through one count. An approval and a question are the same fact
    // from this screen's point of view — something is waiting on a person — and a
    // session parked on a form that reported `running` would blink "working…"
    // over a question nobody had answered.
    if (this.awaitingCount > 0) return "blocked";
    if (this.turn !== null) return "running";
    if (this.session === null) return "starting";
    return "idle";
  }

  get terminal(): boolean {
    return this.exitRecord !== null;
  }

  /**
   * True when there is an agent conversation to reattach to.
   *
   * Deliberately *not* "ended only because the daemon did", which is what this
   * used to claim: a session somebody stopped is resumable too, and the manual
   * `POST /sessions/:id/resume` has always been allowed to do it. Which sessions
   * the daemon brings back *on its own* is a stricter question, and it is
   * `autoResumable`'s.
   */
  get resumable(): boolean {
    return this.terminal && this.agentSessionId !== null;
  }

  /** How this session ended, or `null` while it is still running. */
  get exit(): SessionExit | null {
    return this.exitRecord;
  }

  /** When something last happened here. `null` for a session that never spoke. */
  get lastActivityAt(): number | null {
    return this.lastEventAt;
  }

  /** How many times this daemon has already tried to bring it back. */
  get resumeAttemptCount(): number {
    return this.resumeAttempts;
  }

  /** Why the daemon stopped trying, or `null` while it still might. */
  get resumeAbandoned(): ResumeGiveUp | null {
    return this.resumeGivenUp;
  }

  /**
   * Whether the daemon has stopped trying for a reason a restart cannot change.
   *
   * The gate on both automatic paths. Without it a session whose conversation
   * the agent has forgotten is queued again on every boot and on every message
   * somebody types into it, spawning an agent each time to be told the same
   * thing.
   */
  get resumeSettled(): boolean {
    if (this.resumeGivenUp === null || !resumeGiveUpPersists(this.resumeGivenUp)) return false;
    /*
     * A conversation this daemon opened and never used is **not** settled, even
     * when a previous life wrote the verdict down.
     *
     * That verdict persists precisely because a restart cannot change what is on
     * the agent's disk — true, and it is exactly why it must not also mean
     * "nothing can be done". A cleared-and-unused conversation is recreatable by
     * construction, and a daemon that learns how to recover a class of session
     * must not be vetoed by a row written before it knew.
     *
     * Found the hard way: the very first session this recovery was built for had
     * already been marked `forgotten` on the boot before, so it was filtered out
     * of the queue and the new code never ran on it.
     */
    return !this.conversationKnownEmpty();
  }

  /**
   * One failed attempt: spends budget, and says nothing in the log.
   *
   * Nothing is appended here on purpose. A crash-looping session would otherwise
   * write an event per attempt into a log that evicts a *prefix* — spending the
   * operator's own first prompt to record the same failure three times. The one
   * `error` event comes from {@link abandonResume}, at the end.
   */
  noteResumeFailure(code: string, message: string): number {
    this.resumeAttempts += 1;
    this.lastResumeFailureAt = Date.now();
    this.resumeError = { code, message };
    this.touchSafe();
    return this.resumeAttempts;
  }

  /**
   * Stop trying, and say so exactly once.
   *
   * The `error` event is what makes this visible in a transcript somebody opens
   * later; the snapshot field is what makes it visible in a list they never
   * open. Both are needed and they are not the same audience.
   */
  abandonResume(reason: ResumeGiveUp, code: string, message: string): void {
    if (this.resumeGivenUp !== null) return;
    this.resumeGivenUp = reason;
    this.lastResumeFailureAt = Date.now();
    this.resumeError = { code, message };
    this.safeAppend({
      type: "error",
      message: `could not reattach an agent to this session: ${message}`,
      data: { code, reason },
    });
    this.touchSafe();
  }

  get agentSessionId(): string | null {
    return this.session?.sessionId ?? this.restoredAgentSessionId;
  }

  get agentHandle(): AgentHandle | null {
    return this.session?.handle ?? this.restoredAgentHandle;
  }

  /**
   * How many things are waiting on a person, of either kind.
   *
   * The in-class twin of the exported {@link awaitingHuman}, and it exists
   * because `status` runs *before* a snapshot exists — `snapshot()` calls it, so
   * it cannot read one. Two forms of one rule is exactly the drift the predicate
   * is meant to prevent, so `daemoncheck` asserts the two agree on a session
   * holding only a question.
   *
   * (An earlier draft named `oldestPendingAt` here as a second caller. It is not
   * one: that getter has no callers anywhere, and predates this change.)
   */
  private get awaitingCount(): number {
    return this.pending.size + this.pendingElicitations.size;
  }

  private *awaiting(): Iterable<{ raisedAt: number }> {
    for (const record of this.pending.values()) yield record.info;
    for (const record of this.pendingElicitations.values()) yield record.info;
  }

  /** When the longest wait began, of either kind, for "blocked for how long". */
  get oldestPendingAt(): number | null {
    let oldest: number | null = null;
    for (const info of this.awaiting()) {
      if (oldest === null || info.raisedAt < oldest) oldest = info.raisedAt;
    }
    return oldest;
  }

  /**
   * A frozen point-in-time copy.
   *
   * Copied, not referenced: a frame built now and serialized four seconds later
   * must describe now, not some moment in between that never existed.
   */
  snapshot(): SessionSnapshot {
    const stats = this.log.stats();
    return Object.freeze({
      id: this.id,
      agent: this.agent,
      customAgent: this.customAgent,
      cwd: this.cwd,
      workspace: { ...this.workspace, git: this.workspace.git && { ...this.workspace.git } },
      status: this.status,
      agentSessionId: this.agentSessionId,
      agentHandle: this.agentHandle,
      turn: this.turn,
      turnStartedAt: this.turnStartedAt,
      cancelRequestedAt: this.cancelRequestedAt,
      lastEventAt: this.lastEventAt,
      createdAt: this.createdAt,
      // Primitives, so `Object.freeze` being shallow is not a problem the way it
      // is for `workspace` and `agentConfig` above.
      title: this.titleValue,
      pinned: this.pinnedValue,
      // Copied rather than referenced, like `workspace` above: `Object.freeze` is
      // shallow, and a frame built now must describe now.
      contextUsage:
        this.contextUsageState === null
          ? null
          : { ...this.contextUsageState, cost: this.contextUsageState.cost && { ...this.contextUsageState.cost } },
      agentConfig: snapshotConfig(
        withUltracode(this.snapshotConfigSource, this.agent, this.ultracodeWanted),
        this.modelNamespace,
      ),
      commandsRevision: this.commandsRevisionValue,
      // The derived floor rather than the raw `firstSeq`. A client reads this as
      // "the lowest seq this daemon still has", and the raw value is 0 when the
      // log holds nothing for a session whose sequence is already high — which
      // told the browser history began at 1 and left its "load earlier" button
      // paging a log with nothing in it, for ever.
      firstSeq: oldestAvailable(stats),
      lastSeq: stats.lastSeq,
      dropped: stats.dropped,
      pendingPermissions: [...this.pending.values()].map((record) => ({
        ...record.info,
        options: [...record.info.options],
      })),
      // Copied, like the array above — `snapshot()` returns a frozen point in
      // time, and `Object.freeze` is shallow. `info` is a flat record of scalars,
      // so a spread is the whole copy.
      pendingElicitations: [...this.pendingElicitations.values()].map((record) => ({
        ...record.info,
      })),
      exit: this.exitRecord === null ? null : { ...this.exitRecord },
      ...(this.resumeState === null ? {} : { resume: this.resumeState }),
    });
  }

  /**
   * What the auto-resume pass has to say about this session, or nothing.
   *
   * Spread onto the snapshot only when it exists, so the field stays *absent*
   * for the sessions nobody has thought about — which is every live one. A
   * `null` there would mean something, and what it would mean is exactly what
   * absence already means, one allocation cheaper on a record built for sixty
   * sessions every four seconds.
   *
   * The error is clamped here rather than at the point it is recorded, because
   * this is the boundary it crosses: the strings come from an agent's own
   * failure message, which nothing bounds on the way in.
   */
  private get resumeState(): SessionResumeState | null {
    if (this.resuming !== null) {
      return { state: "running", attempts: this.resumeAttempts, error: null, at: Date.now() };
    }
    // A live session has nothing to say here, and this is a guard rather than an
    // assertion: the counters are only ever raised by a failure, which restores
    // the exit, and only ever cleared by the success that follows — so a running
    // session with attempts on it should be unreachable. Structural beats
    // remembering to reset in a second place.
    if (!this.terminal) return null;
    if (this.resumeGivenUp !== null) {
      return {
        state: "failed",
        attempts: this.resumeAttempts,
        error: this.resumeError && {
          code: this.resumeError.code.slice(0, MAX_RESUME_ERROR_CODE_CHARS),
          message: clip(this.resumeError.message, MAX_RESUME_ERROR_MESSAGE_CHARS),
        },
        at: this.lastResumeFailureAt ?? Date.now(),
      };
    }
    if (this.resumeAttempts === 0) return null;
    return {
      state: "waiting",
      attempts: this.resumeAttempts,
      error: this.resumeError && {
        code: this.resumeError.code.slice(0, MAX_RESUME_ERROR_CODE_CHARS),
        message: clip(this.resumeError.message, MAX_RESUME_ERROR_MESSAGE_CHARS),
      },
      at: this.lastResumeFailureAt ?? Date.now(),
    };
  }

  /**
   * Carry out a `/clear`: the agent forgets, the transcript does not.
   *
   * Here rather than in `session.ts` for the reason every other out-of-turn append
   * is here: `Session` has no `SessionLog`, and the registry owns what goes into the
   * transcript. It used to be argued from the queue draining only inside a turn —
   * true then, and no longer, since a `ManagedSession` reads it between turns; the
   * conclusion is unchanged because it never depended on that.
   *
   * The prompt is recorded first and unconditionally, because it is what
   * somebody typed and the log is a record of that rather than of what worked.
   * The boundary is appended only on success, because it is a claim about the
   * agent.
   */
  async clearContext(text: string): Promise<ClearResult> {
    if (this.terminal) return { kind: "terminal", status: this.status, exit: this.exitRecord };
    if (this.stopRequested) return { kind: "terminal", status: this.status, exit: null };
    const session = this.session;
    if (!session) return { kind: "not_ready", status: this.status };
    // Refused mid-turn rather than queued. Clearing under a running agent means
    // deciding what happens to the turn's own output, and there is no answer to
    // that which is not a surprise to somebody.
    if (this.turn !== null || this.clearing || this.restarting) return { kind: "busy", status: this.status };

    // `?? 0` for the same reason `prompt` uses it: a store that refused the
    // insert still returns a placeholder at that seq, and the caller needs a
    // number rather than a reason to give up on an operation that will happen.
    const seq = this.safeAppend({ type: "prompt", text, attachments: [] })?.seq ?? 0;
    // Set before the append is even flushed and, crucially, before the await
    // below: see the field. Everything from here to the `finally` runs with the
    // agent's session id being replaced underneath it, and nothing else may
    // issue a request in that window.
    this.clearing = true;
    this.touchSafe();

    try {
      const moved = await session.clearContext();
      this.restoredAgentSessionId = moved.next;
      this.safeAppend({
        type: "context_cleared",
        agentSessionId: moved.next,
        previousAgentSessionId: moved.previous,
      });
      // The new session publishes its own controls, and they are the ones a client
      // must now draw — `restoreConfig` puts back what it can, and what it could
      // not is a fact the strip has to show rather than hide.
      this.applyAgentConfig(session.agentConfig);
      this.touchSafe();
      return { kind: "cleared", seq };
    } finally {
      // In a `finally` because a failed clear must not leave the session refusing
      // every prompt for the rest of its life — `session.clearContext` can throw,
      // and the conversation it was replacing is then still the live one.
      this.clearing = false;
    }
  }

  /** Notified whenever the snapshot changes. Unsubscribe with the returned fn. */
  watch(watcher: SessionWatcher): () => void {
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  /* --------------------------------------------------------------------- *
   * Lifecycle
   * --------------------------------------------------------------------- */

  /**
   * Whether this session's next agent is asked for ultracode.
   *
   * A getter and never a field: `ultracodeChoice` is what somebody decided, the
   * default is what the machine is set to, and the fold has to happen at the
   * moment of a launch. See {@link ManagedSessionOptions.ultracodeDefault}.
   */
  private get ultracodeWanted(): boolean {
    return this.ultracodeChoice ?? this.ultracodeDefault();
  }

  /**
   * Which system and model this session runs on, read fresh at every launch.
   *
   * `{}` for a bare harness, which is every session started before assembled
   * agents existed — and spreading nothing is what keeps `Session.start`'s
   * behaviour for those byte for byte what it was.
   *
   * **Two degradations, and they are the same demotion for the same reason.** A
   * preset can be deleted under a sleeping session, and a preset can be
   * *re-pointed at another harness* under one — `PATCH /custom-agents/:id`
   * accepts a change of `harness` and weighs `hostable` against the body it was
   * given, which says nothing about a session that already exists. Either way
   * the preset has stopped describing this session, and either way the honest
   * answer is the bare harness the session's own `agent` column names rather
   * than a pairing nobody chose.
   */
  private get assembled(): { system?: SystemId; model?: string } {
    if (this.customAgent === null) return {};
    const one = this.resolveCustomAgent(this.customAgent);
    // A preset deleted under a sleeping session: the harness on its own is the
    // honest outcome, and it is what `agent` has said all along.
    if (one === null) return {};
    /*
     * An edit that re-points a preset at a different harness leaves the sessions
     * already started on it where they are, on the harness they were started
     * with, because **a conversation cannot change vendor underneath itself** —
     * `agent` is immutable, the agent process is spawned from it, and the
     * transcript on the other side belongs to that CLI.
     *
     * Spreading the new pair over the old harness was the behaviour this arm
     * replaces, and it failed both ways. Loudly: preset `{claude, anthropic,
     * opus}` edited to `{codex, openai, gpt-5-codex}` left a claude session
     * resuming with `system: "openai"`, whose `nativeHarness` is codex, so
     * `applySystem` reached `hostable` and every resume from then on answered
     * `502 system_not_routable` with nothing on any screen connecting it to the
     * edit. Quietly, which is worse: edited to `{kimi, moonshot,
     * kimi-k2-thinking}` it left the claude harness routed at Moonshot on that
     * model — a triple `hostable` permits and `POST /sessions` could never have
     * produced — while the preset, the tile and the glyph all said Kimi Code.
     */
    if (one.harness !== this.agent) return {};
    return { system: one.system, model: one.model };
  }

  /**
   * The model-id prefix this session's own system spells, or `null`.
   *
   * `null` for a bare harness, for a routed pairing — where the agent's list is
   * the harness's own and nothing namespaces it — and for every system that sets
   * no `nativeModelPrefix`, which is all of them but opencode's two. Read through
   * {@link assembled}, so a preset re-pointed at another harness answers `null`
   * here for the same reason it answers no system there.
   */
  private get modelNamespace(): string | null {
    const system = this.assembled.system;
    if (system === undefined) return null;
    const spec = SYSTEMS[system];
    return spec.nativeHarness === this.agent ? spec.nativeModelPrefix : null;
  }

  /**
   * The whole option bag a launch is made with, in one place.
   *
   * ⚠ **One getter because there are three launch sites, and an omission at any
   * of them is silent.** `doResume`'s empty-conversation arm wrote the bag out
   * by hand and left `...assembled` off it, and nothing refused the result:
   * with no `system`, `spawnEnvOf` returns `{}` so no routed-model variable is
   * set, and `applySystem` returns at its first line so `client.routing()`,
   * `hostable` and `providers/set` are never reached and `SystemRoutingError`
   * cannot fire. The agent opened a conversation on the harness's own vendor,
   * account and default model while `sessions.custom_agent` and the snapshot went
   * on naming the assembled agent — exactly the failure with no symptom
   * `.claude/rules/agent-systems.md` names under *"Routable and un-pinnable must
   * refuse"*. That arm is not an edge, either: `conversationKnownEmpty` answers
   * `true` for every `turnCounter === 0`, so every created-but-unprompted session
   * took it, on a restart, on Resume, and on an ultracode toggle.
   *
   * ⚠ **Everything here is re-read at the launch and nothing is remembered.**
   * `assembled` goes back to the preset store, so an edit takes effect without a
   * daemon restart and routing — which lives in the agent *process* — cannot be
   * lost by a resume; `ultracodeWanted` folds in the machine default, which
   * claude reads when the conversation is opened, so a resume without it comes
   * back quietly demoted; `elicitationAllowed` is a thunk for the same reason.
   *
   * A resume adds `agentSessionId` and nothing else, which is what makes one bag
   * correct for all three sites — and what makes a fourth site unable to
   * disagree with the other three.
   */
  private get launchOptions(): SessionOptions {
    return {
      agent: this.agent,
      ...this.assembled,
      cwd: this.cwd,
      permissions: this.resolvePermission,
      elicitations: this.elicitationAllowed() ? this.resolveElicitation : null,
      runtime: this.runtime,
      keepImage: this.keepAgentImage,
      ultracode: this.ultracodeWanted,
    };
  }

  async start(timeoutMs = START_TIMEOUT_MS): Promise<void> {
    this.safeAppend({ type: "status", status: "starting", exit: null });
    await this.launch(Session.start(this.launchOptions), timeoutMs);
  }

  /** Adopts a starting agent, bounded by `timeoutMs`. Shared by start and resume. */
  private async launch(starting: Promise<Session>, timeoutMs: number): Promise<void> {
    this.startPromise = starting;

    // This promise is never dropped, whatever happens to the request that began
    // it. A late resolve owns a live subprocess with piped stdio; if nothing is
    // holding a reference, nothing will ever dispose it.
    //
    // **The launch identifies itself to its own callbacks**, which is the same
    // `this.session !== session` check every other late notification in this class
    // already makes. `startAbandoned` cannot do that job: it is cleared by the
    // *next* `armForStart()`, so a launch that timed out at 45s and resolved at
    // 48s — ordinary, since nothing bounds `session/new` or `session/resume` end
    // to end — arrived to find the flag already reset by the retry, was adopted as
    // the live session, and was then overwritten by the retry's own agent two
    // seconds later. The displaced agent is `detached`, holds the session's
    // worktree, is referenced by nothing (`doStop` awaits `startPromise`,
    // `shutdown` collects `session.agentHandle`) and survives the daemon's own
    // exit, invisible to the next boot's reaper because the persisted pid is the
    // other one's.
    starting.then(
      (session) => this.onStarted(starting, session),
      (error: unknown) => this.onStartFailed(starting, error),
    );

    const timeout = Symbol("timeout");
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<typeof timeout>((resolve) => {
      timer = setTimeout(() => resolve(timeout), timeoutMs);
    });
    const outcome = await Promise.race([
      starting.then(
        () => null,
        (error: unknown) => error ?? new Error("agent failed to start"),
      ),
      expiry,
    ]).finally(() => clearTimeout(timer));

    if (outcome === timeout) {
      this.startAbandoned = true;
      throw new StartTimeoutError(this.id, timeoutMs);
    }
    if (outcome !== null) throw outcome;
  }

  /**
   * Reattaches a fresh agent to this session's earlier conversation.
   *
   * This is the only terminal → non-terminal transition in the daemon, which is
   * why it resets the whole ended-ness of the session in one place: `exitRecord`
   * decides `status` and `terminal`, `stopRequested` gates every permission, and
   * `stopping` is memoised so a later stop() would otherwise return the promise
   * from the *previous* life and resolve immediately without killing anything.
   *
   * Turn numbering continues from the persisted counter rather than restarting,
   * so turn 4 means the fourth turn of the conversation and not the fourth since
   * the last crash.
   */
  async resume(timeoutMs = START_TIMEOUT_MS, quiet = false): Promise<void> {
    /*
     * Memoised like `stopping`, and for a symmetrical reason.
     *
     * Two prompts arriving together — a phone that retried, or the boot pass
     * meeting somebody's first message — used to have the second one lose:
     * the first clears `exitRecord` synchronously, so by the time the second
     * arrives the session is no longer `terminal` but does not yet have a
     * `session`, and `prompt` answers `not_ready`. Joining the promise makes the
     * second request wait for the launch it was going to need anyway.
     *
     * This replaces the old behaviour where a concurrent second call got
     * `409 session_live`. That throw is still here for a genuinely live session,
     * which is the case it was actually written for.
     */
    if (this.resuming) return this.resuming;
    this.quietResume = quiet;
    this.resuming = this.doResume(timeoutMs, quiet);
    try {
      await this.resuming;
    } finally {
      this.resuming = null;
      this.quietResume = false;
    }
  }

  /**
   * Clears everything that makes this session look ended, so `launch` can run.
   *
   * Extracted because it has two callers now: a resume, and the fresh
   * conversation that recovers a cleared session whose empty one the agent never
   * wrote down. `stopping` is in the list for the reason spelled out on
   * `resume` — a memoised promise from the previous life would make a later
   * `stop()` resolve without killing anything.
   */
  /**
   * What a resume that worked has to forget: everything this daemon learned from
   * the attempts that did not.
   *
   * `resumeGivenUp` is in the list because a session abandoned over a stalled
   * mount and then brought back must not stay marked as hopeless on the snapshot
   * for the rest of the daemon's life.
   */
  private onResumed(): void {
    this.resumeAttempts = 0;
    this.lastResumeFailureAt = null;
    this.resumeError = null;
    this.resumeGivenUp = null;
    this.touchSafe();
  }

  private armForStart(): void {
    this.exitRecord = null;
    this.stopRequested = false;
    this.stopping = null;
    this.startAbandoned = false;
    this.startPromise = null;
    this.session = null;
  }

  /**
   * Whether the current conversation is one nothing has ever been said in.
   *
   * **Two arms, because there are two ways to get there**, and they are the two
   * ways a conversation ends up with no existence on the agent's disk. claude
   * writes a transcript **lazily, with the first turn**, so a conversation that
   * never had one was never written down at all. A session nobody ever spoke to
   * is in that state from birth; a cleared one is put back into it by
   * `clearContext`, which mints a fresh empty conversation through
   * `session/new`. Measured in production: resuming either fails, and the
   * session could not be brought back at all, which is worse than the bug the
   * clear interception was built to fix.
   *
   * The first arm is `turnCounter === 0` — a field on the row, so it needs no
   * window and cannot age out of one. The second walks the log, and *that* is
   * where the correction below applies.
   *
   * The second arm asks about the *log*, not about an id, and that correction
   * is the point. Its first version compared the marker's `agentSessionId` to
   * the current one, and worked exactly once: the recovery opens *another* empty
   * conversation and deliberately appends no marker for it, so the next restart
   * found no record naming the new id and gave up. Which id is current is not
   * the question. If nothing has been said since the last clear then whatever
   * conversation is current is empty, however many times it has been reopened.
   *
   * Narrow where it matters and safe at the edges — of the second arm, which is
   * the one with edges. It wants a `context_cleared` with no `prompt` after it —
   * the `/clear` itself is appended *before* the marker, so only a later prompt
   * counts — and it reads a bounded tail, so a marker older than the window is
   * simply not found and nothing is recreated.
   */
  private conversationKnownEmpty(): boolean {
    /*
     * A session that has never run a turn is empty for the first reason, and
     * `turnCounter` is the durable, unambiguous way to know it.
     *
     * Measured 2026-08-05: a session created at 13:56 and left untouched failed
     * to resume exactly the way a cleared one did. claude writes a transcript
     * with the first *turn*, so a conversation that never had one has no
     * existence on disk — whether it got that way through `session/new` at
     * creation or through a clear. The predicate knew only the second and
     * stranded the first.
     *
     * Deliberately **not** "no `prompt` in the log". That was tried and is
     * wrong: an empty log is not evidence of an empty conversation, only of an
     * empty log — events are pruned, and a restored session may have its history
     * somewhere this store does not hold.
     *
     * What is true of `turnCounter` is that it is written by the same row write
     * as `agentSessionId`, so a restore can never see one without the other.
     * What is **not** true is that the two describe the same conversation —
     * `clearContext` moves the id and leaves the counter alone, so after a clear
     * the counter is still counting the conversation the fork left behind. That
     * is precisely why the walk below is still required rather than subsumed:
     * this arm answers for a session nobody ever spoke to, and for nothing else.
     */
    if (this.turnCounter === 0) return true;

    const stats = this.log.stats();
    const from = Math.max(0, stats.lastSeq - UNUSED_CONVERSATION_LOOKBACK);
    /*
     * The whole window is walked and the answer is whichever came **last**, a
     * marker or a prompt. Returning early on the first prompt after the first
     * marker is wrong and was measured wrong: a session cleared twice has an
     * older marker with its own conversation after it, and stopping there
     * answers about a conversation two generations dead.
     *
     * A prompt resets rather than decides, so the `/clear` that *precedes* its
     * own marker costs nothing — the marker follows and sets it again.
     */
    let cleared = false;
    for (const stored of this.log.read(from, UNUSED_CONVERSATION_LOOKBACK + 1, MAX_LOOKBACK_BYTES)) {
      const type = stored.event.type;
      if (type === "context_cleared") cleared = true;
      else if (type === "prompt") cleared = false;
    }
    return cleared;
  }

  private async doResume(timeoutMs: number, quiet: boolean): Promise<void> {
    const agentSessionId = this.agentSessionId;
    if (agentSessionId === null) throw new ResumeUnavailableError(this.id, "no_agent_session_id");
    if (!this.terminal) throw new ResumeUnavailableError(this.id, "session_live");

    const previousExit = this.exitRecord;
    this.armForStart();

    // Same argument as `onStartFailed`: on the automatic path this is one half
    // of a round trip nobody asked for, and the snapshot already says a resume
    // is running. A person who pressed Resume is watching, so they still get it.
    if (!quiet) {
      this.safeAppend({ type: "status", status: "starting", exit: null });
    }
    this.touchSafe();

    /*
     * An empty conversation is opened, not resumed — asked once, up front.
     *
     * claude writes its transcript **lazily, with the first turn**, so a
     * conversation that never had one names nothing on disk and asking the agent
     * to restore it can only fail. Two ways in: `clearContext` mints an empty
     * conversation through `session/new`, and a session created and never
     * prompted has been in that state since birth. Measured in production, both
     * of them — the session could not be brought back at all, which is worse
     * than the bug the clear interception was built to fix, because the old
     * failure left a working session with the wrong memory and this one left no
     * session.
     *
     * Opening another empty conversation is *identical* rather than
     * approximate: there was nothing in the old one to lose, and empty is what
     * clearing — or never speaking — asked for. Deciding it here rather than in
     * a catch is what makes it one agent spawn instead of two: the doomed resume
     * is not attempted at all, and nothing about it reaches the log.
     *
     * `conversationKnownEmpty` is the whole gate, and it is narrow by
     * construction on both arms: a turn counter still at zero, or a
     * `context_cleared` with no `prompt` after it, the latter failing safe
     * outside its window. Every other lost conversation resumes and, if the
     * agent has forgotten it, stays stalled — because silently handing somebody
     * a fresh agent while they expect their history restored is the same quiet
     * lie as handing back what they cleared.
     *
     * Nothing is appended on success either way. A cleared transcript already
     * carries its marker and an untouched one has nothing to say; either way
     * saying it again would imply a second thing happened, when semantically the
     * state is unchanged — empty before, empty now.
     */
    const empty = this.conversationKnownEmpty();
    try {
      /*
       * ⚠ **Both arms take the same bag, and the asymmetry that used to be here
       * was a bug rather than a decision.** This arm was written out by hand
       * without the assembled agent's system and model, so every unprompted
       * session — which is every session at `turnCounter === 0` — came back on
       * the harness's own vendor and default model, silently, while still
       * reporting itself as the assembled agent. What differs between a start
       * and a resume is `agentSessionId` and nothing else; see
       * {@link launchOptions}.
       */
      await this.launch(
        empty
          ? Session.start(this.launchOptions)
          : Session.resume({ ...this.launchOptions, agentSessionId }),
        timeoutMs,
      );
      this.onResumed();
    } catch (error) {
      // Put the original exit back. The commonest failure here is the agent no
      // longer recognising the session id, and letting `onStartFailed`'s
      // `start_failed` stand would rewrite `daemon_restarted` out of existence —
      // the same erasure `doStop`'s `exitRecord ??=` exists to prevent, reached
      // through the other door. The session stays retryable either way.
      if (previousExit) {
        this.exitRecord = previousExit;
        if (!quiet) {
          this.safeAppend({ type: "status", status: this.status, exit: this.exitRecord });
        }
        this.touchSafe();
      }
      throw error;
    }
  }

  private onStarted(launch: Promise<Session>, session: Session): void {
    // Not the launch this session is waiting on any more, so this agent belongs
    // to nobody: dispose it here or it runs for ever. Before `this.session` is
    // assigned, deliberately — adopting it first is what let a superseded agent
    // become the live one for the two seconds until the real launch resolved,
    // during which a prompt would have started a turn on the agent about to be
    // discarded.
    if (this.startPromise !== launch) {
      void session.dispose().catch(() => {});
      return;
    }

    this.session = session;
    // Carried separately so it outlives the process. This is the entire resume
    // story: every agent keeps its side of this id on disk, so it is still
    // meaningful to a fresh subprocess after a restart.
    this.restoredAgentSessionId = session.sessionId;
    this.restoredAgentHandle = session.handle;

    // The connection can close while the process lives, and the process can die
    // while the session is idle. Either way this must end in dispose(), not just
    // a status field, or we mark a live agent "exited" and lose our last handle.
    void session.exited.then(
      () => this.onAgentGone(session),
      () => this.onAgentGone(session),
    );

    if (this.stopRequested || this.startAbandoned) {
      void session.dispose().catch(() => {});
      return;
    }

    // Read once, then subscribe. The initial state is already known by the time
    // `Session.start` resolves, and the *registry* appends the event rather than
    // `session.ts` for the same reason it appends permission events: `Session` holds
    // no log, and this state arrives on its own channel rather than through the
    // event queue at all.
    this.unsubscribeConfig?.();
    this.applyAgentConfig(session.agentConfig);
    this.unsubscribeConfig = session.onConfigChanged((config) => {
      // Identity-checked like `onAgentGone`: a resume replaces `this.session`,
      // and a late notification from the previous agent must not overwrite the
      // controls of the one that replaced it.
      if (this.session !== session) return;
      this.applyAgentConfig(config);
    });

    // Same read-once-then-subscribe shape, same identity check, for the same
    // reason — a resumed agent's window occupancy is not the previous one's.
    this.unsubscribeUsage?.();
    const initialUsage = session.contextUsage;
    if (initialUsage !== null) this.applyContextUsage(initialUsage);
    this.unsubscribeUsage = session.onUsageChanged((usage) => {
      if (this.session !== session) return;
      this.applyContextUsage(usage);
    });

    /*
     * The same shape again — and here the read-once half is load-bearing rather
     * than symmetric.
     *
     * Both adapters schedule `available_commands_update` on a `setTimeout(…, 0)`
     * taken *after* they answer `session/new`, so it can land inside `Session`
     * between `Session.start` resolving and this line running — into a listener
     * set that is still empty. Subscribing without reading would therefore lose
     * the whole list on every session that started quickly, intermittently, with
     * nothing to show for it but an empty menu.
     */
    this.unsubscribeCommands?.();
    const initialCommands = session.agentCommands;
    if (initialCommands.commands.length > 0) this.applyAgentCommands(initialCommands);
    this.unsubscribeCommands = session.onCommandsChanged((commands) => {
      if (this.session !== session) return;
      this.applyAgentCommands(commands);
    });

    this.safeAppend({ type: "status", status: "idle", exit: null });
    this.startIdleDrain(session);
    this.touchSafe();
  }

  /**
   * Reads what the agent says when no turn is reading it.
   *
   * **The agent does not stop talking when the turn ends, and until this existed
   * nobody was listening.** `session/prompt` resolves while claude drives work it
   * has spawned; `Session.prompt`'s generator returns on `turn_end`; everything
   * after that went into a queue whose only consumer had gone. It was released by
   * the *next* prompt, which is why a conversation could sit silent for five
   * minutes, read as finished, and then produce a burst of dialog about work that
   * had happened long before the message that appeared to cause it. Measured on a
   * live log: 294,907 ms of silence, then 57 events inside a 2 ms span.
   *
   * Here rather than inside `Session` so a bare `Session` is untouched, which is
   * what keeps `harness` a regression test for the default paths.
   *
   * Safe to call without knowing whether a turn is running: `drainBetweenTurns`
   * answers a `null` claim by doing nothing. Called on adoption and again at the
   * end of every turn; it needs no explicit stop, because a turn displaces it and
   * `dispose` closes the queue under it.
   */
  private startIdleDrain(session: Session): void {
    session.drainBetweenTurns((event) => {
      /*
       * The identity check every late callback in this class makes, plus the one
       * this reader needs on its own account: `doStop` never nulls `this.session`,
       * and teardown can spend seconds in `sendCancel` and `session/close`, so
       * without `stopRequested` the agent's parting words would land *after*
       * `sweepPending` and before the terminal `status` event, on a session
       * somebody has already ended.
       */
      if (this.session !== session || this.stopRequested) return;

      /*
       * ⚠ **`agent_log` and `other` are dropped here, and that is what today
       * already does rather than a new loss.** Out of turn these were exactly what
       * `EventQueue` evicted first, which is why a fleet-wide count over five
       * database snapshots — 95,618 events — holds **zero** `agent_log` rows. The
       * producer runs for the whole life of the agent process, not just during
       * turns, so recording them would put an unbounded stderr stream into a
       * per-session log that is deliberately `Infinity`/`Infinity`; make
       * `REEMOAT_LOG_EVENTS` actively harmful, since that eviction is a *prefix*
       * and would spend somebody's first prompt on stderr; charge against the
       * tab's 16 MiB ceiling, which evicts from the oldest and would push the
       * start of the conversation out; and bury a reattaching phone behind
       * `ATTACH_REPLAY_MAX`, which is a *seq* window and cannot tell machinery
       * from conversation. Neither type is drawn anywhere, and the last 20 stderr
       * lines are already on `Session.recentLogs()`.
       */
      if (event.type === "agent_log" || event.type === "other") return;

      try {
        this.record(event);
      } catch {
        // Already degraded inside the store, exactly as `pump` has it. Guarded
        // here rather than around the whole callback so one failed append cannot
        // end the drain.
      }
    });
  }

  /** Mirrors the agent's controls onto the snapshot and into the transcript. */
  private applyAgentConfig(config: AgentConfig): void {
    this.agentConfigState = config;
    this.safeAppend({ type: "agent_config", modes: config.modes, options: config.options });
    this.touchSafe();
  }


  /**
   * Mirrors the agent's command list, and moves the number that announces it.
   *
   * Appends nothing to the log — `applyContextUsage`'s rule below, reached by a
   * different road: this is state superseded whole, and the log evicts a
   * *prefix*, so a logged list would cost the operator's own first prompt to
   * re-record something that is replaced rather than accumulated.
   *
   * **Gated on the list actually differing**, which is `applyContextUsage`'s rule
   * rather than `applyAgentConfig`'s, and the reasoning that put it on the other
   * side was wrong. It said a command list has no rate — but the rate here is a
   * property of the *agent's* output, not of this daemon: claude republishes from
   * `commands_changed`, which fires as skills are discovered while it walks a
   * subdirectory, so an identical list can arrive repeatedly during one turn. And
   * a bump is far from free at either end. Here it builds a snapshot, writes a row
   * and enqueues a frame per attached client, on the agent's synchronous emit
   * path; there it makes every attached client refetch the whole list — 18.7 KiB
   * measured — over the relay, to a phone. `usageWorthAnnouncing` exists for the
   * same shape one field over, and the amplification is larger here.
   *
   * The comparison is cheap by construction: `toCommands` has already bounded the
   * list to 256 entries of bounded strings before this ever sees it.
   */
  private applyAgentCommands(commands: AgentCommands): void {
    if (sameCommands(this.agentCommandsState, commands)) return;
    this.agentCommandsState = commands;
    this.commandsRevisionValue += 1;
    this.touchSafe();
  }

  /** The live agent's command list, served by its own route rather than the snapshot. */
  get agentCommands(): AgentCommands {
    return this.agentCommandsState;
  }

  get commandsRevision(): number {
    return this.commandsRevisionValue;
  }

  /**
   * Mirrors the agent's context occupancy onto the snapshot.
   *
   * The field is assigned on *every* update, so a poller and a fresh attach always
   * read the exact current number. What is coalesced is the **fan-out**, and that
   * is the whole of this method.
   *
   * Measured 2026-07-31 against claude-agent-acp 0.63.0: `usage_update` is emitted
   * from the `message_delta` handler, i.e. on essentially every streaming token.
   * `touchSafe()` builds a snapshot, writes a row and enqueues a `{type:"snapshot"}`
   * frame *per attached client* — so an unconditional call here would be thousands
   * of frames per turn, generated on the agent's own synchronous emit path, against
   * an 8000-item outbound queue. That is not a slow consumer; that is us.
   *
   * The rule is what a client can actually *see* change: the whole percent, the
   * window size, or the cost. At most ~100 fan-outs per turn instead of thousands,
   * and no client can tell the difference, because the number it draws is the one
   * that changed. `applyAgentConfig` above still touches unconditionally — a mode
   * change has no rate.
   *
   * Nothing is appended to the log. This is state, not narrative, and the log has
   * a 5000-event budget that real transcript is competing for.
   */
  private applyContextUsage(usage: ContextUsage): void {
    const before = this.contextUsageState;
    this.contextUsageState = usage;
    if (before !== null && !usageWorthAnnouncing(before, usage)) return;
    this.touchSafe();
  }

  /**
   * Renames or pins this session.
   *
   * Deliberately unlike {@link setConfigOption} in three ways, each of which is a
   * decision rather than an omission. It is synchronous, because no agent is
   * involved. It has no `not_ready` refusal, because nothing here needs a live
   * agent. And it has no `terminal` refusal, because naming a session you have
   * finished with so you can find it again next week is exactly a thing people
   * do — refusing on a terminal session would make the feature useless at the one
   * moment it is most wanted.
   *
   * An absent field is "leave it alone"; `title: null` is "clear it", which lets
   * the next prompt derive a fresh one. Normalization happens here rather than at
   * the route so there is one answer to "what is a legal title", and the caller is
   * handed the snapshot rather than an echo because the two differ.
   */
  setMeta(change: { title?: string | null; pinned?: boolean }): SessionSnapshot {
    if (change.title !== undefined) {
      this.titleValue = change.title === null ? null : normalizeTitle(change.title);
    }
    if (change.pinned !== undefined) this.pinnedValue = change.pinned;
    this.touchSafe();
    return this.snapshot();
  }

  /**
   * Changes one of the agent's controls, refusing anything it did not advertise.
   *
   * Validated here rather than at the route because this is where the advertised
   * set lives, and refusing locally keeps a typo from reaching the agent as a
   * JSON-RPC error whose text is the agent's, not ours. The value check is
   * deliberately against the *choices* rather than a format: `effort` and
   * `thinking` share a category and share no values at all.
   */
  async setConfigOption(configId: string, value: string | boolean): Promise<AgentConfigResult> {
    if (this.terminal || this.stopRequested) return { kind: "terminal", status: this.status };
    if (!this.session) return { kind: "not_ready", status: this.status };
    // Beside `prompt`'s guard and for the same reason, which the marker's own
    // docblock states as a rule over *everything* that talks to the agent: this
    // reaches `Session.setConfigOption`, which reads `this.sessionId` at request
    // time, and a clear is in the middle of replacing it. Two ways that goes
    // wrong, neither of them visible: the request lands on the conversation
    // `session/close` is about to destroy, or it lands during `restoreConfig`,
    // which is putting back a `wanted` snapshot captured *before* this change —
    // so the mode somebody just chose is silently overwritten by the pre-clear
    // one. `AgentConfigBar` sits beside the composer, so `/clear` and then a mode
    // tap is one gesture apart.
    if (this.clearing || this.restarting) return { kind: "busy", status: this.status };

    /*
     * The one control that is not the agent's to change, handled before anything
     * is validated against what the agent published — because what it offers is a
     * row the agent has never heard of.
     *
     * Both directions restart the agent, and both have to: the setting is read
     * when a conversation is opened, so turning it *off* by leaving it out of the
     * next `session/new` is the only way to turn it off at all. Choosing an
     * ordinary level therefore clears it first and then falls through to the
     * normal path, which applies that level to the agent this restart produced —
     * `this.session` is deliberately re-read below rather than captured above,
     * because by then it is a different object.
     */
    const ultracodeId = ultracodeOptionId(this.agentConfigState, this.agent);
    if (ultracodeId !== null && configId === ultracodeId) {
      const wanted = value === ULTRACODE_CHOICE;
      if (wanted !== this.ultracodeWanted) {
        // A restart mid-turn would kill the turn: `doStop` sweeps every parked
        // permission and disposes the agent, and the work in flight is not
        // re-sent by the resume that follows. The one refusal on this route that
        // really is about a turn — see `AgentConfigResult`.
        if (this.turn !== null) return { kind: "turn_in_flight", status: this.status };
        await this.applyUltracode(wanted);
      }
      // Nothing else to send: the agent has no such value, and no other value of
      // its own means this. The restart is the whole act.
      if (wanted) return { kind: "ok", config: this.snapshot().agentConfig };
    }

    const session = this.session;
    // Re-read after the restart above, and it can genuinely be absent: a resume
    // that failed leaves the session terminal, holding the choice that was just
    // recorded, to be picked up by the next prompt or the next boot.
    if (!session) return { kind: "not_ready", status: this.status };

    const option = this.agentConfigState.options.find((candidate) => candidate.id === configId);
    if (option === undefined) return { kind: "unknown_option", options: this.agentConfigState.options };
    if (option.kind === "boolean" && typeof value !== "boolean") {
      return { kind: "invalid_value", option };
    }
    if (option.kind === "select" && (typeof value !== "string" || !option.choices.some((c) => c.value === value))) {
      return { kind: "invalid_value", option };
    }

    // Nothing is applied here. `session.setConfigOption` fires `onConfigChanged`
    // before it resolves, so the listener above has already folded this in *and
    // appended the event* — calling `applyAgentConfig` again on the returned
    // value put a second, identical `agent_config` in the transcript for every
    // change, charged twice against the event budget and drawn twice by clients.
    // The answer is read back off the snapshot so it is the same state the
    // listener stored, which is what the removed call was reaching for.
    await session.setConfigOption(configId, value);
    return { kind: "ok", config: this.snapshot().agentConfig };
  }

  /**
   * Records the choice and puts an agent in front of it.
   *
   * The restart is not an implementation detail that could be optimised away
   * later: `ultracode` is read by the CLI when a conversation is opened, and the
   * only two ways to open one are a new agent or a `/clear`. Between them this is
   * the one that keeps the conversation, which is what somebody flipping a switch
   * on the composer expects to happen — the same trade a deploy already makes,
   * and the same machinery: `stop` then `resume`, on the same `agentSessionId`.
   *
   * The choice is written *first*, so a restart that fails leaves a session which
   * knows what it was asked for and will ask for it on the next attempt, rather
   * than one that has to be told twice.
   *
   * A session with no `agentSessionId` — created and never spoken to — has
   * nothing to reattach to and needs no restart: its first agent has not opened a
   * conversation yet, so recording the choice is the whole act.
   */
  private async applyUltracode(next: boolean): Promise<void> {
    this.ultracodeChoice = next;
    this.touchSafe();
    if (this.agentSessionId === null) return;
    await this.restartAgent();
  }

  /**
   * Replace this session's agent process, keeping the conversation.
   *
   * **Extracted rather than copied, because there are two callers now and the
   * sequence is not one anybody would reproduce correctly from memory.** It was
   * written for `ultracode` — a setting the agent reads when the conversation is
   * opened, so the only way to change it is to open a new one — and a pasted
   * credential is the same shape of fact: `secrets` are read at spawn, in
   * `env: { ...agentEnv(), ...this.secrets(agent) }`, so a token saved while an
   * agent is running reaches it never. Somebody pasted one, the badge turned
   * green, and the conversation in front of them went on failing to authenticate.
   *
   * `resume()` carries `agentSessionId`, so what comes back is *this*
   * conversation rather than a fresh one. The window in which the controls are
   * held and every instruction answers `busy` is opened synchronously below and
   * closed in the `finally` — see {@link restarting} for why that has to be one
   * statement and one `finally`.
   *
   * **Callers own the decision to do this at all.** Nothing here asks whether a
   * turn is in flight or a permission is parked, because `applyUltracode`'s
   * caller has already decided for its own reasons; see `reloadCredentials`,
   * which decides differently.
   */
  private async restartAgent(): Promise<void> {
    /*
     * Captured before the stop, because the stop is what destroys it.
     *
     * `doStop` assigns `agentConfigState = {modes: null, options: []}` and
     * `onStarted` then assigns whatever the *new* process published, with nothing
     * in between — so choosing ultracode put the mode back to the agent's own
     * default, which claude calls `Manual`. `/clear` has had this restore since it
     * was written (`Session.clearContext` captures `this.config` before it
     * overwrites it); this path did the same thing with the capture missing.
     *
     * ⚠ `agentConfigState` and **never** `snapshot().agentConfig`. That one is
     * composed through `withUltracode`, which rewrites the effort value to the
     * invented `ULTRACODE_CHOICE` — a value this daemon guarantees never reaches
     * an agent — and through `dedupeAliasChoices`, which rewrites the model value
     * off its `default` placeholder onto a concrete model. Replaying either would
     * send the agent something it never published: the first is refused, and the
     * second silently pins the model on a session whose operator chose to let the
     * agent decide.
     */
    const wanted = this.agentConfigState;

    /*
     * Held across all three steps, and the third is the one that needs it.
     *
     * `stop` and `resume` defend themselves — `stopRequested`, then `terminal`,
     * then a null `session` — but every one of those goes quiet the moment
     * `onStarted` assigns the new agent, while `restoreConfig` below is still
     * putting back a snapshot captured before any of this began. A `setMode` that
     * lands there succeeds, answers 200, and is then overwritten by the restore
     * with nothing recorded. See {@link restarting}.
     *
     * `finally` rather than a clear after the restore, because a `resume()` that
     * throws must not leave the session refusing every instruction for the rest of
     * its life — and because the caller carries on: `setConfigOption` falls through
     * to apply the level somebody actually chose, which is a direct call on
     * `Session` rather than a second trip through the guard, and has to happen
     * *after* the restore rather than be refused by it.
     */
    let finished!: () => void;
    this.restart = {
      config: wanted,
      // Assigned synchronously, before the first `await` below, so the window the
      // guards refuse in and the window `whenRestarted` waits out are the same one
      // — opened by this statement, closed by the `finally`.
      done: new Promise<void>((resolve) => {
        finished = resolve;
      }),
    };
    try {
      await this.stop("config_changed");
      await this.resume();

      /*
       * `this.session` rather than the launch's own value, because `onStarted` has
       * already declined and disposed a launch that lost its race — so reading the
       * field is how this asks "is the agent that came up still the live one".
       *
       * Awaited rather than fired, because `setConfigOption` returns
       * `this.snapshot().agentConfig` as soon as this resolves: a restore still in
       * flight would put the agent's defaults in that response body, which is the
       * revert this exists to stop, arriving in the answer.
       */
      await this.session?.restoreConfig(wanted).catch(() => {});
    } finally {
      /*
       * Cleared and *announced*, and the touch is the half that is not tidiness.
       *
       * The held answer is optimistic about exactly one thing — that the restore
       * puts it back — and the restore is allowed not to: `restoreConfig` skips a
       * mode or a choice the new conversation no longer offers, and swallows every
       * error. So this is the one moment the hold can be found wrong, and it was
       * the one transition that fanned nothing out: the last frame every attached
       * client had seen was a held one, and nothing was scheduled to correct it.
       * The caller gets the truth in the response body; this is that same answer
       * for everybody else, one frame after the controls become tappable again.
       */
      this.restart = null;
      this.touchSafe();
      // Resolved last, so a prompt that was waiting resumes against the corrected
      // state rather than racing the frame that corrects it. `resolve`, never
      // `reject`: see {@link whenRestarted}.
      finished();
    }
  }

  /**
   * Take a credential saved after this agent started, by starting it again.
   *
   * **Returns whether it did**, because the caller reports a count and a silent
   * "no" would make a screen say chats were brought back when none were.
   *
   * The refusals are the whole design:
   *
   *   - **Terminal**: nothing is running to replace, and the next `resume()`
   *     reads the credential anyway. Restarting here would launch an agent
   *     nobody asked for, on a conversation somebody deliberately ended.
   *   - **Mid-turn**: `stop()` would kill the turn. And a session that is
   *     *currently working* is one whose credential is demonstrably fine — the
   *     sessions that need the new one are exactly the idle and the failing.
   *     That is not a compromise; a turn in flight is evidence.
   *   - **Blocked**: a parked permission is somebody being waited on, and the
   *     restart would drop the question without answering it. This daemon's whole
   *     shape is that an approval cannot be lost.
   *   - **Already restarting or clearing**: one process boundary at a time.
   *
   * Everything refused here picks the credential up the next time it starts,
   * which for a turn in flight is whenever it next ends and is resumed.
   *
   * **A getter rather than a promise that answers `false`**, so a caller can count
   * what it is about to do *before* doing it. The first version of
   * `reloadCredentials` returned a number it decremented inside a `.then`, which
   * resolves after the return — so the count it reported was every session on the
   * agent, refusals included.
   */
  get takesCredentialChange(): boolean {
    if (this.terminal || this.stopRequested) return false;
    if (this.session === null || this.agentSessionId === null) return false;
    if (this.turn !== null) return false;
    if (this.awaitingCount > 0) return false;
    return !this.clearing && !this.restarting;
  }

  /** {@link takesCredentialChange}, then the restart. Re-checked, never assumed. */
  async applyCredentialChange(): Promise<void> {
    if (!this.takesCredentialChange) return;
    await this.restartAgent();
  }

  /** Switches permission/plan mode. Same refusal shapes as {@link setConfigOption}. */
  async setMode(modeId: string): Promise<AgentConfigResult> {
    const session = this.session;
    if (this.terminal || this.stopRequested) return { kind: "terminal", status: this.status };
    if (!session) return { kind: "not_ready", status: this.status };
    // Same guard as {@link setConfigOption}, and this is the one the race was
    // *about*: `restoreConfig` re-applies the mode last, so a mode chosen inside
    // the window is the change most likely to be quietly reverted.
    if (this.clearing || this.restarting) return { kind: "busy", status: this.status };

    // Either expression of the same fact is enough: claude fills in `modes`,
    // kimi publishes only the option. Refusing when one of them is absent would
    // make mode changes work on one agent and not the other for no reason.
    const option = this.agentConfigState.options.find((candidate) => candidate.category === "mode");
    const known =
      this.agentConfigState.modes?.available.some((mode) => mode.id === modeId) === true ||
      option?.choices.some((choice) => choice.value === modeId) === true;
    if (!known) return { kind: "unknown_mode", modes: this.agentConfigState.modes };

    // Not applied here either, and for the same reason — both of `setMode`'s
    // branches go through `Session.updateConfig`, which notifies before it
    // returns.
    await session.setMode(modeId);
    return { kind: "ok", config: this.snapshot().agentConfig };
  }

  private onStartFailed(launch: Promise<Session>, error: unknown): void {
    // The mirror of `onStarted`'s check, and it closes the same window from the
    // other side: a launch that was abandoned and then *rejected* after a retry
    // had already re-armed the session would write an `exitRecord` onto the new
    // life — `armForStart` has just cleared it, so the `if (this.exitRecord)`
    // guard below does not see it — leaving a session that is starting normally
    // reported as terminal, and never cleared, because `onStarted` does not
    // rewrite an exit it did not expect to find.
    if (this.startPromise !== launch) return;
    if (this.exitRecord) return;
    this.exitRecord = {
      reason: this.startAbandoned ? "start_timeout" : "start_failed",
      // Clipped, because on an ACP handshake failure this is the agent's own
      // error message and it rides both the snapshot and a flat-192 event.
      detail: clip(describeError(error), MAX_EXIT_DETAIL_CHARS),
      at: Date.now(),
      agentHandle: null,
      agentConfirmedDead: true,
    };
    /*
     * Written to the log only when somebody is watching for it.
     *
     * A failed resume used to leave three status events behind — `starting`,
     * then this `failed`, then `interrupted` as the catch put the original exit
     * back — describing a round trip that ended exactly where it began. Two of
     * those were noise and the middle one was a lie: the session is not
     * `failed`, that record exists for a few microseconds before being replaced.
     *
     * That was tolerable while a resume was a thing a person asked for. It is
     * not now that the daemon attempts one per session per boot: on this
     * machine, nine dead sessions had their transcripts filled with the
     * machinery of their own failed revival, in a log that evicts a *prefix* and
     * therefore pays for it with the operator's own first prompt.
     *
     * The state is still on the snapshot — `resume.state`, `attempts`, `error` —
     * and the *final* give-up still appends one `error` event. What is dropped is
     * only the churn.
     */
    if (!this.quietResume) {
      this.safeAppend({ type: "status", status: this.status, exit: this.exitRecord });
    }
    this.touchSafe();
  }

  private onAgentGone(session: Session): void {
    // Resume replaces `this.session` and clears both guards below, so without
    // this identity check a late notification from the *previous* agent's death
    // would stop the freshly resumed one.
    if (this.session !== session) return;
    // On a deliberate stop we close the connection ourselves, so this fires from
    // our own teardown; labelling that `agent_exited` would be a lie.
    if (this.stopRequested || this.terminal) return;
    void this.stop("agent_exited").catch(() => {});
  }

  stop(reason: ExitReason = "stopped"): Promise<void> {
    if (this.stopping) return this.stopping;
    // Set before the first await so `status` and the permission guards see it
    // immediately — a memoised promise alone would not be visible until later.
    this.stopRequested = true;
    this.stopping = this.doStop(reason);
    return this.stopping;
  }

  private async doStop(reason: ExitReason): Promise<void> {
    this.touchSafe();

    // A start still in flight owns a subprocess we have not been handed yet.
    // Short-circuiting here would mark the row terminal while that agent is still
    // on its way, and nothing would ever dispose it.
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // Already recorded by onStartFailed.
      }
    }

    // Before dispose, not after: a permission parked here keeps the turn alive,
    // which burns the whole cancel grace and pushes teardown onto the kill path.
    this.sweepPending("session_stopped");

    // The controls belong to the live agent, so they go with it. Assigned rather
    // than announced: appending an `agent_config` here would put "no controls"
    // in the transcript as if the agent had said so, when the terminal `status`
    // event a few lines below is what actually happened.
    this.unsubscribeConfig?.();
    this.unsubscribeConfig = null;
    this.agentConfigState = { modes: null, options: [] };

    // Same argument, and it matters more here: a dead agent's window occupancy is
    // not a fact about anything. Back to `null` — "cannot tell" — rather than to a
    // zero that would read as "plenty of room left" on the one screen that draws it.
    this.unsubscribeUsage?.();
    this.unsubscribeUsage = null;
    this.contextUsageState = null;

    // And the same for the commands, which belong to that agent too. The revision
    // is *bumped* rather than reset: it is a change marker and not a count, so
    // moving it is what tells an attached client to drop the list it is holding.
    // Zeroing it here would leave a client that had already fetched revision 1
    // comparing 1 to 1 and keeping a menu whose agent is gone.
    this.unsubscribeCommands?.();
    this.unsubscribeCommands = null;
    // Through the same gate `applyAgentCommands` uses, so "was there anything to
    // withdraw" is answered in one place. `commands.length > 0` was the test here
    // and it misses a list that is empty with a non-zero `dropped` — which is what
    // an agent publishing 300 unusable names produces.
    const withdrawn: AgentCommands = { commands: [], dropped: 0 };
    if (!sameCommands(this.agentCommandsState, withdrawn)) {
      this.agentCommandsState = withdrawn;
      this.commandsRevisionValue += 1;
    }

    const session = this.session;
    const handle = session?.handle ?? null;
    let confirmedDead = true;
    let detail: string | null = null;

    if (session) {
      try {
        await session.dispose();
      } catch (error) {
        detail = describeError(error);
      }
      // `!== "dead"` rather than `=== "alive"`: an agent we could not ask about
      // is one we must still try to kill, and must not then claim we watched
      // die. When the probe itself is unavailable this ends at
      // `confirmedDead: false`, which is what the next boot's reaper needs to
      // see — and which is now recorded *beside* the reason rather than instead
      // of it. See the exit record below.
      if (handle !== null && (await this.runtime.alive(handle)) !== "dead") {
        await this.runtime.kill(handle, "SIGKILL");
        await delay(KILL_CONFIRM_MS);
        confirmedDead = (await this.runtime.alive(handle)) === "dead";
      }
    }

    /*
     * Never overwrite an exit that already exists. Without this, stopping a
     * restored session rewrites `daemon_restarted` as `stopped` and flips its
     * status from `interrupted` to `exited` — erasing the fact that a restart
     * happened. It also closes a pre-existing case: a stop() after
     * onStartFailed used to overwrite `start_failed`, flipping failed → exited.
     * onStartFailed already guards itself this way; this side did not.
     *
     * **The caller's reason is kept even when the kill was not confirmed**, and
     * that is a fix rather than a simplification. This line used to read
     * `confirmedDead ? reason : "agent_kill_failed"`, which threw the reason
     * away for a fact `agentConfirmedDead` was already carrying one field
     * below — so a SIGKILL that took longer than `KILL_CONFIRM_MS` collapsed
     * `daemon_shutdown` and `stopped` into one indistinguishable value. Those
     * two are precisely what `endedWithDaemon` has to tell apart, so an ordinary
     * deploy on a loaded machine could silently produce a session the daemon
     * would refuse to bring back. Nothing ever read `agent_kill_failed`.
     */
    this.exitRecord ??= {
      reason,
      detail,
      at: Date.now(),
      agentHandle: handle,
      agentConfirmedDead: confirmedDead,
    };
    this.safeAppend({ type: "status", status: this.status, exit: this.exitRecord });
    this.touchSafe();
  }

  /**
   * Records that the daemon died underneath this session.
   *
   * The exit is set *before* the event announcing it, so `status` already reads
   * `interrupted` by the time any listener sees the frame — a client folding the
   * log and a client reading the snapshot must not disagree, even for one frame.
   */
  markInterrupted(agentConfirmedDead: boolean, detail: string | null): void {
    if (this.exitRecord) return;
    this.exitRecord = {
      reason: "daemon_restarted",
      detail,
      at: Date.now(),
      agentHandle: this.restoredAgentHandle,
      agentConfirmedDead,
    };
    this.safeAppend({ type: "status", status: this.status, exit: this.exitRecord });
    this.touchSafe();
  }

  /* --------------------------------------------------------------------- *
   * Turns
   * --------------------------------------------------------------------- */

  /**
   * Accept a prompt, with any files staged for it.
   *
   * **Stays synchronous, and the second parameter is client input rather than
   * protocol payload.** Both halves matter. Synchronous because this answers a
   * 202 carrying `{turn, seq}` and calls `safeAppend`, so there is nowhere to put
   * an await; the one read of an attachment's bytes happens in `pump`, which is
   * already async. And `UploadRow[]` rather than `ContentBlock[]` because
   * `deriveSessionTitle` and the `prompt` event both need the **text** — handed a
   * built block array this would have to find the text blocks and re-join a
   * string it was just given — and because whether an agent takes an `image`
   * block is `AcpClient`'s to know, not the HTTP layer's.
   */
  prompt(text: string, attachments: readonly UploadRow[] = []): PromptResult {
    if (this.terminal) return { kind: "terminal", status: this.status, exit: this.exitRecord };
    if (this.stopRequested) return { kind: "terminal", status: this.status, exit: null };
    const session = this.session;
    if (!session) return { kind: "not_ready", status: this.status };
    // `clearing` beside `turn`, because during a `/clear` this session has no turn
    // and is still not something to send a prompt to: the id `Session.prompt`
    // would read is the one `clearContext` is in the middle of closing. See the
    // field.
    if (this.turn !== null || this.clearing || this.restarting) return { kind: "busy", status: this.status };

    // Guard on our own counter, assigned before any await. Session.prompt is a
    // generator, so its own "already in flight" throw would not surface until the
    // first next() — far too late to answer the request with a 409.
    this.turnCounter += 1;
    const turn = this.turnCounter;
    this.turn = turn;
    this.turnStartedAt = Date.now();
    // Somebody is asking again, so the agent is allowed one more replacement if
    // this message meets the same wall. See `onAgentUnusable` and the flag's own
    // docblock.
    this.authRestartArmed = true;

    // The first prompt names the session, once.
    //
    // Below the guards above, so a prompt this daemon *refused* never names
    // anything — a session called "hi" that never ran would be worse than one
    // called by its path. The `=== null` test is the whole of the "written once"
    // rule: a manual rename leaves the field non-null and therefore wins for ever,
    // and clearing a title back to null is what re-arms this. `touchSafe()` below
    // persists it and fans it out in the same frame as the turn start, so no
    // client sees a turn begin on a session that is still nameless.
    //
    // Still the text alone, with attachments deliberately not consulted — and the
    // second half of that reasoning has changed, so it is worth restating rather
    // than leaving a comment that argues from something no longer true. It used
    // to say a files-only prompt was refused upstream, so no nameless case
    // existed; one does now. The answer is the same for the *first* reason alone:
    // a session called `IMG_4821.png` is worse than one called by its path, and
    // leaving the title null is exactly what makes a client fall back to the path.
    if (this.titleValue === null) this.titleValue = deriveSessionTitle(text);

    // Built here rather than in `pump`, from the three facts that need no I/O, so
    // it is the *same* decision `blocksFor` will make rather than a guess at it.
    const caps = { image: session.acceptsImages };
    const refs =
      attachments.length === 0
        ? null
        : attachments.map((row) => ({
            uploadId: row.uploadId,
            name: row.name,
            mime: row.mime,
            bytes: row.bytes,
            inlined: inlinesImage(row.mime, row.bytes, caps),
          }));

    const seq = this.safeAppend({ type: "prompt", text, attachments: refs })?.seq ?? 0;

    /*
     * After the append, and **not** conditional on it having worked.
     *
     * This comment used to say the ordering meant "a prompt that could not be
     * recorded does not mark files as spent", which the code does not do:
     * `safeAppend` answers `null` on a failed insert, that becomes `seq` 0, and
     * the mark runs anyway. Corrected rather than made true, because marking is
     * the right thing either way — the turn really is starting, the agent really
     * is about to be handed these files, and leaving them unconsumed would put
     * them back under the 24-hour sweep while a live turn references them. What
     * the ordering actually buys is that the recorded event and the mark cannot
     * interleave.
     *
     * Synchronous SQLite, off the agent's emit path.
     */
    if (attachments.length > 0) {
      this.uploads?.markConsumed(
        this.id,
        attachments.map((row) => row.uploadId),
      );
    }

    void this.pump(session, text, attachments, turn).catch(() => {
      // pump() already recorded whatever went wrong.
    });
    this.touchSafe();
    return { kind: "accepted", turn, seq };
  }

  /**
   * Stop the turn in flight, and leave the session alive.
   *
   * The distinction from {@link stop} is the whole feature. Stopping kills the
   * agent, writes an `exitRecord` and makes the session terminal; this sends one
   * notification and changes nothing else — the process stays up, the
   * conversation stays loaded, and the next prompt is an ordinary prompt rather
   * than a resume. What it costs is the turn, which is the thing being asked for.
   *
   * **The order is send, then sweep, and it is ACP's rather than a preference.**
   * A client that has cancelled MUST answer any pending
   * `session/request_permission` with `cancelled`, and until it does an agent
   * parked on one is not executing anything that could notice the cancel: the
   * notification sits in its pipe behind a reverse-RPC it is still waiting on. So
   * a cancel that only sent would hang exactly the session most worth
   * cancelling — one blocked on a human — and a cancel that only swept would tell
   * the agent its tool call was abandoned while leaving it free to pick another.
   *
   * **The sweep is in a `finally`.** The send is bounded and can throw on a pipe
   * nobody is reading, and dropping the sweep there would leave the agent holding
   * a promise this daemon will never settle, with `status` stuck on `blocked`
   * against a turn nobody can end. `settle` is a no-op on an id that is already
   * gone, so sweeping a second time when `pump` reaches its own `finally` costs
   * nothing.
   *
   * Not memoised, unlike `stopping` and `resume()`: asking twice is a person
   * tapping again because the first one did not visibly work, and the honest
   * response to that is to ask the agent again rather than to hand back the first
   * attempt's answer.
   */
  async cancelTurn(): Promise<CancelResult> {
    if (this.terminal) return { kind: "terminal", status: this.status, exit: this.exitRecord };
    if (this.stopRequested) return { kind: "terminal", status: this.status, exit: null };
    const session = this.session;
    if (!session) return { kind: "not_ready", status: this.status };
    // Before the `turn` test, not after it: a clear holds no turn, so the other
    // order would answer `no_turn` — "nothing is running, you have what you
    // asked for" — about a session in the middle of an ACP round trip.
    if (this.clearing || this.restarting) return { kind: "busy", status: this.status };
    const turn = this.turn;
    if (turn === null) return { kind: "no_turn", status: this.status };

    // Recorded before the await, so a snapshot built while the notification is
    // still in the pipe already says somebody asked. Anything else leaves a
    // window in which the button springs back and invites a second tap.
    this.cancelRequestedAt = Date.now();
    this.touchSafe();

    try {
      await session.cancelTurn();
    } catch {
      // The pipe is gone or the agent has stopped reading it. Swallowed rather
      // than reported, because there is nothing a caller would do differently and
      // the sweep below is the half that still matters: an agent nobody can reach
      // is one whose turn is about to end through `pump`'s error path anyway.
    } finally {
      // Fenced on the turn this call was about, exactly as `pump`'s own `finally`
      // is. `cancelTurn` can be in flight for as long as the notify takes, and a
      // turn that ends inside that window frees the session to accept a *new*
      // prompt — whose parked permission this sweep would then cancel, from a
      // request that was never about it.
      if (this.turn === turn) this.sweepPending("turn_cancelled");
      this.touchSafe();
    }

    // After the sweep, never before it: an agent blocked on a permission cannot
    // reach its own turn end until the answer above lands, so waiting first would
    // spend the whole budget and report `false` about a cancel that was working.
    const settled = await session.awaitTurnEnd();
    return { kind: "cancelled", turn, settled };
  }

  private async pump(
    session: Session,
    text: string,
    attachments: readonly UploadRow[],
    turn: number,
  ): Promise<void> {
    let failed = false;
    try {
      // The one place an attachment's bytes are read, and the only await this
      // feature adds to a turn. Here rather than in `prompt` because this method
      // is already async — the emit path above it is not and must stay that way.
      const extra =
        attachments.length === 0 || !this.uploads
          ? []
          : await this.uploads.blocksFor(attachments, { image: session.acceptsImages });
      /*
       * A cancel can land in the gap the line above opens.
       *
       * `prompt()` sets `this.turn` synchronously and fires this method, so from
       * the outside the turn already exists — but `Session.turnActive` is not set
       * until the generator below is first pulled, and reading an inlined image's
       * bytes is a real `readFile` between the two. A cancel arriving there is
       * sent to an agent holding no prompt, which every adapter discards, and
       * this loop would then hand it the message anyway: the turn somebody
       * stopped runs to completion, having been told it was cancelled.
       *
       * Narrow — it needs an image attachment, and the window is milliseconds —
       * but the cost of closing it is one test, and the marker is already the
       * right thing to ask. Fenced on the turn, like everything else that reads
       * it. `finally` clears both fields and sweeps; the `turn_end` is written
       * here because the agent never gets to send one and a prompt with no turn
       * end at all is the shape this daemon calls a message that reached no
       * model.
       */
      if (this.turn === turn && this.cancelRequestedAt !== null) {
        this.record({ type: "turn_end", stopReason: "cancelled", usage: null });
        return;
      }
      let errored = false;
      for await (const event of session.prompt(text, extra)) {
        /*
         * Read before the record, so a store that throws cannot also lose the fact
         * that this turn is ending in a failure — and **not every error is one.**
         * The turn generator yields `CLOSED` when the queue closes under it, which
         * is this daemon disposing the agent rather than the agent failing; writing
         * `agent_error` there would blame the agent for a teardown we performed.
         */
        errored = event.type === "error" && !isSessionClosed(event);
        // A recording fault must not unwind this loop. Doing so would call
        // gen.return(), aborting the agent's turn — and force-cancelling a
        // permission a human may be walking to their phone to approve, then
        // telling them the turn simply ended.
        try {
          this.record(event);
        } catch {
          // Already degraded inside the store; nothing useful to do here.
        }
      }
      /*
       * ⚠ **A turn that ended in an error still ended, and for four releases it
       * did not say so.**
       *
       * `Session.prompt` converts a rejected `session/prompt` into an `error`
       * event and returns on it, exactly as it returns on a `turn_end` — so the
       * turn was over and nothing on the wire marked the boundary. Four prompts,
       * three `turn_end`s, in a log anybody could read.
       *
       * The argument is Q2.103's, already made for the cancel path a hundred lines
       * up: the daemon writes the end itself because the agent never gets to, and
       * a prompt with no turn end at all is the shape this codebase calls a message
       * that reached no model. What it actually cost: `Tail.taskFloor` keys on this
       * event, so a turn that failed mid-delegation left its pending calls counted
       * for ever under a permanent "waiting for 1 task"; the `turn.ended` plugin
       * hook never fanned; and the turn's origin claim was never spent, so the
       * plugin that started it had the *next* turn's hook suppressed instead.
       *
       * Not recorded while stopping, and for `record`'s own reason: the generator's
       * synthetic "session closed" error is dropped there as a deliberate shutdown
       * rather than a failure, and an end for an error nobody was told about would
       * be the same misreport arriving one event later.
       */
      if (errored && !this.stopRequested) {
        this.record({ type: "turn_end", stopReason: "agent_error", usage: null });
      }
    } catch (error) {
      failed = true;
      try {
        this.record({
          type: "error",
          message: describeError(error),
          data: null,
        });
      } catch {
        // Nothing left to report with.
      }
    } finally {
      if (this.turn === turn) {
        this.turn = null;
        this.turnStartedAt = null;
        // Cleared with `turn` and inside the same identity test, which is what
        // keeps the pair from disagreeing: a late pump belonging to an older turn
        // must not erase a cancel somebody has just asked for on the current one.
        this.cancelRequestedAt = null;
        /*
         * And the queue goes back to being read, which is the whole of the fix for
         * "the conversation stopped and then dumped five minutes of dialog".
         *
         * Inside the identity test with the fields above: a late pump belonging to
         * an older turn must not start a reader underneath the turn that replaced
         * it. It is safe even so — `drainBetweenTurns` refuses a queue a turn holds
         * — but relying on that would make this line correct by accident.
         *
         * `this.session` rather than the `session` argument, so a pump whose agent
         * has been replaced does not attach a reader to the old one.
         */
        const live = this.session;
        if (live !== null) this.startIdleDrain(live);
      }
      this.sweepPending(failed ? "pump_failed" : "turn_ended");
      /*
       * **A prompt the agent never engaged with means the agent is finished, so
       * it is replaced.**
       *
       * ⚠ Reported with a screenshot: four messages, four identical
       * `Internal error: The Claude Agent session has ended. Please start a new
       * session.` The agent's ACP session had died under a live process — the
       * daemon saw no exit, `status` stayed `idle`, and every message was
       * accepted and failed the same way. There was no way out from inside the
       * app.
       *
       * **`failed` is the precise signal and the message is not.** Reaching this
       * `catch` means `session.prompt()` *rejected* rather than streamed a
       * failure: the agent did not take the message at all. Anything that goes
       * wrong **inside** a turn — a tool blowing up, a command exiting non-zero —
       * arrives through `this.record(event)` and never comes near here, so this
       * cannot fire on an ordinary bad turn. Measured on the real events:
       * `{code: -32603}` with **no `errorKind`**, which is why `isAuthFailure`
       * quite correctly ignored it and why matching the text was never an option
       * — `describeError` is the agent's own prose and moves with its version.
       *
       * Same machinery as an auth failure, for the same reason: what is stale is
       * the process, not the conversation. Armed once per prompt, so a fresh
       * agent that fails the same way leaves the error standing and waits for
       * somebody to send another message rather than looping.
       */
      if (failed) this.onAgentUnusable();
      this.touchSafe();
    }
  }

  private record(event: SessionEvent): void {
    this.lastEventAt = Date.now();
    // While stopping, the generator's synthetic "session closed" error is
    // indistinguishable from a real one. Drop errors rather than report a
    // deliberate shutdown as a failure; the terminal status event says what
    // actually happened.
    if (this.stopRequested && event.type === "error") return;
    this.log.append(event);
    if (isAuthFailure(event)) this.onAgentUnusable();
  }

  /**
   * This agent cannot serve the conversation, so it is given a fresh process.
   *
   * **Two callers and one remedy.** The agent reporting
   * `errorKind: "authentication_failed"` on the event pump, and a prompt the
   * agent **rejected outright** — `session.prompt()` throwing rather than
   * streaming a failure, which is the pump's `failed` flag and means the message
   * was never taken. The second was found the hard way: an ACP session that died
   * under a live process left `status: idle` and answered four messages in a row
   * with the same `-32603`, no `errorKind` on any of them, and no way out of the
   * conversation from inside the app.
   *
   * **Ground truth, and the reason there is no probe on the prompt path.** An
   * earlier version asked the agent's CLI "are you signed in" before every
   * message, which cost a process spawn on the hot path, could only ever be as
   * fresh as its 3s cache — and made the offline drivers depend on whether the
   * person running them happened to be signed in, because a stub runtime inherits
   * the real probe. This is the agent itself reporting, at the only moment that
   * cannot be stale.
   *
   * ⚠ **The auth arm used to end the conversation, and that was wrong about what
   * it had measured.** It called `stop("agent_signed_out")`, on the reasoning that "the
   * credential is gone, so every later message would fail the same way". Q7.99
   * had already found otherwise and the code never caught up: a session idle
   * 5h36m reported `authentication_failed` on its *first* prompt while the token
   * on disk was **still valid for another 1.4 hours**, and a freshly spawned
   * agent worked four minutes later. What had gone stale was the agent process,
   * not the credential — so ending the conversation destroyed the thing that was
   * fine and kept nothing that was broken.
   *
   * What it cost is worth writing down, because it is what this is fixing.
   * `autoResumable` answers `false` for `agent_signed_out` on **both** triggers
   * and the only thing that reverses it is `reloadCredentials`, whose callers are
   * all in-app credential writes — so somebody whose CLI refreshed its own token,
   * or who signed in from their own terminal, had a conversation that could never
   * come back, under a notice claiming they were signed out and a Sign in button
   * leading to a screen where they already were. The composer was gone, so there
   * was nothing to try from inside the app at all.
   *
   * **So the conversation stays, and the agent is replaced under it.** The error
   * is already in the log — `record` appended it one statement above — so what
   * happened is on screen, in the transcript, where somebody can read it and send
   * again. `restartAgent` is the same path a config change takes and stops with
   * `config_changed` deliberately rather than inventing a reason: it *is* "the
   * daemon took the agent away and is bringing it straight back", it is in
   * `DAEMON_EXIT_REASONS` so a client draws "reconnecting", and a new `ExitReason`
   * member would read as `showsAsEnded` on every client older than it — which is
   * the very failure this removes.
   *
   * **Armed once per prompt**, which is what makes this a retry rather than a
   * loop. If the credential really is gone the fresh agent fails the same way,
   * the second failure lands in the transcript beside the first, and nothing
   * restarts again until somebody sends another message. The retry is driven by
   * the person, and the cost of a genuinely revoked credential is one spawn per
   * message they choose to send.
   *
   * Fire-and-forget because `record` is on the event pump and must not await a
   * process teardown.
   */
  private onAgentUnusable(): void {
    if (this.terminal || this.stopRequested) return;
    /*
     * A restart already in flight is left alone, and this is not defensive.
     * `restartAgent` writes `this.restart` — a single field holding the config to
     * put back and the promise `whenRestarted` waits on — so a second one
     * overwrites the first's receipt: the config captured before a config change
     * is lost, and everything waiting on the old promise waits for ever. The
     * agent coming up is a fresh process either way, which is the whole of what
     * this wanted.
     */
    if (this.restarting) return;
    if (!this.authRestartArmed) return;
    this.authRestartArmed = false;
    void this.restartAgent().catch(() => undefined);
  }

  /* --------------------------------------------------------------------- *
   * Permissions
   * --------------------------------------------------------------------- */

  /**
   * Parks the agent's approval request and hands it to whoever shows up.
   *
   * The promise returned here is the agent's turn, held open. Nothing about it
   * belongs to a connection, which is the whole of "survives the client that was
   * going to answer it disappearing".
   */
  private readonly resolvePermission = (
    request: PendingPermission,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> => {
    // Refuse to park when nobody could ever answer. Each of these was a way to
    // hang: a request against a dead session is held by a map that is about to be
    // dropped, and one arriving outside a turn has no sweeper to clear it.
    const refusal = this.refusalReason();
    if (refusal) return Promise.resolve(this.recordRefusal(request, refusal));

    const permissionId = this.mintPermissionId();
    const info: PendingPermissionSnapshot = {
      permissionId,
      toolCallId: request.toolCallId,
      title: request.title,
      options: request.options,
      raisedAt: Date.now(),
      // Bounded here, at the boundary that owns retention — `session.ts` passes
      // through what the agent sent and does not decide how much of it is kept.
      rawInput: clampBlob(request.rawInput, MAX_PERMISSION_BLOB_BYTES),
      content: clampBlob(request.content, MAX_PERMISSION_BLOB_BYTES),
    };

    // Exactly one statement in the executor. A throw inside it rejects the
    // promise — which would answer the agent with an error while leaving the
    // entry in `pending`, so the session would advertise `blocked` forever on a
    // request that was already refused, and approving it would do nothing.
    let resolve!: (response: acp.RequestPermissionResponse) => void;
    const parked = new Promise<acp.RequestPermissionResponse>((capture) => {
      resolve = capture;
    });

    this.pending.set(permissionId, { info, resolve });
    this.safeAppend({
      type: "permission_request",
      permissionId,
      toolCallId: request.toolCallId,
      title: request.title,
      options: request.options,
      decision: null,
    });

    if (signal.aborted) {
      this.settle(permissionId, CANCELLED, "agent_withdrew");
    } else {
      signal.addEventListener(
        "abort",
        () => this.settle(permissionId, CANCELLED, "agent_withdrew"),
        { once: true },
      );
    }

    this.touchSafe();
    return parked;
  };

  private refusalReason(): AnswerResolvedBy | null {
    if (this.terminal || this.stopRequested) return "session_stopped";
    if (this.turn === null) return "no_turn";
    return null;
  }

  private recordRefusal(
    request: PendingPermission,
    by: AnswerResolvedBy,
  ): acp.RequestPermissionResponse {
    // Recorded rather than hidden: a refused request that leaves no trace looks
    // exactly like one that was never raised.
    const permissionId = this.mintPermissionId();
    this.safeAppend({
      type: "permission_request",
      permissionId,
      toolCallId: request.toolCallId,
      title: request.title,
      options: request.options,
      decision: null,
    });
    this.resolved.set(permissionId, { outcome: "cancelled", optionId: null, at: Date.now(), by });
    this.safeAppend({
      type: "permission_resolved",
      permissionId,
      toolCallId: request.toolCallId,
      title: request.title,
      outcome: "cancelled",
      optionId: null,
      by,
    });
    return CANCELLED;
  }

  answerPermission(permissionId: string, answer: PermissionAnswer): PermissionResult {
    const record = this.pending.get(permissionId);
    if (!record) {
      const prior = this.resolved.get(permissionId);
      if (prior) return { kind: "already_answered", permissionId, ...prior };
      // "Too old to report" must never come back as "never existed".
      return this.looksLikeOurs("perm", permissionId)
        ? { kind: "expired", permissionId }
        : { kind: "not_found" };
    }

    const pick = chooseOption(answer, record.info.options);
    if (pick.kind !== "ok") return { kind: pick.kind, options: [...record.info.options] };

    const settled = this.settle(permissionId, pick.response, "client");
    if (!settled) return { kind: "not_found" };
    return {
      kind: "ok",
      permissionId,
      outcome: settled.outcome,
      optionId: settled.optionId,
      seq: settled.seq,
      // We cannot prove the agent received it — the SDK swallows send failures
      // once its connection is gone. Only a later event in the log proves effect.
      delivered: this.session !== null && !this.terminal ? "sent" : "agent_gone",
    };
  }

  /**
   * The only place a permission leaves `pending`.
   *
   * Statement order is load-bearing. `pending.delete` is the compare-and-swap:
   * two simultaneous answers run in separate macrotasks with no await between the
   * get and the delete, so exactly one wins. And the agent is unblocked *before*
   * anything is logged, because a throw while appending would otherwise leave the
   * request recorded as answered, removed from `pending`, and the agent's RPC
   * never responded to — a permanent hang that also switches off every signal
   * that would have made it visible.
   */
  private settle(
    permissionId: string,
    response: acp.RequestPermissionResponse,
    by: AnswerResolvedBy,
  ): { outcome: "selected" | "cancelled"; optionId: string | null; seq: number | null } | null {
    const record = this.pending.get(permissionId);
    if (!record) return null;
    this.pending.delete(permissionId);

    const outcome = response.outcome.outcome === "selected" ? "selected" : "cancelled";
    const optionId = response.outcome.outcome === "selected" ? response.outcome.optionId : null;
    this.resolved.set(permissionId, { outcome, optionId, at: Date.now(), by });

    try {
      record.resolve(response);
    } catch {
      // A promise only settles once; a duplicate is not an error worth surfacing.
    }

    let seq: number | null = null;
    try {
      seq = this.log.append({
        type: "permission_resolved",
        permissionId,
        toolCallId: record.info.toolCallId,
        title: record.info.title,
        outcome,
        optionId,
        by,
      }).seq;
    } catch {
      // The decision already reached the agent; losing the record is survivable.
    }
    this.touchSafe();
    return { outcome, optionId, seq };
  }

  /**
   * Both maps, in one method rather than two calls at each of the two sites.
   *
   * `pump`'s `finally` and `doStop` are the callers, and a sweep that reached one
   * map from one of them would leave an agent parked on a question after the turn
   * that raised it had ended — with the session reading `idle` while its own
   * promise was still held.
   */
  private sweepPending(by: AnswerResolvedBy): void {
    for (const permissionId of [...this.pending.keys()]) {
      this.settle(permissionId, CANCELLED, by);
    }
    for (const elicitationId of [...this.pendingElicitations.keys()]) {
      this.settleElicitation(elicitationId, ELICITATION_CANCELLED, by);
    }
  }

  /* --------------------------------------------------------------------- *
   * Questions
   * --------------------------------------------------------------------- */

  /**
   * Parks the agent's question and hands it to whoever shows up.
   *
   * The twin of {@link resolvePermission}, deliberately beside it and
   * deliberately not merged with it. `PendingRecord.resolve` takes a
   * `RequestPermissionResponse` and this takes a `CreateElicitationResponse`, so
   * one map would mean a union — and then `answerPermission` could reach a
   * question and `chooseOption` could be handed a form, which are the two
   * failures keeping them apart makes unsayable.
   *
   * `refusalReason()` is reused verbatim: a question against a dead session is
   * held by a map about to be dropped, and one raised outside a turn has no
   * sweeper. Both arms are right here for the reasons they were right there.
   */
  private readonly resolveElicitation = (
    request: PendingElicitation,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse> => {
    const refusal = this.refusalReason();
    if (refusal) return Promise.resolve(this.recordElicitationRefusal(request, refusal));

    const elicitationId = this.mintElicitationId();
    const info: PendingElicitationSnapshot = {
      elicitationId,
      toolCallId: request.toolCallId,
      message: request.message,
      // The form is *not* here. It is agent-shaped and this record rides
      // `SessionSnapshot`, which `GET /sessions` returns for sixty sessions every
      // four seconds — and unlike a permission, a question cannot be answered
      // from the list anyway, so the snapshot only has to say one is waiting.
      // `GET /sessions/:id/elicitations/:id` serves the fields, the same shape a
      // command list already has.
      fieldCount: request.form.fields.length,
      raisedAt: Date.now(),
    };

    // Exactly one statement in the executor, for the reason `resolvePermission`
    // gives: a throw here rejects the promise, answering the agent with an error
    // while leaving the entry in the map, so the session advertises `blocked` for
    // ever on something already refused.
    let resolve!: (response: acp.CreateElicitationResponse) => void;
    const parked = new Promise<acp.CreateElicitationResponse>((capture) => {
      resolve = capture;
    });

    this.pendingElicitations.set(elicitationId, { info, form: request.form, resolve });
    this.safeAppend({
      type: "elicitation_request",
      elicitationId,
      toolCallId: request.toolCallId,
      message: request.message,
    });

    if (signal.aborted) {
      this.settleElicitation(elicitationId, ELICITATION_CANCELLED, "agent_withdrew");
    } else {
      signal.addEventListener(
        "abort",
        () => this.settleElicitation(elicitationId, ELICITATION_CANCELLED, "agent_withdrew"),
        { once: true },
      );
    }

    this.touchSafe();
    return parked;
  };

  private recordElicitationRefusal(
    request: PendingElicitation,
    by: AnswerResolvedBy,
  ): acp.CreateElicitationResponse {
    // Recorded rather than hidden, for the reason `recordRefusal` is: a refused
    // request that leaves no trace looks exactly like one that was never raised.
    const elicitationId = this.mintElicitationId();
    this.safeAppend({
      type: "elicitation_request",
      elicitationId,
      toolCallId: request.toolCallId,
      message: request.message,
    });
    this.resolvedElicitations.set(elicitationId, { action: "cancel", at: Date.now(), by });
    this.safeAppend({
      type: "elicitation_resolved",
      elicitationId,
      toolCallId: request.toolCallId,
      message: request.message,
      action: "cancel",
      answers: null,
      by,
    });
    return ELICITATION_CANCELLED;
  }

  /** The form a client is being asked to fill in, or `null` once it is settled. */
  elicitationForm(elicitationId: string): ElicitationForm | null {
    return this.pendingElicitations.get(elicitationId)?.form ?? null;
  }

  answerElicitation(elicitationId: string, answer: ElicitationAnswerBody): ElicitationResult {
    const record = this.pendingElicitations.get(elicitationId);
    if (!record) {
      const prior = this.resolvedElicitations.get(elicitationId);
      if (prior) return { kind: "already_answered", elicitationId, ...prior };
      // "Too old to report" must never come back as "never existed" — the same
      // rule the permission route follows, through the same `looksLikeOurs`.
      return this.looksLikeOurs("elic", elicitationId)
        ? { kind: "expired", elicitationId }
        : { kind: "not_found" };
    }

    let response: acp.CreateElicitationResponse;
    let answers: ElicitationAnswer[] | null = null;
    if ("content" in answer) {
      const problems = validateElicitationContent(record.form, answer.content);
      if (problems.length > 0) {
        return { kind: "invalid_content", problems, fields: [...record.form.fields] };
      }
      response = { action: "accept", content: answer.content };
      answers = renderAnswers(record.form, answer.content);
    } else if ("decline" in answer) {
      response = { action: "decline" };
    } else {
      response = ELICITATION_CANCELLED;
    }

    const settled = this.settleElicitation(elicitationId, response, "client", answers);
    if (!settled) return { kind: "not_found" };
    return {
      kind: "ok",
      elicitationId,
      action: settled.action,
      seq: settled.seq,
      // "Recorded", not "the agent continued" — the same honesty the permission
      // route carries, for the same reason.
      delivered: this.session !== null && !this.terminal ? "sent" : "agent_gone",
    };
  }

  /**
   * The only place a question leaves `pendingElicitations`.
   *
   * Statement order is {@link settle}'s, word for word, and load-bearing for the
   * same two reasons: the delete is the compare-and-swap that makes two
   * simultaneous answers resolve to exactly one winner, and the agent is
   * unblocked *before* anything is logged so that a throw while appending cannot
   * leave a question recorded as answered whose RPC is never responded to.
   *
   * The one thing that differs is the cost of getting it wrong. A hung permission
   * is invisible. `canUseTool` runs `ensureToolCallEmitted` *before* it asks, so a
   * hung question leaves an open tool call with a question under it that will
   * never be answered — on screen, in a transcript somebody is reading.
   */
  private settleElicitation(
    elicitationId: string,
    response: acp.CreateElicitationResponse,
    by: AnswerResolvedBy,
    answers: ElicitationAnswer[] | null = null,
  ): { action: "accept" | "decline" | "cancel"; seq: number | null } | null {
    const record = this.pendingElicitations.get(elicitationId);
    if (!record) return null;
    this.pendingElicitations.delete(elicitationId);

    const action =
      response.action === "accept" ? "accept" : response.action === "decline" ? "decline" : "cancel";
    this.resolvedElicitations.set(elicitationId, { action, at: Date.now(), by });

    try {
      record.resolve(response);
    } catch {
      // A promise only settles once; a duplicate is not an error worth surfacing.
    }

    let seq: number | null = null;
    try {
      seq = this.log.append({
        type: "elicitation_resolved",
        elicitationId,
        toolCallId: record.info.toolCallId,
        message: record.info.message,
        action,
        // Clipped for the log alone. What reached the agent above is verbatim,
        // because a shortened answer is a wrong answer; this copy is a rendering
        // and `clip` leaves its own marker saying so.
        answers:
          action === "accept" && answers !== null
            ? answers.map((entry) => ({
                ...entry,
                value: clip(entry.value, MAX_ELICITATION_ANSWER_CHARS),
              }))
            : null,
        by,
      }).seq;
    } catch {
      // The answer already reached the agent; losing the record is survivable.
    }
    this.touchSafe();
    return { action, seq };
  }

  private mintPermissionId(): string {
    this.askSeq += 1;
    return `perm-${this.askSeq}-${this.askSalt}`;
  }

  private mintElicitationId(): string {
    this.askSeq += 1;
    return `elic-${this.askSeq}-${this.askSalt}`;
  }

  /**
   * Whether an id we no longer hold is one this session's *this life* minted.
   *
   * Takes the prefix rather than owning one, because two kinds of parked question
   * are minted from one counter and "too old to report" must never come back as
   * "never existed" for either of them. One rule, two callers — a second copy
   * with `elic-` substituted is how the two would come to disagree about the
   * salt's shape or about whether the bound is inclusive.
   */
  private looksLikeOurs(prefix: "perm" | "elic", id: string): boolean {
    const match = new RegExp(`^${prefix}-(\\d+)-([0-9a-f]{3})$`).exec(id);
    if (!match) return false;
    return match[2] === this.askSalt && Number(match[1]) <= this.askSeq;
  }

  /* --------------------------------------------------------------------- *
   * Fan-out helpers. Nothing in here may throw into a caller.
   * --------------------------------------------------------------------- */

  private safeAppend(event: SessionEvent): StoredEvent | null {
    try {
      this.lastEventAt = Date.now();
      return this.log.append(event);
    } catch {
      return null;
    }
  }

  private touchSafe(): void {
    let snapshot: SessionSnapshot;
    try {
      snapshot = this.snapshot();
    } catch {
      return;
    }

    // Persisted before the fan-out, so a snapshot a client is holding is already
    // on disk. In its own guard for the same reason the watcher loop has one: a
    // store fault must not cost the watchers their frame, and a watcher throwing
    // must not cost the row its write.
    //
    // This is the hook rather than a registered watcher because `watch()` evicts
    // a watcher that throws — one transient DB error would permanently and
    // silently unregister persistence for this session. It is also the only place
    // that can see turnCounter, askSeq and askSalt, none of which are on the
    // snapshot.
    try {
      this.sessionStore?.put(this.persistedRow(snapshot));
    } catch {
      // The store already swallowed it; this is the second belt.
    }

    for (const watcher of [...this.watchers]) {
      try {
        watcher(snapshot);
      } catch {
        this.watchers.delete(watcher);
      }
    }
  }

  private persistedRow(snapshot: SessionSnapshot): PersistedSession {
    return {
      id: this.id,
      agent: this.agent,
      customAgent: this.customAgent,
      createdAt: this.createdAt,
      workspace: this.workspace,
      agentSessionId: snapshot.agentSessionId,
      agentHandle: snapshot.agentHandle,
      status: snapshot.status,
      exit: snapshot.exit,
      turnCounter: this.turnCounter,
      lastEventAt: this.lastEventAt,
      askSeq: this.askSeq,
      askSalt: this.askSalt,
      // Only the verdict that outlives us. Writing `attempts_exhausted` here
      // would quietly turn the transient case into the permanent one and undo
      // the whole "a restart is new information" argument.
      resumeGaveUp:
        this.resumeGivenUp !== null && resumeGiveUpPersists(this.resumeGivenUp)
          ? this.resumeGivenUp
          : null,
      lastSeq: snapshot.lastSeq,
      dropped: snapshot.dropped,
      title: snapshot.title,
      pinned: snapshot.pinned,
      // The *choice*, never `ultracodeWanted`. Folding the machine's default in
      // here would write it into the row on the next unrelated touch, and this
      // session would then be pinned to today's setting for ever — which is
      // exactly the state the column is nullable to avoid.
      ultracode: this.ultracodeChoice,
    };
  }
}

/**
 * Every session the daemon owns.
 *
 * Terminal sessions stay listed — a client that was disconnected while a session
 * ended still needs to be able to find out why.
 */
export interface CreateSessionOptions {
  agent: AgentId;
  /**
   * The assembled agent this session is being started as, or `null`/omitted for
   * a bare harness.
   *
   * ⚠ **An id, and `agent` beside it is still the harness.** The two are not
   * alternatives and the route does not choose between them: it resolves the row
   * and fills in `agent` from what the row names, so they agree **at creation**.
   *
   * ⚠ **They can come apart afterwards, and this comment used to deny it.**
   * `PATCH /custom-agents/:id` accepts a change of `harness`, so the preset a
   * live session names can be re-pointed at another CLI while `agent` stays
   * what it was — a conversation cannot change vendor underneath itself.
   * `ManagedSession.assembled` is where that is caught, and it degrades to the
   * bare harness rather than launching a triple nobody chose.
   *
   * Everything downstream of here — the worktree, the launch, the
   * restart, the sign-out sweep — reads `agent` and has no idea this exists.
   */
  customAgent?: string | null;
  cwd: string;
  /** Omitted, the daemon-wide default applies. */
  worktree?: WorktreePolicy;
  /** Client-supplied branch name. Validated by git before use. */
  branch?: string | null;
  /**
   * Who asked for this session, when it was not a person.
   *
   * ⚠ **An argument to *this act*, carried to the observers and kept nowhere.**
   * It is not stored on the session, not on the snapshot, not persisted and not
   * on the wire: a session a plugin opened is not that plugin's for ever, and a
   * field that outlived the announcement would become exactly that.
   *
   * Here rather than in `src/plugins/` because the announcement it is for happens
   * **inside** this function — `announce(managed, "created")` runs before `create`
   * resolves, so there is no moment after the `await` at which the caller could
   * stamp it. This file knows nothing about plugins and this string is opaque to
   * it; `PluginHost` is what reads it.
   *
   * ⚠ **Never from a request body.** `POST /sessions` builds these options field
   * by field and does not spread the body — a client able to name its own origin
   * could switch off another plugin's hooks.
   */
  origin?: string | null;
  /**
   * Where this session's worktree goes, overriding the daemon-wide policy.
   *
   * The daemon-wide `workspacePolicy.worktreeRoot` is the answer in production;
   * this exists because the offline drivers point it at a temp directory. It used
   * to be justified per-tenant, so that a worktree landed inside that person's
   * bind mount rather than under the daemon's own home — there is one filesystem
   * and one person now, so what is left is the override and nothing more.
   */
  worktreeRoot?: string;
}

export type WorktreePolicy = "auto" | "require" | "never";

export interface WorkspacePolicy {
  worktreeRoot: string;
  branchPrefix: string;
  defaultMode: WorktreePolicy;
}

const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  worktreeRoot: resolveWorktreeRoot(undefined),
  branchPrefix: DEFAULT_BRANCH_PREFIX,
  defaultMode: "auto",
};

export interface RestoreOptions {
  /** SIGKILL agent process groups the previous daemon left behind. */
  reapOrphans?: boolean;
}

export interface RestoreReport {
  restored: number;
  interrupted: number;
  reaped: number;
}

export interface AutoResumeOptions {
  /** Off turns the whole thing into a no-op, both here and on the prompt path. */
  enabled?: boolean;
  concurrency?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Seams, so a driver can run the retry logic without waiting out a backoff. */
  random?: () => number;
  delay?: (ms: number) => Promise<void>;
  /** Where `src/` reports instead of printing. `scripts/` does the printing. */
  onOutcome?: (outcome: AutoResumeOutcome) => void;
}

export type AutoResumeResult =
  | "resumed"
  | "skipped"
  | "workspace_missing"
  | "workspace_unresponsive"
  | "unsupported"
  | "forgotten"
  | "failed"
  | "attempts_exhausted";

export interface AutoResumeOutcome {
  sessionId: string;
  result: AutoResumeResult;
  attempt: number;
  detail: string | null;
}

export interface AutoResumeReport {
  considered: number;
  resumed: number;
  skipped: number;
  failed: number;
}

/**
 * Somebody watching sessions appear on this daemon.
 *
 * `arrival` is what happened rather than what it looks like: a `restored` session
 * is one this daemon already had before it was last stopped, and an observer that
 * treats it as new writes a duplicate of everything it wrote last week. There is
 * no observer for a session *ending* — that is an event in the session's own log,
 * where an observer is already subscribed and where it is ordered against
 * everything else the session said.
 */
export type SessionObserver = (
  managed: ManagedSession,
  arrival: "created" | "restored",
  /**
   * Who asked for it, when it was not a person — {@link CreateSessionOptions.origin}
   * verbatim, and `null` for every restored session and every session a client
   * created. Opaque here: this file does not know what the string names, and the
   * one observer that does is the plugin host, which uses it to avoid handing a
   * plugin the echo of its own write.
   */
  origin: string | null,
) => void;

export class SessionRegistry {
  private readonly sessions = new Map<string, ManagedSession>();
  /**
   * Who is told when a session appears. See {@link SessionRegistry.watchSessions}.
   *
   * A set rather than one callback because there is one observer today — the
   * plugin host — and "one" is not a property worth building a type around.
   */
  private readonly observers = new Set<SessionObserver>();
  private shuttingDown = false;
  /**
   * Whether the daemon may bring sessions back by itself, on both paths.
   *
   * Injected rather than read here: nothing in this file touches `process.env`,
   * and `scripts/daemon.ts` owns that. One switch for the boot pass *and* the
   * transparent resume on a prompt, because an operator who turned this off
   * because boot spawns hurt does not want prompts spawning either.
   */
  private autoResumeAllowed = true;
  /**
   * Whether an agent on this daemon may ask a person a question.
   *
   * Injected the same way and for the same reason, but with a live consequence
   * `autoResumeAllowed` does not have: declaring the capability re-enables
   * claude's own `AskUserQuestion`, so turning this off withdraws a *tool* rather
   * than a piece of UI. That is the whole justification for having a switch — on
   * a machine nobody is watching, a session that used to finish now parks on a
   * human until the turn is swept. The mirror of `REEMOAT_AUTO_RESUME=0`.
   */
  private elicitationAllowed = true;

  /**
   * How an assembled agent's id is turned back into a system and a model.
   *
   * A switch rather than a constructor collaborator, for `elicitationAllowed`'s
   * reason exactly: `restore()` runs before `daemon.ts` has opened anything, so
   * a store handed in at construction would be absent for every session on the
   * machine — which after a restart is all of them. Defaults to answering `null`,
   * which every driver and `harness.ts` run with and which means "a bare
   * harness".
   */
  private resolveCustomAgentBy: (
    id: string,
  ) => { harness: AgentId; system: SystemId; model: string } | null = () => null;

  /**
   * What a session nobody has decided about asks claude for.
   *
   * Off by default, because it is a real change to how the agent works and
   * turning it on for somebody who did not ask is not this daemon's call. The
   * machine that wants it says so once — see `REEMOAT_CLAUDE_ULTRACODE` — and any
   * session can still overrule it from the effort menu, in either direction.
   */
  private ultracodeByDefault = false;

  /** See {@link MAX_LIVE_SESSIONS}; `daemon.ts` overrides all three. */
  private maxLiveSessions = MAX_LIVE_SESSIONS;
  private createBurst = SESSION_CREATE_BURST;
  private createRefillMs = SESSION_CREATE_REFILL_MS;
  private createTokens = SESSION_CREATE_BURST;
  private createTokensAt = Date.now();

  constructor(
    private readonly store: EventStore = new MemoryEventStore(),
    private readonly sessionStore: SessionStore | null = null,
    private readonly policy: WorkspacePolicy = DEFAULT_WORKSPACE_POLICY,
    /**
     * Where agents run. Defaults to a child process of this daemon, which is
     * what the offline drivers and `harness.ts` drive.
     */
    private readonly runtime: SessionRuntime = new LocalRuntime(),
    /**
     * Where files staged for a prompt live.
     *
     * Null in every driver and in `harness.ts`, which is the honest default: an
     * upload store needs a directory on disk, and those run without one.
     */
    private readonly uploads: UploadsPort | null = null,
    /**
     * Where a session reports a degradation nobody else can see.
     *
     * A constructor parameter beside the other collaborators rather than a
     * setter beside `setAutoResume` and friends, because those three are
     * *environment switches* read through a thunk at every launch, and this is a
     * sink handed to a session when it is built. Defaults to nothing, which is
     * the silence every driver and `harness.ts` already ran with; `scripts/` is
     * what turns it into printed output. See {@link ManagedSessionOptions.onWarning}.
     */
    private readonly onWarning: ((detail: string) => void) | undefined = undefined,
  ) {}

  /**
   * Where assembled agents are read back from. See `resolveCustomAgentBy`.
   *
   * The harness rides along with the system and the model because a preset's
   * harness is editable and a session's is not — `ManagedSession.assembled` is
   * the one reader and it compares rather than uses it.
   */
  setCustomAgents(
    resolve: (id: string) => { harness: AgentId; system: SystemId; model: string } | null,
  ): void {
    this.resolveCustomAgentBy = resolve;
  }

  /**
   * Be told when a session appears, until the returned function is called.
   *
   * ⚠ **A throwing observer is reported and kept, never evicted**, which is the
   * opposite of what `SessionLog.append` does to a throwing listener — and the
   * difference is deliberate. There, a listener is one WebSocket and evicting it
   * costs that socket its events; here, the observer is a whole subsystem, and
   * dropping it on one bad frame would silently stop every plugin hook on the
   * machine for the life of the daemon with nothing anywhere saying so. So the
   * guard reports through `onWarning` and the observer stays.
   */
  watchSessions(observer: SessionObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  private announce(managed: ManagedSession, arrival: "created" | "restored", origin: string | null): void {
    for (const observer of this.observers) {
      try {
        observer(managed, arrival, origin);
      } catch (error) {
        this.onWarning?.(`session observer threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  get workspacePolicy(): WorkspacePolicy {
    return this.policy;
  }

  get sessionRuntime(): SessionRuntime {
    return this.runtime;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get autoResumeEnabled(): boolean {
    return this.autoResumeAllowed;
  }

  setAutoResume(enabled: boolean): void {
    this.autoResumeAllowed = enabled;
  }

  get elicitationEnabled(): boolean {
    return this.elicitationAllowed;
  }

  setElicitation(enabled: boolean): void {
    this.elicitationAllowed = enabled;
  }

  get ultracodeDefault(): boolean {
    return this.ultracodeByDefault;
  }

  /**
   * What a session nobody has decided about asks claude for.
   *
   * Set from the environment by `daemon.ts`, like the two above, and read through
   * a thunk at every launch rather than captured — `restore()` runs before this
   * is called, so a captured value would be wrong for every session on the
   * machine.
   */
  setUltracode(enabled: boolean): void {
    this.ultracodeByDefault = enabled;
  }

  /**
   * The two creation bounds, from the environment.
   *
   * Injected like the three switches above, for the reason given there: nothing
   * in this file reads `process.env`. Taken together rather than one setter each,
   * because they are one policy — a live ceiling with no rate is a create-and-stop
   * loop, and a rate with no ceiling is 200 agents at once.
   */
  setSessionLimits(limits: { live?: number; burst?: number; refillMs?: number }): void {
    if (limits.live !== undefined) this.maxLiveSessions = Math.max(1, limits.live);
    if (limits.burst !== undefined) {
      this.createBurst = Math.max(1, limits.burst);
      // Raising the burst must not leave the bucket below the new ceiling for a
      // whole refill period; lowering it must not leave it above.
      this.createTokens = Math.min(this.createTokens, this.createBurst);
    }
    if (limits.refillMs !== undefined) this.createRefillMs = Math.max(1, limits.refillMs);
  }

  /** Sessions holding, or entitled to, an agent right now. */
  get liveSessionCount(): number {
    let live = 0;
    for (const session of this.sessions.values()) if (!session.terminal) live += 1;
    return live;
  }

  /**
   * Spend one creation slot, or say how long until there is one.
   *
   * A plain token bucket, refilled by elapsed time rather than by a timer: a
   * timer on a daemon that may be idle for days is a wakeup nobody needs, and the
   * arithmetic is the same. `createTokensAt` advances by whole refills only, so a
   * bucket already at its ceiling cannot bank credit for a burst later.
   */
  private takeCreateSlot(now: number): number {
    const elapsed = now - this.createTokensAt;
    const gained = Math.floor(elapsed / this.createRefillMs);
    if (gained > 0) {
      this.createTokens = Math.min(this.createBurst, this.createTokens + gained);
      this.createTokensAt += gained * this.createRefillMs;
    }
    if (this.createTokens <= 0) {
      const wait = this.createRefillMs - (now - this.createTokensAt);
      return Math.max(1, Math.ceil(wait / 1000));
    }
    this.createTokens -= 1;
    return 0;
  }

  async create(options: CreateSessionOptions): Promise<ManagedSession> {
    /*
     * **Refused before anything is touched**, which is the whole point of doing
     * this first: `resolveCwd` below reaches the filesystem, and a path on a
     * stalled network mount costs a bounded probe *and* a threadpool slot. A
     * request that is going to be refused anyway must not spend either.
     *
     * The live cap is checked before the rate, deliberately. It changes no state,
     * so a caller sitting against a full daemon is refused for as long as it is
     * full without also draining the burst it will need when a slot frees — and
     * the two refusals then never mask each other, which matters because they
     * have different remedies: one is "stop something", the other is "wait".
     */
    if (this.liveSessionCount >= this.maxLiveSessions) {
      throw new SessionLimitError(
        "too_many_sessions",
        0,
        `this machine already has ${this.maxLiveSessions} live sessions; stop one before starting another`,
      );
    }
    const wait = this.takeCreateSlot(Date.now());
    if (wait > 0) {
      throw new SessionLimitError(
        "session_rate_limited",
        wait,
        `too many sessions created recently; try again in ${wait}s`,
      );
    }

    // Both throw before anything is spawned or recorded: a bad cwd or a missing
    // agent should be a clean 4xx, not a baffling failure from inside the agent.
    const cwd = await resolveCwd(options.cwd);
    // Through the runtime, not `resolveAgent` directly: a container's agents are
    // in the container, and probing this host's filesystem for them would answer
    // a question about the wrong machine.
    this.runtime.describe(options.agent);

    // And then actually *asked*, which `describe` alone does not do.
    //
    // `describe` is a table lookup in the container runtime — it only throws for
    // an id the route has already rejected as `invalid_agent` — so the fail-fast
    // the comment above promises had quietly stopped happening. The common case
    // it exists for is a tenant who has not run `claude auth login`, or an image
    // without that binary: the order became create-the-worktree, create-the-
    // branch, register-the-session, *then* fail, and `create` deliberately
    // leaves the worktree behind on failure. Nothing ever collected those, so
    // every retry of a failing start was permanent growth inside the tenant's
    // own tree plus a branch left in their repository.
    //
    // This also settles the start budget. `availability` readies the container,
    // so `START_TIMEOUT_MS` below covers only the ACP handshake rather than
    // racing a 120s image pull it could never win.
    const availability = await this.runtime.availability();
    const agentState = availability.find((entry) => entry.id === options.agent);
    if (agentState && !agentState.available) {
      throw new AgentUnavailableError(
        agentState.hint ?? `${options.agent} is not available in this runtime`,
      );
    }

    // Minted before the workspace, because the worktree path and branch name
    // embed it.
    const id = `s_${randomBytes(4).toString("hex")}`;

    // Created before the session is registered, so a WorktreeError is a clean 4xx
    // with nothing on disk and nothing in the map to clean up.
    const { workspace, warnings } = await createWorkspace({
      cwd,
      sessionId: id,
      policy: options.worktree ?? this.policy.defaultMode,
      worktreeRoot: options.worktreeRoot ?? this.policy.worktreeRoot,
      branchPrefix: this.policy.branchPrefix,
      branchHint: options.branch ?? null,
      // `worktree add` performs a checkout, so it runs whatever the repository's
      // own hooks and filters say. That is the intended behaviour now — they are
      // this user's hooks, in this user's repository.
      runner: this.runtime.git(),
    });

    const managed = new ManagedSession(id, options.agent, workspace, this.store, {
      customAgent: options.customAgent ?? null,
      // Re-read through `this` at every call, never captured — see the field.
      resolveCustomAgent: (id) => this.resolveCustomAgentBy(id),
      sessionStore: this.sessionStore,
      runtime: this.runtime,
      uploads: this.uploads,
      elicitationAllowed: () => this.elicitationAllowed,
      ultracodeDefault: () => this.ultracodeByDefault,
      onWarning: this.onWarning,
    });
    this.sessions.set(id, managed);
    // Before start(), so it precedes `status: starting` and a since=0 attach sees
    // where the session lives before it sees anything the agent said.
    managed.recordWorkspace(warnings);
    // After the workspace is recorded and before the agent is launched, so an
    // observer subscribing to this session's log is attached before the first
    // thing the agent says — the same ordering `recordWorkspace` is placed for.
    //
    // The origin travels with the announcement and is kept nowhere. This is the
    // ordering that forces that: this line runs before `create` resolves, so a
    // caller holding the returned session is already too late to stamp it.
    this.announce(managed, "created", options.origin ?? null);

    // If this throws, the worktree is deliberately left in place. Tearing it down
    // on an error path is how you eventually delete a directory you did not
    // create, the day a bug makes `mode` wrong. The session stays listed and
    // terminal, so the workspace is still reachable through its own route.
    await managed.start();
    return managed;
  }

  /**
   * Rebuilds every persisted session, without spawning anything.
   *
   * Must run before the server starts serving, and — because of the reaping
   * below — only ever after the daemon lock has been claimed.
   *
   * A row that already carried an exit ended before the restart; it is left
   * alone, since it has its own reason and its own final status event. Everything
   * else was live when the daemon died, which means its agent died too.
   */
  restore(options: RestoreOptions = {}): RestoreReport {
    if (!this.sessionStore) return { restored: 0, interrupted: 0, reaped: 0 };
    let interrupted = 0;
    let reaped = 0;

    for (const row of this.sessionStore.list()) {
      if (this.sessions.has(row.id)) continue;
      // Nothing to rebuild but the session itself: this used to reconstruct the
      // tenant from the row's owner, and a row written before that column existed
      // came back with none, so every restored session answered `resume` with a
      // 502 it could not explain. There is no tenant now and no second thing to
      // get wrong.
      const managed = ManagedSession.restore(row, this.store, {
        sessionStore: this.sessionStore,
        runtime: this.runtime,
        uploads: this.uploads,
        // A thunk, because `restore()` runs *before* `daemon.ts` reads the
        // environment — a boolean captured here would be stale for every session
        // on the machine.
        elicitationAllowed: () => this.elicitationAllowed,
        ultracodeDefault: () => this.ultracodeByDefault,
        resolveCustomAgent: (id) => this.resolveCustomAgentBy(id),
        onWarning: this.onWarning,
      });
      this.sessions.set(row.id, managed);
      // Announced for every restored row, terminal ones included: an observer
      // rebuilding its own index after a restart needs the sessions that ended
      // while the daemon was down as much as the ones that did not.
      //
      // `null`, and not because the origin was lost: a restart is not an act
      // anybody performed, so there is nobody whose echo this would be.
      this.announce(managed, "restored", null);
      if (row.exit !== null) continue;

      // The runtime owns the fence, because only it knows what makes a recorded
      // handle stale — a host reboot for one, a container restart for the other.
      const orphan = this.runtime.reap(row.agentHandle, row.createdAt, options.reapOrphans ?? true);
      if (orphan.killed) reaped += 1;
      // Appends `status: interrupted` at lastSeq + 1. That append is the whole
      // demonstration: a client reconnecting with the cursor it last saw gets
      // exactly one new event, and it explains the outage.
      managed.markInterrupted(orphan.confirmedDead, orphan.detail);
      interrupted += 1;
    }

    return { restored: this.sessions.size, interrupted, reaped };
  }

  /**
   * Puts an agent back on every session the daemon itself ended.
   *
   * Deliberately **not** part of `restore()`, which has to stay synchronous —
   * the orphan reaping in there is fenced on running before anything serves.
   * This is the async half, and `scripts/daemon.ts` starts it with `void` after
   * the listener is up: `wait_healthy` polls `/health` for 30s during a deploy,
   * and nothing on the boot path may sit behind N agent handshakes.
   *
   * Most-recently-active first, because the session somebody was mid-turn on
   * when the deploy landed is the one they will open. `list()` stays oldest-first
   * — that order is for display and this pass sorts its own copy.
   *
   * Two at a time. Each resume is a node subprocess with a `claude` grandchild
   * under it, and eight of those starting together on a laptop right after a
   * deploy is a real spike for no gain: two drains eight sessions in four
   * handshakes, and nobody is reading more than one of them.
   */
  async autoResume(options: AutoResumeOptions = {}): Promise<AutoResumeReport> {
    const report: AutoResumeReport = { considered: 0, resumed: 0, skipped: 0, failed: 0 };
    if (!(options.enabled ?? this.autoResumeAllowed)) return report;

    const maxAttempts = options.maxAttempts ?? MAX_RESUME_ATTEMPTS;
    const wait = options.delay ?? delay;
    const random = options.random ?? Math.random;
    const say = options.onOutcome ?? ((): void => {});

    const queue = [...this.sessions.values()]
      .filter(
        (session) =>
          !session.resumeSettled && autoResumable(session.exit, session.agentSessionId, "boot"),
      )
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt));
    report.considered = queue.length;

    /*
     * One wasted spawn per agent binary is unavoidable — `Session.resume` can
     * only ask whether an agent supports `session/resume` *after* it has started
     * one — but the other N-1 are not. An agent that answered
     * `ResumeUnsupportedError` once will answer it for every session in this
     * pass, so it is asked once.
     */
    const unsupported = new Set<AgentId>();
    let next = 0;

    /** One session, carried through its whole retry budget before the next is taken. */
    const drive = async (session: ManagedSession): Promise<void> => {
      for (;;) {
        // Checked per attempt rather than once at the top: a deploy's SIGTERM
        // can land in the middle of this pass, and starting an agent we are
        // about to kill is the one thing worse than not starting it. A resume
        // already in flight is safe without this — `resume()` clears
        // `exitRecord` synchronously, so the session is non-terminal and
        // `shutdown()` collects it, and `doStop` awaits `startPromise` rather
        // than orphaning the spawn.
        if (this.shuttingDown) return;

        if (unsupported.has(session.agent)) {
          session.abandonResume(
            "unsupported",
            "resume_unsupported",
            `${session.agent} cannot reattach to an earlier conversation`,
          );
          report.skipped += 1;
          say({ sessionId: session.id, result: "unsupported", attempt: 0, detail: null });
          return;
        }

        /*
         * The workspace is checked *before* the resume rather than left to fail
         * inside the agent, because `resume()` clears and restores `exitRecord`
         * and would emit two status events for a session that was never going
         * to start. claude's adapter rejects a nonexistent `cwd` outright.
         *
         * Three answers, and the third is why this is `probeExists` and not
         * `existsSync`. `false` is "the worktree is gone" — settled, so it costs
         * no attempt and is never retried. `null` is "a mount did not answer",
         * which is emphatically not the same thing: spending the whole budget on
         * it would abandon somebody's work over a NAS that was asleep, and
         * treating it as present would park a fresh agent inside an
         * uninterruptible kernel wait.
         */
        const present = await probeExists(session.workspace.root);
        if (present === false) {
          session.abandonResume("workspace_missing", "workspace_missing", `${session.workspace.root} is gone`);
          report.skipped += 1;
          say({ sessionId: session.id, result: "workspace_missing", attempt: 0, detail: null });
          return;
        }

        // Both ways an attempt can fail converge here — a mount that would not
        // answer and an agent that would not start — because what happens after
        // either is identical. Written as two branches, the give-up half is the
        // one that gets forgotten in whichever copy runs less often.
        let failure: { code: string; message: string } | null = null;

        if (present === null) {
          failure = {
            code: "workspace_unresponsive",
            message: `${session.workspace.root} did not answer`,
          };
        } else {
          try {
            // Quiet: nobody asked for this attempt, so a failure leaves the
            // snapshot's `resume` field and one `error` event at the end rather
            // than a status round trip per try. See `onStartFailed`.
            await session.resume(options.timeoutMs ?? START_TIMEOUT_MS, true);
            report.resumed += 1;
            say({
              sessionId: session.id,
              result: "resumed",
              attempt: session.resumeAttemptCount + 1,
              detail: null,
            });
            return;
          } catch (error) {
            const described = describeResumeFailure(error);
            if (error instanceof ResumeUnsupportedError) {
              unsupported.add(session.agent);
              session.abandonResume("unsupported", described.code, described.message);
              report.skipped += 1;
              say({ sessionId: session.id, result: "unsupported", attempt: 0, detail: described.message });
              return;
            }
            /*
             * The agent says the conversation is gone. That is an answer, not a
             * failure to get one, so it costs no retry budget — the same
             * treatment `workspace_missing` gets above and for the same reason:
             * asking again cannot change what is on the agent's disk.
             *
             * Spending three attempts here was measured in production at ten
             * sessions × three spawns on every restart, for conversations that
             * no longer existed.
             */
            if (error instanceof SessionForgottenError) {
              session.abandonResume("forgotten", described.code, described.message);
              report.skipped += 1;
              say({ sessionId: session.id, result: "forgotten", attempt: 0, detail: described.message });
              return;
            }
            failure = described;
          }
        }

        const spent = session.noteResumeFailure(failure.code, failure.message);
        if (spent >= maxAttempts) {
          session.abandonResume("attempts_exhausted", failure.code, failure.message);
          report.failed += 1;
          say({ sessionId: session.id, result: "attempts_exhausted", attempt: spent, detail: failure.message });
          return;
        }
        say({ sessionId: session.id, result: "failed", attempt: spent, detail: failure.message });
        // Waited out here rather than requeued behind the others, which parks
        // this worker for the backoff. That is the deliberate trade: requeueing
        // means carrying a wall-clock deadline through the queue, and a queue
        // whose head is not yet due either spins or needs a real clock — which a
        // driver injecting a no-op `delay` does not have. One of two workers
        // idling for at most 60s is the cheaper honesty.
        await wait(resumeBackoffMs(spent, random));
      }
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.shuttingDown) return;
        const session = queue[next++];
        if (session === undefined) return;
        await drive(session);
      }
    };

    const width = Math.max(1, Math.min(options.concurrency ?? RESUME_CONCURRENCY, queue.length));
    await Promise.all(Array.from({ length: width }, () => worker()));
    return report;
  }

  get(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * End every conversation running on an agent somebody has just signed out of.
   *
   * **This is what makes signing out mean anything.** A credential is read once,
   * at spawn, so a process started while signed in keeps answering long after the
   * account behind it was revoked — the conversation carries on, apparently
   * fine, for an account its owner has just taken away. Nothing about the
   * sign-out reached it, because nothing could.
   *
   * Ended rather than relaunched, which is the opposite of what a *saved*
   * credential does and for a reason worth stating: relaunching here would start
   * an agent with no way to authenticate, and that fails at the first message —
   * inside the transcript, as `Internal error: Failed to authenticate`, which is
   * the least explicable place a refusal can appear. Ending it says the true
   * thing in the one place the client can render properly.
   *
   * A turn in flight is **not** spared, unlike `takesCredentialChange`. That
   * asymmetry is the point: there, the credential was being *added* and a working
   * turn was evidence of a working credential; here the credential is being taken
   * away, and a turn still running on it is exactly what somebody signing out
   * means to stop.
   *
   * Returns how many were ended, so the route can say so.
   */
  async signOutSessions(agent: AgentId): Promise<number> {
    const live = [...this.sessions.values()].filter(
      (session) => session.agent === agent && !session.terminal,
    );
    // Sequential rather than `Promise.all`: each `stop` awaits a process teardown,
    // and firing every one at once on a machine with many sessions is a thundering
    // herd of SIGTERMs against the same event loop.
    for (const session of live) {
      await session.stop("agent_signed_out").catch(() => undefined);
    }
    return live.length;
  }

  /**
   * Put a credential change in front of every conversation already running on it.
   *
   * **The gap this closes is a whole product's worth of confusion.** Secrets are
   * injected at spawn, so pasting a token updated the database, turned the badge
   * green, and changed nothing at all for the chat somebody was looking at — which
   * went on answering `Failed to authenticate` with no explanation available
   * anywhere on the screen. Measured 2026-08-20: a token saved at 00:23:02, a
   * prompt refused at 00:23:12, and a session created four minutes later working
   * immediately.
   *
   * **Started, not awaited.** A restart runs into seconds and this is a fan-out
   * over every session on the agent; holding the route open for all of them would
   * make saving a key a request that looks hung. Nothing is lost by answering
   * early, because the wait already exists where it matters: `prompt` calls
   * `whenRestarted()`, so somebody who saves a token and immediately types is made
   * to wait for their own session rather than refused by it.
   *
   * The count is what came back, and is deliberately the number of sessions that
   * **will** restart rather than the number that finished — the caller answers a
   * request, not a fleet.
   *
   * ⚠ **`revive` is which direction the change went, and it is not a convenience.**
   * A credential arriving and a credential going away reach the running sessions
   * the same way — both are invisible until a relaunch — so both callers want the
   * restart half. Only one of them wants the resume half, which is the `returning`
   * filter below and the whole of what this argument decides.
   */
  reloadCredentials(agent: AgentId, revive = true): number {
    const mine = [...this.sessions.values()].filter((session) => session.agent === agent);
    const restarting = mine.filter((session) => session.takesCredentialChange);
    /*
     * **Signing in reverses a sign-out, and only a sign-out.**
     *
     * `agent_signed_out` is the record of who ended these and why, so it is what
     * decides which come back: a conversation this daemon ended *because the
     * credential went away* is owed a resume when a credential returns. One
     * somebody stopped by hand carries `stopped` and stays stopped — reviving
     * that would be the daemon overruling a person, which is the whole reason the
     * reason exists rather than a boolean.
     *
     * `autoResumable` deliberately answers `false` for it, and that is not in
     * tension with this: nothing may bring these back *on its own*. This is not
     * on its own — it is the same person, on the same machine, undoing the thing
     * that ended them.
     *
     * ⚠ **And only when a credential *arrived*, which is what `revive` carries.**
     * Both routes reach this function, and reading the change as symmetric made
     * `DELETE /agent-auth/:agent` resume every conversation that had been ended
     * *because there was no credential* — spawning agents with nothing to
     * authenticate with, straight into the `Internal error: Failed to
     * authenticate` this file argues against three docblocks up. A removal is a
     * sign-out's second half, never its reversal: the restart half still runs, so
     * a session holding the old secret in its environment still loses it.
     */
    const returning = revive
      ? mine.filter((session) => session.terminal && session.exit?.reason === "agent_signed_out")
      : [];

    /*
     * ⚠ **One at a time, and still without making the caller wait.**
     *
     * Each of these is a SIGTERM and a process teardown followed by a fresh spawn
     * and an ACP handshake. Issued as N bare `void` calls they all started at
     * once, so saving or deleting one credential on a full machine was up to
     * `DEFAULT_MAX_SESSIONS` simultaneous teardowns and as many spawns against
     * this one event loop — which is exactly the thundering herd `signOutSessions`
     * refuses sixty lines up, in the same file, over the same work.
     *
     * The `void` stays where it matters: the loop is detached, so the route still
     * answers with the count immediately and the restarts proceed behind it. What
     * changed is that they now proceed in a queue rather than in a stampede.
     *
     * Each independently, and a failure in one may not take the others with it. A
     * refused session never reaches here — `takesCredentialChange` decided that
     * above — so what this swallows is a stop or a resume that genuinely threw,
     * which the session reports through its own state the way any failed resume
     * does.
     */
    void (async () => {
      for (const session of restarting) {
        if (this.shuttingDown) return;
        await session.applyCredentialChange().catch(() => undefined);
      }
      for (const session of returning) {
        /*
         * ⚠ **Both of these are debts serialising this loop took on**, and neither
         * was payable before it: the old bare-`void` form did all of this in the
         * tick that decided it, so there was no "later" for anything to change in.
         *
         * The shutdown check is the same one the boot resume pass makes per
         * attempt, for the reason it states there — starting an agent we are about
         * to kill is worse than not starting it. It matters *more* here. That pass
         * notes a resume already in flight is safe without it, because `resume()`
         * clears `exitRecord` synchronously and `shutdown()` then collects the
         * session; a *queued* one has not run at all, so it is in neither
         * `shutdown()`'s list nor anything else's, and the agent it spawns is
         * `detached` and outlives `process.exit(0)`. The restart half above is
         * incidentally safe — `applyCredentialChange` re-tests
         * `takesCredentialChange`, whose first line refuses a terminal session —
         * but it is written out there too rather than relied on silently.
         *
         * The predicate is re-tested for the same reason `applyCredentialChange`
         * re-tests its own: "Re-checked, never assumed." `returning` was decided
         * before the restarts ran, and by the time a queue of process teardowns and
         * ACP handshakes reaches the end of it, a session may have been reconnected
         * and then stopped by hand. `doResume` refuses only a non-terminal session
         * and never looks at the reason, so without this it would be revived —
         * which is the docblock's own line about a conversation carrying `stopped`
         * staying stopped, and the daemon not overruling a person.
         */
        if (this.shuttingDown) return;
        if (!(session.terminal && session.exit?.reason === "agent_signed_out")) continue;
        await session.resume().catch(() => undefined);
      }
    })();
    return restarting.length + returning.length;
  }

  list(): ManagedSession[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Distinct working directories, most recently used first. Feeds the picker.
   *
   * Reports what the client *asked for*, not where the agent ended up. Once
   * sessions run in worktrees those differ, and offering the picker a list of
   * ephemeral `.reemoat/worktrees/…` paths would make it useless.
   */
  recentCwds(limit = 10): string[] {
    const seen: string[] = [];
    for (const session of [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt)) {
      if (!seen.includes(session.requestedCwd)) seen.push(session.requestedCwd);
      if (seen.length >= limit) break;
    }
    return seen;
  }

  async stop(id: string): Promise<boolean> {
    const managed = this.sessions.get(id);
    if (!managed) return false;
    await managed.stop("stopped");
    return true;
  }

  async resume(id: string): Promise<ManagedSession | undefined> {
    const managed = this.sessions.get(id);
    if (!managed) return undefined;
    await managed.resume();
    return managed;
  }

  /**
   * Stops everything, then makes sure.
   *
   * A resolved stop proves an attempt was made, not that a child died, so the
   * group kill runs unconditionally on every path out of here.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const live = this.list().filter((session) => !session.terminal);
    // Collected *before* the stops, because a session that stops cleanly forgets
    // its handle, and this list is precisely for the ones that did not.
    const handles = live
      .map((session) => session.agentHandle)
      .filter((handle): handle is AgentHandle => handle !== null);

    await Promise.race([
      Promise.all(live.map((session) => session.stop("daemon_shutdown").catch(() => {}))),
      delay(SHUTDOWN_BUDGET_MS),
    ]);

    // Parallel, and bounded by the same budget as the stops above.
    //
    // This was a serialized `for..of` with two awaits per handle. That was free
    // while each one was a `process.kill` syscall, and ruinous when the container
    // runtime made it a `docker exec` — a subprocess spawn plus a daemon round
    // trip, N sessions costing 3N of them strictly one after another, outside the
    // shutdown budget and against `daemon.ts`'s hard `process.exit` a few seconds
    // later. It is a syscall again, so the parallelism buys little; it stays for
    // the same reason the bound above does, which is that neither depends on what
    // a kill currently costs.
    //
    // The liveness probe is gone rather than parallelised: `kill` already
    // swallows "no such process" (`okExitCodes` plus a `.catch`), so asking
    // first tripled the cost and changed no decision.
    await Promise.race([
      Promise.all(handles.map((handle) => this.runtime.kill(handle, "SIGKILL").catch(() => {}))),
      delay(SHUTDOWN_SWEEP_MS),
    ]);
  }
}

type OptionPick =
  | { kind: "ok"; response: acp.RequestPermissionResponse }
  | { kind: "invalid_option" }
  | { kind: "no_matching_option" };

/**
 * Maps an answer onto an option the agent actually offered.
 *
 * A rejection never degrades into `cancelled`: cancelled means the turn was
 * abandoned, which is a different thing to tell an agent than "the human said no".
 */
function chooseOption(answer: PermissionAnswer, options: PermissionOptionSummary[]): OptionPick {
  if ("cancel" in answer) return { kind: "ok", response: CANCELLED };

  if ("optionId" in answer) {
    const match = options.find((option) => option.optionId === answer.optionId);
    if (!match) return { kind: "invalid_option" };
    return { kind: "ok", response: { outcome: { outcome: "selected", optionId: match.optionId } } };
  }

  const preference: Record<DecisionWord, PermissionOptionSummary["kind"][]> = {
    allow: ["allow_once", "allow_always"],
    allow_always: ["allow_always", "allow_once"],
    reject: ["reject_once", "reject_always"],
    reject_always: ["reject_always", "reject_once"],
  };
  for (const kind of preference[answer.decision]) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return { kind: "ok", response: { outcome: { outcome: "selected", optionId: match.optionId } } };
    }
  }
  return { kind: "no_matching_option" };
}

/**
 * Whether a `content` object is an answer to this form.
 *
 * Validated against **the projection this daemon sent**, never against the raw
 * `requestedSchema`: the projection is the only thing a client was ever shown, so
 * anything else would refuse answers it was invited to give.
 *
 * **Every problem, never the first.** A form is filled in all at once, and one
 * error per round trip is a phone interaction nobody survives.
 *
 * Module-scope and pure so `daemoncheck` can drive every rule with no session,
 * the same placement `usageWorthAnnouncing` has and for the same reason.
 */
export function validateElicitationContent(
  form: ElicitationForm,
  content: Record<string, unknown>,
): ElicitationProblem[] {
  const problems: ElicitationProblem[] = [];
  const byKey = new Map(form.fields.map((field) => [field.key, field]));

  for (const key of Object.keys(content)) {
    if (byKey.has(key)) continue;
    // Refused rather than stripped. Stripping silently changes what somebody
    // answered, and the one thing that produces a stray key is a client that is
    // out of date — which is exactly when it has to be told.
    problems.push({ key, code: "unknown_field", detail: "this form has no such field" });
  }

  for (const field of form.fields) {
    const present = Object.prototype.hasOwnProperty.call(content, field.key);
    if (!present) {
      if (field.required) {
        problems.push({ key: field.key, code: "missing", detail: "this field is required" });
      }
      continue;
    }
    validateField(field, content[field.key], problems);
  }

  return problems;
}

function validateField(
  field: ElicitationField,
  value: unknown,
  problems: ElicitationProblem[],
): void {
  const bad = (code: ElicitationProblem["code"], detail: string): void => {
    problems.push({ key: field.key, code, detail });
  };

  switch (field.kind) {
    case "string": {
      // Never coerced. JSON already distinguishes a string from a number, so
      // accepting `7` for a string field would be the daemon deciding what
      // somebody meant.
      if (typeof value !== "string") return bad("wrong_type", "expected a string");
      if (value.length > MAX_ELICITATION_ANSWER_CHARS) {
        return bad("too_long", `answers are limited to ${MAX_ELICITATION_ANSWER_CHARS} characters`);
      }
      if (field.options !== null) {
        // By identity against the value we sent — never a prefix match, never
        // case-folded. The permission rule verbatim.
        if (!field.options.some((option) => option.value === value)) {
          return bad("not_an_option", "that is not one of the choices offered");
        }
        return;
      }
      if (field.min !== null && value.length < field.min) {
        return bad("too_short", `at least ${field.min} characters`);
      }
      if (field.max !== null && value.length > field.max) {
        return bad("too_long", `at most ${field.max} characters`);
      }
      // `format` is deliberately not enforced. The canonical email and uri
      // patterns are wrong in both directions, and refusing `a@b` because our
      // regex disagrees with the agent's refuses an answer the agent would have
      // taken. It travels as an input hint and is checked by nobody.
      return;
    }

    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return bad("wrong_type", "expected a number");
      }
      if (field.kind === "integer" && !Number.isInteger(value)) {
        return bad("wrong_type", "expected a whole number");
      }
      if (field.min !== null && value < field.min) return bad("too_small", `at least ${field.min}`);
      if (field.max !== null && value > field.max) return bad("too_large", `at most ${field.max}`);
      return;
    }

    case "boolean":
      if (typeof value !== "boolean") bad("wrong_type", "expected true or false");
      return;

    case "multi_select": {
      if (!Array.isArray(value)) return bad("wrong_type", "expected a list of choices");
      const seen = new Set<string>();
      for (const entry of value) {
        if (typeof entry !== "string") return bad("wrong_type", "expected a list of strings");
        // Refused rather than deduped here: a repeated choice reaches the agent
        // as a repeated label once the adapter joins them, so silently collapsing
        // it would change the answer without saying so.
        if (seen.has(entry)) return bad("duplicate", "the same choice was given twice");
        seen.add(entry);
        if (!(field.options ?? []).some((option) => option.value === entry)) {
          return bad("not_an_option", "that is not one of the choices offered");
        }
      }
      if (field.min !== null && value.length < field.min) {
        return bad("too_few", `choose at least ${field.min}`);
      }
      if (field.max !== null && value.length > field.max) {
        return bad("too_many", `choose at most ${field.max}`);
      }
      return;
    }
  }
}

/**
 * Turns validated content into the pairs the resolution event carries.
 *
 * Rendered *here*, on the side that still holds the form, because the schema does
 * not ride every event and is gone from memory the moment the question settles.
 * That is what makes `ElicitationResolvedEvent` self-describing and is the one
 * place the permission pair is deliberately not copied — see the event's own
 * docblock for what that copy cost when it was missing.
 *
 * `value` is the chosen option's **label** and never its wire value: a wire value
 * is what the agent recognises, a label is what the person read and tapped.
 */
function renderAnswers(
  form: ElicitationForm,
  content: Record<string, ElicitationContentValue>,
): ElicitationAnswer[] {
  const answers: ElicitationAnswer[] = [];
  for (const field of form.fields) {
    if (!Object.prototype.hasOwnProperty.call(content, field.key)) continue;
    const value = content[field.key];
    const label = (raw: string): string =>
      field.options?.find((option) => option.value === raw)?.label ?? raw;
    const rendered = Array.isArray(value)
      ? value.map(label).join(", ")
      : typeof value === "string"
        ? label(value)
        : String(value);
    if (rendered.length === 0) continue;
    answers.push({ key: field.key, label: field.title ?? field.key, value: rendered });
  }
  return answers;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
