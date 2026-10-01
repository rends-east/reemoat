import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { PeerRow } from "../wire";
import { AgentGlyph } from "./AgentIcons";
import { MachineLabel, MENU_BOX, menuRow } from "./bits";

/** `CommandMenu`'s chrome for `@`: never takes focus, the caller moves the active index. A row reads "what it is about @name". Q3.678. */
export function MentionMenu({
  rows,
  notice = null,
  unreachable,
  active,
  anchorRef,
  onHover,
  onChoose,
  onDismiss,
}: {
  rows: readonly PeerRow[];
  /** Drawn in place of rows when there are none to offer. */
  notice?: string | null;
  /** Machines whose sessions could not be listed, named rather than silently missing. */
  unreachable: readonly string[];
  active: number;
  anchorRef: RefObject<HTMLTextAreaElement | null>;
  onHover: (index: number) => void;
  onChoose: (index: number) => void;
  onDismiss: () => void;
}): ReactNode {
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const close = (event: Event): void => {
      const target = event.target as Node;
      if (boxRef.current?.contains(target) === true) return;
      if (anchorRef.current?.contains(target) === true) return;
      onDismiss();
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onDismiss, anchorRef]);

  useEffect(() => {
    boxRef.current?.querySelectorAll("[role=option]")[active]?.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

  return (
    <div ref={boxRef} className={`absolute inset-x-0 bottom-full mb-1 ${MENU_BOX} max-h-[min(18rem,50dvh)]`}>
      {notice !== null && rows.length === 0 && (
        <p role="status" className="px-2.5 py-1 text-xs text-muted">
          {notice}
        </p>
      )}
      <div id="composer-mention-menu" role="listbox" aria-label="Sessions">
        {rows.map((row, index) => {
          const about = row.title !== null && row.title.trim().length > 0 ? row.title : row.folder;
          return (
            <button
              type="button"
              key={`${row.address}:${row.ref}`}
              role="option"
              id={`composer-mention-${index}`}
              tabIndex={-1}
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChoose(index)}
              onMouseEnter={() => onHover(index)}
              className={`${menuRow("center")} text-fg ${index === active ? "bg-raised" : ""}`}
            >
              <span className="shrink-0 text-muted">
                <AgentGlyph agent={row.harness} size={16} />
              </span>
              {/* The spaces are for a screen reader; a flex container drops them from the layout. */}
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="min-w-0 truncate">{about}</span>{" "}
                <span className="shrink-0 text-faint">@{row.name}</span>
                {!row.machine.isThis && (
                  <>
                    {" "}
                    <MachineLabel name={row.machine.label ?? "another machine"} className="text-faint" />
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {unreachable.length > 0 && (
        <p className="px-2.5 py-1 text-2xs text-faint">{unreachable.join(", ")} did not answer</p>
      )}
    </div>
  );
}
