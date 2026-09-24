// Not named `composer.ts`: on a case-insensitive filesystem it would collide with `Composer.tsx`.

export function composerPlaceholder(state: {
  blocked: boolean;
  reconnecting: boolean;
  working: boolean;
  revising: boolean;
  // Whether the `/` menu would offer anything; from the unfiltered command list, not the draft.
  hasCommands: boolean;
}): string {
  // Revising outranks blocked: typing here is how the plan gets answered.
  if (state.revising) return "Say what to change…";
  if (state.blocked) return "Answer the request above first";
  if (state.reconnecting) return "Reconnecting the agent…";
  if (state.working) return "Agent is working…";
  return state.hasCommands ? "Type / for commands" : "Message…";
}

/** On every field an agent reads: WebKit's smart quotes, dashes and text replacements all sit behind `spellcheck`, measured; `autocorrect` is a phone keyboard's (Q3.647). */
export const VERBATIM_FIELD = { spellCheck: false, autoCorrect: "off" } as const;

/** The blank lines around a message and the whitespace after it; the first line's indentation is content (Q3.646). */
export function sentText(text: string): string {
  return text.replace(/^\s*\n/, "").trimEnd();
}

/** A text control, contenteditable or open disclosure; shared with `AskCard` so both agree on what an interruption is. */
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
  return element.getAttribute?.("aria-expanded") === "true";
}

/** Every clause is a way focusing is wrong; `fromKeyboardNav` because the next bare `j` would type into the box. */
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

/** Give the caret back when a request parks over an empty draft, so option shortcuts work; `AskCard` takes it next. */
export function shouldReleaseComposer(state: {
  blocked: boolean;
  focused: boolean;
  draftEmpty: boolean;
}): boolean {
  return state.blocked && state.focused && state.draftEmpty;
}

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
