import { useEffect, useState, type ReactNode } from "react";
import { CONTROL_PLANE_UNREACHABLE, orderKeys, rememberRevokedKey, thisBrowsersKey } from "../../account";
import * as cp from "../../cp";
import type { ApiKeyRecord } from "../../cp";
import { navigate } from "../../router";
import { settingsLeafPath, settingsPath } from "../../settings";
import { store } from "../../store";
import type { Me } from "../../wire";
import { errorText } from "../../http";
import { Button, Empty, SkeletonRow, Spinner } from "../bits";
import { toast } from "../Toast";
import { KeyRow, KeyTable } from "./KeyRow";
import { OneTimeSecret } from "./OneTimeSecret";

// The minted secret, handed over in module state rather than the URL; peeked in state, cleared on mount.
let handoff: string | null = null;

function peekHandoff(): string | null {
  return handoff;
}

function clearHandoff(): void {
  handoff = null;
}

/** The only place a key is minted; your own keys are one tap to revoke (Q3.219), and revoking this browser's signs it out. */
export function KeysSection({ me }: { me: Me | null }): ReactNode {
  const [keys, setKeys] = useState<ApiKeyRecord[] | "failed" | null>(null);
  const [minting, setMinting] = useState(false);

  const load = (): void => {
    void cp
      .myKeys()
      .then((rows) => setKeys(orderKeys(rows)))
      .catch(() => setKeys("failed"));
  };
  useEffect(load, []);

  if (me === null) {
    // Reachable: `bootstrap` stays ready with no `me` when the control plane is unreachable.
    return (
      <Empty
        failed
        action={
          <Button size="sm" onClick={() => void store.refreshMe()}>
            Try again
          </Button>
        }
      >
        {CONTROL_PLANE_UNREACHABLE}
      </Empty>
    );
  }

  const live = keys === null || keys === "failed" ? 0 : keys.filter((key) => key.revokedAt === null).length;
  const atCeiling = live >= MAX_KEYS;
  // Waits for the list but not for a failed read: minting does not need it, and the control plane refuses at its ceiling.
  const newKeyWaits = keys === null;
  const credential = cp.currentCredential();

  const revokeOwn = (record: ApiKeyRecord): (() => void) => {
    if (!thisBrowsersKey(credential, record.prefix)) return load;
    // Clear the credential before any re-read, or the dead key 401s into a session-expired gate. Only the notice is guarded.
    return () => {
      try {
        rememberRevokedKey(window.sessionStorage, record.prefix);
      } catch {
        // Private browsing, or storage disabled: the sign-in screen is still right.
      }
      cp.clearSession();
      window.location.href = "/";
    };
  };

  const mint = (): void => {
    setMinting(true);
    void cp
      .mintMyKey()
      .then((answer) => {
        handoff = answer.apiKey;
        navigate(settingsLeafPath("new-key"));
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setMinting(false));
  };
  const newKey = (
    <Button tone="primary" size="sm" disabled={newKeyWaits || atCeiling || minting} onClick={mint}>
      {minting ? <Spinner /> : "New key"}
    </Button>
  );

  return (
    <div>
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted">For cpctl and scripts. Never expire.</p>
        <span className="shrink-0">{newKey}</span>
      </div>
      {atCeiling && <p className="mt-1 text-xs text-muted">{`${MAX_KEYS} of ${MAX_KEYS}; revoke one first.`}</p>}

      {keys === null ? (
        <SkeletonRow />
      ) : keys === "failed" ? (
        <Empty failed action={<Button size="sm" onClick={load}>Try again</Button>}>
          Could not read your keys.
        </Empty>
      ) : keys.length === 0 ? (
        <Empty>No keys yet.</Empty>
      ) : (
        <KeyTable>
          {keys.map((record) => (
            <KeyRow
              key={record.id}
              record={record}
              thisBrowser={thisBrowsersKey(credential, record.prefix)}
              revoke={() => cp.revokeMyKey(record.id)}
              onRevoked={revokeOwn(record)}
            />
          ))}
        </KeyTable>
      )}
    </div>
  );
}

/** Shows the handed-off key once and never mints; with nothing in hand it walks back. No password on the way (Q1.630). */
export function NewKeyScreen(): ReactNode {
  const [minted] = useState<string | null>(peekHandoff);
  const back = (): void => navigate(settingsPath("keys"), true);

  useEffect(() => {
    clearHandoff();
    if (minted === null) back();
  }, [minted]);

  if (minted === null) return null;
  return (
    <OneTimeSecret
      label="Your new API key"
      value={minted}
      note="Shown once. cpctl reads it from REEMOAT_CP_KEY."
      onDone={back}
    />
  );
}

/** Mirrors `MAX_KEYS_PER_USER` on the control plane; pincheck compares both declarations. */
const MAX_KEYS = 10;
