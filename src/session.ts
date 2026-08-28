import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import {
  AcpClient,
  type ElicitationRequest,
  type NotificationListener,
  type SessionHandlers,
} from "./acp/client.js";
import { MAX_PARENT_ID_CHARS, toolCallLineage } from "./acp/subagents.js";
import { sessionMetaFor } from "./acp/agents.js";
import type { AgentRouting } from "./acp/systems.js";
import {
  hostable,
  routedModelEnv,
  routingHeaders,
  SYSTEMS,
  type SystemId,
} from "./acp/systems.js";
import type { AgentId } from "./acp/agents.js";
import { clip, jsonBytes } from "./events.js";
import type {
  AgentCommand,
  AgentCommands,
  StoredFileRef,
  AgentConfig,
  AgentConfigChoice,
  AgentConfigOption,
  AgentModes,
  ContextUsage,
  ElicitationField,
  ElicitationForm,
  ElicitationOption,
  FileLocation,
  PermissionOptionSummary,
  SessionEvent,
} from "./events.js";
import { LocalRuntime } from "./runtime/local.js";
import type { AgentHandle, SessionRuntime } from "./runtime/types.js";
import { describeError } from "./http.js";

/** ACP's "authentication required" error code. */
const AUTH_REQUIRED = -32000;
/**
 * JSON-RPC `resourceNotFound`, which on a resume means one specific thing: the
 * agent no longer has that conversation.
 *
 * Read as a code rather than off the message, because the message is prose the
 * adapter builds (`Resource not found: <uuid>`) and the code is the contract.
 *
 * Measured 2026-08-04 in production on ten sessions at once, and the first
 * explanation was wrong in a way worth keeping. It read "they were created while
 * agents ran in containers, so their transcripts never reached this host" —
 * true of **six**, whose `cwd` has no project directory under
 * `~/.claude/projects` at all. The other three had one, with nine transcripts in
 * it and theirs missing: they were `/clear` casualties, where the CLI forked to
 * a new conversation and the id we had stored was left naming the fork's parent.
 *
 * That second class is **not fixed and cannot be fixed from here**, which took
 * an attempt to establish. Measured 2026-08-05: `/clear` works (the agent
 * answers `NO MEMORY` straight after), our ACP session id does **not** change,
 * and claude forks underneath — verified by content, the file named by our id
 * still holds the pre-clear conversation while the live one sits under an id we
 * are never told. So there is no rename to follow; a first attempt built exactly
 * that and was reverted for being machinery for an event that does not occur.
 * The lead worth measuring is `session/list`, which claude does advertise.
 *
 * **One caveat, and it is the adapter's rather than ours.** It maps *two* SDK
 * failures onto this code (`acp-agent.js:4287`): "No conversation found with
 * session ID", which is settled, and "Query closed before response received",
 * which is a transport hiccup and is not. We cannot tell them apart from here,
 * so treating the code as settled can strand a session that a retry would have
 * recovered. That is the deliberate trade: the alternative is spawning an agent
 * per dead session on every boot forever, and the way back is one tap on Resume.
 */
const RESOURCE_NOT_FOUND = -32002;
/**
 * JSON-RPC `internalError` — the agent's "something went wrong and I will not
 * say what".
 *
 * Read for exactly one purpose, in `Session.resume`: it is what kimi 0.29.2
 * answers when asked to resume a session left in plan mode while the client
 * declares `clientCapabilities.fs`. Nothing else keys on it, and nothing should
 * — it is the generic bucket, so treating it as *meaning* anything beyond "try
 * the one optional capability off" would be reading tea leaves.
 */
const INTERNAL_ERROR = -32603;
const CANCEL_GRACE_MS = 5_000;
/** Ceilings on RPCs that write to the agent's stdin. See `doDispose`. */
const CANCEL_SEND_TIMEOUT_MS = 1_000;
/**
 * How long {@link Session.cancelTurn} waits to see the turn actually end.
 *
 * Shorter than `CANCEL_GRACE_MS`, and the difference is who is waiting.
 * `doDispose` spends five seconds because what follows it is SIGTERM, so every
 * second bought there is a chance for the agent to shut down cleanly instead. A
 * cancel is asked for by somebody holding a phone, and what follows it is
 * nothing — the turn ends when it ends, `turn_end` reaches the transcript on its
 * own, and the caller does not need to be there for it. So this bounds only how
 * long the answer is willing to say *whether* it worked, and 1500ms is the point
 * past which a person taps again rather than waits.
 */
const CANCEL_SETTLE_MS = 1_500;
const CLOSE_TIMEOUT_MS = 2_000;
/**
 * Ceiling on the `session/new` a clear opens.
 *
 * Measured at ~600ms against claude 0.63.0 on an already-running process — no
 * handshake, only the session — so this is loose by an order of magnitude rather
 * than tuned. Bounded at all for the reason every stdin write here is: the SDK
 * puts no timeout on them, and an agent that has stopped reading its pipe would
 * otherwise park the HTTP request that asked for the clear indefinitely.
 */
const NEW_SESSION_TIMEOUT_MS = 15_000;
/**
 * Ceiling on the `session/new` or `session/resume` that **opens** a session.
 *
 * ⚠ **These two were the hole in "every RPC that writes to agent stdin is
 * bounded"**, and the rule reads as absolute, so nothing was looking. Every other
 * stdin write in this file goes through `withDeadline`; the two on the launch
 * path did not, and they are the ones whose failure is worst.
 *
 * What an unbounded launch cost: an agent that completes `initialize` and then
 * stops reading its pipe — a wedged tool, a full pipe buffer, a dead inner
 * process, exactly the case the constant above is written about — leaves
 * `Session.start`'s promise pending for ever. `registry.ts` awaits it with no
 * ceiling of its own, so `DELETE /sessions/:id` never answers; `stopping` is
 * memoised, so every retry joins the same dead promise. No `exitRecord` is ever
 * written, so the session never becomes `terminal`: it cannot be resumed and it
 * holds one of `MAX_LIVE_SESSIONS` for the life of the process. At shutdown there
 * is no `agentHandle` yet, so the SIGKILL sweep skips it — and the child was
 * spawned detached with its pid never persisted, so the next boot's reaper cannot
 * find it either. One permanently leaked agent, holding a worktree.
 *
 * Four times `NEW_SESSION_TIMEOUT_MS` rather than the same number, because this
 * one is not the same question. That one bounds a `session/new` on a process
 * already running and answering (~600ms measured); this one covers a cold agent
 * that may still be loading a model list, and `session/resume` on top, which
 * restores a conversation whose length nobody here controls. Loose on purpose:
 * the value of a bound is that it exists, and a launch that takes a minute is a
 * bad experience where a launch that never returns is a leaked process.
 */
const LAUNCH_SESSION_TIMEOUT_MS = 60_000;
/**
 * Ceiling on a mode/model/effort change.
 *
 * Generous because switching model is not a local edit — claude rebuilds its
 * available modes around the new model's capabilities — but bounded for the same
 * reason every other stdin write here is: the SDK puts no timeout on it, so an
 * agent that has stopped reading its pipe would park an HTTP request forever.
 */
const SET_CONFIG_TIMEOUT_MS = 15_000;
/**
 * Ceilings on the agent's command list. See {@link toCommands} for why they are
 * applied here rather than downstream.
 *
 * Set against a real list rather than guessed. Measured 2026-08-03 against claude
 * 0.63.0 on a machine with plugins installed: **100 commands, 18.7 KiB**, longest
 * name 24 characters, longest hint exactly 64, and descriptions with a median of
 * 68 but a maximum of 1135 — a skill's whole trigger paragraph. So the name cap is
 * generous, the hint cap is *raised past* the longest real one rather than set at
 * it, and the description cap is the one that actually bites. It is the payload
 * that is being bounded, not the row: the menu truncates prose with CSS, so what
 * this stops is one verbose skill costing more than the other ninety-nine.
 *
 * **The name cap is a refusal and the other two are truncations**, which is the
 * one asymmetry here. A description and a hint are prose to show; a name is text
 * to *send*, so a clipped one is not a shorter command but a broken one. See
 * {@link toCommands}.
 */
const MAX_AGENT_COMMANDS = 256;
const MAX_COMMAND_NAME_CHARS = 64;
const MAX_COMMAND_DESCRIPTION_CHARS = 200;
const MAX_COMMAND_HINT_CHARS = 100;

/**
 * What an elicitation form is allowed to be.
 *
 * Same placement and the same argument as the command caps above — the agent
 * chooses every string here, so "bounded by what the agent sent" is not a bound —
 * with the asymmetry one level up: **structure is refused and prose is carried
 * whole.**
 *
 * A form missing a question is not a smaller form, it is a form whose answer
 * *means something different*, so a count over its cap refuses the whole
 * elicitation rather than delivering a form somebody can answer wrongly. An
 * option's `value` is refused for the reason a command's name is: it round-trips
 * to the agent, and a clipped one is a value the agent will not recognise.
 *
 * ⚠ **`message`, `title` and `description` used to be clipped here — by
 * `MAX_ELICITATION_MESSAGE_CHARS` at 512, `MAX_ELICITATION_TITLE_CHARS` at 100 and
 * `MAX_ELICITATION_DESCRIPTION_CHARS` at 300 — and are not any more.** They are the *question*: with
 * several questions on one form the adapter puts each one in a field's
 * `description` and leaves `message` as a preamble, so a 300-character cap was a
 * cap on the sentence somebody is being asked to answer, and an option's
 * `description` is the sentence explaining what one answer means. Measured against
 * the live log on this machine, one real option description was **318** characters
 * and was being cut. A question a person reads half of is a question they answer
 * wrongly, which is the same failure "structure is refused" exists to avoid, one
 * field along — so the split now runs between *structure* and *prose* rather than
 * between refusing and clipping.
 *
 * What still bounds it is `MAX_ELICITATION_FORM_BYTES` alone, and that is the
 * point of the paragraph below: one whole-object number instead of five per-string
 * ones, refused rather than silently altered.
 *
 * `MAX_ELICITATION_FORM_BYTES` is the backstop the per-item caps cannot be: they
 * stop one enormous string, this stops a thousand small ones. It is deliberately
 * *not* the 8 KiB a pending permission's blob gets — that number is what it is
 * because a permission rides `SessionSnapshot`, which `GET /sessions` returns for
 * sixty sessions every four seconds, and a form does not ride the snapshot. The
 * number and its reason move together.
 *
 * A refusal rather than a `clampBlob` stand-in throughout, because
 * `{truncated: true, bytes}` is a fine thing to show above an Approve button and
 * a useless thing to show above a form.
 *
 * **Measured 2026-08-06 against live claude**, a two-question `AskUserQuestion`
 * driven through `pnpm harness --agent claude --json`: 2 questions → **4 fields**
 * (each question brings its own `_custom` box), 4 options each, longest option
 * value 19 characters, longest description 155, `message` the adapter's own
 * "Please answer the following questions.", nothing `required`, no `format`, no
 * `default`, no `preview`, and ~2.5 KiB in total. The tool's own schema caps
 * questions at 4 and options at 4, so **8 fields is the real ceiling** and every
 * number here sits well above what an agent can actually produce — which is the
 * point, since these bound the pathological case and not a real form.
 *
 * The value cap is the one worth being generous with: it is a *refusal*, so
 * getting it wrong loses a whole form, and it guards a string that is 19
 * characters in practice. The byte backstop is what actually bounds the total.
 */
const MAX_ELICITATION_FIELDS = 24;
const MAX_ELICITATION_OPTIONS = 24;
const MAX_ELICITATION_FORM_BYTES = 32 * 1024;
const MAX_ELICITATION_VALUE_CHARS = 512;
/** Cap on events buffered for a turn iterator that is not currently running. */
const MAX_BUFFERED_EVENTS = 2_000;
/**
 * Ceiling on the text a single `tool_call_update` carries out of a tool.
 *
 * `events.ts` has claimed this constant existed since tool output started being
 * kept, and it did not — so the only bound was `truncateEvent`'s 128 KiB
 * per-event backstop, which is the thing that comment says must *not* be the
 * budget for the commonest event. Tool output is the largest thing an agent
 * emits: one `cat` of a large file built the whole string here, in the agent's
 * own synchronous RPC handler, and then wrote 128 KiB into a log with an 8 MiB
 * per-session budget — sixty-odd of them evict the transcript they sit beside.
 *
 * 32 KiB is a whole test run or several hundred lines of a file, which is far
 * more than anyone reads in a transcript pane, and it leaves the per-event cap
 * doing the job it was described as doing: catching the one enormous event
 * rather than every ordinary one.
 */
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024;

/**
 * How many images one `tool_call_update` may have kept.
 *
 * Its own bound because the byte budget above cannot reach them — see the note
 * in `toolOutput`. Bounded at ingest for the same reason `MAX_PARENT_ID_CHARS`
 * is: the agent chooses how many blocks to send, and "bounded by what the agent
 * sent" is not a bound.
 */
const MAX_IMAGES_PER_UPDATE = 8;

/**
 * What a permission may say about itself, and how many ways it may offer to
 * answer.
 *
 * ⚠ **These are the two fields that had no bound at all, and they are the two
 * that ride the *snapshot*.** `rawInput` and `content` were clamped — at the
 * registry, deliberately, at 8 KiB each — while `title` and `options` were
 * passed through exactly as the agent sent them, into `PendingPermissionSnapshot`
 * and from there onto `GET /sessions` for every session on the machine, every WS
 * `hello`, and every frame `touchSafe()` fans out. Four seconds, every attached
 * client, over the relay, to a phone. `truncateEvent` then declined to cut the
 * event on the stated ground that permissions are "already clamped far tighter
 * upstream by `clampBlob`" — which is true of two fields that are not on the
 * event and false of the two that are.
 *
 * So the comment is now correct rather than aspirational: bounded here, at
 * ingest, where `toCommands` and `toElicitationForm` already bound theirs.
 *
 * **Everything here is a refusal now, and the two 200-character clips are gone.**
 * They were `MAX_PERMISSION_TITLE_CHARS` and `MAX_PERMISSION_OPTION_NAME_CHARS`,
 * and the argument for them — *these two are read by a human and nothing else, so
 * clip them* — is exactly backwards for the one agent that asks a **question**
 * down this channel. kimi surfaces its own `AskUserQuestion` as a
 * `session/request_permission`, so `option.name` is a model-written answer, and
 * `permission.ts`'s `askedQuestion` matches that name against the same string in
 * `rawInput` **by identity** to recover the question. `rawInput` is bounded by
 * bytes and was never clipped by characters, so past 200 the two sides disagreed,
 * the match broke, and the whole question fell back to a row of buttons. A latent
 * bug nothing asserted, removed by removing the clip rather than by teaching the
 * join about it.
 *
 * ⚠ **What replaces them is one whole-object number, because the amplifier was
 * never the string length — it was the snapshot.** `MAX_PERMISSION_SNAPSHOT_BYTES`
 * is measured over the projected `{title, options}` and **refuses**, which is the
 * same shape `MAX_ELICITATION_FORM_BYTES` has one section down and the same shape
 * the option cap beside it already had. It is 8 KiB rather than the form's 32 for
 * the reason the form's own note gives from the other side: a form is fetched when
 * a card opens, and this pair rides `GET /sessions` for sixty sessions every four
 * seconds, to every attached client, over the relay, to a phone. A card whose title
 * alone is 50 KB is not one anybody can read; telling the agent so is a sentence it
 * can act on, and it is what the 24-option cap beside it already does.
 *
 * 24 options matches `MAX_ELICITATION_OPTIONS`, and for the same reason: it is
 * far above every measured card (four is the most any agent has sent) and far
 * below a number that costs a phone anything. Measured on this machine's own log,
 * the longest real title is **14** characters and the longest option name **31**,
 * so 8 KiB is three orders of magnitude of headroom over anything observed.
 */
const MAX_PERMISSION_OPTIONS = 24;
const MAX_PERMISSION_OPTION_ID_CHARS = 256;
const MAX_PERMISSION_SNAPSHOT_BYTES = 8 * 1024;

/**
 * How many file locations one tool call may name, and how long each may be.
 *
 * ⚠ **`locations` was unaccounted in `estimateBytes` and uncut in
 * `truncateEvent`**, on both `tool_call` and `tool_call_update` — so an agent
 * sending a large array produced an event whose real size far exceeded its
 * charged size, walking past the 128 KiB per-event cap, past the per-session
 * byte budget (`schema.sql` pins that column to `estimateBytes`, not to the
 * payload) and past the WS queue's `MAX_QUEUE_BYTES`. Three bounds defeated by
 * one field nobody added a term for, which is precisely the failure the
 * `tool_call_update` arm's own comment names.
 *
 * Bounded here as well as counted there, because counting alone would only make
 * the event *visibly* oversized rather than smaller.
 */
const MAX_TOOL_LOCATIONS = 64;
const MAX_TOOL_LOCATION_CHARS = 1_024;

/** An approval the agent is waiting on, as handed to a {@link PermissionResolver}. */
export interface PendingPermission {
  toolCallId: string | null;
  title: string;
  options: PermissionOptionSummary[];
  /**
   * The tool's arguments, as the agent sent them with the request.
   *
   * Carried because it is often the **only** copy. The obvious place to find a
   * command is the `tool_call` event with the same id, and joining there was the
   * original plan — but measured against kimi, that event arrives with
   * `rawInput: null` and the arguments appear for the first time here, on the
   * permission request itself. A client that joined the log would show an
   * approval button and no command, every time, for the one agent that actually
   * asks.
   *
   * Bounded at the registry boundary, not here: this is what the agent sent and
   * `session.ts` does not decide retention.
   */
  rawInput: unknown;
  /**
   * The request's content blocks — where an edit's diff lives.
   *
   * Same reasoning as `rawInput`. ACP hands both over on the request and the
   * pair of them is what "the thing being approved" actually means.
   */
  content: unknown;
}

/**
 * Decides a permission request on the caller's behalf.
 *
 * The returned promise may be parked indefinitely — that is the point, it is how
 * a human on the other side of a network gets to answer. `signal` aborts if the
 * agent withdraws the request or the connection dies, so a resolver holding a
 * promise open can learn that nobody is waiting for it any more.
 */
export type PermissionResolver = (
  request: PendingPermission,
  signal: AbortSignal,
) => Promise<acp.RequestPermissionResponse>;

/** A question the agent is waiting on, as handed to an {@link ElicitationResolver}. */
export interface PendingElicitation {
  toolCallId: string | null;
  /** The agent's prompt, already clipped. Always present — ACP requires it. */
  message: string;
  /** The projected, bounded form. Never the raw `requestedSchema`. */
  form: ElicitationForm;
}

/**
 * Puts a question in front of somebody and waits for the answer.
 *
 * Parked exactly like {@link PermissionResolver}, and for exactly as long.
 *
 * There is no local fallback and there must not be one. `onPermission` answers
 * for itself when nobody is listening, because allow-once is a defensible default
 * — **a question has no defensible default answer.** So a session with no
 * resolver does not quietly decline on somebody's behalf; it never declares the
 * capability in the first place, and the agent is never given the tool.
 */
export type ElicitationResolver = (
  request: PendingElicitation,
  signal: AbortSignal,
) => Promise<acp.CreateElicitationResponse>;

export interface SessionOptions {
  agent: AgentId;
  /**
   * Absolute path the agent will treat as the session root, **as this daemon
   * sees it**. Translated to the agent's view on the way into `session/new`.
   */
  cwd: string;
  /**
   * Who answers approval requests. Omitted, the session decides for itself with
   * the allow-once policy below and never blocks.
   */
  permissions?: PermissionResolver;
  /**
   * Who shows the agent's questions to a person.
   *
   * **Its presence is what declares the capability**, and that derivation is
   * honest here where it would not be for `fs`: this daemon can always perform a
   * write, so "able" and "advertised" are separable there and the gate needs its
   * own value. Nothing can stand in for somebody's opinion, so "nobody can
   * answer" and "do not tell the agent it can ask" are one fact.
   *
   * Omitted — as `harness.ts` and the offline drivers leave it — the agent is
   * never handed `AskUserQuestion` at all, rather than being handed it and
   * refused. See `LaunchOptions.elicitation`.
   */
  elicitations?: ElicitationResolver | null;
  /**
   * Where to run the agent. Omitted, it runs as a child process of this daemon —
   * which is what `harness.ts` and the offline drivers want, and what the daemon
   * itself did before containers.
   */
  runtime?: SessionRuntime;
  /**
   * Where an image the agent returns is kept.
   *
   * **Synchronous, and it has to be.** This is called from inside the agent's own
   * notification handler — the emit path, which never awaits — so the sink mints
   * an id and returns immediately while the bytes are written on their own. Given
   * none, an image renders as it always did, as the string `[image]`: the drivers
   * and `harness.ts` have no disk to put anything on, and losing a picture is the
   * right degradation for them.
   */
  keepImage?: (mime: string, data: string) => StoredFileRef | null;
  /**
   * Whether to ask claude for its `ultracode` session flag — xhigh effort plus
   * standing workflow orchestration.
   *
   * A boolean rather than a `_meta` blob on purpose: what a caller may ask for is
   * a *setting this daemon has measured*, and `sessionMetaFor` in `acp/agents.ts`
   * is the only thing that decides what that turns into on the wire. Passing the
   * blob through would make every call site a place a vendor shape can be
   * invented.
   *
   * Ignored by every agent but claude, and unset it asks for nothing at all.
   */
  ultracode?: boolean;
  /**
   * Which system this session's traffic reaches, or omitted for the harness's
   * own default.
   *
   * ⚠ **A {@link SystemId}, never a URL or a header** — the same shape and the
   * same argument as {@link ultracode} being a boolean: what a caller may ask
   * for is an entry in a table this daemon measured, and `acp/systems.ts` is the
   * only thing that decides what it turns into on the wire. Passing routing
   * through would make every call site a place a base URL can be invented, over
   * a daemon reachable from the internet.
   *
   * Omitted, or naming the harness's native system, nothing is configured at
   * all — see `applySystem`.
   */
  system?: SystemId | null;
  /**
   * Which model to run, or omitted for the agent's own default.
   *
   * ⚠ **Applied two different ways and it is not a choice this file makes.** A
   * *native* pairing selects it over ACP, after `session/new`, because that is
   * where the agent publishes its own list. A *routed* one cannot: claude does
   * not publish `kimi-k2-thinking` and never will, so the id is named at spawn
   * from `routedModelEnv` and the agent publishes it back. Which door applies is
   * decided by the table, not here.
   */
  model?: string | null;
}

export interface ResumeOptions extends SessionOptions {
  /** The agent's own session id, from a previous run's `session/new`. */
  agentSessionId: string;
}

/**
 * Raised when the agent no longer holds the conversation being resumed.
 *
 * Distinct from {@link ResumeUnsupportedError} — that agent *cannot* reattach to
 * anything, this one simply does not have this particular one — and the
 * difference matters to the caller: the first is a fact about the binary and is
 * re-checked when it changes, the second is a fact about the world that no
 * amount of retrying will alter.
 */
export class SessionForgottenError extends Error {
  constructor(
    displayName: string,
    readonly agentSessionId: string,
  ) {
    super(
      `${displayName} no longer has the conversation ${agentSessionId}. The transcript here ` +
        "is intact, but the agent cannot be put back on it.",
    );
    this.name = "SessionForgottenError";
  }
}

/**
 * This agent cannot be pointed at the system it was asked for.
 *
 * ⚠ **Its existence is the point: there is no fallback arm.** An agent that
 * answers `providers/set` with `methodNotFound`, or that has no credential
 * stored for the system, must not quietly run on its own default — that is a
 * session billed to the wrong account, running a model nobody chose, with the
 * chip on screen naming the one they did.
 *
 * ⚠ **It does *not* fail before a worktree exists**, and an earlier draft of this
 * comment claimed it did. Measured 2026-08-25: `registry.create` resolves the
 * workspace and writes the session row before `managed.start()` is called at all,
 * so a refusal here leaves a session carrying its own exit — exactly what
 * `agent_auth_required` has always left, and the reason `AgentAvailability`
 * exists to catch the commoner case earlier. Moving the *key* half up into
 * `create` would be cheap and is not done here: the routing half needs a spawned
 * agent to answer, so only one of the two could move, and a check that fires
 * early for some refusals and late for others is worse to reason about than one
 * that always fires in the same place.
 */
export class SystemRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemRoutingError";
  }
}

/** Raised when an agent cannot pick up one of its own earlier sessions. */
export class ResumeUnsupportedError extends Error {
  constructor(displayName: string) {
    super(
      `${displayName} does not support session/resume. The session's transcript is intact, ` +
        "but this agent cannot be reattached to it.",
    );
    this.name = "ResumeUnsupportedError";
  }
}

/**
 * A single agent session: spawn, prompt, normalized event stream, clean shutdown.
 *
 * One session owns one agent process. Routing goes through `sessionId` anyway, so
 * several sessions *could* share one `AcpClient` without reshaping the callers —
 * which is a property of the design rather than a plan. This said "the daemon
 * will later multiplex", stated as fact on the central class here, and `multiplex`
 * appeared at that one line and nowhere else in the tree: no entry in
 * `docs/DECISIONS.md`, no open question, no rule. A reader looking for the
 * half-built other half would have found nothing.
 */
export class Session {
  private readonly queue = new EventQueue();
  /** Tool calls that have already reported their diffs. See `emitDiffs`. */
  private readonly diffedToolCalls = new Set<string>();
  private unregister: (() => void) | null = null;
  private unsubscribeLogs: (() => void) | null = null;
  private turnActive = false;
  private disposed: Promise<void> | null = null;
  /**
   * The agent's current mode/model/effort state.
   *
   * Held here rather than pushed through `queue` because the queue only drains
   * while a prompt generator is being consumed — the same reason the registry,
   * not this file, appends permission events. An `agent_config` pushed there
   * would sit stranded until the next turn, which is precisely when a client
   * most wants to have already drawn the controls.
   */
  private config: AgentConfig = { modes: null, options: [] };
  private readonly configListeners = new Set<(config: AgentConfig) => void>();
  /**
   * How full the agent's context window is.
   *
   * Held and announced exactly like `config` above, and for a stronger version of
   * the same reason — see the `usage_update` arm of `onUpdate`. A separate field
   * and a separate listener rather than a member of `AgentConfig`, because that
   * type means "what a caller may change" and this is not changeable.
   *
   * `null` until the agent says. Kimi may never say at all, which is why every
   * consumer has to treat "cannot tell" as its own answer rather than as zero.
   */
  private usage: ContextUsage | null = null;
  private readonly usageListeners = new Set<(usage: ContextUsage) => void>();
  /**
   * What the agent says it will answer to a leading slash.
   *
   * Held out of band for the reason `config` above is, and one stronger.
   * Measured 2026-08-03 against claude-agent-acp 0.63.0, this notification is
   * scheduled with `setTimeout(…, 0)` *after* `newSession` / `forkSession` /
   * `resumeSession` / `loadSession` have already returned — so it arrives
   * **always** outside a turn, and usually before anybody has prompted at all,
   * which is exactly the case `EventQueue` strands. It landed in `onUpdate`'s
   * `default:` arm until now, i.e. as an `other` event, which that queue evicts
   * first on overflow and no client renders.
   *
   * There is nothing to seed it from: `NewSessionResponse` carries no commands
   * field, which is why `adopt` sets `modes` and `options` and not this.
   */
  private commandState: AgentCommands = { commands: [], dropped: 0 };
  private readonly commandListeners = new Set<(commands: AgentCommands) => void>();

  /** Where the agent runs. Kept because {@link clearContext} opens another session here. */
  private cwd = "";

  /**
   * What was attached to the request that opened this conversation.
   *
   * Kept for the same reason `cwd` is: {@link clearContext} opens *another*
   * conversation on this same process, and a flag that arrived at `session/new`
   * and then silently did not arrive at the one replacing it would make `/clear`
   * a way to turn a setting off without saying so.
   */
  private sessionMeta: Record<string, unknown> | undefined;

  private constructor(
    readonly agent: AgentId,
    /**
     * The agent's own id for this conversation, and **not** readonly.
     *
     * It moves exactly once per {@link clearContext}, to an id *we* minted and
     * therefore know. It is emphatically not tracking the agent behind our back:
     * measured 2026-08-05, the CLI's own `/clear` forks underneath the protocol
     * and never tells anyone, which is precisely why the daemon carries the
     * command out itself rather than forwarding it.
     */
    public sessionId: string,
    private readonly client: AcpClient,
    private readonly permissions: PermissionResolver | null,
    /**
     * See {@link SessionOptions.elicitations}.
     *
     * `null` here is not "decline for them" — it is why the capability was never
     * declared, so the agent has no tool to reach for and this handler is
     * unreachable in practice. It still refuses rather than inventing an answer,
     * because a declaration is a statement and only a gate is a gate.
     */
    private readonly elicitations: ElicitationResolver | null,
    /** See {@link SessionOptions.keepImage}. Synchronous by contract. */
    private readonly keepImage: ((mime: string, data: string) => StoredFileRef | null) | undefined,
  ) {}

  /** Resolves when the ACP connection closes, for any reason. */
  get exited(): Promise<void> {
    return this.client.closed;
  }

  /**
   * Forget everything said so far, and keep working.
   *
   * **The daemon carries `/clear` out itself rather than forwarding it**, and
   * that is the whole point. Measured 2026-08-05 against claude 0.63.0: sending
   * `/clear` to the CLI makes it fork to a fresh conversation *underneath* the
   * protocol — our session id does not change, the file it names keeps the
   * pre-clear history, and the live conversation gets an id nobody tells us. The
   * consequences were both real and both silent: the next boot's
   * `session/resume` reattached to the conversation the fork left behind, so a
   * codeword somebody had cleared came back word for word.
   *
   * Opening a session ourselves removes the cause instead of chasing it. The id
   * arrives in the response, so nothing can rot; the result is exactly the state
   * a freshly created session in this directory has, which is the best-understood
   * state there is; and it needs no per-agent knowledge, because `session/new` is
   * the one verb every ACP agent must implement. On kimi — which has no `/clear`
   * at all and answers "Unknown ACP command" — the command starts working for the
   * first time.
   *
   * Measured cost: ~600ms, on the **same** agent process. No relaunch, no
   * handshake; only the session is new.
   *
   * Two things have to be put back afterwards, both measured rather than assumed.
   * The new session starts at the agent's defaults, so mode and effort are
   * re-applied from what this one was set to — otherwise clearing the context
   * would silently reset somebody's plan mode. And the old session stays alive
   * and answering, so it is closed where the agent supports it, or one is leaked
   * per clear.
   */
  async clearContext(): Promise<{ previous: string; next: string }> {
    const previous = this.sessionId;
    const opened = await withDeadline(
      this.client.agent.request(acp.methods.agent.session.new, {
        cwd: this.cwd,
        mcpServers: [],
        // The conversation is replaced; what was asked *of the agent* about it is
        // not. See {@link Session.sessionMeta}.
        ...metaParam(this.sessionMeta),
      }),
      NEW_SESSION_TIMEOUT_MS,
      "session/new (clear)",
    );

    const next = opened.sessionId;
    // Re-key before anything can be addressed to the new id. `registerSession`
    // returns its own unregister, so the old registration is dropped explicitly
    // rather than left to be overwritten — the router is keyed by id, and the
    // two ids are different.
    this.unregister?.();
    this.sessionId = next;
    this.unregister = this.client.registerSession(next, this.handlers());

    const wanted = this.config;
    this.config = {
      modes: toModes(opened.modes),
      options: toConfigOptions(opened.configOptions),
    };

    /*
     * Closed on a best-effort basis, and after the swap rather than before.
     *
     * Before, a failure would leave this session pointing at a conversation it
     * had just abandoned. Best-effort because the alternative is refusing a
     * clear that has already happened — the new session exists either way, and a
     * leaked one inside the agent is a smaller problem than a daemon and an
     * agent disagreeing about which conversation is live.
     */
    if (this.client.supportsSessionClose()) {
      await withDeadline(
        this.client.agent.request(acp.methods.agent.session.close, { sessionId: previous }),
        CLOSE_TIMEOUT_MS,
        "session/close (clear)",
      ).catch(() => {});
    }

    await this.restoreConfig(wanted);
    return { previous, next };
  }

  /**
   * Puts back the mode and options a cleared session was carrying.
   *
   * Only what actually differs, and each failure swallowed: this runs after the
   * clear has already succeeded, and refusing to answer because one knob would
   * not go back would be reporting a failure that did not happen. A knob the new
   * session does not offer at all is skipped rather than forced — the agent
   * decides what it exposes, and claude drops `bypassPermissions` from its modes
   * under root.
   *
   * **Public because `/clear` is no longer the only conversation this daemon
   * replaces underneath a person.** `ManagedSession.applyUltracode` does the
   * structurally identical thing — `stop` then `resume`, a fresh conversation on
   * the same session — and had no restore at all, so the mode somebody chose came
   * back as whatever the new process published. The rules are here rather than
   * copied there, because two answers to one question start to differ.
   *
   * ⚠ **Both withdrawal guards read the *new* conversation's own list.** The
   * option guard used to read `option.choices` — the list off the same object the
   * value came from — so the predicate was true by construction and the rule this
   * docblock describes never fired: a value the new conversation no longer offers
   * was sent anyway, refused, and swallowed at the `.catch`. Benign after a
   * `/clear`, where the two conversations are one agent moments apart; not benign
   * on the restart path, where the agent may be a new binary with a different
   * vocabulary. The mode had no guard at all, which is the sharper omission —
   * `bypassPermissions` under root is a *mode*, and it is this docblock's own
   * example.
   */
  async restoreConfig(wanted: AgentConfig): Promise<void> {
    for (const option of wanted.options) {
      const now = this.config.options.find((candidate) => candidate.id === option.id);
      if (now === undefined || now.value === option.value) continue;
      if (now.kind === "select" && !now.choices.some((c) => c.value === option.value)) continue;
      await this.setConfigOption(option.id, option.value).catch(() => {});
    }
    const mode = wanted.modes?.current;
    if (mode === undefined || this.config.modes === null || this.config.modes.current === mode) return;
    if (!this.config.modes.available.some((available) => available.id === mode)) return;
    await this.setMode(mode).catch(() => {});
  }

  /** How to signal the agent, and how to recognise it after a restart. */
  get handle(): AgentHandle | null {
    return this.client.handle;
  }

  /**
   * What this agent will let a caller change, and what it is set to now.
   *
   * Read once after `start`/`resume` and then kept current through
   * {@link onConfigChanged}. Always complete — see `AgentConfigEvent`.
   */
  get agentConfig(): AgentConfig {
    return this.config;
  }

  /**
   * What this agent will let us do about which system its traffic reaches.
   *
   * Exposed so `agentask.ts` can read it off a spawn it was already paying for:
   * a handshake plus `session/new` is the expensive part, and asking a second
   * process the second question would double the only cost that matters here.
   */
  routing(): Promise<AgentRouting | null> {
    return this.client.routing();
  }

  /**
   * The agent's model control, or `null` where it publishes none (kimi).
   *
   * ⚠ **Found by `category`, never by `id`** — this fleet's standing rule about
   * every agent control. Exposed here rather than re-derived by each caller
   * because there are two with different vocabularies: `agentask.ts` refuses a
   * bad model to a plugin by name, and `Session.start` refuses one by failing
   * the start. What they share is the lookup; what differs is the refusal, so
   * only the lookup is shared.
   */
  get modelOption(): AgentConfigOption | null {
    return this.config.options.find((one) => one.category === "model") ?? null;
  }

  /**
   * Fires whenever the agent's own configuration changes.
   *
   * Both directions land here: a change this daemon asked for, and one the agent
   * made by itself. The second is not hypothetical — claude switches to `plan`
   * from its own hook, and clamps the current mode when a model change makes it
   * unavailable — so a client that rendered only what it last requested would
   * show the wrong mode with no way to notice.
   */
  onConfigChanged(listener: (config: AgentConfig) => void): () => void {
    this.configListeners.add(listener);
    return () => this.configListeners.delete(listener);
  }

  /**
   * How full the context window is, or `null` if this agent has not said.
   *
   * Read once after a listener is attached, for the same reason `agentConfig` is:
   * a subscriber that arrives after the first update would otherwise wait for the
   * next one, and between turns there is no next one.
   */
  get contextUsage(): ContextUsage | null {
    return this.usage;
  }

  /** Fires whenever the agent reports its context occupancy. High frequency — see `updateUsage`. */
  onUsageChanged(listener: (usage: ContextUsage) => void): () => void {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }

  /**
   * Which commands this agent publishes, and how many were clipped off the list.
   *
   * Empty until the agent says — and unlike `agentConfig`, which `adopt` seeds
   * from the `session/new` response, there is no response field to seed this
   * from. A reader that arrives promptly can legitimately see `[]`.
   */
  get agentCommands(): AgentCommands {
    return this.commandState;
  }

  /**
   * Whether this agent takes an `image` block, from what it said at `initialize`.
   *
   * Read live from the client rather than mirrored into a field, because unlike
   * `agentConfig` it cannot change during a session — it is a fact about the
   * agent's build. A resumed session builds a fresh `AcpClient` and therefore
   * re-reads it, which is exactly right: nothing about this should survive a
   * restart, because the CLI on disk may have moved.
   */
  get acceptsImages(): boolean {
    return this.client.acceptsImages();
  }

  /**
   * Fires whenever the agent republishes its command list.
   *
   * More than once per session is normal rather than exceptional: claude pushes
   * a fresh list mid-session as skills are discovered in a subdirectory. Kimi
   * pushes once per session entry and never again, which is why a client cannot
   * fetch once and cache for ever on the strength of having tested one agent.
   */
  onCommandsChanged(listener: (commands: AgentCommands) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  /**
   * The agent's last stderr lines.
   *
   * A `ManagedSession` drains the event queue between turns now, but it
   * deliberately **drops** `agent_log` out of turn — recording every stderr line an
   * idle agent writes would put an unbounded stream into a log that is unbounded by
   * design. So the lines explaining why an idle agent died still do not reach the
   * transcript, and this is still the only way to them.
   */
  recentLogs(): string[] {
    return this.client.recentLogs();
  }

  /**
   * Every `session/update` this agent sends, before `onUpdate` normalizes it.
   *
   * Not filtered by `sessionId`: an update naming a session this client never
   * registered is exactly the kind of thing a measurement needs to see, and the
   * only subscriber is a driver watching one agent it started itself.
   */
  onRawUpdate(listener: NotificationListener): () => void {
    return this.client.onNotification(listener);
  }

  static async start(options: SessionOptions): Promise<Session> {
    if (!isAbsolute(options.cwd)) {
      throw new Error(`cwd must be an absolute path, got "${options.cwd}"`);
    }

    const runtime = options.runtime ?? new LocalRuntime();
    const config = runtime.describe(options.agent);
    const client = await AcpClient.launch(config, await runtime.launch(options.agent, spawnEnvOf(options)), {
      fileIo: runtime.clientFileIo,
      // Derived rather than configured: a question with nobody to answer it has
      // no default, so "no resolver" and "do not tell the agent it can ask" are
      // one fact. See `SessionOptions.elicitations`.
      elicitation: options.elicitations != null,
    });

    try {
      await applySystem(client, options, runtime);
    } catch (error) {
      await client.close();
      throw error;
    }

    let response: acp.NewSessionResponse;
    try {
      response = await withDeadline(
        client.agent.request(acp.methods.agent.session.new, {
          cwd: options.cwd,
          mcpServers: [],
          ...metaParam(sessionMetaOf(options)),
        }),
        LAUNCH_SESSION_TIMEOUT_MS,
        "session/new",
      );
    } catch (error) {
      await client.close();
      if (isAuthRequired(error)) {
        throw new Error(
          `${config.displayName} rejected session/new: authentication required.\n${config.authHint}`,
        );
      }
      throw error;
    }

    const session = Session.adopt(options, client, response.sessionId, response);
    try {
      // A model this agent does not offer fails the start, and there is nothing
      // here to strand: no conversation exists yet, so the only cost of refusing
      // is a session that was never created. `openResumed` weighs the identical
      // sentence differently, which is why `pinNativeModel` answers one rather
      // than throwing it.
      const unpinned = await pinNativeModel(session, options);
      if (unpinned !== null) throw new SystemRoutingError(unpinned);
    } catch (error) {
      await session.dispose();
      throw error;
    }
    return session;
  }

  /**
   * Reattaches a fresh agent process to one of its own earlier sessions.
   *
   * The agent died with the daemon that owned it, but its session id did not: both
   * agents keep their side of it on disk, so a new subprocess can be pointed back
   * at the same conversation. We already hold the transcript, which is why this is
   * `session/resume` (no replay) rather than `session/load` (replays the whole
   * history as notifications, every one of which we would append a second time).
   */
  static async resume(options: ResumeOptions): Promise<Session> {
    const runtime = options.runtime ?? new LocalRuntime();
    try {
      return await Session.openResumed(options, runtime.clientFileIo);
    } catch (error) {
      /*
       * One retry without the file-IO capability, and only for `internalError`.
       *
       * Measured 2026-08-05 against kimi 0.29.2, deterministically: a session
       * **left in plan mode** fails `session/resume` with `-32603` when the
       * client declares `clientCapabilities.fs`, and resumes perfectly without
       * it. Leaving plan mode before the session ends cures it; the mode is one
       * tap away on the composer and is reached for several times an hour, so
       * "left in plan mode" is an ordinary way to end a day rather than a corner.
       *
       * This is not a workaround bolted on beside the design — it is the seam the
       * design keeps. `fileIo` exists precisely so the capability can be
       * declined, `LaunchOptions.fileIo` is required so declining stays a
       * deliberate act, and the cost was measured before any of this: with the
       * capability, kimi made five reverse-RPC calls and claude none; without it,
       * neither made any, and both edit files perfectly well by themselves. What
       * is lost is the `source: "fs_write"` half of a duplicated `file_change`.
       *
       * Narrow on purpose. Only `-32603`, which is the code that was measured —
       * widening it to "any failure we do not understand" would be guessing, and
       * every other way a resume fails is already typed. And only on resume:
       * `session/new` has never failed this way, so extending it there would be
       * speculation too.
       */
      if (!runtime.clientFileIo || !hasRpcCode(error, INTERNAL_ERROR)) throw error;
      return await Session.openResumed(options, false);
    }
  }

  private static async openResumed(options: ResumeOptions, fileIo: boolean): Promise<Session> {
    if (!isAbsolute(options.cwd)) {
      throw new Error(`cwd must be an absolute path, got "${options.cwd}"`);
    }

    const runtime = options.runtime ?? new LocalRuntime();
    const config = runtime.describe(options.agent);
    const client = await AcpClient.launch(config, await runtime.launch(options.agent, spawnEnvOf(options)), {
      fileIo,
      elicitation: options.elicitations != null,
    });

    // Re-applied on every resume, and it has to be: routing lives in the agent
    // *process*, and a resume is a new one. A session that came back unrouted
    // would carry on in the same conversation against a different vendor.
    try {
      await applySystem(client, options, runtime);
    } catch (error) {
      await client.close();
      throw error;
    }

    if (!client.supportsSessionResume()) {
      await client.close();
      throw new ResumeUnsupportedError(config.displayName);
    }

    let response: acp.ResumeSessionResponse;
    try {
      response = await withDeadline(
        client.agent.request(acp.methods.agent.session.resume, {
          sessionId: options.agentSessionId,
          cwd: options.cwd,
          mcpServers: [],
          ...metaParam(sessionMetaOf(options)),
        }),
        LAUNCH_SESSION_TIMEOUT_MS,
        "session/resume",
      );
    } catch (error) {
      await client.close();
      if (isAuthRequired(error)) {
        throw new Error(
          `${config.displayName} rejected session/resume: authentication required.\n${config.authHint}`,
        );
      }
      // Typed here rather than left for the registry to recognise, because this
      // is the ACP boundary and a JSON-RPC code has no business travelling any
      // further in. The caller needs the distinction to decide whether retrying
      // could ever help.
      if (hasRpcCode(error, RESOURCE_NOT_FOUND)) {
        throw new SessionForgottenError(config.displayName, options.agentSessionId);
      }
      throw error;
    }

    const session = Session.adopt(options, client, options.agentSessionId, response);

    /*
     * The model is named to the agent here too, and for a **native** pairing this
     * is the only mechanism there is.
     *
     * ⚠ **This was missing and the loss was total and silent.** `spawnEnvOf`
     * answers `{}` for a native system because `routedModelEnv` fires only for a
     * routed one, and `applySystem` returns at its first line for the same
     * reason — so with no pin nothing named the model to the agent at all, and
     * `SystemRoutingError` cannot fire on a launch that configured nothing.
     * Measured against a peer publishing a `category: "model"` select whose
     * current value is sonnet, with a preset naming opus: started, the session
     * ran opus; resumed, it ran sonnet, with the chip on screen naming opus
     * either way. Q2.215's shape one door further in — the guard is bypassed
     * rather than defeated — and `session/resume` answers with the same
     * `configOptions` `session/new` does, so the list to weigh the model against
     * is already on `modelOption` by the time `adopt` returns.
     *
     * ⚠ **And it does not refuse, which is the whole difference from `start`.**
     * The conversation already exists. A model the CLI has since retired would
     * make every resume of this session fail for ever, and that permanent
     * refusal is exactly the stranding Q2.216 designed away when it chose a
     * demotion over a 502 that never expires. Demoting *quietly* is the other
     * half of the trap and is the defect above, so the answer is neither: pin it
     * when the agent still offers it, and put a sentence in the transcript when
     * it does not. `restoreConfig` skips a choice the new conversation no longer
     * offers for the same reason and swallows the failure; what is new here is
     * that this one is said out loud, because a model is not a knob — it is what
     * the session is billed for.
     */
    let unpinned: string | null;
    try {
      unpinned = await pinNativeModel(session, options);
    } catch (error) {
      // The agent offered the model and then refused the call. Same three
      // choices and the same answer: a live conversation is not torn down over a
      // config option, and a resume that failed here would fail here again.
      unpinned =
        `${options.agent} would not put this conversation back on ` +
        `${JSON.stringify(options.model ?? "")} (${describeError(error)}).`;
    }
    if (unpinned !== null) {
      /*
       * Said in the transcript rather than through `onWarning`, and the two are
       * not interchangeable: a warning reaches whoever is reading the daemon's
       * stdout, and the person this concerns is holding a phone. `error` is the
       * event this daemon already writes about itself when it carries on after
       * something it could not do — `abandonResume` is the same shape — and it is
       * the loud row on purpose, since the alternative considered was refusing
       * the resume outright.
       */
      const current = session.modelOption?.value;
      const running =
        typeof current === "string" && current !== "" ? `running ${current}` : "running this agent's own default";
      session.queue.push({
        type: "error",
        message: `${unpinned} The conversation was resumed anyway, ${running}.`,
        data: { code: "model_not_pinned", model: options.model ?? null },
      });
    }
    return session;
  }

  /**
   * Wires a live ACP session into a `Session`.
   *
   * Shared by `start` and `resume` because everything after the session exists —
   * handler registration, log forwarding, the seed event — is identical, and the
   * two drifting apart is how a resumed session quietly stops reporting file
   * changes.
   */
  private static adopt(
    options: SessionOptions,
    client: AcpClient,
    sessionId: string,
    opened: { modes?: acp.SessionModeState | null; configOptions?: acp.SessionConfigOption[] | null },
    ): Session {
    const session = new Session(
      options.agent,
      sessionId,
      client,
      options.permissions ?? null,
      options.elicitations ?? null,
      options.keepImage,
    );
    session.cwd = options.cwd;
    session.sessionMeta = sessionMetaOf(options);
    session.unregister = client.registerSession(sessionId, session.handlers());
    session.unsubscribeLogs = client.onLog((line) => {
      session.queue.push({ type: "agent_log", line });
    });

    // Both fields, because agents fill in different ones: claude populates
    // `modes` *and* publishes an equivalent `mode` config option, while kimi
    // populates only `configOptions`. Reading one of them is how
    // "kimi has no modes" became folklore — it has four.
    session.config = {
      modes: toModes(opened.modes),
      options: toConfigOptions(opened.configOptions),
    };

    const info = client.initializeResult.agentInfo;
    session.queue.push({
      type: "session_started",
      agent: options.agent,
      sessionId,
      agentInfo: info ? { name: info.name, version: info.version } : null,
      modes: session.config.modes,
    });

    return session;
  }

  /**
   * Changes one of the agent's configuration knobs.
   *
   * Returns the agent's own refreshed view rather than the value that was asked
   * for: `session/set_config_option` answers with the complete option set, and
   * setting one knob genuinely changes others — switching model rebuilds the
   * available modes and can reset the current one. Echoing the request back
   * would show a control state that never existed.
   */
  async setConfigOption(configId: string, value: string | boolean): Promise<AgentConfig> {
    return this.queueConfig(() => this.sendConfigOption(configId, value));
  }

  /**
   * Runs one config change, in its turn.
   *
   * ⭐ **Two changes in flight at once corrupted the held config, and nothing
   * anywhere prevented it.** {@link updateConfig} replaces the option list
   * *wholesale* with whatever the response carried, and setting a model rebuilds
   * the mode and effort lists — so with A and B overlapping, whichever response
   * landed last won, and it had been computed by the agent before the other change
   * existed. The session then reported a configuration that never was, on the
   * snapshot, permanently, until something else happened to touch it.
   *
   * The only thing holding it off was `locked` in `AgentConfigBar`, and that was
   * half a guard: the composer's `/model` and `/effort` menus call
   * `applyConfigChange` directly and never see it, and `pnpm client config` knows
   * of no such thing. So the race was reachable in a browser today, by choosing on
   * the strip and then in the slash menu.
   *
   * Serialized rather than refused, deliberately. A refusal would be one more
   * `busy` for somebody who tapped twice quickly and did nothing wrong, and the
   * ordering a queue gives is exactly what they asked for: the changes apply in
   * the order they were made, and each caller is answered with the state as of its
   * own change.
   *
   * ⚠ **The chain is the reentrancy hazard.** {@link setMode} delegates to a
   * config option when the agent publishes one, so the public methods must queue
   * and the `send*` pair must not: queueing both would have `setMode` wait on a
   * slot it is itself holding, for ever. Same for {@link restoreConfig}, which
   * calls the public methods in a loop and is therefore never queued as a whole —
   * each of its steps takes its own turn.
   */
  private async sendConfigOption(configId: string, value: string | boolean): Promise<AgentConfig> {
    const response = await withDeadline(
      this.client.agent.request(
        acp.methods.agent.session.setConfigOption,
        typeof value === "boolean"
          ? { sessionId: this.sessionId, configId, type: "boolean", value }
          : { sessionId: this.sessionId, configId, value },
      ),
      SET_CONFIG_TIMEOUT_MS,
      `session/set_config_option (${configId})`,
    );
    this.updateConfig({ options: toConfigOptions(response.configOptions) });
    return this.config;
  }

  /**
   * Switches permission/plan mode.
   *
   * Routed through `session/set_config_option` when the agent publishes a
   * mode-category option, which both supported agents do, because that call
   * answers with the refreshed state while `session/set_mode` answers with
   * nothing at all — its response type carries only `_meta`. The bare
   * `session/set_mode` is the fallback for an agent that offers `modes` and no
   * equivalent option, and there the new state has to be assumed.
   */
  async setMode(modeId: string): Promise<AgentConfig> {
    return this.queueConfig(() => this.sendMode(modeId));
  }

  /** {@link setMode}'s body, already holding its turn. See {@link sendConfigOption}. */
  private async sendMode(modeId: string): Promise<AgentConfig> {
    const option = this.config.options.find((candidate) => candidate.category === "mode");
    if (option !== undefined && option.kind === "select") {
      // The **unqueued** one, and this line is the reason the split exists: the
      // public `setConfigOption` would wait on the slot this call is holding.
      return this.sendConfigOption(option.id, modeId);
    }
    await withDeadline(
      this.client.agent.request(acp.methods.agent.session.setMode, {
        sessionId: this.sessionId,
        modeId,
      }),
      SET_CONFIG_TIMEOUT_MS,
      `session/set_mode (${modeId})`,
    );
    this.updateConfig({ currentModeId: modeId });
    return this.config;
  }

  /**
   * The tail of the config queue. Never rejects, never carries a value.
   *
   * Both properties are load-bearing. A rejected tail would take every later link
   * with it — one refused change and the control is dead for the life of the
   * session — so the outcome is swallowed *here* while the caller still gets the
   * real one from the promise it was handed. And it carries no value because the
   * answer belongs to whoever asked: each caller is told the state as of its own
   * change, not as of the last one to run.
   */
  private configChain: Promise<void> = Promise.resolve();

  /**
   * Take a turn at rewriting {@link config}. See {@link sendConfigOption} for why.
   *
   * Deliberately unbounded: these come from somebody tapping, each link carries
   * `SET_CONFIG_TIMEOUT_MS` of its own, and a cap would have to answer a refusal to
   * the one caller least able to do anything about it. What bounds a queue in
   * practice is the route's own budget on the far side.
   */
  private queueConfig(run: () => Promise<AgentConfig>): Promise<AgentConfig> {
    // `then(run, run)` rather than `finally`: a link runs whether its predecessor
    // resolved or threw, because one agent refusing a value says nothing about
    // whether the next change is valid.
    const result = this.configChain.then(run, run);
    this.configChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /**
   * Folds a change into the held state and tells everyone.
   *
   * `currentModeId` arrives alone on ACP's `current_mode_update`, so it is
   * merged rather than assigned: the event this feeds is defined as complete
   * state, and a client rebuilding a snapshot from a delta would have to keep a
   * reducer of its own.
   *
   * ⚠ **`options` is replaced, not merged**, which is what made the overlap in
   * {@link sendConfigOption} corrupting rather than merely out of order — and it
   * is right: ACP defines the response's `configOptions` as the complete list, so
   * merging would keep a control the agent has just withdrawn. The queue is what
   * makes "complete" true of the state we hold, by never letting a stale complete
   * list arrive after a fresh one.
   */
  private updateConfig(change: { options?: AgentConfigOption[]; currentModeId?: string }): void {
    let modes = this.config.modes;
    let options = change.options ?? this.config.options;

    if (change.currentModeId !== undefined) {
      const modeId = change.currentModeId;
      if (modes !== null) modes = { ...modes, current: modeId };
      // Keep the mode-category option in step, so the two ways of expressing the
      // same fact cannot disagree on screen.
      options = options.map((option) =>
        option.category === "mode" && option.kind === "select" && option.choices.some((c) => c.value === modeId)
          ? { ...option, value: modeId }
          : option,
      );
    } else if (change.options !== undefined && modes !== null) {
      /*
       * The same sync, in the direction that was missing.
       *
       * Every path that carries fresh options — `config_option_update`, and the
       * response to every `set_config_option`, which is how a mode change is
       * actually made on both supported agents — left `modes.current` at
       * whatever it was. So the two expressions of one fact disagreed the moment
       * anybody switched mode: `options` said `plan`, `modes.current` still said
       * `default`, and both go out on the snapshot and on `session_started`.
       *
       * Latent rather than visible today only because `AgentConfigBar` happens
       * to read the option. That is not a property worth relying on when the
       * field is published.
       */
      const current = options.find((option) => option.category === "mode" && option.kind === "select");
      if (
        current !== undefined &&
        typeof current.value === "string" &&
        current.value !== modes.current &&
        modes.available.some((mode) => mode.id === current.value)
      ) {
        modes = { ...modes, current: current.value };
      }
    }

    this.config = { modes, options };
    for (const listener of this.configListeners) {
      try {
        listener(this.config);
      } catch {
        // A broken listener must not stop the others, and must not propagate
        // into an agent notification handler. Same guard as `SessionLog.append`.
      }
    }
  }

  /**
   * Records the agent's command list, and tells everyone.
   *
   * **Assigned whole, never merged.** ACP defines the notification as a full
   * replacement and the adapter's own comment tells clients to replace their
   * cached list; merging would keep offering a command the agent has since
   * withdrawn, and the agent would then refuse the thing its own menu offered.
   */
  private updateCommands(commands: AgentCommands): void {
    this.commandState = commands;
    for (const listener of this.commandListeners) {
      try {
        listener(this.commandState);
      } catch {
        // Same guard, same reason as `updateConfig` above: a broken listener must
        // not stop the others or propagate into an agent notification handler.
      }
    }
  }

  /**
   * Records what the agent said about its context window.
   *
   * Validated before it is stored, because the agent is a party this daemon does
   * not trust: a `used` of `NaN` or `-1` would propagate through the snapshot into
   * a client's percentage and render as something between nonsense and a crash.
   * A notification that fails the check is dropped whole rather than half-stored,
   * so the last good reading survives — an unreadable update is not evidence the
   * previous one stopped being true.
   *
   * A non-positive `size` is kept as 0 rather than rejected: "the agent reported
   * occupancy but not a window" is a real state, and 0 is what every consumer
   * already has to read as "cannot tell" because it is the one value they must not
   * divide by.
   *
   * `_meta` is deliberately dropped, which costs `_claude/rateLimit` — the reason a
   * turn is stalled. Worth carrying one day; not worth an unbounded agent-shaped
   * blob on a snapshot returned sixty at a time.
   */
  private updateUsage(update: acp.UsageUpdate): void {
    const used = Number(update.used);
    const size = Number(update.size);
    if (!Number.isFinite(used) || used < 0 || !Number.isFinite(size)) return;

    const rawCost = update.cost as { amount?: unknown; currency?: unknown } | null | undefined;
    const amount = Number(rawCost?.amount);
    const cost =
      rawCost && Number.isFinite(amount) && typeof rawCost.currency === "string"
        ? { amount, currency: rawCost.currency.slice(0, 8) }
        : null;

    this.usage = { used, size: size > 0 ? size : 0, cost };
    for (const listener of this.usageListeners) {
      try {
        listener(this.usage);
      } catch {
        // Same guard, same reason: this runs inside the agent's notification
        // handler, and one broken subscriber must not cost the others their update.
      }
    }
  }

  /**
   * Sends a prompt and streams the turn's events.
   *
   * The iterator ends on `turn_end` or `error`. Events produced outside a turn
   * (agent logs, the initial `session_started`) queue up and are delivered at
   * the head of the next turn.
   */
  async *prompt(
    text: string,
    /**
     * Blocks to send after the text: `resource_link`s for staged files, and an
     * `image` for each one the agent said it would take. Built by the caller, not
     * here — this layer knows the protocol and not what a person attached.
     *
     * Defaulted so `harness.ts`, the regression test for the untouched default
     * paths, keeps compiling and keeps driving exactly the shape it always did.
     */
    extra: readonly acp.ContentBlock[] = [],
  ): AsyncGenerator<SessionEvent, void, void> {
    if (this.turnActive) {
      throw new Error("a prompt is already in flight for this session");
    }
    this.turnActive = true;

    /*
     * The queue is taken **before** the request is fired, and the order is the
     * rule rather than the tidiness.
     *
     * Between this statement and the RPC below there is no await, so no other
     * reader can be resumed in between — which is what makes "a turn's own
     * `turn_end` can never be delivered to the idle drain" a property of the
     * ordering. Reversed, an idle drain parked on `next()` would be the one holding
     * the queue when the agent's first update arrived, and the turn would yield
     * nothing at all.
     */
    const claim = this.queue.claimForTurn();

    void this.client.agent
      .request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        /*
         * The text block is dropped when there is no text.
         *
         * A message that is only a screenshot is legitimate — `server.ts` allows
         * it as long as something came with it — and sending `{type:"text",
         * text:""}` alongside the link would hand the agent an empty turn to
         * interpret. The route guarantees this array is never empty: text and
         * attachments cannot both be absent.
         */
        prompt: text.length === 0 ? [...extra] : [{ type: "text", text }, ...extra],
      })
      .then(
        (response) => {
          // A run that the turn's own end interrupts still owes its final block —
          // `onUpdate` cannot flush it, because there is no next update.
          this.flushToolDraft();
          this.queue.push({
            type: "turn_end",
            stopReason: response.stopReason,
            usage: response.usage ?? null,
          });
        },
        (error: unknown) => {
          this.flushToolDraft();
          this.queue.push({
            type: "error",
            message: describeError(error),
            data: error instanceof acp.RequestError ? { code: error.code, data: error.data } : null,
          });
        },
      )
      .finally(() => {
        this.turnActive = false;
      });

    /*
     * `finally` rather than a release after the loop, because a consumer that
     * breaks out of its `for await` calls `gen.return()` — which runs this — and a
     * cancelled turn has to hand the queue back as reliably as a finished one.
     */
    try {
      for (;;) {
        const event = await this.queue.next(claim);
        /*
         * Displaced. Reachable rather than defensive: `turnActive` is cleared in
         * the RPC's own `.finally` *before* the `turn_end` it produced has been
         * drained — `doDispose` relies on that ordering — so a second `prompt()`
         * can pass the guard above and claim the queue under this one. Returning is
         * what makes that graceful: this generator ends, its `release` below is
         * identity-checked and no-ops, and the new turn keeps what it took.
         */
        if (event === null) return;
        yield event;
        if (event.type === "turn_end" || event.type === "error") return;
      }
    } finally {
      this.queue.release(claim);
    }
  }

  /**
   * Read what the agent says when no turn is being consumed.
   *
   * **The bug this closes: an agent goes on emitting after its turn has ended, and
   * nobody was reading.** `session/prompt` resolves while claude drives background
   * work, the generator above returns on `turn_end`, and everything after it was
   * pushed into a queue with no consumer — held until the *next* prompt started a
   * new generator, which then drained the whole backlog in one microtask cascade.
   * Measured on a live log: 294,907 ms of silence, then 57 events stamped inside a
   * 2 ms span, whose content was five minutes of the agent saying it was waiting.
   * Past `MAX_BUFFERED_EVENTS` it was not even held — it was evicted.
   *
   * Synchronous on the way in, and that is what makes it displaceable rather than
   * racy: the claim is taken before this returns, so a prompt starting in the next
   * microtask displaces this reader deterministically instead of overwriting it.
   * A `null` claim means a turn already owns the queue and there is nothing to do,
   * which is why the caller may call this without knowing whether one has started.
   *
   * Deliberately **not** wired up by `Session` itself. A bare `Session` — `harness`,
   * the Session-level drivers — behaves exactly as it always did, which is what
   * keeps `harness` a regression test for the untouched default paths. Only
   * `ManagedSession` attaches one.
   */
  drainBetweenTurns(onEvent: (event: SessionEvent) => void): void {
    const claim = this.queue.claimForIdle();
    if (claim === null) return;
    void (async () => {
      for (;;) {
        const event = await this.queue.next(claim);
        // Displaced by a turn, or the session is gone. `CLOSED` is compared by
        // identity and never recorded: it is a sentence this daemon writes about
        // itself, and a closed queue answers it synchronously and for ever, so a
        // reader that carried on would spin the microtask queue for the life of the
        // process.
        if (event === null || event === CLOSED) return;
        try {
          onEvent(event);
        } catch {
          // Swallow, and **do not** evict the listener — the deliberate inverse of
          // `SessionLog.append`'s fan-out guard one file over, which is the thing
          // somebody will copy. There it has many listeners and dropping a broken
          // one costs that client its seq; here there is exactly one consumer, and
          // dropping it silences everything this session says for the rest of the
          // agent's life.
        }
      }
    })();
  }

  /**
   * Ask the agent to abandon the turn in flight, and stay running.
   *
   * The same notification `doDispose` has always sent, reached by a second door
   * and deliberately through the same private method rather than a second
   * `notify` call — `session/cancel` is written down in exactly one place, so
   * "every RPC that writes to agent stdin is bounded" is a property of that place
   * and not of two call sites agreeing.
   *
   * **It asks and does not force**, and returning `void` is how that is said out
   * loud. ACP defines cancellation as a notification: there is no response, the
   * promise resolves when the bytes are written, and an agent that ignores the
   * message goes on working. Whether the turn actually ended is a *later* and
   * separate question — {@link awaitTurnEnd} — because in between the caller has
   * something it must do first.
   *
   * **That something is answering anything the agent has parked on a human.** ACP
   * says a client which has cancelled MUST respond to a pending
   * `session/request_permission` with `cancelled`, and until it does, an agent
   * blocked on one is not executing anything that could notice this notification
   * at all. Folding the wait in here would therefore have timed out every single
   * time on exactly the sessions most worth cancelling. The answer is the
   * registry's to give because the registry holds the promise — see
   * `ManagedSession.cancelTurn`, the only caller of either method.
   */
  async cancelTurn(): Promise<void> {
    await this.sendCancel();
  }

  /**
   * Resolves `true` if the turn really ended, `false` if it had not by the budget.
   *
   * `false` is "not yet", never "refused" — nothing here can tell those apart, and
   * nothing escalates on it. What forces is {@link dispose}, a different verb with
   * a different cost.
   */
  awaitTurnEnd(timeoutMs: number = CANCEL_SETTLE_MS): Promise<boolean> {
    return this.waitForTurnToSettle(timeoutMs);
  }

  private sendCancel(): Promise<void> {
    return withTimeout(
      this.client.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: this.sessionId,
      }),
      CANCEL_SEND_TIMEOUT_MS,
    );
  }

  /**
   * Cancels any in-flight turn, closes the session if the agent supports it, and
   * shuts the process down.
   */
  async dispose(): Promise<void> {
    this.disposed ??= this.doDispose();
    return this.disposed;
  }

  private async doDispose(): Promise<void> {
    // Both RPCs below write to the agent's stdin, and the SDK puts no timeout on
    // that write: an agent that has stopped reading its pipe — a wedged tool, a
    // dead inner process, a full pipe buffer — parks them forever. Everything
    // that actually terminates the process is downstream of here, so an unbounded
    // await is the difference between a clean stop and an orphan nobody can see.
    //
    // The cancel goes out unconditionally rather than only when `turnActive`,
    // because that flag is cleared before the `turn_end` it produced is drained —
    // a dispose arriving in that window used to skip the graceful path entirely.
    try {
      await this.sendCancel();
      if (this.turnActive) await this.waitForTurnToSettle(CANCEL_GRACE_MS);
    } catch {
      // The connection may already be gone; the kill path below still runs.
    }

    if (this.client.supportsSessionClose()) {
      try {
        await withTimeout(
          this.client.agent.request(acp.methods.agent.session.close, {
            sessionId: this.sessionId,
          }),
          CLOSE_TIMEOUT_MS,
        );
      } catch {
        // Best effort — closing stdin ends the session either way.
      }
    }

    this.unregister?.();
    this.unsubscribeLogs?.();
    // Before the close, so a session torn down mid-run does not take the only
    // complete copy of that run's block with it. The queue drains only inside a
    // turn, so this is best-effort in exactly the way every other event is here.
    this.flushToolDraft();
    // The close is in a `finally` because an idle drain is parked on this queue and
    // `CLOSED` is the only thing that ends it. `dispose()` memoises, so a throw here
    // is sticky and no later call retries — which would leave that reader parked for
    // the life of the process.
    try {
      await this.client.close();
    } finally {
      this.queue.close();
    }
  }

  private handlers(): SessionHandlers {
    return {
      onUpdate: (notification) => this.onUpdate(notification),
      onPermission: (request, signal) => this.onPermission(request, signal),
      onReadTextFile: (request) => this.onReadTextFile(request),
      onWriteTextFile: (request) => this.onWriteTextFile(request),
      onElicitation: (request, signal) => this.onElicitation(request, signal),
    };
  }

  /**
   * Hand the agent's question to whoever is going to answer it.
   *
   * Two refusals before anything is parked, and both are `invalidParams` rather
   * than a fabricated `{action: "decline"}` — nobody declined, and measured
   * against claude's adapter an RPC error is also the kindest of the three
   * answers, because it becomes `{behavior: "deny", message: …}` and the model
   * carries on knowing why.
   *
   * The first is the form itself: {@link toElicitationForm} throws on a shape
   * this daemon will not render or will not carry, and its message names the cap.
   * The second is having no resolver at all, which cannot happen through the
   * daemon — the capability is derived from the resolver's presence, so the agent
   * was never handed the tool — but *is* reachable if somebody wires
   * `LaunchOptions.elicitation` on by hand, and a statement is not a gate.
   */
  private async onElicitation(
    request: ElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse> {
    if (!this.elicitations) {
      throw acp.RequestError.invalidParams(
        {},
        "nobody is attached to this session who could answer a question",
      );
    }

    let form: ElicitationForm;
    try {
      form = toElicitationForm(request.requestedSchema);
    } catch (error) {
      if (error instanceof ElicitationRefusedError) {
        throw acp.RequestError.invalidParams({}, error.message);
      }
      throw error;
    }

    return this.elicitations(
      {
        toolCallId: request.toolCallId ?? null,
        message: request.message,
        form,
      },
      signal,
    );
  }

  /**
   * A tool's arguments being typed, held back until they stop growing.
   *
   * **The model streams a tool call's *input* into the content channel, one token
   * at a time, and every block is a strict extension of the last.** Measured
   * 2026-08-13 against this daemon's own database: one `Write` produced a
   * `tool_call` and then **715** `tool_call_update`s whose only content block grew
   * from `{` to the finished input JSON — followed by that JSON once more beside
   * the `rawInput` it belongs to, and then the single line that is actually a
   * result. Across every session on that machine those superseded blocks are
   * **15.4% of all events and 55.8% of all bytes**: written to SQLite, replayed
   * down every socket, and paged back over the relay to a phone.
   *
   * Nothing renders them. The transcript folds a run back to its final form
   * (`supersedes` in `tail.ts`), so what all that traffic buys is one block that
   * the *next* event supersedes.
   *
   * Held rather than dropped, because the last block of a run is the only one that
   * is complete, and a tool whose output really is cumulative would lose it. What
   * is *not* held is anything carrying news: a status change, a title, arguments,
   * locations or images go out at once. That is what keeps the spinner honest —
   * `EventList` draws `in_progress` as a spinning `Loader` and `pending` as a
   * static glyph, so holding the update that first says `in_progress` would leave
   * a long write looking like it had not started.
   *
   * ⚠ **This is the same rule as `tail.ts`'s `supersedes`, stated a second time,
   * and the duplication is deliberate rather than overlooked.** `packages/web`
   * cannot import from `src/`. The two are not required to agree, and the drift
   * that matters can only go one way: the client's fold is the *guarantee* — every
   * transcript already on disk carries the full 715 and always will — while this
   * is an optimisation on top of it. A daemon that suppresses less costs bytes; a
   * daemon that suppressed *more* than the client could fold would lose content,
   * which is why this holds instead of dropping.
   */
  private toolDraft: {
    toolCallId: string;
    /**
     * The longest block seen for this call, held or pushed — or `null` when the
     * last thing sent for it carried no single block.
     *
     * Nullable rather than `""`, and the difference is not cosmetic: every string
     * starts with the empty one, so an empty base makes the *first* block after a
     * status-only update look like an extension of something and holds it back for
     * no reason. There is nothing to be a draft of until a block has actually gone
     * out.
     */
    block: string | null;
    /** The status last *pushed* for it, so a transition is never held back. */
    status: acp.ToolCallStatus | null;
    /** The event waiting to go out, or `null` when the last one was pushed. */
    held: Extract<SessionEvent, { type: "tool_call_update" }> | null;
  } | null = null;

  /**
   * Send the held draft, if there is one.
   *
   * Called before **every** other event this session emits, and before `turn_end`,
   * `error` and shutdown — so a run that is never followed by another update still
   * puts its final block in the log. Ordering inside the call is preserved: the
   * draft is always older than whatever is being emitted now.
   */
  private flushToolDraft(): void {
    const draft = this.toolDraft;
    if (draft?.held == null) return;
    const event = draft.held;
    draft.held = null;
    this.queue.push(event);
  }

  /**
   * Hold this update if it says nothing but "the arguments are one token longer".
   *
   * Returns `true` when it has been held and must not be pushed.
   */
  private holdsToolDraft(event: Extract<SessionEvent, { type: "tool_call_update" }>): boolean {
    // Exactly one block and nothing else on the event: anything richer is news.
    if (event.content?.length !== 1) return false;
    const block = event.content[0];
    if (block === undefined) return false;
    if (event.title !== null || event.rawInput !== null) return false;
    if (event.locations.length > 0 || event.images !== null) return false;
    const draft = this.toolDraft;
    if (draft === null || draft.block === null || draft.toolCallId !== event.toolCallId) return false;
    // A status the caller has not seen yet is news, whatever the content says.
    if (event.status !== draft.status) return false;
    // The rule itself, and it is a **strict** extension: an exactly repeated block
    // is a tool that printed the same thing twice, which is content rather than a
    // draft of anything.
    if (block.length <= draft.block.length || !block.startsWith(draft.block)) return false;
    draft.block = block;
    draft.held = event;
    return true;
  }

  private onUpdate(notification: acp.SessionNotification): void {
    const update = notification.update;
    // Everything that is not a tool-call update ends any run in progress, so the
    // held block cannot arrive after an event that was emitted later than it.
    if (update.sessionUpdate !== "tool_call_update") this.flushToolDraft();
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk":
      case "user_message_chunk":
        this.queue.push({
          type: "text",
          role: update.sessionUpdate === "user_message_chunk" ? "user" : "agent",
          thought: update.sessionUpdate === "agent_thought_chunk",
          text: renderContentBlock(update.content),
        });
        return;

      case "tool_call": {
        // Bounded once, here, and used for the `file_change` records too — see
        // `boundToolCallId`. `toolCallLineage` still reads the *raw* id, because
        // its only use for it is the "a call cannot run inside itself" test,
        // which has to compare what the agent actually sent.
        const toolCallId = boundToolCallId(update.toolCallId);
        this.queue.push({
          type: "tool_call",
          toolCallId,
          title: update.title,
          kind: update.kind ?? "other",
          status: update.status ?? "pending",
          locations: toLocations(update.locations),
          rawInput: update.rawInput ?? null,
          ...toolCallLineage(update),
        });
        this.emitDiffs(toolCallId, update.content);
        return;
      }

      case "tool_call_update": {
        // Collected as the blocks are rendered, so an image leaves the prose and
        // arrives on the event in one pass.
        const images: StoredFileRef[] = [];
        /*
         * `rawOutput` only where the blocks carried nothing, which is the whole
         * rule and is what keeps one command from being reported twice.
         *
         * Measured against codex-acp 1.1.9: a finished command arrives as
         * `{status, rawOutput: {formatted_output, exit_code}}` and **no content
         * block at all** — its stdout lives in `rawOutput`, in `_meta`, or behind
         * a `type: "terminal"` handle, none of which `toolOutput` reads. So every
         * Bash card on a codex session showed the command, a tick, and nothing
         * else: the daemon dropped output the agent had already sent. claude puts
         * the same bytes in a `content` block *and* sets `rawOutput`, so
         * preferring the blocks is what stops it appearing twice there.
         */
        const content =
          toolOutput(update.content, this.keepImage, images) ?? rawToolOutput(update.rawOutput);
        // Bounded once, here, for the reason `boundToolCallId` gives — and with
        // the same function the `tool_call` arm uses, so a call and its updates
        // still land on the same string and `toolDraft` keeps matching them.
        const toolCallId = boundToolCallId(update.toolCallId);
        const event: Extract<SessionEvent, { type: "tool_call_update" }> = {
          type: "tool_call_update",
          toolCallId,
          title: update.title ?? null,
          status: update.status ?? null,
          locations: toLocations(update.locations),
          // ACP carries arguments here too, and this arm did not copy them — so an
          // agent that announces a bare call and fills the arguments in afterwards
          // lost them completely.
          rawInput: update.rawInput ?? null,
          content,
          images: images.length === 0 ? null : images,
          // Only the edge, not `subagent`: measured 2026-08-01, claude drops that
          // flag on a spawn's completing update, so carrying it here would say
          // "not a subagent any more" about the call that just finished being one.
          parentToolCallId: toolCallLineage(update).parentToolCallId,
        };
        /*
         * The arguments being typed. Held, not pushed — see `toolDraft`.
         *
         * **The `update.content?.length === 1` guard is on the *raw* blocks and is
         * not the same test `holdsToolDraft` makes.** That one asks about the
         * rendered `content`, which is text only: `toolOutput` drops a `diff`
         * block, so a raw `[{text}, {diff}]` renders to a single string, passes the
         * hold, and takes the `emitDiffs` call below with it — losing a
         * `file_change` for a patch that really was written. Requiring the raw
         * array to be one block means anything arriving *beside* the text is
         * emitted rather than held.
         *
         * `emitDiffs` is skipped with the held event by the same logic: a held
         * update is one this session has not emitted, and it has, by that guard,
         * nothing but the text block. The flush that eventually sends it is
         * followed by the update that ends the run, whose own `emitDiffs` runs
         * against the finished content.
         */
        if (update.content?.length === 1 && this.holdsToolDraft(event)) return;
        this.flushToolDraft();
        this.queue.push(event);
        // Whatever this call's newest block and status are, they are now the ones
        // the reader has seen — which is what the next update is judged against.
        this.toolDraft = {
          toolCallId: event.toolCallId,
          block: event.content?.length === 1 ? (event.content[0] ?? null) : null,
          status: event.status,
          held: null,
        };
        this.emitDiffs(toolCallId, update.content);
        return;
      }

      case "plan":
        this.queue.push({ type: "plan", entries: update.entries });
        return;

      // Not queued, for the reason `this.config` documents: the queue drains
      // only inside a turn, and a mode change most often arrives outside one.
      case "current_mode_update":
        this.updateConfig({ currentModeId: update.currentModeId });
        return;

      case "config_option_update":
        this.updateConfig({ options: toConfigOptions(update.configOptions) });
        return;

      // Not queued either, and for the sharpest version of the reason: measured,
      // both adapters schedule this on a `setTimeout(…, 0)` *after* answering
      // `session/new`, so it is guaranteed to arrive outside a turn and almost
      // always before the first prompt exists to drain the queue.
      case "available_commands_update":
        this.updateCommands(toCommands(update.availableCommands));
        return;

      // Not queued either, and for a stronger version of the same reason. A mode
      // change arrives outside a turn; this arrives *thousands of times inside
      // one* — measured 2026-07-31 against claude-agent-acp 0.63.0, it is emitted
      // from the `message_delta` handler on every streaming token. The queue would
      // be the wrong place even if it drained, so it goes out of band and the
      // registry decides how often a client hears about it.
      case "usage_update":
        this.updateUsage(update);
        return;

      default:
        this.queue.push({
          type: "other",
          sessionUpdate: update.sessionUpdate,
          raw: update,
        });
    }
  }

  /**
   * Permission policy: allow once.
   *
   * Prefer an `allow_once` option, fall back to `allow_always`, and cancel if the
   * agent offers neither. The event is emitted either way, carrying the option
   * list and the decision — that round trip is what the real client will own.
   */
  private async onPermission(
    request: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    /*
     * **Refused whole rather than trimmed**, and this is the one arm where that
     * is the only honest answer. An `optionId` round-trips verbatim in the
     * response below, so clipping one produces an answer the agent will not
     * recognise; dropping an option removes a choice the agent offered, which is
     * the thing the client's `permissionLayout` gives up a *layout* rather than an
     * option to avoid, one layer up. So a card past the cap is declined *to the agent*, which is a sentence
     * it can act on, rather than silently altered into one nobody can answer.
     *
     * `invalidParams` and never `methodNotFound`, matching the elicitation
     * refusals: the capability is present and this particular request is not
     * renderable.
     */
    const oversized =
      request.options.length > MAX_PERMISSION_OPTIONS ||
      request.options.some((option) => option.optionId.length > MAX_PERMISSION_OPTION_ID_CHARS);
    if (oversized) {
      throw acp.RequestError.invalidParams(
        `this client renders at most ${MAX_PERMISSION_OPTIONS} permission options, ` +
          `each with an optionId of at most ${MAX_PERMISSION_OPTION_ID_CHARS} characters`,
      );
    }

    /*
     * **Carried exactly as sent, then the pair is weighed as one thing.**
     *
     * Neither string is shortened any more — see the constants for why clipping
     * `name` broke `askedQuestion`'s identity match against `rawInput` — so what
     * bounds them is the byte measure below, taken *after* projection so it counts
     * what would actually ride `SessionSnapshot` rather than what arrived.
     */
    const options: PermissionOptionSummary[] = request.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    }));
    const title = request.toolCall.title ?? request.toolCall.toolCallId;
    /*
     * Refused rather than trimmed, for the reason the option cap above is: this is
     * the pair that rides the snapshot, and a card nobody can read is better
     * declined *to the agent* — which is a sentence it can act on — than delivered
     * silently shortened. `invalidParams`, matching every other refusal on this
     * path and on the elicitation one.
     */
    const weight = jsonBytes(title) + jsonBytes(options);
    if (weight > MAX_PERMISSION_SNAPSHOT_BYTES) {
      throw acp.RequestError.invalidParams(
        `a permission's title and options come to at most ${MAX_PERMISSION_SNAPSHOT_BYTES} bytes, ` +
          `and this one is ${weight}`,
      );
    }
    const choice =
      request.options.find((option) => option.kind === "allow_once") ??
      request.options.find((option) => option.kind === "allow_always") ??
      null;

    // Hand the decision off only when there is something a human could actually
    // pick. An agent offering no actionable option falls through to the cancel
    // below, as it always has — parking a resolver there would block the agent on
    // a request that no answer can clear.
    if (this.permissions && choice) {
      return this.permissions(
        {
          toolCallId: request.toolCall.toolCallId,
          title,
          options,
          rawInput: request.toolCall.rawInput ?? null,
          content: request.toolCall.content ?? null,
        },
        signal,
      );
    }

    this.queue.push({
      type: "permission_request",
      permissionId: null,
      toolCallId: request.toolCall.toolCallId,
      title,
      options,
      decision: choice?.optionId ?? null,
    });

    if (!choice) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: choice.optionId } };
  }

  private async onReadTextFile(
    request: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    // Used as given. This read happens in the *daemon*, on a path the agent
    // chose — which used to be a trust boundary and is not one now: the agent is
    // a child of this process with this process's uid, so a path refused here is
    // a path it can read for itself with one syscall. What is left is a service,
    // and refusing to perform it would be theatre.
    const path = request.path;

    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      throw acp.RequestError.resourceNotFound(
        `${request.path}: ${describeError(error)}`,
      );
    }

    if (request.line == null && request.limit == null) return { content };

    const lines = content.split("\n");
    const start = Math.max((request.line ?? 1) - 1, 0);
    const end = request.limit == null ? lines.length : start + request.limit;
    return { content: lines.slice(start, end).join("\n") };
  }

  /**
   * Performs the write and reports it.
   *
   * This is a real write, not a notification hook — when an agent routes file IO
   * through the client, the client is the only thing that touches the disk.
   *
   * The path is used as given, and that is a decision rather than an omission.
   * It runs in the daemon on a path the agent chose, which was a route out of a
   * sandbox while there was a sandbox; there is none now and the agent could
   * make this write itself. What survives from that era is the *gate* —
   * `SessionRuntime.clientFileIo`, which `AcpClient` enforces by answering
   * `methodNotFound` rather than merely not advertising — because that is the
   * seam a confining runtime would use, and `LaunchOptions.fileIo` is required so
   * deleting it at either call site is a type error.
   *
   * Worth keeping from the measurement that closed it: claude and kimi edit
   * files perfectly well with this capability declined, so re-declining costs
   * almost nothing — only the `source: "fs_write"` half of the duplicated `file_change`
   * pair.
   */
  private async onWriteTextFile(
    request: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    const path = request.path;

    const oldText = await readFile(path, "utf8").catch(() => null);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, request.content, "utf8");

    this.queue.push({
      type: "file_change",
      // The host path, like every other path on the wire: a client asking the
      // Changes API about this file has to be talking about the same one.
      path,
      oldText,
      newText: request.content,
      source: "fs_write",
      toolCallId: null,
    });
    return {};
  }

  /**
   * Turns `diff` content on a tool call into file-change events.
   *
   * A single edit is reported twice by the Claude adapter: once on the initial
   * `tool_call`, derived from the tool's input, and again on a later
   * `tool_call_update`, derived from the resulting patch. The two differ in
   * trailing whitespace, so content-equality does not deduplicate them. The
   * first update carrying diffs for a tool call wins — later ones are dropped,
   * which also keeps every hunk of a multi-hunk patch, since those all arrive
   * together in one content array.
   */
  private emitDiffs(
    toolCallId: string,
    content: acp.ToolCallContent[] | null | undefined,
  ): void {
    const diffs = (content ?? []).filter((item) => item.type === "diff");
    if (diffs.length === 0 || this.diffedToolCalls.has(toolCallId)) return;
    this.diffedToolCalls.add(toolCallId);

    for (const item of diffs) {
      this.queue.push({
        type: "file_change",
        // The path the agent named, unchanged. It used to go through a
        // translation here, because the agent's filesystem and the daemon's were
        // different namespaces and a path from one meant nothing in the other.
        // They are the same filesystem now, so there is nothing to translate and
        // nothing that can fail to translate. The Changes API remains the
        // authoritative answer for what a session changed; this is the reporting
        // half of the pair, on the agent's own RPC handler, where nothing may
        // block.
        path: item.path,
        oldText: item.oldText ?? null,
        newText: item.newText,
        source: "diff",
        toolCallId,
      });
    }
  }

  /**
   * Resolves `true` when the turn really settled, `false` when the budget ran out.
   *
   * The answer is the whole reason this is not a bare `Promise<void>` any more.
   * `doDispose` throws it away and is right to — what follows it kills the process
   * either way — but {@link cancelTurn} reports to a person, and "the agent stopped"
   * and "the agent has not answered yet" are the two things they need told apart.
   */
  private waitForTurnToSettle(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (!this.turnActive) {
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  }
}

/**
 * What a reader is handed when the queue it was waiting on has closed.
 *
 * A module constant so it can be recognised by **identity**. A closed queue
 * answers `next()` synchronously and for ever, so a reader that matched on the
 * message would spin the microtask queue for the life of the process the moment
 * it got this back — and a reader that *recorded* it would put a sentence this
 * daemon writes about itself into a transcript as though the agent had said it.
 */
const CLOSED: SessionEvent = Object.freeze({
  type: "error",
  message: "session closed",
  data: null,
});

/**
 * Whether this is the sentence above rather than something an agent said.
 *
 * ⚠ **By identity, and exported because the turn generator yields it.**
 * `drainBetweenTurns` recognises it and stops; the turn loop does not, so a
 * session disposed mid-turn hands its pump an `error` event that looks exactly
 * like a provider failure and is in fact this daemon taking the agent away. The
 * pump has to tell them apart before it writes anything about *why* the turn
 * ended — `agent_error` on a deliberate teardown would be the daemon blaming the
 * agent for its own act.
 *
 * Identity and never the message: the string is prose, and matching it would make
 * an agent that happens to say "session closed" indistinguishable from this.
 */
export function isSessionClosed(event: SessionEvent): boolean {
  return event === CLOSED;
}

/**
 * A single-consumer async queue of events, whose consumer may change hands.
 *
 * **Ownership is checked rather than assumed, and that is the whole of this
 * class's complexity.** `next()` used to park its resolver in `waiting`
 * unconditionally, so a second consumer silently overwrote the first: the
 * displaced reader's promise never settled, which is a hang rather than a
 * mismatch — and a hang inside `daemoncheck` or `harness`, which consume
 * {@link Session.prompt} as a generator on a bare `Session`.
 *
 * A claim is a monotonic number. Taking one wakes whoever held the last with
 * `null`, and `next()` answers `null` for a claim that is no longer current, so a
 * reader that was *already* resumed cannot take one more event on its way out.
 * A turn outranks an idle drain — `claimForIdle` refuses while a turn holds it,
 * and `claimForTurn` refuses a queue a turn already holds rather than displacing
 * it, because the asymmetric version can strand `turnHolds` with no owner able to
 * clear it, which silently returns the session to buffering with nothing saying
 * so.
 */
class EventQueue {
  private readonly buffered: SessionEvent[] = [];
  private waiting: ((event: SessionEvent | null) => void) | null = null;
  private closed = false;
  /** Bumped by every claim, so a stale reader is recognisable by number. */
  private reader = 0;
  /** Whether the current claim belongs to a turn, which nothing may displace. */
  private turnHolds = false;

  /**
   * Take the queue for a turn.
   *
   * Called synchronously *before* the `session/prompt` RPC is fired, which is what
   * makes "a turn's own `turn_end` can never reach the idle drain" a property of
   * the ordering rather than a hope: between the claim and the request there is no
   * point at which another reader can be resumed.
   */
  claimForTurn(): number {
    if (this.turnHolds) throw new Error("a turn already holds this session's events");
    this.turnHolds = true;
    return this.handover();
  }

  /** Take the queue between turns, or answer `null` because a turn has it. */
  claimForIdle(): number | null {
    if (this.turnHolds) return null;
    return this.handover();
  }

  /**
   * Give the queue back.
   *
   * Identity-checked, and that is load-bearing rather than tidy: a stale release
   * clearing `turnHolds` under a *live* turn would route that turn's events to the
   * drain, park its generator for ever and pin `ManagedSession.turn`, so the
   * session answers `409 turn_in_flight` for the rest of its life.
   */
  release(claim: number): void {
    if (claim !== this.reader) return;
    this.turnHolds = false;
  }

  private handover(): number {
    this.reader += 1;
    const displaced = this.waiting;
    this.waiting = null;
    displaced?.(null);
    return this.reader;
  }

  push(event: SessionEvent): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(event);
      return;
    }
    this.buffered.push(event);
    if (this.buffered.length <= MAX_BUFFERED_EVENTS) return;

    // What this still bounds is narrower than it was. A `ManagedSession` attaches
    // a drain between turns, so the unread window is the gap between `adopt` and
    // `onStarted`, plus any bare `Session` (`harness`, the Session-level drivers)
    // where nothing drains between turns at all and an idle agent writing to
    // stderr would otherwise grow this without limit. Evict only what is safe to
    // lose: dropping a `text` or `file_change` would leave a transcript that reads
    // as complete and is not, which is worse than the leak. If there is nothing
    // droppable, record the loss rather than hide it.
    const droppable = this.buffered.findIndex(
      (candidate) => candidate.type === "agent_log" || candidate.type === "other",
    );
    if (droppable >= 0) {
      this.buffered.splice(droppable, 1);
      return;
    }
    this.buffered.shift();
    this.buffered.push({
      type: "error",
      message: "event dropped: session queue overflow",
      data: null,
    });
  }

  /**
   * The next event, `null` for a reader that has been displaced, or {@link CLOSED}.
   *
   * The staleness test is the **first** statement for a reason: a displaced reader
   * whose promise was already resolved with an event is still inside its own loop,
   * and without this it would come back and take one more from a queue it no
   * longer owns — delivering an event to a turn that had ended, or to a drain a
   * turn had just displaced.
   */
  next(claim: number): Promise<SessionEvent | null> {
    if (claim !== this.reader) return Promise.resolve(null);
    const buffered = this.buffered.shift();
    if (buffered) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(CLOSED);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  close(): void {
    this.closed = true;
    const resolve = this.waiting;
    this.waiting = null;
    resolve?.(CLOSED);
  }
}

/**
 * Waits for `promise`, giving up after `timeoutMs`.
 *
 * Never rejects: callers use it to bound best-effort teardown RPCs, where the
 * only thing that matters is that control comes back.
 */
function withTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  const settled = promise.then(
    () => undefined,
    () => undefined,
  );
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([settled, expired]).finally(() => clearTimeout(timer));
}

/**
 * Bounds an RPC whose *answer* is wanted, and fails loudly when it does not come.
 *
 * The sibling above is for teardown, where the only thing that matters is that
 * control comes back; this one is for a request a person is waiting on, where
 * silently resolving would report a mode change that never happened.
 */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${timeoutMs / 1000}s`)), timeoutMs);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function hasRpcCode(error: unknown, code: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

/**
 * Whether a launch failure was the agent saying it is not signed in.
 *
 * ⚠ **Matched on the message because that is all there is**, and exported so
 * there is one copy of that concession rather than two. `Session.start` and
 * `Session.resume` rewrap the ACP refusal with the agent's own `authHint` and
 * throw a plain `Error` — no typed class survives the rewrap — so every caller
 * that wants to tell "not signed in" from "would not start" has to read the
 * sentence. `registry.ts` was doing exactly this inline, and `agentask.ts` needed
 * the same answer for a different vocabulary (`502 agent_auth_required` there, a
 * plugin-facing `model_agent_signed_out` here). Two regexes for one fact is how
 * one of them comes to be missing a word the other has.
 *
 * Here rather than in `registry.ts` because this file is where the message is
 * *written*, and both callers already import from it — the dependency runs the
 * right way for both.
 */
export function isAuthRequiredMessage(message: string): boolean {
  return /authentication required/i.test(message);
}

function isAuthRequired(error: unknown): boolean {
  return hasRpcCode(error, AUTH_REQUIRED);
}

/**
 * The files a tool call says it touched.
 *
 * ⚠ **Bounded here, and it used to be bounded nowhere.** `estimateBytes` charged
 * neither `tool_call` nor `tool_call_update` for this array and `truncateEvent`
 * cut it on neither, so a large one produced an event whose stored size and
 * charged size disagreed without limit — see `MAX_TOOL_LOCATIONS`. Both halves
 * are needed: the terms in `events.ts` make the event's size *honest*, and this
 * makes it *small*.
 *
 * Truncated rather than refused, unlike a permission's options: nothing here
 * round-trips to the agent and nothing acts on a location, so a shorter list is
 * a smaller answer to the same question rather than a different one.
 */
function toLocations(
  locations: acp.ToolCallLocation[] | null | undefined,
): FileLocation[] {
  return (locations ?? []).slice(0, MAX_TOOL_LOCATIONS).map((location) => ({
    // Reporting, like `emitDiffs`: an unmappable path is shown as the agent
    // named it rather than dropped, and nothing acts on it. Textual for the same
    // reason — this is reached from `onUpdate`, on the emit path.
    path: clip(location.path, MAX_TOOL_LOCATION_CHARS),
    line: location.line ?? null,
  }));
}

/**
 * A tool call's own id, bounded at ingest.
 *
 * ⚠ **The sibling field was bounded and this one was not.**
 * `MAX_PARENT_ID_CHARS` in `acp/subagents.ts` exists because `truncateEvent`
 * spreads `parentToolCallId` through untouched on both tool-call arms, so an
 * unshrinkable field with no ceiling walks an event straight past the per-event
 * cap. `toolCallId` is the *same agent-chosen string* — claude's parent id is
 * byte-for-byte the parent's own `toolCallId` — sits on the same two events, is
 * charged for by `estimateBytes` through `idSize`, and had no ceiling anywhere:
 * one event could therefore carry megabytes past the 128 KiB cap, into the
 * per-session byte budget and into the WS queue's `MAX_QUEUE_BYTES`, collapsing
 * an attached socket and reporting `slow_consumer` about a client that was never
 * slow.
 *
 * Clipped rather than refused, which is the opposite of what
 * `MAX_PARENT_ID_CHARS` does with an over-long value — because there is no
 * "none" to fall back to here: the field is what identifies the call, and
 * dropping the event loses a tool call outright. Clipping is safe because the
 * id is never typed by a person and never sent back to the agent; it only
 * correlates our own events with each other, and `clip` is deterministic, so a
 * call and every later update for it still land on the same string.
 */
function boundToolCallId(id: string): string {
  return clip(id, MAX_PARENT_ID_CHARS);
}

/** What this daemon asks the agent for at the door, from what the caller asked for. */
function sessionMetaOf(options: SessionOptions): Record<string, unknown> | undefined {
  return sessionMetaFor(options.agent, { ultracode: options.ultracode === true });
}

/**
 * Select the model on a pairing that reaches its system natively.
 *
 * ⚠ **Native only, and the asymmetry is the design rather than an omission.** A
 * routed pairing was pointed at its model at spawn (`routedModelEnv`) and the
 * agent has already published it back as its current value; asking again would
 * be a second mechanism racing the first. A native one has to ask, because the
 * list is the agent's and only exists once the agent has answered the call that
 * opens a conversation — either of them.
 *
 * ⚠ **Validated against what this agent just published, never against a cache.**
 * `agentask.ts` makes the same argument for the same reason: a list can be ten
 * minutes old and a CLI update retires a model in between, so the check that
 * counts is against the agent standing in front of us.
 *
 * ⚠ **Both launch paths, and for a long time only one.** `session/resume`
 * publishes the same `configOptions` `session/new` does, and a native pairing is
 * pointed at its model by nothing else — no `ROUTED_MODEL_ENV`, no
 * `providers/set` — so a resume that skipped this ran the agent's own default
 * with nothing anywhere saying so. The pin belongs to the *process*, and a
 * resume is a new one, exactly as `applySystem` already says of routing.
 *
 * ⚠ **It answers a sentence rather than throwing one, because its two callers
 * disagree about what an un-pinnable model means.** `Session.start` refuses:
 * nothing exists yet to strand, and carrying on with the default is a session
 * running a model nobody chose while the chip on screen names the one they did.
 * `Session.openResumed` cannot refuse — the conversation is already there, and a
 * model the CLI has since retired would make every resume of it fail for ever,
 * which is the permanent refusal Q2.216 chose a demotion over. So the decision
 * is the caller's and the wording is not: one sentence, said two ways.
 *
 * `null` means the model is the agent's current one, and it is also the answer
 * when there was nothing to pin at all.
 */
async function pinNativeModel(session: Session, options: SessionOptions): Promise<string | null> {
  const model = options.model ?? null;
  const system = options.system ?? null;
  if (model === null || model === "") return null;
  if (system !== null && SYSTEMS[system].nativeHarness !== options.agent) return null;

  /*
   * ⚠ **The one place a stored model id is respelled, and it is the last moment
   * before the agent is asked.** Everything upstream — the route, the row in
   * `custom_agents`, the wire — carries the endpoint's own slug, so a preset says
   * one thing whichever harness runs it. opencode is the only harness today that
   * spells a native id differently, prefixing `openrouter/`, and putting that
   * back here rather than at save time is what keeps a preset re-pointable: an
   * edit that swaps the harness must not have to rewrite the model.
   *
   * Idempotent on purpose. An id that already carries the prefix is left alone,
   * so a value that reached the store the long way round — a hand-written row, an
   * older client that stored what the agent published — pins instead of failing
   * with the prefix doubled.
   */
  const prefix = system === null ? null : SYSTEMS[system].nativeModelPrefix;
  const wanted = prefix === null || model.startsWith(prefix) ? model : `${prefix}${model}`;

  const option = session.modelOption;
  if (option === null) return `${options.agent} offers no choice of model on this machine.`;
  if (!option.choices.some((one) => one.value === wanted)) {
    const names = option.choices.map((one) => one.value);
    const shown = names.slice(0, MODEL_NAMES_IN_PIN_REFUSAL).join(", ");
    const rest =
      names.length > MODEL_NAMES_IN_PIN_REFUSAL ? `, and ${names.length - MODEL_NAMES_IN_PIN_REFUSAL} more` : "";
    // The full stop is the documented form of this sentence — `agents.ts` draws
    // it with one and `.claude/rules/agent-systems.md` writes it with one — and
    // it is load-bearing here for a second reason: the resume notice appends a
    // clause saying what the session came back on, and two sentences need a
    // boundary between them.
    return (
      `${options.agent} has no model called ${JSON.stringify(wanted)}` +
      `${names.length === 0 ? "" : ` — it offers ${shown}${rest}`}.`
    );
  }
  await session.setConfigOption(option.id, wanted);
  return null;
}

/** How many model names a pin refusal lists before it stops counting. */
const MODEL_NAMES_IN_PIN_REFUSAL = 8;

/**
 * What the agent process is started with beyond its own environment.
 *
 * Empty for every native pairing, which is every session this daemon has ever
 * started until now.
 */
function spawnEnvOf(options: SessionOptions): NodeJS.ProcessEnv {
  const system = options.system ?? null;
  const model = options.model ?? null;
  if (system === null || model === null || model === "") return {};
  return routedModelEnv(options.agent, system, model);
}

/**
 * Point this agent at the system it was asked for, before any session exists.
 *
 * ⚠ **Between the handshake and `session/new`, and that window is the whole
 * mechanism.** Both adapters that implement this say the configuration is
 * process-scoped and applies to sessions created *after* the call — which is
 * exactly the lifetime this daemon has, since it spawns one adapter per session.
 * Nothing has to be undone and nothing leaks into a neighbouring conversation,
 * because there are no neighbours.
 *
 * ⚠ **`providerId` comes off the agent's own answer.** Measured 2026-08-25:
 * claude calls it `main`, codex calls it `custom-gateway`. Written down, this
 * would configure one agent and hand the other an `invalid_params` about a
 * provider it has never heard of.
 *
 * ⚠ **The credential goes here rather than into the environment this daemon
 * spawns — which is one hop, and not the secrecy an earlier draft claimed.** An
 * agent runs as this uid and can print its own environment into a transcript that
 * is appended to the log and rendered in a browser. Measured against the pinned
 * adapter: `claude-agent-acp` 0.63.0 folds these headers back into
 * `ANTHROPIC_CUSTOM_HEADERS` on the CLI it spawns, so the key does touch a process
 * table, one below this one, where `agentEnv` cannot reach it. See
 * `acp/systems.ts` for the measurement and for what would actually close it.
 */
async function applySystem(
  client: AcpClient,
  options: SessionOptions,
  runtime: SessionRuntime,
): Promise<void> {
  const system = options.system ?? null;
  if (system === null) return;
  const spec = SYSTEMS[system];
  // Native needs no configuring — the agent already reaches it, and replacing
  // its own routing with a copy would swap an OAuth token for a pasted key.
  if (spec.nativeHarness === options.agent) return;

  const routing = await client.routing();
  const refusal = hostable(options.agent, system, routing);
  if (refusal !== null) throw new SystemRoutingError(refusal);
  // `hostable` returning null with a null routing is unreachable for a
  // non-native system — it refuses on `routing === null` — but the compiler
  // cannot see that, and an assertion here would be a second place the rule
  // lives. Re-reading it is one branch.
  if (routing === null || spec.baseUrl === null) {
    throw new SystemRoutingError(`${spec.displayName} cannot be reached from this agent.`);
  }

  const secret = runtime.systemSecret(system);
  if (secret === null) {
    throw new SystemRoutingError(
      `No key is saved for ${spec.displayName} on this machine, so nothing can sign these requests.`,
    );
  }

  try {
    await withDeadline(
      client.setProvider({
        providerId: routing.providerId,
        apiType: spec.apiType,
        baseUrl: spec.baseUrl,
        headers: routingHeaders(system, secret),
      }),
      SET_CONFIG_TIMEOUT_MS,
      "providers/set",
    );
  } catch (error) {
    // Rewritten rather than rethrown, because what reaches a screen otherwise is
    // a JSON-RPC code about a method nobody on the far side has heard of.
    throw new SystemRoutingError(
      `${client.config.displayName} refused to route to ${spec.displayName}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * `_meta` as a spreadable, so a request carries no such key when there is nothing
 * to say.
 *
 * `{_meta: undefined}` is not the same message as `{}`: it survives
 * `JSON.stringify` as an absent key here but is a present-and-undefined property
 * to anything reading the object first, and the agent on the far side is somebody
 * else's code. Spreading nothing is the form with no such question.
 */
function metaParam(meta: Record<string, unknown> | undefined): { _meta?: Record<string, unknown> } {
  return meta === undefined ? {} : { _meta: meta };
}

function toModes(modes: acp.SessionModeState | null | undefined): AgentModes | null {
  if (modes == null) return null;
  return {
    current: modes.currentModeId,
    available: modes.availableModes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      description: mode.description ?? null,
    })),
  };
}

/**
 * Flattens ACP's config options into something a client can render blind.
 *
 * The two shapes that need collapsing are the select payload's grouped and
 * ungrouped forms — `SessionConfigSelectOptions` is either a list of values or a
 * list of groups of values, and a client is not the right place to branch on
 * that. Groups survive as a label on each choice, which is all a rendered
 * dropdown needs.
 *
 * Nothing is filtered by id or category. A knob this daemon has never heard of
 * still reaches the UI as a labelled control, which is the point: the agents add
 * these faster than a hardcoded list could follow.
 */
function toConfigOptions(options: acp.SessionConfigOption[] | null | undefined): AgentConfigOption[] {
  return (options ?? []).map((option) => ({
    id: option.id,
    name: option.name,
    description: option.description ?? null,
    category: option.category ?? null,
    kind: option.type,
    value: option.currentValue,
    choices: option.type === "select" ? toChoices(option.options) : [],
  }));
}

/**
 * Flattens and bounds ACP's command list.
 *
 * **Clamped here, at ingest, rather than at the store** — the same placement and
 * the same reason as `MAX_PARENT_ID_CHARS` in `acp/subagents.ts`: these strings
 * are the agent's, and "bounded by whatever the agent sent" is not a bound. The
 * list rides no event, so `truncateEvent` would never see it, and nothing
 * downstream is willing to shrink it.
 *
 * The count cap is set far above anything measured on purpose — 256 against a
 * real 100 — because what it exists for is the pathological case, an MCP server
 * publishing hundreds of prompts, and not to trim a real list. What is cut is
 * *counted* rather than swallowed, for the reason `truncateEvent`'s
 * `agent_config` arm gives: a picker missing a row silently offers the agent less
 * than it supports.
 *
 * A nameless entry is dropped whole rather than half-stored — the rule
 * `updateUsage` follows for an unreadable reading. Duplicates keep the first,
 * because the agent's own order is authoritative and a menu must never offer one
 * name twice.
 *
 * **The name is dropped rather than clipped, and it is the one field that is.**
 * `clip` is a *display* truncator: it appends `…[truncated N bytes]`, which is
 * right for a description nobody types and wrong for a name, because a command
 * is invoked by sending `/<name>` as text. Clipping produced a row reading
 * `/aaaa…[truncated 34 bytes]` that a client would insert into the composer
 * verbatim. Worse, `seen` held the *unclipped* name while the stored one was
 * clipped, so two names sharing their first `MAX_COMMAND_NAME_CHARS - 32`
 * characters became byte-identical and `dropped` reported none — defeating the
 * uniqueness rule directly above and hiding the loss. A name that cannot be
 * typed is not a command, so it is counted into `dropped` like any other cut.
 */
export function toCommands(list: acp.AvailableCommand[] | null | undefined): AgentCommands {
  const commands: AgentCommand[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const entry of list ?? []) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (name.length === 0 || name.length > MAX_COMMAND_NAME_CHARS || seen.has(name)) {
      dropped += 1;
      continue;
    }
    if (commands.length >= MAX_AGENT_COMMANDS) {
      dropped += 1;
      continue;
    }
    seen.add(name);
    const hint = entry.input?.hint;
    commands.push({
      name,
      description: clip(typeof entry.description === "string" ? entry.description : "", MAX_COMMAND_DESCRIPTION_CHARS),
      hint: typeof hint === "string" && hint.length > 0 ? clip(hint, MAX_COMMAND_HINT_CHARS) : null,
    });
  }

  return { commands, dropped };
}

/** Raised when a form is one this daemon will not put in front of anybody. */
export class ElicitationRefusedError extends Error {}

/**
 * Projects ACP's elicitation schema into the fixed shape this system carries.
 *
 * Same placement and the same argument as {@link toCommands} — at ingest, because
 * the agent chooses every string and the alternative bound is no bound. What
 * differs is the *response* to going over: `toCommands` counts a cut into
 * `dropped` and carries on, because a menu missing a row is still a menu. A form
 * missing a question is not a smaller form, it is one whose answer means
 * something else, so this throws and the agent hears why.
 *
 * Normalizing `enum` against `oneOf`, and `items.enum` against `items.anyOf`,
 * happens here rather than in the browser so there is one answer to "what is an
 * option" and the daemon validates the reply against the same list it sent.
 *
 * An option whose `const` is not a string is **dropped, never coerced**:
 * `String(42)` as a wire value is the mistake `parentToolCallId` already names —
 * a value that names something the agent will not recognise. Duplicates keep the
 * first, because a list whose two rows send the same value has one unreachable
 * row.
 *
 * An unknown property type refuses the whole form rather than being skipped. A
 * field nobody can draw is a field somebody's answer will be missing, and the
 * agent should hear that now rather than receive an object with a hole in it.
 *
 * **The SDK's `ElicitationPropertySchema.is*` guards were used here first and
 * were taken back out**, which is worth recording because reaching for them is
 * the obvious move and they are right next to the types. They validate the whole
 * payload rather than the tag, so *any* field they do not expect — a
 * `format: "hostname"`, which is valid JSON Schema and not one of ACP's four; a
 * single `oneOf` entry whose `const` is a number — makes the property match no
 * variant at all, and the form is then refused for a reason that has nothing to
 * do with what this client can draw. Measured: a `type: "string"` carrying one
 * numeric `const` among good ones took the unknown-type arm and refused
 * everything.
 *
 * So the tag decides which arm, and each arm validates only the fields it
 * actually reads — the same rule `toCommands` follows, and the one ACP's own
 * open unions are designed for. Strict about what is used, lenient about what is
 * ignored.
 */
export function toElicitationForm(schema: acp.ElicitationSchema | null | undefined): ElicitationForm {
  const properties = schema?.properties ?? {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const fields: ElicitationField[] = [];

  for (const [key, property] of Object.entries(properties)) {
    if (fields.length >= MAX_ELICITATION_FIELDS) {
      throw new ElicitationRefusedError(
        `this client renders at most ${MAX_ELICITATION_FIELDS} form fields`,
      );
    }
    fields.push(toElicitationField(key, property, required.has(key)));
  }

  const form: ElicitationForm = { fields };
  // The backstop the per-item caps cannot be: they bound one string, this bounds
  // a thousand of them. Measured after projecting, so it counts what would
  // actually be carried rather than what arrived.
  if (jsonBytes(form) > MAX_ELICITATION_FORM_BYTES) {
    throw new ElicitationRefusedError(
      `this form is larger than the ${MAX_ELICITATION_FORM_BYTES} bytes this client will carry`,
    );
  }
  return form;
}

function toElicitationField(
  key: string,
  property: acp.ElicitationPropertySchema,
  required: boolean,
): ElicitationField {
  const base = {
    key,
    title: textOrNull(property.title),
    description: textOrNull(property.description),
    required,
  };

  // Read off the untyped view: the tag chooses the arm, and each arm reads only
  // what it uses. See the note on the guards above the function.
  const raw = property as Record<string, unknown>;

  switch (property.type) {
    case "string": {
      const format = raw["format"];
      return {
        ...base,
        kind: "string",
        /*
         * **An empty projection is no options at all, not a choice of nothing.**
         *
         * `toElicitationOptions` answers `[]` — never `null` — whenever `enum` or
         * `oneOf` is an array from which nothing survives: `enum: []`, or a
         * `oneOf` whose every `const` is non-string, which its own docblock names
         * as a measured shape. The array arm below refuses that outright ("a
         * select with no options is a dead end"); the string arm let it through,
         * and the two sides then disagreed about what the field *is*. The client
         * reads `options.length > 0` and draws a free-text box;
         * `validateElicitationContent` reads `options !== null` and refuses every
         * value against an empty list. So Submit lit up and the route answered
         * `400 not_an_option` for anything the person could type — a required
         * field answerable only by Skip or Cancel.
         *
         * Normalizing to `null` makes both sides agree that it is free text: the
         * smaller change, and it keeps a field the agent may only have
         * mis-specified.
         */
        options: emptyToNull(toElicitationOptions(raw["oneOf"], raw["enum"])),
        min: numberOrNull(raw["minLength"]),
        max: numberOrNull(raw["maxLength"]),
        // A hint, enforced by nobody — see `validateElicitationContent` on why
        // the canonical email and uri patterns are worse than no check at all.
        // An unrecognised format is dropped rather than refused, because it says
        // nothing this client acts on.
        format: typeof format === "string" && FORMATS.has(format) ? (format as ElicitationField["format"]) : null,
        default: typeof raw["default"] === "string" ? (raw["default"] as string) : null,
      };
    }

    case "number":
    case "integer":
      return {
        ...base,
        kind: property.type,
        options: null,
        min: numberOrNull(raw["minimum"]),
        max: numberOrNull(raw["maximum"]),
        format: null,
        default: typeof raw["default"] === "number" ? (raw["default"] as number) : null,
      };

    case "boolean":
      return {
        ...base,
        kind: "boolean",
        options: null,
        min: null,
        max: null,
        format: null,
        default: typeof raw["default"] === "boolean" ? (raw["default"] as boolean) : null,
      };

    case "array": {
      const items = (raw["items"] ?? {}) as Record<string, unknown>;
      const options = toElicitationOptions(items["anyOf"], items["enum"]);
      // A free list is a control nothing here draws, and a select with no options
      // is a dead end that eats what somebody typed.
      if (options === null || options.length === 0) {
        throw new ElicitationRefusedError(
          `field ${JSON.stringify(key)} is a list with no choices, which this client cannot draw`,
        );
      }
      return {
        ...base,
        kind: "multi_select",
        options,
        min: numberOrNull(items["minItems"] ?? raw["minItems"]),
        max: numberOrNull(items["maxItems"] ?? raw["maxItems"]),
        format: null,
        default: Array.isArray(raw["default"])
          ? (raw["default"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
          : null,
      };
    }

    default:
      throw new ElicitationRefusedError(
        `field ${JSON.stringify(key)} has type ${JSON.stringify(property.type)}, which this client cannot draw`,
      );
  }
}

/** `[]` and `null` mean different things downstream — see the string arm. */
function emptyToNull(options: ElicitationOption[] | null): ElicitationOption[] | null {
  return options === null || options.length === 0 ? null : options;
}

function toElicitationOptions(titled: unknown, bare: unknown): ElicitationOption[] | null {
  const source: ElicitationOption[] = [];
  if (Array.isArray(titled)) {
    for (const raw of titled) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      // Never coerced: a non-string wire value is one the agent will not
      // recognise coming back, so it is not an option at all. `String(42)` here
      // is the mistake `parentToolCallId` already names one file over.
      if (typeof entry["const"] !== "string") continue;
      const value = entry["const"];
      const title = entry["title"];
      source.push({
        value,
        label: typeof title === "string" && title.length > 0 ? title : value,
        description: textOrNull(entry["description"]),
      });
    }
  } else if (Array.isArray(bare)) {
    for (const value of bare) {
      if (typeof value !== "string") continue;
      source.push({ value, label: value, description: null });
    }
  } else {
    return null;
  }

  const options: ElicitationOption[] = [];
  const seen = new Set<string>();
  for (const option of source) {
    // Refused rather than clipped, for the reason a command's name is: this
    // string goes back to the agent and has to round-trip exactly.
    if (option.value.length > MAX_ELICITATION_VALUE_CHARS) {
      throw new ElicitationRefusedError(
        `an option value is longer than the ${MAX_ELICITATION_VALUE_CHARS} characters this client will carry`,
      );
    }
    if (seen.has(option.value)) continue;
    if (options.length >= MAX_ELICITATION_OPTIONS) {
      throw new ElicitationRefusedError(
        `this client renders at most ${MAX_ELICITATION_OPTIONS} choices per field`,
      );
    }
    seen.add(option.value);
    options.push(option);
  }
  return options;
}

const FORMATS = new Set(["email", "uri", "date", "date-time"]);

/*
 * Both take `unknown`, because `ElicitationPropertySchema`'s open catch-all arm
 * types every field that way and the base fields are read before the guards have
 * narrowed anything. Widening here rather than casting at each of their nine call sites.
 *
 * ⚠ This was `clipOrNull(value, budget)` and the budget is gone, not forgotten —
 * see the elicitation caps. **What survives is the empty-to-null half, and it is
 * the load-bearing half**: `""` and `null` are the same absence to every reader,
 * and letting an empty string through would make `askTitle` in the web client
 * draw a blank heading instead of falling through to the next source.
 */
function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toChoices(options: acp.SessionConfigSelectOptions): AgentConfigChoice[] {
  const choices: AgentConfigChoice[] = [];
  for (const entry of options) {
    if ("group" in entry) {
      // The group's *name* rather than its id: this is a heading to print, and
      // the id is only ever meaningful to the agent that minted it.
      for (const option of entry.options) choices.push(toChoice(option, entry.name));
    } else {
      choices.push(toChoice(entry, null));
    }
  }
  return choices;
}

function toChoice(option: acp.SessionConfigSelectOption, group: string | null): AgentConfigChoice {
  return {
    value: option.value,
    name: option.name,
    description: option.description ?? null,
    group,
  };
}

/**
 * One ACP content block, as text — and images pulled out on the way past.
 *
 * `kept` is an out-parameter rather than a return value because the caller is
 * accumulating a `string[]` and an image contributes no text: the block is
 * removed from the prose and named on the event instead. Given no sink, the old
 * `[image]` placeholder is what comes out, which is what the drivers see.
 */
function renderContentBlock(
  block: acp.ContentBlock,
  keep?: (mime: string, data: string) => StoredFileRef | null,
  kept?: StoredFileRef[],
): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return `[resource_link ${block.uri}]`;
    case "resource":
      return `[resource ${block.resource.uri}]`;
    case "image": {
      const ref = keep?.(block.mimeType, block.data) ?? null;
      if (ref === null) return "[image]";
      kept?.push(ref);
      // No text at all: the picture is on the event now, and a placeholder beside
      // it would render as a stray `[image]` under the image it describes.
      return "";
    }
    default:
      return `[${block.type}]`;
  }
}

/**
 * What the tool said, out of ACP's `content` array.
 *
 * The `diff` half of that array goes to {@link Session.emitDiffs} and becomes
 * `file_change` events; this is the other half, and until now it was thrown away
 * — so a client could show what an agent *ran* and never what it *got back*.
 *
 * Only `{type: "content"}` blocks carrying text survive. `terminal` is a live
 * handle rather than a value: rendering its id would be showing a person a number
 * they cannot use, and following it is a different feature. `diff` is excluded
 * because it already has an event of its own, and carrying it twice would put the
 * same patch in the transcript under two shapes.
 *
 * `null` rather than `[]` when nothing survives, so "the update carried no output"
 * stays distinguishable from "the tool answered with nothing" — a client may
 * legitimately say the second and must not say it for the first.
 */
function toolOutput(
  content: acp.ToolCallContent[] | null | undefined,
  keep?: (mime: string, data: string) => StoredFileRef | null,
  kept?: StoredFileRef[],
): string[] | null {
  if (!content || content.length === 0) return null;
  const blocks: string[] = [];
  /*
   * One budget across the whole array, not one per block.
   *
   * A per-block cap is no cap at all here: nothing stops an agent from sending a
   * thousand blocks, and `MAX_TOOL_OUTPUT_BYTES` is a statement about how much of
   * a tool's output ends up in the transcript rather than about how it was
   * chopped up on the way. Spent in arrival order so the *start* of the output
   * survives, which is where a command says what it did.
   */
  let remaining = MAX_TOOL_OUTPUT_BYTES;
  let images = 0;
  for (const item of content) {
    if (item.type !== "content") continue;
    /*
     * Images are bounded by their own count, and they have to be.
     *
     * `MAX_TOOL_OUTPUT_BYTES` cannot do it: a kept image contributes no text, so
     * `remaining` never moves for one, and the `text.length === 0` skip below
     * runs before the budget test anyway. An update carrying a thousand image
     * blocks therefore did a thousand base64 decodes and three thousand
     * synchronous SQLite queries inside the agent's notification handler — the
     * emit path, which must not block.
     *
     * A count rather than a byte budget because `keepAgentImage` already bounds
     * each one and the session total; what was missing was a bound on how many
     * one update may ask for. Eight is above anything measured (three in one
     * database, all from `Read`) and far below a number that costs a turn.
     */
    if (item.content.type === "image" && images >= MAX_IMAGES_PER_UPDATE) continue;
    const before = kept?.length ?? 0;
    const text = renderContentBlock(item.content, keep, kept);
    images += (kept?.length ?? 0) - before;
    if (text.length === 0) continue;
    if (remaining <= 0) {
      // Visibly, never silently — the same rule `truncateEvent` follows. A reader
      // who sees output stop has to be able to tell "the tool printed no more"
      // from "we declined to carry the rest".
      blocks.push(`…[truncated: tool output exceeded ${MAX_TOOL_OUTPUT_BYTES} bytes]`);
      break;
    }
    // `events.ts`'s own helper, imported rather than copied, so a truncation reads
    // the same wherever it happens.
    blocks.push(clip(text, remaining));
    remaining -= text.length;
  }
  return blocks.length > 0 ? blocks : null;
}

/**
 * A tool's output where the agent put it beside the blocks rather than in them.
 *
 * `ToolCallUpdate.rawOutput` is `unknown` in the schema — it is the tool's own
 * result object, whatever that tool is — so this reads exactly one key and
 * refuses everything else. `formatted_output` is codex's, and it is named here
 * rather than tested for an agent id: an agent that spells its output that way
 * is one we can read, and one that does not is unaffected. Measured, claude never
 * writes that key (its `rawOutput` is the tool's content), so nothing changes for
 * it even before the caller's "only when the blocks were empty" gate.
 *
 * The exit code is deliberately not turned into a line of prose. It is already on
 * the update as `status: "failed"`, which is what the card draws, and inventing
 * `exit 1` as text would put a sentence in the transcript that no tool printed.
 *
 * Bounded by the same budget the blocks spend, and visibly — a reader who sees
 * output stop must be able to tell "the command printed no more" from "we
 * declined to carry the rest".
 */
function rawToolOutput(rawOutput: unknown): string[] | null {
  if (rawOutput === null || typeof rawOutput !== "object" || Array.isArray(rawOutput)) return null;
  const formatted = (rawOutput as Record<string, unknown>)["formatted_output"];
  if (typeof formatted !== "string") return null;
  // Trailing newlines are what a shell leaves behind, and the transcript adds its
  // own spacing. Leading whitespace goes with them: an empty answer must reduce to
  // nothing rather than to a blank block that reads as output.
  const text = formatted.trim();
  if (text.length === 0) return null;
  return [clip(text, MAX_TOOL_OUTPUT_BYTES)];
}
