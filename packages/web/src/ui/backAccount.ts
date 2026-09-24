import { useEffect, useState } from "react";
import { nativeAccounts } from "../native";
import { serverLabel } from "../slot";

/** `label` is the host's cached name, or the server for a legacy entry. */
export interface BackAccount {
  key: string;
  label: string;
}

/**
 * Asked of the host on every mount, never from the boot payload: `undefined` is unanswered, `null` is nowhere to go back to.
 * Store-free, since the gate bundle draws `SignIn` too.
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
