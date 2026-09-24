import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  askTitle,
  elicitationAnswer,
  answerMark,
  displacedBy,
  elicitationForm,
  fieldValue,
  stepAnswered,
  type ElicitationForm,
  type RenderField,
} from "../elicitation";
import {
  asksVersion,
  draftFor,
  dropAsk,
  excludedFor,
  isCollapsed,
  setCollapsed,
  setDraftField,
  setExcluded,
  setStep,
  stepFor,
  subscribeAsks,
} from "../ask";
import { answerAlreadyLanded, errorText } from "../http";
import { keyOf, type SessionRef } from "../ids";
import { answerKey } from "../keys";
import { store } from "../store";
import { toast } from "./Toast";
import type { ElicitationField, PendingElicitationSnapshot } from "../wire";
import { AskAction, AskCard, askRowTone, ChoiceMark, type AskOption } from "./AskCard";
import { fitToContent } from "./autosize";
import { Icon, Skeleton } from "./bits";
import { VERBATIM_FIELD } from "./composing";
import { ChevronLeft } from "lucide-react";

// Both halves: outline-none alone loses to index.css's unlayered ring, and no-focus-ring alone brings back WebKit's (Q3.645).
const NO_RING = "no-focus-ring outline-none";

// A typed box's indicator is its caret; the mark's is the app's ring on the glyph, since around its 44px target it straddled the row's edge.
const MARK_RING =
  "[button:focus-visible_&]:outline-2 [button:focus-visible_&]:outline-offset-2 [button:focus-visible_&]:outline-fg";

/** A question the agent asked, one step at a time: Submit accepts, Skip declines and the turn carries on, the ✕ cancels the tool call. */
export function ElicitationCard({
  sessionRef,
  pending,
  more,
  onHeight,
}: {
  sessionRef: SessionRef;
  pending: PendingElicitationSnapshot;
  /** Other requests waiting behind this one. Drawn by the card, not counted here. */
  more: number;
  onHeight?: (px: number) => void;
}): ReactNode {
  const [fields, setFields] = useState<ElicitationField[] | null>(null);
  const [busy, setBusy] = useState<"accept" | "decline" | "cancel" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const sessionKey = keyOf(sessionRef);
  useSyncExternalStore(subscribeAsks, asksVersion);
  const draft = draftFor(sessionKey, pending.elicitationId);

  useEffect(() => {
    let cancelled = false;
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) {
      setLoadError("that machine is gone");
      return;
    }
    setFields(null);
    setLoadError(null);
    void daemon
      .elicitationForm(sessionRef.sessionId, pending.elicitationId)
      .then((result) => {
        if (!cancelled) setFields(result.fields);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionRef.machineId, sessionRef.sessionId, pending.elicitationId]);

  const form: ElicitationForm = useMemo(
    () => elicitationForm(pending, fields ?? []),
    [pending, fields],
  );
  const excluded = excludedFor(sessionKey, pending.elicitationId);
  const answer = useMemo(() => elicitationAnswer(form, draft, excluded), [form, draft, excluded]);

  const respond = (action: "accept" | "decline" | "cancel"): void => {
    if (busy !== null) return;
    setBusy(action);
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) {
      setBusy(null);
      toast("error", "that machine is gone");
      return;
    }
    void daemon
      .answerElicitation(
        sessionRef.sessionId,
        pending.elicitationId,
        action === "accept"
          ? { content: answer.content }
          : action === "decline"
            ? { decline: true }
            : { cancel: true },
      )
      .then((result) => {
        dropAsk(sessionKey, pending.elicitationId);
        store.applySnapshot(sessionRef, result.session);
      })
      .catch((cause: unknown) => {
        if (answerAlreadyLanded(cause, "elicitation_expired")) {
          dropAsk(sessionKey, pending.elicitationId);
          void store.resume("elicitation-settled");
          return;
        }
        toast("error", errorText(cause));
      })
      .finally(() => setBusy(null));
  };

  const set = (field: string, value: Parameters<typeof setDraftField>[3]): void => {
    setDraftField(sessionKey, pending.elicitationId, field, value);
  };

  // Nothing typed is ever erased; an empty string rather than a delete, since an untouched field answers with the agent's default.
  const write = (field: string, value: Parameters<typeof setDraftField>[3]): void => {
    set(field, value);
    const empty = value === "" || (Array.isArray(value) && value.length === 0);
    if (empty) return;
    setExcluded(sessionKey, pending.elicitationId, field, false);
    for (const other of displacedBy(form, field)) set(other, "");
  };

  // Off is ask.ts's excluded, never an empty box; turning one on releases the question it answers.
  const toggleAnswer = (field: RenderField, on: boolean): void => {
    setExcluded(sessionKey, pending.elicitationId, field.key, !on);
    if (!on) return;
    for (const other of displacedBy(form, field.key)) set(other, "");
  };

  const stepCount = Math.max(1, form.steps.length);
  const index = Math.min(stepFor(sessionKey, pending.elicitationId), stepCount - 1);
  const step = form.steps[index];
  const last = index >= stepCount - 1;
  // Next needs this step answered, not only valid: the adapter marks nothing required.
  const stepKeys = new Set((step?.fields ?? []).map((field) => field.key));
  const stepBlocked =
    answer.problems.some((problem) => stepKeys.has(problem.key)) ||
    !stepAnswered(form, index, answer.content);

  // One gate for the button and for Enter in a box.
  const advanceBlocked = busy !== null || fields === null || stepBlocked || (last && !answer.canSubmit);
  const advance = (): void => {
    if (advanceBlocked) return;
    if (last) respond("accept");
    else setStep(sessionKey, pending.elicitationId, index + 1);
  };

  const leader = step?.fields[0];
  // Carried as a pair: TypeScript drops the narrowing of leader.kind inside the closures below.
  const choice =
    leader !== undefined && (leader.kind.k === "select" || leader.kind.k === "multiselect")
      ? { field: leader, kind: leader.kind }
      : null;
  const rest = choice !== null ? (step?.fields ?? []).slice(1) : (step?.fields ?? []);

  const title = askTitle(form, index);

  const chosenValue = choice === null ? undefined : fieldValue(choice.field, draft);
  const multi = choice?.kind.k === "multiselect";
  const options: AskOption[] =
    choice === null
      ? []
      : choice.kind.options.map((option) => {
          const current = Array.isArray(chosenValue) ? chosenValue : [];
          const chosen = multi ? current.includes(option.value) : chosenValue === option.value;
          return {
            id: option.value,
            label: option.label,
            description: option.description,
            chosen,
            mark: multi ? "many" : "one",
            // Tapping the chosen row clears it with an empty string, never a delete, which would fall back to the agent's default.
            onPick: () =>
              multi
                ? write(
                    choice.field.key,
                    chosen
                      ? current.filter((entry) => entry !== option.value)
                      : [...current, option.value],
                  )
                : write(choice.field.key, chosen ? "" : option.value),
          } satisfies AskOption;
        });

  const problemOf = (key: string): string | null =>
    answer.problems.find((entry) => entry.key === key)?.reason ?? null;
  const choiceProblem = choice === null ? null : problemOf(choice.field.key);

  return (
    <AskCard
      onHeight={onHeight}
      title={title}
      detail={
        stepCount > 1 ? (
          <span className="tabular-nums">
            Question {index + 1} of {stepCount}
          </span>
        ) : null
      }
      collapsed={isCollapsed(sessionKey, pending.elicitationId)}
      onToggle={(next) => setCollapsed(sessionKey, pending.elicitationId, next)}
      onDismiss={() => respond("cancel")}
      dismissLabel="Abandon this tool call"
      dismissDisabled={busy !== null}
      more={more}
      busy={busy !== null}
      options={options}
      context={
        loadError !== null ? (
          <p className="text-xs text-danger">{loadError}</p>
        ) : fields === null ? (
          <Skeleton rows={Math.max(1, Math.min(pending.fieldCount, 3))} />
        ) : null
      }
      extra={
        rest.length > 0 || choiceProblem !== null ? (
          <div className="space-y-2.5">
            {choiceProblem !== null && <p className="text-2xs text-danger">{choiceProblem}</p>}
            {rest.map((field) => (
              <Field
                key={field.key}
                field={field}
                heading={field.label === title ? null : field.label}
                hint={field.hint === title ? null : field.hint}
                // Gated on answerMark, not the step, so a mark is drawn only where displacedBy can keep its promise.
                mark={answerMark(form, field)}
                // Whether the field is in the body, not whether its box holds text.
                counted={Object.prototype.hasOwnProperty.call(answer.content, field.key)}
                onToggle={(on) => toggleAnswer(field, on)}
                value={fieldValue(field, draft)}
                problem={problemOf(field.key)}
                onChange={(value) => write(field.key, value)}
                onAdvance={advance}
              />
            ))}
          </div>
        ) : null
      }
      actions={
        <>
          {index > 0 && (
            <AskAction tone="quiet" onClick={() => setStep(sessionKey, pending.elicitationId, index - 1)}>
              <Icon as={ChevronLeft} size={12} />
              Back
            </AskAction>
          )}
          <div className="flex-1" />
          <AskAction
            onClick={() => respond("decline")}
            disabled={busy !== null}
            busy={busy === "decline"}
            title="Skip — the agent carries on without an answer"
          >
            Skip
          </AskAction>
          <AskAction tone="primary" onClick={advance} disabled={advanceBlocked} busy={busy === "accept"}>
            {last ? "Submit" : "Next"}
          </AskAction>
        </>
      }
    />
  );
}

function Field({
  field,
  heading,
  hint,
  value,
  problem,
  mark,
  counted,
  onToggle,
  onChange,
  onAdvance,
}: {
  field: RenderField;
  heading: string | null;
  hint: string | null;
  value: ReturnType<typeof fieldValue>;
  problem: string | null;
  /** Says this field holds an answer, never which answer the agent will use; nothing may key on the custom field's name. */
  mark: AskOption["mark"];
  counted: boolean;
  onToggle: (on: boolean) => void;
  onChange: (value: string | boolean | string[]) => void;
  onAdvance: () => void;
}): ReactNode {
  // Named through aria-labelledby, not a label element, which would forward a tap on the question to its control.
  const id = useId();
  const nameId = `${id}-name`;
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;
  const boolId = `${id}-bool`;
  const showsHint = hint !== null && hint !== heading;
  const describedBy =
    [showsHint ? hintId : null, problem !== null ? problemId : null].filter((entry) => entry !== null).join(" ") ||
    undefined;
  return (
    <div>
      {heading !== null && (mark === null || mark === undefined) ? (
        <p id={nameId} className="mb-1 text-xs font-medium wrap-anywhere">
          {heading}
        </p>
      ) : (
        <span id={nameId} className="sr-only">
          {field.label}
        </span>
      )}
      {showsHint && (
        <p id={hintId} className="mb-1 text-2xs text-muted wrap-anywhere">
          {hint}
        </p>
      )}

      {field.kind.k === "text" &&
        (mark !== null && mark !== undefined ? (
          // The mark is a button, so this row may not be a label: a label forwards activation to its field.
          <div className={`flex min-h-11 w-full items-start rounded-md border ${askRowTone(counted)}`}>
            <TypedAnswer
              multiline={field.kind.multiline}
              rows={field.kind.rows}
              value={typeof value === "string" ? value : ""}
              onChange={onChange}
              onAdvance={onAdvance}
              labelledBy={nameId}
              describedBy={describedBy}
              // py-3 makes one line the mark's 44px, so the mark stays level with the first line as the box grows.
              className="min-w-0 flex-1 border-none bg-transparent px-3 py-3 text-xs"
            />
            <button
              type="button"
              onClick={() => onToggle(!counted)}
              role={mark === "many" ? "checkbox" : undefined}
              aria-checked={mark === "many" ? counted : undefined}
              aria-pressed={mark === "one" ? counted : undefined}
              aria-labelledby={nameId}
              className={`${NO_RING} tap flex h-11 min-w-11 shrink-0 items-center justify-end pr-3 pl-2`}
            >
              <ChoiceMark mark={mark} chosen={counted} className={MARK_RING} />
            </button>
          </div>
        ) : (
          <div className="flex min-h-11 w-full items-center rounded-md border border-edge bg-raised">
            <TypedAnswer
              multiline={field.kind.multiline}
              rows={field.kind.rows}
              value={typeof value === "string" ? value : ""}
              onChange={onChange}
              onAdvance={onAdvance}
              labelledBy={nameId}
              describedBy={describedBy}
              className="min-w-0 flex-1 border-none bg-transparent px-2.5 py-2.5 text-xs"
            />
          </div>
        ))}

      {field.kind.k === "number" && (
        <input
          // inputMode rather than a number input, so intermediate strings like - and 1. survive in the draft.
          type="text"
          inputMode={field.kind.integer ? "numeric" : "decimal"}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => advanceOnEnter(event, onAdvance)}
          aria-labelledby={nameId}
          aria-describedby={describedBy}
          className={`${NO_RING} min-h-11 w-full rounded-md border border-edge bg-raised px-2.5 text-xs`}
        />
      )}

      {field.kind.k === "boolean" && (
        <button
          id={boolId}
          onClick={() => onChange(value !== true)}
          aria-pressed={value === true}
          // Named by the question and its own text, so it announces the question and then Yes.
          aria-labelledby={`${nameId} ${boolId}`}
          aria-describedby={describedBy}
          className={`tap press flex min-h-11 w-full items-center rounded-md border px-2.5 text-left text-xs ${
            value === true
              ? "border-edge-strong bg-raised font-medium text-fg hover:bg-edge"
              : "border-edge bg-raised hover:border-edge-strong hover:bg-edge/50"
          }`}
        >
          {value === true ? "Yes" : "No"}
        </button>
      )}

      {(field.kind.k === "select" || field.kind.k === "multiselect") && (
        <div className="space-y-1">
          {field.kind.options.map((option) => {
            const multi = field.kind.k === "multiselect";
            const current = Array.isArray(value) ? value : [];
            const chosen = multi ? current.includes(option.value) : value === option.value;
            return (
              <button
                key={option.value}
                onClick={() =>
                  multi
                    ? onChange(
                        chosen
                          ? current.filter((entry) => entry !== option.value)
                          : [...current, option.value],
                      )
                    : onChange(option.value)
                }
                role={multi ? "checkbox" : undefined}
                aria-checked={multi ? chosen : undefined}
                aria-pressed={multi ? undefined : chosen}
                // Picked is a ring, not a heavier face, so a wrapping label never reflows the list (Q3.421).
                className={`tap press flex min-h-11 w-full items-start rounded-md border px-2.5 py-2 text-left text-xs ${
                  chosen
                    ? "border-edge-strong bg-raised text-fg ring-1 ring-edge-strong ring-inset hover:bg-edge"
                    : "border-edge bg-raised hover:border-edge-strong hover:bg-edge/50"
                }`}
              >
                <span className="min-w-0 flex-1 wrap-anywhere">{option.label}</span>
                <ChoiceMark mark={multi ? "many" : "one"} chosen={chosen} />
              </button>
            );
          })}
        </div>
      )}

      {problem !== null && (
        <p id={problemId} className="mt-1 text-2xs text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}

// React does not forward isComposing; the pointer is read at the keystroke, as the composer reads it, so an attached keyboard is seen.
function advanceOnEnter(event: KeyboardEvent<HTMLElement>, onAdvance: () => void): void {
  const key = answerKey(
    { ...event, isComposing: event.nativeEvent.isComposing },
    !window.matchMedia("(pointer: coarse)").matches,
  );
  if (key === null) return;
  event.preventDefault();
  onAdvance();
}

/** A box an answer is typed into: lines that grow where the schema allows a newline, one line where its format does not. */
function TypedAnswer({
  multiline,
  rows,
  value,
  onChange,
  onAdvance,
  labelledBy,
  describedBy,
  className,
}: {
  multiline: boolean;
  rows: number;
  value: string;
  onChange: (value: string) => void;
  onAdvance: () => void;
  labelledBy: string;
  describedBy: string | undefined;
  /** Borderless: fitToContent writes scrollHeight, which leaves a border out, so the box around it draws the edge. */
  className: string;
}): ReactNode {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  // Before paint, so the card reports its new height in the frame it grows (Q3.649).
  useLayoutEffect(() => {
    if (areaRef.current !== null) fitToContent(areaRef.current);
  }, [value, multiline, rows]);

  // A narrower card rewraps the same text; only the visual viewport fires for a soft keyboard.
  useEffect(() => {
    const refit = (): void => {
      if (areaRef.current !== null) fitToContent(areaRef.current);
    };
    window.addEventListener("resize", refit);
    window.visualViewport?.addEventListener("resize", refit);
    return () => {
      window.removeEventListener("resize", refit);
      window.visualViewport?.removeEventListener("resize", refit);
    };
  }, []);

  return multiline ? (
    <textarea
      ref={areaRef}
      {...VERBATIM_FIELD}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => advanceOnEnter(event, onAdvance)}
      rows={rows}
      placeholder="Type your own answer here"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`${NO_RING} resize-none overflow-hidden ${className}`}
    />
  ) : (
    <input
      {...VERBATIM_FIELD}
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => advanceOnEnter(event, onAdvance)}
      placeholder="Type your own answer here"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`${NO_RING} ${className}`}
    />
  );
}
