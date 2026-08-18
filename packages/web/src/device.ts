/**
 * A `User-Agent` string as a few words somebody can recognise.
 *
 * Pure and out here rather than inside the component, for the reason `account.ts`
 * and `groups.ts` both state: `webcheck` has no DOM, so a rule that lives in JSX
 * is a rule nothing can assert. That matters more than usual here, because every
 * branch below is a claim about a string this code will never be handed during
 * development — nobody signs in from Windows on this machine.
 *
 * **This is recognition, not identification.** A `User-Agent` is a request header
 * a caller writes for itself, so "Chrome on macOS" means the connection said so.
 * That is enough for the only question the list answers — *which of these rows is
 * not me?* — and it is not enough for anything else. Nothing here is used for a
 * decision, on either side of the wire.
 *
 * The parsing is deliberately shallow: a family and a platform, no versions. A
 * version number is the part that ages worst (`Chrome/142` on a page written when
 * 120 was new reads as a bug), it is the part a person recognises least, and it
 * is the part that makes a parser need maintaining. Two words do the job.
 */

/**
 * Browser families, in the order they must be tested.
 *
 * **The order is the whole correctness argument**, because these strings are
 * subsets of each other by design — a browser claims its predecessors so that
 * server-side sniffing written before it existed still works. Chrome's own agent
 * ends `… Chrome/141.0.0.0 Safari/537.36`, and Edge's is that plus `Edg/141`. So
 * matching `Safari` first calls every desktop browser Safari, and matching
 * `Chrome` before `Edg` calls Edge Chrome. Tested most-specific first, and the
 * table is ordered rather than the matcher being clever.
 *
 * The iOS entries are not a variant of the desktop ones: on iOS every browser is
 * WebKit wearing a different name, and the name is the *only* thing that differs
 * — `CriOS` is Chrome, `FxiOS` is Firefox, `EdgiOS` is Edge. Without them, every
 * iPhone in the list reads "Safari".
 */
const BROWSERS: ReadonlyArray<readonly [needle: string, name: string]> = [
  ["EdgiOS", "Edge"],
  ["Edg", "Edge"],
  ["OPiOS", "Opera"],
  ["OPR", "Opera"],
  ["SamsungBrowser", "Samsung Internet"],
  ["CriOS", "Chrome"],
  ["FxiOS", "Firefox"],
  ["Firefox", "Firefox"],
  ["Chromium", "Chromium"],
  ["Chrome", "Chrome"],
  ["Safari", "Safari"],
];

/**
 * Platforms, in the order they must be tested.
 *
 * Same shape and the same reason: Android's agent begins `Mozilla/5.0 (Linux;
 * Android 14; …)`, so `Linux` must be last or every phone is a desktop. `iPad`
 * before `iPhone` is not an ordering constraint but is kept adjacent to it;
 * iPadOS 13+ reports `Macintosh` in Safari's desktop-site default and there is no
 * honest way to tell it from a Mac, which is stated here rather than guessed at
 * with a touch-point heuristic that cannot run on a string.
 */
const PLATFORMS: ReadonlyArray<readonly [needle: string, name: string]> = [
  ["iPhone", "iPhone"],
  ["iPad", "iPad"],
  ["Android", "Android"],
  ["CrOS", "ChromeOS"],
  ["Macintosh", "macOS"],
  ["Mac OS X", "macOS"],
  ["Windows", "Windows"],
  ["Linux", "Linux"],
];

function firstMatch(ua: string, table: ReadonlyArray<readonly [string, string]>): string | null {
  for (const [needle, name] of table) {
    if (ua.includes(needle)) return name;
  }
  return null;
}

/**
 * What to call the device a session signed in from, or `null` when nothing is
 * recognised.
 *
 * `null` rather than a guess or the raw string. The raw string is 130 characters
 * of `Mozilla/5.0 (X11; …) AppleWebKit/537.36 (KHTML, like Gecko)` that would
 * wrap to three lines and say less than nothing; and a session that predates the
 * table storing this has no agent at all, which is a different fact from an
 * unrecognisable one but reads identically to the person looking. The caller
 * draws one sentence for both.
 *
 * A half-answer is still an answer: a recognised platform with an unrecognised
 * browser is worth more than `null`, so both halves are optional and the sentence
 * is assembled from whichever survived.
 */
export function describeAgent(userAgent: string | null | undefined): string | null {
  if (typeof userAgent !== "string") return null;
  const ua = userAgent.trim();
  if (ua.length === 0) return null;

  const browser = firstMatch(ua, BROWSERS);
  const platform = firstMatch(ua, PLATFORMS);

  if (browser !== null && platform !== null) return `${browser} on ${platform}`;
  return browser ?? platform;
}

/**
 * Whether anything was recorded for this session at all.
 *
 * The distinction this exists to keep is one the code used to throw away: a
 * session that predates `user_session_origins` carries no agent, and one from a
 * client this table does not know carries an agent nobody could read. Both used
 * to draw as "Unrecognised device", and the first question anybody asked on
 * seeing it was *what does that mean — did it fail?* — which is the sentence a
 * label earns when it answers a question the reader did not ask.
 *
 * They need different words because they have different remedies. Nothing was
 * recorded: sign in again and it will be. Something was and we cannot read it:
 * the row is as identified as it is ever going to get, so read the address
 * instead.
 */
export function agentWasRecorded(userAgent: string | null | undefined): boolean {
  return typeof userAgent === "string" && userAgent.trim().length > 0;
}

/**
 * The one line a session row leads with.
 *
 * Separate from `describeAgent` because the fallbacks are *sentences* rather than
 * names, and because there are two of them — see `agentWasRecorded`. An empty
 * cell where the other rows have words reads as a rendering fault, so every row
 * says something true.
 *
 * **It does not take "is this the current one".** It did, and returned "This
 * device" — which cost the browser its place on the one row somebody looks at
 * first, so an account with a single session showed no browser anywhere and the
 * feature read as unbuilt. The two facts are not alternatives: *which row you are
 * on* is certain and belongs on a badge, *what it is* is what the agent said and
 * belongs in the title. Drawing both says more than either and contradicts
 * nothing.
 */
export function deviceLine(userAgent: string | null | undefined): string {
  const described = describeAgent(userAgent);
  if (described !== null) return described;
  return agentWasRecorded(userAgent) ? "Unrecognised browser" : "Signed in before this was recorded";
}
