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

/** The host is the only normalizer of the address, since two spellings are two credential keys; a candidate is probed before it is adopted. */

type Found = { kind: "reemoat" } | { kind: "stranger" } | { kind: "unreachable"; why: string };

// A 404 on the instance route is an older control plane, so it falls through to the JWKS route every control plane serves unauthenticated.
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
    return { kind: "unreachable", why: cause instanceof Error ? cause.message : "could not reach that address" };
  }
}

export function ChooseServer(): ReactNode {
  const current = nativeBoot()?.server ?? null;
  const editing = current !== null;
  const suggested = nativeBoot()?.defaultServer ?? null;
  const back = useBackAccount();
  const adding = back !== null && back !== undefined;
  const [address, setAddress] = useState(current ?? suggested ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const durable = nativeBoot()?.durable !== false;
  // Locked only on a first run with a compiled-in suggestion (Q3.643); disabled rather than readOnly, so Continue takes the focus.
  const [locked, setLocked] = useState(!editing && suggested !== null);
  const field = useRef<HTMLInputElement>(null);

  // No entrance holds a credential today, so held is null; the detach-and-restore order stays for one that does (Q5.120).

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const typed = address.trim();
    if (busy || typed.length === 0) return;
    // Decided before the credential is detached, by exact equality only: a looser match would be a second normalizer.
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
      // The credential goes before the host's origin moves, or in-flight calls would hand this bearer to the new host; a refusal hands it back (Q7.148).
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
      // A reload rather than an in-memory unwind: everything in this process derives from the old fleet's credential.
      window.location.assign("/");
    })();
  };

  // flushSync: a disabled input cannot take focus, and a focus outside the tap raises no keyboard on a phone.
  const unlock = (): void => {
    flushSync(() => setLocked(false));
    field.current?.focus();
    field.current?.select();
  };

  const leave = (): void => {
    setError(null);
    void store.switchAccount(null).catch((cause: unknown) => setError(errorText(cause)));
  };

  if (back === undefined) return <div className="flex min-h-full items-center justify-center p-6" />;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm">
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
          <div className="mt-1 flex items-center gap-2">
            <input
              ref={field}
              id="server-address"
              name="url"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              disabled={locked}
              autoComplete="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              inputMode="url"
              placeholder="app.reemoat.com"
              autoFocus={!editing && !locked}
              className={`min-w-0 flex-1 ${FIELD} disabled:border-edge disabled:text-muted`}
            />
            {locked && (
              <IconButton icon={Pencil} label="Edit server address" size="nav" onClick={unlock} disabled={busy} />
            )}
          </div>

          {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}

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

        <div className="mt-8 space-y-2 text-sm text-muted">
          {!editing && !adding && suggested === null && (
            <p>
              A server holds your account and the machines you add. Use one somebody runs for you, or run your own with{" "}
              <span className="font-mono">install.sh control-plane</span>.
            </p>
          )}
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
