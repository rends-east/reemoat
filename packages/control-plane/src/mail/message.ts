import { domainOf, foldEmail } from "./address.js";

/**
 * A message as bytes, and nothing else.
 *
 * Pure: no socket, no clock, no randomness that is not injected. `date`,
 * `boundary` and `messageId` are all parameters, so a driver pins them and
 * asserts the output byte for byte — which is the only way the encoding rules
 * below are checkable at all.
 *
 * **Every CRLF inside a *message* is produced here.** The transport adds its
 * own — it terminates each command line and writes the closing `\r\n.\r\n` —
 * but nothing there looks inside the body or folds a header, so the two cannot
 * half-agree about the thing that is hard: where a header ends and how a line
 * that begins with a dot survives. (This used to say "and nowhere else", which
 * `smtp.ts` contradicts twice on any read of it.)
 *
 * **Both parts are base64, not quoted-printable**, and that is the decision in
 * this file most likely to be second-guessed. QP is the nicer-looking answer and
 * it is the wrong one: it has three independently-easy-to-get-wrong rules —
 * trailing whitespace before a CRLF, soft line breaks at 76 columns, and a `.`
 * at the start of a line interacting with dot-stuffing — and every one of them
 * fails *per recipient*, invisibly from here, on somebody else's mail client.
 * base64 has one rule. It also makes the message 7-bit clean, so `8BITMIME`
 * never has to be negotiated with a server that may not offer it, and its
 * alphabet excludes `.`, so no body line can ever begin with one. Dot-stuffing
 * still runs; it simply cannot fire.
 *
 * The cost is that a stored body is unreadable, which is fine and is deliberate
 * one level up: the outbox holds a body in order to send it, and the delivery
 * log shows a subject and never a body.
 */

export interface MessageAddress {
  address: string;
  name: string | null;
}

export interface MessageInput {
  from: MessageAddress;
  to: string;
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  /** Injected so a driver can assert bytes. */
  date: Date;
  boundary: string;
  messageId: string;
}

/**
 * A header value that would end the header.
 *
 * **Throws rather than strips**, and the difference matters: every value that
 * reaches here came from the settings screen or from a template, so a display
 * name carrying a CRLF is an admin's input. Stripping it silently changes what
 * they configured and makes the defence invisible.
 *
 * **Who catches it is the pump, not a route**, and this used to say otherwise.
 * `buildMessage` has one caller — `deliver`, inside `outbox.ts` — so the throw
 * becomes a recorded delivery failure that an admin reads in the log, never a
 * `400` at the moment of typing. `checkSettingValue` is what answers 400, and it
 * is the front door rather than this one: it refuses control characters in every
 * setting on `PUT /v1/admin/settings`. The gap that leaves is the *environment*
 * fallback, which `readSetting` returns without validating — a CR in
 * `REEMOAT_CP_MAIL_FROM_NAME` is caught only here, as eight silent retries per
 * message. That is the honest state; this is the backstop, not the notification.
 */
export function headerSafe(name: string, value: string): string {
  if (/[\r\n\x00]/.test(value)) {
    throw new Error(`${name} may not contain a line break or a NUL`);
  }
  return value;
}

/**
 * The most base64 that fits in one RFC 2047 encoded-word.
 *
 * An encoded-word is capped at 75 characters. `=?UTF-8?B?` is 10 and `?=` is 2,
 * leaving 63 — and base64 output is a multiple of 4, so 60 characters, which is
 * 45 bytes of input.
 */
const ENCODED_WORD_BYTES = 45;

function needsEncoding(value: string): boolean {
  return /[^\x20-\x7e]/.test(value);
}

/**
 * A header value as RFC 2047 encoded-words.
 *
 * **Chunked by code point, never by byte**, and that is the whole reason this is
 * a function rather than one `Buffer.from(v).toString("base64")`. Slicing the
 * UTF-8 *bytes* at 45 splits a multi-byte character across two words, and each
 * word is decoded independently by the receiver — so the result is two invalid
 * sequences and a subject line full of replacement characters. It is the bug
 * everybody ships, it only appears once a subject is long enough to need two
 * words, and it is invisible in every single-word test.
 *
 * Words are joined by CRLF + space, which is the folding RFC 5322 defines and
 * which every receiver un-folds.
 *
 * `always` exists for one caller and is not a convenience: a display name
 * carrying a `"` is pure printable ASCII, so the needs-encoding test says no and
 * the value comes back untouched — straight into a header where the quote ends
 * the quoted string early. `formatAddress` has already decided that value must
 * be encoded, and this is how it says so. Without it the guard one function down
 * reads correctly and does nothing.
 */
export function encodeWord(value: string, always = false): string {
  if (!always && !needsEncoding(value)) return value;

  const words: string[] = [];
  let chunk = "";
  let bytes = 0;

  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > ENCODED_WORD_BYTES) {
      words.push(chunk);
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += width;
  }
  if (chunk.length > 0) words.push(chunk);

  return words.map((part) => `=?UTF-8?B?${Buffer.from(part, "utf8").toString("base64")}?=`).join("\r\n ");
}

/**
 * An address with an optional display name, as one header value.
 *
 * A name that is plain printable ASCII becomes a quoted string, which is safe
 * for the dots and commas people put in their own names. **Anything carrying a
 * `"` or a `\` is encoded instead of quoted**, rather than escaped into the
 * quoted form: escaping is correct and it is one backslash away from being
 * wrong, and the encoded form is already needed for the non-ASCII case, so this
 * is one path rather than two.
 */
export function formatAddress(value: MessageAddress): string {
  const address = headerSafe("address", value.address);
  if (value.name === null || value.name.trim().length === 0) return address;

  const name = headerSafe("display name", value.name);
  if (needsEncoding(name) || name.includes('"') || name.includes("\\")) {
    return `${encodeWord(name, true)} <${address}>`;
  }
  return `"${name}" <${address}>`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * RFC 5322's date, with a numeric zone.
 *
 * Not `toUTCString()`, which ends in `GMT`. That form is RFC 7231's — correct
 * for an HTTP header and merely tolerated here — and the one-word difference
 * makes the header unambiguously the one this document is supposed to emit.
 */
export function formatDate(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, "0");
  return (
    `${DAYS[date.getUTCDay()]}, ${two(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:` +
    `${two(date.getUTCSeconds())} +0000`
  );
}

/**
 * `<hex@domain>`, where the domain is the sender's.
 *
 * **Never `os.hostname()`.** Under Docker that is a random hex container id: it
 * leaks the deployment shape into every message, changes on every restart so
 * nothing threads, and some receivers score it.
 */
export function formatMessageId(id: string, fromAddress: string): string {
  const domain = domainOf(foldEmail(fromAddress));
  return `<${id}@${domain}>`;
}

/** base64 wrapped at 76 columns, which is what a MIME body part wants. */
function base64Body(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join("\r\n");
}

/**
 * SMTP's transparency rule: a line that begins with `.` gets another one.
 *
 * Kept and applied even though a base64 body cannot produce such a line, for
 * two reasons: the rule belongs to the format rather than to today's encoding
 * choice, and the day somebody switches a part to quoted-printable this is
 * already right. It is cheap, and its absence would be a silently truncated
 * message.
 */
export function dotStuff(message: string): string {
  return message.replace(/^\./gm, "..");
}

/**
 * The whole message: headers, then a `multipart/alternative` body.
 *
 * `text/plain` comes first because MIME orders alternatives least-preferred
 * first, and a client that shows the last part it understands is the common one.
 */
export function buildMessage(input: MessageInput): string {
  const headers: string[] = [
    `From: ${formatAddress(input.from)}`,
    `To: ${headerSafe("To", input.to)}`,
    `Subject: ${encodeWord(headerSafe("Subject", input.subject))}`,
    `Date: ${formatDate(input.date)}`,
    `Message-ID: ${formatMessageId(input.messageId, input.from.address)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${headerSafe("boundary", input.boundary)}"`,
    // Nothing here is auto-replied to, and saying so is what stops an
    // out-of-office bouncing back into a mailbox nobody reads.
    "Auto-Submitted: auto-generated",
  ];

  if (input.replyTo !== null && input.replyTo.trim().length > 0) {
    headers.splice(2, 0, `Reply-To: ${headerSafe("Reply-To", input.replyTo)}`);
  }

  const body = [
    `--${input.boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(input.text),
    "",
    `--${input.boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(input.html),
    "",
    `--${input.boundary}--`,
    "",
  ];

  return [...headers, "", ...body].join("\r\n");
}
