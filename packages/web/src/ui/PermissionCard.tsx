import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { asksVersion, dropAsk, isCollapsed, setCollapsed, subscribeAsks } from "../ask";
import { answerAlreadyLanded, errorText } from "../http";
import { keyOf, type SessionRef } from "../ids";
import {
  askedQuestion,
  essentialContext,
  optionLabel,
  permissionButtons,
  permissionContext,
  permissionHeadline,
  permissionLayout,
  planControls,
  detailContext,
  truncationNotice,
  withheldDetail,
} from "../permission";
import { elapsedSince, store } from "../store";
import { toast } from "./Toast";
import type { PendingPermissionSnapshot, PermissionOptionSummary, StoredEvent } from "../wire";
import { AskAction, AskCard, type AskOption } from "./AskCard";
import { Icon, shortDuration } from "./bits";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";

/** Busy marker for the cancel button; agent option ids are never empty, so it cannot collide. */
const CANCEL = "";

export function PermissionCard({
  sessionRef,
  pending,
  events,
  agent,
  more,
  onHeight,
}: {
  // Not called ref: React reserves that prop name.
  sessionRef: SessionRef;
  pending: PendingPermissionSnapshot;
  events: readonly StoredEvent[];
  agent: string;
  /** Other requests waiting behind this one. Drawn by the card, not counted here. */
  more: number;
  onHeight?: (px: number) => void;
}): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const sessionKey = keyOf(sessionRef);
  useSyncExternalStore(subscribeAsks, asksVersion);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const row = state.rowsByKey.get(sessionKey);
  const context = useMemo(() => permissionContext(pending, events), [pending, events]);

  // True while the machine still holds a payload a socket frame emptied; false again within one poll.
  const awaitingRecord = row?.snapshot.reduced?.blobs === true;

  // Answers with the option, or cancels the whole request when it is null.
  const respond = (option: PermissionOptionSummary | null): void => {
    if (busy !== null) return;
    setBusy(option?.optionId ?? CANCEL);
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) {
      setBusy(null);
      toast(
        "error",
        "That machine is no longer listed, so your answer was not delivered and the agent is still waiting.",
      );
      return;
    }
    void (
      option === null
        ? daemon.cancelPermission(sessionRef.sessionId, pending.permissionId)
        : daemon.answerPermission(sessionRef.sessionId, pending.permissionId, option)
    )
      .then((result) => {
        dropAsk(sessionKey, pending.permissionId);
        store.applySnapshot(sessionRef, result.session);
      })
      .catch((cause: unknown) => {
        // A 409 carrying repeat: true means the answer already landed, which is success.
        if (answerAlreadyLanded(cause, "permission_expired")) {
          dropAsk(sessionKey, pending.permissionId);
          void store.resume("permission-settled");
          return;
        }
        toast("error", errorText(cause));
      })
      .finally(() => setBusy(null));
  };

  const asked = useMemo(() => askedQuestion(pending, events, context), [pending, events, context]);
  const skip = asked?.skip ?? null;
  const buttons = useMemo(() => permissionButtons(pending.options), [pending.options]);

  const outOfTurn = pending.outOfTurn === true;
  const plan = useMemo(
    () => planControls(context, pending.options, outOfTurn),
    [context, pending.options, outOfTurn],
  );
  // Pages the transcript in to recover a missing or clipped payload; awaitingRecord is deliberately not a dependency.
  useEffect(() => {
    if (!context.unavailable && !context.truncated) return;
    void store.loadAll(sessionRef);
  }, [context.unavailable, context.truncated, sessionRef.machineId, sessionRef.sessionId]);

  // Do nothing on a miss: a null answer would cancel the whole request.
  const pick = (optionId: string): void => {
    const option = pending.options.find((candidate) => candidate.optionId === optionId);
    if (option !== undefined) respond(option);
  };

  const options: AskOption[] =
    asked !== null
      ? asked.answers.map((answer) => ({
          id: answer.optionId,
          label: answer.label,
          description: answer.description,
          busy: busy === answer.optionId,
          onPick: () => pick(answer.optionId),
        }))
      : plan !== null
        ? plan.map((control) => ({
            id: control.option.optionId,
            label: control.label,
            hint: control.option.name,
            leading: control.leading,
            primary: control.primary,
            busy: busy === control.option.optionId,
            onPick: () => respond(control.option),
          }))
        : buttons.order.map((option, index) => ({
          id: option.optionId,
          label: optionLabel(pending.options, option, context.plan !== null),
          hint: option.name,
          leading: index < buttons.leading,
          primary: option.optionId === buttons.primaryId,
          busy: busy === option.optionId,
          onPick: () => respond(option),
        }));

  // elapsedSince rather than subtracting raisedAt from now: raisedAt is on the daemon's clock.
  const waited = row === undefined ? null : shortDuration(elapsedSince(row, pending.raisedAt));

  return (
    <AskCard
      onHeight={onHeight}
      title={asked?.question ?? permissionHeadline(agent, pending.title, context)}
      detail={waited === null ? null : <span className="tabular-nums">waiting {waited}</span>}
      agent={agent}
      collapsed={isCollapsed(sessionKey, pending.permissionId)}
      onToggle={(next) => setCollapsed(sessionKey, pending.permissionId, next)}
      onDismiss={() => respond(null)}
      dismissLabel="Cancel this request"
      dismissDisabled={busy !== null}
      dismissBusy={busy === CANCEL}
      more={more}
      busy={busy !== null}
      options={options}
      layout={asked !== null || (plan === null && permissionLayout(pending.options) === "rows") ? "rows" : "buttons"}
      // A question hides only its raw arguments, so a command it carries is still on screen.
      context={
        asked !== null ? (
          <Context context={{ ...essentialContext(context), rawInput: null }} awaitingRecord={awaitingRecord} />
        ) : (
          <>
            <Context context={essentialContext(context)} awaitingRecord={awaitingRecord} />

            {withheldDetail(context) && (
              <button
                onClick={() => setExpanded(!expanded)}
                aria-expanded={expanded}
                className="tap mt-2 flex min-h-11 items-center gap-1 rounded-sm py-3 text-2xs text-muted hover:text-fg"
              >
                <Icon as={expanded ? ChevronDown : ChevronRight} size={11} />
                details
              </button>
            )}

            {expanded && withheldDetail(context) && (
              <div className="mt-2">
                <Context context={detailContext(context)} awaitingRecord={awaitingRecord} />
              </div>
            )}
          </>
        )
      }
      // Keyed on context.plan, not plan: a plan whose options failed planControls must still be readable.
      size={context.plan !== null ? "tall" : "normal"}
      extra={
        pending.options.length === 0 ? (
          <p className="text-xs text-muted">
            The agent offered no options, so the only answer is the ✕ above.
          </p>
        ) : null
      }
      actions={
        skip !== null ? (
          <>
            <div className="flex-1" />
            <AskAction
              onClick={() => pick(skip.optionId)}
              disabled={busy !== null}
              busy={busy === skip.optionId}
              title="The agent carries on without an answer"
            >
              {skip.name}
            </AskAction>
          </>
        ) : null
      }
    />
  );
}

function Context({
  context,
  awaitingRecord,
}: {
  context: ReturnType<typeof permissionContext>;
  awaitingRecord: boolean;
}): ReactNode {
  if (context.unavailable) {
    return (
      <p className="rounded-md bg-raised px-2.5 py-2 text-xs text-muted">
        No command or diff is available for this request — the tool call is no longer in the log.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {/* The one rendered block: a plan authorizes nothing, so Markdown cannot change what is approved. */}
      {context.plan !== null && (
        <div className="rounded-md bg-raised/50 px-2.5 py-2">
          <Markdown text={context.plan} />
        </div>
      )}

      {truncationNotice(context, awaitingRecord) !== null && (
        <p className="rounded-md bg-raised px-2.5 py-2 text-xs text-muted">
          {truncationNotice(context, awaitingRecord)}
        </p>
      )}

      {/* Never through Markdown: for kimi a text block may be the command, and a renderer eats characters. */}
      {context.text.map((line, index) =>
        context.command === null ? (
          <pre
            key={`t${index}`}
            className="max-h-40 overflow-auto rounded-md bg-raised px-2.5 py-2 font-mono text-xs leading-snug whitespace-pre-wrap wrap-anywhere"
          >
            {line}
          </pre>
        ) : (
          <p key={`t${index}`} className="text-xs text-muted wrap-anywhere">
            {line}
          </p>
        ),
      )}

      {context.summary !== null && !context.text.includes(context.summary) && (
        <p className="text-xs text-muted wrap-anywhere">{context.summary}</p>
      )}

      {context.command !== null && (
        <pre className="max-h-40 overflow-auto rounded-md bg-raised px-2.5 py-2 font-mono text-xs leading-snug whitespace-pre-wrap wrap-anywhere">
          {context.command}
        </pre>
      )}

      {context.body !== null && (
        <div className="overflow-hidden rounded-md border border-edge bg-raised">
          <div className="border-b border-edge px-2 py-1 text-2xs text-muted">
            about to be written{context.target === null ? "" : " to"}
            {context.target !== null && (
              <span className="font-mono text-fg"> {context.target}</span>
            )}
          </div>
          <pre className="max-h-56 overflow-auto px-2 py-1.5 font-mono text-2xs leading-snug">
            {context.body}
          </pre>
        </div>
      )}

      {context.target !== null && context.diffs.length === 0 && (
        <pre className="max-h-40 overflow-auto rounded-md bg-raised px-2.5 py-2 font-mono text-xs leading-snug whitespace-pre-wrap wrap-anywhere">
          {context.target}
        </pre>
      )}

      {context.command === null && context.rawInput !== null && (
        <pre className="max-h-40 overflow-auto rounded-md bg-raised px-2.5 py-2 font-mono text-2xs leading-snug whitespace-pre-wrap wrap-anywhere">
          {context.rawInput}
        </pre>
      )}

      {context.diffs.map((change, index) => (
        <DiffView key={`${change.path}-${index}`} change={change} />
      ))}

      {context.diffs.length === 0 && context.locations.length > 0 && (
        <p className="font-mono text-2xs text-muted wrap-anywhere">{context.locations.join(", ")}</p>
      )}
    </div>
  );
}

