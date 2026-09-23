import { useEffect, useState } from "react";
import { nativeAccounts } from "../native";
import { serverLabel } from "../slot";

/**
 * The account a way back leads to: the key only the host reads, and what the
 * control says — `‹ admin`, the way `‹ Server` names its own far side. The name the
 * host cached, or the server where it never learned one (a legacy entry).
 */
export interface BackAccount {
  key: string;
  label: string;
}

/**
 * The account this computer showed before this window's, asked of the host when
 * the screen that offers a way back to it is drawn.
 *
 * ⚠ **Live, on every mount, and never out of the boot payload.** A window lives
 * for the whole session on a desktop — every account's page is created at launch
 * and kept — so a snapshot taken then would offer no way back after an account was
 * added, and a way back to one removed since. The host's list is one IPC and reads
 * no keyring, so asking again costs nothing a person can notice.
 *
 * Three answers, and the third is why this is not a boolean:
 *
 *   - an account — somewhere to go back to, its key for the host and its name
 *     for the control;
 *   - `null` — nowhere: the only account here, a browser, or a host that did not
 *     answer, which is the same *nothing to offer*;
 *   - `undefined` — not answered yet. A screen whose whole shape changes on the
 *     answer (`ChooseServer`'s welcome against its *Add account*) waits for it
 *     rather than drawing the wrong one for a frame; a screen that only gains a
 *     button treats it as `null`.
 *
 * **Store-free, and that is a property.** `SignIn` is drawn by the gate bundle as
 * well as the app, and the gate may not reach `store.ts`; this reaches `native.ts`,
 * which answers `null` in a browser before anything is drawn from it, and the pure
 * `slot.ts` for a label.
 */
export function useBackAccount(): BackAccount | null | undefined {
  const [back, setBack] = useState<BackAccount | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void nativeAccounts().then((list) => {
      if (!live) return;
      const found = list?.accounts.find((account) => account.key === list.back) ?? null;
      setBack(found === null ? null : { key: found.key, label: found.name ?? serverLabel(found.origin) });
    });
    return () => {
      live = false;
    };
  }, []);
  return back;
}
