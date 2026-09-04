import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { listNavKey, nextOptionIndex } from "../keys";
import { displayCwd, shortPath } from "../paths";
import type { OfflineReason, Reach } from "../machine";
import {
  isTerminal,
  resumeStalled,
  waitingForDaemon,
  type ExitReason,
  type SessionSnapshot,
} from "../wire";
import { LAYER, useDismissible } from "./overlay";

/**
 * The primitive set.
 *
 * Deliberately small and deliberately not a component library: every one of
 * these exists because the same eight Tailwind classes were being retyped in
 * three files and drifting. Anything that needs a prop for every visual decision
 * belongs in the screen that uses it, not here.
 *
 * **The picker rule.** A control whose option count can exceed about five is a
 * {@link Dropdown}. The reason is layout rather than taste: an unbounded wrap of
 * buttons reflows the page every time the set changes size — the fleet gaining a
 * machine, an agent going offline — and on a phone it pushes the fields below it
 * off the screen. There was a `Chip` row here for the fixed-set case; the filter
 * row it served became a `Dropdown`, and nothing has needed one since.
 *
 * One deliberate exception, written down so it is not "fixed" later: the answer
 * rows on `AskCard`, which is where both a permission's options and a question's
 * live. Every option there must be visible at once, and hiding "reject" behind a
 * popover would be a safety regression on the one screen in this app where that
 * matters.
 *
 * **Interaction.** Every interactive element gets hover feedback with a
 * *background* and not only a colour — a 15px glyph changing from `text-muted` to
 * `text-fg` on a dark surface is close to invisible, which is why nothing here
 * looked pressable. Focus is one global `:focus-visible` rule in `index.css`
 * rather than per component, because per-component focus styling is how the fifth
 * copy of a control ends up with none.
 *
 * **One radius, and the circles are not an exception to it.** Everything that can
 * be pressed is `rounded-md`, which is what the textarea, the send button and
 * every attachment chip already were — the pills in the composer's own control
 * strip were the only round things in the composer, so the row that is *part* of
 * it did not look like it. What stays circular is `StatusDot`, `Dot`, `Spinner`
 * and `Skeleton`'s placeholders: those are marks rather than controls, and a
 * two-pixel radius on an eight-pixel dot is a smudge.
 *
 * **Two ways to reach 44px, and which is right is a question about neighbours.**
 * A control that owns its row — {@link Dropdown}'s full-width trigger, a form
 * field — grows its *box* on a coarse pointer: the vertical space is free and a
 * taller target is an easier one to read. A control in a dense row of controls —
 * the composer's strip, a list row's kebab — keeps its box and grows a
 * transparent `::after`, because that strip sits above a soft keyboard where
 * height is paid for out of the transcript, and because `gap-1.5` neighbours mean
 * a symmetric inset would put one control's target on another's face. Both are
 * 44px; only one of them reflows.
 */

/**
 * 32px of ink reaching a 44px target, **vertically only**.
 *
 * Exported because the composer's control strip is built from two different
 * primitives — `ICON_BUTTON_SIZE.chip` here for the paperclip, `CHIP` in
 * `AgentConfigBar` for the pills and the two square buttons — and they sit in
 * one row. Written out twice they were byte-identical and had to stay that way
 * by hand, which is two different tap targets in one strip the first time
 * somebody tunes one of them.
 *
 * Both halves of the asymmetry are measured rather than tidy. Up is 4px because
 * the textarea's own bottom edge is 6px above; down is 8px into the composer's
 * bottom padding, which holds a line of text and nothing you can press.
 *
 * Vertical only, and that is the whole reason it is not `-inset-2.5`: these sit
 * `gap-1.5` apart, so a symmetric inset would put one control's target over its
 * neighbour's *face* — and the neighbour changes the model.
 */
export const TAP_GROW_Y =
  "after:absolute after:inset-x-0 after:-top-1 after:-bottom-2 after:content-['']";

/**
 * The conversation's own column: centred, with room either side.
 *
 * The transcript, the composer and the ask card were each full-bleed, so on a
 * desktop a one-line reply ran the whole width of a 1600px window and the eye had
 * to travel back across all of it for the next line. A measure that wide is not a
 * style preference; it is the thing every reading surface bounds and this one did
 * not.
 *
 * It is a shared constant rather than three copies of `max-w-3xl` because the
 * three have to be the *same* width or the card and the composer stop lining up
 * with the text they belong to — which is visible immediately and was the
 * complaint. Below the breakpoint it resolves to full width with the padding the
 * caller already had, so the phone is unchanged.
 *
 * Deliberately not applied to the scroll box itself: the scrollbar belongs at the
 * edge of the window, not at the edge of the text, and `scroll-stable` is
 * measuring that box.
 */
export const COLUMN = "mx-auto w-full max-w-3xl";

/**
 * A text field's chrome, once.
 *
 * `SignIn` and the password form under Settings → Account are the same control
 * one screen apart, and they had already drifted: `py-3` on the sign-in screen
 * against `py-2` in the settings form. That is not cosmetic here. `index.css`
 * forces `font-size: max(16px, 1em)` on every input under a coarse pointer —
 * the rule that stops iOS zooming the page on focus — so with a 16px face those
 * two are roughly 47px and 39px tall, which puts the *same field* on either side
 * of the 44px tap minimum depending on which screen you reached it from.
 *
 * **That was first settled by keeping `py-3`, and it is settled by `min-h` now.**
 * Padding only ever reached 44px *via* whatever line-height the type scale
 * happened to give that font size — two numbers in two files multiplying out to a
 * height nothing stated. The floor is written down instead, and the resting
 * height with it.
 *
 * Layout is deliberately **not** in here. Width, margin and `block` legitimately
 * differ — a full-width form field, a `max-w-sm` one, a `flex-1` one sitting
 * beside a Button — and folding one caller's layout into the shared string is
 * exactly how the next caller writes a fourth copy to get out of it.
 *
 * **`focus:border-accent` was deleted rather than recoloured, and that is a fix
 * rather than a consequence of the palette.** A text control matches
 * `:focus-visible` on *every* focus, including a touch — that is what the
 * selector means for an input, unlike a button — so the global ring in
 * `index.css` was already firing on every tap into a field, and this drew a
 * second indicator inside it. One tap, two marks, saying the same thing. The ring
 * is the indicator.
 *
 * The resting border is `edge-strong` and not `edge`, for the reason stated at
 * the token: this box has no fill of its own to identify it, so its boundary is
 * the control, and a boundary that identifies a control is held at 3:1.
 */
/**
 * A search box, glyph-inset and complete.
 *
 * ⚠ **A whole string rather than `` `${FIELD} pl-8` ``, and that is the trap
 * {@link FIELD} documents.** Tailwind emits every utility at equal specificity, so
 * `px-3` and `pl-8` race by stylesheet order and the loser is whichever the build
 * happens to emit second. The caller draws the magnifier as an absolutely
 * positioned `pointer-events-none` span in a `relative` wrapper.
 *
 * `bg-surface` because a control is drawn in the colour of what it sits on, and
 * everything using this sits on a sheet. The rail's own search box is the same
 * shape at `bg-ink` and is deliberately not this constant.
 */
export const SEARCH_FIELD =
  "min-h-9 w-full rounded-md border border-edge-strong bg-surface py-2 pr-2.5 pl-8 text-sm outline-none [@media(pointer:coarse)]:min-h-11";

export const FIELD =
  "min-h-9 rounded-md border border-edge-strong bg-surface px-3 text-sm leading-5 outline-none [@media(pointer:coarse)]:min-h-11";

/*
 * ⚠ **Never compose this with a vertical padding, and there is no way to make one
 * work.** Tailwind emits every utility at equal specificity, so the winner is
 * whichever comes later *in the generated stylesheet* rather than in the class
 * attribute. Measured on this bundle: `.py-3` is emitted after `.py-2`, so
 * `` `${FIELD} py-2` `` silently kept the taller box — no error, and the code
 * reading as though it had worked. Two controls meant to line up differed by 10px
 * through a review that said they did not.
 *
 * That is the same trap `Button` documents for a size passed through `className`,
 * and it is why the height above is `min-h` and there is no `py-*` in the string:
 * with none in here, there is nothing for a caller's to lose an argument to. A
 * caller needing a different height states `min-h-*`, one utility against one,
 * which behaves the way it reads.
 */

/**
 * What a link looks like — the *only* thing in this palette that says "this
 * moves you somewhere".
 *
 * With the accent colour gone there is no hue left to mark one, and weight is
 * already spent (a blocked row's title is semibold). What is left is the
 * underline, so it is drawn rather than saved for hover: a navigation nobody can
 * see is a navigation nobody takes, which is exactly what the sign-in screen's
 * two doors were as bare `text-muted` — present, correct, and read as prose.
 *
 * `decoration-edge-strong` and not the text colour, for the reason that token
 * exists: a rule at full strength under every link turns a paragraph into a
 * fence, and this has to sit inside agent output as well as under a form. Hover
 * takes it to `fg`, which is the whole of the affordance.
 *
 * **No fill, ever** — `bg-fg` is the affirmative action inside a decision, and a
 * navigation is not one. `tap` is added by the caller, because an `<a>` does not
 * need it and a `<button>` does.
 */
export const LINK = "text-fg underline decoration-edge-strong decoration-1 underline-offset-2 hover:decoration-fg";

/**
 * Compact durations. A phone glance needs "2m", not "2 minutes ago".
 *
 * **Under a minute is `<1m`, and it used to be a live second count.** This is
 * drawn on every row of the session list, which re-renders on the four-second
 * poll, so a fresh session sat there counting — `4s`, `8s`, `12s` — which is a
 * clock, and a clock is a thing the eye returns to. Nobody was reading it: the
 * question a row answers is *how long ago*, and at this resolution the honest
 * answers are "just now" and a number of minutes. It also stops the column
 * changing width three times in the first minute.
 *
 * `<1m` rather than "now", because the row beside it says `2m`, `1h`, `3d` — one
 * vocabulary, and `<1m` is the same sentence with the same unit.
 */
export function shortDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}


/**
 * Re-exported so the six call sites that had it from here keep their import.
 *
 * It lives in `paths.ts` now, beside `relativeTo` and {@link displayCwd} — the
 * two functions that decide what a path *is* rather than how a row draws one.
 */
export { shortPath };

/**
 * What to call a session: its name, or a fallback built from where it works.
 *
 * One function because there are three call sites — the rail, the phone list and
 * the session header — and three copies of a fallback rule is exactly the
 * divergence class this file keeps being extended to fix.
 *
 * `title` is `undefined` from an older daemon and `null` when nobody has named it;
 * both mean the same thing here. Trimmed and length-checked rather than merely
 * null-checked, because a title of `" "` would render as a blank row, which is
 * worse than a path.
 *
 * **Never rendered through `Markdown`.** This is text a person typed; putting it
 * through a markdown renderer would make `[x](y)` a link and `_x_` italic in a
 * session header. Plain string, `truncate`.
 */
export function sessionLabel(
  row: { snapshot: { title?: string | null; workspace: { requestedCwd: string } } },
  /**
   * The daemon's browse roots, so an unnamed session is called `~/thing` rather
   * than `…/rends/thing`.
   *
   * Defaulted rather than required, and the default is the honest one: a caller
   * with no roots to hand — an older daemon, a machine that has not answered
   * `/fs/roots`, a driver — gets exactly the label this drew before roots
   * existed. See `displayCwd`.
   */
  roots: readonly string[] = [],
): string {
  const title = row.snapshot.title?.trim();
  if (title !== undefined && title.length > 0) return title;
  return displayCwd(row.snapshot.workspace.requestedCwd, roots);
}

/**
 * What a row is doing, in the vocabulary the dot actually has.
 *
 * A separate type from `SessionStatus`, and that is the correction rather than
 * an indirection for its own sake: the dot used to be a
 * `Record<SessionStatus, string>`, and a session interrupted by a *graceful*
 * restart arrives as `exited` — the same key a session somebody stopped arrives
 * under. So the warn-toned `interrupted` treatment was on the branch an ordinary
 * deploy never took, and the branch it did take drew "nothing is happening"
 * over a conversation that was about to come back. The reason is on `exit`, so
 * the tone has to be derived from the whole session.
 */
export type StatusTone =
  | "blocked"
  | "running"
  | "starting"
  | "stopping"
  | "waiting"
  | "stalled"
  | "idle"
  | "ended"
  | "failed";

export function statusTone(
  session: Pick<SessionSnapshot, "status" | "exit" | "agentSessionId" | "resume">,
): StatusTone {
  if (!isTerminal(session.status)) {
    switch (session.status) {
      case "blocked":
        return "blocked";
      case "running":
        return "running";
      case "starting":
        return "starting";
      case "stopping":
        return "stopping";
      default:
        return "idle";
    }
  }
  if (resumeStalled(session as SessionSnapshot)) return "stalled";
  if (waitingForDaemon(session as SessionSnapshot)) return "waiting";
  return session.status === "failed" ? "failed" : "ended";
}

/**
 * Nine states, no colour, and four axes to spend.
 *
 * A mark this size has exactly four properties a glance can read: **filled or
 * hollow**, **ringed or not**, **moving or still**, and **round or a shape**. The
 * palette used to spend hue on this and now cannot, so each of the nine is
 * assigned a combination rather than a colour, and two of them additionally spend
 * something that is not on the dot at all — see the row, which carries weight, and
 * the folder header, which carries a count.
 *
 * The pairing that matters most is `blocked` against `running`, because those are
 * the two loudest and they were previously amber against blue:
 *
 * * `blocked` is **filled with a permanent ring**, static. `ring-*` is a
 *   box-shadow, so it costs no layout, and it is ~3× the area of an ordinary dot.
 *   Static on purpose — `prefers-reduced-motion` deletes motion outright, so
 *   motion can never be what carries the one state somebody has to act on.
 * * `running` is **filled with an animated ring growing from zero**. Under reduced
 *   motion that collapses to a plain filled dot with no ring, which is still not
 *   `blocked`. The dark palette could not manage that without the hue.
 *
 * `failed` and `stalled` are the one **shape** change in the set, and they earn it:
 * the docblock above already says that state is "worth finding without opening
 * anything", and at 10px a glyph is the strongest non-colour cue there is — it
 * survives greyscale, reduced motion and a phone in sunlight together.
 */
const TONE_DOT: Record<StatusTone, string> = {
  blocked: "bg-fg ring-[3px] ring-fg/25",
  // `text-*` beside `bg-*` because the keyframe's ring is `currentColor` — one
  // animation, inked by whoever uses it.
  running: "bg-fg text-fg animate-blink",
  // **Not `running`'s blink**, which this table reserves two lines below for
  // "work actually happening" — and starting is precisely when none is. It is the
  // same sentence as `waiting` read from the live side (an agent is being put in
  // front of this conversation, nobody is deciding anything and nothing is being
  // asked of you), so it gets the same hollow pulse. It shared the loud one for as
  // long as starting meant "a session you just created", where a blink was at
  // least about something you were watching for; a settings change that restarts
  // the agent made it announce, for about a second, that an idle session was
  // working.
  starting: "border border-edge-strong bg-transparent animate-pulse",
  // Hollow, and that is the encoding rather than a lighter shade of the same
  // thing: this session is on its way *out*, so the mark is an outline of one.
  // The gentle `animate-pulse` stays — it is moving, but it is not asking for
  // anything, and the loud blink is reserved for work actually happening.
  stopping: "border border-edge-strong bg-transparent animate-pulse",
  // The same treatment for the same sentence read the other way round: the daemon
  // is bringing this one back. Nobody decides it, so it gets no emphasis.
  waiting: "border border-edge-strong bg-transparent animate-pulse",
  // Hollow and still. The honest drawing of "nothing is happening" — and now
  // genuinely distinct from the two states above, which it was not when all three
  // were a flat fill in slightly different greys.
  idle: "border border-edge-strong bg-transparent",
  ended: "border border-edge-strong bg-transparent",
  // Unused for these two: `StatusDot` draws a glyph instead. Kept as entries so
  // the record stays exhaustive over `StatusTone` and adding a tone is a compile
  // error here, which is the property this table exists to have.
  failed: "",
  stalled: "",
};

/** The two tones drawn as a shape rather than a dot. */
function drawnAsGlyph(tone: StatusTone): boolean {
  return tone === "failed" || tone === "stalled";
}

/** What a screen reader hears, since the dot says nothing at all to one. */
const TONE_TEXT: Record<StatusTone, string> = {
  blocked: "waiting for you",
  running: "running",
  starting: "starting",
  stopping: "stopping",
  waiting: "reconnecting after a restart",
  idle: "idle",
  ended: "ended",
  failed: "failed to start",
  stalled: "could not reconnect",
};

/**
 * A session's status as one dot, in three states a glance can tell apart.
 *
 * It replaces the words `idle` / `running` / `blocked` that used to sit beside
 * every session name. Two problems with those, and the second is the real one.
 * They cost the width a name needs on a 390px screen, and — because they are
 * ordinary text at ordinary weight — they read as *part of the row's content*
 * rather than as its state, so a list of eight sessions was eight lines each
 * ending in a word you had to actually read.
 *
 * The vocabulary is Claude Code's, and it is three states rather than eight:
 *
 * * **blinking** — the agent is working. Motion is the only thing on a list that
 *   is legible from across a desk, and it is spent on this one sentence rather
 *   than on anything else in this app. `animate-blink` and not Tailwind's
 *   `animate-pulse`: at 8px a two-second fade to half opacity reads as a static,
 *   slightly dim dot. See the keyframe in `index.css` for why it also glows
 *   rather than only fading.
 *
 *   It used to be one decision in two places: `WorkingDot` drew the same dot at
 *   the foot of a transcript, off the same keyframe and the same eight pixels.
 *   That is gone — the transcript's working row is `WorkingMark` in `ui/Mark.tsx`
 *   with a keyframe of its own — so `animate-blink` has exactly one user, which is
 *   what the driver asserts and why a stray second one would be worth catching.
 * * **bright, with a halo** — it is waiting for *you*. Deliberately the loudest
 *   thing a row can carry, and the ring is what makes it distinguishable from
 *   the pulsing state at a glance rather than only by colour, which is what a
 *   red/green pair asks of somebody who cannot see the difference. It is also,
 *   now, the *only* mark a blocked row carries: the warning triangle that used to
 *   sit in front of it is gone, for a layout reason rather than a legibility one.
 * * **dim** — nothing is happening. Idle, ended and stopped are all this: from
 *   the far side of a list they are one fact ("not now"), and the exact word is
 *   in the session's own header when it matters.
 *
 * `failed` keeps its own colour, because that one is not "not now" — it is a
 * thing that went wrong and is worth finding without opening anything.
 *
 * The status word is still on the row for a screen reader (`sr-only`), which is
 * the one reader for whom the dot says nothing at all.
 */
export function StatusDot({ session }: { session: SessionSnapshot }): ReactNode {
  // An unrecognised status from a newer daemon lands on `idle` through
  // `statusTone`'s default rather than drawing nothing — this file is a mirror
  // of the daemon's vocabulary and is allowed to be behind it, and a missing dot
  // would misalign the name beside it.
  const tone = statusTone(session);
  return (
    // A fixed 10px box with the mark centred in it, rather than the mark being
    // the box. `failed` is a glyph and the rest are 8px dots, and without a
    // reserved slot the two would sit the name beside them two pixels apart —
    // which is the "nothing in a row mounts sideways" rule at its smallest scale.
    <span
      className="inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center"
      title={TONE_TEXT[tone]}
    >
      {drawnAsGlyph(tone) ? (
        <Icon as={X} size={10} className="text-fg" />
      ) : (
        <span className={`inline-block h-2 w-2 rounded-full ${TONE_DOT[tone]}`} />
      )}
      <span className="sr-only">{TONE_TEXT[tone]}</span>
    </span>
  );
}

/*
 * `WorkingDot` was here, and it is `WorkingMark` in `ui/Mark.tsx` now.
 *
 * It was `TONE_DOT.running` reused, so the transcript's "working" row and a
 * running row in the rail were one object that could not drift. The transcript's
 * end of that is the product's mark blinking as three dots; the rail keeps the
 * dot, which is the right mark at 8px in a list. Named here rather than deleted
 * quietly, because "the same dot, one screen deeper" is an argument this file
 * makes twice above and a reader should find out where the second half went.
 */

/**
 * A machine's reachability, and anything else with the same three answers.
 *
 * Three tones rather than four, and the merge is a named loss. `ok`/`warn`/`off`/
 * `busy` were four *colours*; with the hue gone, `warn` and `off` would both be a
 * hollow static dot, i.e. two names rendering identically — which is worse than
 * three names, because the fourth would look maintained while saying nothing.
 *
 * The concrete casualty is `StreamDot`: it used to draw `connecting` (blue) apart
 * from `waiting` (amber), a backoff retry against a first connect. They are one
 * `pending` now. `SessionView` says which in words directly beside it, which is
 * where that distinction actually belonged — it was never legible at 8px anyway.
 */
export function Dot({ tone }: { tone: "on" | "pending" | "off" }): ReactNode {
  const style =
    tone === "on"
      ? "bg-fg"
      : tone === "pending"
        ? "border border-edge-strong bg-transparent animate-pulse"
        : "border border-edge-strong bg-transparent";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${style}`} />;
}

/**
 * A short fact about the row it sits on.
 *
 * Five tones became two, and the reduction is honest rather than lossy: every
 * non-plain use in this app — `admin`, `this device`, `disabled`, `no password`,
 * `not enrolled`, `N waiting` — meant the same thing, which is "this one is not
 * like the others". That is emphasis, and emphasis is weight.
 *
 * `strong` deliberately does not get a border or a heavier fill. A badge sits
 * inside a row that already has both, and a third box there reads as a control
 * somebody can press.
 */
export function Badge({
  children,
  tone = "plain",
}: {
  children: ReactNode;
  tone?: "plain" | "strong";
}): ReactNode {
  const style = tone === "strong" ? "bg-raised text-fg font-semibold" : "bg-raised text-muted";
  return (
    <span className={`rounded-sm px-1.5 py-0.5 text-2xs leading-tight font-medium ${style}`}>
      {children}
    </span>
  );
}

/**
 * Why a machine has no route, in the words shown to a person.
 *
 * This used to name which of two paths a machine was reached on, because "direct
 * stays primary" was a claim worth making visible. There is one path now, so what
 * is left is the four ways it can fail — and they are genuinely different things
 * to do about: a daemon that is not dialling in, a token this client could not
 * mint, a machine nobody enrolled, and a control plane that is itself down.
 */
const OFFLINE_TEXT: Record<NonNullable<OfflineReason>, string> = {
  no_route: "unreachable",
  no_token: "no token",
  not_enrolled: "not enrolled",
  cp_unreachable: "control plane unreachable",
  // Not a reachability failure but a reachability *consequence* — the tunnel is
  // refused at dial. One entry here buys the machine row's subline and
  // `MachineSystemsSection`'s "not reachable right now — …" line with no edit to
  // either, which is what this table is for.
  over_limit: "over the machine limit",
  owner_disabled: "its owner is disabled",
};

/**
 * A machine's reachability as a phrase, for a sentence somebody else is writing.
 *
 * ⚠ **The `unknown` arm was the bare string `"…"`, and every caller puts this
 * *inside* a sentence.** `MachineSystemsSection`, `MachineAgentsSection`,
 * `MachineSection` and `AgentBuilder` all compose `` `${machine.name} is not
 * reachable right now — ${reachText(…)}` ``, and `MachineSystemsSection` closes
 * with a bare `"."` where no system is named — so for the two or three seconds
 * before the first probe answers the screen read **"laptop is not reachable right
 * now — …."** — an ellipsis where the reason goes, under a claim that had not been
 * measured. An ellipsis is a *pause*; on its own it is not a phrase and cannot be
 * substituted into one.
 *
 * ⚠ **That list said `MachineSystemsSection`, `MachinePluginsSection` and
 * `MachineAgentsSection`, and it was wrong in both directions.**
 * `MachinePluginsSection` draws no reachability line at all any more — its one
 * caller, `MachineSection`, replaced all three of its lists with a single
 * sentence, and `webcheck` pins that section as saying neither half — while
 * `MachineSection` itself and `AgentBuilder` had joined the set with this docblock
 * still naming three screens, one of which had left. The set is four, and
 * `webcheck`'s `REACH_SCREENS` is the copy that has to agree with this one.
 *
 * "not checked yet" is the honest replacement, and it stays useful in the two
 * places that legitimately reach it: the machine row's subline, where it joins
 * `lastSeenText` as `not checked yet · seen 3m ago`, and `NewSession`'s
 * `unusableReason`, where it is why a machine cannot be started on *right now*.
 *
 * ⚠ **It is not a licence to keep drawing "is not reachable" over it.** That
 * sentence belongs to `daemonRead(reach) === "unreachable"` alone — the partition
 * in `machine.ts` exists so a screen branches on the state rather than papering
 * over it with a phrase that reads plausibly in the wrong sentence, which is
 * exactly how the ellipsis survived.
 *
 * `probing…` keeps its ellipsis because it is not a bare one: there is a word in
 * front of it, and it is the truthful trailing-off of a measurement in flight.
 */
export function reachText(reach: Reach, reason: OfflineReason): string {
  if (reach === "online") return "online";
  if (reach === "probing") return "probing…";
  if (reach === "unknown") return "not checked yet";
  return reason === null ? "unreachable" : OFFLINE_TEXT[reason];
}


/**
 * Why the daemon could not bring a session back, in the words shown to a person.
 *
 * The same shape as `OFFLINE_TEXT` above and for the same reason: these are the
 * distinct things somebody can *do something about*, and the daemon's own code
 * is the one vocabulary both the automatic and the manual path answer with —
 * `describeResumeFailure` in `registry.ts` is where they are minted.
 *
 * An unknown code **falls open**: the daemon's own message, and a retry offered.
 * That is `wire.ts`'s rule for this whole mirror — a client that is behind the
 * daemon must degrade to passing its words through, not to refusing an action
 * that might well work.
 */
export function resumeFailureText(
  code: string,
  message: string,
  agent: string,
  machine: string,
): string {
  switch (code) {
    case "no_agent_session_id":
      return "there is no agent conversation to reconnect to";
    case "resume_unsupported":
      return `${agent} cannot reattach to an earlier conversation`;
    // Deliberately about the *agent's* memory rather than about this session:
    // the transcript on this side is intact and still readable, which is the
    // half a reader is most likely to fear for.
    case "agent_forgot_session":
      return `${agent} no longer has this conversation — the transcript here is intact`;
    case "workspace_missing":
      return "this session's folder is gone";
    case "workspace_unresponsive":
      return "this session's folder is not answering";
    case "agent_unavailable":
      return `${agent} is not installed on ${machine}`;
    case "agent_start_timeout":
      return `${agent} did not start in time`;
    case "agent_auth_required":
      return `${agent} is not signed in on ${machine}`;
    default:
      return message;
  }
}

/**
 * Whether offering a Resume button would be honest.
 *
 * Only the two that cannot ever work are refused. `workspace_missing` is
 * retryable on purpose — the folder can be put back, and a person who has just
 * done that should not have to find another door.
 */
export function resumeRetryable(code: string): boolean {
  return (
    code !== "no_agent_session_id" &&
    code !== "resume_unsupported" &&
    // The agent has told us the conversation is gone. Offering a button that
    // spawns an agent to be told the same thing is worse than offering none —
    // it is the daemon's own reason for never trying again, drawn as a promise.
    code !== "agent_forgot_session"
  );
}

/**
 * The one line under a session's transcript explaining why it is not running.
 *
 * Pure and here rather than inline in `SessionView`, because the copy rules are
 * the part worth asserting: `webcheck` states that a session the daemon
 * interrupted says neither the word "ended" nor any raw `ExitReason` token, and
 * that a stopped one still says exactly what it always did.
 *
 * `detail` and `agentConfirmedDead` are printed for an ended session and
 * **suppressed** for an interrupted one. That asymmetry is deliberate: both are
 * daemon plumbing, and "(agent not confirmed dead)" under a routine deploy is
 * alarming, meaningless to the reader, and about a process that is being
 * replaced anyway. On a session somebody stopped it is the difference between
 * "stopped" and "probably orphaned", which is worth their knowing.
 */
/**
 * A line under the transcript, and the one thing to do about it.
 *
 * `action` rather than a `retry` boolean, because the remedies are mutually
 * exclusive and a second boolean beside the first could claim both at once — a
 * state that means nothing and would draw two buttons. `null` is the ordinary
 * case: most notices are a fact with nothing to press.
 */
export interface SessionNotice {
  tone: "quiet" | "warn";
  text: string;
  /**
   * `reconnect` re-runs the resume this daemon gave up on. `sign_in` goes to the
   * agent's own screen on this machine — the conversation is not broken, nobody
   * is signed in to the thing that answers it.
   */
  action: "reconnect" | "sign_in" | null;
}

/**
 * How a conversation ended, in words rather than in the daemon's identifier.
 *
 * ⚠ This line drew `ended: ${session.exit.reason}` — `ended: agent_exited`,
 * `ended: start_timeout` — which is a wire enum printed at somebody who is
 * looking at their own conversation to find out what happened to it. `TONE_TEXT`
 * one screen up is this app's one human-facing status vocabulary and had no
 * counterpart for the reason a session is over; this is it.
 *
 * `agent_signed_out` is deliberately **not** here. It is answered above, as a
 * whole sentence with a button beside it, because it is the one exit with a
 * remedy — and a row in this table would be a second, worse answer competing with
 * that one.
 *
 * The three daemon reasons are not here either, for the structural reason rather
 * than a stylistic one: `waitingForDaemon` catches every one of them above, so a
 * value from `DAEMON_EXIT_REASONS` cannot reach this line. They are left out
 * rather than written down wrong.
 *
 * **The unknown arm keeps the identifier**, like every other place in this client
 * that meets a wire value it does not know: a newer daemon's reason is drawn as
 * itself — legible, and never a guess about what it meant.
 */
const EXIT_TEXT: Partial<Record<ExitReason, string>> = {
  stopped: "you stopped this conversation",
  agent_exited: "the agent exited",
  start_failed: "the agent could not be started",
  start_timeout: "the agent did not start in time",
  agent_kill_failed: "the agent could not be stopped",
};

export function exitText(reason: ExitReason): string {
  return EXIT_TEXT[reason] ?? `ended: ${reason}`;
}

export function sessionNotice(
  session: SessionSnapshot,
  agent: string,
  machineName: string,
): SessionNotice | null {
  if (session.exit === null) return null;
  if (resumeStalled(session)) {
    const error = session.resume?.error;
    const code = error?.code ?? "no_agent_session_id";
    /*
     * **This is where "sign in" is earned, and it is the only place.**
     *
     * `agent_auth_required` means the daemon *tried* — spawned the CLI, asked it
     * to reopen the conversation, and was refused — so "not signed in" here is a
     * measurement rather than a memory. The exit-reason branch below used to make
     * the same claim off a row that could not know, which is how somebody whose
     * CLI had refreshed its own token was sent to a screen they were already
     * signed in to.
     *
     * Retrying is still the right answer for every other failure, and offering
     * both would be the two-remedies-at-once this type has one field to prevent.
     */
    return {
      tone: "warn",
      text: `could not reconnect the agent — ${resumeFailureText(code, error?.message ?? "", agent, machineName)}`,
      action:
        code === "agent_auth_required" ? "sign_in" : resumeRetryable(code) ? "reconnect" : null,
    };
  }
  if (waitingForDaemon(session)) {
    /*
     * **A wait with a reason says the reason.** The daemon defers a session whose
     * harness has no CLI on the machine yet — `waiting`, no attempt spent, and
     * the refusal on the snapshot — because its installer is already scheduled
     * and the session comes back when the install lands. Drawn as the plain
     * restart line, that read as a reconnect in progress for the whole wait:
     * minutes at best, and for good on a machine whose updates are off. So the
     * one waiting state that carries an error draws it — the short sentence
     * `resumeFailureText` already has for the code, never `error.message`, which
     * is the daemon's paragraph naming a script to run.
     */
    const deferred =
      session.resume?.state === "waiting" && session.resume.attempts === 0 && session.resume.error?.code === "agent_unavailable";
    return {
      tone: "quiet",
      text: deferred
        ? `${resumeFailureText("agent_unavailable", "", agent, machineName)} — waiting for it to be installed`
        : session.resume?.state === "running"
          ? "reconnecting the agent…"
          : "the daemon restarted — reconnecting the agent",
      action: null,
    };
  }
  /*
   * **The one exit with a remedy, so it gets a sentence rather than its name.**
   *
   * Every other reason here is either self-explanatory (`stopped`) or something
   * nobody can act on from this screen. This one ended the conversation *because
   * a credential went away*, and printing `ended: agent_signed_out` would withhold
   * the only useful half of what the daemon said.
   *
   * ⚠ **It said "nobody is signed in to claude on <machine>. Sign in and this
   * conversation comes back." Both halves could be false at once, and were.**
   *
   * This is a record of something that happened, drawn in the present tense.
   * Nothing re-checks it: the row keeps its exit reason for ever, and the daemon's
   * own login probe — which is live, three seconds fresh, and was reporting
   * `loggedIn: true` throughout — is not consulted here or anywhere near here. So
   * an expired OAuth token that the CLI then refreshed on its own left this
   * sentence asserting the opposite of the truth. And the promise was not kept
   * either: `reloadCredentials` is the only thing that reverses this reason, and
   * every one of its callers is an in-app credential *write*, so signing in from
   * a terminal — or the CLI refreshing itself — reached none of them. The button
   * went to a screen where you were already signed in.
   *
   * So the sentence is about the past, which is the only thing this row knows,
   * and the action is **Reconnect** — `POST /sessions/:id/resume`, which calls
   * `managed.resume()` with no `autoResumable` gate and has always been able to
   * bring these back. It was simply never offered here. Signing in is still one
   * tap away on the machine's own screen, and is no longer the only way out of a
   * state a person cannot otherwise leave.
   */
  if (session.exit.reason === "agent_signed_out") {
    return {
      tone: "quiet",
      text: `${agent} could not authenticate on ${machineName}, so this conversation stopped.`,
      action: "reconnect",
    };
  }
  const detail = session.exit.detail === null ? "" : ` — ${session.exit.detail}`;
  const orphan = session.exit.agentConfirmedDead ? "" : " (agent not confirmed dead)";
  return { tone: "quiet", text: `${exitText(session.exit.reason)}${detail}${orphan}`, action: null };
}

export function Spinner(): ReactNode {
  return (
    <span
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-edge border-t-fg"
      aria-hidden="true"
    />
  );
}

/**
 * The sentence a pane draws when it has no rows — and, now, the difference
 * between having none and not having been able to ask.
 *
 * ⚠ **One `<p>` was serving at least eight materially different states.** A list
 * that is genuinely empty (`Nothing installed on this machine.`), a search that
 * matched nothing, a machine that has been revoked, a read that *failed*
 * (`Could not read this machine's agents.`), a catalogue host that could not be
 * reached, an offline notice. All of them arrived as centred grey text with
 * nothing to press — so a failure that a tap would fix was drawn identically to
 * an emptiness nobody can act on, and from a dead machine's systems screen the
 * one way out led to a screen showing the same sentence again.
 *
 * **The partition is absence against failure, and it is a claim about the
 * world rather than about the wording.** An *absence* is a true, settled answer:
 * this list is empty, that machine is not yours any more, nothing matches what
 * you typed. A *failure* is the absence of an answer: something was asked and did
 * not come back. Only the second one can be retried, and only the second one is
 * an event.
 *
 * That is why exactly one of them is announced. `role="status"` makes this a
 * live region, and a genuinely empty list is a **state** a reader has already
 * been told about by the thing they just did — narrowing a filter, opening a
 * fresh machine — so announcing "nothing here" on every keystroke is noise in
 * the one channel that cannot be skimmed. A failure is something that *happened*,
 * with nothing else on screen to say so, which is the definition of what a live
 * region is for. `Toast` draws the same line one notch louder: an error there is
 * `role="alert"` because it is transient and 8 seconds from being gone, while
 * this stays on screen until somebody acts, so `status` is enough.
 *
 * A failure also changes the **drawing**, not only the text: it takes the leading
 * `AlertTriangle` this app already uses for a failure in `Toast` and in
 * `EventList`'s transcript notice, and its sentence sits at `text-fg` rather than
 * `text-muted`. The glyph is doing the work for the reason `TONE_DOT` gives at
 * the other end of the scale — a shape survives greyscale, reduced motion and a
 * phone in sunlight, and this palette has no hue left to spend.
 *
 * `action` is a `ReactNode` rather than a label and a callback, because the
 * remedies are not one shape: a {@link Button} that re-runs a read, a `<Link>`
 * back to a list that still exists, an `IconButton` row. It is drawn under the
 * sentence with real spacing and centred under it, and it is available to an
 * absence too — "No machines yet" has an obvious next move, and having one does
 * not make it a failure.
 *
 * ⚠ **The plain case returns byte-identically to what it always did**, by
 * early-returning rather than by a container that happens to collapse to the
 * same thing. **32 of the 55 call sites** pass text and nothing else, and this
 * primitive is drawn in list bodies, sheet panes and the transcript — so
 * "probably the same box" is not good enough, and a structural change to all of
 * them belongs to whoever is looking at those screens.
 *
 * ⚠ That count read *"roughly forty"* and had not been taken. Counted over
 * `packages/web/src` with comments stripped: **55** call sites, of which **32**
 * are written `<Empty>` with no props at all and **23** carry `failed`, `action`
 * or both. All 23 arrived with the release that added those props, because before
 * it there was no second branch to reach — which is exactly the movement a round
 * figure cannot record, forty having been a fair description of the whole set and
 * a poor one of this half. Stated as a count so the next reader retakes it rather
 * than inherits it.
 */
export function Empty({
  children,
  /**
   * This is the absence of an *answer*, not an answer of "none".
   *
   * A boolean rather than a `kind` union, and that is not the shortcut it looks
   * like next to {@link SessionNotice}'s `action`: that one is a union because
   * its remedies are mutually exclusive, so a second boolean beside the first
   * could claim both at once and draw two buttons. Here there are exactly two
   * states and they are complementary, so a boolean *is* the two-way partition —
   * there is no third value for it to fail to express, and no pair to disagree.
   */
  failed = false,
  /** The one thing to do about it, drawn under the sentence. */
  action,
}: {
  children: ReactNode;
  failed?: boolean;
  action?: ReactNode;
}): ReactNode {
  // Unchanged, deliberately and provably: same element, same classes, same
  // whitespace. See the ⚠ above — the call sites that pass only text are not
  // part of this change.
  if (!failed && action === undefined) {
    return <p className="px-4 py-6 text-center text-sm text-muted">{children}</p>;
  }
  return (
    // `status` only on the failure, which is the whole partition in one
    // attribute. `undefined` rather than `"presentation"` or an empty string:
    // React omits the attribute entirely, so an absence is an ordinary `<div>`
    // and no assistive technology is watching it.
    <div role={failed ? "status" : undefined} className="px-4 py-6">
      <p
        className={
          failed
            ? // `items-start` so the triangle sits on the *first* line rather
              // than in the middle of a sentence that wraps, and
              // `justify-center` so a short one still lands in the middle of the
              // pane like every other `Empty`. A wrapping one fills the width and
              // reads as glyph-then-paragraph, which is what `Toast` and the
              // transcript notice already look like.
              "flex items-start justify-center gap-1.5 text-sm text-fg"
            : "text-center text-sm text-muted"
        }
      >
        {failed && (
          // `text-muted` on the glyph, against `text-fg` on the words: the mark
          // says *which kind* of nothing this is and the sentence says what
          // happened, so a triangle louder than the text it introduces would
          // invert that. `mt-0.5` is the nudge `Toast` already gives a 14px
          // glyph sitting beside a line of text.
          <Icon as={AlertTriangle} size={14} className="mt-0.5 text-muted" />
        )}
        <span>{children}</span>
      </p>
      {/* `mt-3` rather than a margin on whatever the caller passed: a remedy that
          is 12px under the sentence reads as part of it, and a caller cannot
          reliably add that margin from outside — see {@link FIELD} for why
          appending a utility to a shared string does not work here. */}
      {action !== undefined && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * A placeholder row with the shape of the thing that is coming.
 *
 * A bare centred spinner says the app is busy; this says what it is busy with,
 * and stops the page jumping when the real rows arrive.
 */
export function Skeleton({ rows = 3 }: { rows?: number }): ReactNode {
  return (
    <div aria-hidden="true">
      {/* No separator: rows in this app are held apart by whitespace now, and a
          skeleton that draws rules the real rows do not have makes the list jump
          the moment it loads. */}
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-2 px-4 py-3.5">
          <div className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-edge" />
          <div className="min-w-0 flex-1">
            <div className="h-3 w-1/3 animate-pulse rounded-sm bg-edge" />
            <div className="mt-1.5 h-2.5 w-2/3 animate-pulse rounded-sm bg-edge/60" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The shape of a conversation that has not arrived yet.
 *
 * A sibling of {@link Skeleton} rather than a `rows` variant of it: that one is a
 * *list row* — a status dot and two lines, at its own `px-4 py-3.5` — and a
 * transcript is neither of those things. Reusing it would also double the `px-4`
 * the transcript's column already carries.
 *
 * **It exists because "nothing" was being drawn as an answer.** On a cold reload
 * the socket replays no history at all (`reattachSince` attaches at the tail), so
 * the whole conversation arrives over HTTP a moment later — and the transcript
 * drew nothing in the meantime, on the strength of a measurement taken over a
 * LAN. Over a relay from a phone that gap is seconds, and what stayed on screen
 * was the one line that does not come from the transcript: `working…`, alone, on
 * a session with hundreds of messages in it.
 *
 * The alternation is the point — an agent paragraph, then a right-aligned block
 * where your own message goes — so the swap to real content is a paint rather than
 * a re-layout. `bg-raised` for the message you wrote and `bg-raised/50` for
 * everything else is the transcript's own ranking (see `index.css`), so this reads
 * as the shapes it stands in for instead of as generic grey.
 *
 * ⚠ No `animation-delay` trick to hide the sub-100ms case. Under
 * `prefers-reduced-motion` this app collapses every animation to a single 0.01ms
 * iteration with no `fill-mode`, so an element started at `opacity-0` would run
 * its cycle and revert — permanently invisible for exactly the people least able
 * to afford a blank screen.
 */
export function TranscriptSkeleton(): ReactNode {
  const bar = (width: string, tone = "bg-raised/50"): ReactNode => (
    <div className={`h-3.5 ${width} animate-pulse rounded-sm ${tone}`} />
  );
  return (
    <div aria-hidden="true" className="space-y-4 py-2">
      <div className="space-y-1.5">
        {bar("w-4/5")}
        {bar("w-3/5")}
      </div>
      <div className="flex justify-end">
        <div className="h-9 w-1/2 animate-pulse rounded-lg bg-raised" />
      </div>
      <div className="space-y-1.5">
        {bar("w-3/4")}
        {bar("w-2/5")}
      </div>
    </div>
  );
}

export type ButtonTone = "primary" | "plain" | "destructive" | "ghost";

/**
 * Four tones, and one rule that binds them together across the whole app.
 *
 * **A `bg-fg` fill is only ever the reversible option.** That generalises the rule
 * `AskCard` already lives by — "the refusal alone on the left, the reversible
 * approval filled on the right" — to every row of buttons anywhere here. Its
 * consequence is the part worth stating out loud, because it looks backwards: a
 * destructive button is **never** the filled one, so in a two-step confirmation
 * the filled button is **Cancel**.
 *
 * Without that rule "filled" would mean *the safe default* on the ask card and
 * *the irreversible one* in settings, which is worse than encoding nothing —
 * somebody would learn the wrong one first.
 *
 * `destructive` therefore reads as an outlined button, and on its own it is not
 * enough. It is never reached directly: {@link DangerButton} is the only door, and
 * it requires a glyph.
 */
/**
 * ⚠ **Disabled dims the ink and keeps the box, and on an outlined tone the box is
 * the whole control.**
 *
 * `disabled:opacity-40` used to ride the base string for all four, and on an
 * outlined button that is not a dimming — it is a *deletion*. `--color-edge-strong`
 * is held at ≥3:1 precisely because a control drawn in the colour of what it sits
 * on has its border as its **only** identification, and 40% of that is ~1.2:1: the
 * hairline `index.css` forbids for exactly this job. So a disabled `plain` button
 * had no boundary at all, and the moment one became live it read as having *grown*
 * — reported in those words, off a strip of four where three are inert most of the
 * time. Nothing about the box ever changed: `min-h-11 px-3` in both states, and
 * `opacity` cannot move layout.
 *
 * ⚠ **That fix replaced the opacity with `disabled:border-edge`, which is the same
 * deletion spelled as a token.** #E3E1DD on `surface` measures 1.31:1 — the value
 * the paragraph above calls a hairline, arrived at on purpose the second time. The
 * button it cost the most is the agent builder's **Add agent**: it is disabled for
 * the whole of a three-screen flow and becomes pressable on the last tap, so for
 * that entire flow the thing the screen is aiming at had no fill, faint type and no
 * boundary — a static caption sitting where a button goes. The boundary stays at
 * `edge-strong` on both outlined tones now and only the *label* dims, which is what
 * "dims the ink and keeps the box" was meant to say in the first place.
 *
 * `destructive` gives up its hue along with its label, and takes the same
 * `edge-strong` box rather than keeping its own: `border-danger/45` is
 * `--color-danger` #7e362b at 45% over `surface` #ffffff, which composites to
 * #C5A5A0 and measures **2.27:1** — so it was never the identification either.
 *
 * ⚠ That number read **2.11:1** here from the day this paragraph was written, and
 * the correction is arithmetic rather than a reversal: 2.27 is still well under the
 * 3:1 WCAG 1.4.11 asks of a non-text control with no fill of its own, which is the
 * whole of what the sentence above rests on. Recomputed per channel —
 * `0.45·126 + 0.55·255 = 197`, `0.45·54 + 140.25 = 165`, `0.45·43 + 140.25 = 160`
 * — then through the sRGB relative-luminance formula against white. What identifies
 * that tone is {@link DangerButton}'s required glyph and the `text-danger` label,
 * and a disabled row has stopped claiming both. A control that cannot act must not
 * be the one red thing in a view.
 *
 * ⚠ **{@link ChoiceRow} and the agent tile in `NewSession.tsx` do the opposite —
 * they hand the boundary back when disabled — and that is one rule read on two
 * shapes rather than two rules.** A button here is a lone control: nothing beside
 * it is pressable, so the only question its border answers is *is there a control
 * here at all*, and the `Add agent` flow above is the measurement of answering it
 * wrong. A row in a picker is one of a run of siblings that differ only in whether
 * they can be taken, so its border is answering *which of these can I press* —
 * there the strong edge on a refused row claims something false, and WCAG 1.4.11
 * exempts an inactive component from the 3:1 that would otherwise require it. The
 * split has a second half that points the same way: those rows carry their own
 * refusal as a subline and a button carries none, which is why `opacity` merely
 * erased a boundary here and would have erased a *reason* there.
 *
 * `primary` and `ghost` keep the opacity, because neither has a boundary to lose —
 * one is a fill and the other is bare text.
 *
 * `disabled:bg-surface` is untouched and is the one clause here that is not about
 * the boundary: `:hover` still matches a disabled `<button>`, so the ground has to
 * be held under a pointer that is going to get nothing.
 */
const BUTTON_TONE: Record<ButtonTone, string> = {
  primary: "bg-fg text-ink hover:bg-fg/85 disabled:opacity-40",
  // Hover moves the *fill*, not the border. See `--color-edge-strong` in
  // `index.css`: the gap between the two line weights is now large enough that
  // swapping them on hover is a louder change than the press itself.
  plain: "border border-edge-strong bg-surface text-fg hover:bg-raised disabled:bg-surface disabled:text-faint",
  destructive:
    "border border-danger/45 bg-surface text-danger font-medium hover:bg-danger/10 disabled:border-edge-strong disabled:bg-surface disabled:text-faint",
  ghost: "text-muted hover:bg-raised hover:text-fg disabled:opacity-40",
};

/**
 * The two sizes a button comes in, as a **prop rather than a `className`**, and
 * that is a correctness fix rather than an ergonomic one.
 *
 * `className` is appended to the base string, which makes it look as though a
 * caller can pass `min-h-9 px-2` and get a smaller button. It cannot: Tailwind
 * emits every utility into one stylesheet at equal specificity, so what wins is
 * the order **in the sheet**, not the order in the attribute — and `min-h-11`
 * sorts after `min-h-9`. Measured on the shipped CSS, a button written
 * `className="min-h-9 px-2 text-xs"` reported `min-height: 44px` and
 * `padding-left: 12px`: only the non-conflicting `text-xs` took effect. The
 * failure is silent in both directions, which is what makes it worth a prop —
 * the caller reads their own source and sees a request that was never refused.
 *
 * `md` is 44px, the platform tap minimum, and it stays the default on **every**
 * tone rather than only the primary one — the deny button is the one somebody is
 * most likely to be aiming at carefully.
 *
 * ⚠ **`sm` was reserved for one shape, the reservation expired, and it carries a
 * coarse-pointer floor now.** This entry read *"`sm` is for the one shape that has
 * earned it: a confirmation that has replaced the controls on a settings row, so
 * it is the only thing on that row and has nothing adjacent to mis-hit"* — and on
 * that premise it was 36px with no floor of any kind. It is on **46** `Button` call
 * sites, and **15** of them are the exact opposite of the shape it was reserved
 * for: they sit inside an {@link Empty}'s `action`, where the button is the only
 * thing on an otherwise empty pane — seven in `AgentBuilder`, two each in
 * `AgentsPanel`, `PluginScreen` and `PluginSettings`, and the *All machines* door
 * on `MachineSystemsSection` and `MachineAgentsSection`. A reservation stated in a
 * docblock and enforced by nothing is not a reservation.
 *
 * Most of them arrived alongside {@link Empty}'s `action`, in the same change that
 * **deleted** `ICON_BUTTON_SIZE.md` — 36px, the default, no growth mechanism —
 * whose argument was that *the call site that thinks about its target least got
 * the one size that was wrong*. That argument
 * applies here word for word, so the fix is in the primitive rather than at 46 call
 * sites, which is the leverage {@link Empty} was given one screen up. A handful of
 * callers had already written `[@media(pointer:coarse)]:min-h-11` into their own
 * `className` by hand — which is the shape of a defect nothing can fix for you, and
 * is why this is not left to them. Those are redundant rather than wrong now, and
 * `webcheck` already spells that exact escape as `COARSE_FLOOR`, so it keeps
 * passing on the ones that still carry it.
 *
 * ⚠ **The floor sits in the same class string as the height it has to beat, so it
 * is only a floor if the sheet emits it later — measured, not assumed.** Measured
 * on the built bundle, `packages/web/dist/assets/index-*.css`, 57263 bytes:
 * `.min-h-9{…}` is written at byte 15133, among the unprefixed utilities; the
 * `@media (pointer:coarse){…}` block opens at 46531 and holds
 * `.[@media(pointer:coarse)]:min-h-11{min-height:calc(var(--spacing) * 11)}` at
 * 46700. Both selectors are a single class, `(0,1,0)`, and a media query adds
 * **no** specificity, so the later rule wins and a finger gets 44px. A fine
 * pointer never matches that query, so `sm` looks exactly as it did.
 *
 * The stylesheet came back **byte-identical** to the build before this change,
 * down to the content hash — `FIELD`, `SEARCH_FIELD` and the call sites that wrote
 * it by hand had already put that class in the sheet — which is the other half of
 * the measurement: no new rule was emitted, so nothing about the order above is a
 * position this change happened to land in.
 *
 * ⚠ One thing the same measurement corrects, because this file states the trap in
 * two shorthands and only one of them survives it. {@link menuRow} says Tailwind v4
 * emits **alphabetically**, and for a *word* scale that holds — `.items-center`
 * before `.items-start`, which is the defect it records. A **numeric** scale is
 * emitted in numeric order instead: `.min-h-8`, `.min-h-9`, `.min-h-10`,
 * `.min-h-11` in that sequence, and `.h-9` (14077) before `.h-11` (14153). So
 * "alphabetical" predicts the wrong winner exactly where two numbers straddle ten,
 * which is where every tap-target argument in this file lives. That is the second
 * reason the floor is written as the variant rather than as a bare `min-h-11`: the
 * variant block's position does not depend on which two numbers are racing.
 */
const BUTTON_SIZE = {
  md: "min-h-11 px-3 text-sm",
  sm: "min-h-9 px-2.5 text-xs [@media(pointer:coarse)]:min-h-11",
} as const;

export type ButtonSize = keyof typeof BUTTON_SIZE;

export function Button({
  children,
  onClick,
  tone = "plain",
  size = "md",
  disabled = false,
  type = "button",
  title,
  className = "",
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: ButtonTone;
  size?: ButtonSize;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
  className?: string;
  ariaLabel?: string;
}): ReactNode {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={`tap press inline-flex items-center justify-center gap-1.5 rounded-md font-medium ${BUTTON_SIZE[size]} ${BUTTON_TONE[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * The only door to the destructive look, and the glyph is why it exists.
 *
 * With one colour left in the palette and a rule that a destructive control is
 * never the filled one, `tone="destructive"` on its own is an outlined button
 * among outlined buttons — on `UsersSection`'s row there are five, and exactly one
 * of them deletes a person. A leading glyph is the strongest cue left at 13px,
 * because it is a *shape* difference rather than a value one.
 *
 * "Must lead with an icon" cannot be expressed as a type on `children`, so it is
 * expressed as a component that takes the icon as a required prop instead.
 * `webcheck` asserts that `tone="danger"` appears nowhere under `src/ui/`, which
 * is what keeps this the only door rather than the polite one.
 *
 * It is **not** the whole answer, and the other two halves are elsewhere by
 * necessity: the two-step confirmation with Cancel last (the property that was
 * actually measured — a second tap on a laggy connection lands on the undo), and
 * the rule at {@link BUTTON_TONE} that the filled button in that pair is Cancel.
 */
export function DangerButton({
  icon,
  children,
  onClick,
  size = "md",
  disabled = false,
  title,
  className = "",
}: {
  icon: ComponentType<{ size?: number | string; className?: string; "aria-hidden"?: boolean }>;
  children: ReactNode;
  onClick?: () => void;
  size?: ButtonSize;
  disabled?: boolean;
  title?: string;
  className?: string;
}): ReactNode {
  return (
    // `size` is forwarded rather than left to `className`, for the reason
    // {@link BUTTON_SIZE} gives: a size passed as a utility class is silently
    // dropped, and this is one half of a confirming pair — a Delete that stayed
    // 44px beside a Cancel that shrank would break the ordering rule by making
    // the two answers different shapes.
    <Button tone="destructive" size={size} onClick={onClick} disabled={disabled} title={title} className={className}>
      <Icon as={icon} size={13} />
      {children}
    </Button>
  );
}

/*
 * The surface vocabulary the overlay layer is built from.
 *
 * Material only — radius, border, fill, shadow, padding. **No `z-index` here**:
 * the layering decision lives in `ui/overlay.ts` as one ordered table, because an
 * ordering that is spread across the files it orders is one nothing can assert and
 * everybody is free to reverse. `Sheet` composes the two.
 *
 * The panel is a **bottom sheet on a phone and a centred card above `sm`**, in one
 * class string, decided by CSS. It leaves a sliver of the app visible above it,
 * which is what says "over" rather than "instead of" — and doubles as the
 * tap-to-close target. `dvh` and not `vh` for `AppShell`'s own reason: with a
 * collapsing mobile toolbar those are different numbers.
 *
 * **`h-`, not `max-h-`, and that is the whole of "a pop-up never changes size".**
 * With a ceiling and no floor the panel was content-sized — measured on this exact
 * chain at 155px, 475px and 492px for two, twelve and eighty lines of body — so
 * every step through the settings list resized the window it was drawn in, under a
 * pointer already aimed at the next row. A dialog that moves while you read it is
 * the one thing a dialog must not do, and the size is not information: it is a
 * side effect of which section happened to be shortest. The head and the foot are
 * `shrink-0` and the body is `flex-1`, so a definite height lands where it should
 * whether or not a caller passes a footer.
 */
export const SHEET_PANEL =
  "pb-safe animate-sheet sm:animate-rise relative flex h-[92dvh] min-h-0 w-full flex-col overflow-hidden rounded-t-2xl border-t border-edge bg-surface shadow-2xl sm:h-[min(44rem,88dvh)] sm:max-w-2xl sm:rounded-2xl sm:border sm:pb-0";
/** Title left, waiting count and ✕ right. 56px, and it never scrolls. */
export const SHEET_HEAD =
  "flex min-h-14 shrink-0 items-center gap-2 border-b border-edge px-4 sm:px-5";
/**
 * The one padding for anything inside a sheet.
 *
 * **`flex flex-col` is the load-bearing half and it was missing**, which is why no
 * pop-up in this app scrolled at all. Both callers write `min-h-0 flex-1` on their
 * top child — Settings for its rail-beside-section row, `NewSession` for the
 * column ending in the folder list — and in a *block* container those two
 * properties do nothing. So every intended inner scroller sized to its own content
 * instead, and had no scroll range: measured, `scrollHeight === clientHeight` at
 * 2592px inside a 433px viewport.
 *
 * The second half is why that did not merely fall back to scrolling *this* box.
 * Those dead containers still carried `overscroll-contain`, and Chrome ends the
 * scroll chain at a container with `overscroll-behavior: contain` **even when it
 * has nothing to scroll** — so the pointer was always over a descendant that
 * refused to pass the wheel on to the one element that could move. Measured on the
 * shipped structure: the same wheel gesture moved 400px with `overscroll-contain`
 * removed and 0px with it present. Giving this box a flex context fixes both at
 * once, because the children become real scrollers and their `overscroll-contain`
 * becomes true rather than merely stated.
 *
 * **`bg-surface` is what makes the section slide legible, and its absence was the
 * whole of "the previous screen's text is still there".** This box carries the
 * `view-transition-name` the horizontal slide moves, and a named element is
 * *lifted out of its ancestor's snapshot* — so with the fill left to the panel,
 * both snapshots were transparent images of nothing but glyphs. Measured
 * mid-flight at 390px: the arriving section's fields and the leaving list's rows
 * were both fully legible, drawn on top of one another over the panel's own fill.
 * A slide needs the pane that arrives to *cover* the one it replaces, which is a
 * property of the element rather than of the animation. Same colour as the panel
 * behind it, so nothing about the sheet at rest changes.
 *
 * That is `AppShell`'s rule for the rail and the pane — every surface paints its
 * own ground, none falls through — reaching the one box that had been getting
 * away with it because nothing had ever moved it before.
 */
export const SHEET_BODY =
  "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-surface px-4 py-5 sm:px-5";
/** Actions right, Cancel last — see {@link BUTTON_TONE}. */
export const SHEET_FOOT =
  "flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-edge px-4 py-3.5 sm:px-5";

/**
 * One screen inside a sheet whose screens have their own action bars.
 *
 * ⚠ **The bar goes *inside* `SHEET_BODY` rather than in `Sheet`'s `footer`, and
 * that is what stops a pop-up resizing between its own screens.** `SHEET_PANEL`
 * is a definite height, so the panel never moves — but the body is what is left
 * after the head *and the footer*, and a footer that only some screens carry
 * makes the body two different heights. The body is the box the section slide
 * animates: `view-transition-name: sheet-body` hangs off it, and a group whose
 * old and new boxes differ morphs between them. Measured at 390px going from New
 * session (footer) to New agent (none): the pane's top edge travelled 57px
 * *downwards* over the 220ms slide, which reads as the screen you were on
 * collapsing rather than leaving sideways.
 *
 * With the bar in here the body's box is identical on every screen of the sheet,
 * the group has nothing to morph, and the bar slides with the screen it belongs
 * to — which is also the truthful animation, since the action *is* part of the
 * screen. `Sheet`'s `footer` stays for the pop-ups with one screen. Q3.472.
 *
 * Cancels `SHEET_BODY`'s own padding so the bar reaches both edges;
 * {@link SHEET_SCROLL} puts it back on the part that scrolls.
 */
export const SHEET_SCREEN = "-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-5";
/** The scrolling half of a {@link SHEET_SCREEN}: everything above the bar. */
export const SHEET_SCROLL =
  "min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-5";
/**
 * The small anchored popover's chrome.
 *
 * Distinct from {@link MENU_PANEL} in exactly one way — no `max-h`/scroll — because
 * this holds a handful of fixed rows rather than a list, and a scrollbar on a
 * three-row menu is a claim there is more.
 */
export const POPOVER = "rounded-lg border border-edge bg-surface p-1.5 shadow-lg";

/**
 * Three sizes, and **every one of them reaches 44px**. That is the property this
 * table now has and did not.
 *
 * They get there by three different mechanisms because the neighbours differ, and
 * the argument for which is right where is in the file's own docblock at the top
 * ("Two ways to reach 44px…"). `sm` is 24px of ink inside a symmetric transparent
 * `::after`; `chip` is 32px inside a vertical-only one; `lg` is 44px of box. The
 * one thing they no longer differ on is whether they clear the floor at all.
 *
 * ⚠ **There was a fourth, `md` — `h-9 w-9`, 36px, with no growth mechanism of any
 * kind — and it was the *default*.** So omitting the prop yielded the one entry
 * that missed the platform tap minimum, which is the worst possible thing for a
 * default to do: the call sites that thought least about their target got the
 * only size that was wrong. `webcheck` wrote the finding down in those words —
 * **"routed through the primitive" was never the same thing as "44px"** — after
 * its old sweep had skipped every `IconButton` call site on exactly that premise.
 *
 * It is deleted rather than resized, and the difference matters: resizing it to
 * `h-11` would have silently moved every layout that had settled around a 36px
 * box, while deleting it makes each of those call sites name what it wants. The
 * `md` name is gone for good — a size that reappears under a name a reader
 * remembers as 36px is worse than no size at all.
 */
const ICON_BUTTON_SIZE = {
  /**
   * 24px of ink, 44px of target.
   *
   * The box has to stay small — this is the kebab on a list row, and a menu
   * button that visually outweighs the row it sits on is the thing `sm` exists
   * to prevent. But 24px is well under the 44px named on `lg` below, and this
   * particular 24px sits directly beside the row's own navigate target, which
   * is the classic mis-tap pair: you aim at the menu and open the session.
   *
   * So the tap area is grown with a transparent `::after` rather than by growing
   * the box. `-inset-2.5` is 10px on each side — 24 + 20 = 44 — and because it is
   * a positioned pseudo-element it costs no layout anywhere, so nothing reflows
   * and the alternative (a coarse-pointer size bump) does not have to be right
   * in three different row densities.
   */
  sm: "relative h-6 w-6 after:absolute after:-inset-2.5 after:content-['']",
  /**
   * 32px of ink, 44px of target — the height of the composer's control strip.
   *
   * It exists because the paperclip was the deleted `md`, 36px, which made it the
   * one control in that row that was not the height of the pills beside it — the
   * measurement that survives its entry. Grown the same way `sm` is, and
   * **vertically only**, which is the difference between the two: these sit
   * `gap-1.5` apart, so a symmetric `-inset-2.5` would put this button's target
   * over the mode chip's *face*, and the chip beside it changes the model.
   *
   * Both halves of the asymmetry are measured rather than tidy. Up is 4px because
   * the textarea's own bottom edge is 6px above; down is 8px into the composer's
   * bottom padding, which holds a line of text and nothing you can press.
   */
  chip: `relative h-8 w-8 ${TAP_GROW_Y}`,
  /** 44px — the platform tap minimum. The composer's send button, and nothing smaller. */
  lg: "h-11 w-11",
} as const;

const ICON_BUTTON_TONE: Record<ButtonTone, string> = {
  // A *background* on hover, not just a colour. That is the whole point of this
  // primitive existing: the hand-rolled copies it replaces changed a 15px glyph
  // from `text-muted` to `text-fg`, which at phone size is very nearly invisible
  // — so it was never clear what could be pressed. It matters more on paper than
  // it did on the dark ground, because the values are closer together here.
  ghost: "text-muted hover:bg-raised hover:text-fg",
  primary: "bg-fg text-ink hover:bg-fg/85",
  plain: "border border-edge-strong bg-surface text-fg hover:bg-raised",
  destructive: "text-danger hover:bg-danger/10",
};

/**
 * A square button that is only an icon.
 *
 * Existed four times as a copied class string — `Header`, `SessionBrowser`, `NewSession`,
 * `SessionView` — none of which had focus styling and all of which had
 * colour-only hover. `label` is **required** rather than optional so the fifth
 * copy cannot be the one that ships with no accessible name; it becomes both
 * `aria-label` and, unless overridden, the tooltip.
 *
 * ⚠ **`size` is required for the same reason, and it took the same failure to
 * get there.** It defaulted to `md`, and `md` was the one entry in
 * {@link ICON_BUTTON_SIZE} that never reached 44px — so the argument `label`
 * makes about an accessible name held word for word about a tap target: the call
 * site that thinks about it least is the one a default has to be right for, and
 * this one was wrong precisely there. `webcheck` had to keep a list of the call
 * sites that omitted it, which is the shape of a defect nothing can fix for you.
 * Now there is no size a caller can get without naming, and no name that misses
 * the floor — the two halves of the same fix, and neither works alone.
 */
export function IconButton({
  icon,
  label,
  onClick,
  tone = "ghost",
  size,
  disabled = false,
  active,
  expanded,
  haspopup,
  title,
  type = "button",
  className = "",
}: {
  icon: ComponentType<{ size?: number | string; className?: string; "aria-hidden"?: boolean }>;
  label: string;
  onClick?: () => void;
  tone?: ButtonTone;
  /** Required, and not defaulted. See the ⚠ on this component. */
  size: keyof typeof ICON_BUTTON_SIZE;
  disabled?: boolean;
  /** Renders as `aria-pressed`. Omit for buttons that are not a toggle. */
  active?: boolean;
  /**
   * Renders as `aria-expanded`. Omit for buttons that do not disclose anything.
   *
   * Distinct from {@link active} and not a second spelling of it: `aria-pressed` is
   * a two-state control that stays pressed, `aria-expanded` is a control that
   * reveals a region. `AskCard`'s collapse is the second, and it arrived here
   * carrying that attribute on a hand-rolled `<button>` — so the choice was to add
   * this or to lose it in the move to the primitive, and losing an attribute is not
   * a thing a refactor gets to do quietly.
   */
  expanded?: boolean;
  /**
   * Renders as `aria-haspopup`. Omit for buttons that open nothing.
   *
   * Here for the reason {@link expanded} gives one paragraph up, applied a second
   * time: `SessionBrowser`'s filter and `ProfileMenu`'s help were hand-rolled
   * `h-9 w-9` buttons carrying `aria-haspopup="menu"`, and routing them through
   * this primitive would otherwise have dropped it. Both call sites had already
   * written the loss down as a ⚠ rather than hiding it, which is what made it
   * findable — the attribute is cheaper to add than the note was to write.
   *
   * `aria-expanded` says a region is open; this says what kind of thing opens.
   * A trigger normally wants both, and the two are independent: `AskCard`'s
   * collapse discloses a region and pops up nothing.
   */
  haspopup?: "menu" | "listbox" | "dialog";
  title?: string;
  type?: "button" | "submit";
  className?: string;
}): ReactNode {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      aria-expanded={expanded}
      aria-haspopup={haspopup}
      title={title ?? label}
      className={`tap press inline-flex shrink-0 items-center justify-center rounded-md disabled:pointer-events-none disabled:opacity-40 ${ICON_BUTTON_SIZE[size]} ${ICON_BUTTON_TONE[tone]} ${className}`}
    >
      {/* The glyph comes down with the box: a 16px paperclip in a 32px square
          reads as a bigger control than the 11–13px glyphs on the chips beside
          it, which is the mismatch `chip` exists to remove. */}
      <Icon as={icon} size={size === "sm" ? 12 : size === "chip" ? 14 : 16} />
    </button>
  );
}

/** A lucide icon at the one size this app uses, so no caller picks its own. */
export function Icon({
  as: Component,
  size = 14,
  className = "",
}: {
  as: ComponentType<{ size?: number | string; className?: string; "aria-hidden"?: boolean }>;
  size?: number;
  className?: string;
}): ReactNode {
  return <Component size={size} className={`shrink-0 ${className}`} aria-hidden={true} />;
}

/**
 * A fold, so a fold in this app opens one way.
 *
 * ⚠ **Its own comment claimed that and it was not true, from the day it was
 * written.** It lived in `PluginConsent.tsx`, private, and said the grid
 * animation existed "so a fold in this app opens one way" — while `MarketEntry`
 * drew a native `<details>`/`<summary>` about 200px further down *the same
 * screen*, with an instant snap instead of a 200ms open and a disclosure triangle
 * the platform supplies rather than the chevron this one rotates. Two folds, one
 * card, two behaviours. A claim about how an app behaves cannot be kept by a
 * function nobody outside one file can reach, which is the whole reason this
 * moved rather than being copied.
 *
 * **A `<button>` and a `grid-template-rows` transition rather than `<details>`,
 * and both halves are load-bearing.** `<details>` keeps its open state nowhere
 * but the DOM, so nothing in React owns it: it survives exactly as long as the
 * element does, and every remount — a changed `key`, a branch above it swapping
 * — closes a fold somebody opened, for a reason that had nothing to do with the
 * fold. Holding it in `useState` is what makes it survive the re-renders these
 * screens drive themselves. And `<details>` cannot be animated: the content is
 * display-swapped, so there is no height to interpolate. The grid trick is the
 * one way to animate to `auto` height — the row goes `0fr → 1fr` and the overflow
 * is hidden by the child, so the content is never measured and never reflows the
 * page.
 *
 * `inert` on the collapsed half, not `hidden`, because a `0fr` grid row still
 * *contains* focusable children at zero height — without it, tabbing walks
 * straight into a fold that is closed, and a screen reader reads a list somebody
 * has not opened.
 */
export function Disclosure({
  label,
  children,
  first,
  defaultOpen = false,
}: {
  /**
   * The closed line — what somebody is agreeing to open.
   *
   * A `ReactNode` rather than a string, because `MarketEntry`'s fold heads its
   * own settings section and wants {@link SETTINGS_HEADING} type on the words
   * while `PluginConsent`'s is body copy. The wrapper below is `text-fg`, which a
   * node carrying its own `text-*` overrides the ordinary way — a colour applied
   * to an element always beats one inherited from its parent, so this is not the
   * Tailwind ordering trap {@link FIELD} documents.
   */
  label: ReactNode;
  children: ReactNode;
  /**
   * Whether this is the first fold in a stack of them.
   *
   * Layout, and normally the caller's business — but this one is *between* two
   * siblings rather than around one, so a caller cannot express it without
   * knowing which of them is drawing the gap. `PluginConsent` passes `first={false}`
   * flat: the blast-radius sentence is drawn above the fold unconditionally now, so
   * something always precedes it and the old `!names` — which asked whether the card
   * had drawn a heading — can no longer be false.
   */
  first: boolean;
  /**
   * Whether it starts open.
   *
   * ⚠ **Read once, at mount, and changing it later does nothing** — it seeds
   * `useState` and the fold is uncontrolled from then on, which is the point: a
   * prop that reopened a fold somebody had just closed would be worse than no
   * prop. Named for React's own `defaultValue`/`defaultChecked` convention so
   * that is what a reader expects rather than something they have to discover.
   *
   * Defaults to closed, so no existing caller changes.
   */
  defaultOpen?: boolean;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={first ? "" : "mt-2"}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        className="tap flex min-h-11 w-full items-center gap-1.5 text-left text-xs text-muted hover:text-fg"
      >
        <Icon
          as={ChevronRight}
          size={13}
          className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-fg">{label}</span>
      </button>
      <div
        id={id}
        inert={!open}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <div className="pb-1">{children}</div>
        </div>
      </div>
    </div>
  );
}

/*
 * The menu's chrome, named once.
 *
 * There are two listboxes in this app that cannot be the same *component* —
 * `Dropdown` owns its own open state and renders a trigger button, while the
 * composer's command menu is opened by the text and never takes focus — and a
 * third inside `AgentConfigBar`, whose trigger has to render inside a pill. What
 * they must not differ in is how a menu *looks*, and three files agreeing on a
 * class list by copy is how two files start differing in only three words.
 *
 * Width, placement and any tighter height cap stay with the caller, because those
 * are the parts that legitimately differ: a control's menu is 15rem beside its
 * chip, the composer's is as wide as the composer, and only the composer's has to
 * fit above a soft keyboard.
 *
 * All three are wired up. They were not — `AgentConfigBar` went on hand-writing
 * the same class list with a row two-thirds the height, so the drift this comment
 * describes had already happened underneath it.
 */
export const MENU_PANEL = `${LAYER.menu} max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-edge bg-surface p-1.5 shadow-lg`;
/**
 * One row in a menu: 44px, and its cross-axis alignment stated rather than
 * defaulted.
 *
 * ⚠ **A function rather than a constant, because a constant could not be
 * overridden and seven call sites believed it could.** This was
 * `MENU_ROW = "… items-start …"`, and the four rows in `ProfileMenu`, the filter
 * in `SessionBrowser`, `RowAction` below and the plugin row in `MachineInstalls`
 * all wrote `` `${MENU_ROW} items-center` `` — including {@link RowAction}, whose
 * own docblock said so in words. **None of them won.** Tailwind v4 emits its
 * utilities in alphabetical order, so `.items-center` is printed *before*
 * `.items-start` in the stylesheet and the constant outranks the append no matter
 * which way round the class string reads. Order inside a `class` attribute
 * decides nothing; order inside the generated CSS decides everything.
 *
 * What that looked like: a 14px icon pinned to the top of a `text-xs` line box
 * while the glyphs beside it start a half-leading plus the ascender/cap-height
 * gap lower — reported as "the text sits slightly below the icons to its left".
 *
 * Two values and no default, which is the whole point of the pair. `start` is for
 * a row that can carry a description under its label — `Dropdown`'s rows,
 * `CommandMenu`'s, `AgentConfigBar`'s — and each of those pads its leading glyph
 * with `mt-0.5` to match. `center` is for a row that is one line. Leaving
 * `items-*` off altogether was the other candidate and is worse: flex defaults to
 * `stretch`, which stretches the icon rather than aligning it, so a call site that
 * forgot would fail in a way nobody reads as forgetting.
 *
 * `webcheck` sweeps every call site of every exported class-string constant for
 * an appended utility from a family the constant already sets, which is the
 * mechanism this comment cannot be.
 */
export function menuRow(align: "start" | "center"): string {
  /*
   * Both class names written out, never `items-${align}`. Tailwind extracts
   * candidates by scanning source *text*, so an interpolated utility is a rule it
   * never generates — and the failure is silent, since flex would then fall back
   * to `stretch` and the icon would grow instead of moving.
   */
  const cross = align === "center" ? "items-center" : "items-start";
  return `tap flex min-h-11 w-full ${cross} gap-2 rounded-md px-2.5 py-3 text-left text-xs`;
}
export const MENU_HEADING =
  "px-2.5 py-1.5 text-2xs font-semibold tracking-wider text-faint uppercase";

/**
 * The settings screen's one heading, and the one section it heads.
 *
 * Written out **fourteen times** across five files before this, and the string
 * itself had not yet drifted — what had drifted is everything around it.
 * `AccountSection` and `ServerSection` put the heading inside a
 * `<section className="mt-8 border-t border-edge pt-5">`; `MachinesSection` and
 * `UsersSection` hung an `mt-6` on the `<h2>` itself and drew no rule at all;
 * `AgentsPanel` used the same type on a `<div>` and therefore has no headings.
 * So five sections of one screen were separated by three different amounts of
 * nothing, which is most of why this screen reads as unfinished.
 *
 * Two constants rather than one, because the pair **is** the rule: the *first*
 * section on a screen takes {@link SETTINGS_HEADING} alone — a rule above the
 * first thing on a page is a line under the title — and every section after it
 * takes {@link SETTINGS_SECTION} too. That asymmetry is why a single combined
 * string would be wrong at exactly one call site per file, which is how a
 * hand-written `mt-6` got there in the first place.
 *
 * Deliberately **not** {@link MENU_HEADING}, which is the same type at
 * `text-faint` with popover padding, and not the nav's heading either, which
 * composes this with `px-4 pt-4 pb-1` so it shares a left edge with its rows.
 * Layout stays with the caller, for the reason {@link FIELD} gives.
 */
export const SETTINGS_HEADING = "text-2xs font-semibold tracking-wider text-muted uppercase";
/** A settings section below the first: the gap, the rule, and the gap under it. */
export const SETTINGS_SECTION = "mt-8 border-t border-edge pt-5";

/**
 * A tab in a strip of them.
 *
 * ⚠ **The same pill the machine bar in the rail draws, and it is one function so
 * it stays that way.** That component argues the palette decision at length and
 * it is not repeated here, only the conclusion: a selected tab is `bg-raised`,
 * because `raised` means *state* in this app and `bg-fg` means the affirmative
 * action inside a decision — a near-black pill for "you are looking at this" was
 * the loudest object on a page whose whole palette sits within 1.22:1. And an
 * unselected tab keeps `raised/50` rather than nothing, or a strip of two reads
 * as one tab and one label, with the only cue that the strip is a strip existing
 * where you already are.
 *
 * A function rather than two constants because the pair *is* the rule: the two
 * states are only meaningful against each other, and two exported strings is an
 * invitation to use one of them somewhere the other never appears.
 *
 * `min-h-8` is 32px and deliberately below the 44px floor, which the rail's own
 * pills already are: this is navigation between two views of the same pop-up, not
 * a control that answers anything. `webcheck`'s 44px sweep covers the three cards
 * where a mis-tap *decides* something, and this is not one of them.
 */
export function tabPill(selected: boolean): string {
  return `tap flex min-h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs whitespace-nowrap ${
    selected ? "bg-raised font-medium text-fg" : "bg-raised/50 text-muted hover:bg-raised hover:text-fg"
  }`;
}

/**
 * One row in a pop-up's left rail — a settings section, a market tab.
 *
 * ⚠ **The row is shared and the list is not, and the split is where the drift
 * actually is.** What two rails must agree on is height, padding, the active wash
 * and the chevron: they sit one tap apart inside sheets that look the same, so a
 * 2px difference reads as two apps. What they must *not* share is which rows
 * exist — for settings that is `navRows(me)`, a function precisely because
 * computing it in JSX draws a **Server** heading over nothing for a non-admin, and
 * a generalised list component would hand that obligation back to the caller.
 *
 * `blurb` is optional because a market tab is a word: a second line of prose under
 * "Market" would be a caption for a noun.
 *
 * `bg-raised` for the active row is `raised`'s one meaning — state, the tab you are
 * on, the toggle that is on — and never `bg-fg`, which is the affirmative action
 * inside a decision and would make a navigation row the loudest thing on screen.
 */
export function RailRow({
  title,
  blurb,
  active,
  onClick,
}: {
  title: string;
  blurb?: string;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      onClick={onClick}
      className={`tap press flex min-h-11 w-full items-center gap-2 px-4 py-3.5 text-left hover:bg-raised ${
        active ? "bg-raised" : ""
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        {blurb !== undefined && <span className="block truncate text-xs text-muted">{blurb}</span>}
      </span>
      <Icon as={ChevronRight} size={14} className="shrink-0 text-faint" />
    </button>
  );
}

/**
 * The row this app draws wherever something is chosen or opened.
 *
 * ⚠ **There are six of it, and three of those are byte-identical to each other.**
 * `ChooseRow` and `PickRow` in `AgentBuilder.tsx` and the system row in
 * `SystemsPanel.tsx` are the three this was extracted from. `AgentsPanel`'s agent
 * row, `MachinesSection`'s machine row and `InstalledList`'s plugin row are the same
 * `min-h-14 w-full items-center gap-3 rounded-lg border border-edge bg-surface px-3
 * py-2.5 text-left hover:border-edge-strong` typed out again, and they are named
 * here so the remainder is a known one rather than a grep somebody has to think to
 * run. Two of those three put a {@link Badge} *inside* the title line, which
 * `title: string` cannot express — so they wait for the prop that would let them,
 * rather than this carrying a prop nothing calls yet.
 *
 * The three it does cover had already drifted exactly where drift shows: `gap-3`
 * against `gap-2.5`, a subline at `text-muted` on one against `text-faint` on the
 * other two, and one title of the three at `font-medium`. That is `SearchBox`'s
 * argument one screen over, verbatim — a copy is a second chance to be wrong the
 * next time a rule is applied to it — and the rule that arrived next was the
 * disabled treatment below, which would otherwise have had to land three times and
 * be right three times.
 *
 * **A live row's boundary is `edge-strong`, and it is the whole of what says the
 * row is a control.** These sit in {@link SHEET_BODY}, which is `bg-surface`, so a
 * live unselected row is a white control on a white ground — the job `index.css`
 * holds that token at ≥3:1 for (4.40:1 here) and says outright that `edge` (1.31:1)
 * may never do. It was `border-edge` with `hover:border-edge-strong` over the top,
 * which breaks that rule twice in one class string: a hairline as the
 * identification, and a hover that jumps #E3E1DD → #7B7873, louder than the press it
 * accompanies. Hover moves the **fill**, and so does selection, so the box a pointer
 * travels over is one shape from first paint to last.
 *
 * ⚠ **A disabled row hands that boundary back, and the sweep that put `edge-strong`
 * on every state is what made this necessary to write down.** Reported off the
 * harness picker in `AgentBuilder`: two refused rows were indistinguishable from the
 * one pressable row, because the strong border *is* this app's signal "you can press
 * this" and the sweep applied it unconditionally. What was left to tell them apart
 * was a title one step quieter and a hover a phone does not have.
 *
 * WCAG 1.4.11 settles it in the same direction rather than against it. It asks 3:1
 * of "visual information required to identify user interface components and states,
 * **except for inactive components** or where the appearance of the component is
 * determined by the user agent and not modified by the author" — so an inert row is
 * exactly the case the floor exempts, and `edge-strong` on a greyed row is not
 * merely unneeded but actively false. `edge` measures 1.31:1 against `surface` and
 * 1.07:1 against a *selected* disabled row's own `bg-raised`; both are fine, because
 * neither is identifying anything. The box does not move — `border` and `rounded-lg`
 * are unconditional — so nothing reads as having grown when a row goes live, which
 * is the failure {@link BUTTON_TONE} measured when it tried `disabled:opacity-40`
 * on an outlined control.
 *
 * ⚠ **Disabled dims the ink upwards, and there is no opacity anywhere on this row.**
 * It was `disabled:opacity-40`, which composites the whole control — the subline
 * included, and on these rows the subline *is the refusal*: why this harness cannot
 * run that model, or which system has no key on this machine. Measured over
 * `surface` (#FFFFFF), `--color-faint` at 40% is #C2BFB9 = 1.83:1 and `--color-fg`
 * at 40% is 2.51:1 — against a token whose floor exists precisely because almost
 * every use of it is 12px. A refusal has to be **more** legible than the label it
 * refuses, never less. So the title steps down to `muted` (7.75:1), the glyph to
 * `faint`, and the subline stays exactly where it was (6.23:1 on `surface`, 5.09:1
 * inside a selected row).
 *
 * Those two paragraphs are one treatment: a handed-back boundary, a quieter title,
 * and a refusal left at full strength. **Three signals for one state**, which is the
 * count `AskCard`'s `CHOSEN` argues for on the rows a person answers with and the
 * count the rail spends on a waiting session — and it is three because with the
 * palette monochrome there is no hue left to spend on a fourth.
 *
 * ⚠ **A row can be selected *and* disabled**, and `AgentBuilder`'s two pickers both
 * reach it: a preset restored from a machine that no longer has that harness, or a
 * model whose system has since lost its key. The fill and the check stay — those
 * say *which one is chosen*, which is still true — and the boundary is decided by
 * `disabled` first, so a chosen row that cannot be acted on does not claim it can.
 *
 * `selected` is left `undefined` where nothing is being chosen, which is
 * {@link IconButton}'s `active` idiom and carries the same two consequences: no
 * `aria-pressed`, and no reserved check slot. Reserving one on a list that has no
 * selection is a column of empty space down the end of every row.
 */
export function ChoiceRow({
  glyph,
  title,
  placeholder = false,
  subline = null,
  trailing,
  selected,
  disabled = false,
  onClick,
}: {
  /** Drawn before the label — a harness's mark, and nothing that is a control. */
  glyph?: ReactNode;
  title: string;
  /**
   * The title is a prompt rather than an answer — `Choose` — so it is drawn at the
   * same `muted` a disabled row's title takes. There is no third step to spend on
   * telling those two apart: the subline under it is already `faint`, and a title
   * quieter than its own subline inverts the row.
   */
  placeholder?: boolean;
  subline?: string | null;
  /**
   * Whatever hangs off the end and is not the check: a chevron on a row that opens
   * a screen, a {@link Badge} on one that carries a state, the harness marks on a
   * model. It is drawn *before* the check slot, so becoming the answer never
   * displaces it.
   */
  trailing?: ReactNode;
  /** Omit where nothing is being chosen. See the docblock. */
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      /*
       * ⚠ **`:hover` still matches a disabled `<button>`**, so the hover fill is
       * granted by state rather than taken back by a `disabled:` variant — which
       * would also have to know what a *selected* row's ground is, and would
       * repaint it `bg-surface` under a pointer. Three states, one expression.
       *
       * The border is asked `disabled` before `selected` for the reason in the
       * docblock: a row that is both is chosen and still cannot be pressed, so the
       * fill stays and the boundary goes.
       *
       * ⚠ `border` is written into **both** arms rather than hoisted out in front
       * of them. Hoisting it reads better and costs the one property this pair is
       * about: `webcheck` reads this file off disk — no type can hold a class
       * string — and asks for the literal `border border-edge-strong`, which a
       * hoisted `border` splits in two. The width never varies, so the two arms
       * cannot disagree about it.
       */
      className={`tap press flex min-h-14 w-full items-center gap-2.5 rounded-lg ${
        disabled ? "border border-edge" : "border border-edge-strong"
      } px-3 text-left ${
        selected === true ? "bg-raised" : `bg-surface ${disabled ? "" : "hover:bg-raised"}`
      }`}
    >
      {glyph !== undefined && (
        <span className={`shrink-0 ${disabled ? "text-faint" : "text-muted"}`}>{glyph}</span>
      )}
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm ${selected === true ? "font-medium" : ""} ${
            disabled || placeholder ? "text-muted" : ""
          }`}
        >
          {title}
        </span>
        {subline !== null && subline.length > 0 && (
          <span className="block truncate text-2xs text-faint">{subline}</span>
        )}
      </span>
      {trailing}
      {selected !== undefined && (
        // Reserved rather than conditional, so a row does not move when it becomes
        // the answer — which is the whole of why the check has a slot of its own
        // instead of being another `trailing`.
        <span className="inline-flex w-4 shrink-0 justify-center text-fg">
          {selected && <Icon as={Check} size={14} />}
        </span>
      )}
    </button>
  );
}

/**
 * One act inside a settings row's kebab.
 *
 * Promoted out of `UsersSection` when `MachinesSection` grew a kebab of its own,
 * rather than copied: a second hand-written copy is how one of the two loses
 * `role="menuitem"`, or picks a slightly different danger wash, and nothing
 * anywhere says they were meant to match. A menu act is one line, so it asks
 * {@link menuRow} for `center`; a `Dropdown` row, which can carry a description
 * under its label, asks for `start`. ⚠ This sentence used to say "overrides it to
 * `items-center`", and the override did not work for a year — see `menuRow`.
 *
 * **`danger` is a tone here and not a {@link DangerButton}, deliberately.** That
 * component's "must lead with a glyph" rule is about a *button among buttons* —
 * on a settings row there were five outlined buttons and exactly one deleted
 * something. A menu is a list of words in which one of them is the only red
 * thing, which is a stronger signal than a 13px icon; icons on some items and
 * not others would also put the labels on two left edges. It is the same
 * `text-danger` over a `danger/15` hover that `SessionMenu`'s own destructive
 * item uses. The irreversible half is unchanged and lives on the row: this opens
 * the two-step confirmation, it never performs the act.
 *
 * In `UsersSection` it replaced `ToggleDisabled`, which existed to give Disable a
 * `Ban` glyph and Enable an ordinary button — a distinction a menu draws with one
 * word.
 */
export function RowAction({
  label,
  onClick,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}): ReactNode {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`${menuRow("center")} ${
        danger ? "text-danger hover:bg-danger/15" : "text-fg hover:bg-raised"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * The rows a panel can move focus between: its own enabled buttons, in document
 * order.
 *
 * A live DOM query on every keystroke rather than a registry of refs, and that is
 * the choice that keeps this usable by {@link Menu}, whose children are a caller's
 * render prop and therefore unknowable from here. It is also correct where a
 * registry is merely convenient: the set changes as a list filters, and a query
 * cannot go stale between a row unmounting and a ref being cleaned up.
 *
 * `:disabled` is excluded because a control that will not act must not be a stop on
 * the way to one, which is the same sentence `index.css` writes about the pointer
 * cursor.
 */
function focusableRows(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>("button:not(:disabled)"));
}

/**
 * Bring a row into view by scrolling **only the panel**.
 *
 * `.focus()` on its own runs the spec's "scroll an element into view" up the whole
 * containing-block chain rather than stopping at the nearest scroller. Both popups
 * here are `absolute` children of a box that is routinely inside `SHEET_BODY`
 * (`overflow-y-auto`), and an absolutely-positioned panel still contributes to that
 * box's scroll height — so revealing a row deep in a `max-h-72` list scrolled the
 * *sheet* as well, moving the form under the pointer at the moment of opening.
 *
 * Rectangles rather than `offsetTop`, deliberately: `offsetTop` is measured from
 * `offsetParent`, which is the panel only while no caller wraps its rows in a
 * positioned element — and `Menu` takes a render prop, so that is a promise this
 * file cannot make. Rect deltas are the same arithmetic with nothing to get wrong.
 */
function revealWithin(panel: HTMLElement, row: HTMLElement): void {
  const rowBox = row.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();
  if (rowBox.top < panelBox.top) panel.scrollTop -= panelBox.top - rowBox.top;
  else if (rowBox.bottom > panelBox.bottom) panel.scrollTop += rowBox.bottom - panelBox.bottom;
}

/**
 * Arrow keys inside a panel that has already claimed a widget role.
 *
 * ⚠ **This exists because the roles were drawn and never implemented.** `Menu`
 * renders `role="menu"`, `Dropdown` renders `role="listbox"` with `role="option"`
 * and `aria-selected` on every row, and a grep for `ArrowDown` across the whole of
 * `packages/web` returned one hit, in the composer's own slash menu. So a screen
 * reader announced "listbox, 8 options" and then not one arrow key moved anything.
 * A widget role is a promise about behaviour; drawing one and not keeping it is
 * worse than drawing a `<div>`, because it is the announcement that makes a
 * keyboard user go looking for a control that is not there.
 *
 * **The listener is on the panel and never on `window`, and that is what keeps it
 * out of everybody else's way.** Focus is moved into the panel when it opens, so an
 * element handler is all that is needed — and this app has exactly two global
 * keydown listeners on purpose (`overlay.ts`'s single Escape arbiter and
 * `AskCard`'s digit shortcuts), each of which had to reason about the other. A
 * third would have had to reason about both. Escape is not read here at all: it
 * belongs to `overlay.ts`, which knows whether a sheet has opened over this menu
 * since, and `listNavKey` returns `null` for it so the key travels there untouched.
 *
 * **Focus goes to the selected row, not the first**, so opening a control you have
 * already set puts the keyboard on the value you are changing rather than at the
 * top of a list you then have to walk. `aria-selected` is the test, which is why
 * this works for `Dropdown` and degrades to "first row" for `Menu`, where nothing
 * is selected because nothing is a value.
 *
 * **The panel itself is focusable (`tabIndex={-1}`) and is the fallback**, which is
 * two fixes in one line. A panel whose rows are a caller's prose — `ProfileMenu`'s
 * `HelpButton` is one — would otherwise never take focus at all, so it announced
 * `role="menu"` and still answered no key. And because the handler is
 * element-scoped, focus *leaving* the rows is the same as the widget going dead:
 * the focused row can unmount under a poll (`NewSession`'s machine list, a
 * conditional row in `UsersSection`), the browser drops focus to `<body>`, and from
 * there no arrow key can reach this handler to get back in. With the panel holding
 * focus, `rows.indexOf` answers -1 and `nextOptionIndex` takes the near end — which
 * is what that arm was written for and, until this line, could not be reached from
 * here at all.
 *
 * **And it hands focus back.** Without the cleanup, closing the panel drops focus to
 * `<body>` and a keyboard user is returned to the top of the document, which in this
 * app means the rail. Two details, both borrowed from `Sheet`, which solved this
 * first and whose version this now matches: the restore is guarded on `isConnected`
 * because the trigger routinely does not survive a poll, falling back to
 * `document.body` rather than throwing away the intent; and it is
 * `{preventScroll: true}`, because the outside-`pointerdown` that closes a panel is
 * also what the *start of a touch scroll* looks like — finger down, panel closes, a
 * task later the passive cleanup scrolls the sheet back to the trigger, fighting the
 * scroll the reader just began.
 *
 * ⚠ The `contains` arm of that guard is **all but dead and is kept rather than
 * trusted**: React runs a passive cleanup after the mutation phase, so the panel is
 * already detached and the browser has already reset `document.activeElement` to
 * `<body>` — the arm that actually fires is the `body` one. It stays because it is
 * the correct question to ask and costs nothing, but do not read it as the guard
 * doing the work.
 *
 * Not applied to `AgentConfigBar`'s hand-rolled panels, which build their own
 * markup from `MENU_PANEL` rather than going through either component here. Named
 * so it is a known remainder rather than an oversight.
 */
function useListKeys(open: boolean): {
  panelRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
} {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    returnRef.current = document.activeElement as HTMLElement | null;
    const rows = focusableRows(panel);
    const selected = rows.findIndex((row) => row.getAttribute("aria-selected") === "true");
    const target = rows[selected < 0 ? 0 : selected] ?? panel;
    target.focus({ preventScroll: true });
    if (target !== panel) revealWithin(panel, target);
    return () => {
      const back = returnRef.current;
      returnRef.current = null;
      if (back === null) return;
      const active = document.activeElement;
      if (active !== null && active !== document.body && !panel.contains(active)) return;
      if (back.isConnected) back.focus({ preventScroll: true });
      else document.body.focus();
    };
  }, [open]);

  return {
    panelRef,
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>): void => {
      // Built by hand rather than passed through, because `isComposing` lives on
      // the *native* event and the synthetic one does not carry it — and an arrow
      // key mid-composition is how an IME walks its own candidate list.
      const action = listNavKey({
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        isComposing: event.nativeEvent.isComposing,
      });
      if (action === null) return;
      const panel = panelRef.current;
      if (panel === null) return;
      const rows = focusableRows(panel);
      const at = nextOptionIndex(action, rows.indexOf(document.activeElement as HTMLElement), rows.length);
      if (at === null) return;
      // Only once something will actually move: an unhandled Home in a panel
      // should still scroll whatever contains it.
      event.preventDefault();
      const row = rows[at];
      if (row === undefined) return;
      // Same `preventScroll` + `revealWithin` pair as the open path, and for the
      // same reason: following focus down a list must move the list, never the
      // sheet the list happens to be sitting in.
      row.focus({ preventScroll: true });
      revealWithin(panel, row);
    },
  };
}

/**
 * A panel anchored to the thing that opened it.
 *
 * The fourth copy of "anchored panel + outside-pointerdown + Escape" in this
 * package, promoted rather than written again — `Dropdown`, `SessionMenu` and
 * `AgentConfigBar`'s overflow each own a version, and they cannot be one component
 * because their triggers are genuinely different (a full-width button, a kebab, a
 * pill). What they must not differ in is the behaviour, and three files agreeing
 * by copy is how two of them start differing in three words.
 *
 * **It does not portal, and that is the point.** `Sheet` portals because `fixed`
 * has to mean the viewport; this is `absolute` against its trigger's `relative`
 * wrapper, which is the only way to anchor something *without measuring the
 * viewport* — and measuring it is breakpoint-state-in-JavaScript wearing a hat.
 * `placement` and `align` are props for the same reason, never detected.
 *
 * The caller is responsible for one thing: no ancestor between the trigger and the
 * scroll container may clip. That is why `AppShell`'s rail moved its `overflow` to
 * an inner box — a footer popover inside an `overflow-y-auto` aside is a popover
 * with its top half cut off.
 */
export function Menu({
  trigger,
  children,
  placement = "down",
  align = "left",
  className = "",
  panelClassName = "",
}: {
  /** Rendered inside the anchor, given the open state so it can show it. */
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  placement?: "up" | "down";
  align?: "left" | "right";
  className?: string;
  panelClassName?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { panelRef, onKeyDown } = useListKeys(open);

  useDismissible("menu", () => setOpen(false), open);

  useEffect(() => {
    if (!open) return;
    // `pointerdown` and never `blur`: the menu is made of buttons, and blur fires
    // before the click that chose one lands.
    const close = (event: Event): void => {
      if (boxRef.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      {trigger(open, () => setOpen(!open))}
      {open && (
        <div
          ref={panelRef}
          onKeyDown={onKeyDown}
          tabIndex={-1}
          role="menu"
          className={`absolute ${LAYER.menu} ${POPOVER} ${
            placement === "up" ? "bottom-full mb-1" : "top-full mt-1"
          } ${align === "right" ? "right-0" : "left-0"} ${panelClassName}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/**
 * One item in a {@link Dropdown}.
 *
 * `group` is a heading rendered above the first item that carries it, so a list
 * that arrives grouped (ACP's model picker does) keeps its structure.
 */
export interface DropdownItem<T> {
  value: T;
  label: string;
  /**
   * The second line, and on a {@link disabled} item it is **the refusal** — every
   * caller that passes both passes the reason here. It is drawn at full
   * `text-faint` in every state for that reason; see the row's own comment.
   */
  description?: string | null;
  group?: string | null;
  /**
   * Unusable, and still listed. Filtering an item out answers "where did my laptop
   * go" with silence, which is `MachinePicker`'s rule and `AgentStrip`'s after it —
   * so an item that arrives `disabled` owes a {@link description} saying why.
   */
  disabled?: boolean;
  /** Drawn before the label. For a machine's reachability dot, and the like. */
  adornment?: ReactNode;
}

/**
 * The one popover picker.
 *
 * Promoted out of `AgentConfigBar`, which had the only good one: outside-pointerdown
 * dismissal (not blur — the menu is made of buttons, and blur fires before the
 * click that chose one lands), the full listbox ARIA set, group headings, check
 * marks and per-row descriptions. Everything else that needed to pick one of many
 * was reimplementing some subset of that, or — in the two machine pickers — was an
 * unbounded wrap of buttons with no hover state at all.
 *
 * **The rule this exists to serve:** a control whose option count can exceed about
 * five is a dropdown; a fixed set of five or fewer is chips. An unbounded wrap
 * reflows the page every time the fleet changes size, and on a phone it pushes the
 * fields below it off the screen. The deliberate exception is `PermissionCard`,
 * where every option must be visible at once — hiding "reject" behind a popover is
 * a safety regression on the one screen where that matters.
 *
 * `placement` is a prop and never auto-detected. Measuring the viewport in
 * JavaScript to choose a direction is breakpoint-state-in-JavaScript wearing a
 * different hat, and `AppShell` is explicit that this app does not have any.
 */
export function Dropdown<T extends string>({
  items,
  value,
  onChange,
  trigger,
  heading,
  placement = "down",
  disabled = false,
  busy = false,
  title,
  align = "left",
  className = "",
}: {
  items: readonly DropdownItem<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** What the closed button shows. A node, so a caller can put a dot or a badge in it. */
  trigger: ReactNode;
  /** Small uppercase label above the list, naming what is being chosen. */
  heading?: string;
  placement?: "up" | "down";
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  align?: "left" | "right";
  className?: string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { panelRef, onKeyDown } = useListKeys(open);

  /*
   * Escape goes through the one arbiter now; the outside press stays here.
   *
   * They are different gestures with different correctness arguments, and only
   * one of them can collide with anything. An outside `pointerdown` is scoped by
   * construction — it asks whether the press landed inside *this* box — and it is
   * deliberately not `blur`, because the menu is made of buttons and blur fires
   * before the click that chose one lands. Escape is global, and a keyboard user
   * who opened this has no "outside" to press, so it has to be handled; that is
   * exactly why it belongs to `overlay.ts`, which knows whether a sheet has opened
   * over this menu since.
   */
  useDismissible("menu", () => setOpen(false), open);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (boxRef.current?.contains(event.target as Node) !== true) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        // 32px is a comfortable pill on a desktop and under the 44px platform
        // minimum on a phone, so the two are stated separately rather than one
        // being made to cover both. In CSS and not in JavaScript, because
        // `AppShell` is explicit that this app holds no breakpoint state — a
        // media query cannot disagree with the window it is in.
        //
        // The disabled arm dims the label and nothing else, for the reason
        // {@link BUTTON_TONE} argues at length: this trigger is `bg-surface` on a
        // `bg-surface` sheet, so its border is the whole of what says a control is
        // there, and `disabled:border-edge` took that to 1.31:1 — the third copy of
        // that deletion, on the one control in this file that is also a value.
        className="tap press inline-flex min-h-8 w-full items-center gap-1.5 rounded-md border border-edge-strong bg-surface px-2.5 text-xs text-fg hover:bg-raised disabled:text-faint [@media(pointer:coarse)]:min-h-11"
      >
        {trigger}
        {busy ? <Spinner /> : <Icon as={ChevronDown} size={12} className="ml-auto text-faint" />}
      </button>

      {open && (
        <div
          ref={panelRef}
          onKeyDown={onKeyDown}
          tabIndex={-1}
          role="listbox"
          className={`absolute w-60 max-w-[min(20rem,calc(100vw-2rem))] ${MENU_PANEL} ${
            placement === "up" ? "bottom-full mb-1" : "top-full mt-1"
          } ${align === "right" ? "right-0" : "left-0"}`}
        >
          {heading !== undefined && <p className={MENU_HEADING}>{heading}</p>}
          {items.map((item, index) => {
            const showGroup =
              item.group !== null && item.group !== undefined && item.group !== items[index - 1]?.group;
            const selected = item.value === value;
            const unavailable = item.disabled === true;
            return (
              <div key={`${item.group ?? ""}:${item.value}`}>
                {showGroup && <p className="mt-1 px-2 py-0.5 text-2xs text-faint">{item.group}</p>}
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={unavailable}
                  onClick={() => {
                    setOpen(false);
                    if (!selected) onChange(item.value);
                  }}
                  // `min-h-11` is the same 44px every other menu row in this app
                  // uses, and it is not gated on a coarse pointer the way the
                  // trigger above is: `SessionMenu`'s items are the same shape and
                  // one of them is `Stop`, so there is exactly one menu-row height
                  // rather than one per file. `py-3` sizes the single-line case to
                  // almost exactly that on its own, so a row with a description
                  // grows rather than the short ones looking top-heavy.
                  // Selection is weight, not colour, and the reserved 12px `Check`
                  // slot below was already doing most of the work — the accent
                  // text was a second mark for the same fact.
                  //
                  // ⚠ **No opacity, and this row was the last control in this file
                  // still spending one.** It was `disabled:opacity-40
                  // disabled:hover:bg-transparent`, which composites the row whole
                  // — `item.description` with it, and on the live caller that
                  // description *is* the refusal: `MachinePicker` in
                  // `NewSession.tsx` passes `unusableReason(machine)` as the
                  // description and `why !== null` as `disabled`, so an offline or
                  // read-only machine drew its **name** at 2.51:1 (13px) and the
                  // whole of **why it cannot be reached** at 1.83:1 (12px) over
                  // this panel's own `bg-surface` (#ffffff), against a 4.5:1 floor
                  // — and this menu is the only place a non-selected machine's
                  // reason appears anywhere in the app. `BUTTON_TONE.ghost`'s
                  // opacity exemption does not reach here: it is conditioned on a
                  // control with no boundary to lose *and no subline to
                  // composite*, and this row has one. So the same three steps
                  // {@link ChoiceRow} takes — the label down to `text-muted`
                  // (7.75:1), the description left exactly where it was at
                  // `text-faint` (6.23:1), and nothing at all on the row itself.
                  //
                  // ⚠ **`:hover` still matches a disabled `<button>`**, so the fill
                  // is granted by state rather than taken back with a `disabled:`
                  // variant — `ChoiceRow`'s expression, for `ChoiceRow`'s reason,
                  // and one fewer utility racing another in the sheet.
                  //
                  // ⚠ **`ChoiceRow`'s other half — hand the boundary back when the
                  // row is inert — has nothing to do here, and that is checked
                  // rather than overlooked.** `menuRow` draws no border in *either*
                  // state: what identifies a row inside this panel is the panel's
                  // own `MENU_PANEL` box and the 44px of hover fill, so there is no
                  // `edge-strong` on a refused row claiming a pressability it does
                  // not have, and adding one to the live rows would be a new
                  // decoration rather than an identification. A future sweep that
                  // borders menu rows owes the disabled arm the same `edge` this
                  // file gives {@link ChoiceRow}. The three signals here are the
                  // ones the row already has: the label down a step, the refusal
                  // that {@link DropdownItem.disabled} obliges a caller to pass,
                  // and the caller's own `adornment` — `MachinePicker`'s `Dot` at
                  // `off`, which is a shape a phone can read with no pointer.
                  className={`${menuRow("start")} text-fg ${unavailable ? "" : "hover:bg-raised"} ${
                    selected ? "font-medium" : ""
                  }`}
                >
                  <span className="mt-0.5 w-3 shrink-0">{selected && <Icon as={Check} size={11} />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      {/* The adornment is left alone deliberately. `MachinePicker`
                          passes a `Dot`, which is a *state mark* drawn from its own
                          tokens rather than from `currentColor` — dimming it would
                          take the one thing on the row already saying "off" down
                          with the label. */}
                      {item.adornment}
                      <span className={`min-w-0 truncate ${unavailable ? "text-muted" : ""}`}>
                        {item.label}
                      </span>
                    </span>
                    {item.description !== null && item.description !== undefined && (
                      <span className="block text-2xs text-faint">{item.description}</span>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
