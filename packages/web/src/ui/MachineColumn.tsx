import { Layers, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { mayAddMachine } from "../quota";
import { navigate } from "../router";
import { settingsPath } from "../settings";
import { sessionGroups, type AppState } from "../store";
import { Icon, Monogram } from "./bits";
import { useMachineDrag, type MachineDrag } from "./machineDrag";
import {
  allTab,
  currentView,
  groupsVersion,
  machineTabs,
  selectMachine,
  subscribeGroups,
  type MachineTab,
} from "./groups";

/** The machine strip drawn as a column at lg and above, on the same groups state as SessionBrowser; order is machineTabs' and is never re-sorted here. */
export function MachineColumn({ state, onMenu }: { state: AppState; onMenu: () => void }): ReactNode {
  useSyncExternalStore(subscribeGroups, groupsVersion);
  const groups = sessionGroups(state);
  const view = currentView(groups);
  const tabs = machineTabs(groups, view);
  const all = allTab(groups, view);
  const selected = view.all ? null : view.machine;
  const scroller = useRef<HTMLDivElement | null>(null);
  const drag = useMachineDrag({ axis: "y", tabs });

  // Stable on purpose: an inline ref would re-attach the drag's listeners on every poll render.
  const hold = useCallback(
    (node: HTMLDivElement | null): void => {
      scroller.current = node;
      drag.scrollerRef(node);
    },
    [drag.scrollerRef],
  );

  useEffect(() => {
    if (selected === null) return;
    scroller.current
      ?.querySelector(`[data-machine="${CSS.escape(selected)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  return (
    // The width is in device pixels to match MACHINE_COLUMN_PX in rail.ts.
    <nav aria-label="Machines" className="flex w-[80px] shrink-0 flex-col border-r border-edge">
      {/* A plain button rather than IconButton: w-full cannot reliably override the chip size's fixed width. */}
      {/* Tall enough that its lower half clears the menu bar macOS slides over a full-screen window; lit edge to edge as an entry is (Q3.666). */}
      <div className="pt-safe shrink-0">
        <button
          type="button"
          aria-label="Menu"
          onClick={onMenu}
          className="tap flex h-14 w-full items-center justify-center text-muted hover:bg-raised/60 hover:text-fg"
        >
          <FlatMenuGlyph />
        </button>
      </div>
      <div ref={hold} className="min-h-0 flex-1 overflow-y-auto">
        <MachineEntry tab={all} glyph={<Icon as={Layers} size={16} />} />
        {tabs.map((tab, index) => (
          <MachineEntry key={tab.id} tab={tab} index={index} drag={drag} />
        ))}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {drag.announcement}
      </p>
      {mayAddMachine(state.me) && (
        <div className="pb-safe shrink-0 border-t border-edge pt-1">
          <button
            type="button"
            onClick={() => navigate(settingsPath("machines"))}
            className="tap flex min-h-14 w-full flex-col items-center justify-center gap-1 text-muted hover:bg-raised hover:text-fg"
          >
            <Icon as={Plus} size={18} />
            <span className="text-xs">Add</span>
          </button>
        </div>
      )}
    </nav>
  );
}

function MachineEntry({
  tab,
  glyph,
  index,
  drag,
}: {
  tab: MachineTab;
  glyph?: ReactNode;
  /** Absent on `All`, which is not a machine and may not be reordered. */
  index?: number;
  drag?: MachineDrag;
}): ReactNode {
  // Selection fills the mark, never the tile, so it cannot misalign with the session list's selected row (bg-fg on a mark narrows Q3.209).
  // The colour transition sits on the chip because .tap's transition is not inherited by it.
  const tile = tab.selected ? "" : "hover:bg-raised/60";
  const chip = tab.selected
    ? "bg-fg text-ink transition-colors"
    : "bg-raised text-muted transition-colors";
  const movable = drag !== undefined && index !== undefined;
  const shift = movable ? drag.shiftFor(index) : 0;
  const lifted = movable && drag.dragging === tab.id;
  // The carried entry is never transitioned (its transform is rewritten every frame); neighbours use slides, since .tap's transition shorthand overrides the utility.
  return (
    <button
      type="button"
      onClick={() => selectMachine(tab.id)}
      aria-pressed={tab.selected}
      title={tab.name}
      style={shift === 0 ? undefined : { transform: `translateY(${String(shift)}px)` }}
      {...(movable ? drag.bind(tab.id, index) : { "data-machine": tab.id })}
      className={`tap group relative flex w-full flex-col items-center gap-1 px-0.5 py-2.5 ${tile} ${
        drag?.sliding === true && !lifted ? "slides" : ""
      } ${lifted ? "z-10 bg-surface shadow-lg will-change-transform" : ""}`}
    >
      {glyph === undefined ? (
        <Monogram name={tab.name} size="rail" className={chip} />
      ) : (
        <span
          aria-hidden="true"
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${chip}`}
        >
          {glyph}
        </span>
      )}
      <span
        className={`w-full truncate text-center text-xs ${
          tab.selected ? "font-medium text-fg" : "text-muted group-hover:text-fg"
        }`}
      >
        {tab.name}
      </span>
      {tab.blockedCount > 0 && (
        // The ring separates the badge from the selected chip, which is also bg-fg.
        <span className="pointer-events-none absolute top-1 right-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-fg px-1 text-2xs font-semibold text-ink ring-2 ring-ink [@media(pointer:coarse)]:h-5 [@media(pointer:coarse)]:min-w-5">
          {tab.blockedCount}
        </span>
      )}
    </button>
  );
}

/** Three wide, thin bars, flatter than lucide's square menu glyph, as Telegram draws its own (Q3.666). */
function FlatMenuGlyph(): ReactNode {
  return (
    <svg aria-hidden="true" width="22" height="14" viewBox="0 0 22 14" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <path d="M1 1h20M1 7h20M1 13h20" />
    </svg>
  );
}
