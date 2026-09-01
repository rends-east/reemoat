/**
 * The daemon's wire vocabulary, mirrored.
 *
 * These are hand-copied from `src/events.ts` and `src/registry.ts` rather than
 * imported, and the reason is mechanical, not stylistic: `src/events.ts` imports
 * its ACP types from `@agentclientprotocol/sdk`, and `src/registry.ts` imports
 * `node:crypto` and `node:os`. Under pnpm's strict layout neither resolves from a
 * browser package, and pulling them in would drag the daemon's whole dependency
 * graph into a bundle that ships to a phone. The import direction would have been
 * legal — the control plane already reads `src/relay/protocol.ts` — but the
 * transitive closure is not.
 *
 * The cost is real and worth stating: **this file can drift.** It describes bytes
 * the daemon already sent, so drift shows up as a field that is `undefined` at
 * runtime rather than a type error at build time. Anything narrowing a union here
 * is therefore written to fail open — an unrecognised `type` renders as an
 * unknown event rather than throwing, and an unrecognised status renders as
 * itself.
 *
 * Copied from the daemon at the commit that introduced this package.
 */

/* ------------------------------------------------------------------ *
 * Events — src/events.ts
 * ------------------------------------------------------------------ */

/**
 * The four harnesses this product ships, mirrored as a **closed** union — because
 * that is what the daemon's `AGENT_IDS` is, and it stayed closed when `AgentId`
 * did not.
 *
 * `src/acp/agents.ts` still derives this tuple from four literals, `resolveAgent`
 * still switches over it with no `default` arm, and `AGENT_LOGIN` is still a
 * `Record` keyed on it. What changed is that a *machine* may now offer more than
 * this repository ships, so the list of what exists and the list of what is
 * built in are two different questions and this answers the second.
 *
 * ⚠ **Keeping this closed is not sentiment; three things on this side depend on
 * it.** `AGENT_LABEL` is a hand-written table `webcheck` reads as source text and
 * requires a row in for every member; `AgentGlyph` is an exhaustive `switch` whose
 * `never` arm is the only thing in the fleet that makes adding a harness loud; and
 * `startsBare`'s built-in arm is a literal. Every one of those would become
 * unsatisfiable — not merely weaker — against a list that grows at runtime.
 */
export const AGENT_IDS: readonly BuiltinAgentId[] = ["claude", "kimi", "codex", "opencode"];
export type BuiltinAgentId = "claude" | "kimi" | "codex" | "opencode";

/**
 * A harness id, which is a string.
 *
 * ⚠ **Widened, and the guard that used to stand behind it is *gone* rather than
 * loosened — which is the part worth reading.** `isAgentId` existed for one
 * caller: an id arriving off a URL, checked so that a stale link opened the agent
 * chooser instead of a screen whose every control answered 400. A shape test
 * cannot do that job any more, because a machine's harnesses are a fact about
 * which plugins are installed on it, so the check moved to where that fact is —
 * the listing this client already fetches. `AgentBuilder` seeds its harness from
 * `GET /agents` rather than from the address, and `parseSettingsRoute` carries the
 * id through to a daemon that refuses what it does not offer.
 *
 * ⚠ **A missing mirror edit is no longer a lie this type can tell**, which is the
 * one thing the old docblock worried about and the one thing that got better:
 * there is nothing here to fall out of step with, because the daemon's answer is
 * the list.
 */
export type AgentId = string;

/** Whether this is one of the four this product ships. Never "does this machine have it". */
export function isBuiltinAgentId(value: string): value is BuiltinAgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

/**
 * Mirrored as an **open** union, because that is what the daemon's is.
 *
 * `src/events.ts` declares `kind: ToolKind` from the ACP SDK, and that type ends
 * in `| string` — the generated zod validator is a `ZodCatch` over `ZodString`,
 * so an agent may send a kind nobody has heard of and the daemon will pass it
 * through. A closed nine-member union here was a lie about the wire in two
 * directions at once: it omitted `switch_mode`, which the schema does define, and
 * it claimed the set was closed when it is not. `(string & {})` keeps
 * autocomplete on the known members while still accepting the rest.
 */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other"
  | (string & {});

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface FileLocation {
  path: string;
  line: number | null;
}

export interface PermissionOptionSummary {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface SessionStartedEvent {
  type: "session_started";
  agent: AgentId;
  sessionId: string;
  agentInfo: { name: string; version: string } | null;
  /**
   * ACP's legacy `modes` field, which claude fills in and kimi does not.
   *
   * Not the thing to render: kimi is not modeless, it publishes the same four
   * modes through `configOptions` under `category: "mode"` instead. Draw from
   * {@link AgentConfigEvent} / `SessionSnapshot.agentConfig`, which normalizes
   * both.
   */
  modes: AgentModes | null;
}

export interface AgentConfigChoice {
  value: string;
  name: string;
  description: string | null;
  /** The heading this value sits under, when the agent grouped its choices. */
  group: string | null;
}

/**
 * One knob the agent will let a client change: mode, model, reasoning effort.
 *
 * **Render from `category`, never from `id`.** The ids are not portable — claude
 * calls reasoning effort `effort` with values `default|low|…|max`, kimi calls it
 * `thinking` with values `off|…` — and a client keyed on the id draws one
 * agent's controls and none of the other's. ACP's own categories are `mode`,
 * `model`, `model_config` and `thought_level`; the spec says they are UX hints
 * that MUST NOT be required for correctness, so an unknown or absent one has to
 * render as a plain labelled control rather than disappear.
 */
export interface AgentConfigOption {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  kind: "select" | "boolean";
  /** A choice's `value` when `kind` is `"select"`, the toggle state otherwise. */
  value: string | boolean;
  /** Empty for a boolean. */
  choices: AgentConfigChoice[];
  /**
   * Whether `choices` is a head rather than the whole list.
   *
   * Set only on the snapshot `GET /sessions` returns, where the daemon cuts a long
   * model list to a bounded head — the selected choice always among it. Absent
   * means the whole list, which is what an older daemon sends for every agent and
   * what this one sends for every agent but opencode, whose published list is long
   * enough to be cut in ordinary use. A screen wanting the rest reads
   * `GET /sessions/:id`.
   */
  truncated?: boolean;
}

export interface AgentModes {
  current: string;
  available: { id: string; name: string; description: string | null }[];
}

/**
 * The complete control state — never a delta.
 *
 * The daemon merges ACP's partial `current_mode_update` against what it already
 * holds before sending this, precisely so a client does not need a reducer of
 * its own. Arrives on session start, whenever the *agent* changes something
 * itself (claude flips to `plan` from its own hook, and resets the mode when a
 * model switch makes the current one impossible), and after every accepted
 * config change.
 */
export interface AgentConfig {
  modes: AgentModes | null;
  options: AgentConfigOption[];
}

export interface AgentConfigEvent extends AgentConfig {
  type: "agent_config";
}

/**
 * One command the agent will answer to a leading slash.
 *
 * ACP's entire argument surface for a command is `hint` — a string of prose, with
 * no schema, no enums and no completion. So `hint` is a placeholder to *show*,
 * never a template to insert: putting it in the box would send it to the model as
 * if somebody had typed it.
 *
 * Deliberately not part of {@link AgentConfig}, which means "what a caller may
 * change". A command is invoked, not set — and it is fetched from its own route
 * rather than carried on the snapshot, so it is not on {@link SessionSnapshot}
 * either. See `commandsRevision` there.
 */
export interface AgentCommand {
  /** Without the leading slash, as the agent published it. */
  name: string;
  description: string;
  hint: string | null;
}

/** Text arrives in chunks. Consecutive ones with the same role/thought are one run. */
export interface TextEvent {
  type: "text";
  role: "agent" | "user";
  thought: boolean;
  text: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  locations: FileLocation[];
  /**
   * The tool's arguments — where a shell command actually lives, and the only
   * place a permission card can find one.
   *
   * May be the truncation stand-in `{truncated: true, bytes: number}` when the
   * event exceeded the 128 KiB per-event cap.
   */
  rawInput: unknown;
  /**
   * The tool call this one ran *inside*, when an agent said so.
   *
   * Three rules a client has to hold, and none of them is enforced by a type:
   *
   * 1. **A parent may not be present.** It can have been evicted below
   *    `firstSeq`, or simply be older than this window. That is normal, not a
   *    fault — a walk that assumes the parent is there draws an empty screen on
   *    exactly the long sessions people care about. Render at top level instead.
   * 2. **A child may arrive before its parent.** The daemon never reorders,
   *    buffers or synthesises in order to build a tree, on purpose.
   * 3. **Every traversal must be cycle-safe, and a depth constant is not
   *    enough.** The daemon normalizes only self-reference; a longer cycle from
   *    a broken agent is not detectable without state it refuses to keep, so two
   *    mutually-parented calls are something a reader will be sent. A depth
   *    limit says when to stop *climbing* and says nothing about how many hops a
   *    walk may take — which is exactly how `ui/tail.ts` hung on a two-element
   *    cycle while holding `MAX_DEPTH`. Carry a visited set per walk. `MAX_DEPTH`
   *    bounds the indent; it does not bound the graph.
   */
  parentToolCallId?: string | null;
  /**
   * The agent called this call a subagent spawn.
   *
   * What the agent *declared*, and read for exactly one thing: whether a call
   * draws as a delegation. Layout is still decided by children — `ui/tail.ts`
   * nests, counts steps and builds a running headline from those alone, which is
   * the only rule that degrades correctly on an agent that says nothing.
   *
   * Measured 2026-08-01 — claude drops this flag on the spawn's own completing
   * update, so a renderer that merged it last-wins would flicker off at the end
   * of every subagent. `ui/tail.ts` reads it from the `tool_call` and never from
   * an update, which is also why `session.ts` copies only the parent edge onto
   * one: there is deliberately nothing on that side to merge.
   */
  subagent?: boolean;
}

export interface ToolCallUpdateEvent {
  type: "tool_call_update";
  toolCallId: string;
  title: string | null;
  status: ToolCallStatus | null;
  locations: FileLocation[];
  /**
   * The arguments, when the agent filled them in here rather than on the call.
   *
   * Optional in this mirror, and every optional field in this file is optional for
   * the same reason: an older daemon does not send it, and a mirror that declared
   * it required would make `undefined` a lie the compiler helped tell.
   */
  rawInput?: unknown;
  /**
   * What the tool said, as plain text blocks.
   *
   * `null` means the update carried none; `[]` would mean the tool answered with
   * nothing, which is a different thing a client may legitimately say out loud.
   */
  content?: string[] | null;
  /**
   * Images the tool handed back.
   *
   * Optional for the reason every optional here is: an older daemon rendered
   * them as the literal string `[image]` and dropped the bytes. Read as
   * `?? []` — a transcript from such a daemon shows what it always showed.
   */
  images?: StoredFileRef[] | null;
  /**
   * See {@link ToolCallEvent.parentToolCallId} — same field, same three rules.
   *
   * Measured 2026-08-01 against claude-agent-acp 0.63.0: **4 of 10** and **5 of
   * 14** of a child's updates omit this even though its `tool_call` carried it,
   * because the `toolResponse`-bearing updates rebuild their metadata from the
   * tool result and do not re-derive lineage. Absence here therefore means
   * "this update did not say", never "top level".
   */
  parentToolCallId?: string | null;
}

export interface FileChangeEvent {
  type: "file_change";
  path: string;
  /** `null` for a file the agent created — the common case, not an edge case. */
  oldText: string | null;
  newText: string;
  source: "diff" | "fs_write";
  toolCallId: string | null;
}

export interface PermissionRequestEvent {
  type: "permission_request";
  permissionId: string | null;
  toolCallId: string | null;
  title: string;
  options: PermissionOptionSummary[];
  decision: string | null;
}

/**
 * Who settled a parked question — an approval or, now, an elicitation.
 *
 * Named for answers rather than permissions on the daemon side too, and mirrored
 * here under the same name deliberately: this file is hand-written against
 * `src/events.ts` and desynchronizes silently, so a member added there and not
 * here is a `by` string no client renders.
 */
export type AnswerResolvedBy =
  | "client"
  | "agent_withdrew"
  | "agent_gone"
  | "session_stopped"
  | "turn_ended"
  | "pump_failed"
  | "no_turn"
  /** Somebody stopped the turn while this was parked on them. See `cancelTurn`. */
  | "turn_cancelled";

export interface PermissionResolvedEvent {
  type: "permission_resolved";
  permissionId: string;
  toolCallId: string | null;
  title: string;
  outcome: "selected" | "cancelled";
  optionId: string | null;
  by: AnswerResolvedBy;
}

export interface PlanEntry {
  content: string;
  priority: string;
  status: string;
}

export interface PlanEvent {
  type: "plan";
  entries: PlanEntry[];
}

/**
 * One file that rode a prompt.
 *
 * No path and no URL, deliberately: a location is a fact about one daemon's disk
 * and the log outlives it. The download URL is rebuilt from `(sessionId,
 * uploadId)`, which are the two things that do not move.
 */
export interface StoredFileRef {
  uploadId: string;
  name: string;
  mime: string | null;
  bytes: number;
}

export interface PromptAttachmentRef extends StoredFileRef {
  /** Whether the agent got the bytes, or only a link to them. */
  inlined: boolean;
}

export interface PromptEvent {
  type: "prompt";
  text: string;
  /**
   * Optional for the reason every optional in this file is: an older daemon does
   * not send it. Read as `?? []` everywhere, so such a prompt renders exactly as
   * it does today rather than as one with a broken chip.
   */
  attachments?: PromptAttachmentRef[];
}

/** What `POST /sessions/:id/uploads` answers. */
export interface UploadAccepted {
  upload: {
    uploadId: string;
    /** What it was stored as. May be shorter than what was sent. */
    name: string;
    originalName: string;
    mime: string | null;
    bytes: number;
    createdAt: number;
    sessionBytes: number;
    sessionLimit: number;
    sessionCount: number;
    countLimit: number;
  };
}

/**
 * The two upload bounds this client enforces before asking.
 *
 * Mirrored from `src/uploads.ts` like everything else in this file, and they can
 * drift — the daemon is the one that decides, and its refusal is what a chip
 * shows. What these buy is that the common refusals happen at the picker instead
 * of after the whole file has crossed a phone's uplink — which is worth four
 * times what it was, this having been 25 MiB.
 *
 * The per-session byte budget is deliberately **not** here: this client cannot
 * know it across a reload, so tracking it would be wrong more often than useful.
 * Nor is the *rate* budget, for a stronger version of the same reason — it is
 * about the last five minutes of the daemon's life, which a tab that was asleep
 * for four of them cannot have an opinion about. Both arrive as refusals with the
 * daemon's own message.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENTS = 10;

/**
 * What `POST /fs/import` answers with when an archive became a folder.
 *
 * `path` is the whole point of the reply: it is what the picker moves to, so the
 * folder somebody just imported is the one their session starts in without them
 * having to find it in a list.
 */
/**
 * What `PUT`/`DELETE /agent-auth/:agent` answer.
 *
 * `restarting` is how many conversations were relaunched to take the change —
 * secrets reach an agent only at spawn, so a token saved while one is running
 * would otherwise be a change that never arrives. **Optional**: a daemon
 * predating that behaviour omits it, and the client must read its absence as "it
 * did not say" rather than as zero, which is a different and much more alarming
 * sentence.
 */
export interface CredentialWritten {
  saved?: boolean;
  removed?: boolean;
  restarting?: number;
}

export interface ImportAccepted {
  import: {
    path: string;
    name: string;
    entries: number;
    bytes: number;
  };
}

/**
 * How large an archive this client will offer to send.
 *
 * Mirrored from `src/archive.ts`, and **deliberately a different number from
 * `MAX_UPLOAD_BYTES`** at both ends: that one bounds an attachment to a message,
 * this one bounds a whole project arriving. Checking it here only saves somebody
 * pushing a large file over a phone's uplink to be told no — the daemon is still
 * the one that decides.
 */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

/**
 * The longest string answer the daemon will take, mirrored from
 * `MAX_ELICITATION_ANSWER_CHARS` in `src/registry.ts`.
 *
 * Here for the same reason the upload caps are, and for a sharper one: the
 * daemon applies this to **every** string field before it looks at the field's
 * own `maxLength`, and the field the adapter is most likely to leave unbounded is
 * its own free-text "Other" box. So without this the client's `max` check passed,
 * `canSubmit` said yes, and the POST came back `400 invalid_content` — which is
 * exactly the failure `canSend` exists to prevent one screen over, and which
 * `elicitation.ts` claims in its own docblock cannot happen because the value
 * enabling the button *is* the value being sent.
 */
export const MAX_ANSWER_CHARS = 2048;

export interface StatusEvent {
  type: "status";
  status: SessionStatus;
  exit: SessionExit | null;
}

export type PlainReason = "not_requested" | "not_a_repo" | "unborn_head" | "git_missing";

export interface WorkspaceEvent {
  type: "workspace";
  mode: "worktree" | "plain";
  root: string;
  requestedCwd: string;
  branch: string | null;
  baseCommit: string | null;
  plainReason: PlainReason | null;
  warnings: { code: string; message: string }[];
}

export interface TurnEndEvent {
  type: "turn_end";
  /**
   * ACP's own reason, or the daemon's `agent_error` for a turn that ended in an
   * `error` — see `TurnStopReason` in `src/events.ts`.
   *
   * `string` rather than the union on purpose, and this is the field the rule was
   * written for: a daemon newer than this client sends a member nobody here has
   * heard of, and `stopReasonText` answers the identifier with its underscores
   * taken out rather than nothing. Widening the daemon's union is therefore not a
   * breaking change in this direction.
   */
  stopReason: string;
  usage: unknown;
}

/**
 * The agent's memory was reset, and this is where.
 *
 * The transcript above it is untouched and still readable: it is the daemon's
 * log rather than the agent's memory. What changed is that the agent past this
 * point knows none of it, which without the marker reads as a conversation that
 * inexplicably forgot itself.
 */
export interface ContextClearedEvent {
  type: "context_cleared";
  agentSessionId: string;
  previousAgentSessionId: string;
}

export interface AgentLogEvent {
  type: "agent_log";
  line: string;
}

export interface OtherUpdateEvent {
  type: "other";
  sessionUpdate: string;
  raw: unknown;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  data: unknown;
}

export type SessionEvent =
  | SessionStartedEvent
  | AgentConfigEvent
  | TextEvent
  | ToolCallEvent
  | ToolCallUpdateEvent
  | FileChangeEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | ElicitationRequestEvent
  | ElicitationResolvedEvent
  | PlanEvent
  | PromptEvent
  | StatusEvent
  | WorkspaceEvent
  | TurnEndEvent
  | AgentLogEvent
  | ContextClearedEvent
  | OtherUpdateEvent
  | ErrorEvent;

export interface StoredEvent {
  readonly seq: number;
  readonly ts: number;
  readonly event: SessionEvent;
}

/* ------------------------------------------------------------------ *
 * Sessions — src/registry.ts
 * ------------------------------------------------------------------ */

/**
 * Derived on the daemon on every read, never stored.
 *
 * `blocked` outranks `running` there, deliberately: it is the state a human has
 * to act on, and this whole UI is arranged around that one fact.
 */
export type SessionStatus =
  | "starting"
  | "idle"
  | "running"
  | "blocked"
  | "stopping"
  | "exited"
  | "failed"
  | "interrupted";

export const TERMINAL_STATUSES: readonly SessionStatus[] = ["exited", "failed", "interrupted"];

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * The statuses in which an agent process exists and can be asked something.
 *
 * The daemon's own derivation restated: `status` is `starting` while
 * `this.session === null`, `stopping` while the agent is being torn down, and
 * terminal after. So these three are exactly "there is something on the other
 * end", which is the question every answer about the agent's *controls* turns on.
 *
 * **`stopping` is excluded and that is load-bearing.** `doStop` touches — and
 * therefore fans a snapshot out to every attached client — both before and after
 * it empties `agentConfigState`, so a frame can legitimately arrive reading
 * `stopping` with no controls on it. Counting that as a live agent saying "I have
 * none" would throw away the memory this predicate exists to protect, on exactly
 * the path it exists for.
 */
export const AGENT_LIVE_STATUSES: readonly SessionStatus[] = ["idle", "running", "blocked"];

export function hasLiveAgent(status: SessionStatus): boolean {
  return AGENT_LIVE_STATUSES.includes(status);
}

export type ExitReason =
  | "stopped"
  | "agent_exited"
  | "start_failed"
  | "start_timeout"
  | "daemon_shutdown"
  /** Legacy. The daemon no longer writes it; rows on disk still carry it. */
  | "agent_kill_failed"
  | "daemon_restarted"
  /**
   * The daemon took the agent away to reopen its conversation with something
   * different asked of it, and is bringing it straight back — today, a change to
   * claude's `ultracode`, which is read when a conversation is opened and has no
   * live channel.
   */
  | "config_changed"
  /**
   * Somebody signed this agent out, so the daemon ended its conversations.
   *
   * A person's decision, exactly like `stopped`, so it is deliberately **not** a
   * daemon exit: nothing brings these back on its own. Signing in again does,
   * because that is the same person reversing it.
   */
  | "agent_signed_out";

/**
 * The exits that mean the daemon went away rather than that anybody decided.
 *
 * Mirrored from `src/events.ts` by hand, like everything else in this file, and
 * this one is worth the copy rather than being re-derived from `status`: it is
 * the rule the whole "a session reads as stopped only when you pressed Stop"
 * behaviour turns on, and the daemon uses the identical function to decide which
 * sessions it brings back.
 *
 * The exhaustive list, and why each of the other five is out: `stopped` is a
 * human's decision — the point. `start_failed`/`start_timeout` never had a
 * conversation. `agent_exited` is the agent quitting under a daemon that never
 * went anywhere, so the *daemon* did not end it. `agent_kill_failed` is legacy
 * and ambiguous.
 *
 * **A copy is only worth having while it is the same copy**, and this one was
 * wrong for exactly one release: `config_changed` was added to `src/events.ts`
 * and not here, so a session the daemon was restarting on purpose answered
 * `showsAsEnded` — which used to take the composer off the screen, the one thing that
 * partition is supposed to make impossible for a session that is coming back.
 * `webcheck` now reads `src/events.ts` off disk and compares the two lists rather
 * than trusting the next person to remember.
 */
export const DAEMON_EXIT_REASONS: readonly ExitReason[] = [
  "daemon_restarted",
  "daemon_shutdown",
  "config_changed",
];

/**
 * The other half of the same partition: reasons a session is **not** coming back.
 *
 * Written out rather than derived, because it is what `endedWithDaemon` actually
 * tests — and the direction of that test is the whole point. `webcheck` asserts
 * the two lists partition the daemon's union, so this one cannot silently fall
 * behind either.
 */
export const FINAL_EXIT_REASONS: readonly ExitReason[] = [
  "stopped",
  "agent_exited",
  "start_failed",
  "start_timeout",
  "agent_kill_failed",
  /*
   * Final, because nothing brings it back on its own — the daemon's
   * `autoResumable` answers `false` for it by name. Signing in again does, and
   * that is a person acting rather than the session "coming back", which is the
   * distinction this list is about.
   */
  "agent_signed_out",
];

/**
 * Did the *daemon* end this session, meaning it is coming back?
 *
 * ⚠ **Asked as "not final" rather than "is a daemon reason", and the inversion is
 * the entire safety property.** This used to be
 * `DAEMON_EXIT_REASONS.includes(exit.reason)`, so a reason the client had never
 * heard of answered `false` — the session fell out of `waitingForDaemon` into
 * `showsAsEnded`, which `Composer.tsx` used to early-return on, **taking the
 * composer off the screen for a conversation that is coming back**.
 *
 * `webcheck` compares both lists against `src/events.ts` off disk, which catches
 * that at build time — and cannot catch it at *runtime*, which is the case that
 * actually happens. `packages/web` ships inside the control plane's image, so a
 * weekly deploy hands a new client to everybody; a daemon is updated whenever its
 * owner gets to it, and a tab is reloaded whenever its owner gets to *that*. A
 * tab older than the daemon it is pointed at is therefore ordinary, not exotic,
 * and the exit reason is the one field where being behind was destructive.
 *
 * Read this way an unknown reason reads as "the daemon took it away", which is
 * wrong in the harmless direction: the row stays in Active with a composer on it,
 * and a send against a session that really did end answers an error the client
 * already draws. The other direction is a live session somebody cannot type into
 * with nothing on screen explaining why.
 */
export function endedWithDaemon(exit: { reason: ExitReason } | null | undefined): boolean {
  if (exit === null || exit === undefined) return false;
  return !FINAL_EXIT_REASONS.includes(exit.reason);
}

/**
 * What the daemon's own resume pass is doing about a session.
 *
 * **Absent means "waiting", never "failed".** An older daemon sends nothing here
 * and never resumes anything, so reading absence as failure would put a red
 * banner on every ended session in the fleet; reading it as waiting is quietly
 * wrong about sessions that are not coming back, which is much the better
 * direction to be wrong in.
 */
export interface SessionResumeState {
  state: "waiting" | "running" | "failed";
  attempts: number;
  error: { code: string; message: string } | null;
  at: number;
}

/**
 * How the daemon last knew the agent, and how it would signal it.
 *
 * A one-arm union rather than a bare `number`, and the shape is kept rather than
 * flattened: the daemon's `toHandle` still has to answer "no handle at all",
 * which is a different fact from "pid 0". Nothing here renders it; it is
 * mirrored so the shape stays honest.
 *
 * Rows written by the multi-tenant daemon can still carry a `container` arm on
 * disk. Nothing produces one now and nothing here has to read it — the daemon
 * reports such a handle as one it will not signal.
 */
export type AgentHandle = { kind: "local"; pid: number };

export interface SessionExit {
  reason: ExitReason;
  detail: string | null;
  at: number;
  agentHandle: AgentHandle | null;
  /** `false` means "probably orphaned", which is worth saying out loud. */
  agentConfirmedDead: boolean;
}

export interface SessionWorkspace {
  mode: "worktree" | "plain";
  /** Where the agent actually runs. For a worktree session this is ephemeral. */
  root: string;
  /** What the human asked for. This is the one to show a human. */
  requestedCwd: string;
  git: {
    repoRoot: string;
    commonDir: string;
    branch: string | null;
    createdBranch: boolean;
    baseCommit: string;
  } | null;
  plainReason: PlainReason | null;
  createdAt: number;
}

export interface PendingPermissionSnapshot {
  permissionId: string;
  /** Still the join key back to the `tool_call`, used as a fallback. */
  toolCallId: string | null;
  title: string;
  options: PermissionOptionSummary[];
  raisedAt: number;
  /**
   * The tool's arguments as sent with the request, bounded to 8 KiB.
   *
   * Usually the only copy: kimi emits its `tool_call` event with `rawInput: null`
   * and the command appears for the first time on the permission request. May be
   * the `{truncated: true, bytes}` stand-in.
   */
  rawInput: unknown;
  /** ACP content blocks — where an edit's diff lives. Bounded the same way. */
  content: unknown;
}

/**
 * A question the agent is waiting on.
 *
 * **The form is not here**, and that is the difference from a pending permission
 * rather than an oversight. A permission earns its 8 KiB on this record because a
 * blocked session has to be answerable *from the list*; a question is not — you
 * have to read the form and fill it in. So the snapshot says only that one is
 * waiting, and `GET /sessions/:id/elicitations/:id` serves the fields when a card
 * opens. Same arrangement the command list has, for the same reason.
 */
export interface PendingElicitationSnapshot {
  elicitationId: string;
  toolCallId: string | null;
  /** The agent's prompt. The one string a list row draws. */
  message: string;
  /** Enough to size a skeleton while the form is in flight. Nothing decides on it. */
  fieldCount: number;
  raisedAt: number;
}

/** One choice on a form field, already normalized by the daemon. */
export interface ElicitationOption {
  value: string;
  label: string;
  description: string | null;
}

/**
 * One field of a form, as the daemon projected it.
 *
 * Projected there rather than here: the raw ACP schema is an open union of
 * JSON-Schema fragments, and the daemon has to validate the reply against
 * something — validating against anything but what the client was shown would
 * refuse answers it invited. `pattern` is deliberately absent all the way down;
 * running an agent-chosen regex is a hazard wherever it happens.
 */
export interface ElicitationField {
  key: string;
  kind: "string" | "number" | "integer" | "boolean" | "multi_select";
  title: string | null;
  description: string | null;
  required: boolean;
  options: ElicitationOption[] | null;
  min: number | null;
  max: number | null;
  format: "email" | "uri" | "date" | "date-time" | null;
  default: string | number | boolean | string[] | null;
}

export interface ElicitationRequestEvent {
  type: "elicitation_request";
  elicitationId: string;
  toolCallId: string | null;
  message: string;
}

/** One answer, already rendered by the daemon so no client has to join. */
export interface ElicitationAnswerSummary {
  key: string;
  label: string;
  value: string;
}

export interface ElicitationResolvedEvent {
  type: "elicitation_resolved";
  elicitationId: string;
  toolCallId: string | null;
  message: string;
  action: "accept" | "decline" | "cancel";
  /** `null` for decline and cancel, which answer *about* the form, not within it. */
  answers: ElicitationAnswerSummary[] | null;
  by: AnswerResolvedBy;
}

export interface SessionSnapshot {
  id: string;
  agent: AgentId;
  /**
   * The assembled agent this session was started as, or `null` for a bare
   * harness.
   *
   * ⚠ **An id and nothing else** — not the name, not the system, not the model.
   * Those belong to the preset, which can be edited, and a copy riding a
   * snapshot fanned out per client on every output token is a copy that goes
   * stale exactly where it would be read. This is the join key into
   * `GET /custom-agents`, which the strip already fetches.
   *
   * Optional for this file's usual reason: a daemon older than this feature
   * sends nothing, and `undefined` reads the same as `null` at every call site.
   */
  customAgent?: string | null;
  cwd: string;
  workspace: SessionWorkspace;
  status: SessionStatus;
  agentSessionId: string | null;
  agentHandle: AgentHandle | null;
  turn: number | null;
  turnStartedAt: number | null;
  /**
   * When somebody asked this turn to stop, or `null`.
   *
   * Optional for the reason `pendingElicitations` is: an older daemon does not
   * send it. Every reader goes through {@link cancelInFlight}, which is where the
   * `?? null` lives, so `undefined` means "that daemon cannot say" and reads as no
   * cancel outstanding — the state the control was in before any of this existed.
   */
  cancelRequestedAt?: number | null;
  /** Not `lastActivity`, not `updatedAt`. The daemon calls it this. */
  lastEventAt: number | null;
  createdAt: number;
  firstSeq: number;
  lastSeq: number;
  dropped: number;
  pendingPermissions: PendingPermissionSnapshot[];
  /**
   * Questions the agent is waiting on.
   *
   * Optional because an older daemon does not send it, and every reader goes
   * through {@link humanRequests} rather than touching it — which is what makes
   * `undefined` behave as `[]` in one place instead of nine.
   */
  pendingElicitations?: PendingElicitationSnapshot[];
  exit: SessionExit | null;
  /**
   * The agent's controls, on the snapshot rather than only in the log.
   *
   * Load-bearing: the controls are state with one current version, and the log
   * evicts a prefix — and a *restored* session has no live agent to have published
   * them, so there may be nothing in the transcript to fold. Optional here because
   * an older daemon does not send it.
   */
  agentConfig?: AgentConfig;
  /**
   * Moves whenever the agent republishes its command list. `0` means it never has.
   *
   * The list itself is behind `GET /sessions/:id/commands` and deliberately not
   * here: this record arrives for every session on every poll, and a command list
   * is only wanted inside one composer. This is the number that says when to go
   * and fetch it.
   *
   * **Refetch on `!==`, never on `>`.** A daemon restart puts this back to 0 while
   * a client still holds 5, and the right response is to drop the cached list —
   * the agent that published it is gone — not to conclude the daemon is behind.
   * `undefined` (an older daemon) collapses to "no commands", the same as `0`.
   */
  commandsRevision?: number;
  /**
   * How full the model's context window is.
   *
   * `null` is a real answer — "cannot tell" — and `undefined` (an older daemon) is
   * the same one, which is why the two collapse rather than being told apart. Kimi
   * may never report it, and a restored session has no live agent to ask.
   *
   * `size` is 0 for "the agent reported occupancy but not a window". Nothing may
   * divide by it and nothing may substitute a default: a percentage of a made-up
   * denominator is a number somebody would plan around.
   */
  contextUsage?: { used: number; size: number; cost: { amount: number; currency: string } | null } | null;
  /**
   * What this session is called, or `null` if nobody has named it.
   *
   * Never `""` — the daemon distinguishes "never named" from "named", and a client
   * needs that to know whether to draw its own fallback.
   */
  title?: string | null;
  /** Kept at the top of its group, and never dropped by a `?limit=` cut. */
  pinned?: boolean;
  /** Absent on an older daemon, and on every session it has no reason to resume. */
  resume?: SessionResumeState;
}

/**
 * Resumable is not a field on the snapshot — it is derived, here, from the two
 * that are. A terminal session that still holds the agent's own session id can be
 * put back on the same conversation.
 *
 * Still the question the manual Resume affordance asks, and deliberately wider
 * than the four below: a session somebody stopped on purpose is resumable, it
 * just is not one the daemon brings back on its own.
 */
export function isResumable(session: SessionSnapshot): boolean {
  return isTerminal(session.status) && session.agentSessionId !== null;
}

/*
 * How a terminal session is presented, in four pure functions.
 *
 * The property that makes them assertable, and that `webcheck` states directly:
 * **for any terminal session exactly one of `waitingForDaemon`, `resumeStalled`
 * and `showsAsEnded` is true, and for a live session none of them is.** They are
 * a partition, not three independent tests, which is why they are written here
 * together rather than inlined at the three call sites that need them.
 *
 * Every one of them keys on `exit.reason` and never on `status` alone. That is
 * the whole correction: `daemon_shutdown` — the ordinary deploy — used to derive
 * `exited`, and a client that asked `status === "interrupted"` would have been
 * right about a hard kill and wrong about every graceful restart there has ever
 * been. The daemon derives `interrupted` from the same predicate now, so the two
 * agree, but agreeing by construction is better than agreeing by coincidence.
 */

/** The daemon ended it and is bringing it back. Draw it as ordinary. */
export function waitingForDaemon(session: SessionSnapshot): boolean {
  if (!isTerminal(session.status) || !endedWithDaemon(session.exit)) return false;
  return session.agentSessionId !== null && session.resume?.state !== "failed";
}

/**
 * The daemon ended it and cannot bring it back. A human has to do something.
 *
 * `agentSessionId === null` lands here rather than in `showsAsEnded` on purpose:
 * the daemon still went away underneath somebody, and saying "ended" about it
 * would be answering a question they did not ask. There is simply nothing to
 * reattach to, which is what the copy says.
 */
export function resumeStalled(session: SessionSnapshot): boolean {
  if (!isTerminal(session.status) || !endedWithDaemon(session.exit)) return false;
  return session.resume?.state === "failed" || session.agentSessionId === null;
}

/** It is over, and somebody meant it. The only case that loses its composer. */
export function showsAsEnded(session: SessionSnapshot): boolean {
  return isTerminal(session.status) && !waitingForDaemon(session) && !resumeStalled(session);
}

/**
 * The agent is working on your behalf, and nothing is waiting on you.
 *
 * Three clauses, and each is a state the other two get wrong:
 *
 *   `turn !== null`             — the field the composer already reads, so the
 *                                 placeholder and the transcript's indicator
 *                                 cannot disagree about the same moment.
 *   `!needsHuman(session)`      — a permission *or a question* is raised
 *                                 **mid-turn**, so `turn` stays set while the
 *                                 agent is in fact waiting on a human. Saying
 *                                 "working" there is simply false, and the card
 *                                 two rows down says the opposite at full size.
 *   `!isTerminal(status)`       — `turn` is cleared in a `finally`, which a daemon
 *                                 that dies mid-turn never reaches. A restored row
 *                                 must not blink for ever.
 *
 * The daemon's own `status === "running"` derivation, restated from the fields the
 * snapshot carries — blocked beats running, terminal beats both — so the two agree
 * by construction rather than by coincidence, which is what the note above this
 * block of predicates asks for.
 */
export function showsWorking(session: SessionSnapshot): boolean {
  return session.turn !== null && !needsHuman(session) && !isTerminal(session.status);
}

/**
 * Whether anything this session started could still report back.
 *
 * The gate on the transcript's "waiting for N tasks" line, and it is a **sibling**
 * of `showsWorking` rather than a widening of it. Widening that one would have been
 * the natural-looking move and it is the trap: `showsWorking` is what refuses Send
 * (`Composer`'s `sendRefused`), so a session whose only way out is sending a message
 * would have had the control taken away in exactly the state the defect was reported
 * from. `canCancelTurn` must not follow it either — there is no turn, so `POST
 * /sessions/:id/cancel` answers `no_turn`, and an armed Stop there is a control that
 * provably does nothing.
 *
 * It deliberately **does not read `turn`**. That clause going false at `turn_end` is
 * the entire reason the line exists: the delegations are events in the log and
 * outlive the turn that started them.
 *
 * Two exclusions, both of them states in which a spawn can never complete:
 *
 *   terminal — the agent is gone, the interrupted turn is deliberately not re-sent,
 *     so every call it left `pending` stays that way. Without this, an ended session
 *     that once delegated reads "waiting for 1 task" for ever.
 *   `stopping` — somebody stopped the turn and the delegation is being killed rather
 *     than awaited. Not covered by `isTerminal`, for the reason `canCancelTurn`
 *     spells out one block down: `{status: "stopping", turn: 5}` persists for
 *     seconds.
 *
 * A **blocked** session still draws it, deliberately. The ask card is an `absolute`
 * region over the composer and does not collide with the transcript's foot, and
 * suppressing would blink the line out and back on every approval.
 *
 * ⚠ **This is half the gate, and it is the half that cannot see the permanent
 * case.** The terminal exclusion above closes only the arm that already resolves
 * itself: auto-resume takes the session back *out* of terminal, so it returns
 * `idle`, holding the same conversation and the same rows a dead agent left
 * `pending` — and every one of those clauses then reads true. No fact about
 * `status` can tell that apart from an agent legitimately working after
 * `turn_end`, because by the time anybody reads one the status is the honest
 * `idle`. What separates them is *which agent process* started the call, which is
 * a fact about the transcript: see `Tail.taskFloor`, the other half, which
 * `EventList` applies beside this one.
 */
export function mayStillReport(session: SessionSnapshot): boolean {
  return !isTerminal(session.status) && session.status !== "stopping";
}

/**
 * There is a turn to stop, so the composer offers a way to stop it.
 *
 * Deliberately **wider than `showsWorking`** by exactly the blocked case, and
 * that difference is the point. A session parked on a question is one where a
 * person has already decided they want out often enough that answering the
 * question is beside the point — and the daemon takes the cancel there, sweeping
 * whatever is parked, so a control drawn on `showsWorking` alone would be missing
 * from the state it is most wanted in. The two predicates are `turn !== null &&
 * !isTerminal` with and without `!needsHuman`, which is why this is written from
 * the same fields rather than as `showsWorking(s) || needsHuman(s)`: that form
 * reads as an afterthought bolted on, and it is the base rule.
 *
 * It matches `POST /sessions/:id/cancel` answering `cancelled` rather than
 * `no_turn`, and not the button's *enabled* state — see {@link cancelInFlight},
 * which is a different question with a different answer.
 *
 * **`stopping` is excluded, and it is not covered by `isTerminal`.** The daemon
 * refuses on `terminal || stopRequested`, and `stopRequested` shows on the wire
 * as exactly this status — a live, non-terminal one with its own dot. It is not a
 * moment either: `turn` is cleared in `pump`'s `finally`, which cannot run until
 * the prompt generator unwinds inside `dispose()`, i.e. after a 5s cancel grace
 * and a 2s close. So a session somebody stopped mid-turn spends *seconds*
 * carrying `{status: "stopping", turn: 5}`, and a predicate reading `isTerminal`
 * alone drew an armed Stop across all of it, onto a guaranteed `409
 * session_terminal` and a red toast about a session that is already stopping.
 */
export function canCancelTurn(session: SessionSnapshot): boolean {
  return session.turn !== null && !isTerminal(session.status) && session.status !== "stopping";
}

/**
 * A change that restarts the agent would be refused right now.
 *
 * The daemon's own gate, read from the field it gates on: `setConfigOption` in
 * `registry.ts` answers `turn_in_flight` on `this.turn !== null`, and the route
 * turns that into `409`. One control needs the agent restarted to take effect —
 * ultracode — and this is what lets its row say so before the tap instead of
 * after it. Q3.429.
 *
 * **Deliberately neither of the two predicates that already read this field.**
 * `showsWorking` carries `!needsHuman`, so it goes false while a permission is
 * parked — and a parked request keeps the turn open, so a warning drawn off it
 * would go silent in one of the two states the daemon still refuses in.
 * `canCancelTurn` additionally drops `stopping` and terminal, which this does not
 * need to exclude and must not: there the daemon answers `session_terminal`
 * instead, a refusal that is *not* suppressed, and the strip is drawn `stale`
 * ahead of it anyway.
 */
export function turnInFlight(session: SessionSnapshot): boolean {
  return session.turn !== null;
}

/**
 * Somebody has asked this turn to stop and the agent has not finished.
 *
 * Both clauses, because the daemon clears the pair together and a client reading
 * `cancelRequestedAt` alone would be trusting a field an older daemon does not
 * send at all — `?? null` is the whole migration, and it degrades to "no cancel
 * has been asked for", which is the honest reading of a snapshot that cannot say.
 *
 * What it is for is the *second* tap. The button must not spring back to an armed
 * Stop the moment the request returns, because the turn very often outlives the
 * answer — an agent mid-tool-call notices a cancel when it next looks — and a
 * control that looks untouched is one somebody presses again.
 */
export function cancelInFlight(session: SessionSnapshot): boolean {
  return (session.cancelRequestedAt ?? null) !== null && canCancelTurn(session);
}

/**
 * Something the agent is waiting on a person for — an approval, or a question.
 *
 * One shape for both, and `title` is whichever string a row should draw, so
 * nothing downstream branches on the kind just to find a label.
 */
export type HumanRequest =
  | { kind: "permission"; raisedAt: number; title: string; permission: PendingPermissionSnapshot }
  | { kind: "elicitation"; raisedAt: number; title: string; elicitation: PendingElicitationSnapshot };

/**
 * Everything waiting on a person here, oldest first.
 *
 * **This function exists so that the other nine places do not.** Every count,
 * sort, badge, dot and placeholder in this client was written against
 * `pendingPermissions.length` — nine call sites across five files — and a second
 * array beside it would have meant nine separate decisions about whether a
 * question counts. It is one decision, here.
 *
 * Oldest first because that is the order `sessionLists` sorts blocked rows in and
 * the order `SessionView` picks which card to draw: the thing that has been
 * waiting longest leads, and a permission does not win by being the older
 * feature.
 *
 * `pendingElicitations` is optional on the wire, so this is also the single place
 * an older daemon's `undefined` becomes `[]`.
 */
export function humanRequests(session: SessionSnapshot): HumanRequest[] {
  const requests: HumanRequest[] = [];
  for (const permission of session.pendingPermissions) {
    requests.push({
      kind: "permission",
      raisedAt: permission.raisedAt,
      title: permission.title,
      permission,
    });
  }
  for (const elicitation of session.pendingElicitations ?? []) {
    requests.push({
      kind: "elicitation",
      raisedAt: elicitation.raisedAt,
      title: elicitation.message,
      elicitation,
    });
  }
  return requests.sort((a, b) => a.raisedAt - b.raisedAt);
}

/** Whether anything is waiting on a person. Replaces `pendingPermissions.length > 0`. */
export function needsHuman(session: SessionSnapshot): boolean {
  return session.pendingPermissions.length + (session.pendingElicitations?.length ?? 0) > 0;
}

/** How many. Replaces `pendingPermissions.length`. */
export function waitingCount(session: SessionSnapshot): number {
  return session.pendingPermissions.length + (session.pendingElicitations?.length ?? 0);
}

/**
 * When the longest wait began, for the blocked sort.
 *
 * `Infinity` when nothing waits, so a caller can `Math.min` over rows without a
 * null check — which is what `sessionLists` was already hand-rolling a fold for.
 */
export function oldestWait(session: SessionSnapshot): number {
  let oldest = Infinity;
  for (const permission of session.pendingPermissions) {
    if (permission.raisedAt < oldest) oldest = permission.raisedAt;
  }
  for (const elicitation of session.pendingElicitations ?? []) {
    if (elicitation.raisedAt < oldest) oldest = elicitation.raisedAt;
  }
  return oldest;
}

/**
 * Whether this counts toward "how much is happening on this machine".
 *
 * Deliberately not the same question as which list it belongs in. A stalled row
 * belongs in Active — somebody has to act on it — but must not inflate a count
 * drawn beside a green dot, because nothing is running.
 */
export function countsAsLive(session: SessionSnapshot): boolean {
  return !isTerminal(session.status) || waitingForDaemon(session);
}

/* ------------------------------------------------------------------ *
 * Stream frames — src/server.ts, StreamConnection
 * ------------------------------------------------------------------ */

export interface HelloFrame {
  type: "hello";
  /** Changes when the daemon restarted. Non-fatal: seqs are durable on disk. */
  instanceId: string;
  session: SessionSnapshot;
  firstSeq: number;
  lastSeq: number;
  since: number;
  gap: boolean;
}

export interface EventsFrame {
  type: "events";
  events: StoredEvent[];
}

export interface SnapshotFrame {
  type: "snapshot";
  session: SessionSnapshot;
}

export interface CaughtUpFrame {
  type: "caught_up";
  seq: number;
}

/**
 * `from`/`to` are inclusive. Advance the cursor to `to`.
 *
 * **Three reasons, and only two of them are losses.** Reading them as one thing is
 * how a client draws a warning about a conversation that is perfectly intact.
 *
 *   `evicted`       — the daemon destroyed these. Since the per-session retention
 *                     window was removed it can only be a session an *older*
 *                     daemon truncated: the floors live on the session row and
 *                     survive, so those go on saying so honestly rather than
 *                     pretending to be whole. Gone for good.
 *   `slow_consumer` — this client could not keep up and the daemon dropped frames
 *                     rather than buffer without bound. Gone from this socket;
 *                     still on disk, so a page would recover them.
 *   `backlog`       — **not a loss.** The attach declined to replay this far
 *                     (`ATTACH_REPLAY_MAX` in `server.ts`), because a socket is a
 *                     live channel and draining an arbitrary amount of history
 *                     into it in one synchronous block is what the collapse path
 *                     exists to stop. Every one of these events is on disk and
 *                     `GET /sessions/:id/events` serves it. The correct response
 *                     is to page, and never to draw a hole.
 */
export interface LaggedFrame {
  type: "lagged";
  from: number;
  to: number;
  dropped: number;
  reason: "evicted" | "slow_consumer" | "backlog";
}

export interface ErrorFrame {
  type: "error";
  code: string;
  message: string;
}

export type StreamFrame = HelloFrame | EventsFrame | SnapshotFrame | CaughtUpFrame | LaggedFrame | ErrorFrame;

/* ------------------------------------------------------------------ *
 * HTTP payloads
 * ------------------------------------------------------------------ */

/**
 * Liveness and a clock, and deliberately nothing else.
 *
 * It used to carry per-status session counts and how long the oldest blocked
 * session had been waiting. Those went when the daemon became multi-tenant: this
 * is its one unauthenticated route, and across tenants those numbers are a
 * readout of other people's work to anyone who can reach the port. Nothing here
 * ever read them — the list comes from `GET /sessions`, per machine.
 */
export interface DaemonHealth {
  ok: boolean;
  instanceId: string;
  startedAt: number;
  uptimeMs: number;
  shuttingDown: boolean;
  time: number;
  authMode: "shared_secret" | "signed" | "both";
  /**
   * What build the daemon is, and what tunnel protocol it speaks.
   *
   * Optional for this file's usual reason — a daemon older than these fields
   * sends neither — and that absence is itself the useful answer: it means the
   * machine is running something from before daemons reported a version at all.
   *
   * ⚠ **A label, not a gate.** Nothing in this client may branch on `version`.
   * The reason is the whole shape of this project's releases: `packages/web`
   * ships inside the control plane's image, so a weekly deploy hands every
   * browser a client newer than most daemons in the fleet, and a client that
   * behaves differently per daemon build would put every one of them back in
   * lockstep with the control plane. What a client is allowed to do with it is
   * *show* it — "this machine is on 0.1.0" is an operator's answer to why
   * something looks different — and what it must keep doing is what this file
   * already does everywhere else: read each field optionally and degrade.
   */
  version?: string;
  protocol?: number;
}

export interface AgentInfo {
  id: AgentId;
  displayName: string;
  available: boolean;
  /** The install or auth instruction when unavailable. Render it. */
  hint: string | null;
  /**
   * Whether the agent is authenticated, with `null` for "could not tell".
   *
   * Three answers, not two. `available` only ever meant "the binary is on PATH",
   * so a logged-out agent reported `true` and the person found out at
   * `502 agent_auth_required` after a container start and a worktree. Only some
   * agents can answer this non-interactively (claude can, kimi cannot), and
   * showing `null` as "logged out" would put a login wizard in front of somebody
   * whose agent works. Absent on an older daemon, which is the same as `null`.
   *
   * ⚠ **A harness with no sign-in can never answer `false` here**, however often
   * it has refused to start — that record is {@link AgentInfo.lastStartRefusal},
   * which is a different question and has a different reader.
   */
  loggedIn?: boolean | null;
  /**
   * The last time this harness refused to open a session, and what it said.
   *
   * ⚠ **An observation, and deliberately not a credential fact.** ACP's
   * `auth_required` is answered by the *adapter*, and the daemon has measured the
   * two disagreeing — a key the model's API accepted while the adapter went on
   * refusing `session/new`. So this says "it would not start, at this time,
   * configured this way" and claims nothing about a key. The daemon ages it out;
   * a value on the wire is always live.
   *
   * `routed` is what stops one refusal condemning a pairing it never tested: a
   * bare start refusing says nothing about one that runs on a system's own saved
   * key, which is the signed-out Claude Code on OpenRouter this app documents as
   * working. Only a refusal measured *while routed* is evidence about a preset.
   *
   * Absent on an older daemon, which is the same as `null`: nothing observed.
   */
  lastStartRefusal?: { at: number; routed: boolean; message: string } | null;
  /**
   * Whether a sign-in can be driven here, and why not when it cannot.
   *
   * ⚠ **On `GET /agents` as well as `GET /agent-auth`, because it answers a
   * question the two fields above cannot.** An agent that has no sign-in at all
   * reports `loggedIn: null` — there is nothing to probe — which is
   * indistinguishable from a probe that failed, and every screen that picks an
   * agent reads this cheap route. `blocked === "no_flow"` is the one member that
   * is a fact about the *agent*; the other three are the host's.
   *
   * Absent on an older daemon, and its absence must read as "an ordinary agent":
   * fall back to `AgentAuthListing.loginSupported`, which is exactly what this
   * client did before the field existed.
   */
  login?: AgentLoginSupport;
  /**
   * What a screen calls this harness, or absent for one this product ships.
   *
   * ⚠ **Deliberately not {@link AgentInfo.displayName}, and reaching for that
   * instead is the mistake this field exists to prevent.** The daemon's
   * `displayName` is a log line and a settings-list row title — literally
   * `Claude (claude-agent-acp)` and `Kimi Code CLI` — while `agentCard.ts`'s own
   * rule is that a label names neither a package nor a CLI, because it is drawn on
   * a 96px tile. Two of the four built-ins fail that rule outright, so a client
   * that used `displayName` as a label would put "Codex (codex-acp)" on a strip.
   *
   * Absent for a built-in, where `AGENT_LABEL` is the answer and is hand-written
   * on purpose. Read through `harnessName`, never directly.
   */
  label?: string;
  /*
   * `standalone` used to ride here and is gone on both sides: a plugin adds a
   * harness, never an agent. `startsBare` answers `false` for every contributed id
   * now, so a daemon that still sends the field is simply not read — which is the
   * same direction its own fallback took, made unconditional.
   */
  /**
   * The plugin that added this harness, or absent for one this product ships.
   *
   * Three screens need it and none of them could work it out: the subline under a
   * tile that is native to no provider, the sentence saying where to go to remove
   * it, and what a refusal names when the plugin is switched off.
   */
  contributedBy?: { pluginId: string; pluginName: string };
}

/** One environment variable an agent reads a pasted credential from. */
export interface AgentCredentialSlot {
  envName: string;
  set: boolean;
  updatedAt: number | null;
}

/**
 * Whether *this* agent's login can be driven here, and what its flow needs.
 *
 * Beside `AgentAuthListing.loginSupported` rather than replacing it, and it
 * carries the two facts that daemon-wide boolean cannot. `supported` folds in
 * whether the agent's own CLI resolved — a different binary from the adapter,
 * and claude's ships inside an SDK package with no `bin` entry — which used to
 * surface only as a `503` after the button was tapped. `needsInput` is whether
 * anything is typed back: claude's flow waits on a paste prompt, the other two
 * are device-code flows whose box was never used.
 *
 * Optional: an older daemon sends neither, and the fallbacks are the listing's
 * own `loginSupported` and "assume there is an input box", i.e. exactly what
 * this client did before.
 */
export interface AgentLoginSupport {
  supported: boolean;
  /**
   * Why the wizard cannot run, when it cannot. Optional: an older daemon omits it.
   *
   * Read as a *narrowing*, never as a gate — `supported` is still what decides
   * whether the button is drawn. An unknown value degrades to "no specific advice"
   * rather than throwing, which is this file's whole contract.
   */
  blocked?: "no_flow" | "no_script" | "no_cli" | "interactive_pty" | null;
  needsInput: boolean;
  /** Whether the agent's CLI has a sign-out verb. kimi has none. */
  canSignOut?: boolean;
}

export interface AgentAuthInfo extends AgentInfo {
  credentials: AgentCredentialSlot[];
}

export interface AgentAuthListing {
  /**
   * The daemon's own platform, as `process.platform`. Absent on an older daemon.
   *
   * Used for **one** thing: naming the system in the sentence that explains why a
   * sign-in wizard cannot run. Never a gate — `login.blocked` decides that — for
   * the reason `wire.ts` gives about every narrowing in it.
   */
  os?: string;
  /**
   * Whether this daemon's runtime will drive an interactive login at all.
   *
   * Reported rather than inferred from anything else: a host without `script`
   * has no pty to allocate, and a client that guessed would offer a wizard that
   * answers 503. Superseded per agent by `AgentAuthInfo.login`, and kept because
   * that field is absent on an older daemon.
   */
  loginSupported: boolean;
  agents: AgentAuthInfo[];
}

/**
 * A *system* — who serves a model and who you sign in to.
 *
 * ⚠ **The distinction this whole screen is built on: a system is not a harness.**
 * A harness (`AgentId`) is the CLI that runs the loop; a system is where its
 * traffic goes. They were the same thing while each of the three agents spoke
 * only to its own vendor, which is why the settings screen used to say "Agents"
 * and then ask you to sign in to Anthropic.
 */
export interface SystemInfo {
  id: string;
  displayName: string;
  /** The wire shape it speaks. Compared against what a harness accepts. */
  apiType: string;
  /**
   * Whether a foreign harness can be pointed at it at all.
   *
   * Optional for this file's usual reason — an older daemon does not send it —
   * and the fallback is "assume not", which greys a cross-system pairing rather
   * than offering one that would fail at the start.
   */
  routable?: boolean;
  /**
   * The harness that reaches it without being routed, or `null`.
   *
   * A string rather than a closed union for `AgentId`'s reason, and with one rule
   * the daemon enforces that this side may rely on: a provider a plugin added may
   * only ever name a harness **that same plugin added**. So this never points at a
   * built-in it did not come with, and the settings screen cannot be made to draw
   * "Sign in to Claude Code" under a heading its author chose.
   */
  nativeHarness: AgentId | null;
  /** Whose CLI drives its sign-in wizard, or `null` for a key-only system. */
  loginVia: AgentId | null;
  /**
   * What to offer when this system is *routed* into a foreign harness.
   *
   * Empty for a natively-reached one, where the agent publishes its own list —
   * which is not a gap. See `AgentCapabilities.models`.
   */
  models: { id: string; name: string }[];
  /**
   * What the native harness prefixes a model id with, or `null`/absent where it
   * spells them the way the endpoint does.
   *
   * Optional for this file's usual reason — an older daemon does not send it —
   * and the fallback is `null`, which is today's behaviour for every system that
   * existed before this field: no respelling, so the two lists a system can carry
   * are compared exactly as they always were.
   */
  nativeModelPrefix?: string | null;
  /**
   * Which of the native harness's variables holds *this* system's key, or `null`
   * where it reads only one and there is nothing to narrow.
   *
   * Read by the settings screen that mounts a harness's card under a system's
   * name: opencode takes a key for OpenRouter and a key for OpenCode Zen, and
   * without this both boxes were drawn under whichever heading you opened.
   * Absent on an older daemon, which draws them all — today's behaviour.
   */
  keyEnv?: string | null;
  keySet: boolean;
  keyUpdatedAt: number | null;
  /**
   * The plugin that added this provider, or absent for one this product ships.
   *
   * Drawn where somebody has to be told where a row came from, and named in the
   * one refusal that is about the plugin rather than about the pairing. Never
   * branched on for a *presentation*: a contributed provider is a provider, and a
   * row that looked different because of where it came from would be this client
   * having an opinion about somebody's tools.
   */
  contributedBy?: { pluginId: string; pluginName: string };
}

/**
 * What a harness will let us do about which system it talks to.
 *
 * `null` where it will not let us do anything, which is kimi. ⚠ **`providerId`
 * is the agent's own and differs between them** — claude says `main`, codex says
 * `custom-gateway` — so nothing here may be written down client-side either.
 */
export interface AgentRouting {
  providerId: string;
  supported: string[];
  /**
   * Whether this harness can be told which model to run on somebody else's system.
   *
   * ⚠ **The fourth arm of `hostable`, which this side could not express and had a
   * paragraph admitting it.** The daemon folds `ROUTED_MODEL_ENV` into its own
   * refusal precisely so a pairing that would *start*, look correct, and quietly
   * run the endpoint's default model never reaches a session — and until this
   * field existed the picker offered exactly that pairing and `POST /custom-agents`
   * refused it after somebody had assembled it.
   *
   * ⚠ **Absent means `true`, which is the opposite fallback from `routable` one
   * interface up — and it is airtight rather than optimistic.** A daemon too old
   * to send this is a daemon with no plugin catalogue, so the only harness it can
   * route is the one that has always had an arm. There is no version of an older
   * daemon for which the safe answer is `false`, and answering `false` there would
   * grey out Claude Code on every machine in the fleet that had not been updated.
   */
  pinsModel?: boolean;
}

/** One harness's answer to what it offers and what it accepts. */
export interface AgentCapabilities {
  models: { id: string; name: string; description: string | null; group: string | null }[];
  routing: AgentRouting | null;
  /** Why this harness could not be asked, or `null`. Never throws the picker away. */
  error: string | null;
}

/** A harness, a system and a model, under a name somebody chose. */
export interface CustomAgent {
  id: string;
  name: string;
  harness: AgentId;
  system: string;
  model: string;
  createdAt: number;
}

/**
 * One remembered position in a machine's agent strip.
 *
 * ⚠ **`ref` is a string here and an `AgentId` nowhere**, which is the mirror of
 * the daemon's own posture rather than this file being loose. The strip stores a
 * position for something that may not exist right now — a harness signed out, an
 * assembled agent this build cannot resolve — and the whole point is that the
 * position survives. What resolves it is `orderStrip` in `agentStrip.ts`, against
 * the two listings the strip already reads, and a `ref` that resolves to nothing
 * is dropped there.
 *
 * `kind` *is* narrow, because it is this system's own vocabulary and reaches a
 * branch in the client: an unknown third value would be a row nothing could draw.
 */
export interface AgentStripEntry {
  kind: "harness" | "custom";
  ref: string;
  hidden: boolean;
}

export interface LoginRunView {
  loginId: string;
  agent: AgentId;
  startedAt: number;
  done: boolean;
  exit: { code: number | null; signal: string | null } | null;
  dropped: number;
  /** Total output produced so far. Poll with this as the next `since`. */
  cursor: number;
}

export interface LoginChunk extends LoginRunView {
  chunk: string;
  /** The requested cursor pointed at output that has since been discarded. */
  gap: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  entries: number | null;
}

export interface DirListing {
  path: string | null;
  parent: string | null;
  roots: string[];
  entries: DirEntry[];
}

export interface RootListing {
  roots: string[];
  recent: string[];
}

export interface EventsPage {
  events: StoredEvent[];
  /**
   * The lowest seq the daemon can still serve.
   *
   * The *derived* floor, not the raw store `firstSeq`: they differ when the log
   * holds nothing for a session whose sequence is already high, and in that case
   * this is `lastSeq + 1` — "there is nothing left" — rather than 0.
   */
  firstSeq: number;
  lastSeq: number;
  dropped: number;
  gap: boolean;
}

/**
 * `GET /sessions`, bounded.
 *
 * `total` and `truncated` are what make a limit safe to act on. A row missing from
 * `sessions` means one of two completely different things — the session is gone, or
 * it fell outside the window — and pruning local state on the wrong one discards a
 * live transcript. Optional because an older daemon does not send them, and their
 * absence must read as "not truncated" rather than as `undefined`.
 */
export interface SessionList {
  sessions: SessionSnapshot[];
  now: number;
  instanceId: string;
  total?: number;
  truncated?: boolean;
}

/** Every error from every service in this system has this shape. */
export interface WireError {
  error: { code: string; message: string; detail: unknown };
}

/* ------------------------------------------------------------------ *
 * Control plane — packages/control-plane/src/app.ts
 * ------------------------------------------------------------------ */

export type Scope = "session:read" | "session:write" | "machine:admin";

/**
 * How long a machine has been away, or `null` when that says nothing useful.
 *
 * ⚠ **"Offline" was the same word for a lid that closed a minute ago and a host
 * that died last week**, because presence is deleted on disconnect and nothing
 * outlived it. That is the first question anybody has about a machine that is not
 * answering, and the product could not answer it at all.
 *
 * Three `null`s, and they are three different silences rather than one:
 *
 * * **`undefined`** — a control plane that predates the field. Saying "never
 *   seen" there would be a claim about a fleet that is working fine.
 * * **`null`** — nothing has ever recorded a tunnel. The row already says
 *   *"waiting for the daemon to dial in"*, which is the same fact with a remedy
 *   attached, so a second sentence would be noise.
 * * **just now** — under a couple of minutes, where the poll interval and the
 *   presence staleness window are the same size as the answer. A machine that
 *   dropped four seconds ago is one somebody is watching; telling them it was
 *   last seen "0m ago" is a number pretending to be information.
 *
 * Coarse on purpose above that: the question is "did this work today", and
 * minute-level precision on a day-old absence reads as certainty the row does not
 * have.
 */
export function lastSeenText(at: number | null | undefined, now = Date.now()): string | null {
  if (at === undefined || at === null) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 120) return null;
  if (seconds < 5400) return `last seen ${Math.round(seconds / 60)} min ago`;
  if (seconds < 129_600) return `last seen ${Math.round(seconds / 3600)} h ago`;
  return `last seen ${Math.round(seconds / 86_400)} days ago`;
}

/**
 * The names that name more than one machine in this list, case-folded.
 *
 * **This is what lets a row draw its id only where the id is doing something.**
 * The id was on every row unconditionally, and the reason given was correct as
 * far as it went: a name is not unique, so two machines called `mac` are told
 * apart by nothing else. What that argument does not establish is that the other
 * rows need it — and it is 18 characters of hex in the one line a row has for
 * *state*, on every machine, for a collision that is rare.
 *
 * The property is preserved exactly rather than traded away: the id appears
 * whenever the name is ambiguous **to this reader**, which is the same question
 * `nameVisibleTo` asks on the server, and disappears only where there is nothing
 * to disambiguate.
 *
 * Case-folded because the server folds too — `idx_users_name_folded` is why
 * `Casey` and `casey` can both exist, and the same is true one table over, so
 * `Mac` and `mac` are a collision a reader would have to squint at. Folding here
 * and not on the server's side of it is deliberate: this decides what to *draw*,
 * and drawing the id for a pair that differs only in case is the honest answer.
 *
 * `readonly` in and `ReadonlySet` out, so a caller cannot mutate the answer back
 * into the list it was computed from.
 */
export function ambiguousNames(machines: readonly { name: string }[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const machine of machines) {
    const folded = machine.name.toLowerCase();
    if (seen.has(folded)) twice.add(folded);
    else seen.add(folded);
  }
  return twice;
}

export interface MachineRecord {
  id: string;
  /**
   * What *this* user calls it.
   *
   * The row's own `machines.name` is unique fleet-wide and nobody chooses it; for
   * a machine you own the control plane sends your label here instead. So two
   * people may each have a "laptop" and neither has to know the other does.
   */
  name: string;
  enrolled: boolean;
  /**
   * When the control plane last saw a tunnel for it, or `null`.
   *
   * Beside `relayOnline` rather than folded into it, and the pair is not
   * redundant: that one is a boolean about *now* and had nothing behind it, so a
   * lid that closed a minute ago and a host that died last week produced the same
   * word on the same row. This is the question somebody actually has about a
   * machine that is not answering.
   *
   * Optional, and `null` and `undefined` mean different things: `null` is "no
   * tunnel has ever been recorded" — a machine that never enrolled — while
   * absence is a control plane that predates the table and cannot claim either.
   * A client that collapsed them would tell somebody their working fleet has
   * never been seen.
   */
  lastSeenAt?: number | null;
  /**
   * Whether this user owns it, and therefore may rename, re-enroll and retire it.
   *
   * `false` for a machine an admin registered before ownership existed, and for
   * one somebody else owns and shared. Optional, so an older control plane
   * degrades to "nothing is owned" rather than to `undefined` being drawn as true.
   */
  owned?: boolean;
  /**
   * Past its **owner's** machine limit, and therefore switched off at the relay.
   *
   * Not a reachability fact: it is asserted by the control plane before any
   * probe, and it is true of a machine whose daemon is running. What follows
   * from it *is* reachability — the tunnel is refused at dial, so the machine
   * also reads offline — and `machine.ts` carries both for that reason.
   *
   * Optional and tested `=== true`, exactly as `owned` is, and the polarity is
   * decided by which typo survives: written this way the natural `=== true`
   * degrades an older control plane to "nothing is suspended", which is true
   * there. Spelled `withinLimit`, the natural `=== true` would draw **every
   * machine in the fleet** as suspended and hide the controls on all of them.
   */
  overLimit?: boolean;
  /**
   * Its owner has been banned, so it is switched off until that is lifted.
   *
   * The sibling of `overLimit` and read the same way. Two fields rather than one
   * "switched off" flag because the **remedies differ** — retire a machine
   * versus unban a person — and a row that could not tell them apart would send
   * somebody to do the wrong one. Only ever true for a machine somebody else
   * owns: a banned owner cannot reach this app at all.
   */
  ownerDisabled?: boolean;
  scopes: Scope[];
  relayUrl: string | null;
  relayOnline: boolean;
}

export interface IssuedToken {
  token: string;
  /** Epoch **milliseconds**, already converted from the `exp` claim's seconds. */
  expiresAt: number;
  scopes: Scope[];
  machine: {
    id: string;
    name: string;
    relayUrl: string | null;
    relayOnline: boolean;
  };
  /**
   * The control plane's own clock when it answered, in epoch milliseconds.
   *
   * **Read this; do not compare `expiresAt` to `Date.now()` directly.** Both are
   * absolute instants but on different clocks, and a phone's is routinely wrong.
   * `expiresAt - serverTime` is the lifetime, which is the only part the two
   * clocks agree on; `machine.ts` adds that to local now. Optional so an older
   * control plane degrades to the previous behaviour rather than to `NaN`.
   */
  serverTime?: number;
}

export interface Me {
  id: string;
  name: string;
  isAdmin: boolean;
  /**
   * Which credential this is, and whether the account has a password at all.
   *
   * Neither is an authorization fact — both credentials are full authority. They
   * are what stops the client guessing: `via` decides whether there is a session
   * to sign out of, and `hasPassword` distinguishes "change your password" from
   * "set one", which is the state every account carried over from before login
   * existed is in and which is otherwise indistinguishable from a forgotten one.
   *
   * Optional, so an older control plane degrades rather than rendering
   * `undefined`.
   */
  via?: "api_key" | "session";
  hasPassword?: boolean;
  /**
   * The address on the account, and whether anybody proved it.
   *
   * **`emailVerified` is carried rather than derived from `email !== null`**,
   * because the two are different states and the difference is the whole of what
   * an address is worth here: an unverified one reserves nothing and
   * `POST /v1/forgot` will not mail it. Inferring one from the other tells
   * somebody they can recover their account when they cannot.
   */
  email?: string | null;
  emailVerified?: boolean;
  /**
   * The control plane is refusing every other route until a new password lands.
   *
   * Tested as `=== true`, never `!== false`. `phase: "ready"` with `me === null`
   * is a state this app really reaches — `bootstrap`'s catch keeps it when the
   * control plane is unreachable but machines are already known — and failing
   * closed there would trap somebody in a password form they may not owe, during
   * an outage, with a working app behind it.
   */
  mustChangePassword?: boolean;
  mustChangePasswordReason?: string | null;
  /**
   * How many machines this account owns, its ceiling, and whether it may add one.
   *
   * **`canAddMachine` is the control plane's answer, not a comparison this
   * client makes.** "Somebody at their limit is not offered a way to add more"
   * is a rule that service owns, and re-deriving it here would be a second copy
   * that drifts the first time the rule gains a clause. The two numbers come too
   * because the *sentence* a screen draws needs them: "you are using all 2 of
   * your 2" cannot be written from a boolean.
   *
   * All three optional, and `quota.ts` collapses their absence to one `unknown`
   * state that **fails open** — an older control plane, or a `me` that could not
   * be read, must not be the reason somebody with quota cannot reach the only
   * form in this app that creates a machine.
   *
   * `machineCount` is **not** `state.machines.length`: that list includes
   * machines granted to you and owned by somebody else, and the limit counts
   * only the ones you own.
   */
  machineCount?: number;
  machineLimit?: number | null;
  canAddMachine?: boolean;
}

/** What `POST /v1/login` answers with. The token is the browser's credential. */
export interface SessionToken {
  token: string;
  sessionId: string;
  /** Epoch milliseconds, on the control plane's clock. */
  expiresAt: number;
  user: Me;
  serverTime?: number;
}

/** One signed-in device, from `GET /v1/me/sessions`. */
export interface SessionRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  /**
   * What the sign-in said about itself, or `null`.
   *
   * Optional on the type as well as nullable, and the two mean different things:
   * `undefined` is a control plane that predates these fields, `null` is one that
   * has them and had nothing to record. Both draw the same way, which is why the
   * client never has to tell them apart — but a client that declared them
   * required would break against the older server rather than against neither.
   *
   * **Neither is evidence.** Both are caller-supplied; see `device.ts`.
   */
  ip?: string | null;
  userAgent?: string | null;
  /** Whether this row is the credential making the request. */
  current: boolean;
}

/**
 * An enrollment code, which exists in exactly one response and nowhere else.
 *
 * `controlPlaneUrl` comes from the server rather than from `window.location`
 * because in dev the browser's origin is Vite's port, which proxies `/v1` — a
 * value pasted from there onto another machine would name a host that machine
 * cannot reach.
 */
export interface EnrollmentCode {
  code: string;
  machineId?: string;
  expiresAt: number;
  controlPlaneUrl: string;
}

/** `POST /v1/machines`: the machine, its grant, and its first code, in one answer. */
export interface CreatedMachine {
  machine: MachineRecord;
  enrollment: { code: string; expiresAt: number };
  controlPlaneUrl: string;
}

export interface AdminUser {
  id: string;
  name: string;
  isAdmin: boolean;
  createdAt: number;
  disabled: boolean;
  hasPassword: boolean;
  sessions: number;
  /**
   * The address, and whether it was proved.
   *
   * This is the one place the cost of deleting the admin password reset is
   * visible: an account with no *verified* address has no recovery at all on an
   * instance with no SMTP. An admin should be able to look at that rather than
   * discover it when somebody forgets a password.
   */
  email?: string | null;
  emailVerified?: boolean;
  /** Created with a temporary password and still holding it. */
  mustChangePassword?: boolean;
}

/**
 * What creating a person answers with, in **two shapes**.
 *
 * `password` is optional now, and that is a good breaking change rather than a
 * loosening: with mail configured the server invites and no password exists at
 * any moment, so a call site that renders `body.password` unconditionally puts
 * `undefined` inside a card that says "copy this". Making it optional forces the
 * two results to be told apart where they are drawn.
 */
export interface CreatedUser {
  id: string;
  name: string;
  isAdmin: boolean;
  invited: boolean;
  /** Only on the arm where no invitation could be sent. */
  password?: string;
  /** Only on the invited arm. */
  email?: string;
  mailQueued?: boolean;
  mustChangePassword?: boolean;
}

/* ------------------------------------------------------------------ *
 * Plugins
 *
 * Mirrored from `src/plugins/protocol.ts`, which is written to be
 * mirrorable — it imports nothing, for this reason. The cost is the one
 * this file's header already states: it can drift, and drift shows up at
 * runtime rather than at build time, so **every narrowing over these
 * shapes fails open**. `plugins.ts` is where that is done and asserted.
 * ------------------------------------------------------------------ */

export type PluginScope =
  | "sessions.read"
  | "sessions.write"
  | "files.read"
  | "store"
  | "net"
  | "model"
  | "harness"
  | "system";

/**
 * One line per scope, for the list somebody reads before installing.
 *
 * Copied rather than fetched. It is the *client's* job to explain what a
 * capability means to the person looking at it, and a daemon that could choose
 * these strings would be a daemon that could describe `net` as "nothing much".
 *
 * ⚠ **`Record<PluginScope, string>` and the fall-through at the call site are
 * both load-bearing, and they answer different questions.** The exhaustive type
 * is about *this* build: a sixth scope added to the union above is a compile
 * error here, so the sentence is written by whoever adds the scope rather than
 * found missing by whoever installs the first plugin asking for it. It was
 * `Record<string, string>` and that caught nothing — the exhaustive copy was the
 * one in `src/plugins/protocol.ts`, which is the copy nobody draws, so a new
 * scope would have failed the build on the unused table and fallen through to a
 * raw identifier on the rendered one. The fall-through is about the *other*
 * build: this file is a hand mirror of a daemon that may be newer than the tab,
 * so `PluginSummary.scopes` claiming `PluginScope[]` is a claim about a wire
 * this file does not control. A scope this client has not heard of must still
 * land as its own identifier — legible, and never a guess about what a newer
 * daemon means by it. Removing the `??` because the type now says it cannot miss
 * would be believing the mirror; it is the same fail-open rule `plugins.ts`
 * keeps over every other shape here.
 */
export const PLUGIN_SCOPE_TEXT: Record<PluginScope, string> = {
  /*
   * ⚠ **One line each, and the length is the decision rather than the wording.**
   * These were sentences — *"Start, prompt, stop and rename sessions, and answer
   * the questions agents ask"* — and six of them stacked is the wall of text that
   * pushed the install control off a phone and got read by nobody, which is the
   * one failure a consent screen cannot survive: an unread disclosure discloses
   * nothing. `webcheck` holds them to a line, because a table of sentences is one
   * well-meant edit away from being a wall again.
   *
   * ⚠ **Lower-case fragments, because they are read as the tail of "It may".**
   * The heading is the verb; each row completes it. Capitalised they read as six
   * separate claims and take a line each to restate the subject.
   *
   * ⚠ **Two of the six carry a consequence rather than a mechanism, and those
   * halves survive the shortening or the shortening was not worth having.**
   * `sessions.write` also grants `sessions.answerPermission` and
   * `sessions.answerElicitation` — so a plugin holding it plus the
   * `permission.requested` hook approves every permission an agent raises on this
   * machine, on a product whose own docs call that prompt the thing standing
   * between an agent and arbitrary shell. And `model` spends the operator's
   * **quota**, on an account they signed an agent into for their own work, from a
   * hook that can fire on every turn of every session. "ask a model a question"
   * describes the mechanism perfectly and hides the only part worth reading.
   *
   * "your agents" rather than a vendor: which agents exist is a fact about the
   * machine, and naming Claude here would be wrong on a host that has only codex.
   */
  "sessions.read": "read your sessions and transcripts",
  "sessions.write": "control sessions, and answer agents' questions",
  "files.read": "read files in a session's workspace",
  store: "keep its own data here",
  net: "reach the hosts it lists",
  model: "ask your agents, at your cost",
  /*
   * ⚠ **The two that gate no method, and their lines have to carry the *thing*
   * rather than the mechanism — the same rule `sessions.write` and `model` are
   * already written under.** "add an agent" describes a list growing by one and
   * hides that the machine will run a program the plugin's author named, as this
   * user, on every session started on it. "add a provider" hides that a key the
   * operator pastes is sent to a host the plugin chose.
   *
   * ⚠ **And the consent screen names the command line and the address as well**,
   * because a line in a list is where somebody learns a capability exists and not
   * where they can judge one. These two are the only scopes with a second
   * disclosure, and that is because they are the only two where the *value*
   * matters as much as the verb.
   */
  harness: "add an agent that runs a program it names",
  system: "add a provider your saved keys are sent to",
};

/**
 * How long one of those lines may be.
 *
 * ⚠ **A number in the mirror rather than a rule in a review**, for the reason the
 * table above gives: the shortening is the whole change, and nothing else in this
 * build would notice it being undone one entry at a time. `webcheck` reads this,
 * so the ceiling and the strings it bounds move together or not at all.
 */
export const PLUGIN_SCOPE_TEXT_MAX = 56;

export type PluginHook =
  | "session.created"
  | "turn.ended"
  | "session.ended"
  | "permission.requested"
  | "permission.resolved";

export interface PluginAction {
  id: string;
  title: string;
  on: "session" | "screen";
}

/**
 * A harness a plugin adds to a machine.
 *
 * Mirrored so the consent screen can draw it. **Nothing here is executed, drawn as
 * markup, or reached for at runtime** — this client's whole relationship with a
 * contributed harness is `GET /agents`, exactly as with a built-in. What this shape
 * is for is the one screen that has to show somebody a command line before it is
 * installed.
 */
export interface HarnessContribution {
  id: string;
  name: string;
  command: string;
  args: string[];
  envNames: string[];
  routedModelEnv: string[];
  authHint: string | null;
}

/**
 * A provider a plugin adds to a machine.
 *
 * Same standing as {@link HarnessContribution}: drawn at consent and never read
 * again — `GET /systems` is where a provider comes from once it is installed.
 * `baseUrl` is the field the disclosure exists for, and it is the whole normalised
 * address rather than an origin, because that is what the daemon compares against
 * what was agreed to.
 */
export interface SystemContribution {
  id: string;
  name: string;
  apiType: string;
  baseUrl: string | null;
  authHeader: { name: string; prefix: string } | null;
  models: { id: string; name: string }[];
  nativeHarness: string | null;
  loginVia: string | null;
  nativeModelPrefix: string | null;
  keyEnv: string | null;
}

export interface PluginContributions {
  screen: { title: string } | null;
  settings: boolean;
  actions: PluginAction[];
  hooks: PluginHook[];
  /**
   * Harnesses and providers this plugin adds.
   *
   * ⚠ **Optional on this side, and that is `compatibility.md`'s rule 2 rather than
   * laziness.** A daemon older than this tab does not send them, and the fallback
   * has to be "this plugin adds none" — which is true of every plugin such a daemon
   * can have installed, since it would refuse the manifest. The direction that is
   * *not* safe is the mirror knowing less than the daemon, and `webcheck`'s sweep
   * is what refuses that.
   */
  harnesses?: HarnessContribution[];
  systems?: SystemContribution[];
}

export type PluginState = "running" | "stopped" | "failed" | "starting";

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string | null;
  scopes: PluginScope[];
  net: string[];
  contributes: PluginContributions;
  enabled: boolean;
  state: PluginState;
  failure: string | null;
  installedAt: number;
  updatedAt: number;
}

export interface PluginListing {
  plugins: PluginSummary[];
  api: number;
}

export interface PluginRowAction {
  id: string;
  label: string;
  tone: "plain" | "destructive";
  confirm: string | null;
}

export type PluginRowTone = "ok" | "warn" | "danger";

/**
 * Where a row goes. **A destination this app has, never a URL** — see
 * `src/plugins/protocol.ts` for the argument, which is the same one that keeps a
 * session-menu action from navigating.
 */
export type PluginOpen = { session: string } | { screen: true };

export interface PluginRow {
  id: string;
  title: string;
  subtitle: string | null;
  badge: string | null;
  tone: PluginRowTone | null;
  open: PluginOpen | null;
  actions: PluginRowAction[];
}

export type PluginFieldKind = "text" | "password" | "number" | "toggle" | "select";

/**
 * Which of a plugin's two screens is being drawn. Mirrors `PluginSurface`.
 *
 * ⚠ **The browser is the only side that knows this for an action's answer**, and
 * that is why the narrowing lives here as well as in the daemon. A `view` is
 * invoked by its id, so the daemon knows which surface it is answering for — but
 * a *form submit* reaches it as an action id, which says which action and never
 * which pane it was pressed on. The component drawing the pane knows; nothing
 * upstream of it does.
 */
export type PluginSurface = "screen" | "settings";

/**
 * What a settings pane draws. Mirrors `PLUGIN_SETTINGS_BLOCK_TYPES`.
 *
 * A settings pane is a form plus the words around it. `text` and `notice` are
 * not settings — they are the sentence above a control and the warning beside
 * it — and a form with no way to say anything about itself is a worse pane, not
 * a stricter one. `list` and `columns` are a **screen**, which a plugin already
 * has at `/p/:machineId/:pluginId`.
 */
export const PLUGIN_SETTINGS_BLOCK_TYPES: readonly PluginBlock["type"][] = ["text", "notice", "form"];

/**
 * The three controls a setting may be. Mirrors `PLUGIN_SETTINGS_FIELD_KINDS`.
 *
 * A box you type in, a switch, a dropdown. `password` and `number` are spellings
 * of the first rather than a fourth and a fifth kind: `PluginField.value` is a
 * string on the wire whatever the kind, so `number` only ever bought a keyboard,
 * and `password` masked a value the daemon keeps in a plaintext SQLite column —
 * an assurance this system does not provide, offered on the screen where a false
 * one costs most.
 */
export const PLUGIN_SETTINGS_FIELD_KINDS: readonly PluginFieldKind[] = ["text", "toggle", "select"];

export interface PluginFieldOption {
  value: string;
  label: string;
}

export interface PluginField {
  key: string;
  label: string;
  kind: PluginFieldKind;
  value: string | null;
  options: PluginFieldOption[];
  placeholder: string | null;
  help: string | null;
}

export type PluginBlock =
  | { type: "text"; text: string; tone: "default" | "muted" }
  | { type: "notice"; text: string; tone: "default" | "danger" }
  | { type: "list"; rows: PluginRow[]; empty: string }
  | { type: "columns"; columns: { title: string; rows: PluginRow[] }[] }
  | { type: "form"; fields: PluginField[]; submit: string; action: string };

export interface PluginView {
  title: string | null;
  /** How often this view asks to be re-read. Already clamped by the daemon. */
  refreshMs: number | null;
  blocks: PluginBlock[];
}

export type PluginResult =
  | { kind: "view"; view: PluginView }
  | { kind: "toast"; text: string; tone: "default" | "danger" };

export interface PluginInstalled {
  plugin: PluginSummary;
  /** The version this replaced, or `null` when it was a fresh install. */
  replaced: string | null;
}
