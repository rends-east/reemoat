import { AlertTriangle, Bot, Brain, Check, ChevronDown, ChevronRight, CircleSlash, Download, FilePen, FilePlus2, Globe, Loader, Minus, Pencil, Search, Terminal, Trash2, Wrench, X } from "lucide-react";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { filenameFor } from "../paths";
import { previewable } from "../preview";
import type { FileAccess } from "./files";
import { ImagePreview } from "./ImagePreview";
import { formatLocation } from "../permission";
import { transcriptNotice, type Gap, type Transcript, type TranscriptNotice } from "../store";
import type {
  AsyncTaskState,
  BackgroundTask,
  PermissionOptionKind,
  PermissionResolvedEvent,
  ElicitationResolvedEvent,
  PromptEvent,
  SessionEvent,
} from "../wire";
import { taskFinished } from "../wire";
import { TASK_NOUNS, type BackgroundReporting } from "../tasks";
import type { PendingEcho } from "../echo";
import { UserBubble } from "./Bubble";
import { Markdown } from "./Markdown";
import { COLUMN, Dot, Empty, Icon, Badge, shortDuration, TAP_GROW_Y, TranscriptSkeleton } from "./bits";
import { WorkingMark } from "./Mark";
import { TaskPanel } from "./TaskPanel";
import { ChangeCounts, DiffView } from "./DiffView";
import {
  buildTail,
  elicitationOutcome,
  permissionDecisions,
  refused,
  resolvedByText,
  runSummary,
  stopReasonText,
  sameNode,
  stripFence,
  opensToAnything,
  detailWorthDrawing,
  headlineWorthDrawing,
  clipTitle,
  toolSummary,
  outstandingTasks,
  SUMMARY_CHARS,
  type AnsweredQuestion,
  type ChangeNode,
  type EventNode,
  type GroupNode,
  type TailNode,
  type ToolNode,
} from "./tail";

/**
 * The transcript, whole.
 *
 * There is no render window any more. It used to hold 1200 events and draw the
 * newest 400, with a button growing that by 400 at a time — so opening any real
 * conversation started three or four taps from its beginning, at a boundary that
 * corresponded to nothing a reader could see. `store.ts` pages the whole log in
 * behind the tail now, and this draws all of it.
 *
 * The one cut is the agent's: after a `/clear` everything above the marker is a
 * conversation it has been told to forget, and one control offers it back. That
 * is the only remaining use of `hidden`.
 *
 * **What makes that affordable is that appending an event no longer re-renders
 * the transcript.** `buildTail` rebuilds its node list on every streamed token —
 * the array's identity changes, so the memo cannot help — and the 400-node break
 * was what kept that cheap regardless of how much history sat behind it. Three
 * things stand in for it, and the first is the one that actually mattered:
 *
 *   - `tail.ts` accumulates a text run with `push` and reverses once, rather than
 *     `unshift`ing each chunk into place. `unshift` is O(n), so a run cost O(k²)
 *     to build and a whole streamed reply O(k³); the node budget had been hiding
 *     that by capping k. Measured: one 8000-chunk reply went 2.48ms → 0.119ms per
 *     walk, and *receiving* a 4000-chunk one went 942ms → 124ms.
 *   - `TailRow` is memoised on {@link sameNode} — a comparator, not a signature
 *     string, because a sig would allocate one string per node per rebuild, which
 *     is the cost being avoided. `buildTail` returns fresh objects every time, so
 *     the default shallow compare would never skip anything.
 *   - `decisions` rides a context rather than a prop, and **only
 *     `PermissionResolvedRow` reads it**. A prop would have defeated the memo on
 *     every row at once; a context read from every `event` node defeated it on
 *     about two thirds of them, since the value is a fresh `Map` per token and a
 *     consumer re-renders on a changed context whatever `memo` says.
 *
 * `Markdown` was already memoised on its text, which is the expensive half.
 */

/**
 * The gap this column keeps under the conversation, in pixels — the old `pb-12`.
 *
 * A number rather than a class because it is now the floor of an arithmetic
 * rather than a constant on its own: a parked ask card raises it. Everything the
 * 48 was chosen for is argued where it is applied.
 */
const TRANSCRIPT_FOOT_PX = 48;

/**
 * How much room a parked card gets on top of its own height.
 *
 * 8 of it is the card frame's `pb-2`, which sits between the card and the bottom
 * of this box; the remaining 12 is the gap the reader actually sees between the
 * last row and the top of the card. Small on purpose — the card has a border and
 * a shadow, so it does not need a band as well, and the room it does need is
 * vertical space a plan is short of.
 */
const ASK_CLEARANCE = 20;

export function EventList({
  transcript,
  askHeight,
  onResized,
  files,
  working,
  reporting,
  turnElapsedMs,
  stale,
  echo,
  queued,
  background,
  reportsTasks,
  tasksOpen,
  onOpenTasks,
  onCloseTasks,
  hiddenFinished,
  onClearFinished,
  onStopTask,
}: {
  transcript: Transcript;
  /**
   * How tall the parked ask card is, or `0` for none.
   *
   * It becomes this column's bottom padding, which is the one place the gap under
   * a conversation is decided. See {@link TRANSCRIPT_FOOT_PX}.
   */
  askHeight: number;
  /**
   * A row changed its own height — a card was opened or closed.
   *
   * The transcript re-measures whether the reader is still at the bottom, so that
   * following the tail does not scroll away the thing they just opened. Must be
   * referentially stable: it rides a context past a memoised `TailRow`.
   */
  onResized: () => void;
  files: FileAccess | null;
  /**
   * `showsWorking(session)`, resolved by the caller.
   *
   * A boolean and not the snapshot: this re-renders on every streamed token, and
   * the store replaces the snapshot object wholesale every four seconds, so a
   * reference here would be a new prop identity on a timer.
   */
  working: boolean;
  /**
   * `mayStillReport(session)`, resolved by the caller for `working`'s reason.
   *
   * Separate from `working` and not derived from it: the whole point of the line
   * below is the window where the turn has ended and delegations have not.
   */
  reporting: boolean;
  /**
   * How long the running turn has been going, in milliseconds — or `null` for no
   * turn.
   *
   * ⚠ **It was `snapshot.turnStartedAt`, and what this file did with it was
   * `Date.now() - turnStartedAt`: two clocks that have no reason to agree.** That
   * field is the *daemon's*, which is why `SessionRow` carries `daemonNow` and
   * `fetchedAt` beside every snapshot and writes down what happens without them —
   * a phone that has been asleep comes back with a drifted clock, and "blocked for
   * −2 minutes" is both wrong and alarming. `elapsedSince` in `store.ts` is that
   * arithmetic and the rail already ages every row with it; the caller resolves it
   * here so this file holds no second copy of a formula whose whole point is that
   * the naive form looks right.
   *
   * A number and not the row, for `working`'s reason.
   */
  turnElapsedMs: number | null;
  /**
   * Nothing is streaming this session — no socket at all, or one whose phase is not
   * `live` — resolved by the caller.
   *
   * **`working` cannot answer this and never could.** It is `showsWorking` over
   * the newest snapshot that *arrived*, so when the socket dies the foot goes on
   * blinking `working…` about an agent nobody has heard from since — with an
   * elapsed time still climbing, our own clock being the only half of that
   * subtraction still moving. The transcript is what the daemon last said; that
   * nothing is still saying it is a fact about the stream, and only the stream
   * has it.
   *
   * ⚠ **It was `stream.phase === "waiting"`, which is the *banner's* question and
   * left this one with a hole on every retry** — the phase is `connecting` for the
   * whole of each attempt, and a handshake into a dead network is bounded by
   * nothing. `SessionView` computes both and carries the measurement.
   */
  stale: boolean;
  /**
   * The message that has been sent and has not come back yet, or `null`.
   *
   * **It is drawn here, in the conversation, and not by the composer.** It used
   * to be the first child of that `sticky bottom-0` bar — a sibling of this scroll
   * box — so a message appeared *under* the transcript with a spinner beside it
   * and then, one commit later, jumped into the transcript when the `prompt` event
   * arrived. Two boxes and one frame is not an animation, it is a teleport, and
   * the reader's own words are the last thing that should be doing it.
   *
   * Read from `echo.ts` by `SessionView` rather than fetched here, for `working`'s
   * reason: this component re-renders on every streamed token, and what crosses
   * the prop is a value that changes twice per message.
   */
  echo: PendingEcho | null;
  /**
   * Seqs of messages the daemon has taken and not yet handed to the agent.
   *
   * ⚠ **Its *identity* is part of the contract, not just its contents.** It goes
   * into `QueuedContext`, so a fresh `Set` on every render would re-render every
   * prompt bubble in the conversation on every arriving token. `SessionView`
   * memoises it on the seqs; see the context.
   */
  queued: ReadonlySet<number>;
  /**
   * `backgroundTasksOf(session)`, resolved by the caller for `working`'s reason.
   *
   * ⚠ **Not gated on `reporting`, unlike the delegation list above.** That gate
   * exists because a delegation is a transcript row nothing will ever complete
   * once the session is terminal — this is snapshot state the daemon clears at
   * `doStop`, so an ended session already has an empty array and a second gate
   * would only hide a `Completed` section somebody may still want to read.
   */
  background: readonly BackgroundTask[];
  /**
   * Whether anybody has been able to ask this session about background work — see
   * {@link TaskPanel}. Three-valued: a daemon restart leaves no agent to ask, which
   * is not the same fact as an agent that does not report.
   *
   * It rides through this component untouched: the panel is rendered from here
   * because this is where both of its sources already are — the delegations are
   * derived from the tail two lines above, and deriving them a second time in
   * `SessionView` would be the same walk over the same conversation to answer the
   * same question twice.
   */
  reportsTasks: BackgroundReporting;
  /** Whether the panel is open. Held in `SessionView`, which makes room for it. */
  tasksOpen: boolean;
  /** Opens the background-tasks panel, which is where they are drawn now. */
  onOpenTasks: () => void;
  onCloseTasks: () => void;
  /**
   * Which finished rows the reader has cleared, and the way to clear them.
   *
   * ⚠ **Both ride through untouched, and this component still learns no session
   * id** — which is the rule every other prop on it already follows. `Transcript`
   * resolves them three lines from `echo`'s pair, so what crosses here is a value
   * and a bound callback rather than a key this component would have to know what
   * to do with.
   */
  hiddenFinished: ReadonlySet<string>;
  onClearFinished: (ids: readonly string[]) => void;
  /**
   * Stop one of them, or `null` where nothing can.
   *
   * ⚠ **Nullable in the type and never `null` in practice, which is worth saying
   * because the obvious reading of this prop is the opposite.** `SessionView`
   * builds it as an unconditional `useCallback`, so the stop control is drawn
   * wherever the task's own `canStop` is set, and a daemon too old to have the
   * route answers `404` **into the card's own sentence** rather than into a
   * toast — the row is what somebody pressed. That is a deliberate call and not
   * this app's usual "a control has to be true in the state it is drawn in": the
   * client cannot tell an old daemon from a current one without asking, and
   * hiding the control on a guess costs more than one legible refusal does.
   *
   * The `null` arm therefore stands for a caller that does not exist yet rather
   * than for a state this app reaches — `TaskCard`'s `offerable` reads it
   * (`onStop !== null && task.canStop && !finished`) and is the half that already
   * works. Implementing the rest means gating the callback in `SessionView` and
   * correcting what is said here and on `TaskPanel`'s own prop for it.
   */
  onStopTask: ((task: BackgroundTask) => Promise<void>) | null;
}): ReactNode {
  /*
   * The whole loaded transcript, cut only at the agent's own `/clear`.
   *
   * Still walked backwards, but no longer for cost: a `tool_call_update` has to
   * be collected before the `tool_call` it belongs to is reached, and the same
   * for a permission's resolution and its request.
   */
  const cut = transcript.clearedAt ?? 0;
  // Why this conversation does not start at its beginning is one answer and it is
  // `transcriptNotice`, out in `store.ts` beside `loadStop` because the two decide
  // the same thing from opposite ends — see it for what each arm means and for what
  // the five booleans that used to be here failed to cover. Computed below, because
  // it needs the drawn row count and hundreds of held events can draw none.
  //
  // A sentence and never a button, in every arm. There is nothing for the reader to
  // do: `loadAll` keeps going until it reaches the floor, retries a page that
  // fails, and is re-driven on every poll a session list survives. The button that
  // used to be here read "N earlier events did not load — try again", which is this
  // client asking somebody to press a button because of its own bookkeeping.
  // `hidden` is deliberately not read, and there is no longer anything that could:
  // it counts only the events below the cut that happen to be *loaded*, which on a
  // session cleared at seq 9500 of 10000 is however many shared one page with the
  // marker. It stays on `Tail` because it is a correct statement about the walk and
  // `webcheck` pins it there.
  /*
   * Over the whole loaded window rather than the rendered rows, because a request can
   * sit above the fold while the answer it explains is on screen — and the answer is
   * the row that would otherwise say "approved" about a refusal. Memoised on `events`
   * alone, so it costs one walk per arriving event rather than one per render.
   *
   * Declared **above** `buildTail` now, because the fold reads it: an approval folds
   * into the run it authorised and a refusal never does, and `outcome` cannot tell
   * them apart. Same identity, same dependency, so threading it in costs nothing.
   */
  const decisions = useMemo(() => permissionDecisions(transcript.events), [transcript.events]);
  const { rows, taskFloor } = useMemo(
    () => buildTail(transcript.events, transcript.gaps, cut, decisions),
    [transcript.events, transcript.gaps, cut, decisions],
  );
  /*
   * The one thing said above the rows, and the row count is why it is computed
   * here rather than beside `cut`: measured on the live log, the newest 500 events
   * of a 1285-event session draw **one** row, so "has anything arrived" is not a
   * question a count of held events can answer.
   */
  const notice = transcriptNotice({
    loadedFrom: transcript.loadedFrom,
    daemonFirstSeq: transcript.daemonFirstSeq,
    clearedAt: transcript.clearedAt,
    loadingHistory: transcript.loadingHistory,
    heldEvents: transcript.events.length,
    heldBytes: transcript.heldBytes,
    rows: rows.length,
  });
  /*
   * The words, once, for the line **and** for the live region.
   *
   * One string rather than a sentence per place, because the pair had already
   * drifted the whole way: the region was gated on the same `rows.length === 0`
   * the skeleton was, so in the state this notice exists for it read the empty
   * string — a screen reader was told nothing at all about a transcript missing
   * 2356 of its 2856 events. Rendering both from one value is what makes them
   * unable to disagree, and the `switch` has no `default`, so a seventh arm on
   * `TranscriptNotice` is a compile error here.
   */
  const noticeSays = noticeText(notice);
  /*
   * What the agent started and has not reported finishing.
   *
   * **Two gates, and they answer different questions.** `reporting` is
   * `mayStillReport(snapshot)` and asks whether this *session* could report at
   * all; `taskFloor` asks which of its delegations belong to the agent that is in
   * front of the conversation now. Neither subsumes the other, and the second is
   * the one that closes the permanent case: an auto-resumed session is `idle` and
   * passes the first, holding rows a dead agent left `pending`.
   *
   * Gated before the walk rather than inside the render, because the states
   * `mayStillReport` excludes are ones where a spawn can *never* complete — a
   * terminal session leaves every call it was running `pending` for ever, so
   * without the gate an ended conversation reads "waiting for 1 task" permanently.
   */
  const tasks = useMemo(
    () => (reporting ? outstandingTasks(rows, taskFloor) : []),
    [reporting, rows, taskFloor],
  );
  /*
   * The background set: one key per render, and everything read off it either
   * memoised on that key or walked without allocating.
   *
   * ⚠ **The win is the context's identity, and the allocation arithmetic is
   * written out here so nobody re-derives it wrongly from the shape.** Three
   * places in this file have to know how much of `background` is still live — the
   * foot's words, the foot's count and the row's `outstanding` prop — and this
   * component re-renders on every arriving chunk, so answering each of them with
   * `background.filter((task) => !taskFinished(task.state))` is three arrays per
   * token for one question. None of the three does: `footSays` reduces to a
   * number and hands `outstandingSays` the raw list, which walks it without a
   * `Set` or a mapped array, and the memo below is the third. What that costs
   * instead is `taskKey`, rebuilt **unconditionally** one line down — an array,
   * N template strings and a join per render on any session that has a task at
   * all. That is the price of a stable identity for the context and it is not
   * zero; what it buys is below.
   *
   * ⚠ **Keyed on the tasks' own ids and states rather than on `background`**, which
   * is `queuedKey`'s arrangement in `SessionView` and is here for the sharper of
   * its two reasons: `taskStates` feeds a **context**, so a fresh `Map` on every
   * token would re-render every tool card in the conversation on every token — the
   * exact cost `DecisionsContext`'s docblock was written about. The snapshot is
   * rebuilt on every logged event, so `background` is a new array per token on any
   * session that has a task at all; this key changes only when a task actually
   * says something. `toolCallId` is in it because it is merged newest-non-null on
   * the daemon and so can arrive after the row it belongs to.
   */
  const taskKey = background.map((task) => `${task.id}:${task.state}:${task.toolCallId ?? ""}`).join(",");
  const liveBackground = useMemo(
    () => background.reduce((live, task) => (taskFinished(task.state) ? live : live + 1), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [taskKey],
  );
  const taskStates = useMemo(
    () => callStates(background),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [taskKey],
  );
  const foot = footSays(working, tasks.length, elapsedSays(turnElapsedMs), stale, background);
  /*
   * ⚠ **There was a `history` line here — `N background tasks finished` — and the
   * owner's call is that it goes.** Post factum it is information nobody needs: the
   * work is over, its output is already in the transcript, and the sentence stood
   * for the rest of the session because `Session.backgroundTasks` keeps terminal
   * rows by decision.
   *
   * **Two things went with it, and neither is an accident.** The foot was the only
   * door into the panel's `Completed` section, so that history is unreachable once
   * nothing is running — which is the same information the line was removed for,
   * reached a second way. And `footSpoken` no longer falls through to it, so a
   * completion is not announced in the `role="status"` region either; what that
   * region says is now exactly what the foot draws, which is the pair those two
   * were always meant to keep. The panel is still reachable for the whole time work
   * is outstanding, which is when it can be acted on.
   *
   * `retained` stays: it is a different question, asked by `WaitingFoot` itself —
   * whether there is a history *behind* the door — and it decides nothing about
   * whether the foot is drawn.
   */
  const retained = background.length;
  const footLine = foot?.line ?? null;
  const footSpoken = foot?.spoken ?? null;

  return (
    /*
     * The conversation's column, and not the scroll box's.
     *
     * `COLUMN` is here rather than on the box in `SessionView` for two reasons.
     * The scrollbar belongs at the window's edge, which is where `scroll-stable`
     * is reserving its gutter; and the ask card floats over the *box* while
     * carrying the same `COLUMN`, so the two line up by sharing one constant
     * instead of by both happening to be full-bleed.
     */
    /*
     * The gap under a conversation, and it is decided here for both of the things
     * that can be below it.
     *
     * `TRANSCRIPT_FOOT_PX` — the old `pb-12` — is 48px, so the conversation never
     * sits flush against the composer. Arrived at by looking at it beside Claude
     * Code's own gap twice: 32 first, then half again. Written as a number rather
     * than as a ratio to that, because the ratio was a guess off a screenshot and
     * the number is what was chosen.
     *
     * Inside the scroll box rather than as a margin on the composer, which is the
     * difference between a gap and a dead band: this is scrollable content, so it
     * only ever *ends* 48px above the composer and nothing loses the room. It also
     * keeps the composer's own box where it was, which is what the ask card's
     * region depends on — `bottom-0` there is the top of the composer.
     *
     * ⚠ **A parked card raises it, and the two must not stack.** The card is out of
     * flow over this scroller, so the room to scroll past it has to come from
     * somewhere — and it was a second `paddingBottom` on the box outside, which put
     * this 48 *and* the card's height between the last row and the card: a 56px
     * hole, reported as one. One number, `max`, and the gap under a card is
     * `ASK_CLEARANCE - 8` — the card frame's own `pb-2` is the other 8 — which is
     * 12px of air rather than a band.
     */
    /*
     * `sel-root` is one property in `index.css`, and the space it owns is the
     * space **between** messages — the margin between two rows, and the empty
     * column beside a right-aligned bubble. No message can own that, because no
     * message is drawn in it. Each markdown body and each bubble carries its own
     * for the text inside them; this one is the only element above all of them
     * that is still a plain block, which is what the property needs.
     */
    <div
      className={`sel-root ${COLUMN} px-4 pt-2`}
      style={{ paddingBottom: Math.max(TRANSCRIPT_FOOT_PX, askHeight + ASK_CLEARANCE) }}
    >
      {/*
       * **There is no control at the head of a transcript any more.**
       *
       * A `w-full` button reading "Show the conversation from before /clear" stood
       * here and re-fetched everything above the agent's own cut. It is deleted on
       * the owner's word, with `store.revealBeforeClear` and the flag behind it:
       * what the agent has been told to forget is not something this client offers
       * to read back, and the marker row below now says the whole of what happened
       * — the `/clear` that was sent, and that the context was cleared.
       *
       * Said here rather than only in the rule file because this is where the next
       * "the reader can't get to their history" report would be answered with a
       * button.
       */}

      {/*
       * The notice, all four visible arms of it, above the rows.
       *
       * Every one of them is about the **beginning** of the conversation — why it
       * starts here, or what is still to arrive in front of what you can see — so
       * this is where the sentence goes: a reader scrolling up meets the
       * explanation exactly where the missing part would have been, and events that
       * are still loading land directly under it. `floor` and `ceiling` wear
       * `AlertTriangle` because they are losses nothing will undo, `stalled` wears
       * it because a run that spent its schedule is a failure, and `loading` gets
       * the spinner every other in-flight thing in this file gets.
       *
       * ⚠ **`loading` and `stalled` spent two revisions at the foot, beside
       * `WaitingFoot`, and that is what this reverses.** The argument for moving
       * them was real and is worth keeping written down: opening a session pins
       * `scrollTop` to `scrollHeight` (`SessionView`'s follow-the-tail effect), so
       * the reader lands at the tail and a sentence at the head is thousands of
       * pixels above them — on precisely the slow connection that produces it. What
       * that traded it for was worse and was reported from a phone: `loading 2 293
       * earlier events…` sitting **under** the last thing the agent said, below
       * `working…`, reads as a piece of the page that has come adrift. The events it
       * names arrive at the top; a line about them at the bottom is describing
       * somewhere else.
       *
       * **The cost of putting it back, stated rather than discovered:** parked at
       * the tail you may not see this line at all, and when a run finishes the line
       * leaves and everything below it shifts up by its own height — it carries no
       * seq, so the `grewAbove` anchoring effect neither sees it arrive nor sees it
       * go. Somebody parked at the bottom is pinned there by the same effect and
       * sees nothing move; somebody parked in history sees one line of drift, once.
       * The `role="status"` region below is unchanged and still speaks it, so the
       * reader who cannot see it is the one who was already being told.
       *
       * `noticeSays` feeds every arm and the live region, so the one string that
       * made them unable to disagree is untouched. Q3.423.
       */}
      {(notice?.kind === "floor" ||
        notice?.kind === "ceiling" ||
        notice?.kind === "loading" ||
        notice?.kind === "stalled") && (
        <p className="mb-2 flex items-center gap-1.5 px-1 py-1 text-2xs text-faint">
          <Icon
            as={notice.kind === "loading" ? Loader : AlertTriangle}
            size={11}
            className={notice.kind === "loading" ? "animate-spin" : ""}
          />
          {noticeSays}
        </p>
      )}

      {/*
       * **"No events yet" is a claim about the conversation, and it was being made
       * about this client's own loading.**
       *
       * Reported against a session of 1989 events: the transcript said it had
       * none, with a "N earlier events did not load — try again" button sitting
       * directly above the sentence denying there was anything to retry. The cause
       * was a stuck latch in `loadAll` and is fixed there.
       *
       * It is an arm of `transcriptNotice` now rather than four booleans here, and
       * the ordering that made it safe is inside that function: nothing can be
       * outstanding, nothing can have been destroyed, and nothing can be on screen.
       * Its own literal rather than `noticeSays`, because this is a visible `<p>`
       * that a screen reader reads already — putting it in the live region too
       * would announce it twice.
       */}
      {/*
       * …and it says what to do, in the vocabulary the other five arms use.
       *
       * It read `No events yet.` — the one arm of a six-arm partition that spoke
       * the *daemon's* word for a log row, where every other arm says
       * "conversation". It was also a hand-inlined near-copy of {@link Empty}
       * (`py-8` against its `py-6`) from a module this file already imports six
       * things from, which is the fifth-copy drift `bits.tsx` exists to stop.
       *
       * The state is overwhelmingly reached one way — **you just made this
       * session** — because the daemon's first rows are all in `TRANSCRIPT_SILENT`.
       * So this is the first thing a new session shows, and a full stop in an empty
       * column is a dead end on the one screen that has an obvious next move
       * sitting 700px below it.
       *
       * Still its own literal rather than `noticeSays`, and that reasoning is
       * unchanged: this is a visible `<p>` a screen reader already reads, so
       * putting it in the live region too would announce it twice.
       */}
      {notice?.kind === "empty" && <Empty>Nothing yet — send the first message below.</Empty>}

      {/*
       * ⚠ **The provider wraps the foot as well as the rows, and it did not.**
       *
       * `WaitingFoot` was a sibling *after* `</ResizedContext.Provider>`, so its
       * `useContext(ResizedContext)` resolved to the module default — the `() => {}`
       * this context is declared with — and the `onResized()` in its tap handler
       * was a no-op. Opening the list therefore grew the box under a reader whose
       * `atBottom` was never re-measured, and the next streamed token ran
       * `SessionView`'s follow-the-tail effect and scrolled the thing they had just
       * opened out of view: verbatim the defect `remeasure` exists to prevent, on
       * the one disclosure that was outside the fence.
       *
       * Hoisted to the whole block rather than extended by two lines, because the
       * boundary that is easy to get wrong is "which children are disclosures" and
       * the boundary that is not is "the transcript". A row added below the foot
       * inherits it now by doing nothing.
       */}
      <ResizedContext.Provider value={onResized}>
        <div className="space-y-1.5">
          {/*
           * Inside the scroll box and above the rows, which is the same argument the
           * `working…` line below makes for being inside it: this changes
           * `scrollHeight` and never the box's own `clientHeight`, so
           * `SessionView`'s `ResizeObserver` — which is there because things *below*
           * the box shrink it — has nothing to do. It carries no seq either, so the
           * `grewAbove` anchoring effect, which keys on the first seq falling, does
           * not see it arrive or leave.
           */}
          {notice?.kind === "skeleton" && <TranscriptSkeleton />}
          <DecisionsContext.Provider value={decisions}>
            <QueuedContext.Provider value={queued}>
              <TasksContext.Provider value={taskStates}>
                {rows.map((node) => (
                  <TailRow key={node.key} node={node} files={files} />
                ))}
              </TasksContext.Provider>
            </QueuedContext.Provider>
          </DecisionsContext.Provider>
          {/*
           * Your own message, at once, in the bubble the committed event will use.
           *
           * **Above the working line and below every row**, which is the order the
           * conversation actually happened in and the one case that decides it:
           * `applySnapshot` folds the daemon's answer in as soon as `/prompt`
           * returns, so a session can be drawn as running while the `prompt` event
           * is still on its way down the socket. Drawn after the foot, a message
           * would sit *below* "working…" for that window.
           *
           * The same `UserBubble` the transcript uses, with the same `files`, so
           * an attached screenshot has its preview and its download here too —
           * which the composer could not give it, being outside
           * `FileAccessContext`. Nothing marks it as pending: it has been sent,
           * and a refusal puts the text back in the box with a toast beside it,
           * which is a remedy rather than a warning.
           */}
          {echo !== null && (
            <UserBubble text={echo.text} attachments={echo.attachments} files={files} />
          )}
          {/*
           * "The agent is working", where the reader is already looking.
           *
           * Inside the scroll box and last, which is the whole reason it is safe:
           * it changes `scrollHeight` and never the box's own `clientHeight`, so
           * the `ResizeObserver` in `SessionView` — which exists because things
           * *below* this box shrink it — has nothing to do, and somebody parked in
           * history sees nothing move. That observer's sibling effect takes
           * `working` as a dependency so that somebody parked at the bottom
           * follows it.
           *
           * This replaces a caption under the composer that mounted and unmounted
           * on every turn, moving the box somebody was typing in. **Fixed height**,
           * so it cannot become that again indoors.
           *
           * ⚠ It went on to say *"and a fixed string. No elapsed time, for the
           * reason `tail.ts` refuses one on a tool card: a ticking number re-renders
           * the whole transcript once a second"* — and neither half has been true
           * since `ELAPSED_FLOOR_MS` arrived. The objection it quotes survives whole
           * and is answered at `elapsedSays`: what is drawn is `shortDuration`, on
           * turns past two minutes only, changing at most once a minute, with
           * nothing scheduling a render for it. The string moves — it carries that
           * duration, and `stale` changes its tense — while the height, which
           * is what this paragraph is actually about, does not.
           */}
          {/*
           * The live region is mounted **unconditionally** and only its text
           * swaps, which is the one arrangement that reliably announces: a
           * `role="status"` inserted into the DOM in the same paint as its
           * content is commonly not spoken at all, VoiceOver on iOS included —
           * and this app is used from a phone. It matters more than usual because
           * the two captions under the composer are gone, so this is now the only
           * place the working state is put into words; `WorkingMark` says nothing
           * to a non-visual reader. `sr-only` takes no layout, so the row below
           * keeps its zero-height-when-idle property.
           *
           * It says whatever the notice says, and has to: the skeleton is
           * `aria-hidden` by construction and the button that used to speak for this
           * state is gone, so without this arm a screen-reader user reloading onto a
           * session gets silence for the whole of it.
           *
           * ⚠ It used to say `awaitingHistory ? "loading the conversation" : ""`,
           * i.e. it was gated on the *skeleton's* condition — `rows.length === 0` —
           * so in the one state this notice was added for, a transcript holding the
           * newest 500 of 2856 events, it read the empty string. Rendered under
           * `react-dom/server`, the whole region above the rows was byte-identical to
           * the finished conversation's and this was empty: the truncation was
           * inaudible as well as invisible. `noticeSays` is the fix and is shared with
           * the lines above, so the two cannot part company again.
           */}
          {/*
           * ⚠ **`footSpoken` and not `foot?.spoken`, so a completion is
           * announced.** `footSays` answers `null` the instant the last task
           * reaches a terminal state on an idle session, so `foot?.spoken` swaps
           * this region straight back to the notice — usually the empty string —
           * and the one event a reader might be waiting for is the one thing never
           * said. `footSpoken` falls through to the same sentence the visible row
           * draws, which keeps the pair that cannot disagree.
           *
           * ⚠ **Both sentences, joined — and it may not be `footSpoken ??
           * noticeSays`, which silences the truncation notice for good.** That
           * form reads as "the newest thing wins", and it is not: `footSpoken`
           * falls back to `history`, which is non-null for as long as the session
           * holds a single finished background row — and `Session.backgroundTasks`
           * **keeps** terminal rows by decision, so that is the rest of the
           * session, short of the daemon restarting and coming back with an empty
           * set. So on exactly those sessions
           * a `??` would outrank the notice permanently, and the notice is the one
           * string whose whole reason for existing (see the block above) is that a
           * truncated conversation was *inaudible as well as invisible*. Nothing
           * would report it either: `webcheck` has no DOM, so this region is
           * pinned as **source text** — a regex looking for `noticeSays` between
           * `role="status"` and the closing tag — and `footSpoken ?? noticeSays`
           * satisfies that regex exactly as this line does, while announcing one
           * of the two.
           *
           * The notice stays **last** rather than first, which is the order the
           * paragraph above already argued for and the only part unchanged by the
           * join: it is already a visible `<p>` above the rows and is a standing
           * condition, while a task finishing is a change that just happened, and a
           * live region is for changes. Empty strings drop out, so an ordinary
           * session with nothing truncated says exactly what it said before.
           */}
          <p role="status" aria-live="polite" className="sr-only">
            {[footSpoken ?? "", noticeSays].filter((said) => said !== "").join(". ")}
          </p>
          {/*
           * The foot is what the *agent* is doing, and nothing else.
           *
           * `loading` and `stalled` were drawn here for two revisions and are back
           * above the rows — see the head block for the whole argument. What is left
           * is the rule that was always true: this end of the transcript says what
           * is happening in the conversation, and the other end says why the
           * conversation does not start at its beginning.
           */}
          {footLine !== null && (
            <WaitingFoot
              line={footLine}
              working={working}
              stale={stale}
              outstanding={tasks.length + liveBackground}
              retained={retained}
              onOpenTasks={onOpenTasks}
            />
          )}
          {/* Portaled, so where it is mounted decides nothing about where it is
              drawn — and it is mounted here because this is the only component
              holding both of its sources. */}
          <TaskPanel
            background={background}
            hiddenFinished={hiddenFinished}
            onClearFinished={onClearFinished}
            onClose={onCloseTasks}
            onStopTask={onStopTask}
            open={tasksOpen}
            reporting={reportsTasks}
            tasks={tasks}
          />
        </div>
      </ResizedContext.Provider>
    </div>
  );
}

/**
 * `permissionDecisions(events)`, so a refusal is not drawn as an approval.
 *
 * A context rather than a prop, and that is a performance decision rather than a
 * tidiness one. It is a fresh `Map` on every arriving event, so as a prop it was a
 * new identity on every row on every token — which defeats `TailRow`'s memo
 * completely and would have made memoising it pointless.
 *
 * **Exactly one component consumes it**, and that is the other half of the same
 * decision. A context is not free the way a stable prop is: a consumer re-renders
 * whenever the value changes, whatever `memo` answers about its props. So while
 * every `event` node read this, a fresh `Map` per token re-rendered about two
 * thirds of the transcript on every token — and almost none of those rows use the
 * value, since it is read in one arm of `renderEvent`. `PermissionResolvedRow`
 * reads it where it is used and nothing else subscribes.
 */
const DecisionsContext = createContext<ReadonlyMap<string, PermissionOptionKind>>(new Map());

/**
 * Which messages the daemon has taken and not yet handed to the agent.
 *
 * A context for `DecisionsContext`'s reason and with the same two halves of the
 * argument, one of which had to be arranged rather than merely observed:
 *
 * **Exactly one component consumes it** — `PromptRow`, and only the arm of it
 * that draws the line. Nothing else subscribes.
 *
 * ⚠ **And its identity is stable across a token**, which is the half that does
 * not come for free: `queuedSeqs` builds a fresh `Set` on every call, so passed
 * straight down it would re-render every prompt bubble in the conversation on
 * every arriving chunk — exactly the cost that argument was written about.
 * `SessionView` memoises it on the seqs themselves, so this value changes when
 * the queue changes and at no other time. Empty on every agent that can be
 * steered, and empty on every daemon too old to have a queue, so the common case
 * is one shared frozen `Set`.
 */
const QueuedContext = createContext<ReadonlySet<number>>(new Set());

/** The one identity a session with no background work ever puts on `TasksContext`. */
const NO_TASK_STATES: ReadonlyMap<string, AsyncTaskState> = new Map();

/**
 * What the daemon last said about the work behind each tool call, by `toolCallId`.
 *
 * ⚠ **The card cannot tell "still running in the background" from "finished
 * minutes ago" out of the log, so it may not be asked to.**
 * `ToolNode.backgrounded` is sticky by design — a call that detached does not stop
 * having detached — so `backgrounded && status === "completed"` is *"this call
 * handed its work off"* and never *"that work is still going"*. A card drawing the
 * `Terminal` glyph and `Running in the background` off that pair alone says *this
 * call detached* for the life of the tab, which is a claim about the past worn as
 * a claim about now. The join that fixes it was already on the wire and unread:
 * the daemon carries `BackgroundTask.toolCallId` on every task and mirrors it
 * **for exactly this**, and nothing in this file, `TaskPanel` or `tasks.ts` asked
 * for it. Without it the panel row reaching `Completed` and the card two inches
 * above it would be two surfaces disagreeing about one piece of work.
 *
 * The worse case is not that pair disagreeing, it is a **restart**:
 * `backgroundTasksState` is in memory, so it comes back empty, and every
 * historically-backgrounded card in a replayed transcript would assert running
 * work on a conversation from days ago — with no panel row beside it and nothing
 * that could ever clear it. That is the case `ToolCall`'s "no matching row means
 * NOT running" arm is decided by.
 *
 * A context for `DecisionsContext`'s two reasons, with the identity question
 * answered the way `QueuedContext`'s is: the value is memoised on the tasks' own
 * ids and states, so it changes when a task says something and never merely
 * because a snapshot arrived. Unlike those two this is read from *every* tool
 * card rather than from one row kind, which is affordable only because of that
 * key — a fresh `Map` per token would re-render the whole transcript's machinery
 * on every chunk.
 */
const TasksContext = createContext<ReadonlyMap<string, AsyncTaskState>>(NO_TASK_STATES);

/**
 * The snapshot's task rows, indexed by the call that started them.
 *
 * A task with no `toolCallId` is dropped rather than kept under a placeholder: it
 * is work with no card — a workflow, a monitor, anything the agent started without
 * a tool call of its own — and it is drawn in the panel, which reads the list
 * itself.
 *
 * ⚠ **A live row outranks a terminal one on the same id**, which is the only
 * tie-break here and is the safe direction: one call id carrying two tasks means
 * the agent re-used it, and answering "finished" over work that is running is the
 * defect this map exists to fix, while answering "running" over a finished row for
 * one more update is a marker that clears itself.
 */
function callStates(background: readonly BackgroundTask[]): ReadonlyMap<string, AsyncTaskState> {
  const out = new Map<string, AsyncTaskState>();
  for (const task of background) {
    if (task.toolCallId === null) continue;
    const held = out.get(task.toolCallId);
    if (held !== undefined && !taskFinished(held)) continue;
    out.set(task.toolCallId, task.state);
  }
  return out.size === 0 ? NO_TASK_STATES : out;
}

/**
 * Tell the transcript a row changed its own height.
 *
 * A context for the same reason `decisions` is one: `TailRow` is memoised, and a
 * subagent's steps are drawn by a nested `TailRow`, so threading a callback down
 * as a prop would mean every card carrying one whether or not it can be opened.
 * The value must be stable — `SessionView` holds it in a `useCallback` — or every
 * consumer re-renders on each transcript render and the memo buys nothing.
 */
const ResizedContext = createContext<() => void>(() => {});

/**
 * A notice as the one sentence that says it.
 *
 * The copy lives here rather than in `store.ts` — that file holds the rules and
 * this is what a reader sees — but it is **one** function for both the visible line
 * and the `role="status"` region, which is the property that was broken: the two
 * were written separately and gated differently, so the region fell silent in
 * exactly the state the line exists for.
 *
 * `empty` answers the empty string deliberately: "No events yet." is a visible
 * `<p>` a screen reader already reads, and repeating it in a live region announces
 * it twice. `skeleton` is the mirror case — the skeleton is `aria-hidden`, so the
 * region is the only voice it has.
 *
 * No `default` arm, so a seventh member of `TranscriptNotice` fails to build here
 * rather than silently drawing an empty line.
 */
function noticeText(notice: TranscriptNotice): string {
  if (notice === null) return "";
  switch (notice.kind) {
    case "skeleton":
      return "loading the conversation";
    case "loading":
      return `loading ${notice.earlier.toLocaleString()} earlier event${notice.earlier === 1 ? "" : "s"}…`;
    case "stalled":
      return (
        `${notice.earlier.toLocaleString()} earlier event${notice.earlier === 1 ? "" : "s"} ` +
        `${notice.earlier === 1 ? "has" : "have"} not arrived yet — retrying`
      );
    case "ceiling":
      // The count actually held, not the constant: two quantities can raise this
      // stop now (see `MAX_TRANSCRIPT_BYTES`), so a fixed number would be a claim
      // about the wrong one.
      return (
        `this conversation is longer than one tab holds — the newest ${notice.held.toLocaleString()} ` +
        `events are shown, and the daemon still has the rest`
      );
    case "floor":
      return (
        `the start of this conversation is gone — ${notice.destroyed.toLocaleString()} earlier ` +
        `event${notice.destroyed === 1 ? "" : "s"} ${notice.destroyed === 1 ? "was" : "were"} dropped by an older daemon`
      );
    case "empty":
      return "";
  }
}

/**
 * What the foot of the transcript says, for the line **and** for the live region.
 *
 * Both renderings come out of one call, which is `noticeText`'s lesson applied
 * before it can be re-learned: the visible line and the `role="status"` region
 * were once written separately and gated differently, and the region fell silent
 * in exactly the state the line existed for. Returning a pair makes them unable to
 * disagree.
 *
 * The spoken form differs from the line only where prose differs from a label —
 * `agent is working` reads aloud as a sentence and `working…` does not — with
 * **one** exception, and it is named at the arm rather than left to be found: a
 * dropped socket puts the reason into the spoken form only, because the visible
 * copy of it is the banner above the conversation and a screen reader is not told
 * that appeared. `null` is "nothing to say", and the region falls back to the
 * transcript notice.
 *
 * `·` is the separator this app already uses between two facts on one line.
 */
/**
 * How long a turn runs before the foot says how long it has been running.
 *
 * **The line stays exactly as it ships today for an ordinary turn**, which is the
 * whole shape of this: a number drawn on every turn is furniture, and a number
 * drawn only on the slow ones *is itself the signal*. Two minutes is chosen rather
 * than measured, and is named here so it is one decision in one place rather than a
 * literal inside a conditional.
 */
const ELAPSED_FLOOR_MS = 120_000;

/**
 * How long the turn has been running, in the vocabulary the session list already
 * uses — or `null`, which is both "no turn" and "not long enough to be worth
 * saying", so a caller cannot draw a number this rule says not to draw.
 *
 * ⚠ **The milliseconds arrive measured, and this function is why that had to
 * change.** It read `Date.now() - turnStartedAt`, where `turnStartedAt` is the
 * daemon's clock off the snapshot — the one subtraction `store.ts` names as wrong
 * on the case that matters, a phone whose clock drifted while it was asleep.
 * `elapsedSince` is the correct form and there is exactly one copy of it, out
 * there where `webcheck` can pin it against two clocks that disagree; the caller
 * threads the row it needs. The floor below then doubles as the guard on what that
 * arithmetic can still produce when our own clock moves backwards between two
 * renders — a negative is under two minutes, so it says nothing at all rather than
 * `−2m`.
 *
 * **`shortDuration` and not a clock**, which is what makes this affordable at all.
 * `tail.ts` refuses an elapsed time on a tool card because "a ticking number
 * re-renders the whole transcript once a second", and that objection is about a
 * *seconds* counter: `shortDuration`'s own note in `bits.tsx` records that it was
 * one, and was made coarse for exactly this reason — `<1m`, then a value that
 * changes once a minute. Nothing schedules a render for it either, because nothing
 * has to: the transcript already re-renders on every streamed token and on the 4s
 * snapshot push, so the number is at most one poll stale.
 */
function elapsedSays(turnElapsedMs: number | null): string | null {
  if (turnElapsedMs === null) return null;
  return turnElapsedMs < ELAPSED_FLOOR_MS ? null : shortDuration(turnElapsedMs);
}

/**
 * How the foot names what is outstanding, over both of its sources.
 *
 * **The two sources are structurally disjoint** — delegations come from the
 * transcript and carry `subagent` or steps, background tasks come from the
 * snapshot, and the daemon never announces a backgrounded *subagent* as a task at
 * all, because the adapter marks it `ignored`. So these two counts can be added
 * without a `Set` to be safe, and the next person to reach for one should read
 * this sentence and `isDelegation`'s instead.
 *
 * Three answers, in the order they are decided:
 *
 * * Delegations alone keep **today's words**, so every assertion written about
 *   this line before background work existed goes on meaning what it meant.
 * * Background work alone, all of one known kind, gets that kind's noun.
 * * Anything mixed — two kinds, or delegations beside background work — falls to
 *   the canonical `N background tasks`. That is Claude Code's own fallback, and
 *   it is the honest one here too: the alternative is a sentence that lists, and
 *   a foot line that lists is a panel drawn one row too high.
 *
 * ⚠ **It is handed the snapshot's list, terminal rows included, and decides for
 * itself which of them are live** — and that is a correctness decision that a
 * performance one nearly took away. The draft of this took the pre-filtered array
 * `footSays` builds one line above the call, on the ground that filtering twice
 * per token is an allocation this component cannot afford. True about the
 * allocation and wrong about the signature: it turned an exported function that
 * could not be misused into one whose answer depends on what a caller remembered
 * to do, in a repository with no unit tests, where `outstandingSays(0, [one
 * finished shell])` would have answered `1 shell`. The walk below skips terminal
 * rows and allocates **nothing** — no `Set`, no mapped array — so the guarantee
 * costs less than the array it replaced, and the caller's own count is the same
 * walk rather than a second rule.
 */
export function outstandingSays(tasks: number, background: readonly BackgroundTask[]): string {
  let live = 0;
  let only: string | undefined;
  let mixed = false;
  for (const task of background) {
    if (taskFinished(task.state)) continue;
    live += 1;
    if (only === undefined) only = task.taskType;
    else if (only !== task.taskType) mixed = true;
  }
  const total = tasks + live;
  if (live === 0) return `${tasks} task${tasks === 1 ? "" : "s"}`;
  if (tasks === 0 && !mixed) {
    const noun = only === undefined ? undefined : TASK_NOUNS[only];
    if (noun !== undefined) return `${live} ${live === 1 ? noun[0] : noun[1]}`;
  }
  return `${total} background task${total === 1 ? "" : "s"}`;
}

export function footSays(
  working: boolean,
  tasks: number,
  /**
   * `elapsedSays(turnElapsedMs)`, resolved by the caller. Optional, so the existing
   * call sites — and every assertion about them — keep their meaning unchanged.
   *
   * ⚠ **Both defaults are right for the call sites and were also how this
   * function's two newest rules shipped with nothing behind them**: `webcheck`
   * called it with two arguments, so neither the elapsed time nor the frozen tense
   * was exercised anywhere. A default keeps an old assertion meaning what it meant;
   * it is not a reason to leave the four-argument form unasserted.
   */
  elapsed: string | null = null,
  /**
   * Nothing is streaming this session: no socket at all, or one whose phase is not
   * `live`. Optional for `elapsed`'s reason, and `false` is the state every
   * existing assertion is about: a live stream.
   *
   * ⚠ **It was `reconnecting`, and it took `phase === "waiting"`** — true only in
   * the gaps *between* attempts, so on a dead network the tense flipped back to the
   * present for the whole of every retry. The caller's own docblock holds the
   * measurement and the reason the banner keeps the narrower question.
   */
  stale: boolean = false,
  /**
   * Work the agent said it left running, from the snapshot.
   *
   * Optional for `elapsed`'s reason, and `[]` is what every existing assertion is
   * about — a daemon that cannot say, or an agent that does not report. Terminal
   * rows are in here too and are filtered by {@link outstandingSays}: the panel
   * keeps a `Completed` section, and a finished task is not something anybody is
   * waiting for.
   */
  background: readonly BackgroundTask[] = [],
): { line: string; spoken: string } | null {
  /*
   * **`working` is a claim about now, and with nothing streaming this has no way
   * to know what now is.** It is `showsWorking` over the last snapshot that
   * arrived, so a dead stream left three bars blinking beside `working…` for as
   * long as the tab stayed open — and the elapsed time beside it was the half a
   * reader could watch going wrong, since `turnStartedAt` is frozen at whatever
   * that snapshot said while `Date.now()` carries on. So the tense changes and the
   * number goes: what is true is that the agent was working when we last heard.
   */
  const frozen = working && stale;
  // Only ever beside `working…`. An elapsed time next to "waiting for 2 tasks"
  // would be the *turn's* duration attached to a sentence about delegations that
  // outlived it — a different quantity wearing the same words.
  const shown = frozen ? null : elapsed;
  const runs = frozen ? "last seen working" : shown === null || !working ? "working…" : `working… · ${shown}`;
  /*
   * The spoken form carries the reason and the line does not, which is the one
   * place the pair is deliberately unequal. The visible copy has the reconnect
   * banner directly above the conversation whenever there is a reconnection to
   * announce, saying it with the error the socket gave; a screen reader is told
   * nothing at all by a `<p>` appearing, so this region is where that fact has to
   * travel.
   *
   * ⚠ **It said `reconnecting`, and that word belongs to the banner's narrower
   * predicate rather than to this one.** This arm is also reached with no socket at
   * all and with one still opening for the first time, where nothing is
   * reconnecting to anything — so it says the thing that is true in every arm,
   * which is that there is no live connection to check the claim against.
   */
  const said = frozen
    ? "last seen working, not connected"
    : shown === null || !working
      ? "agent is working"
      : `agent is working, ${shown}`;
  // Counted rather than filtered, which is what lets `outstandingSays` stay
  // self-defending: both walks skip terminal rows and neither allocates, so this
  // one and the sentence below cannot disagree about which rows are live, and
  // nothing here builds an array per token to answer a question about a number.
  const live = background.reduce((count, task) => (taskFinished(task.state) ? count : count + 1), 0);
  const outstanding = tasks + live;
  /*
   * ⚠ **`null` on an idle session with only finished rows, and that stays true.**
   * This function answers *what is outstanding*, and terminal rows are not: the
   * panel keeps a `Completed` section precisely because a finished task is
   * something to read rather than something to wait for.
   *
   * ⚠ **This paragraph went on to say the foot stays pressable in that state, and
   * that stopped being true when the `N background tasks finished` line went.**
   * That sentence *was* the foot in this state — `EventList` draws `WaitingFoot`
   * only where `footLine !== null` — so with it removed by the owner's call this
   * `null` is exactly what closes the door on the retained history until something
   * else is outstanding. Recorded rather than repaired: the line was removed
   * because a standing report of finished work is not information anybody asked
   * for twice, and re-adding a door for it would be re-adding the line under
   * another name. `retained` below still decides the disclosure, in the narrower
   * set of states this leaves it.
   */
  if (outstanding === 0) return working ? { line: runs, spoken: said } : null;
  const many = outstandingSays(tasks, background);
  if (!working) return { line: `waiting for ${many}`, spoken: `waiting for ${many}` };
  return { line: `${runs} · waiting for ${many}`, spoken: `${said}, waiting for ${many}` };
}

/**
 * The line at the foot of the transcript, and what it opens to.
 *
 * **It exists because the turn ending is not the agent stopping.** `showsWorking`
 * reads `session.turn`, which is cleared at `turn_end` — so a conversation whose
 * delegations were still running drew nothing at all, and read as finished. This is
 * the one signal that outlives the turn, because it is built from the transcript
 * rather than from the snapshot.
 *
 * The row is `[dot] [text] [chevron]`, which is `ToolCall`'s own arrangement rather
 * than a new one, at `h-5` so it occupies exactly the space the bare `working…`
 * paragraph used to. `-mx-1 px-1` hangs the hover fill's padding outside the
 * content box, so **the dot sits in the same pixels whether or not a task is
 * outstanding** — the line must not step sideways when a spawn lands.
 *
 * The two marks are chosen rather than invented. `WorkingMark` is what this app
 * says "a turn is actually running" with — the product's own three bars, blinking
 * as three dots; `Dot tone="pending"` is the hollow pulse it already means "in
 * flight, nobody is deciding anything" by, which is precisely a wait on somebody
 * else's work. Nothing is added to `TONE_DOT`, and the mark is deliberately the
 * same width as the dot it replaced so the line does not shift when a turn starts.
 *
 * **A third state, and it is the same mark rather than a fourth object: `stale`
 * freezes it.** Three bars breathing is an assertion that work is happening *now*,
 * and with nothing streaming this row is drawing the last snapshot that arrived —
 * so the blink was the loudest lie on the screen, and it outlived the daemon it was
 * about. `WorkingMark still` is the idiom the cancelled-turn row already invented
 * for exactly this shape of thing: the same object, not animating, beside a line
 * whose tense has changed. ⚠ It has two callers now, and `Mark.tsx`'s docblock
 * names this row as the second one — a note here said that docblock "still says
 * one", which was true when this shipped and stopped being true when it was
 * rewritten.
 *
 * Not a `button` when there is nothing to open: with no task rows at all this is
 * the old paragraph, `aria-hidden` and inert, because a disclosure whose body is
 * empty is a control that lies about having something behind it.
 *
 * ⚠ **"Nothing to open" is not "nothing outstanding", and reading it as such shuts
 * the one door this row is.** The panel keeps every task it was told about,
 * `Completed` section included, so a session whose background work has all
 * finished still has rows to draw — and keyed on the live count this row would go
 * back to being a paragraph at exactly the moment somebody would want to know how
 * the build ended. `retained` is the question it asks; `outstanding` is left
 * deciding the mark, which is the thing it is right about.
 */
function WaitingFoot({
  line,
  working,
  stale,
  outstanding,
  retained,
  onOpenTasks,
}: {
  line: string;
  working: boolean;
  /** Nothing is streaming this session — see the note above on why the mark stops. */
  stale: boolean;
  /**
   * How many things are outstanding **now**, over both sources.
   *
   * A count rather than the lists themselves, because this row no longer draws
   * them, and `footSays` has already turned the same two sources into the words
   * beside it. ⚠ **It decides the mark and no longer decides the disclosure** —
   * see `retained`, which is what that question moved to.
   */
  outstanding: number;
  /**
   * How many task rows the panel is still holding, finished ones included.
   *
   * ⚠ **This is what makes the row pressable, and it had to stop being
   * `outstanding`.** The panel keeps a `Completed` section, and this row is the way
   * into it — so keyed on the live count the door would disappear at the instant
   * the retained history became worth reading.
   *
   * ⚠ **The state it decides is narrower than this once claimed.** It read *"the
   * only way into it"*, and the sentence carrying a foot for an idle session
   * holding nothing but finished rows is gone — so this row is not drawn there at
   * all, and the finished history is unreachable until something else is
   * outstanding. What `retained` still buys is every state where the foot *is*
   * drawn: a live task beside a finished one, a delegation outstanding while a
   * build has ended. `footSays`'s own ⚠ is the other half of this.
   *
   * ⚠ **The two numbers are not complements over one set, and reading them as a
   * partition is wrong in both directions.** `retained` is `background.length`,
   * the snapshot's task rows and nothing else, finished ones included;
   * `outstanding` is delegations from the *transcript* plus the live half of that
   * same list. So `outstanding` counts rows `retained` holds (every live one) and
   * also rows it never holds (every delegation), and `retained` counts rows
   * `outstanding` drops (every finished one). What the pair is actually for is one
   * disjunction: the row is pressable when either is non-zero, and the only state
   * that draws the inert paragraph is the one where the panel has nothing in it at
   * all — which holds because `tasks` and `outstanding` move together.
   */
  retained: number;
  /** Opens the panel that draws them. */
  onOpenTasks: () => void;
}): ReactNode {
  if (outstanding === 0 && retained === 0) {
    return (
      <p aria-hidden={true} className="flex h-5 items-center gap-2 text-2xs text-faint">
        <WorkingMark still={stale} />
        {line}
      </p>
    );
  }
  return (
    /*
     * ⚠ **A way into the panel, and no longer a fold of its own.**
     *
     * This was a disclosure that drew the same list inline. Two surfaces listing
     * one set is how they come to disagree — and the inline one could not grow the
     * card the panel needs without pushing the composer down the screen every time
     * an agent backgrounded a shell. So the rows moved out and this row kept the
     * one job it was always good at: saying, in the conversation, that something is
     * still going, and being pressable.
     *
     * `aria-haspopup` rather than `aria-expanded`: there is nothing under this row
     * to expand any more, and a control that claims a region it does not own is
     * read out as a lie. `ResizedContext` went with the fold — nothing here changes
     * this element's height now, so there is no scroll anchor to correct.
     */
    <button
      aria-haspopup="dialog"
      onClick={onOpenTasks}
      /* 20px of ink, 44px of target, and the growth is **downward only** — which
         is free here and nowhere else in this file. This is the last row in the
         transcript's column, and that column ends in `pb-12`: 48 pixels that hold
         nothing pressable and exist so the conversation never sits flush against
         the composer. So 24px of `::after` lands entirely in padding, overlaps no
         neighbour's face, and adds nothing to `scrollHeight`. `TAP_GROW_Y` is the
         wrong constant rather than the wrong idea — it is calibrated for a 32px
         box and reaches 32px from this one — and growing symmetrically would put
         this target 12px into a `space-y-1.5` gap and onto the card above, which
         is itself a disclosure somebody aims at. The box stays `h-5`, so the row
         is the same height whether or not a task is outstanding.

         ⚠ **And it is a thumb's 24px, which is why every class carries
         `[@media(pointer:coarse)]:`.** A pad extends `:hover` exactly as far as
         it extends hit-testing, and this row's `hover:bg-raised hover:text-fg`
         was lighting from 24px *below* itself — a caption in the transcript
         answering a pointer that was nowhere near it. `bits.tsx`'s top docblock
         has the mechanism; this is the widest of the leaks it names, because
         `h-5 w-full` is the one shape that driver's square sweep cannot see. */
      className="tap relative -mx-1 flex h-5 w-full items-center gap-2 rounded-md px-1 text-left text-2xs text-faint [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:top-0 [@media(pointer:coarse)]:after:-bottom-6 [@media(pointer:coarse)]:after:content-[''] hover:bg-raised hover:text-fg"
    >
      {/* Three marks for three claims, and the third is the new one. `Dot
          tone="off"` is the hollow **static** dot, which is what this app already
          means by "there is a thing here and nothing is happening to it" — the
          state this row is in when every task has finished and the row is left
          standing as a way back into the record. Drawing `pending` there would be
          a pulse over work that ended, which is the same lie one shape smaller
          that `WorkingMark still` exists to stop. */}
      {working ? <WorkingMark still={stale} /> : outstanding > 0 ? <Dot tone="pending" /> : <Dot tone="off" />}
      <span className="min-w-0 flex-1 truncate">{line}</span>
      <span className="shrink-0">
        <Icon as={ChevronRight} size={11} />
      </span>
    </button>
  );
}

/**
 * One node, drawn. Everything deciding *what* a node is happens in `tail.ts`.
 *
 * Memoised on {@link sameNode}, because `buildTail` hands back new objects every
 * time and the default shallow compare would therefore never skip anything. The
 * `useState` inside `ToolCall` survives this — memo declines to *re-render*, it
 * does not unmount — so a card you opened stays open while the agent works.
 */
const TailRow = memo(function TailRow({
  node,
  files,
}: {
  node: TailNode;
  files: FileAccess | null;
}): ReactNode {
  switch (node.kind) {
    case "text":
      return <TextRun role={node.role} thought={node.thought} text={node.text} />;
    case "tool":
      return <ToolCall node={node} files={files} />;
    case "group":
      return <GroupRow node={node} files={files} />;
    case "change":
      return <ChangeRow node={node} files={files} />;
    case "update":
      // A failure whose own call fell outside the window — the only thing saying
      // something broke up there.
      return (
        <p className="flex items-center gap-1.5 font-mono text-2xs text-danger">
          <Icon as={X} size={11} />
          {node.title ?? node.toolCallId}
        </p>
      );
    case "gap":
      return <GapMarker gap={node.gap} />;
    case "event":
      // A plain call again, not a component wrapper: the decisions context is now
      // read by `PermissionResolvedRow` alone, so this arm needs no hook.
      return renderEvent(node, files);
  }
}, sameRow);

function sameRow(
  a: { node: TailNode; files: FileAccess | null },
  b: { node: TailNode; files: FileAccess | null },
): boolean {
  return a.files === b.files && sameNode(a.node, b.node);
}

/**
 * A permission's answer, and **the only thing in the transcript that reads
 * `DecisionsContext`** — which is the whole point of it being its own component.
 *
 * A context consumer re-renders when the value changes no matter what `memo`
 * answers, and `decisions` is a fresh `Map` on every arriving event (it is
 * `useMemo`'d on `transcript.events`, whose identity moves per append). So while
 * `EventRow` read the context for *every* event node, roughly two thirds of the
 * transcript re-rendered on every streamed token regardless of `sameNode` — and
 * almost none of those rows had any use for the value. Reading it here instead
 * confines that to the handful of rows that are actually permission answers.
 *
 * `outcome: "selected"` means an option was chosen, which includes every
 * `reject_*` one — so keying the icon on it drew a check mark against a refused
 * command, and since `tail.ts` merges the request row away this is the only
 * surviving record of the answer. `permissionDecisions` does the join the
 * resolution cannot do alone; an unknown option is drawn as neither an approval
 * nor a refusal rather than guessed at.
 */
function PermissionResolvedRow({
  event,
  heading,
}: {
  event: PermissionResolvedEvent;
  /**
   * What the call called itself, when the daemon had nothing but its id.
   *
   * Measured against codex: the request carries no title, so the daemon's
   * `title ?? toolCallId` left this row reading `✓ exec-55382d16-8647-…` — the only
   * record that somebody approved something, saying nothing about what. Resolved in
   * `tail.ts`, where the window is, rather than by a walk from here: this component
   * already re-renders on every `DecisionsContext` change and must not also carry a
   * per-render join.
   */
  heading: string | null;
}): ReactNode {
  const kind = useContext(DecisionsContext).get(event.permissionId);
  const denied = refused(kind) || event.outcome === "cancelled";
  return (
    /*
     * **It hangs off the nesting rule, and that is the only axis this row had left.**
     *
     * Five things in this transcript draw `[status glyph][kind glyph][clipped
     * text][trailing badge]` — a tool call, a folded run, this, a file change and the
     * foot — and they all draw it at one ink value, because "machinery is
     * `text-fg/85`, one value for every machinery row" is the rule and the rule is
     * right: a tone here would say *this one is louder* about a settled fact, and a
     * box would be the twenty-bordered-rectangles transcript `ToolCall` already
     * reversed once. So the difference is spent where this app already spends one —
     * `border-l-2 border-edge`, the single nesting idiom, which everywhere else says
     * *this belongs to the row above it*. That is exactly what an answer to a
     * permission is: not a call the agent made, but something that happened to one.
     * `ChangeRow` takes the same rule for the same reason.
     *
     * ⚠ **This narrows an alignment that was deliberate**, so the old note is kept
     * rather than deleted: inside a folded run this check mark was one of five in a
     * column, and it had one icon where a tool row has two and no horizontal padding
     * where a tool row has `px-1`, so it stood four pixels left of everything else
     * and its text a whole glyph left of theirs — reported off a screenshot, which is
     * the only way that gets noticed. The glyph columns still line up; what moved is
     * the whole row, by one indent, on purpose. Which is why the padding below stays
     * on the `<p>` and the rule goes on a wrapper: `pl-2` and `px-1` are the same
     * property, and Tailwind v4 emits utilities alphabetically, so `px-1` would win
     * wherever the two met and the geometry would silently be neither.
     *
     * The second slot is **reserved and empty**, which is this app's stated remedy for
     * a row that is missing the only copy of something: a permission has no ACP kind
     * of its own to draw there, and borrowing the tool's would be decoration standing
     * in for alignment.
     */
    <div className="ml-3 border-l-2 border-edge pl-2">
      <p
        className={`flex items-center gap-2 px-1 py-1 text-xs ${denied ? "text-fg font-medium" : "text-fg/85"}`}
      >
        <span className="shrink-0">
          <Icon as={denied ? CircleSlash : kind === undefined ? Minus : Check} size={12} />
        </span>
        <span className="inline-flex w-3 shrink-0" aria-hidden={true} />
        {/* Truncated, which it did not need to be while every title was a tool's name:
            a codex heading is the command it ran, and those are unbounded. */}
        <span className="min-w-0 flex-1 truncate">{heading ?? event.title}</span>
        {denied && <span className="shrink-0 font-medium">denied</span>}
        {event.by !== "client" && (
          <span className="shrink-0 text-faint">{resolvedByText(event.by)}</span>
        )}
      </p>
    </div>
  );
}

/**
 * A question the agent asked and you answered, drawn as an exchange.
 *
 * The agent's line, then your answer through the same `UserBubble` every other
 * message you have sent uses — one component, now four call sites, so they cannot
 * diverge into four slightly different right-aligned boxes.
 *
 * That shape rather than a permission's one-liner because a question and its
 * answer *are* the conversation: the answer was folded into the tool's input and
 * went into the model's context, unlike an approval, which is bookkeeping about a
 * tool. Skipping and cancelling have no answer to draw, so they stay one quiet
 * line — there is nothing there that a person said.
 */
function ElicitationResolvedRow({
  event,
  asked,
}: {
  event: ElicitationResolvedEvent;
  /** The questions, recovered in `tail.ts`. `null` means "draw what you drew before". */
  asked: readonly AnsweredQuestion[] | null;
}): ReactNode {
  const outcome = elicitationOutcome(event);
  const answers = event.answers ?? [];

  /*
   * The question in muted text, the answer in full strength, inside one quiet
   * box — the shape a tool *result* has, which is what this is.
   *
   * It was a question line plus a `UserBubble`, and that was wrong in a way worth
   * naming: a bubble is something you *said*, and an answer to a form is something
   * you *picked*. Drawn as speech it claimed a turn in the conversation that never
   * happened, and on a phone two right-aligned bubbles in a row read as two
   * messages. The box says "the agent asked, this came back" in one object.
   */
  /*
   * ⚠ **The questions go above the answers, and until 0.3.0 they were nowhere.**
   *
   * `event.message` is what this box used to open with, and for a multi-question
   * form that string is the adapter's preamble — literally *"Please answer the
   * following questions."* — while each real question sits in its field's
   * description, which the resolution does not carry. So a settled
   * `AskUserQuestion` was drawn as a generic sentence over four bare values: the
   * answers to questions the transcript had lost.
   *
   * With `asked` present the preamble earns nothing and is dropped: every row now
   * says what was asked, so a line above them saying "answer the following" is
   * furniture over its own content. Without it, exactly the old rendering — which
   * is what the three fallbacks in `EventNode.asked` are for.
   *
   * `wrap-anywhere` throughout and no clip anywhere, which is the rule this whole
   * release turns on: a question a person reads half of is a question they answer
   * wrongly, and the record of one they already answered is worth no less.
   */
  return (
    <div className="rounded-md border border-edge px-2.5 py-2 text-xs">
      {asked === null && <p className="text-muted wrap-anywhere">{event.message}</p>}
      {asked !== null ? (
        <div className="space-y-1.5">
          {asked.map((answer) => (
            <div key={answer.key}>
              {/* The question when it was recoverable, the field's own title when
                  it was not — which is the "let me describe something else" box,
                  and the only honest label there is for a typed answer. */}
              <p className="text-muted wrap-anywhere">{answer.question ?? answer.label}</p>
              <p className="wrap-anywhere">{answer.value}</p>
            </div>
          ))}
        </div>
      ) : answers.length > 0 ? (
        <div className="mt-1 space-y-0.5">
          {answers.map((answer) => (
            <p key={answer.key} className="wrap-anywhere">
              {/* The label only earns its place when there is more than one
                  answer to tell apart. */}
              {answers.length > 1 && <span className="text-faint">{answer.label}: </span>}
              {answer.value}
            </p>
          ))}
        </div>
      ) : (
        <p className={`mt-1 ${outcome.tone === "warn" ? "text-fg font-medium" : "text-faint"}`}>
          {outcome.verb}
          {event.by !== "client" && ` — ${resolvedByText(event.by)}`}
        </p>
      )}
    </div>
  );
}

/**
 * The person's message, and — where it has not reached the agent yet — one line
 * saying so.
 *
 * ⚠ **A component rather than an arm of `renderEvent`, because the line reads a
 * context and `renderEvent` is a plain function.** That is a mechanical reason
 * for a split that also happens to be the right one: `UserBubble` is shared by
 * four call sites and must not learn about queues, and this is the only one of
 * the four where a message can be waiting.
 *
 * **What the line is for.** A message sent while the agent is working is taken
 * rather than refused, and *how* it reaches the agent depends on the agent:
 * claude and codex take it into the turn already running, so it is already in
 * front of the model and nothing is drawn — a status line about something that
 * has already happened is furniture. kimi has no way to, so the daemon holds it
 * until the turn ends, and that is a real wait somebody would otherwise read as
 * the message having been ignored.
 *
 * **`Bubble.tsx`'s "no `pending`" rule is untouched**, and the distinction is
 * worth stating because this looks like the thing that rule forbids. That rule is
 * about a message *this tab* has sent and not had answered — a claim about the
 * network, drawn as doubt over something that had in fact been delivered. This is
 * the daemon reporting a fact about the agent: the queue is on the snapshot, it
 * survives closing the tab, and the line goes away when the message is handed
 * over. The bubble itself is the same bubble, undimmed and unmarked.
 */
function PromptRow({
  seq,
  event,
  files,
}: {
  seq: number;
  event: PromptEvent;
  files: FileAccess | null;
}): ReactNode {
  const waiting = useContext(QueuedContext).has(seq);
  return (
    <>
      <UserBubble
        text={event.text}
        // `?? []` is the whole fail-open story: a daemon that predates
        // attachments sends no such field, and its prompts render exactly as
        // they always did rather than as ones with a broken chip.
        attachments={event.attachments ?? []}
        files={files}
      />
      {waiting && (
        /*
         * `-mt-3` against the bubble's own `my-4`: this belongs to the message
         * above it, so it sits closer to that than the 16px a turn boundary gets,
         * and the wrapper keeps the boundary's spacing below itself. Right, under
         * the bubble it is about, at the transcript's machinery tone — this is
         * the daemon's bookkeeping and not a second thing the person said.
         */
        <p className="-mt-3 mb-4 flex items-center justify-end gap-2 text-2xs text-faint">
          <Dot tone="pending" />
          Waiting for the agent to finish
        </p>
      )}
    </>
  );
}

/**
 * One coalesced run of agent or user text.
 *
 * Rendered as markdown, which is what it always was — the agent writes markdown
 * and this used to show the source. `Markdown` is memoised on the joined string,
 * so a streaming run reparses once per arriving chunk and not once per rendered
 * row.
 */
function TextRun({ thought, role, text }: { role: string; thought: boolean; text: string }): ReactNode {
  if (text.trim().length === 0) return null;
  /*
   * Unreachable, and kept as a refusal rather than deleted.
   *
   * `showsInTranscript` drops thoughts before a node is ever made, so nothing
   * arrives here with this set — `buildTail` only ever builds a run from an
   * event it kept, which for `text` means `thought === false`, so the field on
   * a node is now a constant.
   *
   * What keeps the speech either side of a dropped reasoning block in two runs
   * is therefore **not** this field's place in the coalescing key, which is now
   * a tautology: it is the explicit `flush()` on the dropped thought in
   * `buildTail`. Do not delete that flush on the strength of the key.
   *
   * The guard stays as a refusal rather than a mechanism, so a reader finding
   * `thought` on the node type does not reasonably add a branch back. If
   * thoughts are ever wanted again, the decision is one line in
   * `showsInTranscript` and a card to design here, not this.
   */
  if (thought) return null;
  // An agent-echoed user message gets the same bubble as a `prompt` event, so the
  // same sentence looks the same however it reached the transcript.
  if (role === "user") return <UserBubble text={text} />;
  return <Markdown text={text} />;
}

/**
 * Everything drawn one-for-one from a single event.
 *
 * `tool_call`, `tool_call_update` and `file_change` are deliberately absent: those
 * three are the ones with a cross-event rule, and that rule lives in `tail.ts`
 * where `webcheck` can reach it. `file_change` is the newest of them — it used to
 * be drawn here as a path and a download button, which is all a row can say
 * without knowing whether the call that made the change is on screen. `ChangeRow`
 * draws the ones that are on their own; the rest are inside their card.
 *
 * `status` and `workspace` are absent for a different reason — nothing ever
 * reaches here holding one, because `showsInTranscript` refuses them. Both were
 * drawn twice and the surviving copy is the one always on screen: for `status`,
 * the header's `StatusDot` and `ExitNotice`. For `workspace` it was the header's
 * own line *and* a `WorkspaceWarnings` banner; the banner has been deleted, so
 * the header's mode-and-branch line is all that is left and the **warnings on
 * that event are now drawn nowhere**. `tail.ts` says the same thing at the set
 * itself, because that is where somebody would go to undo it.
 */
function renderEvent(node: EventNode, files: FileAccess | null): ReactNode {
  const stored = node.stored;
  const event: SessionEvent = stored.event;

  switch (event.type) {
    case "prompt":
      return <PromptRow seq={stored.seq} event={event} files={files} />;

    /*
     * Only the requests nothing ever answered reach here — `tail.ts` merges the
     * rest into their own `permission_resolved`, which carries the same title
     * plus the outcome. A daemon restart with an approval in flight is what is
     * left, and this row is its only trace.
     *
     * `decision` is non-null for exactly one shape: a bare `Session` answering
     * inline with no remote client attached. Through the daemon it stays null for
     * the request's whole life, which is why the merge upstream keys on whether a
     * resolution exists rather than on this field.
     */
    case "permission_request":
      return (
        <p className="flex items-center gap-2 px-1 py-1 text-xs font-medium text-fg">
          <span className="shrink-0">
            <Icon as={AlertTriangle} size={12} />
          </span>
          <span className="inline-flex w-3 shrink-0" aria-hidden={true} />
          <span className="min-w-0 flex-1 truncate">
            asked: {node.heading ?? event.title}
          </span>
          {event.decision !== null && " (answered)"}
        </p>
      );

    /*
     * The verdict, and **not** `outcome`.
     *
     * `outcome: "selected"` means an option was chosen, which includes every
     * `reject_*` one — so keying the icon on it drew a check mark against a
     * refused command, and since `tail.ts` now merges the request row away this
     * is the only surviving record of the answer. `permissionDecisions` does the
     * join the resolution cannot do alone; an unknown option is drawn as neither
     * an approval nor a refusal rather than guessed at.
     */
    case "permission_resolved":
      return <PermissionResolvedRow event={event} heading={node.heading} />;

    /*
     * A question the agent asked, and nothing ever answered.
     *
     * Only reachable after a restart took the parked promise with it — the same
     * exception the unanswered `permission_request` row above is for. A settled
     * one is merged away by `tail.ts` and speaks through the pair below instead.
     */
    case "elicitation_request":
      return (
        <p className="flex items-start gap-1.5 text-xs font-medium text-fg">
          <Icon as={AlertTriangle} size={12} className="mt-0.5" />
          <span className="min-w-0 wrap-anywhere">asked: {event.message}</span>
        </p>
      );

    /*
     * The question and its answer, drawn as the exchange it is.
     *
     * Unlike an approval — which is bookkeeping about a tool — a question and its
     * answer *are* the conversation, and the answer entered the model's context.
     * So it gets the shape a conversation has: the agent's line, then yours in
     * the same `Bubble` every other message you sent uses.
     *
     * No join back to the request: the daemon renders the answer into pairs on
     * the resolution itself, which is the one place the permission pair above is
     * deliberately not copied.
     */
    case "elicitation_resolved":
      return <ElicitationResolvedRow event={event} asked={node.asked} />;

    case "plan":
      return (
        // Same ground as a tool card, and the border goes for the same reason
        // that one's did: with the pane on `surface` the tonal step says "this is
        // a thing" by itself, and two card species in one transcript is how they
        // drift apart.
        <div className="rounded-lg bg-raised/50 px-3 py-2">
          {event.entries.map((entry, index) => (
            <div key={index} className="flex items-start gap-1.5 text-xs wrap-anywhere">
              <span className={`mt-0.5 ${entry.status === "completed" ? "text-fg" : "text-faint"}`}>
                <Icon as={entry.status === "completed" ? Check : ChevronRight} size={11} />
              </span>
              {/* Markdown, because a plan entry is prose the agent wrote and
                  routinely names a file in backticks. `line-through` has to sit
                  on the wrapper rather than inside the markdown, which renders
                  its own block elements. */}
              <span
                className={`min-w-0 ${entry.status === "completed" ? "text-faint line-through" : ""}`}
              >
                <Markdown text={entry.content} tone="dim" />
              </span>
            </div>
          ))}
        </div>
      );

    case "turn_end":
      /*
       * Only reached for a stop reason that is **not** `end_turn` — see
       * `showsInTranscript`. Every one of those is a turn that stopped without
       * finishing, which is a different fact from a reply ending.
       *
       * **A cancel is drawn where `working…` was, and nothing else is.** This
       * row read `— turn ended: cancelled —`, centred between two em dashes: the
       * daemon's own enum, framed as a chapter break, for the one thing on this
       * screen somebody actually *did*. And a cancelled turn's `turn_end` is its
       * last event, so it lands in exactly the row `WaitingFoot` occupied the
       * instant before — which is where the reader is already looking, and the
       * reason it takes that row's shape rather than a divider's: the same 20px
       * line, the same mark, the same gap, one word.
       *
       * The mark is `still`, and that is the whole of the state change: three
       * bars breathing means work is happening, three bars at rest beside a red
       * word means it stopped. `text-danger` on text rather than a fill is what
       * `index.css` allows and what the `error` row below already spends.
       *
       * Every *other* reason stays a centred line, because none of them is
       * something the reader did and none of them replaces an indicator that was
       * just there — the agent ran out of room, hit its step limit or declined,
       * and that is news about the agent.
       */
      return event.stopReason === "cancelled" ? (
        <p className="flex h-5 items-center gap-2 text-2xs font-medium text-danger">
          <WorkingMark still />
          {stopReasonText(event.stopReason)}
        </p>
      ) : (
        <p className="text-center text-2xs font-medium text-fg">
          — {stopReasonText(event.stopReason)} —
        </p>
      );

    /*
     * The same shape the `update` arm above draws, and for the same reason.
     *
     * It was a bare `text-xs text-danger` paragraph with a lowercase `error:`
     * prefix and no glyph — which put a daemon failure *below* `GapMarker`, a note
     * about evicted history, in visual weight: that one carries `AlertTriangle`,
     * `font-medium`, full `fg` and centring. The thing that went wrong read quieter
     * than the bookkeeping about it.
     *
     * The `X` rather than `AlertTriangle`: this transcript has two failure rows and
     * they should be one shape, and the triangle is already spoken for twice (an
     * unanswered request, and history that is gone). A glyph is a *shape*
     * difference, which is the strongest cue this palette has left at 13px — and
     * the reason it is not carrying the row alone is that `text-danger` is still
     * here beside it.
     */
    case "error":
      return (
        <p className="flex items-start gap-1.5 text-xs text-danger">
          <Icon as={X} size={11} className="mt-0.5" />
          <span className="min-w-0 wrap-anywhere">{event.message}</span>
        </p>
      );

    /*
     * The whole of what a `/clear` leaves behind: the command, then the boundary.
     *
     * ⚠ **The sentence here used to read "the agent has forgotten everything
     * above", and it described rows that are not drawn.** `buildTail` cuts at this
     * marker, so there is nothing above it — and with the reveal control deleted
     * there is no longer any state in which there could be. A line describing an
     * absent half of the screen is worse than no line.
     *
     * **The command is drawn from the marker, and that is exact rather than
     * invented.** `server.ts` carries out `/clear` only on the trimmed string
     * matching exactly and only with no attachments, `ManagedSession.clearContext`
     * is the one thing that appends a `context_cleared`, and the `prompt` it wrote
     * an instant earlier is by construction one seq below the cut. So this marker
     * *is* that message, and the `UserBubble` here is the row the reader sent —
     * the same component, in the same place, as if the cut had spared it.
     *
     * The rule stays quiet: a hairline each side of a `text-2xs text-faint` word.
     */
    case "context_cleared":
      return (
        <>
          <UserBubble text="/clear" />
          <div className="my-1 flex items-center gap-2">
            <span className="h-px flex-1 bg-edge" />
            <span className="shrink-0 text-2xs text-faint">Context cleared</span>
            <span className="h-px flex-1 bg-edge" />
          </div>
        </>
      );

    default:
      // An event type from a newer daemon. Silence beats a crash; `wire.ts` is a
      // mirror and is allowed to be behind. This is also where anything
      // `showsInTranscript` refuses would land if the two ever disagreed — the
      // `session_started`/`agent_log`/`other` arms that used to be written out
      // here were dead the day `tail.ts` started filtering them.
      return null;
  }
}

/**
 * A run of tool calls, as one line that says what the run did.
 *
 * The transcript's question is *does anything anywhere need me*, and a turn's worth
 * of machinery is not an answer to it. So a run collapses to a sentence built in
 * `tail.ts` — mechanically, because the words a model writes about its own work
 * reach us on 13 of 1132 updates — and opens to exactly the rows it replaced.
 *
 * **A run always starts collapsed, whatever it is doing, and a tap outranks that for
 * good.** `override` is still three-valued and the reason is unchanged — a
 * two-valued flag would make "I closed this" and "nobody has looked" one thing — but
 * the derivation underneath it is now a constant.
 *
 * ⚠ **It used to be `node.live`, so the newest run drew *expanded* until the agent
 * stopped calling tools.** Reported as: the last group opens by itself and only
 * closes when the next block of text arrives. That is the same event seen from
 * outside — a growing run keeps re-entering `live`, so it settled exactly when the
 * agent moved from calling tools to writing about them. It was deliberate once, on
 * the argument that the live run *is* what is happening now; what it cost is that
 * the machinery a reader had asked to be folded away unfolded itself on every turn,
 * and the one row whose height nobody chose was the one at the bottom of the page.
 *
 * `node.live` is **kept and spent on the collapsed row instead** — the hollow pulse
 * this app already means "in flight, nobody is deciding anything" by. Without that
 * the field would have three green assertions in `webcheck` and no consumer, which
 * is the `sessionOf` failure: a property the code appears to have and nothing
 * enforces. A run of one is never wrapped, so a lone call keeps its own spinning
 * `Loader`; only a run of two or more was ever relying on being open to say so.
 *
 * ⚠ **A failure used to open it too, and that was a bug rather than a kindness.**
 * `override` lives in component state, so it is gone on reload — and `failed > 0` is
 * a property of the *finished* run, so a group somebody deliberately collapsed came
 * back open on every refresh, for ever, with nothing they could do about it.
 * Reported from a real session. The count was never the thing that needed opening:
 * `1 failed` is on the collapsed row already, which is the same "the number survives
 * collapse" idiom as a folder's waiting count and a card's step badge. A bare
 * `ToolCall` still opens itself on failure, and the difference is exactly that — it
 * has no count of its own to say so. ⚠ **That clause read "no badge" until the
 * count stopped being one**: the run's own `1 failed` is a bare `text-muted` run
 * of text now (the fill was `UserBubble`'s, and it read as one), and the property
 * this paragraph rests on is that the collapsed row *says* how many — never what
 * shape the saying takes.
 *
 * The re-measure stays an **effect on `open`** rather than moving into the click
 * handler like `ToolCall`'s, and the reason it used to give is gone: the height no
 * longer changes for two reasons, because a run cannot fold itself any more. It is
 * kept because the effect is honest in both directions and costs a ref — and
 * because `open` is state a tap sets, so measuring after the render that acts on it
 * is the correct order, where the handler measures the layout it is about to
 * replace.
 *
 * **The two costs of the automatic fold are gone with it.** A reader who scrolled
 * into a live run to read a step's output no longer loses it when the last call
 * completes, and a call finishing after a message has landed below it no longer
 * collapses a run further up the page. What replaces them is one much smaller cost,
 * named here so it is a decision rather than an oversight: the work a run is doing
 * is no longer readable without a tap, and the pulse on the row is the whole of what
 * says there is something to tap.
 */
function GroupRow({ node, files }: { node: GroupNode; files: FileAccess | null }): ReactNode {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? false;
  const onResized = useContext(ResizedContext);
  const drawn = useRef(open);
  useEffect(() => {
    if (drawn.current === open) return;
    drawn.current = open;
    onResized();
  }, [open, onResized]);

  return (
    <div>
      {/*
       * A bare row, not a card. There are exactly two card fills in this transcript
       * — machinery and the message you wrote — and a summary of machinery is
       * neither: it is a heading for the rows underneath it, which is why the caret
       * sits against the text the way a folder's does in the rail rather than at the
       * far edge like a card's chevron.
       */}
      {/*
        **44px, and the box grows rather than a target — which is the opposite of
        what the composer's strip does, for a reason that is about neighbours.**

        A run starts collapsed now, so this row is the *only* way to see what the
        agent did, and it was 26px: `text-xs` on `py-1`. The alternative is
        `TAP_GROW_Y`, and it is wrong here in the way `ICON_BUTTON_SIZE.sm`'s note
        describes — these rows are full-width and stacked `space-y-1.5` apart, so a
        target grown 9px each way covers 6px of the row above's *face*, and the row
        above is another disclosure. There is no free direction: a taller box is the
        honest form, and it is what `ChangeRow` reached for one component down.

        The cost is real and is the trade: 18px a row, so an open run of eight calls
        is a screen-and-a-bit rather than two thirds of one. What buys it back is
        that those eight rows are the only record of what the agent did, and until
        this they were 26px of machinery nobody could reliably hit.
      */}
      <button
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        className="tap flex min-h-11 w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs text-fg/85 hover:bg-raised hover:text-fg"
      >
        <span className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>
          <Icon as={ChevronRight} size={13} />
        </span>
        {/* One value for every machinery row in the transcript — see `ToolCall`'s note
            on why a failure no longer takes weight here. The count beside it is what
            says a failure happened, and it survives the collapse. */}
        <span className="min-w-0 flex-1 truncate">{runSummary(node.tally)}</span>
        {/* Survives collapse, like a folder's waiting count and a card's step badge:
            what the run did to the files is the whole reason to open it. */}
        <ChangeCounts events={node.tally.changes} />
        {/* ⚠ **`N approved` was here and is in the body now, and the reason is
            width.** Measured at 390px: the row's five trailing elements — the
            counts, this, the failed badge and the live dot — come to about 215px
            of a 358px column, leaving ~20 characters of `runSummary`. The summary
            is the only part of this row written for a human and the only part that
            shrinks, so the row was spending its width on numbers and clipping the
            sentence that says what the run did.

            This one went rather than the others because of what its own note
            already said about it: it says you were asked and you answered, "which
            is not a thing that needs anybody's attention again". `N failed` and the
            counts are unresolved facts; this is a settled one — and the ranking
            survives the badge that used to carry it, `text-muted` against this
            line's `text-faint`. "An approval cannot
            be hidden" is untouched — that property rests on `tail.ts` refusing to
            fold a *refusal* at all, which is the asymmetry that carries it, and the
            count is still on screen the moment the run is open. */}
        {/* ⚠ **Not a `Badge`, and that was the last thing on this row still
            arguing with the paragraph below it.** `Badge`'s plain tone is
            `bg-raised` — the token `UserBubble` paints, at the same strength, on
            the same `bg-surface` pane — so a count on a machinery row was drawn
            in the fill reserved for the message somebody wrote, three inches
            under one. Reported as *it blends with the message*, which is
            literally what it was: the bubble's own rectangle, shrunk.
            `ToolCall`'s frame note below already says machinery is unfilled and
            that what a failure keeps is "two signals, neither of them a
            rectangle"; this was the rectangle, and it survived the pass that took
            the border off this row and the semibold off its title.

            `text-muted` rather than the row's own `text-fg/85`, because the ask
            was for something quieter — and rather than `text-faint`, which is
            `N approved`'s tone one fold down and is spent on a *settled* fact.
            The ranking Q3.106 records is the thing that may not invert: a
            failure outranks an approval, and it still does. */}
        {node.failed > 0 && (
          <span className="shrink-0 text-2xs text-muted">{node.failed} failed</span>
        )}
        {/* What the run being open used to say, now that it never is. The hollow
            pulse rather than `WorkingMark`'s blink, deliberately: the loud one is
            reserved for a turn actually running, and a run of tool calls inside one
            is not a second claim on the reader's attention. It sits at the trailing
            edge with the counts, so the summary — the `flex-1` sibling — absorbs its
            arrival and the row's leading edge does not move. */}
        {node.live && (
          <span className="shrink-0">
            <Dot tone="pending" />
          </span>
        )}
      </button>

      {/* The same well a subagent's steps hang in, minus its fill: that `bg-surface`
          is there to give a nested card an edge *inside* another card, and this well
          is already on the pane. `space-y-1.5` is the transcript's own rhythm, so a
          row inside a group looks like a row. */}
      {open && (
        <div className="mt-1 ml-3 space-y-1.5 border-l-2 border-edge pl-2">
          {/* The count the collapsed row gave up, at the head of what it is about.
              Same `text-2xs text-faint` it wore up there, and the same words — it
              moved rather than changed, so somebody who remembers the number
              finds the same sentence one tap away. */}
          {node.approved > 0 && (
            <p className="px-1 text-2xs text-faint">
              {node.approved} approved
            </p>
          )}
          {node.children.map((child) => (
            <TailRow key={child.key} node={child} files={files} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A file the agent changed, whose own tool call is not on screen.
 *
 * The change a card *can* draw is drawn inside it, so this is the leftover: a call
 * below the cut, or kimi's `fs_write` channel, which names no call at all. It was
 * the only rendering a `file_change` had — a path and a download button — and the
 * counts and the diff are what it was missing.
 *
 * The row is not itself the button, because the download control is one and a
 * button inside a button is not a thing a browser will draw.
 */
function ChangeRow({ node, files }: { node: ChangeNode; files: FileAccess | null }): ReactNode {
  const [open, setOpen] = useState(false);
  const onResized = useContext(ResizedContext);
  const event = node.event;
  // Absolute, because the agent chose it. The route takes a workspace-relative
  // path, and anything outside gets no button at all.
  const rel = files?.relFor(event.path) ?? null;

  return (
    /* The same `border-l-2 border-edge` a permission's answer takes, and the whole
       argument is written there: a file change is not a call the agent made, it is
       something that happened to a file, and the nesting rule is the axis left once
       a tone and a box are both refused. The diff below sits inside the rule too,
       which is right — it is the same fact, opened. */
    <div className="ml-3 border-l-2 border-edge pl-2">
      <div className="flex items-center gap-1.5 font-mono text-2xs text-muted">
        <button
          onClick={() => {
            setOpen(!open);
            onResized();
          }}
          aria-expanded={open}
          /* `py-3` takes an 18px row to 42px, and the 6px the row already sits in
             covers the rest. It was the line-height of `text-2xs` and nothing else
             — 18px, six pixels from `DownloadButton`'s 15px, which is verbatim the
             geometry `ICON_BUTTON_SIZE.sm` calls "the classic mis-tap pair": you
             aim at Download and expand a diff, or aim at the expander and fire a
             request. Padding rather than `TAP_GROW_Y` here because this button is
             the `flex-1` half of the row and has a neighbour on one side only, so
             there is nothing for a grown target to overlap. */
          className="tap flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-3 text-left hover:text-fg"
        >
          <span className="shrink-0 text-faint">
            <Icon as={open ? ChevronDown : ChevronRight} size={11} />
          </span>
          <span className="shrink-0 text-faint">
            <Icon as={event.oldText === null ? FilePlus2 : FilePen} size={11} />
          </span>
          {/* **The workspace-relative path, which was computed one line up and
              thrown away.** `truncate` clips the *tail*, and every session runs in
              a worktree under `~/.reemoat/worktrees/…` — 32 characters of prefix
              identical on every row — so at this row's ~35-character budget the
              reader got `/Users/…/.reemoat/worktrees/s_c` and none of the filename.
              The discriminating bytes of a path are at the end, which is the one
              data type `truncate` must not be pointed at.

              `rel ?? event.path` degrades exactly right: `relativeTo` answers
              `null` outside the workspace, and that is the single case where the
              absolute prefix is carrying information rather than repeating
              itself. */}
          <span className="min-w-0 flex-1 truncate">{rel ?? event.path}</span>
          <ChangeCounts events={[event]} />
        </button>
        {rel !== null && files !== null && (
          <DownloadButton
            label={`Download ${rel}`}
            run={() => files.download(rel, filenameFor(rel) ?? rel)}
          />
        )}
      </div>
      {open && (
        <div className="mt-1">
          <DiffView change={event} />
        </div>
      )}
    </div>
  );
}

/**
 * ACP's tool kinds, given a glyph each.
 *
 * `ToolKind` is an **open** union — the SDK's own type ends in `| string` and an
 * agent may send a kind nobody has heard of — so this is a lookup with a
 * fallback, never a `Record<ToolKind, …>` that would stop compiling the day an
 * agent invents one.
 */
const KIND_ICON: Record<string, ComponentType<{ size?: number | string; className?: string }>> = {
  read: Search,
  edit: Pencil,
  delete: Trash2,
  move: FilePen,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe,
  switch_mode: Wrench,
  other: Wrench,
};

/**
 * One tool call, and the steps it started.
 *
 * **A subagent is a call that has children, or one the agent said was a spawn**
 * — and never `kind === "think"`, never a title match. Children remain what the
 * *layout* is built from (the nesting, the step badge, the running headline);
 * the declared flag exists so that the icon does not have to wait for a step
 * that may never arrive.
 *
 * That second half is a correction. The rule was children only, on the argument
 * that it degrades correctly on an agent that says nothing — which it does, and
 * which the flag does not weaken, since absence still means children decide. But
 * "no step ever arrives" is not a rare case: measured 2026-08-01, three
 * delegations of the same trivial task rendered as **two robots and one brain**,
 * because the one whose subagent answered from the model alone made no tool call
 * to attribute, fell through to `KIND_ICON`, and claude's spawn is
 * `kind: "think"`. So the icon said "thinking" for the same act that had twice
 * said "delegating", and the same glyph is already spoken for by thinking text a
 * few rows above.
 *
 * The flickering the old rule was avoiding is real and is avoided elsewhere:
 * claude drops `subagent` on the spawn's own completing update, so `tail.ts`
 * reads it from the `tool_call` and never merges it. See `ToolNode.subagent`.
 *
 * The visible cost is now the other way round and smaller: a spawn draws the
 * robot immediately and grows a step badge when its first step lands, rather
 * than changing glyph underneath the reader.
 */
function ToolCall({ node, files }: { node: ToolNode; files: FileAccess | null }): ReactNode {
  const { title, toolKind: kind, status, rawInput, locations, output, images, children } = node;
  // A failure is the one case somebody is going to open anyway, so it opens
  // itself. Everything else stays shut: a transcript of expanded JSON blobs is
  // the thing the render bound in this file exists to prevent.
  const [open, setOpen] = useState(status === "failed");
  // Opening this card is the reader saying "I want to look at *this*". The
  // transcript re-measures on the next frame, so following the tail cannot scroll
  // away the thing they just opened — see `SessionView`'s `remeasure`.
  const onResized = useContext(ResizedContext);
  // The relativiser reaches the *path* arms only — see `toolSummary`, which refuses
  // to touch a command. Without it this row drew the workspace prefix on every line
  // and truncated away the filename, which is the half that identifies anything.
  const { summary, detail } = toolSummary(rawInput, locations, (path) => files?.relFor(path) ?? null);
  const isSubagent = node.subagent || node.steps > 0;
  const headline = isSubagent
    ? node.elapsedMs !== null
      ? shortDuration(node.elapsedMs)
      : // `?? summary` for the case the flag opened up: a declared spawn with no
        // step to name yet, which under the children-only rule could not exist.
        (node.latest ?? summary)
    : summary;
  // Four things can be inside, and the fourth — the arguments — only counts when
  // it is not the string this row is already drawing in full. See
  // `opensToAnything`, which is that rule somewhere `webcheck` can reach it.
  // Clipped here rather than by `truncate`, so "was anything cut off" is a question
  // the card can answer — see `TITLE_CHARS`. A short title is untouched.
  const shownTitle = clipTitle(title);
  const expandable = opensToAnything({
    detail,
    headline,
    outputBlocks: output?.length ?? 0,
    locations: locations.length,
    children: children.length,
    changes: node.changes.length,
    titleClipped: shownTitle.clipped,
  });
  /*
   * ⚠ **A backgrounded call reads `completed` and is not**, which is the one
   * place this card may not believe the status it was sent.
   *
   * A Bash call that detaches returns the instant the command is handed off, so
   * the update carrying `completed` is about the *handoff* — and ACP has no
   * tool-call status for "still running elsewhere", which is exactly why the
   * agent marks the update instead. Drawing the tick there is the lie this whole
   * feature exists to stop: the card said the build was done while it was still
   * compiling, and the transcript below it said nothing at all.
   *
   * `failed` still outranks it. A detach that then failed is a failure, and the
   * marker is about where the work went rather than about how it ended.
   *
   * ⚠ **And the log is only half the answer: the snapshot decides whether the
   * work is still going.** `backgrounded` is sticky by design — see
   * `ToolNode.backgrounded`, where never resetting it is the whole point — so on
   * its own it says *this call detached*, which stays true for ever, and a row
   * keyed on it alone would read `Running in the background` for the rest of the
   * tab's life. The daemon carries `toolCallId` on every background task for this
   * join; `TasksContext` is that index, and `taskFinished` is asked here so the
   * card and the panel read one rule out of one function.
   *
   * ⚠ **No matching row means NOT running, and that is a decision rather than a
   * fallback.** The two absences are one answer on purpose: after a daemon
   * restart the task set is empty (it is in memory), so every historically
   * backgrounded card in a replayed transcript would otherwise claim live work on
   * a conversation from last week, with no panel row and nothing that could ever
   * clear it. It is also the only *defensible* answer — the marker rides the
   * `jetbrains.air` extension and the adapter sends it only to a client that
   * declared `asyncTasks`, precisely because without the lifecycle behind it the
   * flag promises a card state nothing can resolve. So the pairing is by
   * construction, and a card with no row behind it is a card that has not been
   * told, which is not the same as a card that knows.
   *
   * The cost, stated: between the detaching update arriving on the socket and the
   * snapshot that carries the new task row, the card shows the tick it was sent.
   * That window is one push — `applyBackgroundTasks` touches the session, so a
   * spawn is fanned out at once — and it errs in the recoverable direction: a card
   * that says done and then says running is a correction, while one that says
   * running for ever is the defect.
   */
  const backgroundState = useContext(TasksContext).get(node.toolCallId);
  const running =
    node.backgrounded &&
    status === "completed" &&
    backgroundState !== undefined &&
    !taskFinished(backgroundState);
  const tone =
    status === "failed" ? "text-fg" : status === "completed" && !running ? "text-muted" : "text-fg";

  return (
    /*
     * **A tool call has no frame at all, and that reverses two earlier decisions in
     * one line.**
     *
     * The first took the *border* off ("twenty bordered boxes read as twenty things
     * demanding to be looked at") and kept a tonal step instead: `bg-raised/50`, the
     * quiet grade of the transcript's two. The step was doing the same job the border
     * had — saying "this is a thing" — and it turns out the transcript has something
     * better to say it with, which is where the row sits and what it says.
     *
     * What forced it: a folded run is a bare row, and a run of one is not wrapped, so
     * one screen showed **two foldables side by side, one framed and one not**. Two
     * shapes for one idea, and the difference between them said nothing — it was
     * arity. Reported from a real session.
     *
     * So machinery is unfilled and the two filled things left in the transcript are
     * the ones worth filling: **the message you wrote** (`bg-raised`) and **a plan**
     * (`bg-raised/50`). What was two grades of one grey for "yours is louder than the
     * agent's" is now fill-versus-no-fill, which is a bigger step in the same
     * direction.
     *
     * **Failure loses its box, and then its weight as well.** `border border-edge-strong`
     * around an otherwise frameless row would be the same inconsistency one size down,
     * so it went first. A semibold title replaced it — and that made the loudest text in
     * the transcript the row a reader is least likely to need, since a folded run
     * carrying one failed call was bold above the prose it exists to recede behind.
     * Reported that way. What is left is the `X` at full `fg` (`tone`) and `N failed` on
     * the run's own row: two signals, neither of them a rectangle and neither of them
     * louder than the conversation.
     *
     * The expanded body hangs off `border-l-2 border-edge`, which is the one nesting
     * idiom this app has: a subagent's steps, a group's children, and now a card's own
     * detail all read as "this belongs to the row above it".
     */
    <div>
      {/*
        44px for `GroupRow`'s reason, and **unconditionally**, which is the part
        that is not obvious.

        Hanging it off `expandable` the way the hover fill above already hangs off
        it is the tempting shape — a row that cannot be pressed is not a tap target
        and could stay 26px. It is wrong because `expandable` *changes while the
        reader is looking at it*: a `tool_call` with no output yet is not
        expandable, and the `tool_call_update` carrying the output makes it so. That
        would grow the row 18px mid-turn and push everything below it down — the same
        complaint the automatic fold above was removed for, which is a row choosing
        its own height while somebody is reading past it. A row that cannot be
        pressed costs 18px of ground; a row that resizes under a travelling thumb
        costs the reader their place.
      */}
      <button
        onClick={() => {
          setOpen(!open);
          onResized();
        }}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        className={`tap flex min-h-11 w-full items-center gap-2 rounded-md px-1 py-1 text-left text-fg/85 ${
          expandable ? "hover:bg-raised hover:text-fg" : ""
        }`}
      >
        <span className={`shrink-0 ${tone}`}>
          <Icon
            as={
              status === "failed"
                ? X
                : running
                  ? Terminal
                  : status === "completed"
                    ? Check
                    : status === "in_progress"
                      ? Loader
                      : Download
            }
            size={12}
            /* Deliberately not spun. `Mark.tsx`'s own rule: one thing in this
               transcript may say "right now" and it is the working mark — a
               second spinner over work nobody is waiting a turn for reads as a
               stall in the conversation, which it is not. */
            className={status === "in_progress" ? "animate-spin" : ""}
          />
        </span>
        {/* One step brighter than an ordinary kind glyph, and chosen outside
            `KIND_ICON` — that lookup is over ACP kinds and must stay one. `Bot`
            and not `Brain`: `Brain` is `KIND_ICON.think`, i.e. the glyph for a
            call the agent itself declared as thinking, and reusing it here would
            say the wrong thing about delegation. (It used to also be the thinking
            *card*'s glyph; that card is gone, but the collision that matters —
            with the ACP kind — is not.) Keyed on `isSubagent`, so
            every delegation is this glyph whether or not it took a step. */}
        <span className={`shrink-0 ${isSubagent ? "text-muted" : "text-faint"}`}>
          <Icon as={isSubagent ? Bot : (KIND_ICON[kind] ?? Wrench)} size={12} />
        </span>
        {/* Semibold on failure, which is what the box used to do. Same substitution a
            blocked row in the rail makes, and the one the palette's own note calls the
            replacement for a colour it does not have. */}
        {/*
          * `text-fg/85` on the button, so it reaches the title and `hover:` can lift it.
          *
          * Machinery sat at the same value as the agent's prose and read as part of it.
          * Measured, 10.99:1 on the pane against prose's 17.37 and `muted`'s 7.75 — a
          * step between the two, which is what "dimmer but not a caption" means.
          *
          * **One value for every machinery row, failures included.** A failed title was
          * full `fg` plus semibold and a folded run's summary was too, which put the
          * loudest text in the transcript on the row a reader is least likely to need —
          * `> Read SKILL.md, ran 2 commands, searched` in bold, above the prose it was
          * meant to recede behind. What carries a failure instead is the `X`, drawn at
          * full `fg` by `tone`, and `N failed` on the run's own row.
          */}
        <span className="min-w-0 flex-1 truncate text-xs">
          {shownTitle.text}
          {/* The command, on the row, without opening anything. A claude row read
              "Bash" and nothing else — what it was actually running was invisible
              until you tapped it, on the one screen whose whole job is telling you
              what the agent is doing. Truncated hard: a 4000-character command
              must stay one line inside this file's render bound. */}
          {/* For a subagent the slot carries its newest step while it runs, and
              how long it took once it stopped. That is the live status line at
              one row of height instead of forty — and because it replaces text
              rather than adding a line, it cannot change the card's height and
              move the page under a travelling thumb. */}
          {/* Not when it *is* the title. Measured 2026-08-13 in the log: codex
              names a `Bash` call after the command it runs, so `title` and
              `summary` are the same 82 characters and the row drew them twice in
              a row — `node …/fetch-codex-manual.mjs node …/fetch-codex-manual.mjs`.
              An exact comparison, because that is the only case where the second
              copy is certainly worth nothing. */}
          {headlineWorthDrawing(title, headline) && (
            <span className="ml-1.5 font-mono text-2xs text-faint">
              {headline !== null && headline.length > SUMMARY_CHARS
                ? `${headline.slice(0, SUMMARY_CHARS)}…`
                : headline}
            </span>
          )}
        </span>
        {/* Claude Code's own sentence, verbatim, in prose rather than mono: it is
            a state and not a command. Its `(↓ to manage)` becomes nothing here —
            a key chord is not a thing on a phone, and the panel it points at is
            reached from the foot of this same transcript, one tap away and always
            on screen while anything is running.

            ⚠ **And it stays text rather than becoming the second way in**, which
            is not a preference: this whole row *is* the card's disclosure button,
            so a control here would be a `button` inside a `button` — invalid, and
            a tap target that resolves to whichever one the browser felt like. The
            foot row is the one control, which is also what keeps *this* row's tap
            doing what every other tool card's does. */}
        {running && <span className="shrink-0 text-2xs text-faint">Running in the background</span>}
        {/* Survives collapse, like a machine section's blocked count: the number
            is the whole reason to open this. Deliberately not a token count —
            claude reports one on the spawn's completing update, but only there,
            so a running card would have nothing to show and a finished one would
            change what it means. */}
        {/* `steps` and not `isSubagent`: a spawn recognised by its flag alone has
            nothing to count, and "0 steps" is worse than no badge — it asserts
            the delegate did nothing, when what is true is that nothing it did was
            attributed to it. */}
        {/* What the call did to the files, on the row, surviving collapse for the
            same reason the step badge does. A call in a folded run is one level
            down from a group row carrying the run's total; this one is its own. */}
        <ChangeCounts events={node.changes} />
        {node.steps > 0 && (
          <span className="shrink-0">
            <Badge>
              {node.steps} step{node.steps === 1 ? "" : "s"}
            </Badge>
          </span>
        )}
        {expandable && (
          <span className="shrink-0 text-faint">
            <Icon as={open ? ChevronDown : ChevronRight} size={13} />
          </span>
        )}
      </button>

      {/*
       * Outside the expander, deliberately.
       *
       * These were inside it, and that repeated the mistake the prose paths had:
       * a picture the agent handed back is **content**, not a detail of how the
       * tool ran. Nobody expands a `Read` card to find out what the agent saw —
       * measured on a real session, seven images sat behind a chevron nobody had
       * a reason to click.
       *
       * It also fixes a case the expander could not reach at all: a call whose
       * only payload is an image is not `expandable`, so the picture had no way
       * to be shown even by somebody who knew to look.
       */}
      {files !== null && images.length > 0 && (
        <div className="mt-1 ml-3 flex flex-wrap gap-2 border-l-2 border-edge py-1 pl-2">
          {images.map((image) =>
            previewable(image.mime, image.bytes) ? (
              <ImagePreview
                key={image.uploadId}
                cacheKey={`u:${image.uploadId}`}
                fetcher={() => files.fetchUpload(image.uploadId)}
                alt={image.name}
              />
            ) : (
              <button
                key={image.uploadId}
                type="button"
                onClick={() => void files.downloadUpload(image.uploadId, image.name)}
                className="tap flex items-center gap-1.5 rounded-md border border-edge px-2 py-1 font-mono text-2xs hover:border-edge-strong"
              >
                <Icon as={Download} size={11} />
                {image.name}
              </button>
            ),
          )}
        </div>
      )}

      {open && expandable && (
        <div className="mt-1 ml-3 space-y-1.5 border-l-2 border-edge py-1 pl-2">
          {/*
           * The rest of the title, and it is first because for the calls that reach
           * this arm the title *is* the payload: codex names a web search after every
           * query it ran and a `Bash` call after the command. Wrapped rather than
           * scrolled — this is prose the agent wrote, not code.
           */}
          {shownTitle.clipped && (
            <p className="text-xs text-fg/85 wrap-anywhere">{title}</p>
          )}
          {/*
           * First, ahead of the arguments: the change *is* the call. For an `Edit` or
           * a `Write` the arguments are not even drawn — `readInput` suppresses the
           * pretty-printed blob as soon as it finds a body field, which is why
           * `opensToAnything` had to learn about changes before this could be here at
           * all.
           *
           * `locations` below still lists the same file, with its line and its
           * download button, and that is not the "drawn twice" this file refuses
           * elsewhere: one is the diff's own heading and the other is the only
           * per-file download control the transcript has.
           */}
          {node.changes.length > 0 && (
            <div className="space-y-1.5">
              {node.changes.map((change, index) => (
                <DiffView
                  key={`${change.path}-${index}`}
                  change={change}
                  /*
                   * The hunk's new start, measured: a claude `Edit`'s own
                   * `locations[0].line` is `structuredPatch`'s `newStart`, and it is
                   * the only line-number signal that reaches this client.
                   *
                   * **Joined on the path, not `locations[0]`.** One call can carry
                   * several changes — a `MultiEdit` — and taking the first location
                   * for all of them numbered every diff from the first one's line,
                   * across different files. A location that names no change, or a
                   * change no location names, falls back to 1.
                   *
                   * **And trusted only where the change is a fragment**, which is
                   * the guard rather than the join. `DiffView`'s own note says the
                   * line is `structuredPatch`'s `newStart` for claude and is
                   * *unmeasured for codex*, which sends whole files on both sides —
                   * so if codex ever reports one, every number in the diff shifts by
                   * it, silently, with nothing on screen suggesting the numbering is
                   * wrong. A defect with no symptom is the category this repo builds
                   * drivers to prevent, and a comment cannot prevent the one it
                   * describes.
                   *
                   * `oldText === null` is a creation, which starts at line 1 by
                   * construction; anything else with no `oldText` to have been cut
                   * out of is not a fragment of a larger file. Both fall back to the
                   * 1 a whole-file change already gets today, so the guard can only
                   * ever return a number to where there was already a number.
                   */
                  startLine={
                    change.oldText === null
                      ? 1
                      : (locations.find((l) => l.path === change.path)?.line ?? 1)
                  }
                />
              ))}
            </div>
          )}

          {detailWorthDrawing(detail, headline) && (
            <pre className="max-h-64 overflow-auto rounded-md bg-raised/50 px-2 py-1.5 font-mono text-2xs leading-snug wrap-anywhere">
              {detail}
            </pre>
          )}

          {/* Every file the call touched. On the wire since the beginning,
              populated by the daemon, and drawn by nothing until now. */}
          {locations.length > 0 && (
            <ul className="font-mono text-2xs text-muted">
              {locations.map((location, index) => {
                const rel = files?.relFor(location.path) ?? null;
                return (
                  <li key={`${location.path}:${index}`} className="flex items-center gap-1.5">
                    {/* Relative, for `ChangeRow`'s reason and worse here: this list
                        is N rows whose only job is naming the files a call touched,
                        and at 43 characters every one of them truncated inside the
                        shared `~/.reemoat/worktrees/<session>/` prefix — N rows,
                        byte-identical, saying nothing. The line number is re-appended
                        rather than dropped, since `formatLocation` puts it at the
                        tail where the clip was landing. */}
                    <span className="min-w-0 flex-1 truncate">
                      {rel === null
                        ? formatLocation(location)
                        : formatLocation({ path: rel, line: location.line })}
                    </span>
                    {rel !== null && files !== null && (
                      <DownloadButton
                        label={`Download ${rel}`}
                        run={() => files.download(rel, filenameFor(rel) ?? rel)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* What the tool actually said. The daemon threw this away entirely
              until `tool_call_update` started carrying `content`, so a person
              could see what an agent ran and never what it got back.

              `raised/50` and not `ink/40`: this is a well *inside* the card, so
              it has to be a step below whatever the card is, and the card is
              `ink` now. Kept translucent so the card's own rounding shows through
              at the corners. */}
          {output !== null && output.length > 0 && (
            <pre className="max-h-64 overflow-auto rounded-md bg-raised px-2 py-1.5 font-mono text-2xs leading-snug whitespace-pre-wrap wrap-anywhere">
              {output.map(stripFence).join("\n")}
            </pre>
          )}

          {/* The steps, hanging off the card rather than sitting beside it —
              `border-l-2 border-edge` is lifted from `SessionBrowser`'s
              machine sections, the only other nesting in this app, so the two
              read as the same idea. `ml-3` because this one lives inside a card
              that already has `px-3`; `pl-2` and not `pl-1` because these
              children are bordered cards themselves and 4px between two borders
              reads as a rendering artefact. `space-y-1.5` is the transcript's
              own rhythm, so a step looks like a transcript row rather than a new
              species of thing.

              **`bg-surface` on this container is what gives a nested card a
              boundary at all.** A child step renders through the same `ToolCall`,
              so it carries the same fill as its parent — with a border on neither
              unless one has failed, that is 1.00:1 and no card edges anywhere.
              Painting the *well the children sit in* back to the pane's own tone
              restores the step for every one of them at once, without `ToolCall`
              having to know how deep it is: a nested card then has exactly the
              relationship to its ground that a top-level card has to the
              transcript. The `border-l` goes to full `edge` for the same reason —
              at 60% it was 1.13:1 and the rail this comment calls the whole idea
              was not visible. */}
          {children.length > 0 && (
            <div>
              <div className="space-y-1.5">
                {node.omitted > 0 && (
                  <p className="px-1 py-0.5 text-2xs text-faint">
                    {node.omitted} earlier step{node.omitted === 1 ? "" : "s"} not shown
                  </p>
                )}
                {children.map((child) => (
                  <TailRow key={child.key} node={child} files={files} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * History that is genuinely gone, and **only** that.
 *
 * Shown rather than smoothed over: a transcript that silently skips 80 events is
 * one a human will read as continuous. But the bar for drawing this is now high,
 * because for a long time it was drawn about something else entirely.
 *
 * `store.ts` used to *invent* a gap: re-attaching to a session the socket LRU had
 * dropped, with the daemon further ahead than the client keeps, it recorded the
 * difference as `reason: "evicted"` and this rendered "beyond retention".
 * Measured against the live database — a session reporting 3162 such events had
 * every one of them still on the daemon, whose own floor was thousands of seqs
 * below. Nothing had been evicted; the client had declined to fetch them and then
 * described its own decision as data loss, in the tone reserved for a conversation
 * that really does have a hole in it. That branch is gone: the events are paged
 * back in instead.
 *
 * So every gap here is now the daemon's own `lagged` frame, and both of its
 * reasons are real losses with different causes — which is why the text names the
 * cause rather than just the count. `evicted` means the daemon's 5000-event
 * retention destroyed them; `slow_consumer` means this client could not keep up
 * and the daemon dropped frames rather than buffer without bound.
 */
function GapMarker({ gap }: { gap: Gap }): ReactNode {
  const count = gap.to - gap.from + 1;
  return (
    <p className="flex items-center justify-center gap-1.5 py-1 text-center text-2xs font-medium text-fg">
      <Icon as={AlertTriangle} size={11} />
      {count} event{count === 1 ? "" : "s"}{" "}
      {gap.reason === "evicted"
        ? "dropped by the daemon — older than it keeps"
        : "dropped — this client could not keep up"}
    </p>
  );
}

/**
 * One download, with its own spinner.
 *
 * The busy state is here rather than on `FileAccess` because there can be many of
 * these on screen and only the one that was tapped should show anything. A
 * failure toasts the daemon's own message — this is the one place a `413
 * file_too_large` or a `404 not_a_regular_file` becomes readable.
 */
function DownloadButton({ label, run }: { label: string; run: () => Promise<void> }): ReactNode {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={(event) => {
        // Inside a `<p>`/`<li>` that may itself be inside an expander header.
        event.stopPropagation();
        setBusy(true);
        void run().finally(() => setBusy(false));
      }}
      /* 15px of ink, 44px of target **under a finger**. This is the smallest control
         in the app and it sits 6px from `ChangeRow`'s expander — the adjacency
         `ICON_BUTTON_SIZE.sm` names, and the one where the mis-tap *does* something
         rather than merely opening a card. `TAP_GROW_Y` is vertical only for its
         documented reason; `-right-2` is added because this is the last child of its
         row, so growing outward on that side lands in the row's own padding and
         overlaps nothing.

         ⚠ **Both are `[@media(pointer:coarse)]:`, so a mouse gets the 15px box.**
         That is the trade `bits.tsx` argues at the top: a pad extends `:hover` as
         far as it extends hit-testing, and there is no CSS that separates them.
         What it costs here is bounded by what the pad was over — nothing. The
         growth was vertical plus `-right-2`, and every direction it reached is row
         padding or an unclickable container, so the adjacency this note is about is
         the same 6px before and after. */
      className={`tap relative shrink-0 rounded p-0.5 text-faint [@media(pointer:coarse)]:after:-right-2 hover:text-fg disabled:opacity-50 ${TAP_GROW_Y}`}
    >
      <Icon as={busy ? Loader : Download} size={11} className={busy ? "animate-spin" : ""} />
    </button>
  );
}
