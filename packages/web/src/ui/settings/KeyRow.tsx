import { useState, type ReactNode } from "react";
import { ageText } from "../../account";
import type { ApiKeyRecord } from "../../cp";
import { errorText } from "../../http";
import { Badge, Button, SETTINGS_HEADING, Spinner } from "../bits";
import { TABLE } from "../kit/List";
import { toast } from "../Toast";

/** No `table-fixed`: the browser sizes the prefix and action columns, which keeps a row on one line at 320px. */
export function KeyTable({ children }: { children: ReactNode }): ReactNode {
  return (
    <table className={TABLE}>
      <thead>
        {/* The cells' own padding scheme, pr-3 between columns and px-4 at the box's edges, so head and body line up. */}
        <tr className={`text-left whitespace-nowrap ${SETTINGS_HEADING}`}>
          <th className="py-2 pr-3 pl-4 font-semibold">Key</th>
          <th className="py-2 pr-3 font-semibold">Made</th>
          <th className="py-2 pr-3 font-semibold">Last used</th>
          <th className="py-2 pr-4">
            <span className="sr-only">Action</span>
          </th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/**
 * One tap to revoke (Q3.219, Q1.631); a revoked row stays, so the table still says whether a leaked key is dead.
 * Every row is a fixed height, whatever its cells hold (Q3.554).
 */
export function KeyRow({
  record,
  thisBrowser = false,
  revoke,
  onRevoked,
}: {
  record: ApiKeyRecord;
  thisBrowser?: boolean;
  revoke: () => Promise<unknown>;
  onRevoked: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const revoked = record.revokedAt !== null;
  const now = Date.now();
  const lastUsed =
    record.lastUsedAt === undefined || record.lastUsedAt === null
      ? "never"
      : `${ageText(now - record.lastUsedAt)} ago`;

  const run = (): void => {
    setBusy(true);
    void revoke()
      .then(onRevoked)
      .catch((cause: unknown) => toast("error", errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <tr className={`h-12 border-t border-edge align-middle ${revoked ? "text-muted" : ""}`}>
      <td className="pr-3 pl-4">
        <span className="flex flex-wrap items-center gap-2">
          {/* Only the prefix: the route never sends the key or its hash. */}
          <span className="font-mono text-xs">{record.prefix}…</span>
          {thisBrowser && !revoked && (
            <>
              <Badge tone="strong">this browser</Badge>
              {/* The one consequence drawn at rest, because the button beside it acts on the first tap. */}
              <span className="text-xs text-muted">revoking it signs you out</span>
            </>
          )}
        </span>
      </td>
      <td className="pr-3 text-xs whitespace-nowrap text-muted">{`${ageText(now - record.createdAt)} ago`}</td>
      <td className="pr-3 text-xs whitespace-nowrap text-muted">{lastUsed}</td>
      {/* A revoked key's state takes the slot its Revoke button held. */}
      <td className="pr-4 text-right">
        {revoked ? (
          <Badge>revoked</Badge>
        ) : (
          <Button size="sm" disabled={busy} onClick={run} ariaLabel={`Revoke ${record.prefix}…`}>
            {busy ? <Spinner /> : "Revoke"}
          </Button>
        )}
      </td>
    </tr>
  );
}
