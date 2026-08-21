import { useState, type FormEvent, type ReactNode } from "react";
import { signInError, signInReady } from "../account";
import { gateNotice, showsGateLink } from "../gate";
import { navigate } from "../router";
import { store } from "../store";
import type { InstanceConfig } from "../instance";
import { Button, FIELD, LINK } from "./bits";

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

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !signInReady(name, password)) return;
    setBusy(true);
    setError(null);
    void store
      .login(name.trim(), password)
      .catch((cause: unknown) => setError(signInError(cause)))
      .finally(() => setBusy(false));
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
        <h1 className="text-xl font-semibold">Reemoat</h1>
        <p className="mt-1 text-sm text-muted">Sign in to reach your machines.</p>

        {/* The involuntary case only — an expired or revoked session. A refused
            submit is local state and belongs beside the fields, not up here, and
            either of the two forms refusing supersedes it: the sentence about how
            you came to be here stops being the useful one the moment something
            you just typed was rejected. */}
        {notice !== null && error === null && (
          <p className="mt-3 text-sm font-medium text-fg">{notice}</p>
        )}

        <form onSubmit={submit}>
          <label
            htmlFor="signin-name"
            className="mt-4 block text-2xs font-semibold tracking-wider text-muted uppercase"
          >
            Username
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
            className="mt-3 block text-2xs font-semibold tracking-wider text-muted uppercase"
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

          <Button
            type="submit"
            tone="primary"
            disabled={busy || !signInReady(name, password)}
            className="mt-4 w-full"
          >
            {busy ? "Signing in…" : "Sign in"}
          </Button>
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
        */}
        <div className="mt-4 min-h-5 text-sm">
          {showsGateLink("forgot", config) && (
            <button type="button" onClick={() => navigate("/forgot")} className={`tap ${LINK}`}>
              Forgot password?
            </button>
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
          {showsGateLink("register", config) && (
            <p>
              No account?{" "}
              <button type="button" onClick={() => navigate("/register")} className={`tap ${LINK}`}>
                Create one
              </button>
            </p>
          )}
          {gateNotice(config) !== null && <p>{gateNotice(config)}</p>}
        </div>
      </div>
    </div>
  );
}
