import type { NativeBoot } from "./native";
import type { Me } from "./wire";

/**
 * What this window is, and what a screen may offer about it.
 *
 * **Pure, and a type-only import of the payload**, so `webcheck` drives every row
 * of these tables with no DOM, no shell and no store. The host owns which account
 * a window is (Q1.651); what is left to the page is reading that answer the same
 * way on every screen, which is the one thing three screens reading `NativeBoot`
 * separately would stop doing.
 *
 * Not called `accounts.ts`: that is one letter from `account.ts`, which is about a
 * *credential*, and the two would be misread for each other in every import list.
 *
 * ## The three kinds of window
 *
 * - **`pending`** — nobody has signed in to it yet. First run, or an account being
 *   added. The only kind whose server may still change, because an account *is* a
 *   server and a person, and until the person is known there is no account to
 *   repoint.
 * - **`legacy`** — a sign-in kept from before this computer held accounts, not
 *   yet attributed to anybody. It is on the list, so it can be removed; it names a
 *   server, so the server may not change.
 * - **`account`** — an account. Everything that applies to `legacy` applies here.
 *
 * ⚠ **`account` is read first.** {@link NativeBoot.legacy} is also `true` for an
 * account whose server still has kept items waiting for proof — a sign-in that
 * *is* attributed while the device beside it is not — so reading `legacy` first
 * would call a signed-in account a legacy one.
 */
export type Slot = "pending" | "legacy" | "account";

/** `null` in a browser, where a window is not one of several. */
export function slotOf(boot: NativeBoot | null): Slot | null {
  if (boot === null) return null;
  if (boot.account !== null) return "account";
  return boot.legacy ? "legacy" : "pending";
}

/**
 * The ways off the sign-in screen, beside signing in.
 *
 * Each is a door the host already knows the far side of, and each exists only
 * where that far side does:
 *
 * - **`server`** — ‹ Server, back to the screen that chooses one, whose own ‹
 *   leads back to the account that was on screen. Only a pending window: a listed
 *   account, even a signed-out one, may not repoint its server, because that would
 *   make it a different account wearing the old one's keyring entry, device and
 *   daemon. The host refuses it too (Q5.120); drawing a control it will refuse is
 *   the thing this table exists to stop. ⚠ **And only where there is an account to
 *   return to** — the owner's call, 2026-09-24: a first sign-in has no way back at
 *   all, the server screen having been the step it just confirmed.
 * - **`back`** — ‹ *that account*, from a signed-out account's own sign-in to the
 *   account shown before it. It replaced a Cancel button (the same owner's call:
 *   one kind of way back on these screens, a chevron that names where it goes).
 *   Keyed on the **live** `back` from `host_accounts` and never on the boot
 *   payload: a window lives for the whole session on a desktop, and a snapshot from
 *   its launch would offer no way back after an account was added, and a way back
 *   to one since removed. Never beside `server` — one way back per screen.
 * - **`remove`** — take this account off this computer. Only a listed window: a
 *   pending one is discarded by leaving it, and is not on the list to remove.
 *
 * All three `false` in a browser, and in the gate, which is a browser.
 */
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

/**
 * Whether the host should be asked to prove this window's account again, now.
 *
 * Two reasons, and either is enough. **A kept sign-in nobody has attributed**
 * ({@link NativeBoot.legacy}): the host reads it, asks the control plane whose it
 * is and moves it — and anything whose proof could not be reached is asked again
 * at the next launch, because this stays `true` until it has been. **A name the
 * host has cached that the control plane no longer gives**: the drawer lists every
 * account from that cache without a request per account, so a rename reaches it
 * only through this.
 *
 * Asked with `me` still `null` where the control plane could not be reached: the
 * host's own request will fail the same way and cost one refusal, and a proof owed
 * is not worth deciding *not* to ask about on the page's guess.
 */
export function confirmDue(boot: NativeBoot | null, me: Pick<Me, "name"> | null): boolean {
  if (boot === null) return false;
  if (boot.legacy) return true;
  return boot.account !== null && me !== null && boot.name !== me.name;
}

/**
 * A control plane's origin, drawn under an account's name.
 *
 * ⚠ **Display only — never compared, never sent, never stored.** `native-shell.md`
 * forbids a second normalizer on the page, because two spellings of one origin are
 * two keyring accounts; this is not one. The host's canonical origin goes in, a
 * shorter label for a person comes out, and nothing ever reads the label back.
 *
 * **The scheme is dropped for `https` alone.** `http://x` and `https://x` are
 * different trust boundaries and two accounts on them must not draw the same line
 * under their names, so anything that is not `https` is drawn whole — which is
 * also what a local `pnpm cp` on `http://127.0.0.1:8787` should look like: the
 * address somebody typed. Something that does not parse is drawn as it came.
 */
export function serverLabel(origin: string): string {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" ? url.host : origin;
  } catch {
    // Not a URL at all. The host sent it, so it is what there is to show.
    return origin;
  }
}
