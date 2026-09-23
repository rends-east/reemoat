import { ChevronLeft } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { signInError, signInReady } from "../account";
import { gateNotice, showsGateLink } from "../gate";
import { errorText } from "../http";
import { controlPlaneOrigin, nativeBoot } from "../native";
import { signInAuth } from "../signInAuth";
import { signInExits } from "../slot";
import type { InstanceConfig } from "../instance";
import { useBackAccount } from "./backAccount";
import { Button, FIELD, Icon, LINK, SETTINGS_HEADING } from "./bits";

/**
 * Two fields, and nothing else.
 *
 * A real sign-in screen, which the file it replaces said this system did not
 * have — `KeyGate`'s docblock read "there is no password, no session cookie and
 * no reset flow, because the control plane has no concept of any of them", and
 * two of those three are still true. There is no reset flow and no cookie, on
 * purpose: the credential this hands back is a bearer token in `localStorage`,
 * sent only to this origin, never to a daemon and never to the relay. Nothing is
 * carried by the browser on its own initiative, which is what keeps
 * `Access-Control-Allow-Origin: *` safe in `src/cors.ts`.
 *
 * Rendered **outside `AppShell`**: there is no rail and no header, because there
 * is nothing to put in either yet. Same as the loading screen, and both size
 * against the `html, body, #root { height: 100% }` rule rather than `AppShell`'s
 * `h-dvh`.
 *
 * **The form is a real `<form>` with a username field in front of a password
 * field, and that arrangement is the whole of password-manager support** — 1Password,
 * Chrome and Safari all key on the autocomplete tokens and on the order. Enter
 * submits because a native form does that for free, so there is no `onKeyDown`
 * here and no IME question: `keys.ts` guards Enter in the *composer*, where Enter
 * is a send and a Japanese or Korean input method would otherwise commit a
 * candidate invisibly. Here it is a submit, and the browser's own handling
 * already waits for composition to end.
 *
 * **The API-key field is gone.** It existed because `KeyGate` was deleted and an
 * account that had never held a password would otherwise be shut out of the
 * browser by one 401. That argument is weaker now and the screen is worth more:
 * a lost password is recovered by mail, and a key is minted from *inside* the
 * app under Settings → Account. What it still costs is stated rather than
 * waved away — an account with **no password at all** and only a key can no
 * longer reach this screen, and its way in is `cpctl`, which takes the key
 * unchanged. Nobody is in that state on an instance where every account was
 * created with a password or an invitation.
 *
 * **Two doors, on two planes.** Recovery sits against the form, because it is
 * about the thing that just failed; sign-up is the standard sentence at the foot
 * of the screen, because it is about being on the wrong screen entirely. Both
 * wear `LINK` and neither is a `Button`: a navigation does not get the
 * affirmative fill, but it does have to look like a navigation — as one muted
 * line holding both, they read as prose and were tapped by nobody.
 */
export function SignIn({
  notice,
  config,
}: {
  notice: string | null;
  /**
   * What this instance allows, or `null` while it is unknown.
   *
   * Taken as a prop rather than read from the store, because this screen is the
   * one thing rendered *before* there is anything else — and `showsGateLink`
   * fails open on `null`, so the honest thing is for the caller to hand over
   * whatever it has rather than for this file to decide when to look.
   */
  config: InstanceConfig | null;
}): ReactNode {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Where the two doors below lead. `location.origin` in a browser — which is the
   * control plane, and where its own gate bundle is served from — and the chosen
   * server under the shell, where `location.origin` is `tauri://localhost` and
   * would name an installer that joins nothing.
   */
  const authority = controlPlaneOrigin();
  /*
   * ⚠ **The ways off this screen, beside signing in, and each exists only where
   * its far side does.** ‹ Server on a window nobody has signed in to, when there is
   * an account to return to from there; ‹ *that account* on a signed-out account's
   * own window; Remove account on a window that is an account on that list. **One
   * chevron at most, and no Cancel** — the owner's call, 2026-09-24: a way back is
   * drawn the one way this app draws one, naming where it goes, and a first
   * sign-in has none. The table is `slot.ts`'s, pure and driven by
   * `webcheck`, so three screens cannot read one payload three ways — and all
   * three are `false` in a browser and in the gate, where a window is not one of
   * several.
   *
   * `back` is asked of the host when this screen is drawn, never read out of the
   * boot payload: this is the screen an involuntary sign-out lands on, hours into
   * a session in which accounts may have been added or removed.
   */
  const back = useBackAccount();
  const exits = signInExits(nativeBoot(), back === undefined ? undefined : (back?.key ?? null));

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !signInReady(name, password)) return;
    setBusy(true);
    setError(null);
    void signInAuth()
      .login(name.trim(), password)
      .catch((cause: unknown) => setError(signInError(cause)))
      .finally(() => setBusy(false));
  };

  /*
   * The two new ways off, and why neither is guarded by a confirmation. ‹ *that
   * account* shows another account and changes nothing about this one. Remove account is
   * one tap on a screen that is already signed out: nothing is lost that signing
   * in again does not restore, because this computer keeps the account's device
   * and its daemon's root. A refusal is a sentence where the form's own errors
   * go, rather than a control that silently did nothing.
   */
  const leave = (): void => {
    setError(null);
    void signInAuth()
      .switchBack()
      .catch((cause: unknown) => setError(errorText(cause)));
  };
  const remove = (): void => {
    setError(null);
    void signInAuth()
      .forgetAccount()
      .catch((cause: unknown) => setError(errorText(cause)));
  };

  // Chrome from `FIELD`, layout here. This screen's fields are the ones the
  // settings password form had drifted from — see the constant.
  const field = `mt-1 w-full ${FIELD}`;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/* The product's name is a name: capitalised here, in the rail's heading,
            in `<title>` and in every mail this service sends. Lowercase `reemoat`
            survives only where it is an *identifier* — `REEMOAT_*`, `@reemoat/web`,
            `~/.reemoat`, the storage keys — and those must not be touched. */}
        {/*
          ⚠ **The way back to the screen before this one, and its absence was a
          one-way door I built while removing another.**
          
          The welcome asks for a server and `Continue` adopts it. Without this
          control, somebody who typed a reachable but *wrong* address arrived here
          with no route to the screen that sets it — Settings → Account needs a
          session, and getting one needs the right server. That is exactly the
          defect this whole change set out to fix, reintroduced one screen along:
          `setNativeServer` had one call site, and for a moment it had one that
          nobody signed out could reach.

          **It names where it goes and not what it shows.** `web-shell.md` says
          there is no back button in this app — every leading control goes to a
          fixed destination rather than into a history — and this is one of those:
          it is drawn as a chevron and is not `history.back()`. It says "Server"
          because that is the screen it opens, and deliberately not the address,
          which is the line the owner rejected on this screen.

          ⚠ **Only on a window nobody has signed in to — no longer on every
          window in the shell.** An account is a server and a person, so a
          signed-out account's sign-in screen may not repoint its server: that
          would make it a different account wearing the old one's keyring entry,
          device and daemon, and the host refuses it (Q5.120). Another server is
          another account, from the menu.

          ⚠ **And no longer on a first sign-in, which is the case it was built
          for** — the owner's call, 2026-09-24: a first sign-in has no way back.
          What that gives up is named rather than hidden: a reachable but wrong
          address, typed on first run, is a sign-in form with nowhere else to go.
          The server step's probe still refuses anything that is not a Reemoat
          control plane, so the address that strands somebody is somebody else's
          working server. On an add it stays, with the server screen's own ‹
          leading back to the account that was on screen.

          Never in a browser, where the server is the origin that served the
          page and there is no screen to go back to.
        */}
        {exits.server && (
          <button
            type="button"
            onClick={() => signInAuth().pickServer()}
            /* ⚠ **Not while a sign-in is in flight.** `App.tsx` tests
               `pickingServer` above `phase`, so a login that succeeds behind this
               screen would leave somebody on the server form with a live session
               — recoverable through its own ‹, and still a screen nobody asked for.
               The one control that leaves mid-request is the one that should not. */
            disabled={busy}
            className="tap -ml-1 mb-3 flex items-center gap-0.5 text-sm text-muted hover:text-fg disabled:text-faint"
          >
            <Icon as={ChevronLeft} size={14} />
            Server
          </button>
        )}
        {/*
          The way back from a signed-out account's own sign-in, to the account
          that was on screen before it — named, as ‹ Server names its far side.
          `disabled={busy}` for the reason above.
        */}
        {exits.back && back != null && (
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

        <h1 className="text-xl font-semibold">Reemoat</h1>
        <p className="mt-1 text-sm text-muted">Sign in to reach your machines.</p>

        {/*
          ⚠ **The server's address is not on this screen, and it was for one
          draft.** It sat under the lead sentence with a *Change* link, on the
          argument that a custom scheme has no address bar and `cp.ts`'s oldest
          rule — the credential goes to one origin — therefore has nowhere else to
          be stated. The argument was sound and the screen was wrong: a login form
          is not where somebody learns which fleet they are on, and a URL with a
          verb beside it reads as a thing to deal with before typing a password.

          It has its own screen instead — the welcome, which is the first thing
          anybody sees and whose whole subject is that one question — and a row
          under Settings → Account for afterwards, which states it and no longer
          offers to change it (Q3.643). Owner's call, 2026-09-16, on seeing it
          shipped.
        */}

        {/* The involuntary case only — an expired or revoked session. A refused
            submit is local state and belongs beside the fields, not up here, and
            either of the two forms refusing supersedes it: the sentence about how
            you came to be here stops being the useful one the moment something
            you just typed was rejected. */}
        {notice !== null && error === null && (
          <p className="mt-3 text-sm font-medium text-fg">{notice}</p>
        )}

        <form onSubmit={submit}>
          {/* **Both, on one field, because the server takes both on one field.**
              `autoComplete="username"` stays: it is the token a password manager
              fills for the identifier of a sign-in form whichever kind it holds,
              and `email` would tell one to stop offering a saved username. There
              is no placeholder — the label is the whole hint, and this screen's
              source text is read off disk by `webcheck`. */}
          <label
            htmlFor="signin-name"
            className={`mt-4 block ${SETTINGS_HEADING}`}
          >
            Username or email
          </label>
          <input
            id="signin-name"
            name="username"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            className={field}
          />

          <label
            htmlFor="signin-password"
            className={`mt-3 block ${SETTINGS_HEADING}`}
          >
            Password
          </label>
          <input
            id="signin-password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            enterKeyHint="go"
            className={field}
          />

          {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}

          <div className="mt-4 flex gap-2">
            <Button type="submit" tone="primary" disabled={busy || !signInReady(name, password)} className="flex-1">
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </div>
        </form>

        {/*
          **Recovery belongs to the form, and sign-up does not.** They were one
          line separated by a `·`, which made them read as a pair of equal
          options and made neither read as a link at all — two runs of
          `text-muted` under a form are prose. They are answers to different
          questions: *this password is not working* is about the thing that just
          failed, so it sits against it; *I do not have an account* is about
          being on the wrong screen entirely, and that is the standard sentence
          at the foot of every sign-in page there has ever been.

          The strip keeps a fixed minimum height so the block does not change
          size when the config lands, and `showsGateLink` fails **open** — an
          unknown config draws both doors rather than none.

          ⚠ **Both doors are anchors at the control plane, not navigations.** This
          bundle carries no gate screen any more — `/register` and `/forgot` are
          the control plane's own addresses, served from `dist-gate`. Three
          properties ride on the exact shape, and each is a real failure:

          **Absolute, never `/forgot`.** `openableHref` parses with no base, so a
          relative href answers `null`, the shell's click interceptor does not
          fire, the webview navigates, Tauri's asset protocol falls back to
          `index.html`, and the app redraws this screen with a changed URL. A
          relative href is a silent no-op under the shell.

          **`target="_blank"`, and this is the one that is easy to lose.** In a
          browser `<authority>/register` is the *same origin* as the page this
          screen is drawn on — so a plain anchor is a real navigation, and what it
          unloads is this document, taking whatever was already typed into the two
          fields with it. `_blank` answers both surfaces at once: the shell
          intercepts the click in the capture phase and never reads the attribute,
          and a browser keeps the form on screen behind the new tab.

          **`rel="noreferrer"`**, the house idiom beside it.
        */}
        <div className="mt-4 min-h-5 text-sm">
          {showsGateLink("forgot", config) && (
            <a href={`${authority}/forgot`} target="_blank" rel="noreferrer" className={`tap ${LINK}`}>
              Forgot password?
            </a>
          )}
        </div>

        {/*
          The foot of the screen: one sentence about accounts, whichever answer
          it has. When registration is open it ends in a link; when it is closed
          `gateNotice` says the same thing in prose — *"No account? Ask whoever
          runs this control plane."* — so the shape of the line does not depend
          on the instance, only its last few words do.

          Not `cpctl`: the person reading this is not the person with a shell on
          the control plane. `gateNotice` is `null` exactly when both doors are
          drawn, so this block and the strip above can never both be empty for
          the wrong reason.
        */}
        <div className="mt-8 space-y-2 text-sm text-muted">
          {/*
            ⚠ **The same state and the same sentence as a browser with storage
            disabled**, arriving by a different cause: there a private window has no
            durable storage, here the machine has no credential store this app can
            use. `cp.ts`'s `readStoredCredential` catch is the browser half and says
            *"The app still works for one session; it just asks for the password
            again next time."*
            One state, one wording — two spellings of one state is a defect this
            repository has shipped before. Read from `nativeBoot()` directly rather
            than taken as a prop: this screen is only ever drawn once hydration has
            settled, because `phase` cannot be `signed_out` before then.
          */}
          {nativeBoot()?.durable === false && (
            <p className="text-fg">
              This computer has no credential store Reemoat can use, so it will ask you to sign in again after it
              restarts.
            </p>
          )}
          {showsGateLink("register", config) && (
            <p>
              No account?{" "}
              <a href={`${authority}/register`} target="_blank" rel="noreferrer" className={`tap ${LINK}`}>
                Create one
              </a>
            </p>
          )}
          {gateNotice(config) !== null && <p>{gateNotice(config)}</p>}
          {/*
            Last in the foot, and an act rather than a navigation — so it does not
            wear the link look the two doors above wear, and those stay the only
            two. Drawn only on a window that is an account on this computer's list;
            a window nobody has signed in to is discarded by leaving it, and is not
            on the list to take off.
          */}
          {exits.remove && (
            <p>
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="tap text-muted hover:text-fg disabled:text-faint"
              >
                Remove account
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
