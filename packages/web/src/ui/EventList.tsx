import { AlertTriangle, Bot, Brain, Check, ChevronDown, ChevronRight, CircleSlash, Download, FilePen, FilePlus2, Globe, Loader, Minus, Pencil, Search, Terminal, Trash2, Wrench, X } from "lucide-react";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { filenameFor } from "../paths";
import { previewable } from "../preview";
import type { FileAccess } from "./files";
import { ImagePreview } from "./ImagePreview";
import { formatLocation } from "../permission";
import { transcriptNotice, type Gap, type Transcript, type TranscriptNotice } from "../store";
import type {
  AsyncTaskState,
  BackgroundTask,
  PermissionOptionKind,
  PermissionResolvedEvent,
  ElicitationResolvedEvent,
  PromptEvent,
  SessionEvent,
} from "../wire";
import { taskFinished } from "../wire";
import { TASK_NOUNS, taskTokens, type BackgroundReporting } from "../tasks";
import type { PendingEcho } from "../echo";
import { UserBubble } from "./Bubble";
import { PeerMessageRow } from "./PeerMessage";
import { Markdown } from "./Markdown";
import { COLUMN, Dot, Empty, Icon, Badge, shortDuration, TAP_GROW_Y, TranscriptSkeleton } from "./bits";
import { WorkingMark } from "./Mark";
import { TaskPanel } from "./TaskPanel";
import { ChangeCounts, DiffView } from "./DiffView";
import {
  buildTail,
  elicitationOutcome,
  permissionDecisions,
  refused,
  resolvedByText,
  runSummary,
  stopReasonText,
  sameNode,
  stripFence,
  opensToAnything,
  detailWorthDrawing,
  headlineWorthDrawing,
  clipTitle,
  toolSummary,
  outstandingTasks,
  streamedSinceTool,
  SUMMARY_CHARS,
  type AnsweredQuestion,
  type ChangeNode,
  type EventNode,
  type GroupNode,
  type TailNode,
  type ToolNode,
} from "./tail";

const TRANSCRIPT_FOOT_PX = 48;

/** The working line's `h-5`, which lives inside that foot rather than on top of it while no card claims the foot. */
const FOOT_LINE = "1.25rem";

const ASK_CLEARANCE = 20;

export function EventList({
  transcript,
  askHeight,
  onResized,
  files,
  working,
  reporting,
  workElapsedMs,
  stale,
  echo,
  queued,
  background,
  reportsTasks,
  tasksOpen,
  onOpenTasks,
  onCloseTasks,
  hiddenFinished,
  onClearFinished,
  onStopTask,
}: {
  transcript: Transcript;
  askHeight: number;
  /** Must be referentially stable: it rides a context past the memoised TailRow. */
  onResized: () => void;
  files: FileAccess | null;
  working: boolean;
  reporting: boolean;
  /** Elapsed time of the turn or of unprompted work, from the store's skew-corrected clock; null for neither. */
  workElapsedMs: number | null;
  /** Nothing is streaming; working cannot tell, since it reflects the last snapshot that arrived. */
  stale: boolean;
  echo: PendingEcho | null;
  /** Identity matters: it feeds QueuedContext, so the caller memoises it. */
  queued: ReadonlySet<number>;
  background: readonly BackgroundTask[];
  reportsTasks: BackgroundReporting;
  tasksOpen: boolean;
  onOpenTasks: () => void;
  onCloseTasks: () => void;
  hiddenFinished: ReadonlySet<string>;
  onClearFinished: (ids: readonly string[]) => void;
  onStopTask: ((task: BackgroundTask) => Promise<void>) | null;
}): ReactNode {
  const cut = transcript.clearedAt ?? 0;
  // Over every loaded event, not only drawn rows: a request above the fold decides how its answer reads.
  const decisions = useMemo(() => permissionDecisions(transcript.events), [transcript.events]);
  const { rows, taskFloor } = useMemo(
    () => buildTail(transcript.events, transcript.gaps, cut, decisions),
    [transcript.events, transcript.gaps, cut, decisions],
  );
  // Needs the drawn row count: hundreds of held events can draw a single row.
  const notice = transcriptNotice({
    loadedFrom: transcript.loadedFrom,
    daemonFirstSeq: transcript.daemonFirstSeq,
    clearedAt: transcript.clearedAt,
    loadingHistory: transcript.loadingHistory,
    heldEvents: transcript.events.length,
    heldBytes: transcript.heldBytes,
    rows: rows.length,
  });
  // One string for the visible line and the live region, so the two cannot disagree.
  const noticeSays = noticeText(notice);
  // reporting asks whether the session can still report; taskFloor drops delegations of a previous agent.
  const tasks = useMemo(
    () => (reporting ? outstandingTasks(rows, taskFloor) : []),
    [reporting, rows, taskFloor],
  );
  // Keyed on task ids and states, not on background, which is a new array per token; taskStates feeds a context.
  const taskKey = background.map((task) => `${task.id}:${task.state}:${task.toolCallId ?? ""}`).join(",");
  const liveBackground = useMemo(
    () => background.reduce((live, task) => (taskFinished(task.state) ? live : live + 1), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [taskKey],
  );
  const taskStates = useMemo(
    () => callStates(background),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [taskKey],
  );
  // Only the foot reads it, and the memo inside makes a token one step; no row re-renders for it (Q3.644).
  const streamed = working ? streamedSinceTool(transcript.events) : 0;
  const foot = footSays(working, tasks.length, elapsedSays(workElapsedMs), stale, background, streamedSays(streamed));
  const retained = background.length;
  const footLine = foot?.line ?? null;
  const footSpoken = foot?.spoken ?? null;

  return (
    // One padding for both: the parked ask card is out of flow, so the room past it comes from here only.
    // sel-root covers selection in the space between messages, which no message owns.
    <div
      className={`sel-root ${COLUMN} px-4 pt-2`}
      style={{
        paddingBottom:
          askHeight === 0 ? `calc(${TRANSCRIPT_FOOT_PX}px - ${FOOT_LINE})` : Math.max(TRANSCRIPT_FOOT_PX, askHeight + ASK_CLEARANCE),
      }}
    >

      {/* Every arm is about the conversation's beginning, so it is drawn at the head, not the foot (Q3.423). */}
      {(notice?.kind === "floor" ||
        notice?.kind === "ceiling" ||
        notice?.kind === "loading" ||
        notice?.kind === "stalled") && (
        <p className="mb-2 flex items-center gap-1.5 px-1 py-1 text-2xs text-faint">
          <Icon
            as={notice.kind === "loading" ? Loader : AlertTriangle}
            size={11}
            className={notice.kind === "loading" ? "animate-spin" : ""}
          />
          {noticeSays}
        </p>
      )}

      {notice?.kind === "empty" && <Empty>Nothing yet — send the first message below.</Empty>}

      <ResizedContext.Provider value={onResized}>
        <div className="space-y-1.5">
          {notice?.kind === "skeleton" && <TranscriptSkeleton />}
          <DecisionsContext.Provider value={decisions}>
            <QueuedContext.Provider value={queued}>
              <TasksContext.Provider value={taskStates}>
                {rows.map((node) => (
                  <TailRow key={node.key} node={node} files={files} />
                ))}
              </TasksContext.Provider>
            </QueuedContext.Provider>
          </DecisionsContext.Provider>
          {/* Above the working line: a session can be drawn running before its prompt event arrives. */}
          {echo !== null && (
            <UserBubble text={echo.text} attachments={echo.attachments} files={files} />
          )}
          {/* WaitingFoot below has a fixed height, and with no card a slot kept for it, so its coming and going changes no height. */}
          {/* Mounted unconditionally with only its text swapping: a status region inserted with its content is often not announced. */}
          <p role="status" aria-live="polite" className="sr-only">
            {[footSpoken ?? "", noticeSays].filter((said) => said !== "").join(". ")}
          </p>
          {footLine !== null ? (
            <WaitingFoot
              line={footLine}
              working={working}
              stale={stale}
              outstanding={tasks.length + liveBackground}
              retained={retained}
              onOpenTasks={onOpenTasks}
            />
          ) : (
            keepsFootSlot(askHeight, rows.at(-1), echo !== null) && <div aria-hidden={true} className="h-5" />
          )}
          <TaskPanel
            background={background}
            hiddenFinished={hiddenFinished}
            onClearFinished={onClearFinished}
            onClose={onCloseTasks}
            onStopTask={onStopTask}
            open={tasksOpen}
            reporting={reportsTasks}
            tasks={tasks}
          />
        </div>
      </ResizedContext.Provider>
    </div>
  );
}

/**
 * The working line's room is kept while it says nothing, so its coming and going at a turn's edges moves nothing a pinned reader
 * sees (Q3.653) — except under a card, which pads its own, and under a cancel, whose row takes that room as the line did (Q3.437).
 */
export function keepsFootSlot(askHeight: number, last: TailNode | undefined, echoPending: boolean): boolean {
  if (askHeight > 0) return false;
  const event = last?.kind === "event" ? last.stored.event : null;
  return echoPending || event?.type !== "turn_end" || event.stopReason !== "cancelled";
}

/** Read only by PermissionResolvedRow: a fresh Map per event would defeat the TailRow memo in any other consumer. */
const DecisionsContext = createContext<ReadonlyMap<string, PermissionOptionKind>>(new Map());

/** Read only by PromptRow; the caller keeps its identity stable across tokens. */
const QueuedContext = createContext<ReadonlySet<number>>(new Set());

const NO_TASK_STATES: ReadonlyMap<string, AsyncTaskState> = new Map();

/** By toolCallId: the log alone cannot say whether a backgrounded call's work is still running. */
const TasksContext = createContext<ReadonlyMap<string, AsyncTaskState>>(NO_TASK_STATES);

/** A live row outranks a terminal one on the same call id. */
function callStates(background: readonly BackgroundTask[]): ReadonlyMap<string, AsyncTaskState> {
  const out = new Map<string, AsyncTaskState>();
  for (const task of background) {
    if (task.toolCallId === null) continue;
    const held = out.get(task.toolCallId);
    if (held !== undefined && !taskFinished(held)) continue;
    out.set(task.toolCallId, task.state);
  }
  return out.size === 0 ? NO_TASK_STATES : out;
}

/** Must be stable: every consumer re-renders when it changes. */
const ResizedContext = createContext<() => void>(() => {});

/** One sentence per notice for both the line and the live region; no default arm, so a new kind fails to build. */
function noticeText(notice: TranscriptNotice): string {
  if (notice === null) return "";
  switch (notice.kind) {
    case "skeleton":
      return "loading the conversation";
    case "loading":
      return `loading ${notice.earlier.toLocaleString()} earlier event${notice.earlier === 1 ? "" : "s"}…`;
    case "stalled":
      return (
        `${notice.earlier.toLocaleString()} earlier event${notice.earlier === 1 ? "" : "s"} ` +
        `${notice.earlier === 1 ? "has" : "have"} not arrived yet — retrying`
      );
    case "ceiling":
      // The count held, not a constant: two limits can trigger this stop.
      return (
        `this conversation is longer than one tab holds — the newest ${notice.held.toLocaleString()} ` +
        `events are shown, and the daemon still has the rest`
      );
    case "floor":
      return (
        `the start of this conversation is gone — ${notice.destroyed.toLocaleString()} earlier ` +
        `event${notice.destroyed === 1 ? "" : "s"} ${notice.destroyed === 1 ? "was" : "were"} dropped by an older daemon`
      );
    case "empty":
      return "";
  }
}

const ELAPSED_FLOOR_MS = 120_000;

/** Null for no work or under the floor, which also swallows a negative from clock drift. */
function elapsedSays(workElapsedMs: number | null): string | null {
  if (workElapsedMs === null) return null;
  return workElapsedMs < ELAPSED_FLOOR_MS ? null : shortDuration(workElapsedMs);
}

const CHARS_PER_TOKEN = 4;

/** Claude Code's estimate, characters over four, in its compact number; null until there is a token to show (Q3.644). */
export function streamedSays(chars: number): string | null {
  const tokens = Math.round(chars / CHARS_PER_TOKEN);
  if (tokens < 1) return null;
  return `↓ ${taskTokens(tokens)} ${tokens === 1 ? "token" : "tokens"}`;
}

/** The two sources are disjoint, so counts add without dedup; terminal rows are skipped here, not by callers. */
export function outstandingSays(tasks: number, background: readonly BackgroundTask[]): string {
  let live = 0;
  let only: string | undefined;
  let mixed = false;
  for (const task of background) {
    if (taskFinished(task.state)) continue;
    live += 1;
    if (only === undefined) only = task.taskType;
    else if (only !== task.taskType) mixed = true;
  }
  const total = tasks + live;
  if (live === 0) return `${tasks} task${tasks === 1 ? "" : "s"}`;
  if (tasks === 0 && !mixed) {
    const noun = only === undefined ? undefined : TASK_NOUNS[only];
    if (noun !== undefined) return `${live} ${live === 1 ? noun[0] : noun[1]}`;
  }
  return `${total} background task${total === 1 ? "" : "s"}`;
}

export function footSays(
  working: boolean,
  tasks: number,
  elapsed: string | null = null,
  stale: boolean = false,
  background: readonly BackgroundTask[] = [],
  streamed: string | null = null,
): { line: string; spoken: string } | null {
  // With nothing streaming, working is stale: the tense changes and both numbers go.
  const frozen = working && stale;
  const shown = frozen ? null : elapsed;
  // The count is never spoken: the live region would announce every token.
  const counted = [shown, frozen ? null : streamed].filter((part): part is string => part !== null);
  const runs = frozen ? "last seen working" : counted.length === 0 || !working ? "working…" : `working… · ${counted.join(" · ")}`;
  // Only the spoken form names the lost connection: sighted readers have the banner.
  const said = frozen
    ? "last seen working, not connected"
    : shown === null || !working
      ? "agent is working"
      : `agent is working, ${shown}`;
  const live = background.reduce((count, task) => (taskFinished(task.state) ? count : count + 1), 0);
  const outstanding = tasks + live;
  // Null when only finished rows remain: they are something to read, not to wait for.
  if (outstanding === 0) return working ? { line: runs, spoken: said } : null;
  const many = outstandingSays(tasks, background);
  if (!working) return { line: `waiting for ${many}`, spoken: `waiting for ${many}` };
  return { line: `${runs} · waiting for ${many}`, spoken: `${said}, waiting for ${many}` };
}

function WaitingFoot({
  line,
  working,
  stale,
  outstanding,
  retained,
  onOpenTasks,
}: {
  line: string;
  working: boolean;
  stale: boolean;
  outstanding: number;
  /** Task rows the panel holds, finished ones included; any makes the row pressable, but only while footSays draws the row at all. */
  retained: number;
  onOpenTasks: () => void;
}): ReactNode {
  if (outstanding === 0 && retained === 0) {
    return (
      <p aria-hidden={true} className="flex h-5 items-center gap-2 text-2xs text-faint">
        <WorkingMark still={stale} />
        {line}
      </p>
    );
  }
  return (
    <button
      aria-haspopup="dialog"
      onClick={onOpenTasks}
      // Grows downward only, into the bottom padding, and only for coarse pointers so hover does not light from below.
      className="tap relative -mx-1 flex h-5 w-full items-center gap-2 rounded-md px-1 text-left text-2xs text-faint [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:top-0 [@media(pointer:coarse)]:after:-bottom-6 [@media(pointer:coarse)]:after:content-[''] hover:bg-raised hover:text-fg"
    >
      {working ? <WorkingMark still={stale} /> : outstanding > 0 ? <Dot tone="pending" /> : <Dot tone="off" />}
      <span className="min-w-0 flex-1 truncate">{line}</span>
      <span className="shrink-0">
        <Icon as={ChevronRight} size={11} />
      </span>
    </button>
  );
}

/** Memoised on sameNode: buildTail returns fresh objects every time. */
const TailRow = memo(function TailRow({
  node,
  files,
}: {
  node: TailNode;
  files: FileAccess | null;
}): ReactNode {
  switch (node.kind) {
    case "text":
      return <TextRun role={node.role} thought={node.thought} text={node.text} />;
    case "tool":
      return <ToolCall node={node} files={files} />;
    case "group":
      return <GroupRow node={node} files={files} />;
    case "change":
      return <ChangeRow node={node} files={files} />;
    case "update":
      // A failure whose own call fell outside the window.
      return (
        <p className="flex items-center gap-1.5 font-mono text-2xs text-danger">
          <Icon as={X} size={11} />
          {node.title ?? node.toolCallId}
        </p>
      );
    case "gap":
      return <GapMarker gap={node.gap} />;
    case "event":
      return renderEvent(node, files);
  }
}, sameRow);

function sameRow(
  a: { node: TailNode; files: FileAccess | null },
  b: { node: TailNode; files: FileAccess | null },
): boolean {
  return a.files === b.files && sameNode(a.node, b.node);
}

/** Keys the icon on the chosen option's kind, not on outcome: selected includes every reject. */
function PermissionResolvedRow({
  event,
  heading,
}: {
  event: PermissionResolvedEvent;
  heading: string | null;
}): ReactNode {
  const kind = useContext(DecisionsContext).get(event.permissionId);
  const denied = refused(kind) || event.outcome === "cancelled";
  return (
    <div className="ml-3 border-l-2 border-edge pl-2">
      <p
        className={`flex items-center gap-2 px-1 py-1 text-xs ${denied ? "text-fg font-medium" : "text-fg/85"}`}
      >
        <span className="shrink-0">
          <Icon as={denied ? CircleSlash : kind === undefined ? Minus : Check} size={12} />
        </span>
        <span className="inline-flex w-3 shrink-0" aria-hidden={true} />
        <span className="min-w-0 flex-1 truncate">{heading ?? event.title}</span>
        {denied && <span className="shrink-0 font-medium">denied</span>}
        {event.by !== "client" && (
          <span className="shrink-0 text-faint">{resolvedByText(event.by)}</span>
        )}
      </p>
    </div>
  );
}

function ElicitationResolvedRow({
  event,
  asked,
}: {
  event: ElicitationResolvedEvent;
  asked: readonly AnsweredQuestion[] | null;
}): ReactNode {
  const outcome = elicitationOutcome(event);
  const answers = event.answers ?? [];

  return (
    <div className="rounded-md border border-edge px-2.5 py-2 text-xs">
      {asked === null && <p className="text-muted wrap-anywhere">{event.message}</p>}
      {asked !== null ? (
        <div className="space-y-1.5">
          {asked.map((answer) => (
            <div key={answer.key}>
              <p className="text-muted wrap-anywhere">{answer.question ?? answer.label}</p>
              {/* A typed answer keeps its line breaks, as a message does (Q3.646). */}
              <p className="whitespace-pre-wrap wrap-anywhere">{answer.value}</p>
            </div>
          ))}
        </div>
      ) : answers.length > 0 ? (
        <div className="mt-1 space-y-0.5">
          {answers.map((answer) => (
            <p key={answer.key} className="whitespace-pre-wrap wrap-anywhere">
              {answers.length > 1 && <span className="text-faint">{answer.label}: </span>}
              {answer.value}
            </p>
          ))}
        </div>
      ) : (
        <p className={`mt-1 ${outcome.tone === "warn" ? "text-fg font-medium" : "text-faint"}`}>
          {outcome.verb}
          {event.by !== "client" && ` — ${resolvedByText(event.by)}`}
        </p>
      )}
    </div>
  );
}

function PromptRow({
  seq,
  event,
  files,
}: {
  seq: number;
  event: PromptEvent;
  files: FileAccess | null;
}): ReactNode {
  const waiting = useContext(QueuedContext).has(seq);
  const onResized = useContext(ResizedContext);
  // Another agent's message is never drawn as the person's own; an older daemon sends no from at all.
  if (event.from != null) {
    return <PeerMessageRow from={event.from} text={event.text} waiting={waiting} onResized={onResized} />;
  }
  return (
    <>
      <UserBubble
        text={event.text}
        attachments={event.attachments ?? []}
        files={files}
      />
      {waiting && (
        <p className="-mt-3 mb-4 flex items-center justify-end gap-2 text-2xs text-faint">
          <Dot tone="pending" />
          Waiting for the agent to finish
        </p>
      )}
    </>
  );
}

function TextRun({ thought, role, text }: { role: string; thought: boolean; text: string }): ReactNode {
  if (text.trim().length === 0) return null;
  // Unreachable: showsInTranscript drops thoughts; kept so nobody adds a branch back.
  if (thought) return null;
  if (role === "user") return <UserBubble text={text} />;
  return <Markdown text={text} />;
}

function renderEvent(node: EventNode, files: FileAccess | null): ReactNode {
  const stored = node.stored;
  const event: SessionEvent = stored.event;

  switch (event.type) {
    case "prompt":
      return <PromptRow seq={stored.seq} event={event} files={files} />;

    // Only requests nothing ever answered reach here; the rest merge into their resolution.
    case "permission_request":
      return (
        <p className="flex items-center gap-2 px-1 py-1 text-xs font-medium text-fg">
          <span className="shrink-0">
            <Icon as={AlertTriangle} size={12} />
          </span>
          <span className="inline-flex w-3 shrink-0" aria-hidden={true} />
          <span className="min-w-0 flex-1 truncate">
            asked: {node.heading ?? event.title}
          </span>
          {event.decision !== null && " (answered)"}
        </p>
      );

    case "permission_resolved":
      return <PermissionResolvedRow event={event} heading={node.heading} />;

    case "elicitation_request":
      return (
        <p className="flex items-start gap-1.5 text-xs font-medium text-fg">
          <Icon as={AlertTriangle} size={12} className="mt-0.5" />
          <span className="min-w-0 wrap-anywhere">asked: {event.message}</span>
        </p>
      );

    case "elicitation_resolved":
      return <ElicitationResolvedRow event={event} asked={node.asked} />;

    case "plan":
      return (
        <div className="rounded-lg bg-raised/50 px-3 py-2">
          {event.entries.map((entry, index) => (
            <div key={index} className="flex items-start gap-1.5 text-xs wrap-anywhere">
              <span className={`mt-0.5 ${entry.status === "completed" ? "text-fg" : "text-faint"}`}>
                <Icon as={entry.status === "completed" ? Check : ChevronRight} size={11} />
              </span>
              <span
                className={`min-w-0 ${entry.status === "completed" ? "text-faint line-through" : ""}`}
              >
                <Markdown text={entry.content} tone="dim" />
              </span>
            </div>
          ))}
        </div>
      );

    case "turn_end":
      // Only non-end_turn reasons reach here; a cancel takes the working line's shape.
      return event.stopReason === "cancelled" ? (
        <p className="flex h-5 items-center gap-2 text-2xs font-medium text-danger">
          <WorkingMark still />
          {stopReasonText(event.stopReason)}
        </p>
      ) : (
        <p className="text-center text-2xs font-medium text-fg">
          — {stopReasonText(event.stopReason)} —
        </p>
      );

    case "error":
      return (
        <p className="flex items-start gap-1.5 text-xs text-danger">
          <Icon as={X} size={11} className="mt-0.5" />
          <span className="min-w-0 wrap-anywhere">{event.message}</span>
        </p>
      );

    // The marker stands for the prompt one seq below the cut, so the command is drawn from it.
    case "context_cleared":
      return (
        <>
          <UserBubble text="/clear" />
          <div className="my-1 flex items-center gap-2">
            <span className="h-px flex-1 bg-edge" />
            <span className="shrink-0 text-2xs text-faint">Context cleared</span>
            <span className="h-px flex-1 bg-edge" />
          </div>
        </>
      );

    default:
      // An event type from a newer daemon: draw nothing rather than crash.
      return null;
  }
}

/** Starts collapsed whatever it is doing; a tap overrides for good, and live only marks the collapsed row. */
function GroupRow({ node, files }: { node: GroupNode; files: FileAccess | null }): ReactNode {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? false;
  const onResized = useContext(ResizedContext);
  const drawn = useRef(open);
  useEffect(() => {
    if (drawn.current === open) return;
    drawn.current = open;
    onResized();
  }, [open, onResized]);

  return (
    <div>
      <button
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        className="tap flex min-h-11 w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs text-fg/85 hover:bg-raised hover:text-fg"
      >
        <span className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>
          <Icon as={ChevronRight} size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate">{runSummary(node.tally)}</span>
        <ChangeCounts events={node.tally.changes} />
        {/* Plain text, not a Badge, whose fill is the user's bubble; a failure still outranks an approval (Q3.106). */}
        {node.failed > 0 && (
          <span className="shrink-0 text-2xs text-muted">{node.failed} failed</span>
        )}
        {node.live && (
          <span className="shrink-0">
            <Dot tone="pending" />
          </span>
        )}
      </button>

      {open && (
        <div className="mt-1 ml-3 space-y-1.5 border-l-2 border-edge pl-2">
          {node.approved > 0 && (
            <p className="px-1 text-2xs text-faint">
              {node.approved} approved
            </p>
          )}
          {node.children.map((child) => (
            <TailRow key={child.key} node={child} files={files} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A file change whose own tool call is not on screen; not itself a button because the download control is one. */
function ChangeRow({ node, files }: { node: ChangeNode; files: FileAccess | null }): ReactNode {
  const [open, setOpen] = useState(false);
  const onResized = useContext(ResizedContext);
  const event = node.event;
  // Absolute, because the agent chose it. The route takes a workspace-relative
  // path, and anything outside gets no button at all.
  const rel = files?.relFor(event.path) ?? null;

  return (
    <div className="ml-3 border-l-2 border-edge pl-2">
      <div className="flex items-center gap-1.5 font-mono text-2xs text-muted">
        <button
          onClick={() => {
            setOpen(!open);
            onResized();
          }}
          aria-expanded={open}
          className="tap flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-3 text-left hover:text-fg"
        >
          <span className="shrink-0 text-faint">
            <Icon as={open ? ChevronDown : ChevronRight} size={11} />
          </span>
          <span className="shrink-0 text-faint">
            <Icon as={event.oldText === null ? FilePlus2 : FilePen} size={11} />
          </span>
          {/* Relative: truncation clips the tail, and the worktree prefix is identical on every row. */}
          <span className="min-w-0 flex-1 truncate">{rel ?? event.path}</span>
          <ChangeCounts events={[event]} />
        </button>
        {rel !== null && files !== null && (
          <DownloadButton
            label={`Download ${rel}`}
            run={() => files.download(rel, filenameFor(rel) ?? rel)}
          />
        )}
      </div>
      {open && (
        <div className="mt-1">
          <DiffView change={event} />
        </div>
      )}
    </div>
  );
}

/** Open union: agents may send unknown kinds, so a lookup with a fallback, never a Record over ToolKind. */
const KIND_ICON: Record<string, ComponentType<{ size?: number | string; className?: string }>> = {
  read: Search,
  edit: Pencil,
  delete: Trash2,
  move: FilePen,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Wrench,
  other: Wrench,
};

/** A subagent is a call with children or one declared a spawn; never judged by kind or title. */
function ToolCall({ node, files }: { node: ToolNode; files: FileAccess | null }): ReactNode {
  const { title, toolKind: kind, status, rawInput, locations, output, images, children } = node;
  const [open, setOpen] = useState(status === "failed");
  const onResized = useContext(ResizedContext);
  const { summary, detail } = toolSummary(rawInput, locations, (path) => files?.relFor(path) ?? null);
  const isSubagent = node.subagent || node.steps > 0;
  const headline = isSubagent
    ? node.elapsedMs !== null
      ? shortDuration(node.elapsedMs)
      :
        (node.latest ?? summary)
    : summary;
  // Clipped here rather than by truncate, so the card knows whether anything was cut.
  const shownTitle = clipTitle(title);
  const expandable = opensToAnything({
    detail,
    headline,
    outputBlocks: output?.length ?? 0,
    locations: locations.length,
    children: children.length,
    changes: node.changes.length,
    titleClipped: shownTitle.clipped,
  });
  // A backgrounded completed call is running only while the snapshot has a live task for it; no match means not running.
  const backgroundState = useContext(TasksContext).get(node.toolCallId);
  const running =
    node.backgrounded &&
    status === "completed" &&
    backgroundState !== undefined &&
    !taskFinished(backgroundState);
  const tone =
    status === "failed" ? "text-fg" : status === "completed" && !running ? "text-muted" : "text-fg";

  return (
    <div>
      {/* 44px unconditionally: expandable flips mid-turn, and the row must not change height under the reader. */}
      <button
        onClick={() => {
          setOpen(!open);
          onResized();
        }}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        className={`tap flex min-h-11 w-full items-center gap-2 rounded-md px-1 py-1 text-left text-fg/85 ${
          expandable ? "hover:bg-raised hover:text-fg" : ""
        }`}
      >
        <span className={`shrink-0 ${tone}`}>
          <Icon
            as={
              status === "failed"
                ? X
                : running
                  ? Terminal
                  : status === "completed"
                    ? Check
                    : status === "in_progress"
                      ? Loader
                      : Download
            }
            size={12}
            className={status === "in_progress" ? "animate-spin" : ""}
          />
        </span>
        {/* Bot, not Brain: Brain is the ACP think kind, and delegation must not read as thinking. */}
        <span className={`shrink-0 ${isSubagent ? "text-muted" : "text-faint"}`}>
          <Icon as={isSubagent ? Bot : (KIND_ICON[kind] ?? Wrench)} size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs">
          {shownTitle.text}
          {/* Skipped when it equals the title: codex names a Bash call after its command. */}
          {headlineWorthDrawing(title, headline) && (
            <span className="ml-1.5 font-mono text-2xs text-faint">
              {headline !== null && headline.length > SUMMARY_CHARS
                ? `${headline.slice(0, SUMMARY_CHARS)}…`
                : headline}
            </span>
          )}
        </span>
        {/* Text, not a control: this whole row is already the card's button. */}
        {running && <span className="shrink-0 text-2xs text-faint">Running in the background</span>}
        <ChangeCounts events={node.changes} />
        {node.steps > 0 && (
          <span className="shrink-0">
            <Badge>
              {node.steps} step{node.steps === 1 ? "" : "s"}
            </Badge>
          </span>
        )}
        {expandable && (
          <span className="shrink-0 text-faint">
            <Icon as={open ? ChevronDown : ChevronRight} size={13} />
          </span>
        )}
      </button>

      {/* Outside the expander: an image is content, and an image-only call is not expandable. */}
      {files !== null && images.length > 0 && (
        <div className="mt-1 ml-3 flex flex-wrap gap-2 border-l-2 border-edge py-1 pl-2">
          {images.map((image) =>
            previewable(image.mime, image.bytes) ? (
              <ImagePreview
                key={image.uploadId}
                cacheKey={`u:${image.uploadId}`}
                fetcher={() => files.fetchUpload(image.uploadId)}
                alt={image.name}
              />
            ) : (
              <button
                key={image.uploadId}
                type="button"
                onClick={() => void files.downloadUpload(image.uploadId, image.name)}
                className="tap flex items-center gap-1.5 rounded-md border border-edge px-2 py-1 font-mono text-2xs hover:border-edge-strong"
              >
                <Icon as={Download} size={11} />
                {image.name}
              </button>
            ),
          )}
        </div>
      )}

      {open && expandable && (
        <div className="mt-1 ml-3 space-y-1.5 border-l-2 border-edge py-1 pl-2">
          {shownTitle.clipped && (
            <p className="text-xs text-fg/85 wrap-anywhere">{title}</p>
          )}
          {node.changes.length > 0 && (
            <div className="space-y-1.5">
              {node.changes.map((change, index) => (
                <DiffView
                  key={`${change.path}-${index}`}
                  change={change}
                  // Joined on path, not the first location: one call can change several files; a created file starts at 1.
                  startLine={
                    change.oldText === null
                      ? 1
                      : (locations.find((l) => l.path === change.path)?.line ?? 1)
                  }
                />
              ))}
            </div>
          )}

          {detailWorthDrawing(detail, headline) && (
            <pre className="max-h-64 overflow-auto rounded-md bg-raised/50 px-2 py-1.5 font-mono text-2xs leading-snug wrap-anywhere">
              {detail}
            </pre>
          )}

          {locations.length > 0 && (
            <ul className="font-mono text-2xs text-muted">
              {locations.map((location, index) => {
                const rel = files?.relFor(location.path) ?? null;
                return (
                  <li key={`${location.path}:${index}`} className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate">
                      {rel === null
                        ? formatLocation(location)
                        : formatLocation({ path: rel, line: location.line })}
                    </span>
                    {rel !== null && files !== null && (
                      <DownloadButton
                        label={`Download ${rel}`}
                        run={() => files.download(rel, filenameFor(rel) ?? rel)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {output !== null && output.length > 0 && (
            <pre className="max-h-64 overflow-auto rounded-md bg-raised px-2 py-1.5 font-mono text-2xs leading-snug whitespace-pre-wrap wrap-anywhere">
              {output.map(stripFence).join("\n")}
            </pre>
          )}

          {children.length > 0 && (
            <div>
              <div className="space-y-1.5">
                {node.omitted > 0 && (
                  <p className="px-1 py-0.5 text-2xs text-faint">
                    {node.omitted} earlier step{node.omitted === 1 ? "" : "s"} not shown
                  </p>
                )}
                {children.map((child) => (
                  <TailRow key={child.key} node={child} files={files} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Only the daemon's lagged frames, which are real losses, so the text names the cause. */
function GapMarker({ gap }: { gap: Gap }): ReactNode {
  const count = gap.to - gap.from + 1;
  return (
    <p className="flex items-center justify-center gap-1.5 py-1 text-center text-2xs font-medium text-fg">
      <Icon as={AlertTriangle} size={11} />
      {count} event{count === 1 ? "" : "s"}{" "}
      {gap.reason === "evicted"
        ? "dropped by the daemon — older than it keeps"
        : "dropped — this client could not keep up"}
    </p>
  );
}

function DownloadButton({ label, run }: { label: string; run: () => Promise<void> }): ReactNode {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={(event) => {
        // Inside a `<p>`/`<li>` that may itself be inside an expander header.
        event.stopPropagation();
        setBusy(true);
        void run().finally(() => setBusy(false));
      }}
      // Coarse pointers only: the pad would extend hover as far as the hit area.
      className={`tap relative shrink-0 rounded p-0.5 text-faint [@media(pointer:coarse)]:after:-right-2 hover:text-fg disabled:opacity-50 ${TAP_GROW_Y}`}
    >
      <Icon as={busy ? Loader : Download} size={11} className={busy ? "animate-spin" : ""} />
    </button>
  );
}
