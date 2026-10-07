import type { ReactNode } from "react";
import type { NativeAccountSummary } from "../native";
import { serverLabel } from "../slot";
import { Monogram, personEmoji } from "./bits";

/** `MenuDrawer`'s `DRAWER_ROW`, written twice and compared by `webcheck`, which reads the drawer's own off its file by name. */
export const ACCOUNT_ROW = "tap flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-sm";

export function AccountLines({ account }: { account: NativeAccountSummary }): ReactNode {
  return (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{account.name ?? serverLabel(account.origin)}</span>
        {account.name !== null && (
          <span className="block truncate font-mono text-2xs text-muted">{serverLabel(account.origin)}</span>
        )}
      </span>
      {!account.signedIn && <span className="shrink-0 text-2xs text-faint">signed out</span>}
    </>
  );
}

/** Another account as a way to it: the drawer's row, wherever a screen has to offer the way itself. */
export function AccountRow({
  account,
  onPick,
  disabled = false,
}: {
  account: NativeAccountSummary;
  onPick: () => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      className={`${ACCOUNT_ROW} text-fg hover:bg-raised disabled:text-faint`}
    >
      <Monogram name={account.name} glyph={personEmoji(account.name)} size="row" className="bg-raised" />
      <AccountLines account={account} />
    </button>
  );
}
