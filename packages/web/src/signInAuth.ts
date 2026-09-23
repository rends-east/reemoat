/**
 * The acts the sign-in screen performs, named once so that screen can be drawn by
 * either bundle without naming either store.
 *
 * Four now: signing in, the one that was always here; ‹ Server; and the two ways
 * off a signed-out account's sign-in screen that the shell added when a computer
 * began to hold several accounts — back to the one shown before, and taking this
 * one off. The last three are live in the app and structurally dead in the gate,
 * for `pickServer`'s reason below.
 *
 * ## Why this module exists at all
 *
 * `ui/SignIn.tsx` is one of the handful of boxes both bundles draw — the
 * intersection of the two entry closures is `ErrorBoundary`, `SignIn`, `Toast`,
 * `bits`, `GateCard` and `legal/LegalScreen` — and it is the only one of them that
 * has to *act*. (CLAUDE.md's "`GateCard` is the one shared box" is about a gate
 * **screen**, which is a narrower claim than this list and not in tension with
 * it.) It is rendered **twice** in the app — the signed-out root at `App.tsx` and
 * Settings → Agents — and once in the gate, from `Gate`'s `/verify` branch: a
 * mailed link that needs a session, where signing in has to leave the URL alone so
 * the token in the fragment is still there when the form unmounts.
 * `ForcedPasswordChange` renders a `GateCard` rather than a `SignIn` and is not
 * one of them.
 *
 * Before this, that screen imported `store.ts` directly, and that single edge was
 * worth **70.5 kB of the gate's 335 kB entry chunk**: `store.ts` value-imports
 * `machine.ts`, which value-imports `e2ee.ts`, which imports `@reemoat/protocol`
 * — the Noise handshake, the cipher state and the frame codec. A browser holds no
 * device key and `dist-gate` has no session view to open a channel *for*, so
 * every one of those nine addresses — a registration form, four mailed-link
 * screens opened by a mail client on a phone, three legal documents and the
 * handoff page — carried an implementation of `Noise_IK` it was structurally
 * incapable of using. `vite.gate.config.ts` holds the measurement.
 *
 * ## Why a registry rather than a prop
 *
 * A prop is the shape this repository prefers and `SignIn`'s own `config`
 * docblock argues for it one field down. It was rejected here for one reason: it
 * spreads across four files — the screen plus its three call sites — and each of
 * those exists only to hand back the store the screen was already reaching for.
 * The thing actually being decided is **which bundle this is**, which no render
 * site knows anything about and none of them should have to repeat.
 *
 * So it is decided where it is actually known: in the store module's own body,
 * the way `cp.onSignedOut` already decides which store owns an involuntary
 * sign-out. That is not a coincidence — it is the same fact wearing a second
 * name, and it is safe for the same reason: **the two stores are never in one
 * bundle.** `store.ts` is reachable only from `main.tsx` and `gateStore.ts` only
 * from `gate-main.tsx`, so exactly one `provideSignInAuth` call is ever
 * evaluated in a program. Nothing here arbitrates between two providers, because
 * a program with two is a wiring mistake rather than a state to handle — and
 * `webcheck.gate-and-server-settings.ts`'s *"each bundle links exactly one store,
 * and never both"* is where that is asserted rather than assumed, over the value
 * import graph from each entry point. ⚠ It was assumed for as long as this file
 * existed before that check was written; nothing pins `SignIn.tsx` itself to the
 * shared pair, only the stores.
 */
export interface SignInAuth {
  /**
   * Sign in, and settle whatever the bundle's store settles afterwards.
   *
   * **Rejects rather than reporting** — `SignIn` draws its own error beside the
   * field it is about, which is why this returns nothing. The app's
   * implementation goes on to run the whole bootstrap; the gate's deliberately
   * does not, and that difference is the point of the seam.
   */
  login(name: string, password: string): Promise<void>;
  /**
   * Open the screen that says which control plane this installation talks to.
   *
   * Reached from a control `SignIn` draws only on a window nobody has signed in to
   * (`signInExits` in `slot.ts`), which exists only in the shell — so this is live
   * in the app and structurally dead in the gate, which is served over HTTP from
   * the one origin it could possibly talk to.
   */
  pickServer(): void;
  /**
   * Back to the account this computer showed before this one.
   *
   * Cancel on the sign-in screen, drawn only where the host's live list names one.
   * **Rejects with the host's sentence** rather than reporting, for `login`'s
   * reason: `SignIn` draws it beside the control that failed.
   */
  switchBack(): Promise<void>;
  /**
   * Take the account this window is off this computer.
   *
   * Remove account, on the sign-in screen of an account that is on the list and
   * signed out. Rejects, for the same reason.
   */
  forgetAccount(): Promise<void>;
}

let provided: SignInAuth | null = null;

/**
 * Called once, from the module body of whichever store this bundle links in.
 *
 * Last writer wins, exactly as `cp.onSignedOut` does, and for the same reason
 * there is no second writer to lose to: see the module docblock.
 */
export function provideSignInAuth(auth: SignInAuth): void {
  provided = auth;
}

/**
 * The store this bundle was built with.
 *
 * ⚠ **Throws rather than answering a no-op**, because the only way to reach it
 * with nothing provided is a bundle whose entry point pulls in `ui/SignIn.tsx`
 * and neither store — which is a build somebody has broken, not a state a person
 * can get into. A silent no-op there is a Sign in button that does nothing, on
 * the one screen where "nothing happened" is indistinguishable from "your
 * password is wrong".
 *
 * Read at call time and never at module scope: every reader is inside an event
 * handler, which runs long after every module body in the program.
 */
export function signInAuth(): SignInAuth {
  if (provided === null) throw new Error("no sign-in store in this bundle");
  return provided;
}
