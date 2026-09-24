// Keyboard decisions as pure functions, so webcheck can assert them without a DOM.

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  // On a React synthetic event this is nativeEvent.isComposing.
  isComposing?: boolean;
}

/** Bare Enter sends; Enter during IME composition commits the candidate and must not send. */
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

export function isTypingInto(target: unknown): boolean {
  // Duck-typed on unknown so webcheck can call it without a DOM.
  if (target === null || typeof target !== "object") return false;
  const element = target as { tagName?: string; isContentEditable?: boolean };
  if (element.isContentEditable === true) return true;
  const tag = (element.tagName ?? "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

export type CompletionKey = "next" | "prev" | "choose" | "dismiss" | null;

/** Has its own IME guard, since Enter commits a composition candidate; Shift and other chords stay with the textarea. */
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

export type ComposerKey = CompletionKey | "send";

/** The menu takes Enter while open, shouldSend otherwise; enterSends is false on a soft keyboard so Enter inserts a newline there. */
export function composerKey(event: KeyLike, menuOpen: boolean, enterSends: boolean): ComposerKey {
  if (menuOpen) {
    const action = completionKey(event);
    if (action !== null) return action;
  }
  return enterSends && shouldSend(event) ? "send" : null;
}

/** No Cmd, Ctrl or Alt held and no IME composition; Shift is left to each caller. */
export function isBareKey(event: KeyLike): boolean {
  return (
    event.metaKey !== true &&
    event.ctrlKey !== true &&
    event.altKey !== true &&
    event.isComposing !== true
  );
}

export type ListNavKey = "first" | "last" | "next" | "prev" | null;

/** Escape is left to overlay.ts, the single Escape arbiter; Enter and Space are left to the rows' own buttons. */
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

/** Wraps; with nothing focused (current -1) next lands on the first row and prev on the last; null for an empty list. */
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

/** Digits 1..count, ignored while typing into a field (the composer sits under the card) and with Shift held (Shift+1 is a character). */
export function optionShortcut(event: KeyLike, target: unknown, count: number): number | null {
  if (!isBareKey(event) || event.shiftKey === true) return null;
  if (isTypingInto(target)) return null;
  if (!/^[1-9]$/.test(event.key)) return null;
  const index = Number(event.key) - 1;
  return index < count ? index : null;
}
