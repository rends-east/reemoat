import { useState, type FormEvent, type ReactNode } from "react";
import * as cp from "../cp";
import { parseInstanceConfig } from "../instance";
import { nativeBoot, probeServer, setNativeServer } from "../native";
import { store } from "../store";
import { Button, FIELD, SETTINGS_HEADING } from "./bits";

/**
 * Which Reemoat this application talks to.
 *
 * **Two entrances, and neither is a URL.** `state.host.server === null` is first
 * run; `state.pickingServer` is the control on the sign-in screen and the row
 * under Settings → Account. The second one is new ground rather than polish:
 * `setNativeServer` had exactly one call site and `clearSession` deliberately
 * leaves the server alone, so **a server that had been chosen could not be
 * changed from inside the app at all** — signing out returned you to the same
 * one, and the only remedy was deleting the shell's config file by hand.
 *
 * **Reached by state, not by a URL**, which is why it is filed beside `SignIn.tsx`
 * rather than in `ui/gate/`. `ForcedPasswordChange` is the precedent and the
 * argument is the same one: a `GateScreen` member is a *route*, `parseGateScreen`
 * is shared with the router, and the web build would then parse and draw `/server`
 * — a screen that cannot do anything in a browser, where the server is the origin
 * this page was served by. As a phase it is unreachable there instead: `App.tsx`
 * branches on `state.host`, which is `null` in a browser and for ever.
 *
 * The other half of the payoff is that **no compile-enforced switch changes**.
 * `depthOf`, `sheetKind`, `sheetTitle`, `screenOf` and `upFrom` all switch over
 * `Route`; `isSheet`, `isOverlayPath` and `sheetUpLabel` are the three that take a
 * new arm in silence. A route would have been eight edits and a case table; a
 * phase is none.
 *
 * **Nothing here validates the address**, and that is deliberate. The host process
 * normalizes it — scheme filled in, host lowercased, a default port dropped, path
 * and query discarded — and answers either the one canonical spelling or a sentence
 * saying why it is not an address. One authority, because two normalizers is two
 * spellings of one origin, which is two credential keys, one of which a sign-out
 * would not reach.
 *
 * **And it probes before it adopts.** A typo that is a perfectly good URL would
 * otherwise strand somebody in an app with no server that answers and no way back
 * to this screen — the failure `GateCard` already refuses one screen over. So this
 * asks the candidate two public questions and only writes anything down if one of
 * them answered like a Reemoat.
 */

/** What a probe learned, in the only three shapes worth telling apart. */
type Found = { kind: "reemoat" } | { kind: "stranger" } | { kind: "unreachable"; why: string };

/**
 * Two questions, and the second one is why an older instance is still adoptable.
 *
 * `GET /v1/instance` is the useful one — it parses, so a body in a shape this
 * client cannot read is distinguishable from no body at all. But a control plane
 * rolled back past the release that added it answers **404**, and `cp.ts` records
 * that this is *not* an outage and must not be drawn as one. So a 404 falls through
 * to `GET /v1/jwks`, which every control plane that has ever existed serves
 * unauthenticated, and whose answer nothing else on the web serves by accident.
 *
 * Both are above the control plane's auth gate, so neither needs a credential —
 * which is the whole reason this screen can ask anything at all.
 */
async function probe(address: string): Promise<Found> {
  try {
    const instance = await probeServer(address, "/v1/instance");
    if (instance.ok) {
      return parseInstanceConfig(await instance.json().catch(() => null)) === null
        ? { kind: "stranger" }
        : { kind: "reemoat" };
    }
    const jwks = await probeServer(address, "/v1/jwks");
    if (!jwks.ok) return { kind: "stranger" };
    const keys = (await jwks.json().catch(() => null)) as { keys?: unknown } | null;
    return Array.isArray(keys?.keys) ? { kind: "reemoat" } : { kind: "stranger" };
  } catch (cause: unknown) {
    /*
     * A rejection here is the host saying the request was never answered — a
     * refused address, an unreachable host, or a normalization it would not accept.
     * Its message is already a sentence somebody can act on, which is why it is
     * shown rather than replaced.
     */
    return { kind: "unreachable", why: cause instanceof Error ? cause.message : "could not reach that address" };
  }
}

export function ChooseServer(): ReactNode {
  /*
   * ⚠ **The field opens on the current value, and Cancel exists only where there
   * is one.** Those two lines are what turn a first-run screen into an editing
   * one, and the second is load-bearing beyond politeness: with no server chosen
   * there is nothing to go back *to*, so the screen offers no way off — which is
   * what keeps "a sign-in form is never drawn without a server" true by
   * construction, and is why `signInReady` did not have to learn about servers.
   *
   * Read from `nativeBoot()` rather than taken as a prop, matching `durable`
   * below and for its reason: this screen exists only in the shell, and the shell
   * has answered by the time anything draws it.
   */
  const current = nativeBoot()?.server ?? null;
  const editing = current !== null;
  /*
   * ⚠ **The field opens on a suggestion on first run and on the truth when
   * editing, and those are two different values.** `defaultServer` is what this
   * build was compiled to suggest; `server` is what this installation is on.
   * Folding them into one — writing the default down at first launch — is what
   * the first draft did, and it skipped this screen entirely: the app picked
   * somebody's fleet and told them afterwards, on the sign-in screen, in a line
   * nobody asked for.
   */
  const suggested = nativeBoot()?.defaultServer ?? null;
  /*
   * ⚠ **Whether there is a sign-in to lose, which is not the same as whether
   * there is a server.** This screen is reached from Settings with a live session
   * *and* from the back control on the sign-in form with none — and in the second
   * state the sentence about forgetting this computer's sign-in describes
   * something that does not exist. Read at render from the module that owns it;
   * `cp.currentCredential()` is synchronous and is the same value `cpFetch`
   * compares by identity.
   */
  const signedIn = cp.currentCredential() !== null;
  /*
   * Whether this shell can run a daemon here at all, which is the one condition on
   * the third sentence below: on a phone there is nothing to keep running, and a
   * sentence about it would be a promise about nothing. `canHostDaemon` is the
   * declared capability, never a guess from `platform`.
   *
   * ⚠ `=== true`, the reverse of `canHostDaemonHere`'s `!== false`, for the
   * reverse reason: there silence would cost the local route, here it costs one
   * sentence, and a sentence is a claim that should be left out when unsure.
   */
  const hostsDaemon = nativeBoot()?.canHostDaemon === true;
  const [address, setAddress] = useState(current ?? suggested ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const durable = nativeBoot()?.durable !== false;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const typed = address.trim();
    if (busy || typed.length === 0) return;
    /*
     * ⚠ **Nothing moved, so nothing is given up — and this has to be decided
     * *before* the credential is cleared, not after.**
     *
     * `host_set_server` returns early on an origin equal to the one it holds, so
     * the obvious place for this check is after it. That is wrong here, and it
     * was written that way first: by then the page has already let go of its
     * credential, and when that was `clearSession()` saving the address you are
     * already on signed you out. `detachSession()` keeps the stored copy now, so
     * the cost below the check is a reload rather than a sign-in — and a reload
     * over nothing is still the wrong answer to pressing Continue on no change.
     *
     * **Exact equality against the canonical value, and deliberately nothing
     * cleverer.** `current` came from the host already normalized, and the field
     * is seeded with it, so the no-op this exists for is a literal match. A looser
     * comparison would be a second normalizer on the page — which is the one thing
     * `native-shell.md` forbids, two spellings of one origin being two credential
     * keys. Getting it wrong in the safe direction (`app.example` against
     * `https://app.example`) costs the full path and one sign-in; there is no
     * unsafe direction, because two different strings cannot compare equal.
     */
    if (typed === current) {
      store.cancelServerPick();
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      const found = await probe(typed);
      if (found.kind === "unreachable") {
        setError(found.why);
        setBusy(false);
        return;
      }
      if (found.kind === "stranger") {
        setError("Something answered at that address, but it is not a Reemoat control plane.");
        setBusy(false);
        return;
      }
      /*
       * ⚠ **The credential goes before the host's origin moves, and this ordering
       * is the whole of why the editing entrance is safe.**
       *
       * `host_set_server` moves the base **in the host process**, so from the
       * instant it returns every `host_cp` call goes to the *new* origin — while
       * this page still holds the old fleet's bearer in memory. The four-second
       * poll, `refreshConfig`, or any `cpFetch` already in flight would then hand
       * server A's session token to a host somebody has just typed in. While this
       * screen was only ever drawn at `server === null` there was no credential
       * and no window; as a settings screen there is both.
       *
       * `detachSession()` is local, instant and cannot fail, and it drops this
       * page's copy only: `credential#<old origin>` stays in the keyring, so the
       * server being left is still signed in when somebody switches back
       * (Q7.148). What the other order costs is a credential disclosure to a host
       * nobody has verified. Priced, and stated here because the safe-looking
       * order is the wrong one.
       *
       * ⚠ **A refusal hands the copy back.** Every way `host_set_server` fails —
       * an address it will not normalize, a `server.json` it could not write —
       * returns before it moves the base, so the page is still pointed at the
       * server this bearer belongs to. Without this a full disk left the page
       * with no credential and no sign-out: every `cpFetch` refusing locally,
       * machines drifting to no token, and only a quit to recover. Re-adopted
       * through the hydration door, because what it restores is exactly what the
       * keyring still holds for this origin.
       */
      const held = cp.currentCredential();
      if (held !== null) cp.detachSession();
      try {
        await setNativeServer(typed);
      } catch (cause: unknown) {
        if (held !== null) cp.adoptHydratedCredential(held.value);
        setError(cause instanceof Error ? cause.message : "could not save that address");
        setBusy(false);
        return;
      }
      /*
       * **The reload is unconditional from here**, including where the host
       * answers the origin it already held. That happens only when somebody typed
       * a different *spelling* of the server they are on — the exact-equality exit
       * at the top caught the literal case — and by this line the page holds no
       * credential. Cancelling would put them back on a screen behind a session
       * this page has let go of; reloading reads the stored one back for the
       * server they are in fact still pointed at, which is what the rest of this
       * function already produces for any server that was signed in before.
       */
      /*
       * ⚠ **A reload rather than an in-memory unwind**, and `signOut` takes the same
       * path for the same reason: every machine connection, every minted token, every
       * route memo and every open socket in this process was derived from a credential
       * for a *different fleet*. Rebuilding that by hand is a teardown nobody can
       * prove complete; starting again is one that cannot be incomplete.
       *
       * `/` rather than `reload()`, because a path from the previous server names
       * nothing on this one.
       */
      window.location.assign("/");
    })();
  };

  // Chrome from `FIELD`, layout here — `SignIn`'s line, and the two screens are
  // read one after the other.
  const field = `mt-1 w-full ${FIELD}`;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/*
          ⚠ **Two arrivals, two headings, and the first one is a *welcome* rather
          than a question.** This is the screen somebody sees before anything else
          in the product, on a machine where nothing has happened yet — so it
          greets, says what is about to happen, and asks one thing. Reached from
          Settings it is the opposite: a change to something that already works,
          where a welcome would read as having forgotten who you are.
        */}
        <h1 className="text-xl font-semibold">{editing ? "Server" : "Welcome to Reemoat"}</h1>
        <p className="mt-1 text-sm text-muted">
          {editing
            ? "Change which server this connects to."
            : "One thing to set up, and then you are in. Reemoat keeps your account and your machines on a server — this one, or your own."}
        </p>

        <form onSubmit={submit}>
          <label htmlFor="server-address" className={`mt-4 block ${SETTINGS_HEADING}`}>
            Server address
          </label>
          <input
            id="server-address"
            name="url"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            /* `url` rather than `off`: a password manager offering the address you
               typed last time is the right behaviour on a screen somebody reaches
               once per machine. */
            autoComplete="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            inputMode="url"
            placeholder="app.reemoat.com"
            /* The first screen of the product is one field; focusing it is the
               whole of what somebody is here to do. **Not when editing**: that
               arrival replaces a sheet that has already placed focus, and taking
               it is the defect `Sheet`'s own `[screen]` effect exists to avoid. */
            autoFocus={!editing}
            className={field}
          />

          {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}

          {/*
            ⚠ **What changing servers costs, said before rather than discovered
            after — and the first sentence used to be a cost.** `host_set_server`
            erased `credential#<previous>` in the same act, so pointing somewhere
            else was signing out of here. It keeps it now (Q7.148): `submit` drops
            this page's copy and nothing else, and switching back asks nothing.

            It stays exactly true for the reason the old second sentence was:
            **nothing here ends the session on the old server.** No `DELETE
            /v1/me/sessions/current` is sent, and deliberately not — it is a
            network call to a server somebody is leaving, which is often the
            reason they are leaving, and it must not stand in front of a server
            change. Leaving it for good is signing out while on it.

            ⚠ **The third is what a switch does *not* cost, which it used to.**
            Each server has a daemon of its own on this computer now (Q7.148), and
            `host_set_server` touches none of them: the one for the server being
            left goes on running — its turns, its pending approvals, a phone's way
            in — until Reemoat quits. Conditional on purpose, because whether this
            copy started one for that server is not something this screen knows.
          */}
          {/*
            ⚠ **"Stays signed in" is said only where it is true.** On a computer
            whose credential store does not keep what it is given (`durable`
            false), switching back *does* ask again, and the sentence under the
            buttons already says so; drawing both would be two answers to one
            question with only one of them right.
          */}
          {editing && signedIn && (durable || hostsDaemon) && (
            <p className="mt-3 text-sm text-muted">
              {durable && (
                <>
                  This computer stays signed in to{" "}
                  <span className="font-mono text-fg">{current}</span>, so switching back does not
                  ask again.
                </>
              )}
              {hostsDaemon &&
                " If Reemoat runs a daemon on this computer for that server, it keeps running until you quit Reemoat."}
            </p>
          )}

          {/*
            Cancel last, which is the ordering rule `TwoStep` already argues on
            every settings row: both controls lay out in one box, so the last
            child occupies the same pixels whichever set is drawn, and a second
            tap aimed at a control that looked inert lands on the way out rather
            than on the act. `plain`, never `primary` — the affirmative here is
            adopting a server, and two primaries is no primary.
          */}
          <div className="mt-4 flex gap-2">
            <Button
              type="submit"
              tone="primary"
              disabled={busy || address.trim().length === 0}
              className="flex-1"
            >
              {busy ? "Checking…" : editing ? "Save" : "Continue"}
            </Button>
            {editing && (
              <Button type="button" onClick={() => store.cancelServerPick()} disabled={busy}>
                Cancel
              </Button>
            )}
          </div>
        </form>

        {/*
          What a server *is*, because this is the one screen where somebody may not
          know — and the honest answer names both possibilities rather than only the
          hosted one. `deploy/install.sh control-plane` is the whole of running your
          own; the author runs one for people who would rather not.
        */}
        <div className="mt-8 space-y-2 text-sm text-muted">
          {/*
            ⚠ **What a server is used to be said here and is now in the lead
            paragraph**, because on a welcome screen the explanation belongs above
            the field rather than below the button. What is left here is the one
            thing the lead cannot carry: that running your own is a real option
            and not a footnote. First run only — somebody who arrived from
            Settings has a working server and is not asking what one is.
          */}
          {!editing &&
            (suggested === null ? (
              <p>
                A server holds your account and the machines you add. Use one somebody runs for you, or run your own
                with <span className="font-mono">install.sh control-plane</span>.
              </p>
            ) : (
              <p>
                That address is ours. Run your own with <span className="font-mono">install.sh control-plane</span> and
                point this at it instead.
              </p>
            ))}
          {/*
            ⚠ **The same sentence `cp.ts` already has for a browser with storage
            disabled, because it is the same state.** There a private window has no
            durable storage; here a machine has no unlocked credential store — most
            often a Linux box with no keyring running. One state, one wording, from one
            decision: two spellings of one state is a defect this repository has
            shipped before and a driver now pins.
          */}
          {!durable && (
            <p className="text-fg">
              This computer has no credential store Reemoat can use, so it will ask you to sign in again after it
              restarts.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
