import { AlertTriangle, Bot, Brain, Check, ChevronDown, ChevronRight, ChevronUp, CircleSlash, Download, FilePen, FilePlus2, Globe, Loader, Minus, Pencil, Search, Terminal, Trash2, Wrench, X } from "lucide-react";
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
  PermissionOptionKind,
  PermissionResolvedEvent,
  ElicitationResolvedEvent,
  SessionEvent,
} from "../wire";
import type { PendingEcho } from "../echo";
import { UserBubble } from "./Bubble";
import { Markdown } from "./Markdown";
import { COLUMN, Dot, Empty, Icon, Badge, shortDuration, TAP_GROW_Y, TranscriptSkeleton } from "./bits";
import { WorkingMark } from "./Mark";
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
  type OutstandingTask,
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

export function EventList({
  transcript,
  onReveal,
  onResized,
  files,
  working,
  reporting,
  turnStartedAt,
  echo,
}: {
  transcript: Transcript;
  /** Show the conversation from before the last `/clear`, and go and fetch it. */
  onReveal: () => void;
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
   * `snapshot.turnStartedAt` — when the running turn began, or `null`.
   *
   * A number and not the snapshot, for `working`'s reason: the store replaces the
   * snapshot object wholesale every four seconds, so a reference here would be a
   * new prop identity on a timer. A primitive is stable when the value is.
   */
  turnStartedAt: number | null;
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
}): ReactNode {
  /*
   * The whole loaded transcript, cut only at the agent's own `/clear`.
   *
   * Still walked backwards, but no longer for cost: a `tool_call_update` has to
   * be collected before the `tool_call` it belongs to is reached, and the same
   * for a permission's resolution and its request.
   */
  const cut = transcript.clearedAt !== null && !transcript.revealedBeforeClear ? transcript.clearedAt : 0;
  /** The reveal has been asked for and its events have not all arrived yet. */
  const fetchingEarlier = transcript.revealedBeforeClear && transcript.loadingHistory;
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
  // `hidden` is deliberately not read: it counts only the events below the cut
  // that happen to be *loaded*, which is not the number a reader wants and is not
  // what the control claims — see the button below. It stays on `Tail` because it
  // is a correct statement about the walk and `webcheck` pins it there.
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
    revealedBeforeClear: transcript.revealedBeforeClear,
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
  const foot = footSays(working, tasks.length, elapsedSays(turnStartedAt));

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
     * `pb-12` rather than `py-2`, so the conversation never sits flush against the
     * composer.
     *
     * 48px, arrived at by looking at it beside Claude Code's own gap twice: 32 first,
     * then half again. Written as a number rather than as a ratio to that, because
     * the ratio was a guess off a screenshot and the number is what was chosen.
     *
     * Inside the scroll box rather than as a margin on the composer, which is the
     * difference between a gap and a dead band: this is scrollable content, so it
     * only ever *ends* 32px above the composer and nothing loses the room. It also
     * keeps the composer's own box where it was, which is what the ask card's
     * region depends on — `bottom-0` there is the top of the composer.
     */
    <div className={`${COLUMN} px-4 pt-2 pb-12`}>
      {/*
       * The one control left in a transcript, and it offers something a reader
       * can actually name: the conversation from before they cleared it.
       *
       * What it replaces was "N earlier — show more", where N was a count of
       * events against a render budget — a number about this client's bookkeeping,
       * appearing on every session over 200 events, meaning nothing to anybody.
       *
       * `text-left` rather than the `<button>` default: it is `w-full`, so a
       * centred label is a label whose position depends on the width of the box,
       * which is the thing `scroll-stable` is elsewhere fixing. Two mechanisms for
       * one property is one too many, and this one costs nothing.
       */}
      {(cut > 0 || fetchingEarlier) && (
        <button
          onClick={onReveal}
          disabled={fetchingEarlier}
          className="tap mb-2 flex w-full items-center gap-1.5 rounded-md border border-edge-strong px-3 py-2 text-left text-xs text-muted hover:bg-raised hover:text-fg disabled:opacity-50"
        >
          <Icon as={ChevronUp} size={12} />
          {/* Kept mounted through the fetch, because pressing it *stops* cutting
              the tail and the events it promised are still on the daemon — so
              without this the button would vanish on the tap and the transcript
              would sit unchanged for a round trip, which reads as nothing having
              happened. */}
          {/*
           * **No count**, and that is a correction rather than a simplification.
           *
           * It read `${hidden} events from before /clear`, and `hidden` is what
           * `buildTail` walked past — i.e. only the events *already loaded* below
           * the cut. `loadAll` stops the moment a `context_cleared` lands in a
           * page, so that is however many happened to share one 500-event page
           * with the marker: on a session cleared at seq 9500 of 10000 it read
           * "299" for 9499 real events, and when the marker landed first in its
           * page it read **"0 events from before /clear — show them"**, which
           * tells the reader there is nothing up there at all.
           *
           * The honest count is on the daemon and would cost a request to learn.
           * Naming the thing instead costs nothing and is what this diff already
           * argued for when it deleted "N earlier — show more": a number about
           * this client's own bookkeeping meant nothing to anybody.
           */}
          {fetchingEarlier ? "Loading earlier…" : "Show the conversation from before /clear"}
        </button>
      )}

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
            {rows.map((node) => (
              <TailRow key={node.key} node={node} files={files} />
            ))}
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
           * on every turn, moving the box somebody was typing in. Fixed height and
           * a fixed string, so it cannot become that again indoors. No elapsed
           * time, for the reason `tail.ts` refuses one on a tool card: a ticking
           * number re-renders the whole transcript once a second.
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
          <p role="status" aria-live="polite" className="sr-only">
            {foot?.spoken ?? noticeSays}
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
          {foot !== null && <WaitingFoot line={foot.line} working={working} tasks={tasks} />}
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
 * `agent is working` reads aloud as a sentence and `working…` does not. `null` is
 * "nothing to say", and the region falls back to the transcript notice.
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
 * **`shortDuration` and not a clock**, which is what makes this affordable at all.
 * `tail.ts` refuses an elapsed time on a tool card because "a ticking number
 * re-renders the whole transcript once a second", and that objection is about a
 * *seconds* counter: `shortDuration`'s own note in `bits.tsx` records that it was
 * one, and was made coarse for exactly this reason — `<1m`, then a value that
 * changes once a minute. Nothing schedules a render for it either, because nothing
 * has to: the transcript already re-renders on every streamed token and on the 4s
 * snapshot push, so the number is at most one poll stale.
 */
function elapsedSays(turnStartedAt: number | null): string | null {
  if (turnStartedAt === null) return null;
  const elapsed = Date.now() - turnStartedAt;
  return elapsed < ELAPSED_FLOOR_MS ? null : shortDuration(elapsed);
}

export function footSays(
  working: boolean,
  tasks: number,
  /**
   * `elapsedSays(turnStartedAt)`, resolved by the caller. Optional, so the existing
   * call sites — and every assertion about them — keep their meaning unchanged.
   */
  elapsed: string | null = null,
): { line: string; spoken: string } | null {
  // Only ever beside `working…`. An elapsed time next to "waiting for 2 tasks"
  // would be the *turn's* duration attached to a sentence about delegations that
  // outlived it — a different quantity wearing the same words.
  const runs = elapsed === null || !working ? "working…" : `working… · ${elapsed}`;
  const said = elapsed === null || !working ? "agent is working" : `agent is working, ${elapsed}`;
  if (tasks === 0) return working ? { line: runs, spoken: said } : null;
  const many = `${tasks} task${tasks === 1 ? "" : "s"}`;
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
 * Not a `button` when there is nothing to open: with no tasks this is the old
 * paragraph, `aria-hidden` and inert, because a disclosure whose body is empty is a
 * control that lies about having something behind it.
 */
function WaitingFoot({
  line,
  working,
  tasks,
}: {
  line: string;
  working: boolean;
  tasks: readonly OutstandingTask[];
}): ReactNode {
  const [open, setOpen] = useState(false);
  const onResized = useContext(ResizedContext);
  if (tasks.length === 0) {
    return (
      <p aria-hidden={true} className="flex h-5 items-center gap-2 text-2xs text-faint">
        <WorkingMark />
        {line}
      </p>
    );
  }
  return (
    <div>
      <button
        onClick={() => {
          setOpen(!open);
          onResized();
        }}
        aria-expanded={open}
        className="tap -mx-1 flex h-5 w-full items-center gap-2 rounded-md px-1 text-left text-2xs text-faint hover:bg-raised hover:text-fg"
      >
        {working ? <WorkingMark /> : <Dot tone="pending" />}
        <span className="min-w-0 flex-1 truncate">{line}</span>
        <span className="shrink-0">
          <Icon as={open ? ChevronDown : ChevronRight} size={11} />
        </span>
      </button>
      {/* The transcript's only nesting idiom, as everywhere else that something
          belongs to the row above it. */}
      {open && (
        <div className="mt-1 ml-3 space-y-1 border-l-2 border-edge pl-2">
          {tasks.map((task) => (
            <p key={task.key} className="flex items-center gap-2 text-2xs">
              <span className="shrink-0 text-muted">
                <Icon as={Bot} size={11} />
              </span>
              <span className="min-w-0 flex-1 truncate text-fg/85">
                {task.title}
                {task.latest !== null && <span className="ml-1.5 text-faint">{task.latest}</span>}
              </span>
              {task.steps > 0 && (
                <span className="shrink-0 text-faint">
                  {task.steps} step{task.steps === 1 ? "" : "s"}
                </span>
              )}
            </p>
          ))}
          {/* The whole semantics of the count, in four words, where somebody who
              wanted to know *what* will read it. The collapsed row keeps the
              reader's own words; this is the qualifier. */}
          <p className="text-faint">started, and not reported finished</p>
        </div>
      )}
    </div>
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
     * **Aligned with a tool row, glyph for glyph.** This sits inside a folded run now,
     * so its check mark is one of five in a column — and it had one icon where a tool
     * row has two and no horizontal padding where a tool row has `px-1`, so it stood
     * four pixels left of everything else and its text a whole glyph left of theirs.
     * Reported off a screenshot, which is the only way that gets noticed.
     *
     * The second slot is **reserved and empty**, which is this app's stated remedy for
     * a row that is missing the only copy of something: a permission has no ACP kind
     * of its own to draw there, and borrowing the tool's would be decoration standing
     * in for alignment.
     */
    <p className={`flex items-center gap-2 px-1 py-1 text-xs ${denied ? "text-fg font-medium" : "text-fg/85"}`}>
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
      return (
        <UserBubble
          text={event.text}
          // `?? []` is the whole fail-open story: a daemon that predates
          // attachments sends no such field, and its prompts render exactly as
          // they always did rather than as ones with a broken chip.
          attachments={event.attachments ?? []}
          files={files}
        />
      );

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
     * A rule across the transcript, not a message.
     *
     * Everything above it is still here and still readable — the log is the
     * daemon's, not the agent's memory — so the honest shape is a boundary you
     * scroll past rather than a bubble somebody said. Quiet on purpose: the loud
     * treatments in this app are reserved for things that need a person.
     */
    case "context_cleared":
      return (
        <div className="my-1 flex items-center gap-2">
          <span className="h-px flex-1 bg-edge" />
          <span className="shrink-0 text-2xs text-faint">
            context cleared — the agent has forgotten everything above
          </span>
          <span className="h-px flex-1 bg-edge" />
        </div>
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
 * has no badge to say so.
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
      <button
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        className="tap flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs text-fg/85 hover:bg-raised hover:text-fg"
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
            counts are unresolved facts; this is a settled one. "An approval cannot
            be hidden" is untouched — that property rests on `tail.ts` refusing to
            fold a *refusal* at all, which is the asymmetry that carries it, and the
            count is still on screen the moment the run is open. */}
        {node.failed > 0 && (
          <span className="shrink-0">
            <Badge>
              {node.failed} failed
            </Badge>
          </span>
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
    <div>
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
  const tone =
    status === "failed" ? "text-fg" : status === "completed" ? "text-muted" : "text-fg";

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
      <button
        onClick={() => {
          setOpen(!open);
          onResized();
        }}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        className={`tap flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-fg/85 disabled:cursor-default ${
          expandable ? "hover:bg-raised hover:text-fg" : ""
        }`}
      >
        <span className={`shrink-0 ${tone}`}>
          <Icon
            as={
              status === "failed"
                ? X
                : status === "completed"
                  ? Check
                  : status === "in_progress"
                    ? Loader
                    : Download
            }
            size={12}
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
      /* 15px of ink, 44px of target. This is the smallest control in the app and it
         sits 6px from `ChangeRow`'s expander — the adjacency `ICON_BUTTON_SIZE.sm`
         names, and the one where the mis-tap *does* something rather than merely
         opening a card. `TAP_GROW_Y` is vertical only for its documented reason;
         `-right-2` is added because this is the last child of its row, so growing
         outward on that side lands in the row's own padding and overlaps nothing. */
      className={`tap relative shrink-0 rounded p-0.5 text-faint after:-right-2 hover:text-fg disabled:opacity-50 ${TAP_GROW_Y}`}
    >
      <Icon as={busy ? Loader : Download} size={11} className={busy ? "animate-spin" : ""} />
    </button>
  );
}
