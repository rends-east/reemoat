import { signupMode, type InstanceConfig, type SignupMode } from "./instance";

/**
 * The screens somebody reaches before there is a credential, and every rule
 * about their URLs.
 *
 * Here rather than in `router.ts` for the reason `settings.ts` states: that
 * module reads `window.location` and installs a `popstate` listener **in its
 * module body**, so `webcheck` — which stubs `location.href` and nothing else —
 * throws on import before a single case runs. A rule the driver cannot reach is
 * a rule nothing asserts.
 *
 * ## `/confirm` and `/verify` are two words for two acts
 *
 * `/confirm` **creates an account that did not exist until it was clicked**;
 * `/verify` annotates an account that already exists with an address it can
 * later reset from. Readers merge them on sight, so the distinction lives here
 * rather than in a comment at one call site.
 *
 * ## The token rides the fragment
 *
 * `…/reset#t=<token>`, never a path segment and never a query. Three reasons,
 * and the second is the one that decides it:
 *
 *   1. **A fragment never reaches the server.** `CLAUDE.md` already made this
 *      argument when `readCredential` was narrowed to read a query credential
 *      only on an `upgrade: websocket` request — *"the URL lands in history, in
 *      `Referer` and in every intermediary's log"* — and `install.sh` tells
 *      operators to put a TLS proxy in front, which logs request lines.
 *   2. **Corporate mail gateways `GET` every URL in an inbound message.** With
 *      the token in the path a scanner fetches it before the human sees it; with
 *      it in the fragment the scanner fetches `/reset` and learns nothing.
 *   3. It sidesteps the control plane's `looksLikeAsset`, which treats a last
 *      path segment matching a short extension as a file and answers a JSON 404
 *      — so a token that happened to contain a dot would render a blank page.
 *
 * *Rejected: the path segment.* It is this app's idiom for route state and it is
 * assertable through one parser, and `Referer` is genuinely a wash — the default
 * `strict-origin-when-cross-origin` sends the full URL, query and all, on
 * same-origin requests. It loses on the proxy log and on the scanner.
 */

export type GateScreen = "register" | "confirm" | "forgot" | "reset" | "verify";

export const GATE_SCREENS: readonly GateScreen[] = ["register", "confirm", "forgot", "reset", "verify"];

/**
 * The gate screen a path names, or `null` for every other path.
 *
 * Takes segments rather than a pathname so it composes with `router.ts`'s own
 * split, and matched **exactly**, so the case a URL happens to arrive in never
 * decides what is rendered — `parseSettingsSection`'s rule.
 */
export function parseGateScreen(segments: readonly (string | undefined)[]): GateScreen | null {
  const first = segments[0];
  if (first === undefined) return null;
  return GATE_SCREENS.find((screen) => screen === first) ?? null;
}

/** Whole-segment, the `isOverlayPath` rule: `/registerish` is not `/register`. */
export function isGatePath(pathname: string): boolean {
  return parseGateScreen(pathname.split("/").filter((part) => part.length > 0)) !== null;
}

export function gatePath(screen: GateScreen): string {
  return `/${screen}`;
}

/** Whether the screen means anything without a token. Data, not a second switch. */
export function gateNeedsToken(screen: GateScreen): boolean {
  return screen === "confirm" || screen === "reset" || screen === "verify";
}

/**
 * Whether the screen needs a **session** as well as a token, and there is
 * exactly one.
 *
 * `/verify` spends its token at `POST /v1/me/email/verify`, which sits *below*
 * THE LINE on the control plane deliberately: the token says which address, and
 * the session says whose account. A token that could repoint an account's reset
 * channel on its own would be a credential rather than a link, so the screen
 * genuinely needs both — and a signed-out visitor holding one is not an error,
 * they are one sign-in away.
 *
 * Data beside `gateNeedsToken` rather than a second `screen === "verify"` inside
 * the component, because the two answer one question together — *what is this
 * screen still missing* — and the defect they replace was the component asking
 * neither. `VerifyEmail`'s effect fired on mount unconditionally; `cpFetch`
 * refuses before a byte leaves the browser when there is no credential, so what
 * reached the card was `ApiError(401, "missing_api_key", "not signed in")`,
 * whose message is the internal sentence that exists so a bug in *this client*
 * has something to say. `linkError`'s `default:` arm printed it verbatim under
 * "That link did not work" — telling somebody their perfectly good, unspent link
 * was dead.
 *
 * **Not folded into `gateOutranksSession`.** That one asks whether the screen is
 * drawn *over* a live session and this asks whether it can act *without* one;
 * they are opposite questions that happen to name the same screen, and the pair
 * `gateNeedsToken`/`gateOutranksSession` already records what happens when two
 * such questions are answered by one function.
 */
export function gateNeedsSession(screen: GateScreen): boolean {
  return screen === "verify";
}

/**
 * Whether this screen is drawn even over a live session.
 *
 * Asked for a different reason from `gateNeedsToken` and currently answered the
 * same way, which is why they are two functions: somebody signed in on this
 * device may still click a reset link mailed to them, and `/register` over a
 * live session is a mistake worth telling them about rather than acting on. The
 * day these diverge, this assertion is deleted deliberately rather than
 * discovered.
 */
export function gateOutranksSession(screen: GateScreen): boolean {
  return gateNeedsToken(screen);
}

/**
 * The shape every token mailed by this service has.
 *
 * `xxx_` plus base64url, which is the shape `app.ts` already gives every
 * credential here. Three couplings ride on it and each is a real failure: no
 * `.` (the SPA fallback would 404 the link as an asset), no `/` (a path split
 * would cut it), no `%` (a decode would rewrite it). The prefix is deliberately
 * outside the `rk_`/`rs_` family that `credentialKind` sorts on, so a token
 * handed to `setSession` by mistake cannot be mistaken for a credential.
 *
 * The **length is not checked**. `parseSettingsRoute` validates an agent id
 * against a closed set because the daemon refuses anything else; that argument
 * is about shape and does not extend to length, which is the server's and which
 * a client pinning a number would break the day the format moved.
 */
export function isGateToken(value: string): boolean {
  return /^(et|pr)_[A-Za-z0-9_-]{16,}$/.test(value);
}

/**
 * The token out of a URL fragment, or `null`.
 *
 * Never throws, for `decodeSegment`'s reason one level up: this runs on a string
 * somebody pasted out of a chat app, and a truncated one must produce a screen
 * that says so rather than an exception. A value that is not token-shaped is
 * `null` rather than passed on, so the screen says *"this link is incomplete"*
 * instead of the server answering about a token nobody typed.
 */
export function readGateToken(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) return null;
  let value: string | null = null;
  try {
    value = new URLSearchParams(raw).get("t");
  } catch {
    return null;
  }
  if (value === null) return null;
  return isGateToken(value) ? value : null;
}

/** Whether the screen can act. A token screen with no token cannot. */
export function gateUsable(screen: GateScreen, token: string | null): boolean {
  return !gateNeedsToken(screen) || token !== null;
}

/**
 * What to offer somebody whose link arrived truncated, per screen.
 *
 * One card served all three and its button went to `/forgot`, which is the
 * **wrong remedy for two of them**. A cut-short *confirmation* link belongs to
 * somebody with no account at all: `/forgot` answers them with the same
 * deliberately blank "if that address has an account" sentence and mails
 * nothing, so the one screen whose whole job is to be a way forward was a dead
 * end. A cut-short *verify* link is for an account that already exists and is
 * already signed in somewhere; a reset is not what they lost, so there is
 * nothing honest to put on a button and the sign-in footer is the answer.
 *
 * `null` means the card carries no action, which is a real answer rather than a
 * missing one — and pure here so `webcheck` asserts all three without a DOM.
 */
export function incompleteLinkRemedy(screen: GateScreen): { label: string; path: string } | null {
  switch (screen) {
    case "confirm":
      return { label: "Sign up again", path: "/register" };
    case "reset":
      return { label: "Send a new link", path: "/forgot" };
    case "verify":
    case "register":
    case "forgot":
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * What the signed-out screen offers
 * ------------------------------------------------------------------ */

export type GateOffer = "link" | "closed" | "unknown";

/**
 * Whether to draw the "Create an account" and "Forgot password?" links.
 *
 * **This one does not decide anything on a `null` config — it answers
 * `"unknown"`, and `showsGateLink` is where failing open happens.** The
 * distinction was worth making because the misattribution had already been
 * copied into CLAUDE.md: a reader tightening *this* function to fail closed
 * would find every assertion still green, because the callers ask
 * `showsGateLink`.
 *
 * The rule the pair implements is one sentence, and it is the opposite of
 * `visibleSections`': *fail closed where the cost is a missing screen, fail open
 * where the cost is a locked-out person.* `visibleSections` hides an admin
 * section until reload and the admin still has the app; here the cost is that
 * somebody who cannot get in never sees the only door back.
 *
 * The flicker is real and bounded: `unknown → link` is no change, and
 * `unknown → closed` removes a link for about one frame. Its worst outcome is a
 * tap landing on `/register`, which says registration is closed — the same
 * sentence that screen shows anyway.
 *
 * **`forgot` keys on `email` alone, never on registration.** Registration closed
 * with mail configured is a real and important instance — admin-only, and people
 * still recover their own accounts — and an implementation keyed on one
 * "self-service" boolean gets every other cell right and this one wrong.
 */
export function gateOffer(which: "register" | "forgot", config: InstanceConfig | null): GateOffer {
  if (config === null) return "unknown";
  if (which === "register") return config.registration === "open" ? "link" : "closed";
  return config.email ? "link" : "closed";
}

/**
 * Whether to actually draw the link — **this is where failing open happens**.
 *
 * `gateOffer` answers three ways and every caller wants two, and that gap is
 * where the design was lost: the fail-open documented above was asserted as
 * `"unknown"` and then thrown away by call sites testing `=== "link"`, so an
 * unknown config drew *nothing* — the exact opposite of the intent, and visible
 * only in the frame before the config lands, which is the frame somebody
 * arriving at a sign-in screen actually looks at.
 *
 * So the three-way answer stays (it is honest, and the admin screen wants it)
 * and the two-way rule lives here, once. `!== "closed"` is the whole of it:
 * **only a definite no hides a door.**
 */
export function showsGateLink(which: "register" | "forgot", config: InstanceConfig | null): boolean {
  return gateOffer(which, config) !== "closed";
}

/**
 * The sentence that stands in for a door that is not there, or `null`.
 *
 * The property worth asserting is not the prose: **`gateNotice` is `null` if and
 * only if both links are drawn**. There is never a door missing without a
 * sentence saying so, and a fifth field on `InstanceConfig` cannot arrive
 * without answering it.
 */
export function gateNotice(config: InstanceConfig | null): string | null {
  // Through `showsGateLink`, not `gateOffer`, so this cannot disagree with what
  // was drawn — the invariant below is that it never explains a door that is
  // there, and never stays silent about one that is not.
  const canRegister = showsGateLink("register", config);
  const canRecover = showsGateLink("forgot", config);
  if (canRegister && canRecover) return null;
  if (canRegister) return "Lost your password? Ask whoever runs this control plane.";
  // Kept verbatim from the screen this replaces, in the mode it was written for:
  // "Not `cpctl` — the person reading this is not the person with a shell on the
  // control plane."
  if (canRecover) return "No account? Ask whoever runs this control plane.";
  return "New accounts and lost passwords are both handled by whoever runs this control plane.";
}

/* ------------------------------------------------------------------ *
 * What the sign-up screen draws before it knows anything
 * ------------------------------------------------------------------ */

/**
 * Everything `/register` can be, including the two states that are not about
 * the instance at all.
 */
export type SignupScreen = SignupMode | "waiting" | "unavailable";

/**
 * Which of the five the sign-up screen is in, given the config and whether a
 * read of it has **finished**.
 *
 * `signupMode` answers `null` for an unknown config and is right to — this is
 * the one screen that may not guess, because the wrong guess in either
 * direction is a form that cannot work (see its own docblock). What was missing
 * is the second input: *has anybody finished asking?* Without it `null` means
 * both "the answer is coming" and "there is no answer", the screen drew a
 * spinner for the union of the two, and `GET /v1/instance` failing once left a
 * **footerless spinner for ever** — a signed-out tab never re-reads the config
 * (`runResume`'s re-read is behind `cp.currentCredential() !== null`), so
 * nothing was coming and nothing said so. Reached by the ordinary road:
 * `showsGateLink` fails *open*, so the sign-in screen offers "Create an account"
 * precisely when the config is unknown, and its justification — *"its worst
 * outcome is a tap landing on `/register`, which says registration is closed"* —
 * held only while the config eventually lands.
 *
 * **`unavailable` is derived and therefore never sticky.** A read that lands
 * after the screen gave up supersedes it on the next render, because the config
 * is tested first and the flag only ever decides between the two answers left
 * when there is no config at all. That is the whole reason this is a function of
 * both rather than a latched piece of component state.
 */
export function signupScreen(config: InstanceConfig | null, settled: boolean): SignupScreen {
  return signupMode(config) ?? (settled ? "unavailable" : "waiting");
}
