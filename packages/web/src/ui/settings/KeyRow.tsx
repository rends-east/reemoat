import { Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ageText } from "../../account";
import type { ApiKeyRecord } from "../../cp";
import { errorText } from "../../http";
import { Badge, Button, DangerButton, Spinner } from "../bits";
import { toast } from "../Toast";

/**
 * API keys are a table. Every list of them — yours on the API keys screen,
 * somebody else's in the Users panel — is this element with {@link KeyRow}s in
 * it, so the two cannot drift into two markups again (they had), and so a key
 * reads the way a key reads everywhere else: one line per key, one column per
 * fact.
 *
 * Four columns, the last one unheaded: the prefix, when it was made, when it was
 * last presented, and the verb. `table-fixed` is deliberately *not* set — the
 * prefix column is eight monospace characters and the action column is a button,
 * and letting the browser size them is what keeps it one line at 320px.
 */
export function KeyTable({ children }: { children: ReactNode }): ReactNode {
  return (
    <table className="mt-2 w-full text-sm">
      <thead>
        <tr className="text-left text-2xs font-semibold tracking-wider text-muted uppercase">
          <th className="py-1.5 pr-3 font-semibold">Key</th>
          <th className="py-1.5 pr-3 font-semibold">Made</th>
          <th className="py-1.5 pr-3 font-semibold">Last used</th>
          <th className="py-1.5">
            <span className="sr-only">Action</span>
          </th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/**
 * One API key, as a table row.
 *
 * What differs between the two callers is a decision, not paint, so it arrives
 * as a prop:
 *
 * - `confirm` — whether Revoke is two-step. **Your own keys are one tap**
 *   (Q3.219, kept whole in decision 4C: every own key, the one this browser is
 *   holding included); **somebody else's is two**, with the question naming the
 *   key. The confirming pair replaces the button inside the same cell, and Cancel
 *   is last — Q3.218's ordering, which is the safety property rather than a
 *   preference.
 * - `thisBrowser` — draws the `this browser` badge and the one consequence that
 *   is allowed at rest, "revoking it signs you out", because the control beside
 *   it is one-tap (decision 10A). The caller decides it from the credential it
 *   holds (`thisBrowsersKey`); with a session credential no row is ever this.
 *
 * `revoke` is the request; `onRevoked` is what the caller does with the 200 —
 * re-read the list, or for this browser's own key, sign out on purpose.
 *
 * A revoked row keeps its place rather than vanishing: the question the table
 * answers is "is the one that leaked dead yet", and a row that disappears on
 * revocation cannot answer it. It is greyed, badged, and sorted last by the
 * caller.
 */
export function KeyRow({
  record,
  confirm,
  thisBrowser = false,
  revoke,
  onRevoked,
}: {
  record: ApiKeyRecord;
  confirm: boolean;
  thisBrowser?: boolean;
  revoke: () => Promise<unknown>;
  onRevoked: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const revoked = record.revokedAt !== null;
  const now = Date.now();
  const lastUsed =
    record.lastUsedAt === undefined || record.lastUsedAt === null
      ? "never"
      : `${ageText(now - record.lastUsedAt)} ago`;

  const run = (): void => {
    setBusy(true);
    void revoke()
      .then(() => {
        setConfirming(false);
        onRevoked();
      })
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <tr className={`border-t border-edge/60 align-middle ${revoked ? "text-muted" : ""}`}>
      <td className="py-2 pr-3">
        <span className="flex flex-wrap items-center gap-2">
          {/* The eight clear characters the lookup is indexed on — never the key
              and never its hash, neither of which the route will ever send. */}
          <span className="font-mono text-xs">{record.prefix}…</span>
          {revoked && <Badge>revoked</Badge>}
          {thisBrowser && !revoked && (
            <>
              <Badge tone="strong">this browser</Badge>
              {/* The one consequence drawn at rest on the keys screen, and only
                  here, because the button beside it acts on the first tap (10A). */}
              <span className="text-2xs text-muted">revoking it signs you out</span>
            </>
          )}
        </span>
      </td>
      <td className="py-2 pr-3 text-xs whitespace-nowrap text-muted">{`${ageText(now - record.createdAt)} ago`}</td>
      <td className="py-2 pr-3 text-xs whitespace-nowrap text-muted">{lastUsed}</td>
      <td className="py-2 text-right">
        {!revoked && (
          <span className="inline-flex flex-wrap items-center justify-end gap-2">
            {confirm && confirming ? (
              <>
                <span className="text-xs text-muted whitespace-nowrap">
                  Revoke <span className="font-mono">{record.prefix}…</span>?
                </span>
                <DangerButton icon={Trash2} size="sm" disabled={busy} onClick={run}>
                  {busy ? <Spinner /> : "Revoke"}
                </DangerButton>
                <Button size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={busy} onClick={confirm ? () => setConfirming(true) : run}>
                {busy && !confirm ? <Spinner /> : "Revoke"}
              </Button>
            )}
          </span>
        )}
      </td>
    </tr>
  );
}
