import { domainOf, foldEmail } from "./address.js";

// Pure: date, boundary and messageId are injected, so a driver can assert the bytes.
// Both parts are base64, not quoted-printable: one rule, 7-bit clean, and no body line can begin with a dot.

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
  date: Date;
  boundary: string;
  messageId: string;
}

/** Throws rather than strips: the value is an admin's input, and the throw becomes a recorded delivery failure. */
export function headerSafe(name: string, value: string): string {
  if (/[\r\n\x00]/.test(value)) {
    throw new Error(`${name} may not contain a line break or a NUL`);
  }
  return value;
}

// A 75-character encoded-word minus its 12-character wrapper leaves 60 base64 characters, i.e. 45 bytes.
const ENCODED_WORD_BYTES = 45;

function needsEncoding(value: string): boolean {
  return /[^\x20-\x7e]/.test(value);
}

/** Chunked by code point, never by byte, so no character splits across words. always forces encoding for a name holding a quote. */
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

/** A name holding a double quote or a backslash is encoded rather than escaped into a quoted string. */
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

/** RFC 5322 with a numeric zone; toUTCString ends in GMT, which is the HTTP form. */
export function formatDate(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, "0");
  return (
    `${DAYS[date.getUTCDay()]}, ${two(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:` +
    `${two(date.getUTCSeconds())} +0000`
  );
}

/** The domain is the sender's, never the host name (a random container id under Docker). */
export function formatMessageId(id: string, fromAddress: string): string {
  const domain = domainOf(foldEmail(fromAddress));
  return `<${id}@${domain}>`;
}

function base64Body(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join("\r\n");
}

/** Applied even though a base64 body cannot start a line with a dot, so changing an encoding can never truncate a message. */
export function dotStuff(message: string): string {
  return message.replace(/^\./gm, "..");
}

/** text/plain first: MIME orders alternatives least-preferred first. */
export function buildMessage(input: MessageInput): string {
  const headers: string[] = [
    `From: ${formatAddress(input.from)}`,
    `To: ${headerSafe("To", input.to)}`,
    `Subject: ${encodeWord(headerSafe("Subject", input.subject))}`,
    `Date: ${formatDate(input.date)}`,
    `Message-ID: ${formatMessageId(input.messageId, input.from.address)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${headerSafe("boundary", input.boundary)}"`,
    // Stops an out-of-office reply bouncing back.
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
