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

/**
 * The key the list just minted, on its way to {@link NewKeyScreen}.
 *
 * Module state rather than a URL segment, because the value is the secret and
 * an address is copied, logged and kept in history. It is set by the New key
 * button after the 201, read **once** by the screen it navigates to, and gone
 * after that — so a reload of `/settings/keys/new` finds nothing and walks
 * back to the table rather than minting a second key nobody asked for.
 *
 * **Reading and clearing are two calls on purpose** (review D16). The screen
 * peeks in its state initialiser and clears from its mount effect, once the
 * value is in state. One call that nulled on read was right only because React
 * 19 keeps the first initialiser's result under StrictMode's double call; with
 * the two apart, "read once" is a property of the construction — state survives
 * StrictMode's simulated remount, so the effect firing twice clears a value the
 * screen already holds.
 */
let handoff: string | null = null;

/** The minted key, left where it is: reading is not what consumes it. */
function peekHandoff(): string | null {
  return handoff;
}

/** What consumes it, from the screen's effect once the value is in state. */
function clearHandoff(): void {
  handoff = null;
}

/**
 * Your API keys: a table, and a button that leaves the screen.
 *
 * They were a block inside Account; the brief that produced this screen said
 * why that was wrong in one line: a key is minted for `cpctl` on another
 * machine, and the screen it sat on was about *you*. Everything that was true
 * of the block is still true here — this is the **only** place a key is minted
 * (`adminMintKey` is deleted: an admin may take a credential away and never
 * issue one), `myKeys` and `revokeMyKey` have no other callers, and your own
 * keys are **one tap** to revoke (Q3.219, kept whole by decision 4C).
 *
 * ⚠ **Nothing on this screen expands.** The first version drew the password
 * step under the button and the minted key in a card above the table, and the
 * owner's review of it was two words. A key is a row; making one is
 * {@link NewKeyScreen}, its own address, and the table is only ever the table.
 *
 * The row knows which key **this browser** is holding — decided from the
 * credential in hand, `thisBrowsersKey`, with no control-plane change — and
 * revoking that one signs this tab out **on purpose** rather than by the next
 * request 401ing: the credential is cleared before anything can be re-read, a
 * one-shot line is left for the gate, and the page reloads onto it (5A).
 */
export function KeysSection({ me }: { me: Me | null }): ReactNode {
  /* `null` is "not read yet", `"failed"` is "asked and refused", and a list is a
     list — three states, because "No keys yet." over a list that has not arrived
     is a false claim. */
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
    // Reachable: `bootstrap` keeps `phase: "ready"` with `me: null` when the
    // control plane is unreachable but machines are already known.
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
  /*
   * The ceiling is the control plane's `MAX_KEYS_PER_USER`, answered as a 409
   * `key_limit`. Refusing here is what stops a tap that opens a screen only to
   * be told no. Mirrored rather than fetched: the number has been 10 since keys
   * existed.
   */
  const atCeiling = live >= MAX_KEYS;
  /*
   * New key waits for the list and not for a failed read. While `keys === null`
   * the count is unknown — `live` reads 0 — so a tap during the skeleton could
   * open the leaf only to be answered `409 key_limit` (review D18). After a
   * failed read it stays enabled **on purpose**: minting does not need the list,
   * the control plane refuses at its own ceiling, and a screen that cannot read
   * your keys should still let you make one for the machine that can.
   */
  const newKeyWaits = keys === null;
  const credential = cp.currentCredential();

  const revokeOwn = (record: ApiKeyRecord): (() => void) => {
    if (!thisBrowsersKey(credential, record.prefix)) return load;
    /*
     * ⚠ **Clear the credential before anything is re-read.** The 200 has landed
     * and the key in this tab is dead; a `load()` here would send it, answer
     * `401 api_key_revoked`, and hand the gate "Your session expired" about an
     * act the person just chose. So: the notice, the clear, the reload — and no
     * request in between. `webcheck` pins the order.
     *
     * The notice is the optional third of the three; the clear and the reload
     * are not. `sessionStorage` throws where the read side in `App.tsx` already
     * guards for it, and unguarded here the throw skipped both — the tab kept a
     * dead key and the next request 401ed into the very sentence this line
     * exists to replace (D3). So only the notice is guarded, and losing it costs
     * the gate one line rather than the sign-out.
     */
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

  /*
   * One tap: mint, then leave for the screen that shows the key. The request
   * runs from the list rather than from the screen so the screen has nothing to
   * ask and nothing to press — it is the key and Done. Nothing in the list
   * changes until Done brings the person back, when the table re-reads.
   */
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
      {/* Drawn beside the button rather than after a refused request. Six words
          with the semicolon, the consequence-at-rest cap; the dash it carried
          counted as a seventh (review D10). */}
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
              confirm={false}
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

/**
 * The key you just made, once. `/settings/keys/new`.
 *
 * The mint happened on the list's button; this screen only shows what came
 * back: peeked out of the module-level handoff in the state initialiser and
 * cleared from the mount effect, so it is read once by construction rather
 * than by React 19 keeping the first of StrictMode's two initialiser calls.
 * Arriving here with nothing in hand — a reload, a bookmark, Back after Done —
 * walks straight back to the table in that same effect, never minting: the
 * screen has no verb of its own.
 *
 * No password anywhere on the way (Q1.630, the owner's call); what stands in
 * for the gate is the table, where every key is dated, this browser's is
 * marked, and any is one tap to revoke.
 *
 * Done walks back with `replace`, so Android's Back does not return to a screen
 * whose value has already stopped existing. The note names the variable `cpctl`
 * reads rather than drawing a second box with the same bytes in it.
 */
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

/**
 * Mirrors `MAX_KEYS_PER_USER` on the control plane; see `atCeiling`. The two
 * copies are held equal by `pincheck`, which reads both declarations — this
 * line's exact shape is what it captures.
 */
const MAX_KEYS = 10;
