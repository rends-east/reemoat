import { Bot, Check, ChevronDown, Gauge, MoreHorizontal, SlidersHorizontal, Sparkles } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { errorText, meansRestartRefused } from "../http";
import { beginChoice, choicesFor, choicesVersion, endChoice, subscribeChoices } from "../choices";
import { LAYER, useDismissible } from "./overlay";
import { keyOf, type SessionRef } from "../ids";
import { store } from "../store";
import type { AgentConfigChoice, AgentConfigOption, StoredEvent } from "../wire";
import {
  chipParts,
  choiceLabel,
  choiceOverride,
  drawnChoices,
  choiceRefusal,
  configProse,
  labelFor,
  NESTED_HOST,
  slotFor,
  splitOptions,
  unavailableHint,
  withChoice,
  type ChipParts,
  type ConfigProse,
  type DrawnControls,
  effortFollowUp,
} from "./agentConfig";
import { Icon, MENU_HEADING, MENU_PANEL, menuRow, TAP_GROW_Y } from "./bits";
import { toast } from "./Toast";

/** Draws the agent's answer, never the requested value; records the pending choice for both doors until then. */
export function applyConfigChange(
  sessionRef: SessionRef,
  configId: string,
  value: string | boolean,
): Promise<boolean> {
  const daemon = store.daemonFor(sessionRef.machineId);
  if (daemon === undefined) {
    toast("error", "that machine is not reachable");
    return Promise.resolve(false);
  }
  const before =
    store.getSnapshot().sessions.find((row) => row.key === keyOf(sessionRef))?.snapshot.agentConfig?.options ?? [];
  const held = beginChoice(keyOf(sessionRef), configId, value);
  return daemon
    .setConfig(sessionRef.sessionId, { configId, value })
    .then((result) => {
      store.applySnapshot(sessionRef, result.session);
      const followUp = effortFollowUp(
        before.find((option) => option.id === configId),
        before,
        result.session.agentConfig?.options ?? [],
      );
      if (followUp !== null) return applyConfigChange(sessionRef, followUp.configId, followUp.value);
      return true;
    })
    .catch((cause: unknown) => {
      // Only a restart refusal is swallowed: the row already says why.
      if (!meansRestartRefused(cause)) toast("error", errorText(cause));
      return false;
    })
    .finally(() => endChoice(held));
}

/** Drawn from ACP category, never id, and values from the snapshot: claude drops bypassPermissions as root without IS_SANDBOX. */

const CATEGORY_ICON: Record<string, ComponentType<{ size?: number | string; className?: string }>> = {
  mode: SlidersHorizontal,
  model: Bot,
  thought_level: Gauge,
  model_config: Sparkles,
};

const CHIP_MAX = "max-w-32";

// Must equal --animate-sheet-out in index.css; webcheck asserts it.
const SHEET_EXIT_MS = 260;

const SHEET_FULL = "92dvh";

// SHEET_FULL as a fraction, for the drag math; webcheck asserts they agree.
const SHEET_FULL_SHARE = 0.92;

const SHEET_DRAG_STEP = 24;

const SHEET_DISMISS_PX = 72;

// Must equal the transition literal in .config-sheet; webcheck asserts it.
const SHEET_SETTLE_MS = 300;

// Borderless in the composer's box: the chevron marks a chip as a control, so it shows at every width.
const CHIP = `tap press relative inline-flex min-h-8 items-center gap-1.5 rounded-md border text-2xs ${TAP_GROW_Y}`;

export function AgentConfigBar({
  sessionRef,
  controls,
  events,
  disabled,
  turnRunning,
}: {
  sessionRef: SessionRef;
  controls: DrawnControls;
  events: readonly StoredEvent[];
  disabled: boolean;
  /** The daemon's turnInFlight, which refuses a restarting change; not disabled and not controls.stale. */
  turnRunning: boolean;
}): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);
  useSyncExternalStore(subscribeChoices, choicesVersion);
  const pending = choicesFor(keyOf(sessionRef));

  const { options: polledOptions, stale, unavailable } = controls;

  // The poll carries only a head of long lists; a truncated control triggers one full read.
  const [fullOptions, setFullOptions] = useState<readonly AgentConfigOption[] | null>(null);
  const sessionKey = keyOf(sessionRef);
  const anyTruncated = polledOptions.some((one) => one.truncated === true);
  useEffect(() => {
    setFullOptions(null);
  }, [sessionKey]);
  useEffect(() => {
    if (!anyTruncated || fullOptions !== null) return;
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) return;
    let live = true;
    void daemon
      .session(sessionRef.sessionId)
      .then((answer) => {
        if (live) setFullOptions(answer.session.agentConfig?.options ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [anyTruncated, fullOptions, sessionKey, sessionRef.machineId, sessionRef.sessionId]);

  // Untruncated options keep their identity: drawnChoices memoises on it.
  const options = useMemo(
    () =>
      fullOptions === null
        ? polledOptions
        : polledOptions.map((one) => {
            if (one.truncated !== true) return one;
            const whole = fullOptions.find((candidate) => candidate.id === one.id);
            if (whole === undefined) return one;
            return { ...whole, value: one.value, truncated: false };
          }),
    [polledOptions, fullOptions],
  );
  const slots = splitOptions(options, unavailable);

  // A menu layer, so the ask card's digit shortcuts stay off underneath.
  useDismissible("menu", () => setOverflowOpen(false), overflowOpen && slots.overflow.length > 0);

  useEffect(() => {
    if (!overflowOpen) return;
    const close = (event: Event): void => {
      if (overflowRef.current?.contains(event.target as Node) !== true) setOverflowOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [overflowOpen]);

  const prose = useMemo(() => configProse(events), [events]);

  if (options.length === 0) return null;

  const apply = (option: AgentConfigOption, value: string | boolean): void => {
    setBusy(option.id);
    void applyConfigChange(sessionRef, option.id, value).finally(() => setBusy(null));
  };

  // Below sm the model chip folds into a live mode host, or it would be unreachable on a phone.
  const foldHost = slots.left.find(
    (one) => one.category === NESTED_HOST && one.kind !== "boolean" && !unavailable.has(one.id),
  );
  const foldedBelowSm =
    foldHost === undefined ? [] : slots.right.filter((one) => one.category === "model");

  const control = (option: AgentConfigOption): ReactNode => {
    const nested = option.category === NESTED_HOST ? slots.nested : [];
    const narrow = option.category === NESTED_HOST ? foldedBelowSm : [];
    if (unavailable.has(option.id)) {
      return <Absent key={option.id} option={option} never={controls.never.has(option.id)} />;
    }
    return option.kind === "boolean" ? (
      <Toggle
        key={option.id}
        option={withChoice(option, pending)}
        prose={prose.get(option.id)}
        disabled={disabled || stale}
        locked={busy !== null}
        onChange={(value) => apply(option, value)}
      />
    ) : (
      <Select
        key={option.id}
        option={withChoice(option, pending)}
        nested={nested.map((sub) => withChoice(sub, pending))}
        narrow={narrow.map((sub) => withChoice(sub, pending))}
        proseOf={(sub) => prose.get(sub.id)}
        disabled={disabled || stale}
        locked={busy !== null}
        refuses={(sub, value) => choiceRefusal(sub, value, turnRunning)}
        onChange={apply}
      />
    );
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2">
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">{slots.left.map(control)}</div>

      <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
        {slots.right.map((option) =>
          option.category === "model" ? (
            <div
              key={option.id}
              className={foldedBelowSm.length > 0 ? "hidden sm:contents" : "contents"}
            >
              {control(option)}
            </div>
          ) : (
            control(option)
          ),
        )}

        {slots.overflow.length > 0 && (
          <div ref={overflowRef} className="relative">
            <button
              type="button"
              onClick={() => setOverflowOpen(!overflowOpen)}
              disabled={disabled || stale || busy !== null}
              aria-label="More controls"
              aria-expanded={overflowOpen}
              // Not IconButton: a disclosure needs aria-expanded. CHIP stays interpolated for webcheck's 44px sweep.
              className={`${CHIP} w-8 justify-center border-transparent ${
                disabled || stale
                  ? "text-faint"
                  : "text-muted hover:bg-raised active:bg-raised hover:text-fg"
              }`}
            >
              <Icon as={MoreHorizontal} size={13} />
            </button>
            {overflowOpen && (
              <div
                className={`absolute right-0 bottom-full ${LAYER.menu} mb-1 flex w-max max-w-[min(20rem,calc(100vw-2rem))] flex-col gap-1.5 rounded-lg border border-edge bg-surface p-2 shadow-xl`}
              >
                {slots.overflow.map(control)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function label(option: AgentConfigOption): ReactNode {
  const icon = CATEGORY_ICON[option.category ?? ""];
  return icon === undefined ? null : (
    <span className="text-faint">
      <Icon as={icon} size={11} />
    </span>
  );
}

function chipInner(option: AgentConfigOption, parts: ChipParts): ReactNode {
  return (
    <>
      {label(option)}
      {parts.caption !== null && (
        <span className={`${CHIP_MAX} truncate text-faint`}>{parts.caption}</span>
      )}
      {/* No fixed reserve, the old chipReserve: the value hugs its text up to CHIP_MAX (Q3.564). */}
      <span className={`${CHIP_MAX} truncate`}>{parts.value}</span>
    </>
  );
}

// Keeps its slot and is not disabled: it opens and says why nothing can be chosen.
function Absent({
  option,
  never,
}: {
  option: AgentConfigOption;
  never: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const hint = unavailableHint(option, never);

  useDismissible("menu", () => setOpen(false), open);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (boxRef.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={boxRef} className="relative">
      <button
        // Explicit type: inside the composer's form a typeless button submits the draft.
        type="button"
        onClick={() => setOpen(!open)}
        title={`${labelFor(option)}: ${hint}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${labelFor(option)}: ${hint}`}
        className={`${CHIP} border-transparent px-2 text-muted hover:bg-raised active:bg-raised`}
      >
        {chipInner(option, chipParts(option, false))}
        <Icon as={ChevronDown} size={12} className="text-faint" />
      </button>

      {open && (
        <div
          className={`absolute bottom-full ${
            slotFor(option) === "left" ? "left-0" : "right-0"
          } mb-1 w-60 max-w-[calc(100vw-1.5rem)] ${MENU_PANEL}`}
        >
          <p className={`${MENU_HEADING} flex items-center gap-1.5`}>
            {label(option)}
            {labelFor(option)}
          </p>
          <p className="px-2.5 pt-1 pb-2 text-xs text-muted">{hint}</p>
        </div>
      )}
    </div>
  );
}

function Select({
  option,
  nested = [],
  narrow = [],
  proseOf,
  disabled,
  locked,
  refuses,
  onChange,
}: {
  option: AgentConfigOption;
  nested?: readonly AgentConfigOption[];
  narrow?: readonly AgentConfigOption[];
  proseOf: (option: AgentConfigOption) => ConfigProse | undefined;
  /** No agent to ask: inert and dimmed. */
  disabled: boolean;
  /** Another control is in flight: inert, not dimmed. */
  locked: boolean;
  refuses: (option: AgentConfigOption, value: string | boolean) => string | null;
  onChange: (option: AgentConfigOption, value: string) => void;
}): ReactNode {
  const prose = proseOf(option);
  const align = slotFor(option) === "left" ? "left-0" : "right-0";
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  /** Full detent below sm: the list is clipped at rest and scrolls only when full. */
  const [expanded, setExpanded] = useState(false);
  const restH = useRef<number | null>(null);
  const live = useRef({ height: 0, below: 0 });
  const settle = useRef<number | null>(null);
  const restore = useRef<number | null>(null);
  /** Geometry goes straight onto the node, avoiding a render per pointer move. */
  const paint = (vars: Record<string, string | null>): void => {
    const panel = sheetRef.current;
    if (panel === null) return;
    for (const [name, value] of Object.entries(vars)) {
      if (value === null) panel.style.removeProperty(name);
      else panel.style.setProperty(name, value);
    }
  };
  const atRest = (): void =>
    paint({
      "--sheet-h": null,
      "--sheet-y": null,
      "--sheet-min": null,
      "--sheet-max": null,
    });
  const settling = (on: boolean): void => {
    // Cancel a pending restore, or a new drag gets its transition back mid-gesture.
    if (restore.current !== null) {
      window.cancelAnimationFrame(restore.current);
      restore.current = null;
    }
    const panel = sheetRef.current;
    if (panel === null) return;
    panel.style.transition = on ? "" : "none";
  };
  /** Writes without a transition and restores it a frame later. */
  const paintNow = (vars: Record<string, string | null>): void => {
    settling(false);
    paint(vars);
    restore.current = window.requestAnimationFrame(() => {
      restore.current = null;
      settling(true);
    });
  };
  const exit = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; y: number; height: number } | null>(null);
  /** Lets the capture handler swallow the click a drag would send to a row. */
  const dragged = useRef(false);

  const dismiss = (): void => {
    if (exit.current !== null) return;
    setLeaving(true);
    exit.current = window.setTimeout(() => {
      exit.current = null;
      setLeaving(false);
      setOpen(false);
    }, SHEET_EXIT_MS);
  };

  // Cancels an unfinished exit, or a fast tap-tap leaves the sheet stuck leaving.
  const show = (): void => {
    if (exit.current !== null) {
      window.clearTimeout(exit.current);
      exit.current = null;
    }
    setLeaving(false);
    if (settle.current !== null) {
      window.clearTimeout(settle.current);
      settle.current = null;
    }
    drag.current = null;
    restH.current = null;
    live.current = { height: 0, below: 0 };
    settling(true);
    atRest();
    setExpanded(false);
    setOpen(true);
  };

  // Guarded: above sm the portal measures zero.
  useLayoutEffect(() => {
    if (!open || sheetRef.current === null) return;
    const height = sheetRef.current.getBoundingClientRect().height;
    if (height > 0) restH.current = height;
  }, [open]);

  // Move and release are on the full-viewport scrim, so a finger leaving the panel keeps dragging.
  const fullHeight = (): number => window.innerHeight * SHEET_FULL_SHARE;
  const restHeight = (): number => restH.current ?? window.innerHeight / 2;

  const dragStart = (event: ReactPointerEvent<HTMLElement>): void => {
    dragged.current = false;
    if (expanded && listRef.current?.contains(event.target as Node) === true) return;
    const panel = sheetRef.current;
    if (panel === null) return;
    if (settle.current !== null) {
      window.clearTimeout(settle.current);
      settle.current = null;
    }
    drag.current = { id: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height };
  };

  const dragMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const from = drag.current;
    if (from === null || from.id !== event.pointerId) return;
    const travelled = event.clientY - from.y;
    if (!dragged.current && Math.abs(travelled) < SHEET_DRAG_STEP) return;
    if (!dragged.current) {
      dragged.current = true;
      // Captured here, not at pointer down, which would retarget every tap's click.
      sheetRef.current?.setPointerCapture(event.pointerId);
    }
    const rest = restHeight();
    const wanted = from.height - travelled;
    const next =
      wanted >= rest
        ? { height: Math.min(wanted, fullHeight()), below: 0 }
        : { height: rest, below: rest - wanted };
    live.current = next;
    settling(false);
    paint({
      "--sheet-min": "0px",
      "--sheet-max": SHEET_FULL,
      "--sheet-h": `${next.height}px`,
      "--sheet-y": `${next.below}px`,
    });
  };

  const dragEnd = (pointerId: number): void => {
    const from = drag.current;
    if (from === null || from.id !== pointerId) return;
    drag.current = null;
    if (!dragged.current) return;
    // Keep the offset: the exit keyframe animates from the current transform.
    if (live.current.below > SHEET_DISMISS_PX) {
      dismiss();
      return;
    }
    const rest = restHeight();
    const full = fullHeight();
    const toFull = live.current.height > (rest + full) / 2;
    settling(true);
    paint({ "--sheet-y": "0px", "--sheet-h": `${toFull ? full : rest}px` });
    setExpanded(toFull);
    // The pixel height must outlive the settle animation and no longer.
    settle.current = window.setTimeout(() => {
      settle.current = null;
      if (toFull) paintNow({ "--sheet-h": null, "--sheet-y": null, "--sheet-min": SHEET_FULL, "--sheet-max": SHEET_FULL });
      else paintNow({ "--sheet-h": null, "--sheet-y": null, "--sheet-min": null, "--sheet-max": null });
    }, SHEET_SETTLE_MS);
  };

  const toggleDetent = (): void => {
    if (settle.current !== null) {
      window.clearTimeout(settle.current);
      settle.current = null;
    }
    settling(true);
    if (expanded) atRest();
    else paint({ "--sheet-h": null, "--sheet-y": null, "--sheet-min": SHEET_FULL, "--sheet-max": SHEET_FULL });
    setExpanded(!expanded);
  };

  useEffect(
    () => () => {
      if (exit.current !== null) window.clearTimeout(exit.current);
      if (settle.current !== null) window.clearTimeout(settle.current);
      if (restore.current !== null) window.cancelAnimationFrame(restore.current);
    },
    [],
  );

  const current = drawnChoices(option).find((choice) => choice.value === option.value);
  const currentProse =
    prose?.choices.get(String(option.value)) ?? current?.description ?? null;
  const currentName = current === undefined ? null : choiceLabel(option, current);

  const parts = chipParts(option, true, prose);

  useDismissible("menu", dismiss, open);

  // Both boxes are tested because the sheet is portalled outside boxRef.
  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      const target = event.target as Node;
      const inside =
        boxRef.current?.contains(target) === true || sheetRef.current?.contains(target) === true;
      if (!inside) dismiss();
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const sections = (list: readonly AgentConfigOption[], where: string): ReactNode =>
    list.map((section, index) => (
      <ChoiceSection
        key={section.id}
        where={where}
        option={section}
        prose={proseOf(section)}
        divided={index > 0}
        refuses={refuses}
        onChoose={(value) => {
          dismiss();
          if (value !== section.value) onChange(section, value);
        }}
      />
    ));

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? dismiss() : show())}
        disabled={disabled || locked}
        title={
          currentProse === null
            ? (currentName ?? prose?.description ?? option.description ?? labelFor(option))
            : `${labelFor(option)}: ${currentProse}`
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={labelFor(option)}
        // Dimmed by token, never opacity: a faded chip falls below 3:1 contrast.
        className={`${CHIP} border-transparent px-2 ${
          disabled ? "text-faint" : "text-muted hover:bg-raised active:bg-raised hover:text-fg"
        }`}
      >
        {chipInner(option, parts)}
        <Icon as={ChevronDown} size={12} className="text-faint" />
      </button>

      {open && !leaving && (
        <div
          role="listbox"
          className={`absolute bottom-full ${align} mb-1 hidden w-60 max-w-[calc(100vw-1.5rem)] sm:block ${MENU_PANEL}`}
        >
          {sections([option, ...nested], "panel")}
        </div>
      )}
      {/* Not Sheet: it would set inert on the root even while hidden above sm. */}
      {open &&
        createPortal(
          <div
            data-config-scrim=""
            className={`${
              leaving ? "animate-scrim-out" : "animate-scrim"
            } fixed inset-0 ${LAYER.overlay} flex touch-manipulation flex-col justify-end bg-fg/25 sm:hidden`}
            onClick={(event) => {
              if (event.target === event.currentTarget) dismiss();
            }}
            onPointerMove={dragMove}
            onPointerUp={(event) => dragEnd(event.pointerId)}
            onPointerCancel={(event) => dragEnd(event.pointerId)}
          >
            <div
              ref={sheetRef}
              onPointerDown={dragStart}
              // Swallows the one click a drag leaves behind.
              onClickCapture={(event) => {
                if (!dragged.current) return;
                dragged.current = false;
                event.preventDefault();
                event.stopPropagation();
              }}
              className={`config-sheet pb-safe ${
                leaving ? "animate-sheet-out" : "animate-sheet"
              } flex w-full flex-col overflow-hidden overscroll-contain rounded-t-2xl border-t border-edge bg-surface shadow-2xl`}
            >
              <button
                type="button"
                onClick={toggleDetent}
                aria-label={expanded ? "Collapse the menu" : "Expand the menu"}
                aria-expanded={expanded}
                className={`tap relative flex min-h-8 shrink-0 touch-none items-center justify-center ${TAP_GROW_Y}`}
              >
                <span aria-hidden className="h-1 w-9 rounded-full bg-edge-strong" />
              </button>
              <div
                ref={listRef}
                // This copy owns the listbox role too, or the phone's option rows are orphans.
                role="listbox"
                className={`min-h-0 overscroll-contain px-1.5 pb-1.5 ${
                  expanded ? "flex-1 overflow-y-auto" : "touch-none overflow-hidden"
                }`}
              >
                {sections([option, ...nested, ...narrow], "sheet")}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function ChoiceSection({
  option,
  where,
  prose,
  divided,
  refuses,
  onChoose,
}: {
  option: AgentConfigOption;
  where: string;
  prose: ConfigProse | undefined;
  divided: boolean;
  /** Required: without it a refused row does nothing and says nothing. */
  refuses: (option: AgentConfigOption, value: string | boolean) => string | null;
  onChoose: (value: string) => void;
}): ReactNode {
  // Read once: refusals and rows must index the same list.
  const choices = drawnChoices(option);
  const refusals = choices.map((choice) => refuses(option, choice.value));
  const refused = refusals.filter((text): text is string => text !== null);
  const shared =
    refused.length > 1 && refused.every((text) => text === refused[0]) ? (refused[0] ?? null) : null;
  const sharedId = `${where}-${option.id}-refusal`;
  return (
    <div className={divided ? "mt-1 border-t border-edge pt-1" : undefined}>
      <p className={`${MENU_HEADING} flex items-center gap-1.5`}>
        {label(option)}
        {labelFor(option)}
      </p>
      {(prose?.description ?? option.description) !== null && (
        <p className="px-2 pb-1 text-2xs text-faint">{prose?.description ?? option.description}</p>
      )}
      {shared !== null && (
        <p id={sharedId} className="px-2 pb-1 text-2xs text-muted">
          {shared}
        </p>
      )}
      {option.truncated === true && (
        <p className="px-2 pb-1 text-2xs text-muted">
          Showing the first {choices.length}. The rest of this list has not loaded.
        </p>
      )}
      {choices.map((choice, index) => {
            const heading = choice.group !== null && choice.group !== choices[index - 1]?.group;
            // Transcript prose first: the snapshot strips descriptions of unselected choices.
            const description = rowDescription(
              option,
              choice.value,
              prose?.choices.get(String(choice.value)) ?? choice.description,
            );
            const refusal = refusals[index] ?? null;
            return (
              <div key={`${choice.group ?? ""}:${choice.value}`}>
                {heading && (
                  <p className="mt-1 px-2 py-0.5 text-2xs text-faint">{choice.group}</p>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={choice.value === option.value}
                  aria-disabled={refusal !== null || undefined}
                  aria-describedby={refusal !== null && shared !== null ? sharedId : undefined}
                  onClick={() => {
                    if (refusal !== null) return;
                    onChoose(String(choice.value));
                  }}
                  className={`${menuRow("start")} hover:bg-raised ${
                    choice.value === option.value ? "font-medium" : ""
                  }`}
                >
                  <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                    {choice.value === option.value && (
                      <Icon as={Check} size={14} className="stroke-[2.5]" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className={`block truncate ${refusal !== null ? "text-muted" : ""}`}>
                      {rowLabel(option, choice)}
                    </span>
                    {refusal !== null && shared === null ? (
                      <span className="block text-2xs text-muted">{refusal}</span>
                    ) : (
                      description !== null && (
                        <span className="block text-2xs text-faint">{description}</span>
                      )
                    )}
                  </span>
                </button>
              </div>
            );
          })}
    </div>
  );
}

function rowLabel(option: AgentConfigOption, choice: AgentConfigChoice): string {
  return choiceLabel(option, choice);
}

function rowDescription(
  option: AgentConfigOption,
  value: string | boolean,
  own: string | null,
): string | null {
  return own ?? choiceOverride(option, value)?.description ?? null;
}

function Toggle({
  option,
  prose,
  disabled,
  locked,
  onChange,
}: {
  option: AgentConfigOption;
  prose: ConfigProse | undefined;
  disabled: boolean;
  locked: boolean;
  onChange: (value: boolean) => void;
}): ReactNode {
  const on = option.value === true;
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      disabled={disabled || locked}
      title={prose?.description ?? option.description ?? labelFor(option)}
      aria-pressed={on}
      className={`${CHIP} px-2 ${
        disabled
          ? "border-transparent text-faint"
          : on
            ? "border-edge-strong bg-raised font-medium text-fg hover:bg-edge active:bg-edge"
            : "border-transparent text-muted hover:bg-raised active:bg-raised hover:text-fg"
      }`}
    >
      {label(option)}
      <span className={`${CHIP_MAX} truncate`}>{labelFor(option)}</span>
    </button>
  );
}
