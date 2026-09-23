import { ChevronLeft, Pencil } from "lucide-react";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import * as cp from "../cp";
import { errorText } from "../http";
import { parseInstanceConfig } from "../instance";
import { nativeBoot, probeServer, setNativeServer } from "../native";
import { store } from "../store";
import { useBackAccount } from "./backAccount";
import { Button, FIELD, Icon, IconButton, SETTINGS_HEADING } from "./bits";

/**
 * Which Reemoat this application talks to.
 *
 * **Two entrances, and neither is a URL.** `state.host.server === null` is a
 * window nobody has given a server — first run, or an account being added from the
 * menu; `state.pickingServer` is ‹ Server on the sign-in screen, drawn only on a
 * window nobody has signed in to yet. Both are a *pending* window: an account is a
 * server and a person, so a signed-in one may not be repointed, and the row that
 * used to offer that under Settings → Account is gone (Q3.643). The screen still
 * exists for the reason the second entrance was added: `setNativeServer` had
 * exactly one call site, so **a server that had been chosen could not be changed
 * from inside the app at all**. ‹ Server now reaches it only while an account is
 * being added: a first sign-in has no way back (the owner's call, 2026-09-24).
 *
 * **Adding an account is this screen with a different heading**, not a screen of
 * its own. The host opens a fresh pending window for it, which arrives here exactly
 * as a first run does; what differs is that this computer already holds accounts,
 * so the screen says *Add account* and opens on a ‹ back to the one that was on
 * screen, named. Which of the two it is comes from the host's live list, never from
 * the boot payload — see `useBackAccount`.
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
   * ⚠ **The field opens on the current value, and the way back exists only where
   * there is an account to go back to.** The second rule is load-bearing beyond
   * politeness: with no other account on this computer there is nothing to go back
   * *to*, so the screen offers no way off — which is what keeps "a sign-in form is
   * never drawn without a server" true by construction, and is why `signInReady`
   * did not have to learn about servers. An add is the one arrival with somewhere
   * to go, and its ‹ goes there — to the interface, from either arrival.
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
   * ⚠ **No sentence here is about a sign-in the screen holds any more, because no
   * entrance reaches it holding one.** It used to be drawn from Settings with a
   * live session behind it, so a `signedIn` read decided whether "this computer
   * stays signed in" described something that existed. Both entrances are a
   * pending window now, and the host refuses a server change for anything else
   * (Q5.120) — so the read, and the sentence it guarded, went together. The
   * ordering in `submit` that protected a live bearer stays, as the belt for the
   * day an entrance with one comes back.
   */
  /*
   * ⚠ **Adding, which is decided by the host's live list and not by anything on
   * this screen.** A pending window on a computer that already holds an account is
   * an account being added; on one that holds none it is a first run. `back` is
   * the account Cancel returns to, so *there is somewhere to go back to* and *this
   * is an add* are one fact. `undefined` until the host answers — see the hold
   * below the handlers.
   */
  const back = useBackAccount();
  const adding = back !== null && back !== undefined;
  const [address, setAddress] = useState(current ?? suggested ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const durable = nativeBoot()?.durable !== false;
  /*
   * ⚠ **Locked only where the field opens on the build's own suggestion and there
   * is no truth to show instead** — the owner's call (Q3.643): the address a build
   * was made for is what most people are here to confirm, so it is drawn as settled,
   * with a pencil beside it for the few who run their own. Never on the ‹ Server
   * arrival, where the field holds the address this window already has and the
   * reason for coming back is to change it; never where the build compiled no
   * suggestion in, where there is nothing to confirm.
   *
   * **`disabled`, not `readOnly`, and both were weighed.** A disabled field reads
   * as not yours to edit until you ask, takes no caret and raises no keyboard on a
   * phone, and is announced as unavailable beside a pencil that is labelled. A
   * read-only one is focusable, draws a caret and reads as editable to everybody
   * who then finds it is not. What `disabled` costs is focus — and so Enter from
   * the field — which Continue taking the focus while it is locked repays.
   */
  const [locked, setLocked] = useState(!editing && suggested !== null);
  const field = useRef<HTMLInputElement>(null);

  /*
   * ⚠ **Byte for byte what it was, including the arguments inside it that are
   * about an entrance that no longer exists** — and that is on purpose, not
   * neglect. Its ⚠ blocks reason about a settings screen with a live session behind
   * it, which was the Settings → Account entrance; no entrance reaches this screen
   * holding a credential now (both are a pending window, and the host refuses a
   * server change for anything else, Q5.120), so `held` is `null` on every path
   * that runs today and the detach and re-adopt are no-ops. They stay — and stay
   * unedited, so the index pins on them keep meaning what they were written to
   * mean — as the belt for the day an entrance with a credential comes back: the
   * order they encode is still the only safe one if it does.
   */

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

  /*
   * The pencil: unlock, then focus and select, in that order and inside the tap.
   *
   * ⚠ **`flushSync`, because a disabled input cannot take focus.** Setting the
   * state alone commits it after this handler returns, so the `focus()` below would
   * land on a field that is still disabled and do nothing. Committing inside the tap
   * is also what lets a phone raise its keyboard: a focus that arrives in a later
   * task is not one the platform treats as the person's, which is `router.ts`'s
   * precedent for the same call. Selected, because somebody who pressed the pencil
   * is about to type a different address, not edit this one a character at a time.
   *
   * The pencil unmounts once pressed — one way, the redundant control deleted —
   * and the field, the `flex-1` sibling, takes the room it leaves.
   */
  const unlock = (): void => {
    flushSync(() => setLocked(false));
    field.current?.focus();
    field.current?.select();
  };

  /*
   * ‹ on an add: back to the account that was on screen. The host discards
   * this pending window by leaving it — closes it, or rebinds it and asks for a
   * reload — so there is nothing here to tidy. A refusal is a sentence under the
   * field rather than a silent no-op.
   */
  const leave = (): void => {
    setError(null);
    void store.switchAccount(null).catch((cause: unknown) => setError(errorText(cause)));
  };

  /*
   * ⚠ **Nothing drawn until the host has said whether this is an add.** The two
   * answers are two different screens — a welcome that explains what a server is,
   * against *Add account* with a Cancel — and drawing the first while the list is
   * one IPC away would flash a welcome at somebody who already has three accounts.
   * The box keeps its place, so the arrival is a paint rather than a jump, and the
   * field is mounted with the answer in hand, which is what lets `autoFocus` be the
   * right one on the first try.
   */
  if (back === undefined) return <div className="flex min-h-full items-center justify-center p-6" />;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/*
          ⚠ **Three arrivals, three headings, and the first one is a *welcome*
          rather than a question.** This is the screen somebody sees before
          anything else in the product, on a machine where nothing has happened yet
          — so it greets, says what is about to happen, and asks one thing. Adding
          an account is the opposite of a first run — somebody who is already in —
          so it names the act rather than greeting, and ‹ Server from the sign-in
          screen is a correction to an address, where a welcome would read as
          having forgotten what was just typed.
        */}
        {/*
          ⚠ **The way back is a chevron that names where it goes, and it goes to
          the interface** — the owner's call, 2026-09-24, replacing a Cancel beside
          Continue: `SignIn`'s ‹ Server is the shape, and on this screen, from the
          first arrival or back from the sign-in form, it returns to the account
          that was on screen. A first run has none.
        */}
        {adding && (
          <button
            type="button"
            onClick={leave}
            disabled={busy}
            className="tap -ml-1 mb-3 flex max-w-full items-center gap-0.5 text-sm text-muted hover:text-fg disabled:text-faint"
          >
            <Icon as={ChevronLeft} size={14} />
            <span className="truncate">{back.label}</span>
          </button>
        )}
        <h1 className="text-xl font-semibold">{adding ? "Add account" : "Welcome to Reemoat"}</h1>
        <p className="mt-1 text-sm text-muted">
          {adding
            ? "Choose the server the account is on."
            : "One thing to set up, and then you are in. Reemoat keeps your account and your machines on a server — this one, or your own."}
        </p>

        <form onSubmit={submit}>
          <label htmlFor="server-address" className={`mt-4 block ${SETTINGS_HEADING}`}>
            Server address
          </label>
          {/*
            The field and, while it is locked, the pencil that unlocks it. Chrome
            from `FIELD`, layout here — `SignIn`'s line, and the two screens are
            read one after the other.

            ⚠ **The locked look is two `disabled:` variants and no opacity.** With
            none, a disabled `FIELD` would draw exactly like an editable one:
            Tailwind's preflight already sets inputs to inherit their colour on a
            transparent ground at full opacity, and `FIELD` sets the ground and the
            boundary itself, so the engines' own disabled styling — WebKit's mixed
            ink, Chromium's grey — never shows. So the ink dims to `text-muted` and
            the boundary steps back to `edge`, which is the refusing-controls idiom
            this app uses everywhere a control says *not now* without compositing
            itself away; an opacity would take the value somebody is here to read
            down with it.

            `nav` for the pencil, not `sm`: beside a field at `gap-2`, `nav`'s
            finger pad lands inside the gap, where `sm`'s would lie over the field.
          */}
          <div className="mt-1 flex items-center gap-2">
            <input
              ref={field}
              id="server-address"
              name="url"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              disabled={locked}
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
              /* The field takes focus only where it can be typed in: a first run or
                 an add with no suggestion, where it is the one thing somebody is here
                 to fill. **Not while locked** — a disabled field cannot hold it, and
                 Continue takes it instead, below. **Not on the ‹ Server arrival**,
                 where most who come back are confirming the address above a phone's
                 keyboard they did not ask for. */
              autoFocus={!editing && !locked}
              className={`min-w-0 flex-1 ${FIELD} disabled:border-edge disabled:text-muted`}
            />
            {locked && (
              <IconButton icon={Pencil} label="Edit server address" size="nav" onClick={unlock} disabled={busy} />
            )}
          </div>

          {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}

          {/*
            ⚠ **What adding costs the accounts already here is not said on this
            screen any more** — the owner's call, 2026-09-24, on seeing it: two
            sentences between the field and the button, both about the absence of a
            cost (Q7.149 has it). And the way back is the ‹ above, not a Cancel here.

            ⚠ **Continue takes the focus while the field is locked**, which is the
            other half of the lock: a disabled input takes none, so without this
            the first screen's whole job — confirm the address, press Enter — would
            need a click.
          */}
          <div className="mt-4 flex gap-2">
            <Button
              type="submit"
              tone="primary"
              autoFocus={locked}
              disabled={busy || address.trim().length === 0}
              className="flex-1"
            >
              {busy ? "Checking…" : "Continue"}
            </Button>
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
            and not a footnote. On the first arrival only, of a first run or an
            add — somebody who came back through ‹ Server has already chosen once
            and is correcting an address, not asking what one is. And on an add
            too, deliberately: the account being added may well be on a server of
            its own, which is exactly what this line is for.
          */}
          {/*
            ⚠ **"That address is ours" is gone** — the owner's call, 2026-09-24:
            the lead already says a server is "this one, or your own", and a build
            with an address compiled in is one whose owner chose it. What is left is
            the one case that line cannot carry: a build with no address at all, on
            a first run, where somebody has to be told what a server is.
          */}
          {!editing && !adding && suggested === null && (
            <p>
              A server holds your account and the machines you add. Use one somebody runs for you, or run your own with{" "}
              <span className="font-mono">install.sh control-plane</span>.
            </p>
          )}
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
