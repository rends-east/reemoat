import { Bot, ChevronRight, Square, Trash2, X } from "lucide-react";
import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { errorText } from "../http";
import {
  BACKGROUND_EMPTY,
  dotCells,
  FINISHED_LABEL,
  TASK_CHIPS,
  taskDuration,
  taskElapsedMs,
  taskKindLabel,
  taskSections,
  taskTitle,
  taskTokens,
  type BackgroundReporting,
} from "../tasks";
import { taskFinished, type BackgroundTask } from "../wire";
import type { OutstandingTask } from "./tail";
import { Icon, IconButton, SETTINGS_HEADING } from "./bits";
import { useLeaving } from "./leaving";
import { PaneHandle } from "./PaneHandle";
import { LAYER, useDismissible } from "./overlay";
import { useSheetGesture, useSlideSheet } from "./sheetDrag";
import { SHEET_MS } from "./sheetMotion";
import { taskPane } from "./taskWidth";

/** Docked width from md, a draggable custom property; its defaults live in index.css since a class cannot be built from a number. */
export const TASK_PANEL_WIDTH = "md:w-[var(--task-fit)]";
export const TASK_PANEL_INSET = "md:top-3 md:right-3 md:bottom-3";
/** The width plus the right inset, or the card overlaps the conversation by 12px. */
export const TASK_PANEL_GUTTER = "md:pr-[calc(var(--task-fit)+0.75rem)]";

/** Sheet below md, docked card from md, decided in CSS only; a menu layer, so nothing behind it goes inert. */
export function TaskPanel({
  open,
  onClose,
  tasks,
  background,
  reporting,
  onStopTask,
  hiddenFinished,
  onClearFinished,
}: {
  open: boolean;
  onClose: () => void;
  tasks: readonly OutstandingTask[];
  background: readonly BackgroundTask[];
  /** Tells an empty list from an unasked question; see tasks.ts. */
  reporting: BackgroundReporting;
  /** `null` where nothing can stop one — an older daemon, or a session with no agent. */
  onStopTask: ((task: BackgroundTask) => Promise<void>) | null;
  /** Finished rows this reader cleared; finishedTasks.ts owns it. */
  hiddenFinished: ReadonlySet<string>;
  onClearFinished: (ids: readonly string[]) => void;
}): ReactNode {
  // shown, never open: the layer lives as long as the element, or shortcuts return while the sheet still covers the screen.
  // SHEET_MS is the longer of its two exits, the card's rise-out being 140ms.
  const { shown, leaving, onAnimationEnd } = useLeaving(open, SHEET_MS);
  useDismissible("menu", onClose, shown);
  const panelRef = useRef<HTMLElement | null>(null);
  const grabber = useRef<HTMLSpanElement | null>(null);
  const scrimRef = useRef<HTMLElement | null>(null);
  const geometry = useSlideSheet(panelRef, "down", onClose, { scrim: scrimRef, open });
  // The grabber is md:hidden, so the docked card never drags.
  const drag = useSheetGesture<HTMLElement>({ axis: "down", enabled: open, geometry, gate: grabber, held: panelRef, scrim: scrimRef });
  if (!shown) return null;
  return createPortal(
    <>
      {/* Below md only; pointer-events-none while leaving, or the fading scrim eats clicks. */}
      <div
        ref={drag.scrim.ref}
        {...drag.scrim.bind}
        aria-hidden={true}
        className={`${
          leaving ? "animate-scrim-out pointer-events-none" : "animate-scrim"
        } fixed inset-0 touch-none bg-fg/25 md:hidden ${LAYER.overlay}`}
        onClick={leaving ? undefined : onClose}
      />
      {/* SHEET_PANEL's tokens spelled out; pb-safe is a utility here because the unlayered .pb-safe would beat md:pb-0. */}
      <aside
        ref={drag.ref}
        {...drag.bind}
        aria-label="Background"
        // Ends the exit; SHEET_MS is the backstop.
        onAnimationEnd={onAnimationEnd}
        // One animation utility per variant in each arm; md needs a real animation or no animationend fires.
        className={`pb-[max(0.75rem,env(safe-area-inset-bottom))] ${leaving ? "animate-sheet-out" : "animate-sheet"} fixed inset-x-0 bottom-0 flex h-[92dvh] min-h-0 flex-col overflow-hidden rounded-t-2xl border-t border-edge bg-surface shadow-2xl ${TASK_PANEL_WIDTH} ${TASK_PANEL_INSET} ${leaving ? "md:animate-rise-out" : "md:animate-rise"} md:left-auto md:h-auto md:rounded-2xl md:border md:pb-0 md:shadow-lg ${LAYER.overlay}`}
        role="dialog"
      >
        <PanelHead onClose={onClose} grabber={grabber} />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          <PanelBody
            background={background}
            hiddenFinished={hiddenFinished}
            onClearFinished={onClearFinished}
            onStopTask={onStopTask}
            reporting={reporting}
            tasks={tasks}
          />
        </div>
      </aside>
      {/* A sibling of the aside, which clips and animates; inset past the card's radius, and for a fine pointer only. */}
      <PaneHandle
        pane={taskPane}
        label="Background panel width"
        sign={-1}
        className={`fixed hidden w-2 translate-x-1/2 md:top-6 md:bottom-6 md:[@media(pointer:fine)]:block ${LAYER.overlay}`}
        style={{ right: "calc(var(--task-fit) + 0.75rem)" }}
      />
    </>,
    document.body,
  );
}

const GRABBER_BELOW_MD = "absolute top-1 left-1/2 h-1 w-9 -translate-x-1/2 rounded-full bg-edge-strong md:hidden";

// SHEET_HEAD's tokens at 44px, spelled out: a composed second min-h can only make it taller.
const PANEL_HEAD = "relative flex min-h-11 shrink-0 touch-none items-center gap-2 border-b border-edge px-4 sm:px-5";

function PanelHead({
  onClose,
  grabber,
}: {
  onClose: () => void;
  grabber: RefObject<HTMLSpanElement | null>;
}): ReactNode {
  return (
    <div className={PANEL_HEAD}>
      <span ref={grabber} aria-hidden className={GRABBER_BELOW_MD} />
      {/* text-xs: strictly smaller than SessionTitle, which webcheck asserts. */}
      <h2 className="min-w-0 flex-1 truncate text-xs font-semibold">Background</h2>
      <IconButton icon={X} label="Close background tasks" onClick={onClose} size="sm" />
    </div>
  );
}

function PanelBody({
  tasks,
  background,
  hiddenFinished,
  onClearFinished,
  reporting,
  onStopTask,
}: {
  tasks: readonly OutstandingTask[];
  background: readonly BackgroundTask[];
  hiddenFinished: ReadonlySet<string>;
  onClearFinished: (ids: readonly string[]) => void;
  reporting: BackgroundReporting;
  onStopTask: ((task: BackgroundTask) => Promise<void>) | null;
}): ReactNode {
  // Memoised: EventList re-renders per streamed token, and the daemon sends a fresh array only on change.
  const sections = useMemo(() => taskSections(background), [background]);
  // Drawn even when empty, but only for an agent that reports a lifecycle; elsewhere a zero would be a false answer.
  const finished = useMemo(() => background.filter((task) => taskFinished(task.state)), [background]);
  const showFinished = reporting === "reports" || finished.length > 0;
  const bands = (tasks.length > 0 ? 1 : 0) + sections.length + (showFinished ? 1 : 0);
  // One interval for the whole panel, and only while something runs.
  const now = useTick(background.some((task) => !taskFinished(task.state)));
  const headings = useId();
  if (tasks.length === 0 && sections.length === 0 && !showFinished) {
    return <p className="text-2xs text-faint">{BACKGROUND_EMPTY[reporting]}</p>;
  }
  return (
    <div className="space-y-5">
      {tasks.length > 0 && (
        <section
          aria-labelledby={bands > 1 ? `${headings}-agents` : undefined}
          className="space-y-1.5"
        >
          {bands > 1 && <PanelHeading count={tasks.length} id={`${headings}-agents`} label="Agents" />}
          {tasks.map((task) => (
            <p className="flex items-center gap-2 text-2xs" key={task.key}>
              <span className="shrink-0 text-muted">
                <Icon as={Bot} size={11} />
              </span>
              <span className="min-w-0 flex-1 truncate text-fg/85">
                {task.title}
                {task.latest !== null && <span className="ml-1.5 text-faint">{task.latest}</span>}
              </span>
              {task.steps > 0 && (
                <span className="shrink-0 text-faint">
                  {task.steps} step{task.steps === 1 ? "" : "s"}
                </span>
              )}
            </p>
          ))}
          <p className="text-2xs text-faint">started, and not reported finished</p>
        </section>
      )}
      {sections.map((section, index) => {
        const headingId = `${headings}-${index}`;
        const named = bands > 1;
        return (
          <section
            aria-labelledby={named ? headingId : undefined}
            className="space-y-1.5"
            key={section.label}
          >
            {named && (
              <PanelHeading count={section.tasks.length} id={headingId} label={section.label} />
            )}
            {section.tasks.map((task) => (
              <TaskCard key={task.id} now={now} onStop={onStopTask} task={task} />
            ))}
          </section>
        );
      })}
      {showFinished && (
        <FinishedSection
          headingId={`${headings}-finished`}
          hidden={hiddenFinished}
          label={FINISHED_LABEL}
          now={now}
          onClear={onClearFinished}
          onStop={onStopTask}
          tasks={finished}
        />
      )}
    </div>
  );
}

/** Written out: SETTINGS_HEADING plus a tone is a silent no-op. Both arms of the band use it. */
const FINISHED_HEADING = "text-2xs font-semibold tracking-wider text-faint uppercase";

/** Folded, and collapsed on every open since the panel unmounts on close. Clearing hides rows; it removes nothing. */
function FinishedSection({
  headingId,
  hidden,
  label,
  now,
  onClear,
  onStop,
  tasks,
}: {
  headingId: string;
  hidden: ReadonlySet<string>;
  label: string;
  now: number;
  onClear: (ids: readonly string[]) => void;
  onStop: ((task: BackgroundTask) => Promise<void>) | null;
  tasks: readonly BackgroundTask[];
}): ReactNode {
  const [open, setOpen] = useState(false);
  const shown = tasks.filter((task) => !hidden.has(task.id));
  // Nothing to show is a heading, not a fold: an empty disclosure claims a body it lacks.
  if (shown.length === 0) {
    return (
      <section aria-labelledby={headingId} className="space-y-1.5">
        <PanelHeading count={0} id={headingId} label={label} tone={FINISHED_HEADING} />
      </section>
    );
  }
  return (
    <section aria-labelledby={headingId} className="space-y-1.5">
      <div className="flex items-center gap-3">
        <h3 className="min-w-0 flex-1" id={headingId}>
          <button
            aria-expanded={open}
            className={`tap flex w-full items-center gap-1.5 rounded-md px-1 text-left hover:bg-raised ${FINISHED_HEADING}`}
            onClick={() => setOpen(!open)}
            type="button"
          >
            <span className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>
              <Icon as={ChevronRight} size={13} />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {label} ({shown.length})
            </span>
          </button>
        </h3>
        {/* Destroys nothing on the machine; every finished id is handed up so the hidden set gets pruned. */}
        <IconButton
          icon={Trash2}
          label="Clear the finished list"
          onClick={() => onClear(tasks.map((task) => task.id))}
          size="sm"
        />
      </div>
      {open && shown.map((task) => <TaskCard key={task.id} now={now} onStop={onStop} task={task} />)}
    </section>
  );
}

function PanelHeading({
  label,
  count,
  id,
  tone = SETTINGS_HEADING,
}: {
  label: string;
  count: number;
  id: string;
  /** The whole class string: a tone cannot be composed onto a caps constant. */
  tone?: string;
}): ReactNode {
  return (
    <h3 className={tone} id={id}>
      {label} ({count})
    </h3>
  );
}

// The panel's only clock-driven render, installed once in PanelBody.
const TICK_MS = 1_000;

function useTick(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

const TaskCard = memo(function TaskCard({
  task,
  now,
  onStop,
}: {
  task: BackgroundTask;
  now: number;
  onStop: ((task: BackgroundTask) => Promise<void>) | null;
}): ReactNode {
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A press ends when the daemon reports a new state, never when the stop request returns.
  useEffect(() => {
    setStopping(false);
  }, [task.state]);
  const finished = taskFinished(task.state);
  const chip = TASK_CHIPS[task.state] ?? TASK_CHIPS.running;
  const offerable = onStop !== null && task.canStop && !finished;
  const title = taskTitle(task);
  const description = task.description === title ? null : task.description;
  const command = task.taskType !== "workflow" && task.taskType !== "monitor";
  return (
    // bg-raised/50, the documented strength for a card on a panel (Q3.205, Q3.206).
    <div className="rounded-lg bg-raised/50 px-3 py-2.5">
      <div className="flex items-start gap-2">
        {/* break-words, not truncate: a shell's title is its command line. */}
        <p
          className={`min-w-0 flex-1 break-words text-fg ${
            command ? "font-mono text-2xs" : "text-xs font-medium"
          }`}
        >
          {title}
          {stopping && !finished && <span className="text-faint"> · stopping…</span>}
        </p>
        {offerable && (
          <span className="-mt-1 -mr-1 shrink-0">
            <IconButton
              disabled={stopping}
              icon={Square}
              label={`Stop ${title}`}
              onClick={() => {
                setStopping(true);
                setFailure(null);
                void onStop(task)
                  .catch((cause: unknown) => {
                    setStopping(false);
                    setFailure(errorText(cause));
                  });
              }}
              size="sm"
            />
          </span>
        )}
      </div>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-2xs">
        <span className="text-muted">{taskKindLabel(task.taskType)}</span>
        <span className="text-faint">{taskDuration(taskElapsedMs(task, now))}</span>
        <span className={chip[1]}>{chip[0]}</span>
      </p>
      {task.usage !== null && (
        <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1 text-2xs text-faint">
          <span className="text-muted">{taskTokens(task.usage.totalTokens)}</span>
          <span>tokens</span>
          <span aria-hidden={true} className="px-1">
            ·
          </span>
          <span className="text-muted">{task.usage.toolUses}</span>
          <span>tool {task.usage.toolUses === 1 ? "call" : "calls"}</span>
        </p>
      )}
      {description !== null && description.length > 0 && (
        <p className="mt-2 text-2xs break-words text-faint">{description}</p>
      )}
      {task.taskType === "workflow" && <Phases running={!finished} />}
      {failure !== null && <p className="mt-2 text-2xs text-danger">Couldn&apos;t stop it: {failure}</p>}
    </div>
  );
});

// One synthetic phase and no fraction: nothing more crosses the wire.
function Phases({ running }: { running: boolean }): ReactNode {
  return (
    <div className="mt-3">
      <p className="text-2xs font-medium text-fg">Phases</p>
      <div className="mt-1.5 rounded-md bg-raised px-2.5 py-2">
        <p className="text-2xs text-muted">Agents</p>
        <div className="mt-1.5">
          <Meter running={running} />
        </div>
      </div>
    </div>
  );
}

function Meter({ running }: { running: boolean }): ReactNode {
  return (
    <span aria-hidden={true} className="flex shrink-0 items-center gap-1">
      {dotCells(0, 0, running).map((cell, index) => (
        <span
          className={`size-1.5 rounded-full ${
            cell === "empty"
              ? "bg-edge-strong/40"
              : cell === "live"
                ? "animate-pulse bg-add-ink motion-reduce:animate-none"
                : "bg-add-ink"
          }`}
          key={index}
        />
      ))}
    </span>
  );
}
