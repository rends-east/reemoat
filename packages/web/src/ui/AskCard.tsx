import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { optionShortcut } from "../keys";
import { COLUMN, Icon, IconButton, Spinner } from "./bits";
import { focusWorthKeeping } from "./composing";
import { currentLayers, decisionShortcutsEnabled, useDismissible } from "./overlay";

export interface AskOption {
  id: string;
  label: string;
  description?: string | null;
  /** The agent's own wording, when the label is ours. A tooltip, never drawn. */
  hint?: string | null;
  chosen?: boolean;
  /** Drawn as the indicator's shape: one is a circle, many a box; absent draws nothing, as on every permission. */
  mark?: "one" | "many" | null;
  busy?: boolean;
  leading?: boolean;
  primary?: boolean;
  onPick: () => void;
}

/** rows are answers; buttons are a decision about one tool call, with the refusal left and the filled approval right. */
export type AskLayout = "rows" | "buttons";

// Whole literal class strings, since Tailwind reads this file as text. 100% governs; the dvh value is only a ceiling.
const BOX_MAX = {
  normal: "max-h-[min(70dvh,100%)]",
  tall: "max-h-[min(88dvh,100%)]",
} as const;

export type AskSize = keyof typeof BOX_MAX;

// Keyed on a coarse pointer, not a breakpoint: the digits are keyboard shortcuts.
const KEYS_ONLY = "pointer-coarse:hidden";

// edge-strong: these rows have no fill, so the border is the only sign of a control.
const ROW = "border-edge-strong bg-surface text-fg hover:bg-raised";

// Border, fill and an inset ring; a ring cannot reflow the row as a weight change did (Q3.421).
const CHOSEN = "border-fg bg-raised text-fg ring-1 ring-fg ring-inset hover:bg-edge";

export function AskCard({
  title,
  detail,
  agent,
  collapsed,
  onToggle,
  onDismiss,
  dismissLabel,
  dismissDisabled = false,
  dismissBusy = false,
  more,
  options,
  layout = "rows",
  busy,
  context,
  extra,
  actions,
  size = "normal",
  onHeight,
}: {
  title: string;
  detail?: ReactNode;
  agent?: string;
  collapsed: boolean;
  onToggle: (next: boolean) => void;
  onDismiss: () => void;
  dismissLabel: string;
  dismissDisabled?: boolean;
  dismissBusy?: boolean;
  more: number;
  options: AskOption[];
  layout?: AskLayout;
  busy: boolean;
  context?: ReactNode;
  extra?: ReactNode;
  actions?: ReactNode;
  size?: AskSize;
  /** Current height, so the transcript can pad past this out-of-flow card; 0 on unmount. */
  onHeight?: (px: number) => void;
}): ReactNode {
  const headingId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);

  const heightOut = useRef(onHeight);
  heightOut.current = onHeight;
  // Layout effects, so the room is reserved in the frame the card paints over the rows; the observer alone lands a frame late (Q3.649).
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null || typeof ResizeObserver === "undefined") return;
    const send = (): void => heightOut.current?.(panel.offsetHeight);
    send();
    const observer = new ResizeObserver(send);
    observer.observe(panel);
    return () => {
      observer.disconnect();
      heightOut.current?.(0);
    };
  }, [collapsed]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel !== null) heightOut.current?.(panel.offsetHeight);
  });

  // Off while collapsed and under any other layer: inert does not stop a window keydown.
  useEffect(() => {
    if (collapsed || busy) return;
    const onKey = (event: KeyboardEvent): void => {
      if (!decisionShortcutsEnabled(currentLayers())) return;
      const index = optionShortcut(event, event.target, options.length);
      if (index === null) return;
      const option = options[index];
      if (option === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      option.onPick();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // Escape folds the card away; it never cancels.
  useDismissible("ask", () => onToggle(true), !collapsed);

  const moreNow = useRef(more);
  useEffect(() => {
    moreNow.current = more;
  });

  // Restores focus only if this card held it, and not when another card takes its place.
  useEffect(() => {
    const previous = document.activeElement;
    return () => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      if (moreNow.current > 0) return;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else document.body.focus();
    };
  }, []);

  // A frame later, once the composer has released the caret; the panel rather than an option, so the request is announced.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const frame = requestAnimationFrame(() => {
      if (panel.contains(document.activeElement)) return;
      if (focusWorthKeeping(document.activeElement)) return;
      panel.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [collapsed]);

  // Committed empty and filled on the next render, which is what gets announced; the wait is left out.
  const [spoken, setSpoken] = useState("");
  const waiting = `${title} — ${agent === undefined || agent.length === 0 ? "the agent" : agent} is waiting for an answer`;
  useEffect(() => {
    setSpoken(waiting);
  }, [waiting]);

  // No grown target: at this spacing it would reach onto the neighbour's face.
  const toggle = (
    <IconButton
      icon={collapsed ? ChevronRight : ChevronDown}
      size="lg"
      onClick={() => onToggle(!collapsed)}
      title={collapsed ? "Show the question" : "Fold it away and read the conversation"}
      label={collapsed ? "Expand this request" : "Collapse this request"}
      expanded={!collapsed}
    />
  );

  // Cancel only on the open card: a one-line bar must not end a tool call.
  const controls = (withCancel: boolean): ReactNode => (
    <div className="flex shrink-0 items-center gap-1">
      {more > 0 && <MoreWaiting count={more} />}
      {toggle}
      {withCancel && cancel}
    </div>
  );

  // Set apart by a hairline and padding, and colourless: cancelling authorizes nothing.
  const cancel = (
    <span className="relative ml-1 flex items-center border-l border-edge/60 pl-1">
      <IconButton
        icon={X}
        size="lg"
        onClick={onDismiss}
        disabled={dismissDisabled || dismissBusy}
        title={dismissLabel}
        label={dismissLabel}
      />
      {dismissBusy && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner />
        </span>
      )}
    </span>
  );

  // No z-index: a positive one would outrank the composer's menus, trapped in its backdrop-blur context.
  return (
    <div className={`pointer-events-none absolute inset-0 ${COLUMN} flex flex-col justify-end px-4 pb-2`}>
      {collapsed ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-labelledby={headingId}
          tabIndex={-1}
          className="animate-rise pointer-events-auto flex min-h-11 w-full shrink-0 items-center gap-1 rounded-lg border border-edge-strong bg-surface py-1.5 pr-1 pl-3 shadow-2xl outline-none"
        >
          {/* wrap-anywhere, never truncate: nothing an agent asked may be shortened. */}
          <span id={headingId} className="min-w-0 flex-1 text-xs font-medium wrap-anywhere">{title}</span>
          {detail !== undefined && detail !== null && (
            <span className="shrink-0 text-2xs text-faint">{detail}</span>
          )}
          {controls(false)}
        </div>
      ) : (
        // Title and footer never shrink; the middle boxes scroll and have floors, so the controls are never clipped.
        <div
          ref={panelRef}
          role="dialog"
          aria-labelledby={headingId}
          tabIndex={-1}
          className={`animate-rise pointer-events-auto flex w-full ${BOX_MAX[size]} min-h-0 flex-col overflow-hidden rounded-lg border border-edge-strong bg-surface shadow-2xl outline-none`}
        >
          <div className="flex shrink-0 items-start gap-1 px-3 pt-2.5 pb-2">
            <div className="mt-1 min-w-0 flex-1">
              <p id={headingId} className="text-sm font-medium wrap-anywhere">{title}</p>
              {detail !== undefined && detail !== null && (
                <div className="mt-0.5 text-2xs text-faint">{detail}</div>
              )}
            </div>
            {controls(true)}
          </div>

          {context !== undefined && context !== null && (
            <div className="min-h-12 flex-1 overflow-y-auto border-t border-edge/60 px-3 py-2.5">
              {context}
            </div>
          )}

          {((layout === "rows" && options.length > 0) || (extra !== undefined && extra !== null)) && (
            <div className="max-h-[45vh] min-h-0 space-y-1.5 overflow-y-auto border-t border-edge/60 px-3 py-2.5">
              {layout === "rows" &&
                options.map((option, index) => (
                  <OptionRow key={option.id} option={option} index={index} disabled={busy} />
                ))}
              {extra}
            </div>
          )}

          {/* Drawn only when there are buttons or actions; the way out is the header's cancel. */}
          {(layout === "buttons" || (actions !== undefined && actions !== null)) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-edge/60 px-3 py-2.5">
            {/* Two nested groups, so refusals stay left and approvals right when the row wraps. */}
            {layout === "buttons" && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {options.map((option, index) =>
                    option.leading === true ? (
                      <OptionButton key={option.id} option={option} index={index} disabled={busy} />
                    ) : null,
                  )}
                </div>
                <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
                  {options.map((option, index) =>
                    option.leading === true ? null : (
                      <OptionButton key={option.id} option={option} index={index} disabled={busy} />
                    ),
                  )}
                </div>
              </>
            )}
            {actions}
          </div>
          )}
        </div>
      )}
      {/* On the frame, which outlives a fold. No aria-modal: the question is about what lies outside the card. */}
      <p role="status" aria-live="polite" className="sr-only">
        {spoken}
      </p>
    </div>
  );
}

function MoreWaiting({ count }: { count: number }): ReactNode {
  const says = `${count} more request${count === 1 ? "" : "s"} waiting after this one`;
  return (
    <span
      title={says}
      className="shrink-0 rounded-sm bg-raised px-1.5 py-0.5 text-2xs text-muted tabular-nums"
    >
      <span aria-hidden={true}>+{count}</span>
      <span className="sr-only">{says}</span>
    </span>
  );
}

function OptionRow({
  option,
  index,
  disabled,
}: {
  option: AskOption;
  index: number;
  disabled: boolean;
}): ReactNode {
  return (
    <button
      onClick={option.onPick}
      disabled={disabled}
      title={option.hint !== undefined && option.hint !== null && option.hint !== option.label ? option.hint : undefined}
      role={option.mark === "many" ? "checkbox" : undefined}
      aria-checked={option.mark === "many" ? option.chosen === true : undefined}
      aria-pressed={option.mark === "one" ? option.chosen === true : undefined}
      // primary applies to rows too, so a decision drawn as rows keeps its one filled control.
      className={`tap press relative flex min-h-11 w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left disabled:opacity-40 ${
        option.primary === true ? "border-fg bg-fg text-ink hover:bg-fg/90" : askRowTone(option.chosen === true)
      }`}
    >
      {option.busy === true && (
        <span className="absolute top-1/2 left-1 -translate-y-1/2">
          <Spinner />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium wrap-anywhere">{option.label}</span>
        {option.description !== null && option.description !== undefined && (
          <span
            className={`mt-0.5 block text-2xs wrap-anywhere ${option.primary === true ? "text-ink/70" : "text-muted"}`}
          >
            {option.description}
          </span>
        )}
      </span>
      {index < 9 && (
        <span
          className={`mt-0.5 shrink-0 text-2xs tabular-nums ${KEYS_ONLY} ${
            option.primary === true ? "text-ink/60" : "text-faint"
          }`}
        >
          {index + 1}
        </span>
      )}
      <ChoiceMark mark={option.mark} chosen={option.chosen === true} className="mt-0.5" />
    </button>
  );
}

/** Shared with ElicitationCard's typed answer so picked state is painted one way. */
export function askRowTone(chosen: boolean): string {
  return chosen ? CHOSEN : ROW;
}

/** A reserved slot drawn as a ring. The role is claimed only where the button keeps it: checkbox for many, aria-pressed for one. */
export function ChoiceMark({
  mark,
  chosen,
  className = "",
}: {
  mark: AskOption["mark"];
  chosen: boolean;
  className?: string;
}): ReactNode {
  if (mark === undefined || mark === null) return null;
  return (
    <span
      aria-hidden={true}
      className={`flex h-4 w-4 shrink-0 items-center justify-center ${
        mark === "many" ? "rounded-none" : "rounded-full"
      } ring-1 ring-inset ${chosen ? "bg-fg ring-fg" : "ring-edge-strong"} ${className}`.trimEnd()}
    >
      {chosen &&
        (mark === "many" ? (
          <Icon as={Check} size={11} className="text-ink" />
        ) : (
          <span className="block h-1.5 w-1.5 rounded-full bg-ink" />
        ))}
    </span>
  );
}

function OptionButton({
  option,
  index,
  disabled,
}: {
  option: AskOption;
  index: number;
  disabled: boolean;
}): ReactNode {
  return (
    <button
      onClick={option.onPick}
      disabled={disabled}
      title={option.hint !== undefined && option.hint !== null && option.hint !== option.label ? option.hint : undefined}
      className={`tap press relative flex min-h-11 items-center gap-1.5 rounded-md px-3 text-xs font-medium disabled:opacity-40 ${
        option.primary === true
          ? "bg-fg text-ink hover:bg-fg/90"
          :
            "border border-edge-strong bg-surface text-fg hover:bg-raised"
      }`}
    >
      {option.busy === true && (
        <span className="absolute left-1.5 flex items-center">
          <Spinner />
        </span>
      )}
      {option.label}
      {index < 9 && (
        <span className={`tabular-nums ${KEYS_ONLY} ${option.primary === true ? "text-ink/60" : "text-faint"}`}>
          {index + 1}
        </span>
      )}
    </button>
  );
}

/** A footer button, 44px tall, so Back, Skip and Submit line up. */
export function AskAction({
  onClick,
  disabled = false,
  busy = false,
  tone = "plain",
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: "plain" | "quiet" | "primary";
  title?: string;
  children: ReactNode;
}): ReactNode {
  const look =
    tone === "primary"
      ?
        "bg-fg text-ink hover:bg-fg/90"
      : tone === "quiet"
        ? "text-muted hover:bg-raised hover:text-fg"
        :
          "border border-edge-strong text-muted hover:bg-raised hover:text-fg";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`tap press relative flex min-h-11 items-center gap-1 rounded-md px-3 text-xs font-medium disabled:opacity-40 ${look}`}
    >
      {busy && (
        <span className="absolute left-2 flex items-center">
          <Spinner />
        </span>
      )}
      {children}
    </button>
  );
}
