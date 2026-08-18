/**
 * A login transcript, read as steps instead of as a terminal.
 *
 * The daemon runs the agent's own CLI under a pty and hands back the bytes it
 * printed. Those bytes used to go straight into a `<pre>` — which is a correct
 * rendering and a hostile one, because the person reading it is on a phone,
 * three taps into Settings, trying to find out what to do next. Every one of
 * these flows wants the same two things done: open a page, and either read a
 * code off the screen or paste one back. This file finds those two things.
 *
 * **It is a reading, not a protocol, and the fallback is the whole safety
 * property.** Nothing here is negotiated with any agent; these are patterns
 * matched against prose that a vendor may reword in any release. So when it
 * recognises nothing it says so — {@link LoginView} comes back all-null — and
 * the caller's contract is to show the raw transcript in that case. The worst
 * outcome is therefore exactly the screen this replaces, never less than it.
 *
 * Pure, with no DOM, so `webcheck` asserts these rules against fixtures rather
 * than against a rendered card.
 */

export type LoginPhase = "starting" | "acting" | "waiting" | "done" | "failed";

export interface LoginView {
  phase: LoginPhase;
  /** The page to open. The last one printed, since these flows redraw. */
  url: string | null;
  /** A device code to read off the screen, when one was recognised. */
  code: string | null;
  /** A sentence about a recognised failure. Never invented for an unknown one. */
  message: string | null;
}

/**
 * Failures worth naming, in order, first match wins.
 *
 * **One entry per thing that has actually been observed**, and the first is why
 * this table exists at all: on macOS the login wizard does not run for any
 * agent, because BSD `script` reads its own stdin's termios in order to copy it
 * onto the pty and `LocalRuntime.login` hands it a pipe. What somebody saw was
 * `script: tcgetattr/ioctl: Operation not supported on socket` in a `<pre>`,
 * with nothing anywhere connecting that to "paste a token instead".
 *
 * Ordered rather than a map, because these overlap: a missing binary can print
 * both "not found" and a shell's own wording, and the more specific reading has
 * to win. Anything matching none of them is `null`, which the caller draws as
 * the transcript.
 *
 * **Every entry has to be about a failure that cannot be retried away**, and
 * that is the rule a `/\bexpired\b/` entry broke. A device code really can
 * expire, the flow really does print so, and the CLI then prints a *fresh* code
 * and carries on — so once the process exited, a login that had succeeded was
 * drawn as `phase: "failed"` in red, saying the code had expired, beside a badge
 * reading "signed in". This table is matched against the whole transcript, so
 * anything transient in it is a claim about the past stated in the present.
 */
const FAILURES: readonly { pattern: RegExp; message: string }[] = [
  {
    // The macOS pty defect. Matched on either half, because util-linux and BSD
    // word it differently and only the ioctl name is common to both.
    pattern: /tcgetattr|Operation not supported on socket/i,
    // Points at a control that is on screen — the key rows are drawn below the
    // wizard for exactly this reason — rather than at a mechanism. "PATH" and
    // "its own login flow" are gone: the reader is not a developer, and neither
    // word changes what they do next.
    message: "This machine cannot run the sign-in program. Close this and save a key below instead.",
  },
  {
    pattern: /command not found|No such file or directory|is not recognized as/i,
    message: "The sign-in program is not installed on this machine, so it cannot be run from here.",
  },
];

/** Where a device code is likely to be, in decreasing confidence. */
const CODE_PATTERNS: readonly RegExp[] = [
  // Introduced by a word, which is how every device flow prints one. The
  // separator class is deliberately wide — these lines carry colons, box-drawing
  // remnants and stray spacing — and bounded so it cannot span a paragraph.
  /(?:code|enter)[^A-Za-z0-9\n]{0,20}([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/,
  /(?:code|enter)[^A-Za-z0-9\n]{0,20}\b([A-Z0-9]{6,10})\b/,
  // Bare, and only in the hyphenated shape. A lone run of capitals is far too
  // common in this output to guess at.
  /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/,
];

/**
 * Words that look like a code and are not.
 *
 * The bare pattern above matches anything hyphenated and shouty, and these
 * flows print several. Checked as a set rather than folded into the regex,
 * because a negative lookahead that grows is a regex nobody can read.
 */
const NOT_CODES = new Set(["HTTP-1", "UTF-8", "SHA-256", "X-REQUEST-ID"]);

/**
 * Every URL in the transcript, newest last, deduplicated.
 *
 * Deduplicated because these flows *redraw*: a spinner repaints its line and the
 * same authorize URL is printed a dozen times.
 *
 * Three are kept and `readLoginTranscript` surfaces only the newest, which is
 * deliberate rather than an oversight: a flow that reprinted after an expiry has
 * exactly one *live* page and offering the dead ones beside it is worse than not
 * offering them. The rest stay reachable in the transcript. Exported because it
 * is the half of this file that predates the rest of it, and `webcheck` asserts
 * the deduplication directly.
 */
export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
  return [...new Set(found)].slice(-3);
}

/**
 * The device code, if one is recognisable. A hint — see the module docblock.
 *
 * **The newest match, not the first**, which is the same end {@link extractUrls}
 * reads from and it has to be. These flows reprint on expiry: a code times out,
 * the CLI prints a fresh URL and a fresh code, and `extractUrls().at(-1)` moved
 * to the new page while a non-global `exec` here stayed on the first code —
 * putting a stale code beside a live page, which is the one pairing that cannot
 * work.
 *
 * The patterns are still tried in order of confidence, so a code introduced by
 * its own word beats a bare one even if the bare one came later.
 */
export function extractCode(text: string): string | null {
  for (const pattern of CODE_PATTERNS) {
    let found: string | null = null;
    // `matchAll` needs the `g` flag, and these are shared module constants — so
    // the last match is taken by iterating rather than by re-flagging them,
    // which would put mutable `lastIndex` state on a shared regex.
    for (const match of text.matchAll(new RegExp(pattern, "g"))) {
      const candidate = match[1];
      if (candidate !== undefined && !NOT_CODES.has(candidate)) found = candidate;
    }
    if (found !== null) return found;
  }
  return null;
}

/** The recognised failure, or `null` for "this is not a failure we know". */
export function extractFailure(text: string): string | null {
  for (const failure of FAILURES) {
    if (failure.pattern.test(text)) return failure.message;
  }
  return null;
}

/**
 * What the card should draw.
 *
 * `done` and `needsInput` come from outside because neither is in the bytes:
 * the first is the daemon saying the process exited, and the second is a fact
 * about the agent's flow that the daemon reports from its own table. Reading
 * either out of the transcript would be exactly the guessing this file's
 * docblock declines to do.
 *
 * The phases:
 *
 *   - `starting` — nothing recognised yet and the flow is alive. A spinner.
 *   - `acting` — there is a page to open and this flow wants something back.
 *   - `waiting` — there is a page to open and the flow is watching the network.
 *   - `done` — the process exited and nothing looked like a failure.
 *   - `failed` — the process exited *and* a failure was recognised.
 *
 * **A failure while the flow is still running is not `failed`.** These programs
 * print warnings and retry, and a card that gave up on the first scary line
 * would abandon a login that was about to work. The message is still carried, so
 * the card can show it beside the spinner.
 */
export function readLoginTranscript(text: string, done: boolean, needsInput: boolean): LoginView {
  const message = extractFailure(text);
  const urls = extractUrls(text);
  const url = urls.at(-1) ?? null;
  const code = extractCode(text);

  /*
   * **A page and a code are instructions, not history.** Once the process has
   * exited there is nothing to open and nothing to type — but the bytes still
   * hold both, because nothing in a device flow ever says a code was consumed,
   * and `extractCode` reads the *newest* match on purpose for the reprint case.
   * So they are dropped here rather than gated at the call site: a code that
   * cannot be reached cannot be drawn, and the rule lives in a file `webcheck`
   * reads. This is the defect in the report — a spent code still burning under a
   * badge already reading "signed in".
   *
   * ⚠ The matching honesty limit, which must **not** be "fixed": while `waiting`
   * the code stays on screen even after you have authorised on the page. Process
   * exit plus one poll is the only terminator these bytes offer, and guessing at
   * success strings is exactly what a removed `expired` pattern used to do.
   */
  if (done) return { phase: message === null ? "done" : "failed", url: null, code: null, message };
  if (url === null && code === null) return { phase: "starting", url, code, message };
  return { phase: needsInput ? "acting" : "waiting", url, code, message };
}

/**
 * Whether the raw transcript is the only useful thing on screen.
 *
 * The fallback rule, as one exported predicate rather than a condition spelled
 * out at the call site, so `webcheck` asserts the rule itself: when nothing was
 * recognised the `<details>` starts **open** and the person sees precisely what
 * they saw before this file existed.
 */
export function transcriptIsTheAnswer(view: LoginView): boolean {
  /*
   * ⚠ **This line is the trap in nulling `url`/`code` on exit, not a nicety.**
   * The test below is "nothing was recognised", and a finished run now satisfies
   * it by construction — so without this, every login that WORKED would spring
   * the raw pty pane open under its own success message: a screen of terminal
   * output where a sentence should be. A finished run is never its own
   * transcript's answer; the card states an outcome for it.
   */
  if (view.phase === "done" || view.phase === "failed") return false;
  return view.url === null && view.code === null && view.message === null;
}

/**
 * What the card may claim once the process has exited.
 *
 * `done` says a pty child ended, and nothing more. The exit status is
 * deliberately unread — BSD `script` does not propagate it — `FAILURES` has no
 * success counterpart, and every way of losing that nobody has met yet lands in
 * `done` with a null message. **The re-probe is the only oracle**, and this is
 * the total partition over what it can say.
 *
 * `checking` outranks `checkFailed`, so a retry in flight never shows the error
 * the retry is trying to clear. Q3.430.
 */
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

/**
 * Whether the raw pty output opens by itself — the honest successor to the
 * fallback rule rather than a weakening of it.
 *
 * Live: unchanged, the bytes are the answer when nothing was recognised. Once
 * the flow has ended they are the answer again exactly when the card has run out
 * of things to say: no recognised failure to act on, and no verdict obtainable.
 * `outcome` is `null` while the flow is still running.
 */
export function rawTranscriptIsOpen(view: LoginView, outcome: LoginOutcome | null): boolean {
  if (view.phase !== "done" && view.phase !== "failed") return transcriptIsTheAnswer(view);
  // A recognised failure already says what to do; the terminal adds nothing.
  if (view.message !== null) return false;
  return outcome === "cannotTell" || outcome === "unreachable";
}
