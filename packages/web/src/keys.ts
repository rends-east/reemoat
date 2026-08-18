/**
 * Keyboard decisions, as pure functions.
 *
 * They live here rather than inline in the components so `pnpm webcheck` can
 * assert them without a DOM — the driver stubs `window` and has no React
 * renderer, so anything expressed only as an `onKeyDown` prop is untestable by
 * construction. These are small enough to look obviously correct and were not.
 */

/** The parts of a keyboard event these decisions actually read. */
export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /**
   * Whether an IME is mid-composition.
   *
   * On a React synthetic event this is `event.nativeEvent.isComposing`, not a
   * property of the synthetic event itself.
   */
  isComposing?: boolean;
}

/**
 * Whether this keystroke should send the message.
 *
 * Bare Enter sends; `Shift+Enter` inserts a newline. That is what was asked for
 * and it is what every chat client does **on a keyboard that has a Shift+Enter**.
 * Whether this keystroke arrived from one is not this function's question — see
 * {@link composerKey}'s `enterSends`, which is where a soft keyboard is let out
 * of the rule rather than here, so that "which chord is a send" stays one answer.
 *
 * **The IME guard is the part that is not obvious.** With a Chinese, Japanese,
 * Korean or Russian phonetic input method, Enter is how you *commit the
 * candidate you are typing* — the composition is not text in the box yet. A
 * naive `key === "Enter"` sends a half-finished word and swallows the keystroke
 * that was meant to finish it, on every message, for everyone using one of those
 * layouts. `isComposing` is false for a plain Latin keyboard, so this costs
 * nothing to the case that does work.
 *
 * Modifier chords are left alone rather than also sending. `Cmd+Enter` is a
 * plausible second way to send, but it is also what several browsers and OS
 * shortcuts already use, and having two ways to do this is how one of them ends
 * up broken without anybody noticing.
 */
export function shouldSend(event: KeyLike): boolean {
  if (event.key !== "Enter") return false;
  if (event.isComposing === true) return false;
  return (
    event.shiftKey !== true &&
    event.metaKey !== true &&
    event.ctrlKey !== true &&
    event.altKey !== true
  );
}

/**
 * Whether the page should act on a bare, unmodified letter shortcut.
 *
 * Every desktop shortcut in this app is a single key, which is only acceptable
 * while the user is not typing — otherwise `j` in the composer scrolls the list
 * instead of appearing in the message. There is no allowlist of "safe" elements
 * because the set of things that accept text keeps growing; the question is
 * whether focus is in something editable at all.
 */
export function isTypingInto(target: unknown): boolean {
  // `unknown` rather than `EventTarget | null`, which is what every real caller
  // passes: `EventTarget` carries none of the properties this reads, so the
  // narrowing below has to be duck-typed anyway — and typing the parameter as a
  // DOM interface would make this untestable from `webcheck`, which has no DOM
  // and is the only thing that checks it.
  if (target === null || typeof target !== "object") return false;
  const element = target as { tagName?: string; isContentEditable?: boolean };
  if (element.isContentEditable === true) return true;
  const tag = (element.tagName ?? "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

/** What a keystroke means while the command menu is open. */
export type CompletionKey = "next" | "prev" | "choose" | "dismiss" | null;

/**
 * How the command menu reads a keystroke, or `null` to leave it to the textarea.
 *
 * **The IME guard is the load-bearing half again, for the same reason it is in
 * `shouldSend`.** With a Russian, Chinese, Japanese or Korean input method Enter
 * commits the candidate being typed — so a menu that treated it as a selection
 * would insert a command instead of finishing a word, on every message, invisibly
 * from a Latin keyboard. It is the identical defect arriving through a new door,
 * which is why the guard is restated here rather than assumed from the fact that
 * `shouldSend` runs afterwards.
 *
 * **Enter is the one key this shares with `shouldSend`, and the collision is
 * resolved by order in the composer**: the menu takes Enter while it is open, and
 * `shouldSend` takes it otherwise. That ordering is written down here because an
 * ordering that exists only inside an `onKeyDown` prop is one nothing can assert
 * and everyone is free to reverse.
 *
 * Modified chords are left alone rather than claimed: `Shift+Enter` stays a
 * newline and `Shift+Tab` stays focus-backwards, which are the things a person
 * expects to keep working while a suggestion list happens to be on screen.
 */
export function completionKey(event: KeyLike): CompletionKey {
  if (!isBareKey(event)) return null;
  if (event.shiftKey === true) return null;
  switch (event.key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "prev";
    case "Enter":
    case "Tab":
      return "choose";
    case "Escape":
      return "dismiss";
    default:
      return null;
  }
}

/** Everything the composer's textarea can decide a keystroke means. */
export type ComposerKey = CompletionKey | "send";

/**
 * The composer's whole key dispatch, and the resolution of the one collision.
 *
 * Enter is claimed by both {@link completionKey} and {@link shouldSend}, and the
 * rule is that the menu takes it while the menu is open and `shouldSend` takes it
 * otherwise. That rule lived inside an `onKeyDown` prop, where nothing could
 * assert it — CLAUDE.md said it was asserted in `webcheck` and what `webcheck`
 * actually asserted was that the collision *exists*, which stays green with the
 * two blocks in either order. Reversing them sends a half-typed message instead
 * of completing a command, so it is precisely the ordering worth pinning.
 *
 * Returns what the keystroke means and nothing about what to do with it: the
 * `preventDefault`, the `stopPropagation` that Escape additionally needs (see
 * `Composer`), and the index arithmetic all stay with the component, because they
 * are DOM and this file is the part with no DOM in it.
 *
 * **`enterSends` is false on a soft keyboard, and that is the whole of the mobile
 * rule.** A phone keyboard has no Shift+Enter, so "Enter sends" leaves no way to
 * type a newline at all — which the composer used to answer with a `↵` button
 * beside the box, appending `\n` to the *end* of the draft wherever the caret
 * happened to be. Returning `null` here instead hands the keystroke back to the
 * textarea, which inserts a line break at the caret like every other character,
 * and Send becomes the button. It is **required** rather than defaulted so a new
 * call site is a compile error rather than a silent Enter-sends.
 *
 * The menu still takes Enter first, whatever the pointer: typing `/model` and
 * pressing Return on a phone must choose the command, not break the line. So this
 * gates only the fall-through, which is the one thing `enterSends` is about.
 */
export function composerKey(event: KeyLike, menuOpen: boolean, enterSends: boolean): ComposerKey {
  if (menuOpen) {
    const action = completionKey(event);
    if (action !== null) return action;
  }
  return enterSends && shouldSend(event) ? "send" : null;
}

/** A plain letter or `/` with no modifier held — the shape of every shortcut here. */
export function isBareKey(event: KeyLike): boolean {
  return (
    event.metaKey !== true &&
    event.ctrlKey !== true &&
    event.altKey !== true &&
    event.isComposing !== true
  );
}

/** What a keystroke means to an open menu or listbox. */
export type ListNavKey = "first" | "last" | "next" | "prev" | null;

/**
 * How a popup list reads a keystroke, or `null` to leave it alone.
 *
 * **This exists because three widgets in `bits.tsx` claimed a role they did not
 * implement.** `Menu` renders `role="menu"`, `Dropdown` renders `role="listbox"`
 * with `role="option"` and `aria-selected` on every row — and a grep for
 * `ArrowDown` across the whole of `packages/web` found exactly one hit, in
 * `completionKey`, which belongs to the composer's slash menu. So a screen reader
 * announced "listbox, 8 options" and then no arrow key did anything at all. An
 * unimplemented widget role is the same class of defect as an unmeasured contrast
 * ratio, except that nothing in this app was asserting it.
 *
 * **Escape is deliberately absent, and that is the load-bearing omission.**
 * `overlay.ts` is the single arbiter for Escape — it holds the LIFO layer stack and
 * the one capture-phase listener, and `decisionShortcutsEnabled` reads that stack
 * to decide whether a bare digit may resolve a permission. A second component
 * answering Escape is exactly the shape that arbiter replaced, so this function
 * returns `null` for it and the key travels to where it is owned.
 *
 * **Enter and Space are absent for a smaller reason**: every row in both widgets is
 * a real `<button>`, which activates on both without help. Claiming them here would
 * mean re-implementing what the platform already does, and doing it slightly
 * differently.
 *
 * `isBareKey` keeps chords and IME composition out, for `completionKey`'s reason.
 * `shiftKey` is not checked: `Shift+ArrowDown` is a text-selection gesture in a
 * field, and there is no field inside these panels.
 */
export function listNavKey(event: KeyLike): ListNavKey {
  if (!isBareKey(event)) return null;
  switch (event.key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}

/**
 * Where {@link listNavKey}'s answer lands, given where focus is now.
 *
 * Separate from the key reading so the arithmetic is assertable on its own — the
 * wrap is the part that is easy to get subtly wrong and impossible to see in a
 * driver with no DOM.
 *
 * **`current` of -1 means nothing in the list has focus yet**, which is the state
 * every panel opens in before its effect runs, and it is why `next` and `prev` are
 * not simply `+1`/`-1`: from nowhere, Down goes to the first row and Up to the
 * last, so a keyboard reaching a freshly opened menu gets the near end either way
 * rather than landing on row two.
 *
 * **The list wraps**, which is the convention for a popup of bounded length and the
 * opposite of what a long document does. It also removes the dead key: on a
 * four-row menu with focus on the last row, an unwrapped Down does nothing and
 * gives the reader no signal about why.
 *
 * `null` for an empty list, so a caller cannot focus index 0 of nothing.
 */
export function nextOptionIndex(action: ListNavKey, current: number, count: number): number | null {
  if (action === null || count <= 0) return null;
  switch (action) {
    case "first":
      return 0;
    case "last":
      return count - 1;
    case "next":
      return current < 0 || current >= count - 1 ? 0 : current + 1;
    case "prev":
      return current <= 0 ? count - 1 : current - 1;
  }
}

/**
 * Which answer a digit picks on the ask card, or `null` for every other key.
 *
 * The card draws a number beside each option, and until now that number did
 * nothing — a comment on the row called it "the number a keyboard would reach
 * for", which is a promise the card was not keeping. A drawn shortcut that is not
 * wired is worse than no number at all, so either it goes or it works; the
 * reference this card is modelled on numbers them and means it.
 *
 * **Three guards, and the middle one is why this is here rather than inline.**
 * `isBareKey` keeps every chord and every IME composition out. `isTypingInto`
 * is the one that matters in practice: the composer sits directly under this card
 * and takes the caret on its own, so without it the first digit of a message
 * would approve whatever the agent was asking. And `shiftKey` is checked here
 * rather than in `isBareKey` — the letter shortcuts want `Shift+J` to stay a
 * navigation, while `Shift+1` is `!`, i.e. a character somebody is typing.
 *
 * Bounded by `count` rather than by 9, so a form with three answers ignores `4`
 * instead of resolving it to nothing further down the component.
 */
export function optionShortcut(event: KeyLike, target: unknown, count: number): number | null {
  if (!isBareKey(event) || event.shiftKey === true) return null;
  if (isTypingInto(target)) return null;
  if (!/^[1-9]$/.test(event.key)) return null;
  const index = Number(event.key) - 1;
  return index < count ? index : null;
}
