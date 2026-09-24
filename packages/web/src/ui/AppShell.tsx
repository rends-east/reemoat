import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { AGENT_HOST_OS, installCommand } from "../enrollment";
import { controlPlaneOrigin } from "../native";
import { keyOf } from "../ids";
import { machineQuotaNotice, mayAddMachine } from "../quota";
import type { Route } from "../router";
import type { AppState } from "../store";
import { CommandLine } from "./CommandLine";
import { MachineColumn } from "./MachineColumn";
import { SessionBrowser } from "./SessionBrowser";
import { useKeyboard } from "./keyboard";
import { LAYER } from "./overlay";
import { PaneHandle } from "./PaneHandle";
import { rail, railWidth, subscribeRail } from "./rail";
import { subscribeTaskWidth, taskWidth } from "./taskWidth";

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

  return (
    <div className="relative flex h-dvh">
      {/* `overflow-hidden` so its two children scroll independently; `border-r` because `ink` on `surface` is only 1.06:1. */}
      <aside className="hidden shrink-0 overflow-hidden border-r border-edge bg-ink lg:flex lg:w-[var(--rail-w)]">
        <MachineColumn state={state} onMenu={onMenu} />
        <SessionBrowser state={state} activeKey={activeKey} onMenu={onMenu} />
      </aside>

      {/* `min-w-0` stops long lines widening this pane; screens stretch inside it rather than using `h-full`. */}
      {/* Clipped while a back swipe draws the list: a conversation translated past its edge grew its scroll width and repainted it every frame (Q3.663). */}
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-surface has-[>[data-back-under]]:overflow-hidden">
        {children}
      </main>

      <RailHandle />
    </div>
  );
}

export function NothingSelected({ state }: { state: AppState }): ReactNode {
  const probing = state.machines.some((m) => m.reach === "probing" || m.reach === "unknown");
  if (state.machines.length === 0 && !probing) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted">No machines yet.</p>
        {mayAddMachine(state.me) ? (
          <>
            <p className="text-xs text-muted">Run this on the {AGENT_HOST_OS} machine you want to use:</p>
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
