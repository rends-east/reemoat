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
  withheldDetail,
} from "../permission";
import { elapsedSince, store } from "../store";
import { toast } from "./Toast";
import type { PendingPermissionSnapshot, PermissionOptionSummary, StoredEvent } from "../wire";
import { AskAction, AskCard, type AskOption } from "./AskCard";
import { Icon, shortDuration } from "./bits";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";

/**
 * The `busy` marker for the cancel button.
 *
 * A sentinel rather than a second piece of state, and one that cannot collide
 * with an `optionId`: option ids come from the agent, and none of them is empty.
 */
const CANCEL = "";

/**
 * An approval, in the shared ask card.
 *
 * **The frame is `AskCard` and that is the whole of "unified".** Measured
 * 2026-08-06, kimi asks its questions through this very route — its own
 * `AskUserQuestion` arrives as a `session/request_permission` titled
 * `AskUserQuestion`, with each answer an `allow_once` option and a `reject_once`
 * called Skip. So the identical question renders through the permission path on
 * one agent and the elicitation path on the other, and drawing them differently
 * meant one agent got the new card and the other did not.
 *
 * Nothing here detects that. What is shared is the component, not a guess about
 * what kind of request this is; the option *tone* still comes from the agent's own
 * `PermissionOptionKind`, because only a permission has one.
 *
 * Every structural property this card had is kept and now lives one file over:
 * docked above the composer where the thumb already is and where it cannot scroll
 * away, **every option visible at once** in the agent's own order (`bits.tsx`
 * carves out the exception for exactly this — hiding a reject behind a disclosure
 * is a safety regression), 44px targets, the spinner overlaid rather than
 * replacing the label, and de-emphasis in fill and border but never in text.
 */
export function PermissionCard({
  sessionRef,
  pending,
  events,
  agent,
  more,
}: {
  // Deliberately not called `ref`: React reserves that prop name, and a card
  // whose props silently stopped arriving would be a very bad thing for this
  // particular component to have go wrong.
  sessionRef: SessionRef;
  pending: PendingPermissionSnapshot;
  events: readonly StoredEvent[];
  /** The agent's own id, and the only place its *name* appears in this UI. */
  agent: string;
  /** Other requests waiting behind this one. Drawn by the card, not counted here. */
  more: number;
}): ReactNode {
  const [busy, setBusy] = useState<string | null>(null);
  // Collapsed until asked, and reset per request because the state is about
  // *this* question rather than about a preference.
  const [expanded, setExpanded] = useState(false);
  const sessionKey = keyOf(sessionRef);
  useSyncExternalStore(subscribeAsks, asksVersion);
  /*
   * The session's row, and it is here for one number: how long this has waited.
   *
   * Subscribed rather than read off `store.getSnapshot()` in passing, which is
   * what the parent's own re-render would have made *look* sufficient. It costs
   * nothing measurable — `SessionView` re-renders this card on every one of these
   * emits already, being neither memoised nor keyed against them — and it is the
   * arrangement `AgentBuilder` uses, so there is one way in this package to read
   * the store from a component the shell does not hand it to.
   */
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // Memoised: this walks the held transcript to find the tool call behind the
  // request, and it was re-running on every streamed event.
  const context = useMemo(() => permissionContext(pending, events), [pending, events]);

  /**
   * Answer, or — with no option — cancel.
   *
   * Both go through one path because the failure handling is the whole subtlety
   * and there is no reason to have two copies of it. `option === null` is the case
   * the card already described in words ("it can only be cancelled") while
   * offering no button to do it: `cancelPermission` existed on the client and
   * nothing called it, so the only way out of an optionless permission was to stop
   * the session.
   */
  const respond = (option: PermissionOptionSummary | null): void => {
    if (busy !== null) return;
    setBusy(option?.optionId ?? CANCEL);
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) {
      setBusy(null);
      /*
       * A whole sentence naming what did not happen, which "that machine is gone"
       * did not: the card stays up, the request stays parked and the agent is
       * still stopped, and a lower-case fragment leaving in eight seconds is the
       * whole of what somebody got told about that. The neighbouring refusals in
       * this app are sentences — `PluginScreen` says "That machine is not
       * reachable right now." and `AgentsPanel` says "That machine is not
       * reachable." — and this is the one place where the thing left unfinished is
       * an agent waiting on an answer.
       *
       * ⚠ **Those were quoted here as one string, and `AgentsPanel`'s carries no
       * "right now".** Nothing turned on the difference — the point is that both
       * name a subject and end in a full stop — but a quotation that does not match
       * the source it names is the same defect as a claim that has expired, and
       * this one was sitting where the next refusal would be copied from.
       */
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
        // The daemon's answer is "recorded", not "the agent continued". The
        // session snapshot it returns is folded in so the card disappears now;
        // proof of effect is the next event in the transcript.
        dropAsk(sessionKey, pending.permissionId);
        store.applySnapshot(sessionRef, result.session);
      })
      .catch((cause: unknown) => {
        // A 409 carrying `repeat: true` is success, not failure — the answer had
        // already landed. The three disjuncts that decide it live in `http.ts`
        // now, because the elicitation card needs the same rule and a second copy
        // is a second chance to make the mistake that shipped once.
        if (answerAlreadyLanded(cause, "permission_expired")) {
          dropAsk(sessionKey, pending.permissionId);
          void store.resume("permission-settled");
          return;
        }
        // A toast rather than an inline line: `Toast.tsx` names this card as one
        // of the three places inline errors were removed from, and it had kept
        // one anyway.
        toast("error", errorText(cause));
      })
      .finally(() => setBusy(null));
  };

  /*
   * Is this an approval, or a question wearing one?
   *
   * kimi has no `elicitation.form`, so its `AskUserQuestion` comes down this
   * route — and everything the card needs is in the payload, it was simply being
   * thrown away. `askedQuestion` decides from ACP's own option-kind enum and from
   * the tool's input shape, never from the title or the option ids; see the
   * argument written there. `null` is the ordinary answer and changes nothing.
   */
  const asked = useMemo(() => askedQuestion(pending, events, context), [pending, events, context]);
  const skip = asked?.skip ?? null;
  /*
   * Where each decision goes. Not the agent's order — see `permissionButtons` for
   * why that rule was reversed for a row of buttons and kept for a list of rows.
   */
  const buttons = useMemo(() => permissionButtons(pending.options), [pending.options]);

  /*
   * The plan-mode decision, curated — or `null`, which is every other request in
   * this daemon's history and is drawn by `buttons` above exactly as it always
   * was. Everything that makes this narrow is argued at `planControls`.
   */
  const plan = useMemo(() => planControls(context, pending.options), [context, pending.options]);
  /*
   * Everything below the title is joined out of the **loaded** transcript, so a
   * card can open before the conversation it is about has paged in — and then it
   * has one boilerplate sentence and nothing else, which is how an approval came
   * to be asked for with no way to see what it was.
   *
   * `loadAll` is the same call `openSession` makes and is a no-op while a run is
   * in flight, so this costs nothing in the ordinary case and closes the window in
   * the case that was reported. Measured against this daemon: 1989 events page in
   * over the relay in four requests and 40ms total, so there is no reason for the
   * card to be the one place that gives up.
   */
  /*
   * ...and **`truncated` is the same sentence**, which is why it joins the gate.
   *
   * Both mean *the card cannot explain this request from what it is holding, and
   * the log is the only other place to look*. A payload the daemon clamped at
   * 8 KiB for the snapshot is sitting whole on the `tool_call_update` under the
   * 128 KiB per-event cap, so paging the conversation in is what recovers it —
   * and `permissionContext` now prefers that copy over the stand-in, so this
   * self-terminates: the moment the join lands, `truncated` goes false.
   */
  useEffect(() => {
    if (!context.unavailable && !context.truncated) return;
    void store.loadAll(sessionRef);
  }, [context.unavailable, context.truncated, sessionRef.machineId, sessionRef.sessionId]);

  /*
   * Answer by id, and **do nothing** if the id is not there.
   *
   * `respond(null)` means *cancel the whole request*, so resolving an id through
   * `?? null` would turn a lookup miss into an abandoned tool call — the loudest
   * possible failure for the quietest possible bug. Every id here came out of
   * `pending.options` a line ago, so the miss is unreachable; that is exactly why
   * it must not be spelled in a way that would act if it ever became reachable.
   */
  const pick = (optionId: string): void => {
    const option = pending.options.find((candidate) => candidate.optionId === optionId);
    if (option !== undefined) respond(option);
  };

  /*
   * Answers are rows and decisions are buttons — argued at `AskCard`, ordered by
   * `permissionButtons`, worded by `optionLabel`. Nothing about either is decided
   * here; this only builds the list.
   */
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
            // The agent's own wording, kept where it costs no width. Ours is on
            // the face because claude's labels do not fit a row whose meaning is
            // carried by position — see `PLAN_ORDER`.
            hint: control.option.name,
            leading: control.leading,
            primary: control.primary,
            busy: busy === control.option.optionId,
            onPick: () => respond(control.option),
          }))
        : buttons.order.map((option, index) => ({
          id: option.optionId,
          label: optionLabel(pending.options, option),
          // The agent's own words, kept where they cost no width — as the
          // button's `title`, and nowhere else. An earlier comment here promised
          // `details` carried them as well "for a pointer that cannot hover",
          // which named the one case the fallback does not serve and was false
          // besides: the disclosure draws a `PermissionContext`, which holds no
          // option names at all. Where it matters — a *scoped* grant — nothing is
          // replaced in the first place; see `optionLabel`.
          hint: option.name,
          leading: index < buttons.leading,
          primary: option.optionId === buttons.primaryId,
          busy: busy === option.optionId,
          onPick: () => respond(option),
        }));

  /*
   * **How long the agent has been stopped, which was on the wire and drawn
   * nowhere.** `raisedAt` has been on `PendingPermissionSnapshot` for the life of
   * the field and its only reader was `oldestWait`, i.e. a sort — so a request
   * parked forty minutes ago and one parked four seconds ago drew the same card,
   * and the reader had no way to tell whether they had just missed it or had been
   * away.
   *
   * **`elapsedSince` and not `Date.now() - raisedAt`.** `raisedAt` is the
   * *daemon's* clock and this is a phone that may have slept; the row carries both
   * clocks at the moment it was fetched, so the arithmetic is wrong by at most the
   * age of the row rather than by the whole drift. Its docblock in `store.ts` is
   * where that is argued, and "blocked for −2 minutes" is the reading it exists to
   * prevent.
   *
   * `shortDuration` is the session list's own vocabulary — `<1m`, `12m`, `3h` —
   * so the row you tapped and the card you land on say the same thing about the
   * same request. It is coarse by design, which is also what makes it affordable
   * without a timer: nothing schedules a render for this, and the store's 4s poll
   * already re-renders the card, so the number is at most one poll stale. Drawn
   * unconditionally rather than above a floor, because unlike the transcript's
   * working line this is not a number that appears mid-turn to say a turn is slow
   * — the card *is* a wait, and its length is the fact.
   *
   * `null` when the row has not landed, which a cold open onto a session URL
   * genuinely is: no number is better than one measured against nothing.
   */
  const row = state.rowsByKey.get(sessionKey);
  const waited = row === undefined ? null : shortDuration(elapsedSince(row, pending.raisedAt));

  return (
    <AskCard
      /*
       * The question when there is one; otherwise the tool **and what it is acting
       * on**, which `pending.title` alone does not say. `AskUserQuestion` and
       * `Write` are both a bare tool name, and a card headed with one of those was
       * the second half of "the question does not reflect what is being asked".
       */
      title={asked?.question ?? permissionHeadline(agent, pending.title, context)}
      detail={waited === null ? null : <span className="tabular-nums">waiting {waited}</span>}
      /* The live region's subject. Only this card can name it: the elicitation
         route carries the question and not who asked it. */
      agent={agent}
      collapsed={isCollapsed(sessionKey, pending.permissionId)}
      onToggle={(next) => setCollapsed(sessionKey, pending.permissionId, next)}
      // Cancelling is a cancel, exactly as it is on a question — and it is the only
      // way out of a request the agent offered no options for, which used to be
      // described in words with no control behind it. It is a labelled footer
      // button rather than a ✕ in the header now, so this label is drawn.
      onDismiss={() => respond(null)}
      dismissLabel="Cancel this request"
      dismissDisabled={busy !== null}
      dismissBusy={busy === CANCEL}
      more={more}
      busy={busy !== null}
      options={options}
      /*
       * An answer is a row; a decision is a button. kimi's `AskUserQuestion`
       * arrives down this route and takes the same rows claude's elicitation
       * does, and everything else takes the confirmation-dialog row.
       *
       * ⚠ **The second clause is new, and it is what let `drawableOptions` go.** A
       * decision whose labels do not fit a button row also takes rows — because the
       * alternative, which shipped for a year, was *deleting the option that did
       * not fit*. `permissionLayout` decides it by length and never by id, and the
       * plan card is exempt because `PLAN_ORDER` writes our own short labels for
       * exactly this reason. The positional rule survives the switch: refusals are
       * still first and one option is still `primary`, which `OptionRow` draws
       * filled.
       */
      layout={asked !== null || (plan === null && permissionLayout(pending.options) === "rows") ? "rows" : "buttons"}
      /*
       * **A question hides its arguments and nothing else**, and that distinction
       * is load-bearing rather than tidy.
       *
       * What `Context` would draw for a real question is the tool's arguments —
       * the question and its answers, as a wall of JSON above the same question
       * and answers drawn properly — so `detailContext` drops `rawInput` and the
       * region collapses to nothing. But it was suppressed *wholesale*, and that
       * is what turned a mis-classification into a lie: a request carrying a
       * command would have had the command hidden under an agent-authored
       * question. `askedQuestion` now refuses such a request outright, and this
       * is the belt to that brace — if one ever slips through, what it is
       * authorizing is on screen.
       */
      context={
        asked !== null ? (
          <Context context={{ ...essentialContext(context), rawInput: null }} />
        ) : (
          <>
            <Context context={essentialContext(context)} />

            {/*
             * **Drawn only when something is withheld, above what it reveals, and
             * it toggles.** Three corrections in one control, and the last two
             * were reported together: the digest it used to expand into was the
             * request's own ids, which is bookkeeping nobody reads, and with the
             * file rendered *before* the button the control that reveals sat
             * underneath the thing revealed.
             *
             * `essentialContext` and `detailContext` are a partition now, so the
             * button has somewhere to be: everything always on screen above it,
             * everything it adds below.
             */}
            {withheldDetail(context) && (
              <button
                onClick={() => setExpanded(!expanded)}
                aria-expanded={expanded}
                /* `py-3` on an otherwise 18px row: this is the disclosure on the
                   card that approves a command, and `text-2xs`'s line height was
                   the whole of its height. Padding rather than `TAP_GROW_Y`
                   because it has no neighbour to overlap — the revealed detail is
                   below it, not beside it. */
                className="tap mt-2 flex min-h-11 items-center gap-1 rounded-sm py-3 text-2xs text-muted hover:text-fg"
              >
                <Icon as={expanded ? ChevronDown : ChevronRight} size={11} />
                details
              </button>
            )}

            {expanded && withheldDetail(context) && (
              <div className="mt-2">
                <Context context={detailContext(context)} />
              </div>
            )}
          </>
        )
      }
      /*
       * A plan is a document rather than a line, so it gets the room to be read.
       * Keyed on `context.plan` and **not** on `plan !== null`: a plan whose
       * option set failed `planControls`' exact-match still has to be readable.
       */
      size={context.plan !== null ? "tall" : "normal"}
      extra={
        pending.options.length === 0 ? (
          <p className="text-xs text-muted">
            The agent offered no options, so the only answer is to cancel it.
          </p>
        ) : null
      }
      /*
       * The footer has one occupant here now.
       *
       * A question's non-answer option — kimi calls it `Skip` — belongs beside
       * Submit where an elicitation's Skip is, not in the list of answers where a
       * red row would read as "this one is dangerous". Its label is the agent's
       * own word; only its *position* is ours, and the leading `flex-1` is what
       * pushes it to the far edge from the cancel `AskCard` draws first.
       *
       * ⚠ **The second occupant is gone and nothing was lost with it.** For a
       * request with no options at all this slot used to offer a Cancel, because
       * `cancelPermission` existed on the client and nothing called it — the card
       * described the only way out in words and provided no control for it. That
       * cancel is now on every card unconditionally, drawn by `AskCard` itself, so
       * a second one here would be the same act twice in one row. The sentence
       * above the answers still names it and now points at something permanent.
       */
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

function Context({ context }: { context: ReturnType<typeof permissionContext> }): ReactNode {
  if (context.unavailable) {
    return (
      <p className="rounded-md bg-raised px-2.5 py-2 text-xs text-muted">
        No command or diff is available for this request — the tool call is no longer in the log.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {/*
        **The one thing on this card that is rendered rather than quoted, and the
        gate above it is what makes that safe.**

        The rule three blocks down — verbatim, never through `Markdown` — is about
        `context.text`, and `context.text` is untouched. Its argument is that a
        text block *may be the command*: for kimi it is, and a renderer that eats
        an asterisk means the operator approves what they read while the agent runs
        something else. A `plan` is the other thing entirely — a document named by
        the tool's own schema, on a request `permissionContext` has already
        established authorizes nothing at all: no command, no body, no diff, no
        location. There is nothing here whose exact characters could cost anybody
        anything, and 5000 characters of markdown drawn as raw monospace in a
        160px box is not a plan somebody can read from a phone.

        `bg-raised/50` is the palette's well for a plan, which is what
        `EventList` already draws a checklist on — so the approval and the
        transcript agree rather than resembling each other.

        `Markdown` is the hardened one: no `rehype-raw`, `img` bound with no
        `src`, links through `openableHref`. It is also outside
        `FileAccessContext` here, so an inline path is a plain chip rather than a
        download button — no new fetch surface on the card that approves things.
      */}
      {context.plan !== null && (
        <div className="rounded-md bg-raised/50 px-2.5 py-2">
          <Markdown text={context.plan} />
        </div>
      )}

      {/*
        Truncation is one item in the list, not an early return.
        It used to replace everything, which meant an oversized `rawInput` also
        hid the request's text blocks and its diff — and for kimi the text block
        *is* the command. `permissionContext` deliberately keeps `text` and
        `diffs` alongside `truncated`; this was the only thing discarding them.
        Losing the arguments box is the cost of being over the cap; losing the
        command as well was a bug.
      */}
      {context.truncated && (
        <p className="rounded-md bg-raised px-2.5 py-2 text-xs text-muted">
          Part of this request was too large to keep and is not shown below.
        </p>
      )}

      {/*
        First, because for kimi this is the command itself rather than a note
        about it. Monospace for the same reason — and **verbatim, never through
        `Markdown`**, which is the reason this is a `<pre>` and everything else
        in the transcript is not.

        A renderer is free to consume the characters it is given. `find . -name
        '*.ts' -o -name '*.tsx'` comes out as emphasised `find . -name '.ts' -o
        -name '.tsx'` with both asterisks gone; backticks become a code span
        with the backticks stripped; `[label](url)` hides the URL behind the
        label; remark-gfm's `~~` deletes what it wraps. Everywhere else that is
        the right trade. Here it means the operator approves what they read and
        the agent runs something else, which is the one thing this card exists
        to prevent. The rule is about **`context.text`**, which is why a plan —
        which has no command, no body, no diff and no location, by the gate in
        `permissionContext` — renders through `Markdown` a few lines up without
        touching it: there is nothing there whose characters a renderer could
        consume to the operator's cost.
      */}
      {/*
        **Prose in a proportional font, or the command in monospace — and which
        it is depends on whether the command arrived separately.**

        This was always a `<pre>`, on the measured grounds that for kimi the text
        block *is* the command and a renderer must not consume its characters.
        That is still true and still enforced — it is a raw string either way,
        never `Markdown`, so `*` and backticks survive. What changed is the font:
        with `command` present, the command has its own box below and these blocks
        are the agent's description, which in monospace read as a second command
        and made the card twice the size it needed to be. With no `command`, a
        block may still be the command, so it keeps the monospace that makes `l`
        and `1` tell apart.
      */}
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

      {/* The tool's own sentence about the call, when it sent one — the line the
          heading is built from, repeated underneath exactly as the reference does,
          because a heading is read once and a description is read while looking
          at the command. Suppressed when it is already a text block above. */}
      {context.summary !== null && !context.text.includes(context.summary) && (
        <p className="text-xs text-muted wrap-anywhere">{context.summary}</p>
      )}

      {context.command !== null && (
        <pre className="max-h-40 overflow-auto rounded-md bg-raised px-2.5 py-2 font-mono text-xs leading-snug whitespace-pre-wrap wrap-anywhere">
          {context.command}
        </pre>
      )}

      {/*
        What is about to be written, which is the thing being approved.
        A file rather than a command, so it gets the same box a diff does — a
        header naming the path and the text under it — and `whitespace-pre` rather
        than `pre-wrap`, because code that soft-wraps at a phone's width reads as a
        different file.
      */}
      {context.body !== null && (
        <div className="overflow-hidden rounded-md border border-edge bg-raised">
          {/*
            What the box *is*, said in words. Without it a disclosure opens onto a
            wall of text with a path on top, and whether that is the file as it
            stands or the file as it will be is exactly the question somebody is
            expanding this to answer.
          */}
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

      {/*
        **The whole path, in the box a command would get.**

        A read and an edit carry no command at all, so without this the buttons
        sat above an empty box for exactly the requests where "which file" is the
        entire question. It is the *full* path and the heading is the last segment
        of it — two different strings rather than one repeated, which is the
        reference's own arrangement: the heading has to fit on a line and the
        thing you are approving has to be exact.

        Suppressed under a diff, which already names the file in its own header.
      */}
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

/*
 * The diff this card draws lives in `ui/DiffView.tsx` now.
 *
 * It was here, and being here was the reason the *transcript* — where a change is
 * read rather than authorised — drew a path and nothing else for the whole life of
 * this feature. Moving it gained hunks, line numbers and colour on both screens at
 * once, which is the argument for one component over two that resemble each other.
 */
