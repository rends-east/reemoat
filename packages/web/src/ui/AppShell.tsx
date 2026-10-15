import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { AGENT_HOST_OS, installCommand } from "../enrollment";
import { controlPlaneOrigin } from "../native";
import { keyOf } from "../ids";
import { machineQuotaNotice, mayAddMachine } from "../quota";
import type { Route } from "../router";
import type { AppState } from "../store";
import { CommandLine } from "./CommandLine";
import { Icon } from "./bits";
import { boardListOpen, boardSelected, groupsVersion, listBody, settingUp, subscribeGroups, toggleBoardList } from "./groups";
import { MachineColumn } from "./MachineColumn";
import { SessionBrowser } from "./SessionBrowser";
import { useKeyboard } from "./keyboard";
import { LAYER } from "./overlay";
import { PaneHandle } from "./PaneHandle";
import { MACHINE_COLUMN_PX, rail, railWidth, subscribeRail } from "./rail";
import { subscribeTaskWidth, taskWidth } from "./taskWidth";
import { Unreachable } from "./Unreachable";

/** The rail's slide, a little past its 200ms transition so it is never cut. */
const SLIDE_MS = 260;

/** One screen at a time below `lg`, a permanent rail at `lg`; CSS decides which, never breakpoint state in JavaScript. */
export function AppShell({
  state,
  route,
  onMenu,
  children,
}: {
  state: AppState;
  route: Route;
  onMenu: () => void;
  children: ReactNode;
}): ReactNode {
  const activeKey = route.name === "session" ? keyOf(route.ref) : null;
  const activeTask = route.name === "task" ? { machineId: route.machineId, taskId: route.taskId } : null;
  useKeyboard(state, route);

  // Only the committed width: a drag writes `--rail-w` directly through `PaneHandle`.
  const width = useSyncExternalStore(subscribeRail, railWidth);
  // Written here because `TaskPanel` mounts only while open; `null` removes it so the stylesheet's breakpoints apply.
  const taskW = useSyncExternalStore(subscribeTaskWidth, taskWidth);
  useEffect(() => {
    document.documentElement.style.setProperty("--rail-w", `${width}px`);
    if (taskW === null) document.documentElement.style.removeProperty("--task-w");
    else document.documentElement.style.setProperty("--task-w", `${String(taskW)}px`);
  }, [width, taskW]);

  useSyncExternalStore(subscribeGroups, groupsVersion);
  const board = boardSelected();
  const folded = board && !boardListOpen();
  // Only while a press slides it: a transition left on would make a drag of its edge trail the pointer.
  const [slid, setSlid] = useState(0);
  const sliding = slid > 0;
  useEffect(() => {
    if (slid === 0) return;
    const timer = window.setTimeout(() => setSlid(0), SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [slid]);

  return (
    <div data-shell className="relative flex h-dvh">
      {/* `overflow-hidden` so its two children scroll independently; `border-r` because `ink` on `surface` is only 1.06:1. */}
      <aside
        className={`hidden shrink-0 overflow-hidden border-r border-edge bg-ink lg:flex ${folded ? "lg:w-[80px]" : "lg:w-[var(--rail-w)]"} ${
          sliding ? "transition-[width] duration-200 ease-out motion-reduce:transition-none" : ""
        }`}
      >
        <MachineColumn state={state} onMenu={onMenu} />
        {/* Its own width while the rail slides, so the list is uncovered rather than squeezed. */}
        <div inert={folded} className="flex h-full min-h-0 min-w-[calc(var(--rail-w)_-_80px)] flex-1">
          <SessionBrowser state={state} activeKey={activeKey} activeTask={activeTask} onMenu={onMenu} />
        </div>
      </aside>

      {/* `min-w-0` stops long lines widening this pane; screens stretch inside it rather than using `h-full`. */}
      {/* Clipped while a back swipe draws the list: a conversation translated past its edge grew its scroll width and repainted it every frame (Q3.663). */}
      {/* `overscroll-contain`: a scroll that reaches its end stops here rather than carrying the app with it (Q3.739). */}
      <main className="flex min-w-0 flex-1 flex-col overscroll-contain overflow-y-auto bg-surface has-[>[data-back-under]]:overflow-hidden">
        {children}
      </main>

      {!folded && <RailHandle />}
      {board && (
        <BoardListToggle
          open={!folded}
          sliding={sliding}
          onToggle={() => {
            setSlid((n) => n + 1);
            toggleBoardList();
          }}
        />
      )}
    </div>
  );
}

export function NothingSelected({ state }: { state: AppState }): ReactNode {
  if (state.machines.length === 0) {
    const body = listBody({
      device: state.device,
      server: state.server.state,
      registry: state.registry,
      fleet: [],
      selected: null,
      rows: 0,
      needle: false,
      hidden: 0,
      settingUp: settingUp(state.setup),
    });
    // The rail carries the sentence at every width; this pane adds what there is room for here (Q3.709).
    if (body.kind === "network" || body.kind === "server") {
      return (
        <div className="mx-auto w-full max-w-xs pt-2">
          <Unreachable cause={body.kind === "network" ? { what: "network" } : { what: "server", why: body.why }} />
        </div>
      );
    }
    // Not read yet: the rail draws the shape, and this pane claims nothing.
    if (body.kind !== "no_machines") return null;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted">No machines yet.</p>
        {mayAddMachine(state.me) ? (
          <>
            <p className="text-xs text-muted">Run this on the {AGENT_HOST_OS} machine you want to use, and sign in there:</p>
            <div className="w-full max-w-lg text-left">
              <CommandLine command={installCommand(controlPlaneOrigin())} />
            </div>
          </>
        ) : (
          <p className="max-w-xs text-xs text-muted">{machineQuotaNotice(state.me)}</p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm text-muted">Pick a session from the list.</p>
      <p className="max-w-xs text-xs text-faint">
        A machine with sessions waiting on you says so on its header, open or closed.
      </p>
    </div>
  );
}

function RailHandle(): ReactNode {
  return (
    // Out of flow at the rail's edge, after main and at LAYER.header, so the sticky header and composer cannot cover it.
    <div
      // Mouse only: an iPad Pro in portrait matches `lg`, and this strip is `touch-action: none`.
      className={`absolute inset-y-0 hidden w-2 -translate-x-1/2 lg:[@media(pointer:fine)]:block ${LAYER.header}`}
      style={{ left: "var(--rail-w)" }}
    >
      <PaneHandle pane={rail} label="Sidebar width" sign={1} className="absolute inset-0" />
    </div>
  );
}

/** The board's list, shown or hidden from the rail's edge (the owner's call, 2026-10-15): the board draws the same tasks. */
function BoardListToggle({ open, sliding, onToggle }: { open: boolean; sliding: boolean; onToggle: () => void }): ReactNode {
  const label = open ? "Hide the list" : "Show the list";
  return (
    <div
      className={`absolute top-1/2 hidden -translate-x-1/2 -translate-y-1/2 lg:flex ${LAYER.header} ${
        sliding ? "transition-[left] duration-200 ease-out motion-reduce:transition-none" : ""
      }`}
      style={{ left: open ? "var(--rail-w)" : `${String(MACHINE_COLUMN_PX)}px` }}
    >
      {/* A tab on the edge, as a sidebar's collapse handle is drawn: taller than wide, barely rounded. */}
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={onToggle}
        className="tap press flex h-9 w-4 items-center justify-center rounded-sm border border-edge-strong bg-surface text-muted shadow-sm hover:bg-raised hover:text-fg"
      >
        <Icon as={open ? ChevronLeft : ChevronRight} size={12} />
      </button>
    </div>
  );
}
