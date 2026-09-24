import { ArrowDown, GitBranch, Pin } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { backgroundReporting } from "../tasks";
import { echoFor, echoVersion, subscribeEchoes } from "../echo";
import { hiddenFinished, hiddenFinishedVersion, hideFinished, subscribeHiddenFinished } from "../finishedTasks";
import { permissionContext } from "../permission";
import { keyOf, type SessionRef } from "../ids";
import { describe, missingRowReason } from "../machine";
import { displayCwd, downloadablePath, folderLabel, relativeTo } from "../paths";
import { navigate } from "../router";
import { settingsPath } from "../settings";
import { elapsedSince, store, type AppState, type SessionRow } from "../store";
import { machineDisplayName } from "../machineOrder";
import {
  humanRequests,
  isBuiltinAgentId,
  mayStillReport,
  backgroundTasksOf,
  queuedSeqs,
  showsWorking,
  deliversQueued,
  waitingCount,
  workStartedAt,
  type BackgroundTask,
  type SessionSnapshot,
} from "../wire";
import { agentLabel } from "./agentCard";
import { useBackSwipe } from "./backSwipe";
import { Composer } from "./Composer";
import { ConnectionPill } from "./ConnectionPill";
import { EventList } from "./EventList";
import { useFollow } from "./follow";
import { FileAccessContext, type FileAccess } from "./files";
import { saveBlob } from "./download";
import { Header } from "./Header";
import { ElicitationCard } from "./ElicitationCard";
import { PermissionCard } from "./PermissionCard";
import { RenameField, resumeSession, SessionMenu } from "./SessionMenu";
import { toast } from "./Toast";
import { TASK_PANEL_GUTTER } from "./TaskPanel";
import {
  COLUMN,
  Icon,
  TranscriptSkeleton,
  sessionLabel,
  sessionNotice,
} from "./bits";

// One identity: this feeds a context, and a fresh Set per render would re-render every bubble.
const EMPTY_QUEUE: ReadonlySet<number> = new Set();

const EMPTY_TASKS: readonly BackgroundTask[] = [];

/** The card frame's own 8px under the panel, and the pill's 12px off whatever it floats over. */
const PILL_OVER_CARD_PX = 20;

export function SessionView({ state, sessionRef }: { state: AppState; sessionRef: SessionRef }): ReactNode {
  const key = keyOf(sessionRef);
  const row = state.rowsByKey.get(key);
  const transcript = state.transcripts.get(key);
  const machine = state.machines.find((candidate) => candidate.id === sessionRef.machineId);
  const [renaming, setRenaming] = useState(false);

  // Bumped by the composer on every send so the transcript returns to its foot; a counter, since two sends are two requests.
  const [tailRequest, setTailRequest] = useState(0);

  // The ask card is absolute and invisible to layout, so its height becomes padding inside the transcript.
  const [askHeight, setAskHeight] = useState(0);

  useEffect(() => {
    store.openSession(sessionRef);
  }, [sessionRef.machineId, sessionRef.sessionId]);

  // Above the early return: the memo below is a hook, and the hook count must not change when the row lands.
  const asking = row === undefined ? undefined : humanRequests(row.snapshot)[0];
  // Memoised on the permission and events, not on `asking`; `?? []` because a cold open may have no transcript while the plan is on the snapshot.
  const pendingAsk = asking !== undefined && asking.kind === "permission" ? asking.permission : null;
  const events = transcript?.events;
  const awaitingPlan = useMemo(
    () => pendingAsk !== null && permissionContext(pendingAsk, events ?? []).plan !== null,
    [pendingAsk, events],
  );

  // Held here because at xl the docked panel must move this whole column; reset on a switch, since this pane is not remounted.
  const [tasksOpen, setTasksOpen] = useState(false);
  useEffect(() => setTasksOpen(false), [key]);
  const openTasks = useCallback(() => setTasksOpen(true), []);
  const closeTasks = useCallback(() => setTasksOpen(false), []);
  // Opaque, because below lg a back swipe draws the list under it (Q3.663).
  const back = useBackSwipe();

  if (row === undefined) {
    const why = missingRowReason(machine?.reach ?? null, state.listed.has(sessionRef.machineId));
    return (
      <div ref={back.ref} onPointerDownCapture={back.press} className="flex min-h-0 flex-1 flex-col bg-surface">
        <Header title={<span className="text-base font-semibold">Session</span>} close backRef={back.gate} />
        {why === "loading" ? (
          <div className={`${COLUMN} px-4 py-2`}>
            <TranscriptSkeleton />
          </div>
        ) : (
          <p className="p-6 text-center text-sm text-muted">
            {why === "no_machine"
              ? "That machine is no longer granted to you."
              : why === "unreachable"
                ? `${machine?.name ?? "That machine"} is not reachable right now.`
                : "That session is not on this daemon."}
          </p>
        )}
      </div>
    );
  }

  const session = row.snapshot;
  const stream = transcript?.stream ?? null;
  // Anything not live, since a handshake can sit in `connecting` indefinitely; the trouble itself is the pill's to say.
  const stale = stream === null || stream.phase !== "live";


  return (
    // `min-h-0` so the transcript scrolls; the gutter pads this column because the fixed panel displaces nothing.
    <div
      ref={back.ref}
      onPointerDownCapture={back.press}
      className={`flex min-h-0 flex-1 flex-col bg-surface ${tasksOpen ? TASK_PANEL_GUTTER : ""}`}
    >
      <Header
        title={
          <>
            <SessionTitle
              row={row}
              roots={state.rootsByMachine.get(sessionRef.machineId) ?? []}
              renaming={renaming}
              onRenaming={setRenaming}
            />
            {session.pinned === true && (
              <span className="inline-flex w-3 shrink-0 justify-center text-muted" title="Pinned">
                <Icon as={Pin} size={12} />
                <span className="sr-only">Pinned</span>
              </span>
            )}
          </>
        }
        subtitle={
          <WorkspaceLine
            machineName={machineDisplayName({ id: sessionRef.machineId, name: row.machineName }, state.localMachineId)}
            workspace={session.workspace}
            roots={state.rootsByMachine.get(sessionRef.machineId) ?? []}
          />
        }
        close
        backRef={back.gate}
      >
        {/* At every width: Background tasks has no other door once nothing is outstanding. Q3.631. */}
        <SessionMenu
          onOpenTasks={openTasks}
          onRename={() => setRenaming(true)}
          sessionRef={sessionRef}
          state={state}
        />
      </Header>

      {/* Above the conversation region, so the absolute ask card cannot paint over it. */}
      <ExitNotice row={row} machineName={row.machineName} />

      <div className="relative flex min-h-0 flex-1 flex-col">
        <Transcript
          sessionRef={sessionRef}
          state={state}
          tailRequest={tailRequest}
          stale={stale}
          askHeight={askHeight}
          tasksOpen={tasksOpen}
          onOpenTasks={openTasks}
          onCloseTasks={closeTasks}
        />

        {/* Keyed per request, or two parked requests reconcile as one instance and carry state across. */}
        {/* Not gated on a transcript: a cold open without a connection has none, and the card fetches its own context. */}
        {asking !== undefined &&
          (asking.kind === "permission" ? (
            <PermissionCard
              key={asking.permission.permissionId}
              sessionRef={sessionRef}
              pending={asking.permission}
              events={transcript?.events ?? []}
              agent={session.agent}
              more={waitingCount(session) - 1}
              onHeight={setAskHeight}
            />
          ) : (
            <ElicitationCard
              key={asking.elicitation.elicitationId}
              sessionRef={sessionRef}
              pending={asking.elicitation}
              more={waitingCount(session) - 1}
              onHeight={setAskHeight}
            />
          ))}

        {/* Below lg only, where no list is on screen; above it the list's pill reads this conversation too. Lifted over a card. */}
        <div className="contents lg:hidden">
          <ConnectionPill
            state={state}
            openKey={key}
            machines={[sessionRef.machineId]}
            placement="bottom-3 left-3"
            style={askHeight > 0 ? { bottom: askHeight + PILL_OVER_CARD_PX } : undefined}
          />
        </div>
      </div>

      <Composer
        sessionRef={sessionRef}
        state={state}
        revising={awaitingPlan}
        onSent={() => setTailRequest((n) => n + 1)}
      />
    </div>
  );
}

// A plain string, never Markdown: a typed name must not become a link.
function SessionTitle({
  row,
  roots,
  renaming,
  onRenaming,
}: {
  row: SessionRow;
  roots: readonly string[];
  renaming: boolean;
  onRenaming: (next: boolean) => void;
}): ReactNode {
  const fallback = folderLabel(row.snapshot.workspace.requestedCwd, roots);

  if (renaming) {
    return (
      <RenameField
        sessionRef={row.ref}
        current={row.snapshot.title ?? null}
        placeholder={fallback}
        onDone={() => onRenaming(false)}
        className="lg:-ml-1"
      />
    );
  }

  return (
    <button
      onClick={() => onRenaming(true)}
      title="Rename this session"
      // The text caret says the name is edited in place, on the owner's word (Q3.665).
      className="tap min-w-0 truncate rounded-sm px-1 text-left text-sm hover:bg-raised lg:-ml-1 cursor-text"
    >
      {sessionLabel(row, roots)}
    </button>
  );
}

function ExitNotice({ row, machineName }: { row: SessionRow; machineName: string }): ReactNode {
  const [busy, setBusy] = useState(false);
  const notice = sessionNotice(row.snapshot, row.snapshot.agent, machineName);
  if (notice === null) return null;
  return (
    <p
      className={`${COLUMN} flex flex-wrap items-center justify-center gap-2 px-4 py-2 text-center text-xs ${
        notice.tone === "warn" ? "text-fg font-medium" : "text-muted"
      }`}
    >
      <span>{notice.text}</span>
      {notice.action === "reconnect" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void resumeSession(row.ref).finally(() => setBusy(false));
          }}
          className="tap rounded border border-edge px-2 py-0.5 text-2xs text-fg hover:bg-raised disabled:opacity-50"
        >
          {busy ? "reconnecting…" : "Reconnect"}
        </button>
      )}
      {notice.action === "sign_in" && (
        <button
          type="button"
          // The machine's page, not a system built from the agent id: mapping a harness to its system is the daemon's answer.
          onClick={() => navigate(settingsPath("machines", row.ref.machineId))}
          className="tap rounded border border-edge px-2 py-0.5 text-2xs text-fg hover:bg-raised"
        >
          {isBuiltinAgentId(row.snapshot.agent)
            ? `Sign in to ${agentLabel(row.snapshot.agent)}`
            : "Open agent settings"}
        </button>
      )}
    </p>
  );
}

function WorkspaceLine({
  machineName,
  workspace,
  roots,
}: {
  machineName: string;
  workspace: SessionSnapshot["workspace"];
  roots: readonly string[];
}): ReactNode {
  const where = workspace.requestedCwd;
  const branch = workspace.git?.branch ?? null;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0">{machineName}</span>
      <span className="shrink-0 text-faint">·</span>
      <span className="truncate font-mono" title={where}>{displayCwd(where, roots)}</span>
      {workspace.mode === "worktree" && branch !== null && (
        <>
          <span className="text-faint">·</span>
          <span className="flex min-w-0 items-center gap-1 text-muted">
            <Icon as={GitBranch} size={10} />
            <span className="truncate">{branch}</span>
          </span>
        </>
      )}
    </span>
  );
}

function Transcript({
  sessionRef,
  state,
  tailRequest,
  stale,
  askHeight,
  tasksOpen,
  onOpenTasks,
  onCloseTasks,
}: {
  sessionRef: SessionRef;
  state: AppState;
  tailRequest: number;
  stale: boolean;
  askHeight: number;
  tasksOpen: boolean;
  onOpenTasks: () => void;
  onCloseTasks: () => void;
}): ReactNode {
  const key = keyOf(sessionRef);
  const row = state.rowsByKey.get(key) ?? null;
  const snapshot = row?.snapshot ?? null;
  const root = snapshot?.workspace.root ?? null;
  useSyncExternalStore(subscribeEchoes, echoVersion);
  const echo = echoFor(key);

  // Subscribed by version: a fresh Set per call would loop `useSyncExternalStore`.
  useSyncExternalStore(subscribeHiddenFinished, hiddenFinishedVersion);
  const hiddenFinishedIds = hiddenFinished(key);

  // Optimistic: an echo in flight counts as working, bounded by the echo's own lifetime; `showsWorking` itself stays pure.
  const working = echo !== null || (snapshot !== null && (showsWorking(snapshot) || deliversQueued(snapshot)));
  const reporting = snapshot !== null && mayStillReport(snapshot);
  const startedAt = snapshot === null ? null : workStartedAt(snapshot);
  // `elapsedSince` corrects for the device clock; never subtract the local time from a daemon stamp.
  const workElapsedMs = row === null || startedAt === null ? null : elapsedSince(row, startedAt);
  const transcript = state.transcripts.get(key);

  const queuedKey = (snapshot?.queuedPrompts ?? []).map((entry) => entry.seq).join(",");
  // Keyed on `queuedKey`: the snapshot is new every poll, and this feeds a context.
  const queued = useMemo(
    () => (snapshot === null ? EMPTY_QUEUE : queuedSeqs(snapshot)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [queuedKey],
  );

  const background = snapshot === null ? EMPTY_TASKS : backgroundTasksOf(snapshot);

  const onClearFinished = useCallback((ids: readonly string[]) => hideFinished(key, ids), [key]);

  const onStopTask = useCallback(
    async (task: BackgroundTask): Promise<void> => {
      const daemon = store.daemonFor(sessionRef.machineId);
      if (daemon === undefined) throw new Error("this machine is not reachable");
      const result = await daemon.stopBackgroundTask(sessionRef.sessionId, task.id);
      // The snapshot rarely carries the stop yet (the agent's own edge ends the task), and `result.stopped` false under a 200 means it had already finished.
      store.applySnapshot(sessionRef, result.session);
    },
    [sessionRef],
  );

  // Behind a ref so `FileAccess` keeps a stable identity while the touched set grows.
  const touched = useRef<Set<string>>(new Set());
  useMemo(() => {
    const next = new Set<string>();
    for (const stored of transcript?.events ?? []) {
      const event = stored.event;
      if (event.type === "file_change") next.add(event.path);
      const locations = "locations" in event ? event.locations : null;
      for (const location of locations ?? []) next.add(location.path);
    }
    touched.current = next;
  }, [transcript?.events]);

  const files = useMemo<FileAccess | null>(() => {
    if (root === null) return null;
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) return null;
    return {
      relFor: (absPath: string) => relativeTo(root, absPath),
      spanTarget: (span: string) => downloadablePath(span, root, touched.current),
      download: async (rel, name) => {
        try {
          saveBlob(await daemon.downloadFile(sessionRef.sessionId, rel), name);
        } catch (error) {
          toast("error", describe(error));
        }
      },
      fetchUpload: (uploadId) => daemon.downloadUpload(sessionRef.sessionId, uploadId),
      downloadUpload: async (uploadId, name) => {
        try {
          saveBlob(await daemon.downloadUpload(sessionRef.sessionId, uploadId), name);
        } catch (error) {
          toast("error", describe(error));
        }
      },
    };
  }, [root, sessionRef.machineId, sessionRef.sessionId]);
  const firstSeq = transcript?.events[0]?.seq ?? 0;
  const { boxRef, contentRef, atBottom, scrolledDown, remeasure } = useFollow(key, firstSeq, tailRequest);

  return (
    <div className="relative min-h-0 flex-1">
      {/* `relative` keeps absolutely positioned descendants inside this scroller rather than overflowing `main`. */}
      {/* Chrome's own anchoring would add a second shift to useFollow's history one; WebKit has none. */}
      <div ref={boxRef} className="scroll-stable relative h-full overflow-y-auto [overflow-anchor:none]">
        <div ref={contentRef}>
          {transcript !== undefined && (
            <FileAccessContext.Provider value={files}>
              <EventList
                files={files}
                echo={echo}
                queued={queued}
                transcript={transcript}
                askHeight={askHeight}
                working={working}
                reporting={reporting}
                stale={stale}
                workElapsedMs={workElapsedMs}
                background={background}
                reportsTasks={backgroundReporting(snapshot)}
                tasksOpen={tasksOpen}
                onOpenTasks={onOpenTasks}
                onCloseTasks={onCloseTasks}
                onStopTask={onStopTask}
                hiddenFinished={hiddenFinishedIds}
                onClearFinished={onClearFinished}
                onResized={remeasure}
              />
            </FileAccessContext.Provider>
          )}
        </div>
      </div>

      {/* No backdrop blur here (a filter pass per scroll frame); `pointer-events-none` because it covers live controls. */}
      {scrolledDown && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-surface/70 to-transparent"
        />
      )}

      {!atBottom && (
        <button
          // Holds nothing: held, the next growth would pin and cut the smooth scroll short; arriving is what holds it (Q3.426).
          onClick={() => {
            const box = boxRef.current;
            if (box === null) return;
            box.scrollTo({
              top: box.scrollHeight,
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ? "auto"
                : "smooth",
            });
          }}
          className="tap absolute bottom-3 left-1/2 flex min-h-11 -translate-x-1/2 items-center gap-1.5 rounded-md border border-edge bg-raised px-3 py-1.5 text-xs shadow-lg"
        >
          <Icon as={ArrowDown} size={12} />
          latest
        </button>
      )}
    </div>
  );
}


