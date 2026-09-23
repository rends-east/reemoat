import type { AuthFailure } from "./account";
import { authFailure, WrongAccount } from "./account";
import { ApiError, readJson, withTimeout } from "./http";
import { parseInstanceConfig } from "./instance";
import type { CpInit } from "./native";
import {
  bindNativeCredential,
  clearNativeCredential,
  cpSend,
  inNativeShell,
  nativeBoot,
  setNativeDevice,
} from "./native";
import type { ConfigField, InstanceConfig } from "./instance";
import type {
  AdminUser,
  CreatedMachine,
  CreatedUser,
  DeviceRecord,
  EnrollmentCode,
  IssuedToken,
  MachineRecord,
  Me,
  SessionRecord,
  SessionToken,
} from "./wire";

/**
 * The control plane, from the browser.
 *
 * **The credential is sent to one origin and nowhere else.** It never goes to a
 * daemon and never to the relay; those get short-lived, machine-scoped tokens that
 * this service mints. That is the security boundary, and it is held two different
 * ways depending on where this code is running.
 *
 * In a browser it is held by *being* same-origin: this page is served by the
 * control plane, and in dev Vite proxies `/v1` to it rather than letting the call
 * go cross-origin. In the native shell there is no such thing as same-origin — the
 * document comes from a custom scheme and the control plane mounts no CORS at all —
 * so the base URL lives in the host process instead, this module sends it a *path*,
 * and the host refuses anything that would leave the configured origin. **Stronger
 * than same-origin rather than weaker**: the page cannot name the address the
 * credential goes to. `native.ts` is the seam and `.claude/rules/native-shell.md`
 * carries the argument.
 *
 * The credential is a session token now, obtained by signing in. It is **not a
 * cookie**: `src/cors.ts` answers `*` and never sends
 * `Access-Control-Allow-Credentials`, and that wildcard is only safe because no
 * credential here is ever ambient. So it is stored by this module and put in a
 * header by this module, exactly as the API key it replaced was.
 */

const CREDENTIAL_STORAGE = "reemoat.credential";

/**
 * What previous builds wrote, read once and adopted under the name above.
 *
 * Two of them now, and both are read for the same reason: **a rename must not sign
 * anybody out.** `remoslop.credential` is the same credential under the old
 * product name, and `remoslop.apiKey` is older still — an `rk_` key, which is a
 * valid bearer either way, since `callerAuth` on the control plane takes both
 * kinds. A deploy that stopped reading either would have logged out every open tab
 * in the fleet for no reason at all.
 *
 * Adopted rather than merely tolerated: the value moves to the new name and the
 * old one is removed, so these have an end date rather than being extra names that
 * have to keep working for ever. Ordered newest-first, so a tab holding both takes
 * the session token over the older key.
 */
/*
 * ⚠ **These are historical literals and must never be renamed with the product.**
 *
 * A blanket rename caught them once and the failure was immediate and total:
 * `setSession` writes `CREDENTIAL_STORAGE` and then sweeps this list, so with the
 * same string in both, signing in deleted the credential it had just written and
 * every request went out unauthenticated. `webcheck` caught it on the first run.
 *
 * What these name is not this product — it is **what is already sitting in
 * somebody's browser**, written by a build that shipped under the old name. They
 * stop being useful only once no tab in the fleet has been signed in since before
 * the rename, and then they are deleted rather than updated.
 */
const LEGACY_STORAGE = ["remoslop.credential", "remoslop.apiKey"];

/**
 * Which device this browser is registered as, on this origin.
 *
 * **Deliberately a separate key rather than a field beside the credential**, and
 * not merely for tidiness: it survives a sign-out. That is the whole behaviour —
 * signing out ends a session, and the computer you signed out of is still the same
 * computer, so the next sign-in re-binds the same row rather than registering a
 * second one for one machine.
 *
 * `LEGACY_STORAGE` has no twin here and never will: nothing wrote this under an
 * older name, so there is nothing to adopt and nothing to sweep.
 *
 * A browser origin scopes this for free, which is why it needs no origin in the
 * key — the asymmetry with the native shell, where one webview origin serves every
 * server and `config.rs` keys the same value by origin, is `native-shell.md`'s and
 * is not an inconsistency.
 */
const DEVICE_STORAGE = "reemoat.device";

const CP_TIMEOUT_MS = 10_000;

export type CredentialKind = "session" | "api_key";

export interface Credential {
  value: string;
  kind: CredentialKind;
}

/**
 * Which credential a stored string is.
 *
 * The three-character prefix, the same one `keyPrefix` on the control plane
 * assumes. Nothing branches on it for authorization — both are full authority —
 * but a client that knows it holds an API key can say "this is a key, there is no
 * session to sign out of" rather than showing a button that 409s.
 */
export function credentialKind(value: string): CredentialKind {
  return value.startsWith("rk_") ? "api_key" : "session";
}

/**
 * Which of the two stored names to believe, and whether the old one was adopted.
 *
 * Pure because the impure half runs **once, at import time**, and a module is
 * imported once per process — so a driver gets exactly one seeding of storage and
 * no more. This is the whole migration rule, reachable without one.
 */
export function pickStored(
  fresh: string | null,
  legacy: string | null,
): { value: string; kind: CredentialKind; migrated: boolean } | null {
  if (fresh !== null && fresh.length > 0) {
    return { value: fresh, kind: credentialKind(fresh), migrated: false };
  }
  if (legacy !== null && legacy.length > 0) {
    return { value: legacy, kind: credentialKind(legacy), migrated: true };
  }
  return null;
}

/**
 * The one header, from the one credential.
 *
 * A session token and a legacy API key are sent **identically** — same header,
 * same origin, nothing extra for either. Out here so that stays something a test
 * asserts rather than something `cpFetch` happens to do.
 */
export function authHeader(credential: Credential | null): Record<string, string> | null {
  if (credential === null) return null;
  return { authorization: `Bearer ${credential.value}` };
}

/*
 * ⚠ **Two stores, and which one is read is decided synchronously, here.**
 *
 * In a browser this line is unchanged and is the whole story: `localStorage`, read
 * once in the module body, with the pre-rename names adopted and swept.
 *
 * In the native shell there is no `localStorage` worth trusting, and the sharper
 * reason is not trust: **there is one webview origin for every server somebody
 * might point that app at.** A browser hands out one storage area per origin and
 * therefore scopes a credential to a server for free; a custom scheme does not. So
 * the credential lives in the operating system's credential store under a key that
 * *is* the account — the server's origin and the person the control plane says the
 * token is (`credential#<origin>#<userId>`, `packages/native/src-tauri/src/credential.rs`)
 * — which means it cannot be read for a server it was not issued by, nor for a
 * second person on the same server, structurally rather than because a code path
 * remembered to clear it on a change. Which account a window is, the host decides;
 * this module holds one credential, because a window is one account (Q1.651).
 *
 * That store is async and this assignment is not, so the native arm starts empty
 * and `store.bootstrap()` fills it through {@link adoptHydratedCredential} after
 * awaiting `hostReady`. `nativeHydrating()` is what stops the sign-in screen being
 * drawn in the frame before it lands. The alternatives, and why each is worse, are
 * in `native.ts`'s docblock for `hostReady`.
 */
let credential: Credential | null = inNativeShell() ? null : readStoredCredential();

/**
 * Adopt what the operating system's credential store held, once it has answered.
 *
 * **A function the store calls rather than a `.then` registered here**, so the
 * ordering is something a reader can see and a driver can drive: two promise
 * callbacks on one promise resolve in registration order, which is true and is
 * exactly the kind of thing that stops being true when somebody moves an import.
 *
 * A credential adopted since is **newer than the keyring's** and wins — a sign-in
 * that completed while the keyring read was in flight is the whole case, and it is
 * the same reasoning `cpFetch` uses when it refuses to let a late 401 clear a fresh
 * credential.
 */
export function adoptHydratedCredential(value: string | null): void {
  if (value === null || credential !== null) return;
  credential = { value, kind: credentialKind(value) };
}

function readStoredCredential(): Credential | null {
  try {
    const picked = pickStored(
      window.localStorage.getItem(CREDENTIAL_STORAGE),
      LEGACY_STORAGE.map((key) => window.localStorage.getItem(key)).find(
        (value) => value !== null && value.length > 0,
      ) ?? null,
    );
    if (picked === null) return null;
    if (picked.migrated) {
      window.localStorage.setItem(CREDENTIAL_STORAGE, picked.value);
      for (const key of LEGACY_STORAGE) window.localStorage.removeItem(key);
    }
    return { value: picked.value, kind: picked.kind };
  } catch {
    // Private browsing, or storage disabled. The app still works for one
    // session; it just asks for the password again next time.
    return null;
  }
}

export function currentCredential(): Credential | null {
  return credential;
}

/**
 * Adopt a credential: a session token from `login`, or an **API key somebody
 * pasted**.
 *
 * The second half is not a leftover. `callerAuth` takes either, `CLAUDE.md` says
 * an API key is how you get back in when a password is lost or this service has
 * been rolled back past the release that added them — and `KeyGate`, the only
 * field that ever accepted an `rk_`, is deleted. Without a way to put one in
 * here, a single 401 (a swept key, an expired session, a rollback) locks a
 * key-only account out of the browser permanently.
 *
 * **The sign-in screen no longer offers that field**, so nothing in this app
 * calls `setSession` with an `rk_` any more — but this still accepts one,
 * because `readStoredCredential` adopts a key a tab was already holding, and a
 * deploy that stopped doing so would sign the fleet out. `credentialKind` tells
 * the two apart for labelling only; nothing branches on it for authority,
 * because both are full authority.
 *
 * Trimmed, because the value arrives by paste out of a terminal.
 */
export function setSession(token: string): void {
  credential = { value: token.trim(), kind: credentialKind(token.trim()) };
  /*
   * ⚠ **The native arm returns, and never falls through to the writes below.**
   *
   * Writing to `localStorage` *as well* would be the one thing a native client must
   * not do: the whole reason the credential lives in the OS store is that a
   * webview's storage is neither protected nor scoped to a server, and a second
   * copy sitting beside it would be the unprotected one somebody later reads.
   * `webcheck` asserts the absence under all three names rather than trusting this
   * comment.
   *
   * ⚠ **And it writes nothing through the bridge either — this is memory only.**
   * In the shell a credential is stored *against the account it belongs to*, and
   * the account is exactly what the sign-in finds out: so the keyring write is
   * `login`'s awaited `bindNativeCredential`, which the host answers only after
   * asking the control plane whose the token is. By the time this runs the host
   * has already filed it, and a second write from here would be a second writer
   * with no idea which account it was writing for.
   */
  if (inNativeShell()) return;
  try {
    window.localStorage.setItem(CREDENTIAL_STORAGE, credential.value);
    /*
     * Sweep the pre-rename names here too, not only on adoption and sign-out.
     *
     * `readStoredCredential` runs once, in the module body. So a tab that was
     * already open when the rename shipped signs in fresh, writes the new name —
     * and leaves the old one holding a token that the *next* page load would
     * adopt in preference to nothing. Signing out then looks like it worked and
     * the reload puts you back in on a credential you thought you had discarded.
     */
    for (const key of LEGACY_STORAGE) window.localStorage.removeItem(key);
  } catch {
    // See above: in-memory is a usable degraded mode, an exception here is not.
  }
}

export function clearSession(): void {
  credential = null;
  // Removed from the keyring rather than blanked, and before anything else: this is
  // the path `store.signOut()` takes, and it ends in a full reload.
  //
  // ⚠ **The device is deliberately left alone here.** Signing out ends a session;
  // the computer is still the same computer, and the row on the server is still
  // live. Clearing it would make every sign-out register a second device for one
  // machine, which walks an account into its device limit. `forgetDevice` is the
  // separate act, called on `device_revoked` alone.
  //
  // In the shell the host erases *this window's account's* entry and nobody
  // else's — it knows which from the window and the document, and the page names
  // none (`clearNativeCredential`).
  if (inNativeShell()) {
    clearNativeCredential();
    return;
  }
  try {
    window.localStorage.removeItem(CREDENTIAL_STORAGE);
    for (const key of LEGACY_STORAGE) window.localStorage.removeItem(key);
  } catch {
    // Nothing to do; the in-memory value is already cleared.
  }
}

/**
 * Stop presenting the credential this page holds, and **leave the stored one
 * where it is** — the half of `clearSession` a server change needs and nothing
 * more.
 *
 * ⚠ **This exists for one caller, `ChooseServer`, and it is the page's half of a
 * switch's safety.** `host_set_server` moves the base in the host process, so from
 * the instant it returns every `host_cp` call goes to the *new* origin; a bearer
 * still held here would ride the next four-second poll or `cpFetch` to a host
 * somebody has just typed in. Nulling it first means none of those is *sent* with
 * one — a request already dispatched carries its header regardless, and what keeps
 * that one on the old server is that the host reads its base when it runs.
 * `state.host` still holds the boot's copy until the reload, and nothing between
 * here and that reload adopts it.
 *
 * What it no longer does is erase `credential#<origin>`: the server being left
 * stays signed in on this computer, so switching back asks nothing (Q7.148). The
 * keyring entry is keyed on its own origin and the page reloads on the new one,
 * so a kept credential is still never read for any other server. Signing out is
 * still `clearSession`, and still erases the current server's entry alone.
 *
 * ⚠ **Switching *accounts* deliberately does not call this**, and that is not an
 * oversight next to `ChooseServer`'s call. A document is one account for its whole
 * life: where the host shows another account it shows another *window*, and this
 * one stays alive and hidden with its session, sockets and poll intact; where it
 * rebinds this window instead, it rotates the document's generation, so every late
 * command this document still sends is refused rather than landing on the account
 * that replaced it (Q5.120). A detach there would strand a live hidden page with no
 * credential, which is the one outcome worse than the race it would be guarding.
 * `ChooseServer` still needs it because a pending window's server moves *under* the
 * same document, which is the one move that is not a new one.
 */
export function detachSession(): void {
  credential = null;
}

/**
 * Which installation this client is registered as, or `null`.
 *
 * In the shell this comes from `NativeBoot` — the shell's own configuration file,
 * **not its keyring**, so it survives a machine whose credential store silently
 * discards writes (`config.rs` carries that argument). In a browser it is
 * `localStorage`, which the origin already scopes.
 */
export function currentDevice(): string | null {
  if (inNativeShell()) return nativeBoot()?.deviceId ?? null;
  try {
    const held = window.localStorage.getItem(DEVICE_STORAGE);
    return held === null || held.length === 0 ? null : held;
  } catch {
    // Private browsing, or storage disabled. The app registers a device per
    // session instead, which is the same degraded mode the credential has.
    return null;
  }
}

/**
 * Whether the stored device is bound to the session this page holds.
 *
 * `true` in a browser, and that is not a claim about a browser's device: a browser
 * registers none, so there is nothing for this to gate. In the shell it is the
 * host's own flag ({@link NativeBoot.deviceBound}) — `false` from the moment a
 * credential is written until `host_device_set` stores what the control plane
 * answered — so a sign-in in this document is followed by a registration even
 * though the account's device id is already known. **A shell that has not answered
 * is not evidence either way**, and reads as bound: the id it would be checked
 * against is `null` there anyway, which already registers.
 */
export function deviceBound(): boolean {
  return !inNativeShell() || nativeBoot()?.deviceBound !== false;
}

/** Remember the device the control plane just bound this session to. */
export function rememberDevice(id: string): void {
  if (inNativeShell()) {
    setNativeDevice(id);
    return;
  }
  try {
    window.localStorage.setItem(DEVICE_STORAGE, id);
  } catch {
    // See `currentDevice`: in-memory-only is a working degraded mode.
  }
}

/**
 * Give up the stored device id.
 *
 * Called on `device_revoked` and on nothing else — see `clearSession`, which
 * deliberately does not. The server declines to bind a retired id and registers a
 * fresh device instead, so this is belt rather than the only guard; what it buys
 * is that the client stops presenting something it has been told is finished.
 */
export function forgetDevice(): void {
  if (inNativeShell()) {
    setNativeDevice(null);
    return;
  }
  try {
    window.localStorage.removeItem(DEVICE_STORAGE);
  } catch {
    // Nothing to do.
  }
}

/**
 * Told when this origin stops accepting the credential we hold.
 *
 * `cp.ts` cannot import `store.ts` — the dependency runs the other way and always
 * has — so the store registers a handler here rather than this module knowing what
 * a phase is.
 */
let signedOutHandler: ((failure: AuthFailure) => void) | null = null;

export function onSignedOut(handler: (failure: AuthFailure) => void): void {
  signedOutHandler = handler;
}

async function cpFetch<T>(path: string, init: CpInit = {}): Promise<T> {
  /*
   * Which credential this request actually carried, held so the refusal below can
   * be attributed to it rather than to whatever is current when it lands.
   *
   * `setSession` always allocates, so identity is the whole comparison.
   */
  const sent = credential;
  const headers = authHeader(sent);
  if (headers === null) throw new ApiError(401, "missing_api_key", "not signed in");
  if (init.body !== undefined) headers["content-type"] = "application/json";

  const response = await cpSend(path, { ...init, headers, signal: withTimeout(CP_TIMEOUT_MS) });
  try {
    return await readJson<T>(response);
  } catch (error) {
    /*
     * **The one place a dead credential is noticed, because it is the one place
     * the credential is used.**
     *
     * Before this the only 401 handler was `bootstrap()`, which runs at load. A
     * key revoked while the tab was open therefore never returned anybody to the
     * gate: `machine.ts`'s `ensureToken` caught the failed `mintToken`, marked
     * that machine `offlineReason: "no_token"`, and the app read as a fleet that
     * had gone to sleep. A session has a TTL, so *everybody* reaches that state
     * eventually rather than only somebody an admin revoked.
     *
     * **And only about the credential that was refused.** A request lives up to
     * `CP_TIMEOUT_MS`, which is ten seconds of window in which the credential can
     * be replaced: a slow `GET /v1/me/sessions` sent with an expired token, a
     * wake that notices the expiry first, a sign-in that succeeds, and then the
     * old request finally answering `401 session_expired` — which used to clear
     * the *new* token from memory and from `localStorage` and drop the tab back
     * to the gate saying "your session expired", about a session that was
     * perfectly good and, `DELETE /v1/me/sessions/current` never having been
     * sent, then lingered for its full thirty days.
     */
    const failure = authFailure(error);
    if (failure !== null && credential === sent) {
      clearSession();
      signedOutHandler?.(failure);
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Before there is a credential
 *
 * Everything in this block uses a raw `fetch` rather than `cpFetch`, for
 * `login`'s stated reason: `cpFetch`'s first act is to refuse when there is no
 * credential, so routing these through it would need a special case in exactly
 * the place that must not have any.
 *
 * The tokens these carry come out of a URL **fragment** and never out of a path
 * or a query — see `gate.ts` for why — and every one of them is spent with a
 * `POST`, so a mail scanner that follows the link cannot consume it.
 * ------------------------------------------------------------------ */

async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const response = await cpSend(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: withTimeout(CP_TIMEOUT_MS),
  });
  return await readJson<T>(response);
}

/**
 * What this instance allows, for the screen that has no credential yet.
 *
 * Its caller's catch is **bare and load-bearing**: a control plane rolled back
 * past this release answers 404 here, and that is not an outage and must not
 * draw one. `config` simply stays `null`, which both predicates in `gate.ts`
 * answer.
 *
 * **The body is parsed, never cast**, and that is the whole of a shipped defect:
 * this read `readJson<InstanceConfig>(response)`, which is an unchecked
 * assertion over two shapes that have never matched — the server answers
 * `{registration: {enabled}, mail: {configured}}` and `InstanceConfig` is flat.
 * A body this client cannot read **throws**, joining the rolled-back control
 * plane on the one path that already exists for "we do not know", where `config`
 * stays `null` and every door is drawn. The alternative — returning a config
 * with everything off — is the failure it replaces.
 */
export async function instanceConfig(): Promise<InstanceConfig> {
  const response = await cpSend("/v1/instance", { signal: withTimeout(CP_TIMEOUT_MS) });
  const config = parseInstanceConfig(await readJson<unknown>(response));
  if (config === null) throw new Error("this control plane described itself in a shape this client cannot read");
  return config;
}

/**
 * Ask for an account.
 *
 * **Two shapes, narrowed here into a union** rather than left as
 * `{pending, token?, email?}` for every call site to re-derive. With mail
 * configured nothing exists until the link is opened; without it the account is
 * created and this hands back a session.
 */
export type RegisterAnswer =
  | { kind: "session"; session: SessionToken }
  | { kind: "sent"; expiresAt: number };

export async function register(input: {
  name: string;
  password: string;
  email?: string;
  /** Sent only on an instance that publishes documents to agree to. */
  acceptedTerms?: boolean;
}): Promise<RegisterAnswer> {
  const body = await publicPost<SessionToken & { pending: boolean; expiresAt: number }>("/v1/register", input);
  if (body.pending) return { kind: "sent", expiresAt: body.expiresAt };
  return { kind: "session", session: body };
}

/**
 * Spend a confirmation link, which creates the account and **hands back no
 * credential**.
 *
 * The return type is the guard, the same way `requestPasswordReset` returning
 * `void` is: there is no token in this answer to adopt even by accident, so a
 * future call site cannot quietly turn a link out of a mailbox back into a
 * session. Confirming proves control of an address; the password proves who you
 * are, and this flow is the one where those can be two different people.
 */
export function confirmRegistration(token: string): Promise<{ user: { name: string } }> {
  return publicPost<{ user: { name: string } }>("/v1/register/confirm", { token });
}

/**
 * Ask for a reset link.
 *
 * **The return type is the anti-enumeration guard.** There is nothing in the
 * answer for a screen to branch on, so `/forgot` cannot tell a stranger whether
 * an address has an account here even by accident — enforced by the signature
 * rather than by a comment, which is the cheapest possible place to enforce it.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await publicPost<{ sent: boolean }>("/v1/forgot", { email });
}

export function consumePasswordReset(token: string, newPassword: string): Promise<SessionToken & { apiKeysActive: number }> {
  return publicPost<SessionToken & { apiKeysActive: number }>("/v1/reset", { token, newPassword });
}

/* ------------------------------------------------------------------ *
 * Signing in
 * ------------------------------------------------------------------ */

/**
 * The account a sign-in turned out to be is already on this computer.
 *
 * Two of the host's answers arrive as this — `existing`, where that account is
 * signed in and the host revoked the session just made, and `adopted`, where it
 * was signed out and the host gave it this one — and both mean the same thing to
 * the page: **this window is not where that account lives, so go there.** A named
 * rejection rather than a return value, so `SignIn` and the gate's store keep the
 * one-promise shape `login` has always had, and only the app's store, which can
 * move windows, has to know it exists.
 *
 * `account` is the key the host answered with, and is only ever handed back to
 * it (`switchNativeAccount`); `null` there falls back to the account shown before.
 */
export class AccountAlreadyOpen extends Error {
  constructor(readonly account: string | null) {
    super("that account is already on this computer");
    this.name = "AccountAlreadyOpen";
  }
}

/**
 * Deliberately not through `cpFetch`: there is no credential yet, and routing it
 * through the function whose first act is to refuse without one would need a
 * special case in exactly the place that must not have any.
 */
export async function login(name: string, password: string): Promise<Me> {
  /*
   * ⚠ **The request names no device, and it used to — one round trip rather than
   * two, the argument `GET /v1/me` makes for `canAddMachine`.** That argument was
   * sound while a device belonged to a computer. In the shell it belongs to an
   * *account*, and the account is exactly what this request finds out: offering
   * the stored id, and above all its public key, would hand whoever signs in next
   * the device of whoever signed in last. The control plane's owner clause makes a
   * foreign *id* harmless — it registers a fresh row — but it copies the offered
   * *key* onto that row, and one key on two accounts' rows links them, which is
   * the thing `credential.rs` keeps a key per account to prevent.
   *
   * So registration moves one round trip later, to `ensureDevice` in the
   * bootstrap that follows in this same document, after the host has said whose
   * account this is and handed back that account's own id and key. In a browser
   * nothing changes: `describeDevice()` answered `null` there, so this body was
   * already these two fields.
   */
  const response = await cpSend("/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
    signal: withTimeout(CP_TIMEOUT_MS),
  });
  const body = await readJson<SessionToken>(response);
  if (inNativeShell()) {
    /*
     * ⚠ **In the shell nothing is adopted until the host has filed it.** The host
     * asks the control plane whose the token is — against this window's own
     * origin, with the token itself — and answers what it did with it. Only
     * `bound` makes it this window's; every other answer, every unknown answer and
     * every rejection leaves the page holding nothing (Q1.651).
     *
     * The rejection is the case that used to be forgiven. The old setter was
     * fire-and-forget, because a keyring that would not keep a write is the
     * `durable: false` state and memory is a usable degraded mode for *that*. It is
     * not one for this: a token the host could not attribute — the control plane
     * unreachable from the host, a refusal — is a session in a window that may be
     * somebody else's account, and adopting it would register that account's
     * device for this person and start its daemon under their sign-in. A failed
     * sign-in costs a retry; the other costs an identity. Nothing revokes that
     * token: the host could not reach the server it would revoke on, and a pending
     * window may not send a bearer at all — it is bounded by the per-account
     * session cap and idle expiry instead.
     *
     * `existing` and `refused` were revoked by the host, which already held the
     * token; the page sends no request with a bearer it never adopted.
     */
    const bound = await bindNativeCredential(body.token);
    if (bound.outcome === "adopted" || bound.outcome === "existing") throw new AccountAlreadyOpen(bound.account);
    if (bound.outcome === "refused") throw new WrongAccount();
    if (bound.outcome !== "bound") throw new Error("this computer did not keep that sign-in");
  }
  setSession(body.token);
  return body.user;
}

/**
 * What this installation should be called, or `null` where it is not one.
 *
 * `null` in a browser: a tab is not an installation somebody chose to register,
 * and naming it after its `User-Agent` would put a guess in a list whose whole
 * value is that its rows were named by a person. The sessions list already
 * describes a browser through `device.ts`, which is the right surface for it.
 *
 * In the shell the name is the computer's own — the same string `machineLabelFor`
 * uses when this app buys a machine — because that is the word somebody will
 * recognise in a list of three.
 */
function describeDevice(): { id?: string; name: string; platform: string; publicKey?: string } | null {
  const boot = nativeBoot();
  if (!inNativeShell() || boot === null) return null;
  const name = boot.hostName ?? "This computer";
  const held = currentDevice();
  /*
   * ⚠ **The key travels with the registration, and it is what makes a capability
   * more than a bearer token.** The control plane names it in everything it mints
   * for this installation, and the daemon compares that name against the key the
   * encrypted handshake authenticated — so a capability copied off this device is
   * worth nothing to whoever copied it.
   *
   * Omitted rather than sent as `null` where the shell has none, which is a real
   * state on a machine no credential store would answer for. The route keeps the
   * registration and says the installation has no key; minting is what refuses,
   * with a code naming the remedy.
   */
  const key = boot.devicePublicKey ?? undefined;
  return {
    ...(held === null ? {} : { id: held }),
    name,
    platform: boot.platform,
    ...(key === undefined ? {} : { publicKey: key }),
  };
}

/* ------------------------------------------------------------------ *
 * Devices
 * ------------------------------------------------------------------ */

/**
 * Register this installation, or adopt the one it already holds.
 *
 * ⚠ **How every native sign-in is bound now, not only a restored one.** It used to
 * be the path for a session that came back from storage with no device, `login`
 * binding its own in the request that signed in. `login` names no device any more
 * (its own block says why), so `store.bootstrap()` calls this whenever the stored
 * id is missing *or not bound to this session* — right after a sign-in, in the
 * same document, and before anything mints a capability. It is also the retry for
 * a first registration that failed, because the bound flag stays `false`.
 *
 * ⚠ **Single-flight, because it has two callers that can meet.** `ensureDevice`
 * runs it after a sign-in, and a mint refused with `device_key_required` runs it
 * again (`machine.ts`); with a `null` id both would describe *no* id and the
 * control plane would register two rows for one computer. A second caller waits
 * on the first's answer instead. Released when it settles, never latched, so a
 * key reset later in the same document registers again.
 *
 * Answers `null` where there is nothing to register: a browser, or a shell that
 * could not describe itself. The caller treats that as "no device", which is an
 * ordinary state rather than a failure.
 */
export function registerDevice(): Promise<string | null> {
  registering ??= registerOnce().finally(() => {
    registering = null;
  });
  return registering;
}

/** The registration in flight, shared by whoever asks while it is. */
let registering: Promise<string | null> | null = null;

async function registerOnce(): Promise<string | null> {
  const device = describeDevice();
  if (device === null) return null;
  const body = await cpFetch<{ id: string; hasKey?: boolean }>("/v1/me/devices", {
    method: "POST",
    body: JSON.stringify(device),
  });
  rememberDevice(body.id);
  return body.id;
}

/** The installations on this account — live, and recently retired. */
export async function devices(): Promise<{ devices: DeviceRecord[]; limit: number }> {
  return await cpFetch<{ devices: DeviceRecord[]; limit: number }>("/v1/me/devices");
}

/**
 * Retire one installation, ending every sign-in on it.
 *
 * ⚠ **Retiring the one you are holding is allowed and ends this session**, which
 * is what somebody reaching for it on a machine they are giving away wants — and
 * refusing would mean the last device on an account could never be retired. The
 * caller is what confirms; this does not guess.
 */
export function revokeDevice(id: string): Promise<{ revoked: boolean; sessionsRevoked: number }> {
  return cpFetch<{ revoked: boolean; sessionsRevoked: number }>(`/v1/me/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/**
 * End this session server-side, then locally whatever happened.
 *
 * The local half is in a `finally` on purpose: a control plane that is down must
 * never be able to trap somebody in an app they are trying to leave.
 */
export async function logout(): Promise<void> {
  try {
    await cpFetch<{ revoked: boolean }>("/v1/me/sessions/current", { method: "DELETE" });
  } catch {
    // Already expired, an API key rather than a session, or the service is down.
    // None of those is a reason to stay signed in on this device.
  } finally {
    clearSession();
  }
}

export async function changePassword(current: string | undefined, next: string): Promise<number> {
  const body = await cpFetch<{ sessionsRevoked: number }>("/v1/me/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword: current, newPassword: next }),
  });
  return body.sessionsRevoked;
}

export function me(): Promise<Me> {
  return cpFetch<Me>("/v1/me");
}

export async function sessions(): Promise<SessionRecord[]> {
  const body = await cpFetch<{ sessions: SessionRecord[] }>("/v1/me/sessions");
  return body.sessions;
}

export function revokeSession(id: string): Promise<{ revoked: boolean }> {
  return cpFetch<{ revoked: boolean }>(`/v1/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * Sign out everywhere else, and answer how many that was.
 *
 * **`revokedCount`, not `revoked`.** The two single-session deletes beside this
 * one answer `{revoked: true}`; this one used to answer `{revoked: 3}` under the
 * identical key, so a client reading `body.revoked` as the outcome got `true`
 * from one route and `0` — falsy, i.e. "it failed" — from the honest answer that
 * there was nothing left to sign out of. The server renamed the count; this is
 * the client following, and it returns the number rather than the envelope so
 * there is no second chance to read the wrong field.
 */
export async function revokeOtherSessions(): Promise<number> {
  const body = await cpFetch<{ revokedCount: number }>("/v1/me/sessions?keepCurrent=1", { method: "DELETE" });
  return body.revokedCount;
}

/* ------------------------------------------------------------------ *
 * API keys
 *
 * The one credential here that never expires. `revoked_at` was a column nothing
 * could write — `callerAuth` read it and answered `api_key_revoked`, so the
 * capability looked present from both ends while a leaked key was immortal until
 * the account holding it was deleted outright. These four routes are the write
 * that was missing, and two of them are for *everybody* rather than for an
 * admin: the person most likely to know a key leaked is the person who pasted
 * it somewhere.
 * ------------------------------------------------------------------ */

/**
 * One API key, as much of it as may ever be shown.
 *
 * **Never the key and never its hash.** Only the hash was stored, so the
 * plaintext is unrecoverable by construction; `prefix` is the eight clear
 * characters the lookup is indexed on and is the only thing that lets somebody
 * holding two keys tell which row is which.
 *
 * `revokedAt` is `null` for a key that still works. Revoked rows are **listed
 * rather than filtered** — the question this list answers is "is the one that
 * leaked dead yet", which a row that vanishes on revocation cannot answer.
 *
 * Declared here rather than in `wire.ts` because it is a control-plane shape
 * that only this module and its callers ever see; nothing on the daemon's wire
 * has an opinion about it.
 */
export interface ApiKeyRecord {
  id: string;
  prefix: string;
  createdAt: number;
  revokedAt: number | null;
  /**
   * When this key last authenticated a request, or `null` for never — written by
   * the control plane at most once a minute, so it is a day-resolution fact.
   * Optional on the wire: an older control plane does not send it, and a row
   * without it reads the same as one never used.
   */
  lastUsedAt?: number | null;
}

export async function myKeys(): Promise<ApiKeyRecord[]> {
  const body = await cpFetch<{ keys: ApiKeyRecord[] }>("/v1/me/keys");
  return body.keys;
}

/**
 * Retire one of your own keys, **including the one you are holding**.
 *
 * Refusing that would be refusing the whole point: "this key leaked" is exactly
 * the case where the leaked key is the one in your hand. The consequence is
 * immediate: once the 200 lands the key in this tab is dead. `KeysSection` does
 * not wait to find that out from the next request — it records the notice,
 * clears the credential and reloads, with no request in between (Q3.546,
 * decision 5A) — because the other route to the gate, `cpFetch` seeing a `401
 * api_key_revoked`, reads "Your session expired" about an act the person just
 * chose. That arm is still the backstop for a key revoked from anywhere else: an
 * admin, or another tab.
 */
export function revokeMyKey(keyId: string): Promise<{ revoked: boolean }> {
  return cpFetch<{ revoked: boolean }>(`/v1/me/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
}

/**
 * Mint yourself a key.
 *
 * **This is what replaces `adminMintKey`**, and it is the only way a key comes
 * into existence outside the bootstrap: an admin may take a credential away and
 * may never issue one.
 *
 * The session is the whole proof (Q1.630): the route asked for the current
 * password until 2026-09-04 and the owner took that out. What stands in for it
 * is the keys table itself — every key listed, dated, marked if it is this
 * browser's, and one tap to revoke.
 */
export function mintMyKey(): Promise<{ apiKey: string }> {
  return cpFetch<{ apiKey: string }>("/v1/me/keys", { method: "POST" });
}

/* ------------------------------------------------------------------ *
 * Your address, which is the only thing that makes recovery possible
 * ------------------------------------------------------------------ */

/**
 * Set or change it. A confirmation goes out; nothing is verified until it is used.
 *
 * A session is the whole proof (Q1.630): the route asked for the current
 * password until 2026-09-04 and the owner took that out, knowing the chain the
 * control plane's own docblock on `PUT /v1/me/email` records. An API key is not
 * (Q1.630, amended 2026-09-05): the route asks a key holder with a password for
 * `currentPassword`, which this call never sends — `SignIn` takes no key, so the
 * one browser that presents one is the legacy adoption from `LEGACY_STORAGE`,
 * and on the email leaf it draws the server's 400 sentence with no field to
 * answer it. Whether that adoption should drop an `rk_` key rather than adopt
 * it as a bearer is an owner's call, recorded here rather than decided.
 */
export function setMyEmail(email: string): Promise<{ email: string; verified: boolean }> {
  return cpFetch<{ email: string; verified: boolean }>("/v1/me/email", {
    method: "PUT",
    body: JSON.stringify({ email }),
  });
}

export function verifyMyEmail(token: string): Promise<{ email: string; verified: boolean }> {
  return cpFetch<{ email: string; verified: boolean }>("/v1/me/email/verify", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/* ------------------------------------------------------------------ *
 * Machines
 * ------------------------------------------------------------------ */

/**
 * The machine registry: every machine this user holds a grant on.
 *
 * An empty list no longer means "ask an admin for a grant" — it means you have
 * not added a machine yet, and the screen that fixes it is one tap away. That is
 * the whole of what user-owned machines changed here.
 */
export async function machines(): Promise<MachineRecord[]> {
  const body = await cpFetch<{ machines: MachineRecord[] }>("/v1/machines");
  return body.machines;
}

/**
 * Rename a machine you own — your **label** for it, not the row's fleet-wide
 * name, which nobody chooses and nothing here can change.
 *
 * A machine you do not own answers `404 machine_not_found`, never a 403, so a
 * caller cannot map the fleet by watching which ids answer differently. A name
 * somebody can already see is a `409 machine_exists`, which is wider than the
 * unique index on purpose: two rows reading the same word in one list is worse
 * than a refusal, because that word is also what `POST /v1/tokens` resolves.
 */
export function renameMachine(id: string, name: string): Promise<{ id: string; name: string; owned: boolean }> {
  return cpFetch<{ id: string; name: string; owned: boolean }>(`/v1/machines/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function mintEnrollment(id: string): Promise<EnrollmentCode> {
  return cpFetch<EnrollmentCode>(`/v1/machines/${encodeURIComponent(id)}/enrollments`, { method: "POST" });
}

/**
 * Register a machine, grant it to yourself and mint its first code — one request.
 *
 * ⚠ **This function existed, was deleted on 2026-09-04, and is back for a
 * different caller.** It went with the by-name "add a machine" form on Settings →
 * Machines, because a machine is enrolled *from the host it runs on* and a code
 * carried to another computer by hand was the step that form existed to create.
 * `webcheck.machine-limit-and-probe.ts` still pins that **no settings screen may
 * `POST /v1/machines` under any spelling**, and that pin stays true: the caller
 * now is `store.ts`'s provisioning step, on a computer that is about to run the
 * daemon itself, where there is nothing to carry anywhere.
 *
 * ⚠ **Every call spends one of fifty, permanently.** `machine_owners` is counted
 * with no revoked filter, so retiring a machine does not give the slot back. A
 * caller must know it has not already claimed one — `DaemonState.claimed` is that
 * record — and should ask `mayAddMachine(me)` first rather than discovering the
 * ceiling as a `409 machine_limit`.
 *
 * The answer carries all three halves because the server resolves the third:
 * `controlPlaneUrl` is the address **the daemon will dial**, taken from the
 * request rather than from this page's origin — which in dev is Vite's port, and
 * in the native shell is a custom scheme naming no server at all.
 */
export function createMachine(name: string): Promise<CreatedMachine> {
  return cpFetch<CreatedMachine>("/v1/machines", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/**
 * Retire a machine you own. Three writes in one transaction on the server, and
 * two of them are worth reporting to whoever pressed the button.
 *
 * `enrollmentCodesInvalidated` is a live code that has just stopped working — a
 * code mints a full machine identity *and* rotates the tunnel key, so "there was
 * one outstanding" is something an operator should read. Both counters are
 * optional so an older control plane degrades to silence rather than to
 * `undefined` being drawn as a number.
 */
export function revokeMachine(id: string): Promise<{
  revoked: boolean;
  enrollmentCodesInvalidated?: number;
  outstandingTokensExpireWithinSeconds?: number;
}> {
  return cpFetch(`/v1/machines/${encodeURIComponent(id)}/revoke`, { method: "POST" });
}

/**
 * Mint a token for one machine.
 *
 * One token addresses exactly one machine — that is the audience binding the
 * daemon and the relay both enforce — so reaching N machines means N tokens, held
 * separately, and there is no such thing as a fleet-wide token to be tempted by.
 *
 * The response also carries `relayUrl` and `relayOnline`, which is the
 * registry telling the client where the machine is. That is why route discovery
 * lives on this call rather than in a separate one that could get out of step
 * with it.
 */
export function mintToken(machine: string): Promise<IssuedToken> {
  return cpFetch<IssuedToken>("/v1/tokens", {
    method: "POST",
    body: JSON.stringify({ machine }),
  });
}

/* ------------------------------------------------------------------ *
 * Admin
 *
 * Every one of these answers `403 forbidden` to a non-admin, and that is the
 * guard. `settings.ts` only decides whether the screen is offered.
 * ------------------------------------------------------------------ */

/**
 * `AdminUser` plus the machine numbers the fleet list gained.
 *
 * Widened here rather than in `wire.ts` for the same reason `ApiKeyRecord` is
 * declared here: it is a control-plane shape and the daemon's wire has no
 * opinion about it. Optional, like every other field this list has grown, so an
 * older control plane reads as "not reported" rather than as zero — the
 * difference between "nobody owns a machine" and "nobody asked".
 *
 * **No `keys` field.** A count of live API keys was declared here from Q1.611
 * to 2026-09-06 and is gone with the admin's view of anybody's keys (Q1.631):
 * a control plane older than that still sends `keys` on every row, and this
 * client neither declares it nor reads it, so the number reaches no screen.
 * Not declared as deprecated-optional either — a field the type carries is a
 * field somebody will draw, and the instruction was that an admin sees nothing
 * about a person's keys, not even how many.
 */
export interface AdminUserRow extends AdminUser {
  /** Machines they own. Not machines they can reach — a grant carries no quota. */
  machines?: number;
  /** Their effective ceiling, already clamped to the fleet-wide one. */
  machineLimit?: number;
  /**
   * Whether that number is theirs or the instance default.
   *
   * The only thing a "use the default" control can key on, which is
   * `canResetField`'s rule: where there is no override there is nothing to
   * reset *to*.
   */
  machineLimitSource?: "default" | "override";
  /**
   * What clearing their override lands on — the instance default.
   *
   * Separate from `machineLimit`, which is already resolved and therefore says
   * nothing about what "use the default" costs somebody holding an override.
   * Optional like everything else here, so a control plane rolled back past it
   * reads as unknown rather than as zero.
   */
  machineLimitDefault?: number;
  /** How many of their machines are switched off right now. Zero when they are within it. */
  machinesOverLimit?: number;
}

/** What both machine-limit verbs answer with, so a caller renders one shape. */
export interface MachineLimitAnswer {
  userId: string;
  maxMachines: number;
  source: "default" | "user";
  instanceDefault: number;
  owned: number;
  /** What this change switched off, oldest first — so the last entry went first. */
  suspended: { id: string; label: string }[];
}

/**
 * Set or clear one person's machine limit.
 *
 * **Two functions and never `maxMachines: null` meaning clear.** `0` and "no
 * override" are one keystroke apart and mean opposite things — no machines at
 * all, versus whatever the instance default says — so the difference is a verb
 * rather than a value. The same rule `adminSaveSettings` states for a setting,
 * with more at stake.
 */
export function adminSetMachineLimit(userId: string, maxMachines: number): Promise<MachineLimitAnswer> {
  return cpFetch<MachineLimitAnswer>(`/v1/admin/users/${encodeURIComponent(userId)}/machine-limit`, {
    method: "PUT",
    body: JSON.stringify({ maxMachines }),
  });
}

/**
 * Whether the fleet has a provisioning key.
 *
 * **A boolean, and that is the whole projection.** Nothing draws this key or any
 * part of it — not the value, not a prefix, not an id — so anything richer would
 * exist only to be a second place it can leak from. There is at most one, and the
 * only act is minting another.
 */
export async function adminHasProvisioningKey(): Promise<boolean> {
  const body = await cpFetch<{ minted: boolean }>("/v1/admin/provisioning-key");
  return body.minted;
}

/**
 * Mint one, retiring the previous in the same act.
 *
 * **The only response in this client that carries a `pk_`.** The screen shows it
 * once through `OneTimeSecret` and nothing stores it — the control plane keeps a
 * hash, so a lost key is reminted rather than recovered, which is the same
 * contract as the one-time password an admin-created account gets.
 */
export function adminMintProvisioningKey(): Promise<{ key: string }> {
  return cpFetch("/v1/admin/provisioning-key", { method: "POST" });
}

export function adminClearMachineLimit(userId: string): Promise<MachineLimitAnswer> {
  return cpFetch<MachineLimitAnswer>(`/v1/admin/users/${encodeURIComponent(userId)}/machine-limit`, {
    method: "DELETE",
  });
}

export async function adminUsers(): Promise<AdminUserRow[]> {
  const body = await cpFetch<{ users: AdminUserRow[] }>("/v1/admin/users");
  return body.users;
}

/**
 * Create a person, optionally by inviting them.
 *
 * **Widened rather than twinned.** One route decides between the two shapes from
 * the presence of the address, so a second function would be a second place the
 * mode matrix lives — and the answer already discriminates itself on `invited`.
 * With an address nothing secret is ever generated; without one the response
 * carries a temporary password the admin has to hand over.
 */
export function adminCreateUser(name: string, isAdmin: boolean, email?: string): Promise<CreatedUser> {
  return cpFetch<CreatedUser>("/v1/admin/users", {
    method: "POST",
    // `undefined` is dropped by `JSON.stringify`, so an absent address is an
    // absent field rather than an empty one — which the route reads as "do not
    // invite" rather than as a malformed address.
    body: JSON.stringify({ name, isAdmin, email: email !== undefined && email.trim().length > 0 ? email.trim() : undefined }),
  });
}

/*
 * ⚠ Four admin functions used to live here and are deleted, in two acts.
 *
 * `adminResetPassword` and `adminMintKey` went first, with the two routes
 * behind them (Q7.74). **An admin can take a credential away and can never
 * issue one.** What replaces the reset is the person doing it themselves:
 * `requestPasswordReset` above, and `mintMyKey` for a key.
 *
 * `adminUserKeys` and `adminRevokeKey` went on 2026-09-06 (Q1.631), with `GET
 * /v1/admin/users/:id/keys` and `DELETE /v1/admin/users/:id/keys/:keyId` behind
 * them and the "API keys" item in the Users row's kebab in front of them. The
 * revoke had survived an earlier instruction to remove it on the argument that
 * it was the only writer of `revoked_at` for a key you do not hold (Q3.217);
 * that expired once `revokeMyKey` and `DELETE /v1/me/keys/:keyId` were the
 * holder's own writer, and the owner's model is that a key is between the
 * person and their machine. **An admin can neither see nor do anything with
 * anybody's API keys**; the whole of their reach is the account — `adminSetDisabled`
 * and `adminDeleteUser` below.
 *
 * Leaving any of the four as callerless exports would recreate exactly the
 * `myKeys` / `revokeMyKey` situation the first deletion existed to fix — a
 * function nothing calls, describing a capability the product no longer has.
 * `webcheck` asserts neither of the newer two is exported, and the names stay
 * in this comment because `docscheck` requires every symbol `docs/DECISIONS.md`
 * cites to grep to source.
 */

/**
 * Ban somebody, or let them back in.
 *
 * **Typed rather than `unknown`, because disabling now burns something `enable`
 * does not give back.** The route invalidates every unredeemed enrollment code
 * the account minted — the one credential a ban does not otherwise reach, since
 * `/v1/enroll` sits above the control plane's auth gate and never asks who minted
 * a code — and reports how many. Discarded here, an admin banning somebody from
 * the browser was told nothing about it, while `cpctl admin disable` prints it and
 * `revokeMachine` two functions up already surfaces the identical counter. A
 * number that only the terminal client can see is a number the web UI is lying by
 * omission about.
 *
 * Every field is optional: `enable` answers `{disabled: false}` alone, and an
 * older control plane sent no counter at all.
 */
export interface DisabledAnswer {
  disabled: boolean;
  sessionsRevoked?: number;
  enrollmentCodesInvalidated?: number;
  outstandingTokensExpireWithinSeconds?: number;
}

export function adminSetDisabled(userId: string, disabled: boolean): Promise<DisabledAnswer> {
  return cpFetch<DisabledAnswer>(
    `/v1/admin/users/${encodeURIComponent(userId)}/${disabled ? "disable" : "enable"}`,
    { method: "POST" },
  );
}

export interface InviteAnswer {
  email: string;
  mailQueued: boolean;
  expiresAt: number;
}

/**
 * Send somebody's invitation again.
 *
 * **The remedy for the one state this product can otherwise not get out of.** An
 * invited account holds no password and an *unverified* address — clicking the
 * link is what verifies it — so `POST /v1/forgot` will not mail it, because that
 * route looks addresses up among verified owners only. If the invitation never
 * arrives or is not opened inside 48 hours, the account can neither sign in nor
 * recover, creating it again answers `409 user_exists`, and the admin reset and
 * key-mint routes that used to be the way out are deleted. Every door shut at
 * once, on an account that looks perfectly ordinary in the list.
 *
 * It hands the caller nothing — no token, no password — so it does not reopen
 * what deleting those routes closed. The link goes to the address on the account
 * and nowhere else, which is what the original invitation already did.
 */
export function adminInviteUser(userId: string): Promise<InviteAnswer> {
  return cpFetch<InviteAnswer>(`/v1/admin/users/${encodeURIComponent(userId)}/invite`, { method: "POST" });
}

/**
 * Remove a person and every credential that authenticates as them.
 *
 * `machinesRevoked` is the one lasting effect outside their own rows: machines
 * they registered are taken off the network, and the caller says so rather than
 * leaving somebody to find out when a daemon stops answering.
 *
 * **Renamed from `machinesReleased`, and the old name would now be a lie.** They
 * used to stay registered and become ownerless — which turned out to put them
 * outside the machine limit and outside the ban check, both being facts about
 * the owner, so deleting a person was the one act that manufactured a live
 * machine no rule applied to. The row survives for the audit trail; it is
 * revoked.
 */
export function adminDeleteUser(userId: string): Promise<{
  name: string;
  machinesRevoked: number;
  /**
   * Enrollment codes they had minted and not spent.
   *
   * The other side effect outside their own rows, and the one with teeth: a live
   * code is redeemed at `/v1/enroll`, which sits above the credential gate and
   * asks only whether the code is unused — so it would still hand out a machine
   * identity and rotate the legitimate daemon's tunnel key, minutes after the
   * account was deleted. Optional, for an older control plane that did not sweep
   * them.
   */
  enrollmentCodesInvalidated?: number;
}> {
  return cpFetch(`/v1/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

/* ------------------------------------------------------------------ *
 * Server settings
 * ------------------------------------------------------------------ */

/**
 * Whether mail is *arriving*, which is a different question from whether it is
 * configured.
 *
 * Optional on the wire, so a control plane rolled back past it reads as "no
 * delivery information" rather than as "nothing has failed" — the difference
 * matters, because the whole point of this object is to raise a suspicion nobody
 * currently has any way to form.
 */
export interface MailDelivery {
  pending: number;
  failed: number;
  oldestPendingMs: number | null;
  lastError: string | null;
  lastFailedAt: number | null;
  /** The breaker is open: five consecutive failures, dialling stopped for 5 min. */
  paused: boolean;
}

export interface SettingsAnswer {
  settings: ConfigField[];
  mail: { configured: boolean; problems: string[]; delivery?: MailDelivery };
  registration: { enabled: boolean; requiresEmail: boolean };
}

export function adminSettings(): Promise<SettingsAnswer> {
  return cpFetch<SettingsAnswer>("/v1/admin/settings");
}

/**
 * Write settings, or drop an override.
 *
 * **Two verbs rather than `null` meaning delete**, which is the server's shape
 * and is repeated here rather than smoothed over: `null` and `""` are one
 * keystroke apart in a JSON body and exactly one of them is destructive — and an
 * empty string is a real value here (`smtp.username = ""` means "this server
 * wants no username").
 *
 * Every value is a string, including `"587"`. The column is TEXT, so a number
 * would come back as a string and the route would not round-trip its own
 * request.
 */
export function adminSaveSettings(input: {
  set?: Record<string, string>;
  clear?: string[];
}): Promise<SettingsAnswer> {
  return cpFetch<SettingsAnswer>("/v1/admin/settings", { method: "PUT", body: JSON.stringify(input) });
}

/**
 * Queue a test message.
 *
 * `202`, not a delivery report: the server refuses to hold a socket open for up
 * to ninety seconds against an admin-supplied host on the process that carries
 * every relay tunnel. Where it ended up is `cpctl admin mail`; this client has
 * no delivery log — the screen that held one was removed as noise, and the two
 * functions that fed it went with it rather than staying as exports nothing
 * calls.
 */
export function adminTestMail(to?: string): Promise<{ id: string; to: string }> {
  return cpFetch<{ id: string; to: string }>("/v1/admin/settings/test", {
    method: "POST",
    body: JSON.stringify(to === undefined ? {} : { to }),
  });
}
