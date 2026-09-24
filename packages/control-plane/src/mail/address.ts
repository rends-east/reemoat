// Structural checks only: refuse what a string can do to the protocol (a control character is header injection), never what an address is.

export const MAX_EMAIL_CHARS = 254;

// The characters that end or re-open an address in a header list: refused rather than quoted.
const STRUCTURAL = new Set([",", ";", "<", ">", '"', "\\"]);

/** The whole address is lowercased, so two accounts cannot share one mailbox by case. No NFKC and no punycode. */
export function foldEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export type AddressCheck =
  | { ok: true; address: string; folded: string }
  | { ok: false; message: string };

export function checkEmailAddress(raw: unknown): AddressCheck {
  if (typeof raw !== "string") return { ok: false, message: "an email address is required" };
  const address = raw.trim();

  if (address.length === 0) return { ok: false, message: "an email address is required" };
  if (address.length > MAX_EMAIL_CHARS) {
    return { ok: false, message: `an email address may be at most ${MAX_EMAIL_CHARS} characters` };
  }

  if (/[\x00-\x1f\x7f]/.test(address)) {
    return { ok: false, message: "an email address may not contain control characters" };
  }
  if (/\s/.test(address)) {
    return { ok: false, message: "an email address may not contain spaces" };
  }
  for (const character of address) {
    if (STRUCTURAL.has(character)) {
      return { ok: false, message: `an email address may not contain ${character}` };
    }
  }

  // Exactly one @; a second would be a quoted local part, and quotes are already refused.
  const at = address.indexOf("@");
  if (at < 0 || at !== address.lastIndexOf("@")) {
    return { ok: false, message: "an email address needs exactly one @" };
  }
  if (at === 0) return { ok: false, message: "an email address needs something before the @" };
  if (at === address.length - 1) return { ok: false, message: "an email address needs a domain after the @" };

  return { ok: true, address, folded: foldEmail(address) };
}

export function domainOf(emailFolded: string): string {
  const at = emailFolded.lastIndexOf("@");
  return at < 0 ? "" : emailFolded.slice(at + 1);
}
