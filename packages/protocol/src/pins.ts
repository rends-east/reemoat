// The key a machine was first reached with (Q1.657): the server names one on every mint and is believed once. One copy for
// every initiator, the app's and a script's, so the rule cannot drift between them.

/** A machine key as every end spells it: 32 bytes, unpadded URL-safe base64. Anything else is no key. */
export function readMachineKey(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export type OfferedKey =
  /** Nothing to connect with: the machine never announced a key and this device holds none for it. */
  | { kind: "none" }
  | { kind: "use"; key: string; pin: boolean }
  /** The server now names another key. The held one is still the one to dial with, and `offered` waits on a person. */
  | { kind: "changed"; key: string; offered: string };

/** What to dial with, given what this device holds and what the server just named. Pure, so every pair of the two is driven. */
export function weighOfferedKey(pinned: string | null, offered: string | null): OfferedKey {
  if (pinned === null) return offered === null ? { kind: "none" } : { kind: "use", key: offered, pin: true };
  if (offered === null || offered === pinned) return { kind: "use", key: pinned, pin: false };
  return { kind: "changed", key: pinned, offered };
}
