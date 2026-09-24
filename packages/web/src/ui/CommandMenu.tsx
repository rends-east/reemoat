import { Check, SlidersHorizontal } from "lucide-react";
import { Fragment, useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { AgentConfigOption } from "../wire";
import { labelFor } from "./agentConfig";
import { choiceRuns, type ChoiceRow, type CommandEntry } from "./commands";
import { Icon, MENU_HEADING, MENU_PANEL, menuRow, Spinner } from "./bits";

/** Never takes focus and always opens above the composer's box; the caller computes the rows and moves the active index. */
export function CommandMenu({
  entries,
  choices,
  active,
  stage,
  busy,
  dropped,
  anchorRef,
  onHover,
  onChoose,
  onChooseValue,
  onDismiss,
}: {
  entries: readonly CommandEntry[];
  /** Non-null exactly when a control was picked and is being valued. */
  choices: readonly ChoiceRow[] | null;
  active: number;
  stage: AgentConfigOption | null;
  busy: string | null;
  /** How many commands the daemon had to cut. Drawn, never silently swallowed. */
  dropped: number;
  anchorRef: RefObject<HTMLTextAreaElement | null>;
  onHover: (index: number) => void;
  onChoose: (index: number) => void;
  onChooseValue: (index: number) => void;
  onDismiss: () => void;
}): ReactNode {
  const boxRef = useRef<HTMLDivElement | null>(null);

  // The textarea is not outside: moving the caret must not drop a staged choice. Escape is handled on the textarea.
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

  // The highlight is an index, not focus, so nothing else scrolls it into view.
  useEffect(() => {
    boxRef.current?.querySelectorAll("[role=option]")[active]?.scrollIntoView({ block: "nearest" });
  }, [active, choices, entries]);

  return (
    // The heading sits outside the listbox, which may hold only options and groups.
    <div
      ref={boxRef}
      className={`absolute inset-x-0 bottom-full mb-1 ${MENU_PANEL} max-h-[min(18rem,50dvh)]`}
    >
      {stage !== null && <p className={MENU_HEADING}>{labelFor(stage)}</p>}
      <div id="composer-command-menu" role="listbox" aria-label={stage === null ? "Commands" : labelFor(stage)}>
      {stage !== null && choices !== null ? (
        <>
          {choiceRuns(choices).map((run) => {
            const rows = run.items.map(({ choice, index }) => {
              const selected = stage.value === choice.value;
              return (
              <button
                key={choice.value}
                type="button"
                role="option"
                id={`composer-command-${index}`}
                // Not a tab stop: the textarea is the composite widget, pointing here via aria-activedescendant.
                tabIndex={-1}
                aria-selected={index === active}
                aria-current={selected}
                // preventDefault on mousedown keeps the caret in the textarea; the work is on click, so click-only activation still works.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onChooseValue(index)}
                onMouseEnter={() => onHover(index)}
                className={`${menuRow("start")} ${index === active ? "bg-raised" : ""} ${
                  selected ? "font-medium" : ""
                }`}
              >
                <span className="mt-0.5 w-3 shrink-0">
                  {busy === choice.value ? <Spinner /> : selected && <Icon as={Check} size={11} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {choice.label}
                    {selected && <span className="sr-only"> (current)</span>}
                  </span>
                  {choice.description !== null && (
                    <span className="block text-2xs text-faint">{choice.description}</span>
                  )}
                </span>
              </button>
              );
            });
            return run.group === null ? (
              <Fragment key={`run:${run.items[0]?.index ?? 0}`}>{rows}</Fragment>
            ) : (
              <div key={`run:${run.items[0]?.index ?? 0}`} role="group" aria-label={run.group}>
                <p aria-hidden className="mt-1 px-2 py-0.5 text-2xs text-faint">
                  {run.group}
                </p>
                {rows}
              </div>
            );
          })}
        </>
      ) : (
        entries.map((entry, index) => (
          <button
            key={`${entry.kind}:${entry.name}`}
            type="button"
            role="option"
            id={`composer-command-${index}`}
            tabIndex={-1}
            aria-selected={index === active}
            aria-current={entry.value !== null && entry.option?.value === entry.value}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(index)}
            onMouseEnter={() => onHover(index)}
            className={`${menuRow("start")} text-fg ${index === active ? "bg-raised" : ""}`}
          >
            <span className="mt-0.5 w-3 shrink-0">
              {busy === entry.value && entry.value !== null ? (
                <Spinner />
              ) : entry.value !== null && entry.option?.value === entry.value ? (
                <Icon as={Check} size={11} className="text-fg" />
              ) : (
                entry.kind === "config" && <Icon as={SlidersHorizontal} size={11} className="text-faint" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5">
                <span className="min-w-0 truncate font-medium">/{entry.name}</span>
                {entry.hint !== null && (
                  <span className="min-w-0 truncate text-2xs text-faint">{entry.hint}</span>
                )}
              </span>
              {entry.description.length > 0 && (
                <span className="block truncate text-2xs text-faint">{entry.description}</span>
              )}
            </span>
          </button>
        ))
      )}
      </div>
      {stage === null && dropped > 0 && (
        <p className="px-2 py-1 text-2xs text-faint">
          {dropped} more the agent published are not shown
        </p>
      )}
    </div>
  );
}
