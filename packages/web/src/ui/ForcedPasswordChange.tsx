import { useState, type FormEvent, type ReactNode } from "react";
import { changePasswordError, passwordProblem, passwordProblemText } from "../account";
import * as cp from "../cp";
import { store } from "../store";
import type { Me } from "../wire";
import { Button, FIELD, SETTINGS_HEADING } from "./bits";
import { GateCard } from "./gate/GateCard";
import { UseAnotherAccount } from "./UseAnotherAccount";

/** Reached by state rather than a route, and not a Sheet since it must not be dismissible; the enforcing half is requirePasswordCurrent on the control plane. */
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
        // bootstrap rather than refreshMe: the machine list came back empty while the wall stood, so it is re-read along with me.
        return store.bootstrap();
      })
      .catch((cause: unknown) => {
        // An invalid_password 401 does not sign anybody out: authFailure answers null for that code.
        setError(changePasswordError(cause));
        setBusy(false);
      });
  };

  const field = `mt-1 w-full ${FIELD}`;
  const label = `mt-3 block ${SETTINGS_HEADING}`;

  return (
    <GateCard
      title="Choose your own password"
      lead="This account was created for you with a temporary password. It has to be replaced before you can go any further."
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <UseAnotherAccount />
          <Button tone="ghost" onClick={() => void store.signOut()}>
            Sign out
          </Button>
        </div>
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
