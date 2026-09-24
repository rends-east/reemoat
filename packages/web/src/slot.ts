import type { NativeBoot } from "./native";
import type { Me } from "./wire";

export type Slot = "pending" | "legacy" | "account";

/** `account` wins over `legacy`, which is also true for an attributed account awaiting proof. */
export function slotOf(boot: NativeBoot | null): Slot | null {
  if (boot === null) return null;
  if (boot.account !== null) return "account";
  return boot.legacy ? "legacy" : "pending";
}

/** `back` follows the live `host_accounts` answer, not the boot snapshot; the host refuses a server change on a listed account (Q5.120). */
export interface SignInExits {
  server: boolean;
  back: boolean;
  remove: boolean;
}

export function signInExits(boot: NativeBoot | null, back: string | null | undefined): SignInExits {
  const slot = slotOf(boot);
  if (slot === null) return { server: false, back: false, remove: false };
  const elsewhere = typeof back === "string" && back.length > 0;
  return {
    server: slot === "pending" && elsewhere,
    back: slot !== "pending" && elsewhere,
    remove: slot !== "pending",
  };
}

export function confirmDue(boot: NativeBoot | null, me: Pick<Me, "name"> | null): boolean {
  if (boot === null) return false;
  if (boot.legacy) return true;
  return boot.account !== null && me !== null && boot.name !== me.name;
}

/** Display only; only `https` drops its scheme, since http and https are different accounts. */
export function serverLabel(origin: string): string {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" ? url.host : origin;
  } catch {
    return origin;
  }
}
