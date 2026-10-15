import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MachineId } from "../../ids";
import type { AppState } from "../../store";
import { Icon, MENU_HEADING, MENU_MAX_PX, MENU_PANEL, menuRow, useListKeys, type DropdownItem } from "../bits";
import { LAYER, useDismissible } from "../overlay";
import { assigneeValue, type Assignee } from "./assignees";
import { HolderAvatar } from "./Holder";
import { NOBODY, useAgentChoices, YOU, type AssigneeChoice } from "./Pickers";

const MENU_WIDTH_PX = 256;

/**
 * Who does a task, as a menu over the board: under a card's assignee, or under a card let go in Running (Q3.728, Q3.732). The
 * Dropdown's rows and check, portaled, since a lane scrolls and would clip a panel inside it; dismissed as every menu is.
 */
export function AgentMenu({
  state,
  anchor,
  heading,
  only,
  nobody = false,
  you = false,
  value,
  onPick,
  onCancel,
}: {
  state: AppState;
  /** Where the menu opens: under this box, or over it where the window has no room below. */
  anchor: () => DOMRect | null;
  heading: string;
  /** The agents of one machine, for a task whose conversations live there. */
  only: MachineId | null;
  nobody?: boolean;
  you?: boolean;
  /** Leads the keys and wears the check. */
  value: AssigneeChoice | null;
  onPick: (choice: Assignee | "nobody" | "you") => void;
  onCancel: () => void;
}): ReactNode {
  const choices = useAgentChoices(state, only);
  const me = state.me?.name ?? null;
  const [at, setAt] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { panelRef, onKeyDown } = useListKeys(at !== null, boxRef);
  useDismissible("menu", onCancel, true);

  useLayoutEffect(() => {
    const box = anchor();
    if (box === null) {
      onCancel();
      return;
    }
    const width = Math.max(box.width, MENU_WIDTH_PX);
    const up = window.innerHeight - box.bottom < MENU_MAX_PX + 16 && box.top > window.innerHeight - box.bottom;
    setAt({ left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)), top: up ? box.top : box.bottom, width, up });
  }, []);

  useEffect(() => {
    const away = (event: Event): void => {
      if (boxRef.current?.contains(event.target as Node) !== true) onCancel();
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [onCancel]);

  if (at === null) return null;
  const items: DropdownItem<string>[] = [
    ...(nobody ? [{ value: NOBODY, label: "Not assigned", adornment: <HolderAvatar holder={{ kind: "nobody" }} me={me} /> }] : []),
    ...(you ? [{ value: YOU, label: "You", adornment: <HolderAvatar holder={{ kind: "you" }} me={me} /> }] : []),
    ...choices.items,
  ];
  const chosen =
    value === null ? null : value === "nobody" ? NOBODY : value === "you" ? YOU : assigneeValue(value.machineId, value.kind, value.id);
  const pick = (raw: string): void => {
    if (raw === NOBODY || raw === YOU) {
      onPick(raw === NOBODY ? "nobody" : "you");
      return;
    }
    const agent = choices.pick(raw);
    if (agent !== null) onPick(agent);
  };

  return createPortal(
    <div
      ref={boxRef}
      className={`fixed ${LAYER.menu}`}
      style={{ left: at.left, top: at.top, width: at.width, transform: at.up ? "translateY(calc(-100% - 6px))" : "translateY(6px)" }}
    >
      <div ref={panelRef} role="listbox" aria-label={heading} tabIndex={-1} onKeyDown={onKeyDown} className={`${MENU_PANEL} animate-rise`}>
        <p className={MENU_HEADING}>{heading}</p>
        {items.map((item, index) => {
          const showGroup = item.group !== null && item.group !== undefined && item.group !== items[index - 1]?.group;
          const selected = item.value === chosen;
          const unavailable = item.disabled === true;
          return (
            <div key={`${item.group ?? ""}:${item.value}`}>
              {showGroup && <p className="mt-1 px-2.5 py-0.5 text-2xs text-faint">{item.group}</p>}
              <button
                type="button"
                role="option"
                aria-selected={selected}
                disabled={unavailable}
                onClick={() => (selected ? onCancel() : pick(item.value))}
                className={`${menuRow("start")} text-fg ${unavailable ? "" : "hover:bg-raised"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    {item.adornment}
                    <span className={`min-w-0 truncate ${unavailable ? "text-muted" : ""}`}>{item.label}</span>
                  </span>
                  {item.description !== null && item.description !== undefined && <span className="block text-2xs text-faint">{item.description}</span>}
                </span>
                <span className="inline-flex h-[var(--text-sm--line-height)] w-4 shrink-0 items-center justify-center">
                  {selected && <Icon as={Check} size={14} />}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
