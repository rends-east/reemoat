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

/** A real form with the username field before the password field: password managers key on the autocomplete tokens and that order. */
export function SignIn({
  notice,
  config,
}: {
  notice: string | null;
  /** What this instance allows, or null while unknown; showsGateLink fails open on null. */
  config: InstanceConfig | null;
}): ReactNode {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Under the shell this page's origin is not the server, so the doors are built from the control plane's origin.
  const authority = controlPlaneOrigin();
  // Each way off exists only where its far side does, per signInExits in slot.ts.
  // The back account is asked of the host, not read from boot: accounts may have changed since.
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

  // No confirmation: this computer keeps the account's device and daemon root, so signing in again restores it.
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

  const field = `mt-1 w-full ${FIELD}`;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/* Only on a window nobody has signed in to: a signed-out account may not repoint its server (Q5.120). */}
        {exits.server && (
          <button
            type="button"
            onClick={() => signInAuth().pickServer()}
            // Disabled mid-request: App.tsx checks pickingServer before phase, so a login landing behind it would strand the server form.
            disabled={busy}
            className="tap -ml-1 mb-3 flex items-center gap-0.5 text-sm text-muted hover:text-fg disabled:text-faint"
          >
            <Icon as={ChevronLeft} size={14} />
            Server
          </button>
        )}
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

        {/* Only the involuntary notice (expired or revoked session); a refused submit supersedes it. */}
        {notice !== null && error === null && (
          <p className="mt-3 text-sm font-medium text-fg">{notice}</p>
        )}

        <form onSubmit={submit}>
          {/* autoComplete stays username for either identifier kind; email would stop a manager offering a saved username. */}
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

        {/* Absolute and in a new target: a relative href is a no-op under the shell, and a same-origin navigation would discard what was typed. */}
        <div className="mt-4 min-h-5 text-sm">
          {showsGateLink("forgot", config) && (
            <a href={`${authority}/forgot`} target="_blank" rel="noreferrer" className={`tap ${LINK}`}>
              Forgot password?
            </a>
          )}
        </div>

        <div className="mt-8 space-y-2 text-sm text-muted">
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
