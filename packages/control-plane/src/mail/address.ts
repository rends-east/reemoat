/**
 * What this service will accept as an email address, and how it compares two.
 *
 * **The check is minimal and structural, and the justification is not "is this a
 * valid address".** `src/registry.ts` already states this repository's position
 * on the canonical patterns: they are wrong in both directions, and refusing a
 * string because our regex disagrees refuses an answer somebody meant. RFC 5321
 * permits quoted local parts and address literals that every popular regex
 * rejects, and an address this service refuses is a person who cannot sign up
 * and cannot recover their account.
 *
 * So the rules below are about **what a string can do to the protocol**, not
 * about what an address is. The whole security content is one line: no control
 * characters. `MAIL FROM:<…>` and `To:` are line-oriented, so a CR or LF inside
 * an address is header injection — a `Bcc:` somebody else wrote — and a NUL
 * truncates in whichever layer is least expecting it.
 *
 * Deliberately **not** required, each of which a stricter implementation would
 * have refused and each of which is somebody real:
 *
 *   - a dot in the domain. Self-hosted intranet domains have none, and this is a
 *     self-hosted product.
 *   - a TLD from a list. That list is a network request or a stale copy.
 *   - `+`-tag stripping or Gmail dot-normalization. Those are policies about one
 *     provider, wrong for every other, and the second would silently treat one
 *     person's `a+1@…` and `a+2@…` as the same account.
 */

/** RFC 5321's limit on a forward-path, and this value also goes in a header. */
export const MAX_EMAIL_CHARS = 254;

/**
 * The characters that end or re-open an address inside a header list.
 *
 * `,` and `;` separate addresses, `<` and `>` delimit one, `"` opens a quoted
 * string and `\` escapes out of it. None of them can appear in an address this
 * service will handle, because handling them means implementing the quoting
 * rules that make them safe — and the payoff is a shape of address nobody in
 * this product has.
 */
const STRUCTURAL = new Set([",", ";", "<", ">", '"', "\\"]);

/**
 * One address, compared.
 *
 * **The whole address is lowercased, and that is a uniqueness decision rather
 * than a claim about RFCs.** The RFC says the local part is case-sensitive; no
 * mail system anybody uses actually treats it that way, and if we folded only
 * the domain then `Ada@x` and `ada@x` would be two accounts that receive the
 * same mail — which is a password-reset flow pointing at an address the other
 * account also controls.
 *
 * The address as *typed* is stored beside the folded one and is what a screen
 * shows, so nobody's address is displayed back to them in the wrong case.
 *
 * No NFKC. Unlike a password — which this service both stores and compares — an
 * address is compared against a value somebody else's mail system holds, and
 * normalizing it here would mean sending to a string the sender never typed. No
 * punycode either: a Unicode domain is stored as given, because IDN conversion
 * is a library this repository will not add for it.
 */
export function foldEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export type AddressCheck =
  | { ok: true; address: string; folded: string }
  | { ok: false; message: string };

/**
 * Whether a string may be used as an address, with the sentence if not.
 *
 * Returns the message rather than a boolean because every caller puts it in an
 * error envelope or on a screen, and a shared "that address is not valid" would
 * be the same sentence for six different refusals.
 */
export function checkEmailAddress(raw: unknown): AddressCheck {
  if (typeof raw !== "string") return { ok: false, message: "an email address is required" };
  const address = raw.trim();

  if (address.length === 0) return { ok: false, message: "an email address is required" };
  if (address.length > MAX_EMAIL_CHARS) {
    return { ok: false, message: `an email address may be at most ${MAX_EMAIL_CHARS} characters` };
  }

  // The one rule that is about safety rather than shape. Checked before
  // anything else so the message is about the real problem.
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

  // Exactly one `@`, with something on each side. `lastIndexOf` would admit
  // `a@b@c`, which is a quoted local part we have already refused the quotes for.
  const at = address.indexOf("@");
  if (at < 0 || at !== address.lastIndexOf("@")) {
    return { ok: false, message: "an email address needs exactly one @" };
  }
  if (at === 0) return { ok: false, message: "an email address needs something before the @" };
  if (at === address.length - 1) return { ok: false, message: "an email address needs a domain after the @" };

  return { ok: true, address, folded: foldEmail(address) };
}

/**
 * The domain half of an address that has already been checked.
 *
 * Used for `Message-ID`, which RFC 5322 wants to be globally unique and which
 * receivers score. Takes the folded form, so the caller cannot produce two
 * different message ids for one sender by capitalising differently.
 */
export function domainOf(emailFolded: string): string {
  const at = emailFolded.lastIndexOf("@");
  return at < 0 ? "" : emailFolded.slice(at + 1);
}
