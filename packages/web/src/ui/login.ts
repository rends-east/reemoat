// Pattern-matches vendor prose, not a protocol: when nothing is recognised the caller shows the raw transcript.

export type LoginPhase = "starting" | "acting" | "waiting" | "done" | "failed";

export interface LoginView {
  phase: LoginPhase;
  url: string | null;
  code: string | null;
  message: string | null;
}

// First match wins. Only failures that cannot be retried away: this is matched against the whole transcript.
const FAILURES: readonly { pattern: RegExp; message: string }[] = [
  {
    pattern: /tcgetattr|Operation not supported on socket/i,
    message: "This machine cannot run the sign-in program. Close this and save a key below instead.",
  },
  {
    pattern: /command not found|No such file or directory|is not recognized as/i,
    message: "The sign-in program is not installed on this machine, so it cannot be run from here.",
  },
];

const CODE_PATTERNS: readonly RegExp[] = [
  /(?:code|enter)[^A-Za-z0-9\n]{0,20}([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/,
  /(?:code|enter)[^A-Za-z0-9\n]{0,20}\b([A-Z0-9]{6,10})\b/,
  // Bare only when hyphenated: a lone run of capitals is too common here to guess at.
  /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/,
];

const NOT_CODES = new Set(["HTTP-1", "UTF-8", "SHA-256", "X-REQUEST-ID"]);

export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  return [...new Set(found)].slice(-3);
}

/** The newest match of the most confident pattern, so after a reprint the code pairs with the newest URL. */
export function extractCode(text: string): string | null {
  for (const pattern of CODE_PATTERNS) {
    let found: string | null = null;
    // Iterate a `g` copy: re-flagging the shared constants would share `lastIndex` state.
    for (const match of text.matchAll(new RegExp(pattern, "g"))) {
      const candidate = match[1];
      if (candidate !== undefined && !NOT_CODES.has(candidate)) found = candidate;
    }
    if (found !== null) return found;
  }
  return null;
}

export function extractFailure(text: string): string | null {
  for (const failure of FAILURES) {
    if (failure.pattern.test(text)) return failure.message;
  }
  return null;
}

/** `done` and `needsInput` come from the daemon; a failure while the flow runs is not `failed`, since these CLIs retry. */
export function readLoginTranscript(text: string, done: boolean, needsInput: boolean): LoginView {
  const message = extractFailure(text);
  const urls = extractUrls(text);
  const url = urls.at(-1) ?? null;
  const code = extractCode(text);

  // Once the process exits the page and code are spent, so neither is drawn.
  if (done) return { phase: message === null ? "done" : "failed", url: null, code: null, message };
  if (url === null && code === null) return { phase: "starting", url, code, message };
  return { phase: needsInput ? "acting" : "waiting", url, code, message };
}

export function transcriptIsTheAnswer(view: LoginView): boolean {
  // A finished run always states an outcome, or every successful login would open the raw pane.
  if (view.phase === "done" || view.phase === "failed") return false;
  return view.url === null && view.code === null && view.message === null;
}

/** What the card may claim after exit: the re-probe is the only oracle, and `checking` outranks `checkFailed`. Q3.430 */
export type LoginOutcome = "checking" | "signedIn" | "notSignedIn" | "cannotTell" | "unreachable";

export function loginOutcome(
  checking: boolean,
  checkFailed: boolean,
  loggedIn: boolean | null | undefined,
): LoginOutcome {
  if (checking) return "checking";
  if (checkFailed) return "unreachable";
  if (loggedIn === true) return "signedIn";
  if (loggedIn === false) return "notSignedIn";
  return "cannotTell";
}

export function rawTranscriptIsOpen(view: LoginView, outcome: LoginOutcome | null): boolean {
  if (view.phase !== "done" && view.phase !== "failed") return transcriptIsTheAnswer(view);
  if (view.message !== null) return false;
  return outcome === "cannotTell" || outcome === "unreachable";
}
