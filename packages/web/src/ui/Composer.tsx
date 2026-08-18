import { Paperclip, Send, Square, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  addAttachments,
  admitFiles,
  attachmentsFor,
  canSend,
  attachmentsVersion,
  forgetAttachments,
  removeAttachment,
  restoreAttachments,
  pastedName,
  sendableAttachments,
  subscribeAttachments,
  updateAttachment,
  type PendingAttachment,
} from "../attach";
import { errorText } from "../http";
import { keyOf, type SessionRef } from "../ids";
import { composerKey } from "../keys";
import { formatBytes } from "../paths";
import { store, type AgentCommandList, type AppState } from "../store";
import {
  canCancelTurn,
  cancelInFlight,
  MAX_PROMPT_ATTACHMENTS,
  MAX_UPLOAD_BYTES,
  resumeStalled,
  showsAsEnded,
  needsHuman,
  showsWorking,
  turnInFlight,
  waitingForDaemon,
  type AgentConfigOption,
  type StoredEvent,
} from "../wire";
import { AgentConfigBar, applyConfigChange } from "./AgentConfigBar";
import { choiceRefusal, configProse, drawnControls } from "./agentConfig";
import {
  composerPlaceholder,
  focusWorthKeeping,
  shouldFocusComposer,
  shouldReleaseComposer,
  takeKeyNav,
} from "./composing";
import { UserBubble } from "./Bubble";
import { COLUMN, IconButton, Spinner } from "./bits";
import {
  buildCommands,
  completion,
  configChoices,
  filterCommands,
  slashQuery,
  typedConfigCommand,
} from "./commands";
import { CommandMenu } from "./CommandMenu";
import { toast } from "./Toast";

/**
 * Where a prompt is written.
 *
 * Three things this did not do before, all of them things every other chat
 * client does and whose absence made the app feel broken rather than minimal.
 *
 * **Enter sends.** There was no key handling here at all — a grep for
 * `onKeyDown` across the whole package returned nothing — so the only way to
 * send was tapping the arrow. See `keys.ts` for why the IME guard is not
 * optional.
 *
 * **The box grows.** It was `rows={1}` with `resize-none`, so a paragraph
 * scrolled inside a 44px slot and you could not see what you had written.
 *
 * **The draft survives.** Switching sessions unmounted this and threw away
 * whatever was typed, which on a phone is one mis-tap.
 */

/**
 * Drafts, per session, outside React.
 *
 * A module-level map rather than `AppState` on purpose: nothing else renders
 * from a draft, so putting it in the store would wake every subscriber on every
 * keystroke — the store's subscribers include the whole session list. This
 * outlives an unmount, which is the only property actually needed.
 */
const drafts = new Map<string, string>();

/**
 * How much of the *visible* page the growing box may take.
 *
 * A share rather than a line count, because what has to stay readable is the
 * thing underneath — the conversation this is a reply to — and that is a share of
 * a screen rather than a number of lines.
 *
 * **0.22, which is 0.4 lowered by 45% on request after looking at it running.**
 * The first cap was set to the largest share that still left the conversation the
 * majority of the screen, which is a defensible number and was not the one that
 * felt right in the hand. Measured at `text-sm`, i.e. a 22px line: seven lines on
 * a 390×844 phone, four with the keyboard up, three in a 416px-tall desktop
 * window, nine at 1000px. Past that the box scrolls, which is the whole point of
 * there being a cap — the floor is `min-h-11` on the box itself and is not
 * restated here.
 */
const COMPOSER_MAX_SHARE = 0.22;

/**
 * Size the box to its text, bounded, and give it a scrollbar only when bounded.
 *
 * One function rather than a body inside the effect, because two things call it:
 * the text changing, and the viewport changing under text that did not. See the
 * effect for why the bound is read off `visualViewport`.
 *
 * `height = "auto"` first is what makes `scrollHeight` mean "what the content
 * wants" rather than "what the box already is" — without it the box only ever
 * grows.
 */
function fitToContent(area: HTMLTextAreaElement): void {
  area.style.height = "auto";
  const visible = window.visualViewport?.height ?? window.innerHeight;
  const max = Math.round(visible * COMPOSER_MAX_SHARE);
  const wanted = area.scrollHeight;
  area.style.height = `${Math.min(wanted, max)}px`;
  area.style.overflowY = wanted > max ? "auto" : "hidden";
}

/**
 * A stable empty array for a session whose transcript has not loaded.
 *
 * `[]` written inline is a new identity on every render, which would defeat the
 * `useMemo` in `AgentConfigBar` that walks the whole event window — on every
 * keystroke, since this component re-renders on each one.
 */
const EMPTY_EVENTS: readonly StoredEvent[] = [];
/** Same reason, for the two lists the command menu is derived from. */
const EMPTY_COMMANDS: AgentCommandList = { commands: [], dropped: 0 };

/** Distinguishes chips within one session. Never leaves the client. */
let uploadSeq = 0;

export function Composer({
  sessionRef,
  state,
  onSent,
}: {
  sessionRef: SessionRef;
  state: AppState;
  /**
   * A message is going out on this screen, said once per send.
   *
   * `SessionView` turns it into "put the conversation back at its foot". It fires
   * on the **optimistic** half — where the echo is written and the box is cleared —
   * rather than when the daemon answers, because that is the moment the reader's
   * own message appears and the moment they expect the ground to move; a refusal
   * arriving 90 seconds later has already put the text back in the box, and having
   * scrolled to the tail in the meantime costs nothing.
   *
   * It is deliberately not called for a typed config command (`/effort high`),
   * which sends no message and leaves the transcript untouched.
   */
  onSent: () => void;
}): ReactNode {
  const key = keyOf(sessionRef);
  const row = state.rowsByKey.get(key);
  const [text, setText] = useState(() => drafts.get(key) ?? "");
  const [busy, setBusy] = useState(false);
  /**
   * The cancel request itself, not the state of being cancelled.
   *
   * A second flag beside `busy` rather than a reuse of it: `busy` gates Send and
   * is what the spinner in that slot means, and a cancel is dispatched precisely
   * when Send is *not* available — so one flag would have made the Stop button
   * replace itself with the Send spinner. This one covers only the round trip;
   * what outlives it is `cancelInFlight`, read off the daemon's own snapshot.
   */
  const [stopping, setStopping] = useState(false);
  /** The prompt we sent and the seq it landed at, until the log catches up. */
  const [echo, setEcho] = useState<{
    text: string;
    seq: number;
    attachments: readonly PendingAttachment[];
  } | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  /*
   * The command menu's state.
   *
   * `caret` is tracked because the menu is derived from where the caret *is*, not
   * only from what the text is — clicking back into the middle of a word must
   * close a menu that would otherwise be completing something else. `stage` is
   * the control being valued once one has been picked; `dismissed` is an Escape
   * that must not be undone by the next keystroke recomputing the same query.
   */
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [stage, setStage] = useState<AgentConfigOption | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  /** Where to put the caret after a completion rewrote the box. */
  const pendingCaret = useRef<number | null>(null);
  /**
   * Which session this instance is showing *now*, readable from a callback that
   * started under a different one.
   *
   * This component is not remounted on a session change — `App` renders
   * `SessionView` with no `key` and `SessionView` renders this with none — which
   * is the whole reason the `[key]` effect below exists. `send`'s continuations
   * can land up to ninety seconds later (`POST /sessions/:id/prompt` is on the
   * slow-route budget and resumes a terminal session first), so the `key` in
   * their closure is *the session the message went to* while this ref is *the
   * session somebody is looking at*. Every `setText`/`setEcho`/`setBusy` after an
   * await needs the second one: a `409 turn_in_flight` from session A used to
   * put A's message into B's box, where pressing Enter sent it to B's agent in
   * B's worktree.
   *
   * Written from the effect rather than during render, so a render React
   * discards cannot move it.
   */
  const liveKey = useRef(key);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  /*
   * Attached files, from module state rather than from React or the store.
   *
   * `useSyncExternalStore` over `attach.ts` for the same reason drafts live
   * outside React: list → detail → back unmounts this component, and a chip lost
   * that way is bytes already on the daemon that nothing can reference. Not the
   * store either — a progress event at 60fps would wake every subscriber
   * including the session list, which is strictly worse than the keystroke this
   * component already refuses to put there.
   */
  useSyncExternalStore(subscribeAttachments, attachmentsVersion);
  // For drawing the chips and for `canSend`. The ids that actually go on the wire
  // are resolved inside `send`, from the live list — see the note there.
  const attachments = attachmentsFor(key);

  /** What the optimistic echo draws, in the shape the transcript uses. */
  const echoRefs = useMemo(
    () =>
      (echo?.attachments ?? [])
        .filter((item) => item.uploadId !== null)
        .map((item) => ({
          uploadId: item.uploadId as string,
          name: item.name,
          mime: item.mimeType,
          bytes: item.size,
          inlined: false,
        })),
    [echo],
  );

  /**
   * Take files from the picker and start uploading them.
   *
   * **On select, not on send.** The daemon has to answer `{uploadId}` before a
   * prompt can name it, so uploading at send time would turn Send into a
   * thirty-second operation under `busy` with no way to tell the network from the
   * agent — and a limit refusal should arrive while somebody is still at the
   * picker rather than after they commit.
   *
   * Sequentially rather than in parallel: ten concurrent 25 MiB streams against a
   * 256 KiB-per-stream tunnel window is self-inflicted head-of-line blocking on
   * the same tunnel that carries the poll and every socket in the fleet.
   *
   * The cost, accepted rather than papered over: bytes land on the daemon for
   * messages that are never sent, because a tab can close mid-upload. That is
   * what the daemon's own 24-hour sweep of unconsumed uploads is for.
   */
  const attach = (picked: readonly File[]): void => {
    if (picked.length === 0) return;
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) return;

    const { accepted, refused } = admitFiles(attachmentsFor(key), picked);
    for (const item of refused) {
      toast(
        "error",
        item.reason === "too_large"
          ? `${item.file.name} is larger than ${formatBytes(MAX_UPLOAD_BYTES)}`
          : item.reason === "empty"
            ? `${item.file.name} is empty`
            : `at most ${MAX_PROMPT_ATTACHMENTS} files per message`,
      );
    }
    if (accepted.length === 0) return;

    const stampedAt = Date.now();
    const staged = accepted.map((file: File) => {
      const controller = new AbortController();
      return {
        localId: `a_${uploadSeq++}`,
        file,
        // Not `file.name`: a pasted screenshot can arrive nameless, and the
        // daemon refuses an empty one. Named here so the chip and the upload
        // cannot disagree.
        name: pastedName(file.name, file.type, stampedAt),
        size: file.size,
        mimeType: file.type,
        state: "uploading" as const,
        progress: 0,
        uploadId: null,
        error: null,
        cancel: () => controller.abort(),
        controller,
      };
    });
    addAttachments(
      key,
      staged.map(({ controller, ...item }) => { void controller; return item; }),
    );

    void (async () => {
      for (const item of staged) {
        try {
          const answer = await daemon.uploadFile(
            sessionRef.sessionId,
            item.file,
            item.name,
            // Resolves `(key, localId)` and no-ops if the entry is gone, which is
            // what lets a session switch mid-upload simply not matter.
            (fraction) => updateAttachment(key, item.localId, { progress: fraction }),
            item.controller.signal,
          );
          updateAttachment(key, item.localId, {
            state: "ready",
            progress: 1,
            uploadId: answer.upload.uploadId,
            // The daemon may have shortened it. Show what it will actually be.
            name: answer.upload.name,
            cancel: null,
          });
        } catch (cause) {
          if (item.controller.signal.aborted) continue;
          // The chip stays, carrying the daemon's own message, with a retry. A
          // toast and a vanished chip is the "nothing to retype from" failure
          // this file already names for the config path.
          updateAttachment(key, item.localId, {
            state: "failed",
            error: errorText(cause),
            cancel: null,
          });
        }
      }
    })();
  };

  // Reload the draft when the session changes under a mounted composer, which
  // is what happens in the desktop two-pane layout.
  // Everything keyed to the old session goes, and that means every one of these:
  // a `caret` left behind indexes into a draft it never came from, and an
  // `applying` left behind lets a config change dispatched against the previous
  // session close this one's menu when it lands.
  useEffect(() => {
    liveKey.current = key;
    setText(drafts.get(key) ?? "");
    setEcho(null);
    setStage(null);
    setDismissed(false);
    setCaret(0);
    setApplying(null);
    // And `busy`, which belongs to a prompt sent against the *previous* session:
    // left set, it made this session's Send a spinner and `submit`'s `if (busy)
    // return` swallow every message typed here until that other request answered.
    setBusy(false);
    // And `stopping`, for the same reason and with a worse ending, because unlike
    // `busy` there is no second path that could ever clear it. Its only reset is
    // gated on `onScreen()`, and a cancel routinely holds the daemon for
    // `CANCEL_SEND_TIMEOUT_MS + CANCEL_SETTLE_MS` — long enough to tap another
    // session — after which that reset is skipped, the send slot draws the
    // "Stopping" spinner for whatever session is on screen, the Stop button that
    // would dispatch again is no longer drawn, and `cancelTurn`'s own `if
    // (stopping) return` refuses to reach the `finally` that would release it.
    setStopping(false);
    // Deliberately *not* clearing attachments: they are keyed by session in
    // `attach.ts` and coming back to this one should find them where they were.
  }, [key]);

  /*
   * The caret goes in the box when the session changes.
   *
   * A `useEffect` on `[key]` and not `autoFocus`, for the same reason the reset
   * above is one: at `lg` the two-pane shell does **not** remount this component
   * when you switch sessions — only `key` changes — so a mount-time prop fires
   * once, on the first session you ever open, and never again.
   *
   * `composerShows` is in the dependency list because `row` can be absent on the
   * first render after a switch: `openSession` has not answered yet, this renders
   * `null`, and there is no textarea for the effect to reach. Keyed on `key`
   * alone it would fire into nothing and never fire again.
   *
   * `matchMedia` is read **here** rather than held in state, and that is not a
   * violation of the rule this file states further down — it is the rule. What
   * `SessionBrowser` removed was a media query read during render and *kept*,
   * which an iPad gaining a keyboard silently invalidated. This answer is
   * discarded in the same tick it is taken, so there is nothing to go stale, and
   * it cannot be a CSS variant because there is no CSS for "call `.focus()`".
   *
   * `preventScroll` because this box is inside a sticky footer and the transcript
   * beside it is a separate scroll container: focusing must not also be a scroll.
   */
  const composerShows = row !== undefined && !showsAsEnded(row.snapshot);
  useEffect(() => {
    // Taken unconditionally, so a switch that decided not to focus cannot leave
    // the flag set for the next one.
    const fromKeyboardNav = takeKeyNav();
    const active = document.activeElement;
    if (
      !shouldFocusComposer({
        hasBox: composerShows,
        pointerCoarse: window.matchMedia("(pointer: coarse)").matches,
        /*
         * Only focus that would actually be *stolen* — an editable field or an
         * open menu — and emphatically not "anything at all is focused".
         *
         * The wider test made this feature dead on Chromium at `lg`, which is
         * the layout it was written for: the rail stays mounted, a session row
         * is a `<button>` (`SessionBrowser`), and Chromium focuses buttons on
         * click — so `activeElement` was always the row you had just tapped and
         * the effect declined every single time. Safari and Firefox on macOS do
         * not focus buttons on click, so it worked there, and below `lg` the
         * list unmounts so it worked there too. A feature that depends on which
         * browser you opened is not a feature; confirmed dead in practice before
         * this was narrowed.
         */
        focusHeldElsewhere: focusWorthKeeping(active),
        blocked: row !== undefined && needsHuman(row.snapshot),
        fromKeyboardNav,
      })
    ) {
      return;
    }
    areaRef.current?.focus({ preventScroll: true });
    // `row` is read inside and is deliberately *not* a dependency: the store
    // replaces that object on every poll, so listing it would re-focus the box
    // every four seconds and fight whatever else is on the screen. What is read
    // from it is a guard, not an input — it only ever decides against focusing.
  }, [key, composerShows]);

  /*
   * Grow to fit, up to a share of what you can actually see.
   *
   * There used to be a `min(scrollHeight, 40vh)` clamp here and a `max-h-[40vh]`
   * to match, and both were removed on the argument that the box *is* the
   * message: past about a dozen lines it became a small window with a scrollbar
   * down its right edge, so you were writing into a viewport rather than at a
   * page. That removal wrote its own cost down rather than hiding it — "a
   * genuinely huge paste makes the composer taller than the viewport, and the
   * column has nowhere to put the overflow" — and that is exactly what came back
   * from a phone: a long message and the box is the whole screen, with the
   * conversation it is a reply to squeezed to nothing.
   *
   * So a cap is back, and two things make it a different cap from the one that
   * was taken out.
   *
   * **It is measured against `visualViewport`, never `innerHeight` and never
   * `vh`.** A software keyboard covers the layout viewport without shrinking it,
   * so with the keyboard up on a 390×844 phone `40vh` is 337px of a page with
   * only ~508px of it visible — a cap that still resolves to "most of the screen",
   * which is the report. `visualViewport.height` is the number the keyboard
   * actually moves, and it is why this is arithmetic here rather than a
   * `max-h-[…]` utility: CSS has no unit for it.
   *
   * **The box scrolls only once it is capped.** `overflow-hidden` stays in the
   * class list as the pre-measurement default and this overrides it inline, so no
   * scrollbar exists until there is something to scroll — the other half of the
   * old objection. The caret needs no help staying in view; that is what a
   * scrollable textarea already does on input.
   *
   * `useLayoutEffect` so the height is set before paint; with `useEffect` the box
   * visibly steps taller one frame late on every keystroke. Q3.422.
   */
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (area === null) return;
    fitToContent(area);
  }, [text]);

  /*
   * The cap moves without the text moving, so it is re-applied on its own.
   *
   * A rotation, a desktop window resize and the keyboard opening or closing all
   * change what `visualViewport.height` answers while `text` is untouched, and the
   * effect above is keyed on `text` alone — so without this a box that was capped
   * with the keyboard up stays that tall when it closes, and one measured against
   * a tall window stays taller than a short one. `visualViewport` is the only one
   * of the two that fires for the keyboard; `window` still gets rotations on
   * browsers where the visual viewport does not.
   *
   * Mount-only, and it can be: `fitToContent` reads the DOM and closes over
   * nothing that renders.
   */
  useEffect(() => {
    const refit = (): void => {
      const area = areaRef.current;
      if (area !== null) fitToContent(area);
    };
    window.addEventListener("resize", refit);
    window.visualViewport?.addEventListener("resize", refit);
    return () => {
      window.removeEventListener("resize", refit);
      window.visualViewport?.removeEventListener("resize", refit);
    };
  }, []);

  const transcript = state.transcripts.get(key);
  // Drop the echo once the real event is in the log. Comparing seq rather than
  // text: an identical prompt sent twice would otherwise clear the second echo
  // against the first event.
  useEffect(() => {
    if (echo === null) return;
    if ((transcript?.events.at(-1)?.seq ?? 0) >= echo.seq) setEcho(null);
  }, [echo, transcript]);

  /*
   * The agent's command list, fetched once per revision for the open session only.
   *
   * Keyed on the revision as well as the session: claude republishes mid-session
   * as it discovers skills in a subdirectory, and the revision is the only thing
   * on the snapshot that says so.
   */
  const revision = row?.snapshot.commandsRevision;
  useEffect(() => {
    store.ensureCommands(sessionRef, revision);
    // On the ids and not on `sessionRef` itself, the same as `SessionView`'s own
    // effect: the object is rebuilt by the router on every render, so depending on
    // its identity would re-run this on each keystroke. `ensureCommands` would
    // no-op every time, but a dependency that is always new is a dependency list
    // that says nothing.
  }, [sessionRef.machineId, sessionRef.sessionId, revision]);

  /*
   * Put the caret where the completion left it.
   *
   * `useLayoutEffect` for the same reason the auto-grow above uses one: with a
   * plain effect the caret is visibly in the wrong place for a frame, and on a
   * phone that frame is where the soft keyboard decides what to capitalise.
   */
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    areaRef.current?.setSelectionRange(at, at);
    setCaret(at);
  }, [text]);

  const events = transcript?.events ?? EMPTY_EVENTS;
  const commandList = state.commands.get(key) ?? EMPTY_COMMANDS;
  const commands = commandList.commands;
  const agentConfig = row?.snapshot.agentConfig;

  // Memoised because this walks both lists and the composer re-renders on every
  // keystroke — the same reason `EMPTY_EVENTS` exists above. What these deps are
  // *not* is stable across a poll: `agentConfig` rides a snapshot the store
  // reparses every four seconds, and `events` is a fresh array per streamed
  // event. That is why nothing downstream may key a *reset* on their identity.
  const prose = useMemo(() => configProse(events), [events]);
  const entries = useMemo(
    () => buildCommands(commands, agentConfig, prose, row?.snapshot.agent),
    [commands, agentConfig, prose, row?.snapshot.agent],
  );
  const query = dismissed ? null : slashQuery(text, caret);
  const matches = useMemo(
    () => (query === null ? [] : filterCommands(entries, query.query)),
    [entries, query?.query],
  );
  /*
   * Read from `row` and not from `session`, which is bound below the early return
   * and is not in scope here — the memo would otherwise close over a stale value
   * and the `/` menu would draw a sentence about a turn that had ended.
   */
  const turnRunning = row !== undefined && turnInFlight(row.snapshot);
  const choices = useMemo(
    () => (stage === null ? null : configChoices(stage, prose.get(stage.id), turnRunning)),
    [stage, prose, turnRunning],
  );

  /** Whichever list is on screen. `active` indexes into this and nothing else. */
  const rows: readonly unknown[] = choices ?? matches;
  // An empty panel is furniture, so the menu opens only onto something.
  const menuOpen = !dismissed && rows.length > 0 && (stage !== null || query !== null);

  /*
   * Send the highlight home when the *question* changes, never when the array
   * does.
   *
   * This was keyed on `[matches, choices]`, and those identities move on a timer
   * rather than on content: `entries` depends on the session snapshot, which the
   * 4s poll replaces wholesale, and on `prose`, which is a new Map per streamed
   * event. So arrowing through a hundred-entry menu had the highlight snap back
   * to row 0 every four seconds at rest and continuously while the agent worked —
   * which is exactly when the menu is used, since the composer stays live and
   * queues. Enter then acted on row 0 instead of the row under the eye, and for a
   * mode shortcut that applies in one tap with no second step: aiming at
   * `/dontAsk` and landing on `/default` is a silent permission change.
   *
   * The query string and the stage are what actually invalidate the index, and
   * both are values rather than references.
   */
  useEffect(() => {
    setActive(0);
  }, [query?.query, stage]);

  // Belt to that brace: a list can also shrink under a held highlight without the
  // query changing — a command withdrawn mid-session does it — and an `active`
  // past the end selects nothing at all.
  useEffect(() => {
    setActive((at) => (at < rows.length ? at : 0));
  }, [rows.length]);

  /*
   * Hand the caret back when a request parks, so the card's own keys work.
   *
   * The mirror of `shouldFocusComposer` and the half it was missing: declining to
   * *take* focus does nothing about a caret taken a moment earlier, and while the
   * composer holds one every shortcut on the ask card is switched off by
   * `isTypingInto`.
   *
   * **Above the early returns, with `blocked` derived from `row` rather than from
   * `session`.** It sat below them, which is a Rules-of-Hooks violation and not a
   * style point: `showsAsEnded(session)` flips true the moment anybody stops a
   * session, that render produces one hook fewer than the last, React throws
   * `Rendered fewer hooks than expected`, and there was no error boundary
   * anywhere in this package, so the root unmounted to a blank page — on a
   * phone, with no console. `RootErrorBoundary` is the floor under that now, and
   * it names this docblock as one of the two ways in; it turns the blank page
   * into a message and a Reload, which is a better failure and not a fix for
   * this one. Nothing here would have caught it: there is no eslint, `tsc` does
   * not model hook order, and `webcheck` has no DOM.
   *
   * `row !== undefined && needsHuman(row.snapshot)` is the same expression
   * `shouldFocusComposer` is already given a few lines up, for the same reason.
   */
  const parked = row !== undefined && needsHuman(row.snapshot);
  useEffect(() => {
    const box = areaRef.current;
    if (box === null) return;
    if (
      shouldReleaseComposer({
        blocked: parked,
        focused: document.activeElement === box,
        draftEmpty: text.trim().length === 0,
      })
    ) {
      box.blur();
    }
    // `text` is deliberately not a dependency: this is about the moment a request
    // arrives, not about every keystroke after it.
  }, [parked]);

  if (row === undefined) return null;
  const session = row.snapshot;
  /*
   * `showsAsEnded` and not `isTerminal`, which is the whole point of the four
   * predicates in `wire.ts`.
   *
   * Only a session somebody *ended* loses its composer. One the daemon
   * interrupted keeps it, and sending a message is what brings the agent back —
   * the route resumes in front of the prompt. Losing the box for the length of a
   * deploy was the failure this fixes: an ordinary restart left the reader
   * looking at `ended: daemon_shutdown` with nothing to type into and a Resume
   * item buried in a kebab menu.
   *
   * This also revives two things below that had been dead code for as long as
   * they had existed: the `disabled` on `AgentConfigBar` — correct, since a
   * session waiting on the daemon has no live agent to answer a config change —
   * and the paperclip's own note about staging a file for a terminal session.
   */
  if (showsAsEnded(session)) return null;

  const blocked = needsHuman(session);
  const working = showsWorking(session);
  /*
   * The daemon will not take a message, so the composer does not offer to send one.
   *
   * `ManagedSession.prompt` returns `busy` while `this.turn !== null`, and a
   * parked question keeps the turn open — so both of these are a guaranteed `409
   * turn_in_flight`. `composerPlaceholder` already says which one it is, in the
   * box the sentence belongs in.
   */
  const sendRefused = blocked || working;
  /*
   * The two halves of the send slot's other state.
   *
   * `stoppable` is `canCancelTurn`, which is `sendRefused` restated from the
   * snapshot's own fields — the two coincide today and are *not* the same
   * sentence, so they are read from the predicate that means what this control
   * means rather than reusing the one above. `pendingCancel` is whether somebody
   * has already asked, which is the daemon's answer and not this tab's.
   */
  const stoppable = canCancelTurn(session);
  const pendingCancel = cancelInFlight(session);

  const reconnecting = waitingForDaemon(session) || resumeStalled(session);

  const update = (next: string): void => {
    setText(next);
    if (next.length === 0) drafts.delete(key);
    else drafts.set(key, next);
  };

  /**
   * Is this render's session still the one on screen?
   *
   * Only ever asked *after* an await, and that is a property of the call sites
   * rather than a hope about them. Everything synchronous here is by definition
   * still looking at the session it was written for, and asking then would make
   * an ordinary keystroke depend on an effect having flushed — `liveKey` is
   * written from the `[key]` effect, so between a session-switch render and its
   * flush this answers `false` about the session the render is actually for.
   *
   * `send` is the one function reachable *both* ways, and it takes `late`
   * explicitly for that reason: the synchronous caller cannot accidentally ask
   * this question, and the deferred one cannot accidentally skip it. Stated as a
   * comment alone it was false — `submit` calls `send` with nothing awaited, so
   * the ordinary Send did depend on that effect, and in the window where it does
   * not hold the message goes to the daemon while the box is left full, no echo
   * is drawn and no spinner lights: the one rendering that reads as "it did not
   * send" and invites a duplicate.
   *
   * See `liveKey`: the box, the echo and the spinner are one shared instance
   * while `drafts` and `attach.ts` are keyed, so a late answer may write the
   * keyed halves and must not write the shared ones.
   */
  const onScreen = (): boolean => liveKey.current === key;

  const closeMenu = (): void => {
    setStage(null);
    setDismissed(true);
  };

  /**
   * Apply one value of a control, and close only if the daemon agreed.
   *
   * `onDone` is how the one-tap path defers its own draft edit until the answer
   * is in — see `choose`. Nothing here edits the box itself, because the second
   * stage has already cleared it by the time it gets here.
   *
   * `applying`, `stage` and `dismissed` are the same shared instance the box is,
   * and this callback runs after `POST /sessions/:id/config` on the 90s slow
   * route — long enough for somebody to be looking at another session in this
   * same composer, which at `lg` does not remount. So a config change dispatched
   * against A used to close B's open `/` menu when it landed, with nothing said
   * and no way to tell it from a stray tap. `onDone` is called either way,
   * because what it does with a late answer is its own decision and every one of
   * them is keyed.
   */
  const applyValue = (option: AgentConfigOption, value: string, onDone?: (ok: boolean) => void): void => {
    /*
     * **The second door, refused by the same function as the first.** The strip's
     * row swallows this tap and so does this one, which is what licenses
     * `applyConfigChange` suppressing the toast for that single code: nothing
     * dispatches into a refusal that says nothing.
     *
     * `onDone?.(false)` keeps this path's contract — the typed form sends its
     * message only if the daemon agreed — so a refused value neither applies nor
     * sends, and the menu stays open because only success closes it.
     */
    if (choiceRefusal(option, value, turnRunning) !== null) {
      onDone?.(false);
      return;
    }
    setApplying(value);
    void applyConfigChange(sessionRef, option.id, value).then((ok) => {
      // One question, asked once, because the two writes below are one decision:
      // clearing the spinner and closing the menu belong to the same session or
      // to neither, and `onDone` sits between them.
      const present = onScreen();
      if (present) setApplying(null);
      onDone?.(ok);
      // Closed only on success. The daemon's answer is the truth — the agent can
      // refuse a value — and a menu that shut on failure would look like it had
      // worked. The toast is `applyConfigChange`'s.
      if (ok && present) closeMenu();
    });
  };

  /**
   * Take a command.
   *
   * Three outcomes, not two: `/plan` carries its own value and applies in one
   * tap, `/model` opens its choices as a second stage, and everything else fills
   * the box for sending.
   */
  const choose = (index: number): void => {
    if (query === null) return;
    const entry = matches[index];
    if (entry === undefined) return;
    const next = completion(text, query, entry);

    if (entry.option !== null && entry.value !== null) {
      /*
       * The one-tap path dispatches *first* and rewrites the draft only if the
       * daemon agreed, which is the same rule `applyValue` states and this branch
       * was breaking. Clearing up front meant that on a refusal the token was
       * already gone — and with it `query`, so `menuOpen` went false and the menu
       * closed anyway, leaving a toast as the only trace of a mode that did not
       * change. There is nothing to retype from.
       */
      applyValue(entry.option, entry.value, (ok) => {
        if (!ok) return;
        /*
         * The same split `send` makes, for the same reason: this runs after a
         * `POST /sessions/:id/config` round trip on a 90s budget, and `update`
         * writes `setText` — the one shared instance — as well as the keyed
         * draft. Tapping `/plan` in the menu and then moving to another session
         * put A's completion text into B's visible box, and `pendingCaret` then
         * moved B's caret to A's offset, so an Enter aimed at retrying A's
         * gesture sent A's text to B's agent (`submit` reads the live render's
         * `sessionRef`).
         *
         * The draft is written for the session it was typed in either way —
         * that is what makes "come back to it and it is waiting for you" true —
         * and only the box on screen is rewritten. `pendingCaret` is a position
         * *in that box*, so it goes with the box and never with the draft.
         */
        if (onScreen()) {
          update(next.text);
          pendingCaret.current = next.caret;
        } else if (next.text.length === 0) drafts.delete(key);
        else drafts.set(key, next.text);
      });
      return;
    }

    update(next.text);
    pendingCaret.current = next.caret;
    // A control is not a message: no text is sent, the token is cleared, and the
    // menu becomes that control's own choice list.
    setStage(entry.kind === "config" ? entry.option : null);
  };

  const chooseValue = (index: number): void => {
    const value = choices?.[index]?.value;
    if (stage === null || value === undefined) return;
    applyValue(stage, value);
  };

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    const daemon = store.daemonFor(sessionRef.machineId);
    if (busy || daemon === undefined) return;
    // Text **or** files. A message that is only a screenshot is legitimate, and
    // `canSend` is where that rule lives so the button and this guard cannot
    // disagree — it also refuses while an upload is in flight, because sending
    // then would deliver a files-only message with no files in it.
    if (!canSend(text, attachments, sendRefused)) return;

    /*
     * A typed control is a control, not a message.
     *
     * The menu applies these on selection and sends nothing; typing the same name
     * and pressing Enter used to send it to the agent as text. Measured against
     * claude: `/plan I want…` — a slash command with an argument after it —
     * arrived as a prompt and came back "/plan isn't available in this
     * environment", a mode change spent as a turn.
     * The names are ours precisely so they are typeable, so typing one has to do
     * what choosing it does.
     */
    const typed = typedConfigCommand(text, entries);
    if (typed !== null) {
      const { entry, option, rest } = typed;
      if (entry.value === null) {
        // `/model`, `/effort`, `/mode`: a question rather than a change. Open the
        // choices, the same second stage the menu would. Anything typed after the
        // name is not a message — it is an argument to a picker that has none —
        // so the box keeps just the token and the list answers it.
        //
        // `dismissed` is cleared with the stage, and that is the whole of this
        // gesture rather than a detail of it: `menuOpen` is `!dismissed && …`, and
        // tapping the Send arrow *is* a dismissal — `pointerdown` lands outside the
        // panel and the textarea, so `CommandMenu`'s own outside-click listener has
        // run `closeMenu()` before the `click` that submits. Without this, pressing
        // Send on `/model` opened a stage nothing would draw: no picker, no message,
        // no toast, repeatable for ever, with only editing the text as a way out.
        // Escape-then-Enter reached the same dead end. `dismissed` may only ever
        // suppress the menu the *query* derives; it must never suppress a stage
        // somebody just asked for.
        update(`/${entry.name}`);
        setStage(option);
        setDismissed(false);
        return;
      }
      // Dispatch first and send only if the daemon agreed, which is `applyValue`'s
      // own rule: a prompt written for plan mode must not run in the previous one
      // because the change was refused. On a refusal the draft is untouched and
      // `applyConfigChange`'s toast says why, so there is something to retry from.
      setBusy(true);
      applyValue(option, entry.value, (ok) => {
        // The same split `send` makes below, for the same reason and one round
        // trip earlier: this callback runs after `POST /sessions/:id/config` on a
        // 90s budget, by which time somebody may be looking at another session in
        // this same composer. The draft still goes to the session it was typed in
        // — `update` writes `drafts` under this render's key — and `send` below
        // still sends to `sessionRef`; what must not happen is `/plan`'s leftover
        // message appearing in a box belonging to a different agent.
        if (onScreen()) setBusy(false);
        if (!ok) return;
        if (onScreen()) update(rest);
        else if (rest.length === 0) drafts.delete(key);
        else drafts.set(key, rest);
        // Nothing after the name is the ordinary case — `/plan` on its own is a
        // whole gesture. `canSend` decides for the rest, so a files-only message
        // still goes and an empty one does not.
        //
        // Against the **live** set and not this render's copy: a round trip has
        // happened since, and nothing stops a file being attached during it.
        if (canSend(rest, attachmentsFor(key), sendRefused)) send(rest, true);
      });
      return;
    }

    // Nothing has been awaited between the keystroke and here, so this render's
    // session *is* the one on screen — see `late`.
    send(text.trim(), false);
  };

  /**
   * Put a message on the wire. Split out so a typed control can reach it too.
   *
   * `late` says whether the caller has awaited since the gesture began, and it is
   * required with no default for the reason `LaunchOptions.fileIo` is: a new call
   * site has to decide, and deleting the argument is a type error rather than a
   * silent one. The two answers are the two doors — `submit` arrives straight off
   * the keystroke, `applyValue`'s callback arrives a `POST /sessions/:id/config`
   * round trip later, by which time this one composer instance may be showing a
   * different session.
   *
   * It is the whole of what `onScreen` is asked here, and asking it on the
   * synchronous path was wrong in the one direction that matters: `liveKey` is
   * written from an effect, so in the window between a session-switch render and
   * its flush the ordinary Send would have put the message on the wire while
   * skipping the box, the echo and the spinner — which reads as "it did not
   * send".
   */
  const send = (body: string, late: boolean): void => {
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) return;

    /*
     * Read **live**, not from this render's closure.
     *
     * `forgetAttachments(key)` two lines down deletes the whole live list, so
     * whatever is captured here has to be the same list that is about to be
     * destroyed — or a chip is thrown away without being sent and without being
     * restorable. That is not hypothetical: the typed-control path calls `send`
     * from `applyValue`'s callback, i.e. after a `POST /sessions/:id/config` round
     * trip on a 90s budget, while the paperclip, paste and drop all stay live
     * throughout. Type `/plan fix the build`, press Enter, paste a screenshot
     * while the config call is in flight, and the closure's copy sent the prompt
     * without the screenshot, cleared the chip anyway, and left no error and
     * nothing in the echo to say a file had gone.
     *
     * On the ordinary path nothing has awaited, so this reads exactly what the
     * render did and the change is invisible.
     */
    const sent = [...attachmentsFor(key)];
    const { ids: sending } = sendableAttachments(sent);
    /*
     * These three are the shared instance, and on the `late` door — the
     * typed-control path, calling from `applyValue`'s callback a `POST
     * /sessions/:id/config` round trip later — they belong to a session that may
     * no longer be the one on screen. Emptying the box, drawing the pending
     * bubble and lighting the spinner all belong to the session the message came
     * from, so on that door they happen only while it is still showing. The
     * draft is cleared either way: the message has genuinely left it.
     *
     * `!late` short-circuits rather than merely being redundant, which is what
     * keeps `onScreen`'s "only ever asked after an await" true and what stops the
     * ordinary Send depending on an effect having flushed.
     */
    if (!late || onScreen()) {
      setBusy(true);
      update("");
      setEcho({ text: body, seq: Number.MAX_SAFE_INTEGER, attachments: sent });
      // Inside this arm rather than beside it, and for its whole reason: on the
      // `late` door the session that sent this may not be the one on screen, and
      // scrolling *that* conversation to its foot would move a transcript nobody
      // was writing into.
      onSent();
    } else {
      drafts.delete(key);
    }
    forgetAttachments(key);
    /*
     * Everything below the await is split in two, and the split is the same one
     * `updateAttachment` already makes for a chip: what is **keyed** by session
     * happens whatever is on screen, and what is **React state on this one shared
     * instance** happens only if this is still the session that sent it.
     *
     * `drafts`, `attach.ts` and the store are all keyed, so they are correct from
     * anywhere. `setText`, `setEcho` and `setBusy` are not: they write into
     * whichever session this composer is showing when the promise settles, and at
     * `lg` switching sessions does not remount it. What that produced was A's
     * refused message appearing in B's box — and then being sent to B's agent by
     * an Enter aimed at retrying it — plus A's pending bubble drawn above B's
     * composer, which B's own log can only clear once it passes A's seq.
     */
    void daemon
      .prompt(sessionRef.sessionId, body, sending)
      .then((result) => {
        if (onScreen()) setEcho({ text: body, seq: result.seq, attachments: sent });
        store.applySnapshot(sessionRef, result.session);
      })
      .catch((cause: unknown) => {
        // Put it back rather than losing it. `turn_in_flight` is the commonest
        // refusal and the message is the daemon's own, which says which of the
        // two reasons it was.
        //
        // **Both**, and that is not tidiness: the uploads are still on the daemon
        // and still valid, so restoring the text while dropping the chips would
        // silently turn a retry into a different message.
        //
        // The draft is written through the map either way — that is what makes
        // "come back to the session and it is waiting for you" true — and only the
        // box on screen is rewritten.
        if (onScreen()) {
          setEcho(null);
          update(body);
        } else if (body.length === 0) {
          // A files-only message has no text to restore, and an empty entry left
          // in the map is a draft that is not one. Same rule `update` applies.
          drafts.delete(key);
        } else {
          drafts.set(key, body);
        }
        restoreAttachments(key, sent);
        toast("error", errorText(cause));
      })
      .finally(() => {
        if (onScreen()) setBusy(false);
      });
  };

  /**
   * Ask the agent to stop what it is doing.
   *
   * **Nothing is written optimistically.** Every other action here draws its
   * effect before the daemon confirms it — the box empties, the echo appears —
   * because a message a person typed is theirs and putting it back is the
   * remedy. A cancel has no such copy: drawing "stopping" and then having the
   * request fail would claim an agent had been called off when it is still
   * working, which is the one lie this control must not tell. So the button's
   * pending state comes from the snapshot the daemon returns
   * (`cancelRequestedAt`) and from nothing else.
   *
   * `stopping` is local and short-lived, covering only the round trip itself, and
   * it is gated on `onScreen()` for the reason `busy` is: this composer instance
   * outlives a session switch, so a late answer must not spin a button belonging
   * to somebody else's session. The keyed half — the snapshot — is applied
   * unconditionally, because it names the session it is about.
   */
  const cancelTurn = (): void => {
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined || stopping) return;
    setStopping(true);
    void daemon
      .cancelTurn(sessionRef.sessionId)
      .then((result) => {
        store.applySnapshot(sessionRef, result.session);
      })
      .catch((cause: unknown) => {
        toast("error", errorText(cause));
      })
      .finally(() => {
        if (onScreen()) setStopping(false);
      });
  };

  return (
    <div
      /*
       * Dropped files, on the whole composer rather than on the textarea: a
       * person aims at the box they type in, and the box is 44px tall when empty.
       *
       * `onDragOver` has to `preventDefault` or `drop` never fires at all — the
       * browser's default is to refuse the drop — and it is gated on the drag
       * actually carrying files so that selecting text and dragging it within the
       * box still behaves normally.
       */
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(event) => {
        // Fires for every child the pointer crosses. Only the one that leaves the
        // composer itself counts, or the highlight flickers on every internal edge.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files];
        setDragging(false);
        if (files.length === 0) return;
        event.preventDefault();
        attach(files);
      }}
      className={`pb-safe sticky bottom-0 border-t bg-surface/95 pt-2 backdrop-blur ${
        dragging ? "border-edge-strong bg-raised ring-1 ring-edge-strong ring-inset" : "border-edge"
      }`}
    >
      {/*
       * The bar is full width and its contents are not.
       *
       * The rule, the background and the drop target span the window — they are
       * chrome, and a centred rule with gaps either side would read as a card. The
       * box you type in shares `COLUMN` with the transcript above it and the ask
       * card that floats between them, so all three line up at every width.
       */}
      <div className={COLUMN}>
      {echo !== null && (
        <div className="px-3 pb-2">
          <UserBubble text={echo.text} pending attachments={echoRefs} />
        </div>
      )}

      {/* Its own full-width row rather than a place in the control strip: chips
          wrap to two lines and need the width a phone has, and the strip is a
          single line of controls that must not reflow under them. */}
      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 px-3 pb-2">
          {attachments.map((item) => (
            <li
              key={item.localId}
              className={`flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-2xs ${
                item.state === "failed" ? "border-danger/50 bg-danger/5" : "border-edge bg-surface"
              }`}
            >
              {item.state === "uploading" ? (
                <Spinner />
              ) : (
                <Paperclip size={11} className="shrink-0 text-faint" />
              )}
              <span className="min-w-0 truncate font-mono">{item.name}</span>
              <span className="shrink-0 text-faint">
                {item.state === "uploading"
                  ? item.progress > 0
                    ? `${Math.round(item.progress * 100)}%`
                    : "sending…"
                  : item.state === "failed"
                    ? (item.error ?? "failed")
                    : formatBytes(item.size)}
              </span>
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() => removeAttachment(key, item.localId)}
                className="tap shrink-0 rounded p-0.5 text-faint hover:text-fg"
              >
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* `relative` on the form and not on the textarea: the panel spans the whole
          composer, which is the width a phone has, and anchoring it to the box
          alone would leave it short by the send button. */}
      <form onSubmit={submit} className="relative flex items-end gap-2 px-3">
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            attach([...(event.currentTarget.files ?? [])]);
            // Cleared so picking the same file twice in a row fires `change`
            // again — otherwise the second attempt does nothing, silently.
            event.currentTarget.value = "";
          }}
        />
        {menuOpen && (
          <CommandMenu
            entries={matches}
            choices={choices}
            active={active}
            stage={stage}
            busy={applying}
            dropped={commandList.dropped}
            anchorRef={areaRef}
            onHover={setActive}
            onChoose={choose}
            onChooseValue={chooseValue}
            onDismiss={closeMenu}
          />
        )}
        <textarea
          ref={areaRef}
          value={text}
          onChange={(event) => {
            update(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            // Typing re-arms a menu an Escape closed. Any other rule means Escape
            // switches the feature off for the rest of the draft.
            setDismissed(false);
            // And it abandons a value picker. Choosing `/model` clears the box, so
            // typing into it is somebody writing a message again rather than
            // picking a model — leaving the choices up would put a list they are
            // no longer looking at over the text they are.
            setStage(null);
          }}
          /*
           * The caret can move without the text changing — an arrow key, a click,
           * a drag — and the menu is derived from where it is. Without these a
           * click back into the middle of a word leaves a menu open that is
           * completing something the caret is no longer in.
           */
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          /*
           * Ctrl+V of an image, which on a desktop is how a screenshot is
           * actually attached — the picker is the phone's answer, not everyone's.
           *
           * `preventDefault` only when there really are files: a clipboard
           * carrying an image often carries a text alternative too, and letting
           * the default run would paste a filename or a data URL beside the chip.
           * An ordinary text paste must fall straight through untouched, which is
           * why this returns before touching the event.
           */
          onPaste={(event) => {
            const files = [...(event.clipboardData?.files ?? [])];
            if (files.length === 0) return;
            event.preventDefault();
            attach(files);
          }}
          onKeyDown={(event) => {
            /*
             * What the keystroke means is decided in `keys.ts`, including the one
             * collision — Enter, which the menu takes while it is open and
             * `shouldSend` takes otherwise. That ordering used to live here, in
             * two blocks in a JSX prop, which is a rule nothing could assert;
             * `composerKey` is the same rule somewhere `webcheck` can reach it.
             *
             * `nativeEvent.isComposing`, not the synthetic event: React does not
             * forward it, and without it Enter commits an IME candidate *and*
             * sends the half-typed word.
             *
             * **The pointer is read here, at the keystroke, and thrown away in the
             * same tick** — the rule this file already states for
             * `shouldFocusComposer` above. A soft keyboard has no Shift+Enter, so
             * on a coarse pointer Enter is the newline and Send is the button;
             * `keys.ts` carries why. Held in state instead it would be the exact
             * staleness the deleted `↵` button's own comment warned about — an
             * iPad gaining or losing a keyboard flips this and nothing re-renders
             * — whereas the next keystroke always reads the truth.
             */
            const action = composerKey(
              { ...event, isComposing: event.nativeEvent.isComposing },
              menuOpen,
              !window.matchMedia("(pointer: coarse)").matches,
            );
            if (action === null) return;
            event.preventDefault();
            if (action === "send") submit();
            else if (action === "next") setActive((at) => (at + 1) % rows.length);
            else if (action === "prev") setActive((at) => (at - 1 + rows.length) % rows.length);
            else if (action === "choose") {
              if (stage === null) choose(active);
              else chooseValue(active);
            } else {
              // Escape only, and the propagation stop is the load-bearing half:
              // `useKeyboard` binds Escape on `window` to blur whatever has
              // focus, so without this, dismissing the menu would also throw you
              // out of the composer and dismiss the soft keyboard.
              event.stopPropagation();
              closeMenu();
            }
          }}
          rows={1}
          /*
           * `enter` rather than `send`, unconditionally, and the unconditionality
           * is the point: this attribute is only ever consulted by a *virtual*
           * keyboard, so there is no pointer question to ask and nothing that can
           * go stale. It is the half of the mobile rule the person can see — the
           * key is drawn as a return key and it inserts a return, which is what
           * `composerKey`'s `enterSends` makes true underneath.
           */
          enterKeyHint="enter"
          placeholder={composerPlaceholder({ blocked, reconnecting: busy && reconnecting, working })}
          aria-label="Message"
          role="combobox"
          // `combobox` on a `textarea` costs the multiline semantics a screen
          // reader would otherwise infer, so they are restored explicitly rather
          // than lost silently; `aria-autocomplete` is what says the list narrows
          // as you type, which nothing else here conveys.
          aria-multiline={true}
          aria-autocomplete="list"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? "composer-command-menu" : undefined}
          // The highlight is an index rather than focus, which is what lets the
          // caret stay in the box — and therefore what lets an input method go on
          // composing while the list is up.
          //
          // Both stages, not just the first. This was gated on `stage === null`
          // because only the entries branch rendered the ids — which made the
          // choice list, the one that changes the agent's model or mode, the one
          // with no announcement at all: the arrows moved a highlight a screen
          // reader could not see and Enter applied whatever it had reached.
          aria-activedescendant={menuOpen ? `composer-command-${active}` : undefined}
          /*
           * One appearance, focused or not, and `outline-none` is what keeps it
           * that way rather than an oversight.
           *
           * The border used to turn `accent` on focus, which made the box somebody
           * is about to type in the loudest thing on the screen for the whole time
           * they are typing in it. It is where the caret already is; a second
           * signal saying so is decoration.
           *
           * Deleting `outline-none` instead would be *worse*, not neutral. The
           * app-wide rule in `index.css` is `:focus-visible`, and a text control
           * matches that whenever it is focused — mouse and touch included, unlike
           * a button — so removing it draws a 2px ring on every single tap. The
           * caret is the focus indicator a textarea has anyway.
           *
           * **`outline-none` alone was not enough, and it looked like it was.**
           * No Tailwind utility can win here: they are emitted inside
           * `@layer utilities` and the app-wide rule is unlayered, and unlayered
           * styles beat layered ones *regardless of specificity* — measured,
           * `focus-visible:outline-none` at (0,2,0) still loses to the rule's
           * (0,1,0). So the box went on drawing an accent ring on focus while
           * this comment claimed it did not.
           *
           * `no-focus-ring` is the opt-out that rule declares for itself in
           * `index.css`, which is the only place able to grant one. Nothing else
           * in this app should use it — see the note there.
           */
          // `bg-surface`, the bar's own colour, rather than `bg-ink` — which was
          // the rail's tone and is 1.06:1 from this ground, i.e. a fill that was
          // doing nothing but claiming to. Same rule as every other field: match
          // the ground, and let `edge-strong` be the identification.
          className="no-focus-ring min-h-11 flex-1 resize-none overflow-hidden rounded-md border border-edge-strong bg-surface px-3 py-2.5 text-sm outline-none"
        />
        {/*
         * **There was a `↵` button here, and it is gone rather than moved.**
         *
         * It existed because a soft keyboard has no Shift+Enter while Enter sent,
         * so on touch there was no way to type a newline at all. That is answered
         * one level down now — `composerKey`'s `enterSends` is false on a coarse
         * pointer, so the keyboard's own Return key inserts the line break and
         * Send is the button, which is what every phone chat client does.
         *
         * Two things went with it that were never right. The button appended to
         * the **end** of the draft (`update(`${text}\n`)`) while `caret` sat one
         * field away unread, so a newline typed in the middle of a message landed
         * at the bottom of it; and it took 44px plus a gap out of the box you are
         * typing in, on the narrowest screen this app runs on, to do it.
         */}
        {busy ? (
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-fg text-ink">
            <Spinner />
          </span>
        ) : stopping || pendingCancel ? (
          /*
           * A cancel has been asked for and the agent has not finished.
           *
           * A spinner rather than a disabled Stop, and the reason is mechanical:
           * `IconButton` carries `disabled:pointer-events-none`, so a greyed
           * square's `title` never appears — the explanation would exist only for
           * a screen reader while everybody else got an unexplained dead control.
           * The same shape the `busy` branch above uses, in `plain` rather than
           * `accent`, because this is the way out of an action and not the
           * affirmative one.
           *
           * It is drawn from `cancelInFlight` and not from the local `stopping`
           * alone: the turn routinely outlives the request that asked for it — an
           * agent notices a cancel when it next looks up — so a slot that re-armed
           * the moment the answer came back would invite a second tap at every
           * stop. If the agent never answers, the escalation is Stop in the
           * session menu, which is a different act with a different cost.
           */
          <span
            role="status"
            aria-label="Stopping — the agent has not finished yet"
            title="Stopping — the agent has not finished yet"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-edge bg-raised text-fg"
          >
            <Spinner />
          </span>
        ) : stoppable ? (
          /*
           * The same slot, holding the only thing that can be done in it.
           *
           * Send is refused for exactly one reason — there is a turn in flight —
           * and until now that produced a disabled arrow with a sentence in its
           * tooltip explaining why nothing would happen. A control whose whole
           * content is "not now" is worse than the control somebody actually
           * wants, and every remote agent has the same answer to what that is.
           *
           * `tone="plain"` and not `accent`: this is not the affirmative action in
           * the row, it is the way out of one. The colour rule is `AskCard`'s —
           * de-emphasis lives in fill and border, never in the text — so the label
           * stays fully legible while the button does not compete with the
           * transcript.
           */
          <IconButton
            icon={Square}
            label="Stop the agent"
            tone="plain"
            size="lg"
            type="button"
            onClick={cancelTurn}
          />
        ) : (
          <IconButton
            icon={Send}
            /*
             * **It does not queue, and this said it did.** `ManagedSession.prompt`
             * refuses while a turn is open, so that tooltip described a feature
             * nothing implements and Send was live onto a guaranteed `409
             * turn_in_flight` — a red toast on every message typed while the agent
             * was working or while a question was parked. `canSend` refuses now
             * and the placeholder says which of the two it is.
             */
            label={sendRefused ? "Wait for the agent — it cannot take a message yet" : "Send"}
            tone="primary"
            size="lg"
            type="submit"
            // A visible refusal while a file is still going up. Sending now would
            // send the message without the attachment somebody just added, and a
            // *failed* chip deliberately does not block — it is never going to
            // finish, so holding Send hostage to it would leave no way out but
            // removing it.
            disabled={!canSend(text, attachments, sendRefused)}
          />
        )}
      </form>

      {/*
       * Below the input, not above it.
       *
       * This is where every remote control for an agent puts its controls, and
       * the reason is that a strip above the box reads as a separate toolbar
       * belonging to the transcript rather than to the thing you are about to
       * send. The popovers still open upward (`bottom-full`), so nothing is ever
       * hidden behind a soft keyboard.
       *
       * It also replaces the hint line that used to live here. "Enter to send ·
       * Shift+Enter for a new line" is gone entirely now, and not merely made
       * conditional: it appeared under the box on every focus, i.e. on every
       * single message, and a keyboard hint that is still being shown after the
       * hundredth message is no longer teaching anybody anything — it is a line
       * of furniture between the thing you are typing and the thing you are
       * reading. The behaviour it described is `keys.ts`.
       *
       * That last clause used to read "the newline button beside the box is what a
       * device with no Shift+Enter needs, and that is a control rather than a
       * caption", i.e. the caption was licensed away by a control that has since
       * been deleted. Nothing replaces either, and nothing needs to: on a coarse
       * pointer Return is now simply a return, which is the behaviour a soft
       * keyboard already draws on its own key, and Send is the one filled button
       * on the row.
       *
       * Two more lines went the same way, and by the same argument. `agent is
       * working — your message will queue` mounted and unmounted under this strip
       * on **every turn**, adding and removing 16px between the box you are
       * typing in and the transcript you are reading it against — the exact
       * motion the paragraph above objects to, on a schedule set by the agent
       * rather than by you. The fact it carried is not gone: `showsWorking` draws
       * a row inside the transcript, where the agent's next sentence is going to
       * appear anyway. The queueing itself was never described anywhere else and
       * does not need to be — the message sends, no error comes back, and the
       * reply arrives after the current one; Send's own label says so for anybody
       * who hovers or listens.
       *
       * `reconnecting the agent — this can take a moment` had the same shape and
       * a better excuse, since it explains a Send button that has been a spinner
       * for up to 90 seconds. It moved into the **placeholder**, which is visible
       * for exactly that window — `submit()` clears the draft before the request
       * resolves — and which costs no height at all. A reserved-height slot was
       * the other candidate and was refused: 16px of permanent blank under every
       * composer, for ever, to avoid a shift in a state most people never reach.
       */}
      <AgentConfigBar
        sessionRef={sessionRef}
        agent={session.agent}
        // The pair rather than the snapshot's own config: a restart empties that,
        // and the strip used to go blank for the length of one. `drawnControls`
        // decides between the live answer and the row's memory of the last one,
        // and reports which — so nothing here has to know.
        controls={drawnControls(session, row?.heldConfig)}
        usage={session.contextUsage}
        events={transcript?.events ?? EMPTY_EVENTS}
        // The session's turn, which is what the daemon refuses a restart on — not
        // `disabled` below, which is this tab's own prompt in flight and clears
        // the moment the daemon accepts it.
        turnRunning={turnRunning}
        // Terminal is no longer named here: a session with no live agent arrives
        // as `stale` from `drawnControls`, which is the same refusal reached
        // through the predicate that also decides what may be drawn.
        disabled={busy}
        leading={
          <IconButton
            icon={Paperclip}
            label="Attach a file"
            tone="plain"
            // 32px, so it is one of the pills rather than the only 36px thing in
            // the row. `md` made it the tallest control in the strip and the only
            // one that did not line up with its neighbours.
            size="chip"
            // Not gated on any capability: ACP requires every agent to support
            // `resource_link`, so there is no agent for which this does nothing.
            // Only the count limit closes it, and a terminal session does not —
            // `resume` exists, and staging a file for one is the ordinary flow.
            disabled={attachments.filter((item) => item.state !== "failed").length >= MAX_PROMPT_ATTACHMENTS}
            onClick={() => fileInput.current?.click()}
          />
        }
      />
      </div>
    </div>
  );
}
