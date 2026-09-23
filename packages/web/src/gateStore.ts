import { signedOutText, type AuthFailure } from "./account";
import * as cp from "./cp";
import type { InstanceConfig } from "./instance";
import type { SignInAuth } from "./signInAuth";
import type { Me, SessionToken } from "./wire";

/**
 * The gate's state, and the whole of it.
 *
 * ⚠ **A second store rather than a narrower view of `store.ts`, and the reason is
 * bytes on a phone.** `store.ts` is the app's: it holds a fleet, so it
 * value-imports `machine.ts`, which value-imports `e2ee.ts`, which imports
 * `@reemoat/protocol`. That chain was in `dist-gate` because `gate-main.tsx`
 * imported `store.ts` for six calls and four fields — **70.5 kB of a 335 kB entry
 * chunk**, attributed off the emitted sourcemap as @noble/{curves,ciphers,hashes}
 * 43,208 B, `packages/protocol/src` 6,200 B, `e2ee.ts` 9,571 B and `machine.ts`
 * 11,573 B. A browser holds no device key and this bundle has no session view to
 * open a channel *for*, so those bytes were an implementation of `Noise_IK` that
 * every one of these nine addresses downloaded and none of them could ever
 * execute — to four screens a mail client opens, typically on mobile data.
 *
 * Nothing here is a *policy* about what the gate may reach. It is a store that
 * holds what these five screens read, which happens to be four fields; the
 * transport is absent because nothing in this bundle has anything to say to a
 * daemon, not because a rule forbids it.
 *
 * ## The singleton is exported as `store`, and that is deliberate
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * It makes every call site in the gate byte-identical to what it was — the whole
 * diff in the three screens is one import specifier — so *"no gate screen's
 * behaviour changed"* is something a reader can see rather than something this
 * docblock asserts.
 *
 * And `webcheck.gate-and-server-settings.ts` pins `/store\.refreshConfig\(/`
 * against a comment-stripped `Gate.tsx`, to hold the one thing that can end
 * `/register`'s spinner on a tab that never asks again. A `gateStore.` prefix
 * does not match that regex, so renaming the singleton would turn that driver red
 * about a property this change does not touch.
 *
 * ## What this deliberately does not have
 *
 * No machines, no sessions, no transcripts, no poll, no wake path and no
 * `cpError`. `gate-main.tsx` already argued that this surface must not mint
 * tokens or open sockets for somebody who is on it precisely because they do not
 * have the app yet — and that argument used to be a *restraint*, one call this
 * entry point declined to make into a store that could still make it. Signing in
 * on `/verify`, or finishing a registration on an instance with no mail, reached
 * `AppStore.bootstrap` one hop later and did every one of those things anyway.
 * Here there is nothing to decline: the fleet machinery is not linked in.
 */
export interface GateState {
  /**
   * `"loading"` means *there is a credential and nobody has confirmed whose*.
   *
   * It draws no spinner on this surface: `Gate` reads this field twice — once to
   * offer the sign-in form on a link that needs a session, once to intercept a
   * screen a signed-in person should not be looking at — and every other screen
   * renders the same whichever of the three it holds. That is why the failure
   * arm of {@link GateStore.settle} can simply stop: an unreachable control plane
   * leaves a registration form working rather than a page stuck on a wait.
   */
  phase: "signed_out" | "loading" | "ready";
  me: Me | null;
  /** What this instance allows, or `null` while it is unknown or unanswerable. */
  config: InstanceConfig | null;
  /** Why this tab was signed out without being asked, for the sign-in form to say. */
  authError: string | null;
}

class GateStore implements SignInAuth {
  private listeners = new Set<() => void>();
  private snapshot: GateState = {
    /*
     * ⚠ **`store.ts` writes `cp.currentCredential() === null && !nativeHydrating()`
     * here and this deliberately drops the conjunct.**
     *
     * That half exists because the native shell reads its credential out of the OS
     * keyring asynchronously, so "no answer yet" must not draw as "signed out" for
     * a frame — and it is released by `bootstrap` awaiting `hostReady`. This bundle
     * is served over HTTP by the control plane and is never what the shell loads:
     * `native:build` compiles `dist`, and `dist-gate` is copied into the control
     * plane's image. So there is no keyring read to wait for, and carrying the
     * latch without the `await` that releases it would be a `"loading"` nothing in
     * this program could ever end.
     */
    phase: cp.currentCredential() === null ? "signed_out" : "loading",
    me: null,
    config: null,
    authError: null,
  };

  /* ---------------------------------------------------------------- *
   * React glue
   * ---------------------------------------------------------------- */

  // Arrow properties, because `useSyncExternalStore` takes them unbound.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): GateState => this.snapshot;

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private patch(fields: Partial<GateState>): void {
    this.snapshot = { ...this.snapshot, ...fields };
    this.emit();
  }

  /* ---------------------------------------------------------------- *
   * Reads
   * ---------------------------------------------------------------- */

  /**
   * What this instance allows, for the screens that have no credential yet.
   *
   * **The catch is bare and that is load-bearing**, verbatim from `loadConfig`'s
   * reason in `store.ts`: a control plane rolled back past the release that added
   * `/v1/instance` answers 404, which `readJson` turns into an `ApiError`. That is
   * not an outage — drawing an alarming banner for it would be wrong on a working
   * sign-up form. `config` stays `null`, which every predicate that reads it has
   * an answer for.
   *
   * ⚠ **There is no private `loadConfig` behind this, and there should not be.**
   * In `store.ts` the split exists because the private half is `bootstrap`'s first
   * statement and that placement is asserted behaviourally, so a second door was
   * cheaper than a second thing to keep true of the first. There is no bootstrap
   * here for it to be the first statement of, and every caller on this surface is a
   * screen re-asking for itself — so a private half would be a door with nothing
   * behind it.
   *
   * It does not dedupe, deliberately, which is the cost `LegalRoute` and `Handoff`
   * name at their own effects: a screen cannot see a request in flight, so the
   * ordinary visit pays one extra `GET /v1/instance` rather than risk a screen that
   * waits for a read it cannot observe.
   */
  async refreshConfig(): Promise<void> {
    try {
      this.patch({ config: await cp.instanceConfig() });
    } catch {
      // See above. An older control plane is not a failure to report.
    }
  }

  /**
   * Re-read `/v1/me`, and nothing else.
   *
   * Called by `/verify` once the address is confirmed, so the signed-in card
   * behind it stops describing an account with an unverified address.
   *
   * A transport failure is swallowed: `me` is already held and stale-by-one-field
   * beats blanking the card. A failure that means the credential is finished has
   * already signed this tab out inside `cpFetch`, so there is nothing left here to
   * decide.
   */
  async refreshMe(): Promise<void> {
    try {
      this.patch({ me: await cp.me() });
    } catch {
      // See above. Every outcome worth acting on has been acted on before this.
    }
  }

  /* ---------------------------------------------------------------- *
   * Becoming signed in
   * ---------------------------------------------------------------- */

  /**
   * Sign in. Rejects rather than reporting — `SignIn` shows its own error, beside
   * the field it is about.
   *
   * Reached through {@link SignInAuth}, which is how one sign-in screen is drawn
   * by two bundles without naming either store — see `signInAuth.ts` for why that
   * is a registry rather than a prop.
   */
  async login(name: string, password: string): Promise<void> {
    const me = await cp.login(name, password);
    this.patch({ me, authError: null });
    await this.settle();
  }

  /**
   * Adopt a session the server minted on a gate screen — a confirmation, a reset,
   * or a registration on an instance with no mail.
   *
   * ⚠ **`AppStore.adoptSession` dropped every live connection before adopting the
   * credential, and this deliberately does not** — because there is nothing here
   * that has ever opened one. That was the *whole* of the deleted method's body
   * beyond these three lines, and its warning stayed behind in `store.ts` with
   * `login`, which is what the warning was actually about.
   *
   * What it does keep is the patch order. `me` is written from the answer rather
   * than waited for, so the card that replaces this form already knows the name;
   * `Gate`'s signed-in interception needs `phase: "ready"` as well, which
   * {@link GateStore.settle} reaches one round trip later. That is why `Register`'s
   * no-mail arm cannot say "account created" on its way out — by the time this
   * resolves, `Gate` has replaced the form it would have said it on.
   */
  async adoptSession(token: SessionToken): Promise<void> {
    cp.setSession(token.token);
    this.patch({ me: token.user, authError: null });
    await this.settle();
  }

  /**
   * Confirm who the new credential belongs to, and register this browser.
   *
   * ⚠ **The bare catch covers two outcomes that want the same thing.** A failure
   * that means the credential is finished has already run through `cpFetch` into
   * {@link GateStore.handleSignedOut}, which set `phase: "signed_out"` — so
   * re-deciding it here could only overwrite a better answer. A control plane that
   * is merely unreachable leaves `phase` at `"loading"`, which on this surface is
   * a working screen minus the signed-in interception; that is what `bootstrap`
   * does with the same failure and no machines to fall back on.
   *
   * `ensureDevice` runs **after** the try, exactly where `bootstrap` puts it: it
   * is bookkeeping, and a refusal — a full device cap, a network blip — must not
   * be able to decide what `phase` this page is in.
   */
  private async settle(): Promise<void> {
    this.patch({ phase: "loading" });
    try {
      this.patch({ me: await cp.me(), phase: "ready", authError: null });
    } catch {
      // See above. Both arms have already been answered elsewhere.
    }
    await this.ensureDevice();
  }

  /**
   * Register this browser with the control plane, once, if it has none.
   *
   * Silent on every failure, verbatim from `store.ts`: what a refusal costs is one
   * unregistered visit, where the sessions list describes this client through its
   * `User-Agent` rather than by name.
   *
   * `login` binds a device itself, in the request that signs in, so the caller
   * this actually exists for is {@link GateStore.adoptSession} — a confirmation or
   * a password reset, where the session arrives already minted.
   *
   * ⚠ **`password_change_required` is not a failure here and must not become
   * one**, which is the half of `store.ts`'s reasoning that a bare catch loses.
   * `POST /v1/me/devices` is registered *above* the control plane's second gate so an
   * admin-created account can reach it — but a control plane that has not been
   * updated answers 403, and this client has to keep working against one. So the
   * catch is total on purpose rather than by omission, and narrowing it to "real"
   * errors is the edit that breaks a fleet mid-upgrade.
   *
   * ⚠ **Two copies, and nothing compares them.** This method,
   * {@link GateStore.handleSignedOut}, {@link GateStore.refreshMe} and
   * {@link GateStore.signOut} all exist in `store.ts` too. They are two because
   * the two stores are never in one bundle — see `signInAuth.ts` — and the cost is
   * that a rule fixed in one is not fixed in the other. This paragraph is here
   * because it was already lost once: it lived only in `store.ts` after the split.
   */
  private async ensureDevice(): Promise<void> {
    if (cp.currentDevice() !== null) return;
    try {
      await cp.registerDevice();
    } catch {
      // Bookkeeping. A device is how somebody *recognises* this client in a list;
      // nothing on this surface depends on having one.
    }
  }

  /* ---------------------------------------------------------------- *
   * Stopping being signed in
   * ---------------------------------------------------------------- */

  /**
   * The app signed you out without being asked. Registered on `cp.onSignedOut`.
   *
   * ⚠ **`device_revoked` gives the stored id up and nothing else does**, which is
   * `store.ts`'s rule and has to be kept in both copies: that failure means the
   * *installation* was retired, so a kept id would be offered at the next sign-in,
   * the server would hand back a fresh device by its adopt-or-register rule, and
   * this client would quietly register a new one every visit while presenting an
   * id nothing will ever adopt. Every other failure leaves it alone — signing out
   * is not a statement about the computer, and `session_revoked`, which is what
   * the per-user session cap produces, leaves the device perfectly valid.
   */
  handleSignedOut(failure: AuthFailure): void {
    if (failure === "device_revoked") cp.forgetDevice();
    this.patch({ phase: "signed_out", me: null, authError: signedOutText(failure) });
  }

  /**
   * Sign out, server-side first, then reload.
   *
   * The order is the whole of it: `DELETE /v1/me/sessions/current` has to land
   * before the navigation, or the session stays valid on the control plane for its
   * whole lifetime and the only thing that changed is that this tab forgot it. Its
   * failure is swallowed inside `cp.logout`, so a control plane that is down cannot
   * trap somebody in an app they are trying to leave.
   *
   * ⚠ **`/` on this origin is the control plane's JSON 404**, and that is a
   * pre-existing wrong that is deliberately carried over unchanged rather than
   * repaired inside a bundling change — `Gate`'s own signed-in card records the
   * same fact about the same address. The reload is what makes the sign-out
   * complete; where it lands is a separate defect with a separate fix.
   */
  async signOut(): Promise<void> {
    await cp.logout();
    window.location.href = "/";
  }

  /**
   * Structurally unreachable here, and a body rather than a throw.
   *
   * `SignIn` draws the control that calls this only on a window the shell says
   * nobody has signed in to (`signInExits`), and there is no shell in a browser for
   * ever — this bundle is served over HTTP, so the server
   * *is* the origin that served the page and there is nothing to choose. It is the
   * same dead arm `AppState.host` and `AppState.pickingServer` already document in
   * the app's store, seen from the other side.
   *
   * Empty rather than absent because {@link SignInAuth} is what lets one screen be
   * drawn by two bundles, and empty rather than `throw` because a dead arm that
   * throws is a crash waiting for the day somebody makes it reachable — where
   * doing nothing is what the screen already does when the control is not drawn.
   */
  pickServer(): void {}

  /**
   * Structurally unreachable here, for {@link GateStore.pickServer}'s reason.
   *
   * `SignIn` draws Cancel only where the shell's live list of accounts names one
   * to go back to, and a browser has no shell and so no list: `nativeAccounts()`
   * answers `null` there before anything is drawn. Resolving rather than
   * rejecting, because a rejection is drawn as a sentence and there is nothing
   * true to say about a control that is not on screen.
   */
  async switchBack(): Promise<void> {}

  /**
   * Structurally unreachable here, for the same reason: Remove account is drawn
   * only on a window the shell says is an account, and in a browser there is no
   * such window.
   */
  async forgetAccount(): Promise<void> {}
}

/**
 * ⚠ **Constructed here and wired in `gate-main.tsx`, which is not where
 * `store.ts` does it and is not a style difference.**
 *
 * `cp.onSignedOut` holds exactly one handler and `provideSignInAuth` exactly one
 * store — last writer wins for both. A module body's position in the evaluation
 * order is decided by the import graph, which is not something this file can see
 * or control: any other module in the bundle that registers, for any reason, wins
 * or loses purely on where it happens to sit in that graph. The entry point's
 * body is the one place in a program guaranteed to run after every module it
 * pulls in, so that is where this bundle says which store it is.
 *
 * `store.ts` registers from its own tail and can afford to: `dist` has one store,
 * and nothing in it has ever had an opinion about which.
 */
export const store = new GateStore();
