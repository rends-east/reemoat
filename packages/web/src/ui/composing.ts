/**
 * What the composer says when it is empty, and who gets the caret.
 *
 * Here rather than inside `Composer.tsx` for the reason `tail.ts`, `commands.ts`
 * and `agentConfig.ts` are here: `webcheck` has no DOM, so a rule written as a
 * ternary in a JSX prop is untested by construction. That matters more than usual
 * for this file, because what it holds is the *replacement* for two lines of
 * furniture that were deleted — and deleting them is only safe if what absorbed
 * them is pinned.
 *
 * Named `composing.ts` and not `composer.ts` deliberately: this repository is
 * developed on a case-insensitive filesystem, where `./composer` and `./Composer`
 * are the same specifier and which one you get depends on resolution order.
 */

/**
 * What the empty box says, in the order these facts override each other.
 *
 * All three used to be somewhere else. `working` was a caption under the control
 * strip that mounted and unmounted on **every turn**, adding and removing 16px
 * between the box you are typing in and the transcript you are reading it
 * against; `reconnecting` was a second caption with the same shape. A placeholder
 * costs no height at all and is in the place somebody is already looking.
 */
export function composerPlaceholder(state: {
  blocked: boolean;
  /** A send is in flight *and* the agent is being brought back. */
  reconnecting: boolean;
  working: boolean;
  /**
   * A plan is on screen waiting to be decided, and this box is one of the ways
   * to decide it. See {@link Composer}'s send path.
   */
  revising: boolean;
}): string {
  /*
   * **First, because it is the one state where `blocked` does not mean "wait".**
   *
   * A plan is the only request whose answer can be a sentence: writing one here
   * stops the turn and sends it, which refuses the plan and says why in a single
   * gesture. So the box that would otherwise tell you to go and answer something
   * is itself the answer, and the placeholder has to say so or the control is
   * invisible.
   */
  if (state.revising) return "say what to change…";
  // Blocked first: nothing typed here moves until the request above is answered.
  if (state.blocked) return "answer the request above first";
  /*
   * Then reconnecting, which is the rarer and the more surprising of the two —
   * and the one that explains why Send has been a spinner for thirty seconds.
   *
   * It works as a placeholder for a reason that is not obvious: the box is empty
   * for exactly the window in which this is true, because `submit()` clears the
   * draft before the request resolves.
   */
  if (state.reconnecting) return "reconnecting the agent…";
  if (state.working) return "agent is working…";
  return "message…";
}

/**
 * Whether whatever holds focus right now would genuinely be interrupted.
 *
 * The clause this replaces was `active !== null && active !== document.body`,
 * i.e. "anything is focused at all". Measured against the layout the autofocus
 * was written for, that is always true on Chromium: at `lg` the rail stays
 * mounted, a session row is a `<button>`, and Chromium focuses buttons on click
 * — so the caret never moved. Safari and Firefox on macOS do not focus buttons
 * on click, so the same code worked there, which is how it passed a hand check.
 *
 * What is actually worth protecting is a text field somebody is typing in and an
 * open disclosure they are reading. A button that merely received a click is
 * neither, and taking focus off it is the entire point of the feature.
 *
 * Duck-typed and taking `unknown` for the same reason `isTypingInto` is:
 * `webcheck` has no DOM, and it is the only thing that checks this.
 *
 * ⚠ **`AskCard` reads it too now, and that is the rule being shared rather than a
 * helper being borrowed.** When a request parks, the card takes the caret so that
 * a keyboard user is not left at `<body>` in front of a transcript with no render
 * window — and the question it has to ask first is this one, asked in the other
 * direction: *is anything holding focus that would genuinely be interrupted?* One
 * predicate rather than two, so the composer and the card cannot come to disagree
 * about what counts as an interruption.
 *
 * ⚠ **That last sentence said *"the two cases that answer yes are the two
 * {@link shouldReleaseComposer} protects, a half-written message and a plan being
 * answered in the box"*, and it was false in both halves.** There are **three**
 * arms below, not two: a contenteditable, a text control, and an open disclosure.
 * The third belongs to no part of `shouldReleaseComposer` — that function reads
 * `draftEmpty` about the composer's own box and cannot see a menu at all — and the
 * two it named are one arm rather than two, since a half-written message and a
 * plan being revised are both the textarea with something in it. The true pair of
 * *subjects* is the one the paragraph above already names: a text field somebody
 * is typing in, and an open disclosure they are reading. `webcheck` sweeps all
 * three arms plus `aria-expanded="false"` and the bare row button, which is what
 * made the miscount survivable.
 */
export function focusWorthKeeping(active: unknown): boolean {
  if (active === null || typeof active !== "object") return false;
  const element = active as {
    tagName?: string;
    isContentEditable?: boolean;
    getAttribute?: (name: string) => string | null;
  };
  if (element.isContentEditable === true) return true;
  const tag = (element.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  // An open disclosure — a menu, a popover, a listbox trigger. Closed ones read
  // `"false"` and are not worth keeping, which is what makes a plain row button
  // (no attribute at all) fall through to `false`.
  return element.getAttribute?.("aria-expanded") === "true";
}

/**
 * Whether a session switch should put the caret in the box.
 *
 * Every clause is a way this is *wrong* rather than merely unnecessary:
 *
 *   `hasBox`             — `Composer` renders nothing for a session somebody
 *                          ended, so there is no textarea to reach.
 *   `pointerCoarse`      — on a phone this raises the soft keyboard over half the
 *                          screen every time you open a session, including the
 *                          ones you opened to read.
 *   `focusHeldElsewhere` — never take the caret off something that already has
 *                          it. This is what stops a session switching under a
 *                          mounted pane from yanking focus out of a menu.
 *   `blocked`            — the box's own placeholder says to answer the request
 *                          above first, so focusing it aims at the wrong control.
 *   `fromKeyboardNav`    — **the one that is not obvious.** `useKeyboard`
 *                          navigates on bare `j`/`k`, and `isTypingInto` switches
 *                          every bare shortcut off while the composer has focus.
 *                          Autofocusing after a `j` therefore breaks the *next*
 *                          `j`: it types the letter into a message instead of
 *                          moving to the next session. So the keyboard layer says
 *                          the hop was its own, and this defers.
 */
export function shouldFocusComposer(state: {
  hasBox: boolean;
  pointerCoarse: boolean;
  focusHeldElsewhere: boolean;
  blocked: boolean;
  fromKeyboardNav: boolean;
}): boolean {
  return (
    state.hasBox &&
    !state.pointerCoarse &&
    !state.focusHeldElsewhere &&
    !state.blocked &&
    !state.fromKeyboardNav
  );
}

/**
 * Whether the composer should give the caret **back**, and it is the missing half
 * of {@link shouldFocusComposer}.
 *
 * That rule declines to take focus while a request is parked, which was read as
 * covering the case and does not: on a desktop the composer takes the caret when
 * you open a session, and a request that parks a moment *later* finds it already
 * holding one. Everything downstream then reads "somebody is typing" —
 * `optionShortcut` refuses, so the numbers drawn beside the answers do nothing,
 * and the first digit of a keyboard answer lands in the message box instead.
 *
 * **Only with an empty draft.** Somebody halfway through a sentence keeps their
 * caret and keeps their digits as digits, which is precisely the property
 * `isTypingInto` exists to protect; taking the caret out from under a
 * half-written message to enable a shortcut would be trading one silent loss for
 * another.
 *
 * ⚠ **This lets go and something else has to catch, which for four releases
 * nothing did.** The caret fell to `<body>`, and `EventList` draws every event
 * with no render window — so reaching Approve from a keyboard meant Tab past every
 * tool card in the conversation, on the one screen where the alternative is
 * leaving an agent stopped. `AskCard`'s panel takes it now, guarded by
 * {@link focusWorthKeeping} and deferred a frame, because this effect runs *after*
 * the card's: the composer is a sibling of the conversation region rather than a
 * child of it. Neither half is much use without the other, so they are named at
 * each other rather than left to be found.
 */
export function shouldReleaseComposer(state: {
  blocked: boolean;
  focused: boolean;
  draftEmpty: boolean;
}): boolean {
  return state.blocked && state.focused && state.draftEmpty;
}

/*
 * One bit of module state, in the same shape as `groups.ts`'s `currentFilter()`
 * and for the same reason: two things have to agree about something not worth
 * waking every store subscriber for, and one of them is a `window` keydown
 * handler that does not render at all.
 *
 * Consumed rather than merely read, so it cannot go stale and suppress the next
 * legitimate focus.
 */
let keyNav = false;

/** `useKeyboard` announcing that this route change came from `j`/`k`. */
export function markKeyNav(): void {
  keyNav = true;
}

/** `Composer` asking, and putting the flag down whatever it decides. */
export function takeKeyNav(): boolean {
  const was = keyNav;
  keyNav = false;
  return was;
}
