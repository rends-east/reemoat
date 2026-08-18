import { useState, type FormEvent, type ReactNode } from "react";
import { changePasswordError, passwordProblem, passwordProblemText } from "../account";
import * as cp from "../cp";
import { store } from "../store";
import type { Me } from "../wire";
import { Button, FIELD } from "./bits";
import { GateCard } from "./gate/GateCard";

/**
 * The wall an admin-created account lands on, and the only way past it.
 *
 * **Reached by state, not by a URL**, which is why it lives here beside
 * `SignIn.tsx` rather than in `ui/gate/`: filing it with the routed screens
 * would invite somebody to give it a route, and a route is a thing you can leave
 * by typing another one.
 *
 * **It is not a `Sheet`.** A sheet has a ✕ and registers `useDismissible`, so
 * Escape would reveal the app behind an obligation the server is still
 * enforcing. The screen has no dismissal, so it must not be built from the
 * primitive whose entire job is dismissal. It returns before `<AppShell>` in
 * `App.tsx`, so a typed `/settings/account` renders this too — the client half
 * of a gate whose real half is `requirePasswordCurrent` on the control plane.
 *
 * **The current password is required and not waived.** The temporary password is
 * the thing they just typed to get here, so they have it; waiving it would build
 * a route where a lifted session token becomes ownership of the account in one
 * request, which is the argument `POST /v1/me/password` has always made.
 *
 * **Sign out stays reachable**, and it has to: somebody who has lost the
 * temporary password has exactly one way out of this screen, and without it they
 * are clearing site data. `ghost` rather than `DangerButton` — `--color-danger`
 * is for at most one control in a view, this view's one real decision is the
 * password, and signing out is the most *reversible* thing on screen.
 */
export function ForcedPasswordChange({ me }: { me: Me }): ReactNode {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = next.length > 0 || confirm.length > 0 ? passwordProblem(current, next, confirm) : null;
  const ready = !busy && current.length > 0 && next.length > 0 && confirm.length > 0 && problem === null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    void cp
      .changePassword(current, next)
      .then(() => {
        /*
         * `bootstrap`, not `refreshMe`.
         *
         * The tab has **no machines listed** — `bootstrap`'s tolerant catch
         * returned an empty list while the wall stood — so re-reading one
         * boolean would take the wall down and reveal an app with an empty
         * fleet. `bootstrap` re-reads `me` and lists machines in one call, which
         * is exactly the state a fresh sign-in is in.
         */
        return store.bootstrap();
      })
      .catch((cause: unknown) => {
        // `401 invalid_password` does **not** sign anybody out: `authFailure`
        // answers `null` for that code, a guard added after it bit somebody on
        // this exact shape of screen.
        setError(changePasswordError(cause));
        setBusy(false);
      });
  };

  const field = `mt-1 w-full ${FIELD}`;
  const label = "mt-3 block text-2xs font-semibold tracking-wider text-muted uppercase";

  return (
    <GateCard
      title="Choose your own password"
      lead="This account was created for you with a temporary password. It has to be replaced before you can go any further."
      footer={
        <Button tone="ghost" onClick={() => void store.signOut()}>
          Sign out
        </Button>
      }
    >
      <form onSubmit={submit}>
        {/* A password manager updating a saved entry has to know which one. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          className="sr-only"
          tabIndex={-1}
          readOnly
          value={me.name}
        />
        <label htmlFor="wall-current" className={label}>
          The password you were given
        </label>
        <input
          id="wall-current"
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          autoComplete="current-password"
          className={field}
        />
        <label htmlFor="wall-next" className={label}>
          New password
        </label>
        <input
          id="wall-next"
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          autoComplete="new-password"
          className={field}
        />
        <label htmlFor="wall-confirm" className={label}>
          Again
        </label>
        <input
          id="wall-confirm"
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
          enterKeyHint="go"
          className={field}
        />
        {problem !== null && <p className="mt-2 text-sm text-muted">{passwordProblemText(problem)}</p>}
        {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
        <Button type="submit" tone="primary" disabled={!ready} className="mt-4 w-full">
          {busy ? "Setting…" : "Set my password"}
        </Button>
      </form>
    </GateCard>
  );
}
