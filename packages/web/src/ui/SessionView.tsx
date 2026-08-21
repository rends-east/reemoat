import { ArrowDown, GitBranch, Pin } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { echoFor, echoVersion, subscribeEchoes } from "../echo";
import { keyOf, type SessionRef } from "../ids";
import { describe, missingRowReason } from "../machine";
import { displayCwd, downloadablePath, relativeTo } from "../paths";
import { navigate } from "../router";
import { settingsPath } from "../settings";
import { store, type AppState, type SessionRow } from "../store";
import { humanRequests, mayStillReport, showsWorking, waitingCount, type SessionSnapshot } from "../wire";
import { agentLabel } from "./agentCard";
import { Composer } from "./Composer";
import { EventList } from "./EventList";
import { FileAccessContext, type FileAccess } from "./files";
import { saveBlob } from "./download";
import { Header } from "./Header";
import { ElicitationCard } from "./ElicitationCard";
import { PermissionCard } from "./PermissionCard";
import { RenameField, resumeSession, SessionMenu } from "./SessionMenu";
import { toast } from "./Toast";
import {
  COLUMN,
  Icon,
  TranscriptSkeleton,
  sessionLabel,
  sessionNotice,
} from "./bits";

export function SessionView({ state, sessionRef }: { state: AppState; sessionRef: SessionRef }): ReactNode {
  const key = keyOf(sessionRef);
  const row = state.rowsByKey.get(key);
  const transcript = state.transcripts.get(key);
  const machine = state.machines.find((candidate) => candidate.id === sessionRef.machineId);
  /*
   * The title is the rename affordance, and it always was the *other* one.
   *
   * This said "owned here rather than inside the title, because the menu starts it
   * too" — and that menu is gone. Nothing was lost with it: tapping the session
   * name has always toggled this, carrying its own `title="Rename this session"`,
   * and `RenameField` closes it. It stays owned here because two things still
   * write it.
   */
  const [renaming, setRenaming] = useState(false);

  /*
   * "The composer just sent something", said upwards so the transcript can hear it.
   *
   * The two halves are siblings — the conversation region and the composer, which is
   * outside it on purpose (`AskCard`'s frame ends where the composer begins) — so a
   * send has no way to reach the scroll box except through the one component that
   * renders both. A counter and not a flag: two messages in a row are two requests,
   * and a flag would need clearing by whoever consumed it.
   *
   * Kept here rather than in `store.ts` deliberately. It is the only state on this
   * screen with nothing durable about it, and putting it in the store would wake
   * every subscriber — the whole session list included — on a keystroke-adjacent
   * event, which is the reason `drafts` and `attach.ts` are outside the store too.
   */
  const [tailRequest, setTailRequest] = useState(0);

  // Attaching is an effect of *viewing*, so it belongs here rather than in the
  // router. The store's LRU decides what stays live when this unmounts, which is
  // what lets two sessions on different machines keep streaming at once.
  useEffect(() => {
    store.openSession(sessionRef);
  }, [sessionRef.machineId, sessionRef.sessionId]);

  if (row === undefined) {
    /*
     * **Four answers, and `loading` is the one that used to be missing.**
     *
     * This read `machine.reach === "online" ? "not on this daemon" : "not
     * reachable"`, which are both claims this screen cannot support on the
     * ordinary path: a cold reload straight onto a session URL renders here three
     * round trips before the session list exists — `bootstrap` promotes to
     * `ready` on the *machine* list — and `resumeMachine` drops the route memo
     * first, so `reach` is `unknown` or `probing` for most of that. On a phone
     * over the relay that is seconds of the app denying that a live session
     * exists. `missingRowReason` carries the rule and `webcheck` walks its matrix.
     */
    const why = missingRowReason(machine?.reach ?? null, state.listed.has(sessionRef.machineId));
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Header title={<span className="text-base font-semibold">Session</span>} close />
        {why === "loading" ? (
          // The same shape the transcript shows once there *is* a row, so landing
          // on a session looks like one loading rather than like one missing.
          <div className={`${COLUMN} px-4 py-2`}>
            <TranscriptSkeleton />
          </div>
        ) : (
          <p className="p-6 text-center text-sm text-muted">
            {why === "no_machine"
              ? "That machine is no longer granted to you."
              : why === "unreachable"
                ? `${machine?.name ?? "That machine"} is not reachable right now.`
                : "That session is not on this daemon."}
          </p>
        )}
      </div>
    );
  }

  const session = row.snapshot;
  // Whichever has waited longest, of either kind. Only one card at a time; the
  // rest are counted in the strip below it.
  const asking = humanRequests(session)[0];
  const stream = transcript?.stream ?? null;

  return (
    /* `flex-1` and not `h-full`: this stretches inside `AppShell`'s `main`
       rather than asking for a percentage of it — see the note there. `min-h-0`
       so the transcript inside can actually scroll instead of forcing this
       column taller than the viewport. */
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        title={
          <>
            {/* ⚠ **The `StatusDot` was here and is gone**, and with the machine's
                badge it is the second thing this row has given back to the name.

                The argument for it was that the list draws the same dot in the same
                place, so opening a session does not change what its state looks
                like. True, and it stops being worth 14px once you are *inside* the
                session: everything the dot can say, this screen says at length and
                unprompted. Working is `working…` at the foot of the transcript, with
                a live region. Blocked is a card covering most of the conversation.
                Ended is `ExitNotice` in a sentence naming the reason. So the dot was
                the one place saying it in a form you have to already know how to
                read, on the row where the name is the thing you came for.

                What went with it, said out loud rather than discovered: its
                `sr-only` status word. The live region at the transcript's foot is
                what carries that now, and it says more. */}
            {/* ⚠ **The machine's `Badge` was here and is on the subline now.** This
                row is the one place the session's own *name* is the thing you came
                to read, and on a phone the badge, the dot, the pin slot and the
                title were four things sharing 358px — the name truncated while a
                word naming the machine sat beside it at full length. It is not lost
                and it is not smaller: `WorkspaceLine` is the "where is this session"
                line, and the machine is the first half of that answer, ahead of the
                path it is a path *on*. Moved at every width rather than below `sm`,
                because at `lg` the rail is already showing which machine's tab is
                selected, so the badge was the more redundant there of the two. */}
            {/* ⚠ **The pin follows the name now, and that replaces a reservation
                rather than merely moving a glyph.**

                It sat *before* the name, as a permanently reserved 12px, because
                nothing in this row is `flex-1` — so appearing on demand slid the
                session's own name 18px sideways the moment somebody pinned it, on
                the one screen where that name is what you are looking at. The
                reservation bought no-slide and charged an indent for it, and the
                indent is what was left once the status dot and the machine badge
                went: the title sat 22px in while the path under it started at zero.

                After the name, both problems are gone at once and neither is traded
                for the other. The name starts flush left, aligned with the subline,
                and a pin appears *after* it — so the thing that grows is the end of
                the row, which nothing is measured against. `gap-1.5` contributes
                nothing while the glyph is absent, because a gap only applies between
                items that exist.

                The old objection to "after" was a glyph sitting among the *trailing
                actions*, where it read as one more status light. That is a different
                place: this is inside the title group, touching the name it is about,
                with the kebab a whole flex slot away. */}
            <SessionTitle
              row={row}
              roots={state.rootsByMachine.get(sessionRef.machineId) ?? []}
              renaming={renaming}
              onRenaming={setRenaming}
            />
            {session.pinned === true && (
              <span className="inline-flex w-3 shrink-0 justify-center text-muted" title="Pinned">
                <Icon as={Pin} size={12} />
                {/* `Icon` is `aria-hidden` and `title` on a non-interactive span is
                    exposed inconsistently, so the state would be sighted-only
                    without this. It used to point at the `StatusDot` beside it as the
                    precedent; that dot is gone, which leaves this the only `sr-only`
                    label on the row and makes it load-bearing rather than consistent. */}
                <span className="sr-only">Pinned</span>
              </span>
            )}
          </>
        }
        subtitle={<WorkspaceLine machineName={row.machineName} workspace={session.workspace} />}
        close
      >
        {/*
         * **The kebab is back, below `lg` only, and the argument that removed it is
         * the argument for putting it back exactly there.**
         *
         * It held Rename, Pin, Resume and Stop and went because "every one of which
         * is on this session's row in the list, where list-shaped actions belong".
         * That is true, and it is true *only while the list is on screen*. At `lg`
         * the rail is beside you and the row is one glance away, so the menu here
         * would be a second door to a door. Below `lg` this app is one screen at a
         * time: the list is a different screen, so "it is on the row" means "go
         * back, find the row, act, come back", for renaming the thing whose name is
         * in front of you.
         *
         * `lg:hidden` rather than a prop, for `AppShell`'s reason: the breakpoint is
         * answered in CSS, so a resized window cannot leave a menu mounted that the
         * layout says is not there.
         *
         * Rename stays reachable from the title as well, and that is not a
         * duplicate worth removing — the title is the discoverable path and the menu
         * is the one a thumb finds without knowing the title is a button.
         */}
        <div className="lg:hidden">
          <SessionMenu sessionRef={sessionRef} state={state} onRename={() => setRenaming(true)} />
        </div>
      </Header>

      {/*
        `relative`, and this is what scopes the ask card.
        The card's frame is `absolute inset-0` inside here with `justify-end`, so
        it floats at the foot of the conversation — over the last few lines of
        transcript, above the composer, and short of the header and the session
        rail beside it. `inset-0` rather than `bottom-0` is deliberate and is
        argued at `AskCard`: it is what stops a tall form growing up and out. One
        waiting request must not make the fleet unreachable, and it must not take
        the composer away either: the placeholder there already says to answer the
        request above first, which is a thing you can read only if the box is
        visible.

        The composer is therefore a **sibling** of this region rather than inside
        it. That is the whole positioning change: `bottom-0` of a region that ends
        where the composer begins is the reference layout, and it needs no
        knowledge of how tall the composer currently is.
      */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Transcript sessionRef={sessionRef} state={state} tailRequest={tailRequest} />

        {stream?.phase === "waiting" && (
          <p className={`${COLUMN} px-4 py-1 text-center text-2xs text-muted`}>
            reconnecting{stream.error === null ? "" : ` — ${stream.error}`}
          </p>
        )}

        <ExitNotice row={row} machineName={row.machineName} />

        {/*
          Last, so both paint over everything in this region, and out of flow so
          they move none of it. One slot for both, because from here they are the
          same fact — the agent is waiting on you — and `AskCard` is the one shape
          they get.

          `more` replaces the "N more waiting after this one" strip that used to
          sit under the card: another thing mounting and unmounting between the
          transcript and the composer, and one that vanished the moment the card
          was folded away. It is a chip in the card's own header now.
        */}
        {/*
          `key` is the request's own id, and without it the card carries state
          across a change of request. Two parked questions reconcile as one
          component instance because they sit at the same position and have the
          same type, so answering the first painted the *second* question's title
          over the *first* one's answer rows — `setFields(null)` is in a passive
          effect and runs after that frame — and a tap landing there wrote into a
          key the new form does not have. The permission version is quieter and
          just as wrong: `details` expanded on one request stayed expanded on the
          next, which the comment on that state says it must not.
        */}
        {asking !== undefined &&
          (asking.kind === "permission"
            ? transcript !== undefined && (
                <PermissionCard
                  key={asking.permission.permissionId}
                  sessionRef={sessionRef}
                  pending={asking.permission}
                  events={transcript.events}
                  agent={session.agent}
                  more={waitingCount(session) - 1}
                />
              )
            : (
                <ElicitationCard
                  key={asking.elicitation.elicitationId}
                  sessionRef={sessionRef}
                  pending={asking.elicitation}
                  more={waitingCount(session) - 1}
                />
              ))}
      </div>

      <Composer sessionRef={sessionRef} state={state} onSent={() => setTailRequest((n) => n + 1)} />
    </div>
  );
}

/**
 * The session's name, and one of the two places it can be changed.
 *
 * The input itself is `RenameField`, shared with the list row, so the rules that
 * are easy to get subtly different in a second copy — empty means clear, the
 * placeholder is the fallback, the daemon's normalized value is what gets stored —
 * exist once.
 *
 * A plain string and never `Markdown`: this is text a person typed, and running it
 * through a renderer would make `[x](y)` a link in a page header.
 */
function SessionTitle({
  row,
  roots,
  renaming,
  onRenaming,
}: {
  row: SessionRow;
  /** This machine's browse roots, so the fallback name is `~/thing`. */
  roots: readonly string[];
  renaming: boolean;
  onRenaming: (next: boolean) => void;
}): ReactNode {
  // The same string `sessionLabel` falls back to, which is what makes the rename
  // box's placeholder show exactly what the header is showing.
  const fallback = displayCwd(row.snapshot.workspace.requestedCwd, roots);

  if (renaming) {
    return (
      <RenameField
        sessionRef={row.ref}
        current={row.snapshot.title ?? null}
        placeholder={fallback}
        onDone={() => onRenaming(false)}
      />
    );
  }

  return (
    <button
      onClick={() => onRenaming(true)}
      title="Rename this session"
      /* `lg:-ml-1` cancels the `px-1` on the left, and only where the row is
         left-aligned. The padding itself has to stay: it is what gives the hover
         fill room around the name, and this button *is* the rename control. Pulling
         the box back by the same 4px puts the text flush with the path on the line
         below, which is the alignment being asked for. Below `lg` the row is centred,
         so the padding is symmetric and there is nothing to cancel. */
      className="tap min-w-0 truncate rounded-sm px-1 text-left text-sm hover:bg-raised lg:-ml-1"
    >
      {sessionLabel(row, roots)}
    </button>
  );
}

/**
 * Where this session is working, in one line.
 *
 * Replaces the plain path, because the path alone does not answer the question
 * somebody actually has. A session in a git repository runs on a branch of its
 * own in a checkout the daemon made; one that is not runs in the folder itself.
 * That used to be a choice offered at creation time, which was the wrong shape —
 * it asked for a decision before there was anything to decide it with. Reported
 * afterwards it is just a fact, and a short one.
 */
/**
 * Why this session is not running, in one line under the transcript.
 *
 * Three states and one rule about each, all decided by `sessionNotice` so the
 * copy is assertable with no DOM. The one worth knowing when reading this: a
 * session the daemon interrupted must never say "ended", because from the
 * reader's side nothing ended — a deploy happened and it is coming back.
 */
function ExitNotice({ row, machineName }: { row: SessionRow; machineName: string }): ReactNode {
  const [busy, setBusy] = useState(false);
  const notice = sessionNotice(row.snapshot, row.snapshot.agent, machineName);
  if (notice === null) return null;
  return (
    <p
      className={`${COLUMN} flex flex-wrap items-center justify-center gap-2 px-4 py-2 text-center text-xs ${
        notice.tone === "warn" ? "text-fg font-medium" : "text-muted"
      }`}
    >
      <span>{notice.text}</span>
      {notice.action === "reconnect" && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void resumeSession(row.ref).finally(() => setBusy(false));
          }}
          className="tap rounded border border-edge px-2 py-0.5 text-2xs text-fg hover:bg-raised disabled:opacity-50"
        >
          {busy ? "reconnecting…" : "Reconnect"}
        </button>
      )}
      {/*
        * Straight to the agent's own screen **on this machine**, which is the
        * screen that can actually fix it — a sign-out is per host, and a person
        * reading this is looking at one conversation on one of them. Navigating
        * rather than opening anything inline: signing in is a wizard or a pasted
        * token, and both live there already.
        *
        * The same shape as `Reconnect` beside it and never both, which is what
        * `action` being one field rather than two booleans guarantees.
        */}
      {notice.action === "sign_in" && (
        <button
          type="button"
          onClick={() => navigate(settingsPath("machines", row.ref.machineId, row.snapshot.agent))}
          className="tap rounded border border-edge px-2 py-0.5 text-2xs text-fg hover:bg-raised"
        >
          Sign in to {agentLabel(row.snapshot.agent)}
        </button>
      )}
    </p>
  );
}

function WorkspaceLine({
  machineName,
  workspace,
}: {
  machineName: string;
  workspace: SessionSnapshot["workspace"];
}): ReactNode {
  const where = workspace.requestedCwd;
  const branch = workspace.git?.branch ?? null;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {/* The machine first, because a path means nothing until you know which host
          it is on — and this line is the answer to "where is this session", which
          that is the first half of. `shrink-0`: it is short, it is the part that
          disambiguates two sessions with the same path on two hosts, and the path
          beside it is the one with room to give. */}
      <span className="shrink-0">{machineName}</span>
      <span className="shrink-0 text-faint">·</span>
      <span className="truncate">{where}</span>
      {workspace.mode === "worktree" && branch !== null && (
        <>
          <span className="text-faint">·</span>
          <span className="flex min-w-0 items-center gap-1 text-muted">
            <Icon as={GitBranch} size={10} />
            <span className="truncate">{branch}</span>
          </span>
        </>
      )}
    </span>
  );
}

/**
 * The scrolling transcript, which follows the tail unless you have left it.
 *
 * Following unconditionally is worse than not following at all: it yanks the
 * page away mid-sentence from somebody who scrolled up to read what the agent
 * did three tool calls ago. So it follows only while the viewport is already at
 * the bottom, and offers a way back when it is not.
 *
 * Scroll position is also preserved across a history page-in — and those now
 * arrive on their own, one page at a time, while the conversation loads in behind
 * the tail. Without it, prepended events drop the reader into a completely
 * different part of the conversation: what they were reading is still there, just
 * several screens further down, moving every time a page lands.
 */
function Transcript({
  sessionRef,
  state,
  tailRequest,
}: {
  sessionRef: SessionRef;
  state: AppState;
  /**
   * Bumped by `SessionView` every time the composer sends, and read only as
   * *"it changed"*.
   *
   * A counter rather than a boolean, because two messages in a row are two
   * requests and a flag would have to be cleared by whoever consumed it — which
   * is a second piece of state and a race with this component's own effects. It
   * starts at 0 and this ignores that value, so opening a session does not count
   * as a send.
   */
  tailRequest: number;
}): ReactNode {
  const key = keyOf(sessionRef);
  const snapshot = state.rowsByKey.get(key)?.snapshot ?? null;
  const root = snapshot?.workspace.root ?? null;
  /** Read here rather than in `EventList`, so what crosses the prop is a value. */
  const working = snapshot !== null && showsWorking(snapshot);
  // Read here rather than in `EventList` for `working`'s reason, and separately
  // from it: the state this answers for is the one where the turn has ended and
  // what it delegated has not.
  const reporting = snapshot !== null && mayStillReport(snapshot);
  const transcript = state.transcripts.get(key);
  /*
   * The message on its way out, from module state rather than from the store.
   *
   * `useSyncExternalStore` over `echo.ts` for the reason `Composer` subscribes to
   * `attach.ts` the same way: this is keystroke-adjacent, and putting it in the
   * store would wake every subscriber — the sixty-row session list included — at
   * the moment somebody presses Enter. It is read here rather than inside
   * `EventList` so what crosses that prop is a value, which is the rule every
   * other prop on it already follows.
   */
  useSyncExternalStore(subscribeEchoes, echoVersion);
  const echo = echoFor(key);

  /*
   * How this transcript's files are reached.
   *
   * Memoised on the three things that actually decide it, because `EventList` is
   * re-rendered on every streamed token and a fresh object here would give every
   * row a new prop identity each time.
   *
   * `relFor` answering `null` is what makes a location outside the workspace draw
   * nothing at all, rather than a button that is guaranteed to 403.
   */
  /*
   * Every path this session has touched, from `file_change` and from tool-call
   * `locations`.
   *
   * Behind a ref rather than in the memo below, and that is the load-bearing
   * part: the set grows as events arrive, so putting it in the dependency list
   * would hand `FileAccess` a fresh identity on every streamed token — and the
   * whole point of `files.ts` is that this object stays stable while `Markdown`
   * keeps its memo. The ref lets the answers be current and the identity not.
   */
  const touched = useRef<Set<string>>(new Set());
  useMemo(() => {
    const next = new Set<string>();
    for (const stored of transcript?.events ?? []) {
      const event = stored.event;
      if (event.type === "file_change") next.add(event.path);
      const locations = "locations" in event ? event.locations : null;
      for (const location of locations ?? []) next.add(location.path);
    }
    touched.current = next;
  }, [transcript?.events]);

  const files = useMemo<FileAccess | null>(() => {
    if (root === null) return null;
    const daemon = store.daemonFor(sessionRef.machineId);
    if (daemon === undefined) return null;
    return {
      relFor: (absPath: string) => relativeTo(root, absPath),
      spanTarget: (span: string) => downloadablePath(span, root, touched.current),
      download: async (rel, name) => {
        try {
          saveBlob(await daemon.downloadFile(sessionRef.sessionId, rel), name);
        } catch (error) {
          // The daemon's own message: this is the one place a `413
          // file_too_large` or a `404 not_a_regular_file` becomes readable.
          toast("error", describe(error));
        }
      },
      fetchUpload: (uploadId) => daemon.downloadUpload(sessionRef.sessionId, uploadId),
      downloadUpload: async (uploadId, name) => {
        try {
          saveBlob(await daemon.downloadUpload(sessionRef.sessionId, uploadId), name);
        } catch (error) {
          toast("error", describe(error));
        }
      },
    };
  }, [root, sessionRef.machineId, sessionRef.sessionId]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  /**
   * Whether anything has scrolled up out of sight.
   *
   * Only read by the fade at the top: a conversation short enough to fit, or one
   * scrolled to its own first message, has nothing above and must not be told it
   * has. Same measurement as `atBottom` and taken in the same place, so the two
   * cannot disagree about where the box is.
   */
  const [scrolledDown, setScrolledDown] = useState(false);
  /** The same flag, readable from a long-lived observer callback. */
  const atBottomRef = useRef(true);
  /** This box's height as of the previous commit — i.e. before whatever just landed. */
  const lastHeight = useRef(0);
  const count = transcript?.events.length ?? 0;
  /** The oldest seq on screen. Falls when a page of history lands above the reader. */
  const firstSeq = transcript?.events[0]?.seq ?? 0;
  const lastFirstSeq = useRef(firstSeq);

  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    /*
     * History now arrives **unasked**, and that is why this is no longer keyed on
     * a tap.
     *
     * It used to be: `onShowMore` captured `scrollHeight`/`scrollTop` into an
     * anchor ref before calling the store, and this consumed it. That worked
     * exactly as long as the only way to gain older events was to press a button.
     * `store.loadAll` pages a whole conversation in behind the tail on open, so a
     * reader who scrolled up to read history would have had the ground move under
     * them once per arriving page, with nothing having been pressed.
     *
     * The arithmetic is the same and the trigger is the general one: the oldest
     * seq on screen fell, so what landed went in *above*. Shift down by exactly
     * however much taller the box became and the same content stays under the
     * reader. `lastHeight` is written on every run, so it always holds the height
     * as of the previous commit.
     */
    const grewAbove = firstSeq < lastFirstSeq.current;
    lastFirstSeq.current = firstSeq;
    const previous = lastHeight.current;
    lastHeight.current = box.scrollHeight;

    // Not for somebody parked at the bottom: they want the bottom, and the branch
    // below puts them there whatever arrived.
    if (grewAbove && !atBottom) {
      box.scrollTop += box.scrollHeight - previous;
      return;
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
    // `working` is in here because the indicator is a *row*: it grows
    // `scrollHeight` without touching this box's `clientHeight`, so the
    // `ResizeObserver` below never sees it and this is the only thing that
    // re-pins somebody parked at the bottom when a turn opens or closes.
  }, [count, firstSeq, atBottom, working]);

  /*
   * **Sending puts you back at the foot of the conversation.**
   *
   * Scrolling up to re-read something and then writing a message is an ordinary
   * thing to do, and it used to leave you reading history while your own message —
   * and everything the agent said back — landed somewhere below the fold: nothing
   * on this screen followed the tail again until you scrolled there by hand.
   * Sending is the clearest statement there is that the newest end is the one you
   * want.
   *
   * Instant and not smooth, which is the opposite of the *latest* button below and
   * is not an inconsistency: that button is a journey somebody asked for and wants
   * to see, while this is the ground being put back under a message you are already
   * writing. An animation here would scroll the page out from under the composer at
   * the exact moment your own message appears above it.
   *
   * **What this now does is the whole of it, and that is a simplification the echo
   * moving bought.** The bubble used to be drawn by the composer, so sending grew
   * the bar *below* this box in the same commit, shrinking the box while the
   * browser kept `scrollTop` — a second, later correction only the
   * `ResizeObserver` could make. The bubble is a row inside this box now: it adds
   * `scrollHeight` and touches `clientHeight` not at all, exactly like the working
   * line, so this one assignment already lands on the finished height.
   *
   * `atBottomRef` is still written beside the state rather than instead of it —
   * the state drives the pinning effect above and the *latest* button's
   * visibility, the ref is what a callback outliving this render sees — and the
   * observer is untouched, because every other cause it exists for is: the
   * composer growing as you type, a soft keyboard, a dismissed banner.
   *
   * It measures the finished DOM because `setEcho` and `onSent` land in **one**
   * commit — both run synchronously inside the same handler, so the bubble is
   * already there when this effect runs.
   */
  useEffect(() => {
    if (tailRequest === 0) return;
    const box = boxRef.current;
    if (box === null) return;
    atBottomRef.current = true;
    setAtBottom(true);
    box.scrollTop = box.scrollHeight;
  }, [tailRequest]);

  /*
   * Absorb every change to this box's own height, so nothing below it can make
   * the conversation jump.
   *
   * The permission card is what prompted this and is **no longer one of the
   * causes**, which is worth saying rather than quietly deleting: it was an
   * in-flow sibling up to 40vh tall that mounted and unmounted on the agent's
   * schedule, and it is `absolute` now, so it changes this box's height by
   * nothing at all. The "N more waiting" strip that used to sit beside it is gone
   * entirely — it is a chip in the card's own header.
   *
   * What remains is enough: the composer grows as you type, a phone's soft
   * keyboard resizes the viewport, the workspace banner is dismissed, and the
   * reconnect and exit lines appear from nowhere. Each of them shrinks this box
   * while the browser keeps `scrollTop`, which moves whatever you were reading up
   * or down by that many pixels.
   *
   * Reacting to any *one* of those by name is how this stays subtly broken: the
   * next thing added below would reintroduce it — and the card leaving the list
   * is exactly why the observer stays rather than being reconsidered. A
   * `ResizeObserver` on the box itself is the general form; it does not care what
   * changed or why.
   *
   * Only the parked-at-the-bottom case is corrected, and the other one is left
   * deliberately alone. A shrinking scroll box keeps its `scrollTop`, so whatever
   * was at the *top* of the viewport stays exactly where it was — which is right
   * for somebody reading history, and adjusting by the delta would be the thing
   * that moved it. It is only the tail that slips out of view, so it is only the
   * tail that has to be chased.
   */
  useEffect(() => {
    const box = boxRef.current;
    if (box === null || typeof ResizeObserver === "undefined") return;
    let previous = box.clientHeight;
    const observer = new ResizeObserver(() => {
      const height = box.clientHeight;
      if (height === previous) return;
      previous = height;
      // `atBottomRef` and not `atBottom`: this callback outlives the render that
      // created it, and a stale closure here would pin the wrong way round for
      // the rest of the session.
      if (atBottomRef.current) box.scrollTop = box.scrollHeight;
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // Reset when the session changes under a mounted pane — the desktop two-pane
  // case, where this component is not remounted. A new conversation starts at
  // its end.
  useEffect(() => {
    setAtBottom(true);
    atBottomRef.current = true;
    const box = boxRef.current;
    if (box !== null) box.scrollTop = box.scrollHeight;
  }, [key]);

  const measure = useCallback((): void => {
    const box = boxRef.current;
    if (box === null) return;
    // 48px of slack: an exact comparison is never true on a fractional-DPI
    // display, so "at the bottom" would be false for everyone on a laptop.
    const bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    // No slack on this one, and none is wanted: the question is "is a line cut off
    // by the header", and one pixel of scroll is already one cut line.
    setScrolledDown(box.scrollTop > 0);
  }, []);

  /*
   * Something in the transcript changed its own height, so ask again whether the
   * reader is still at the bottom.
   *
   * Opening a tool card is the case. The reader was parked at the bottom, so
   * `atBottom` was true and stayed true — no scroll event fires when content
   * grows under you — and the next arriving event re-pinned the box to its foot,
   * scrolling the card they had just opened up and out of view. Following the
   * tail is right; following it *over* the thing somebody deliberately opened is
   * not.
   *
   * A re-measurement rather than a "stop following" flag, because it is honest in
   * both directions and needs no new state: an expansion taller than the slack
   * genuinely takes them off the bottom and the card then stays where it is with
   * the text below moving down, while a small one leaves them at the bottom and
   * following continues, which is what they would want. It also keeps the
   * jump-to-bottom button truthful, which a forced flag would not.
   *
   * One frame later, because the height it has to read is the height *after*
   * React has committed the card's new state and the browser has laid it out.
   */
  const remeasure = useCallback((): void => {
    requestAnimationFrame(measure);
  }, [measure]);

  return (
    <div className="relative min-h-0 flex-1">
      {/*
       * `scroll-stable` reserves the scrollbar's width whether or not it is
       * scrolling — see `index.css`. Expanding a tool card only adds height, and
       * without this that height crossing the scroll threshold narrowed the box
       * and slid every centred row in the transcript sideways.
       *
       * **`relative` is what stops an absolutely-positioned descendant escaping
       * this box**, and its absence was a real bug with a very odd shape. An
       * abspos element is clipped by its *containing block*, not by whichever
       * scroll container it happens to sit inside — and with no `relative` here
       * the nearest positioned ancestor was the wrapper outside, so anything
       * abspos in the transcript stopped being this box's problem and became
       * `main`'s scrollable overflow instead.
       *
       * What found it: `EventList`'s `role="status"` live region is `sr-only`,
       * which Tailwind implements as `position: absolute` — one pixel, invisible,
       * carrying no content anybody sees. It sat at its static position at the end
       * of the transcript, which for a long conversation is a thousand pixels
       * down, so `main.scrollHeight` measured 1105 against a `clientHeight` of
       * 823. `main` was therefore scrollable by 282px of nothing, and once
       * scrolled the session column rode up and left blank space under the
       * composer. Measured in the live app: every element in `main` reported a
       * `bottom` inside the viewport except one 1px `<p>` at 1105.
       *
       * Pre-existing, and this made it visible rather than causing it: while the
       * transcript drew only its newest 400 events, that paragraph's static
       * position was near the fold and the overflow was small enough to look like
       * nothing. Rendering the whole conversation moved it a thousand pixels down.
       */}
      <div ref={boxRef} onScroll={measure} className="scroll-stable relative h-full overflow-y-auto">
        {transcript !== undefined && (
          <FileAccessContext.Provider value={files}>
            <EventList
              files={files}
              echo={echo}
              transcript={transcript}
              working={working}
              reporting={reporting}
              turnStartedAt={snapshot?.turnStartedAt ?? null}
              onReveal={() => store.revealBeforeClear(sessionRef)}
              onResized={remeasure}
            />
          </FileAccessContext.Provider>
        )}
      </div>

      {/*
       * **The conversation fades out under the header rather than being cut by it.**
       *
       * The header is opaque and the transcript scrolls beneath it, so the topmost
       * line was sliced mid-glyph at a hard edge — which reads as a rendering
       * fault, and worse, reads as the *beginning* of the text. A short fade says
       * "this continues above" without anything having to be written.
       *
       * **The blur is gone, and the gradient does the whole job — which it was
       * never given the room to do.** This carried a 2px `backdrop-blur` on the
       * argument that the gradient alone "leaves sharp grey words, which look
       * deliberate", and the blur was compensating for a ramp that never reached
       * opaque.
       *
       * **It never should have reached opaque. This softens the emergence from
       * under the header; it does not hide anything, and that is the correction.**
       * Two attempts went the other way first — 56px opaque to 45%, then 80px
       * opaque to 30% — and both were reported the same way: the text goes white
       * too far down, and the top line cannot be read at all. Which is exactly what
       * they did. An opaque band is a band the reader cannot see through, and 24px
       * of it is one full line of body text deleted from a conversation somebody is
       * trying to read. The blur's original complaint was aimed at the wrong thing:
       * "sharp grey words" at the top are **fine** — they are the words, still
       * legible, on their way out from under an opaque header that already ends in
       * a `border-b`. There was never a raw cut here to cover.
       *
       * So: **40px, starting at 70% and falling linearly to nothing.** Two stops
       * and no middle one, which is what guarantees there is no kink for the eye to
       * catch — the failure of the 56px version was a 5%/px tail against a 1%/px
       * middle, i.e. a visible line where the fade stopped, which is the hard edge
       * this element exists to avoid, moved down the screen. The topmost letters
       * sit under 70% paper and stay readable, which is the requirement.
       *
       * Dropping the blur is kept from those attempts and is worth its own line: a
       * `backdrop-filter` re-rasterises and re-blurs its backdrop on **every frame
       * the backdrop moves**, and this sits over the app's hottest scrolling
       * surface — a transcript with no render window that draws every event it
       * holds — stacked under a sticky header that carries its own blur. `Sheet`
       * refuses a scrim blur in this file's own voice, calling it "a full-screen
       * filter pass on every scroll frame on a phone"; that argument did not stop
       * at the scrim, and this was the other one.
       *
       * `pointer-events-none` is load-bearing: this covers the top 40px of the
       * scroller, which holds real links, tool cards and download buttons.
       *
       * It is a sibling of the scroll box rather than a `mask-image` on it,
       * because a mask on a scroll container applies to the scrollbar too — and
       * `scroll-stable` means there is always one there.
       *
       * Before the "latest" button below, so that button paints over it: later
       * siblings win, and nothing here carries a `z-index` that would let the ask
       * card's own stacking argument drift.
       */}
      {scrolledDown && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-surface/70 to-transparent"
        />
      )}

      {!atBottom && (
        <button
          /*
           * **It travels, and the travelling is the point.**
           *
           * This assigned `scrollTop` and set `atBottom` in the same tick, so the
           * conversation teleported: whatever you were reading was replaced by the
           * foot with nothing in between, and on a long transcript there was no way
           * to tell "jumped to the end" from "the page re-rendered". A scroll that
           * moves says which direction the end was in and roughly how far away it
           * was, which is the whole reason a reader taps this rather than flicking.
           *
           * **`setAtBottom` is deliberately gone from this handler.** It would fire
           * the pinning effect above on the very next commit, which assigns
           * `scrollTop` outright — an instant jump that eats the animation it was
           * meant to accompany. Nothing needs to be told: `measure` runs on every
           * scroll event, including the ones a smooth scroll emits, so the flag
           * flips when the box actually arrives and this button disappears at the
           * end of the journey rather than at the start of it. An interrupted scroll
           * therefore leaves the button on screen, which is the truth.
           *
           * The pointer for reduced motion is read here and thrown away, the rule
           * this app already keeps for `matchMedia`: `behavior: "smooth"` is not
           * covered by the `prefers-reduced-motion` block in `index.css`, which can
           * only reach CSS animations and transitions.
           */
          onClick={() => {
            const box = boxRef.current;
            if (box === null) return;
            box.scrollTo({
              top: box.scrollHeight,
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                ? "auto"
                : "smooth",
            });
          }}
          className="tap absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-md border border-edge bg-raised px-3 py-1.5 text-xs shadow-lg"
        >
          <Icon as={ArrowDown} size={12} />
          latest
        </button>
      )}
    </div>
  );
}


