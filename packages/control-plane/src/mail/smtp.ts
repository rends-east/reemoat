import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import { dotStuff } from "./message.js";

// Every step is bounded and every reply size-capped: this process also carries the API and every relay tunnel, and smtp.host is admin-supplied.

export interface SmtpConnection {
  readonly stream: Duplex;
  /** `null` means the connection cannot be upgraded: a value rather than a throw, so it is never mistaken for a network error. */
  startTls(options: { servername: string; rejectUnauthorized: boolean }): Promise<Duplex | null>;
  close(): void;
}

export interface DialTarget {
  host: string;
  port: number;
  implicitTls: boolean;
  servername: string;
  rejectUnauthorized: boolean;
  timeoutMs: number;
}

export interface SmtpDialer {
  connect(target: DialTarget): Promise<SmtpConnection>;
}

export type SmtpStep =
  | "connect"
  | "greeting"
  | "ehlo"
  | "starttls"
  | "auth"
  | "mail_from"
  | "rcpt_to"
  | "data"
  | "body"
  | "quit";

const MAX_REPLY_TEXT = 300;

/** Bounds a step with no read behind it (the TLS handshake), which neither the reply timer nor `total` can see; onTimeout destroys the socket first. */
async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  step: SmtpStep,
  what: string,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new SmtpError(step, `${what} within ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class SmtpError extends Error {
  readonly step: SmtpStep;
  readonly code: number | null;
  readonly reply: string | null;
  /** 5xx is permanent; 4xx and every transport failure are not. */
  readonly permanent: boolean;

  constructor(step: SmtpStep, message: string, code: number | null = null, reply: string | null = null) {
    super(message);
    this.name = "SmtpError";
    this.step = step;
    this.code = code;
    this.reply = reply === null ? null : sanitizeReply(reply);
    this.permanent = code !== null && code >= 500 && code < 600;
  }
}

/** CR and LF go because this lands in mail_outbox.last_error, which an admin screen draws unescaped. */
export function sanitizeReply(raw: string): string {
  const flat = raw.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
  return flat.length > MAX_REPLY_TEXT ? `${flat.slice(0, MAX_REPLY_TEXT)}…` : flat;
}

/** RFC 5321 §4.5.3.1.5: a reply line, including CRLF. */
const MAX_REPLY_LINE = 1000;
const MAX_REPLY_TOTAL = 64 * 1024;

/** Far below RFC 5321's: this process is also the only way anybody reaches their machines. `total` caps the whole message. */
export const SMTP_TIMEOUTS = {
  connect: 10_000,
  greeting: 10_000,
  ehlo: 10_000,
  starttls: 10_000,
  handshake: 10_000,
  auth: 10_000,
  envelope: 10_000,
  data: 10_000,
  body: 30_000,
  dot: 60_000,
  quit: 5_000,
  total: 90_000,
} as const;

interface Reply {
  code: number;
  lines: string[];
}

/** A hyphen after the code continues a multiline reply and a space ends it; matching on the code alone hangs. */
class ReplyReader {
  private buffer = "";
  private closed = false;
  private failure: Error | null = null;
  private waiter: (() => void) | null = null;
  private stream: Duplex | null = null;
  private handlers: { data: (chunk: string) => void; failed: (error: Error) => void; ended: () => void } | null = null;

  constructor(stream: Duplex) {
    this.attach(stream);
  }

  /** Clears the buffer: bytes from before the upgrade belong to the cleartext conversation. */
  adopt(stream: Duplex): void {
    this.release();
    this.buffer = "";
    this.closed = false;
    this.failure = null;
    this.attach(stream);
  }

  /** Call before startTls: a still-attached cleartext reader races the handshake and later misreports a close. The error listener is replaced, never removed. */
  release(): void {
    const stream = this.stream;
    const handlers = this.handlers;
    this.stream = null;
    this.handlers = null;
    if (stream === null || handlers === null) return;
    stream.removeListener("data", handlers.data);
    stream.removeListener("error", handlers.failed);
    stream.removeListener("close", handlers.ended);
    stream.removeListener("end", handlers.ended);
    stream.on("error", () => {
      // Swallowed on purpose: a socket with no error listener throws an uncaught exception.
    });
    stream.pause();
  }

  private attach(stream: Duplex): void {
    stream.setEncoding("utf8");
    const data = (chunk: string): void => {
      this.buffer += chunk;
      this.wake();
    };
    const failed = (error: Error): void => {
      this.failure = error;
      this.wake();
    };
    const ended = (): void => {
      this.closed = true;
      this.wake();
    };
    stream.on("data", data);
    stream.on("error", failed);
    stream.on("close", ended);
    stream.on("end", ended);
    this.stream = stream;
    this.handlers = { data, failed, ended };
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  async read(step: SmtpStep, timeoutMs: number): Promise<Reply> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const parsed = this.take(step);
      if (parsed !== null) return parsed;
      if (this.failure !== null) {
        throw new SmtpError(step, `the connection failed: ${this.failure.message}`);
      }
      if (this.closed) {
        throw new SmtpError(step, "the server closed the connection without replying");
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new SmtpError(step, `the server did not reply within ${timeoutMs}ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          resolve();
        }, left);
        this.waiter = (): void => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  private take(step: SmtpStep): Reply | null {
    if (this.buffer.length > MAX_REPLY_TOTAL) {
      throw new SmtpError(step, `the server sent more than ${MAX_REPLY_TOTAL} bytes in one reply`);
    }
    const lines: string[] = [];
    let cursor = 0;
    for (;;) {
      const end = this.buffer.indexOf("\r\n", cursor);
      // A bare LF is accepted on the way in and never produced on the way out.
      const bare = this.buffer.indexOf("\n", cursor);
      const at = end >= 0 ? end : bare;
      if (at < 0) {
        if (this.buffer.length - cursor > MAX_REPLY_LINE) {
          throw new SmtpError(step, `the server sent a reply line longer than ${MAX_REPLY_LINE} bytes`);
        }
        return null;
      }
      const line = this.buffer.slice(cursor, at).replace(/\r$/, "");
      if (line.length > MAX_REPLY_LINE) {
        throw new SmtpError(step, `the server sent a reply line longer than ${MAX_REPLY_LINE} bytes`);
      }
      cursor = at + (at === end ? 2 : 1);
      lines.push(line);

      const match = /^(\d{3})([ -]?)/.exec(line);
      if (match === null) {
        throw new SmtpError(step, `the server sent something that is not an SMTP reply: ${sanitizeReply(line)}`);
      }
      if (match[2] !== "-") {
        this.buffer = this.buffer.slice(cursor);
        return { code: Number.parseInt(match[1] ?? "0", 10), lines };
      }
    }
  }
}

export interface SmtpClientOptions {
  host: string;
  port: number;
  security: "implicit_tls" | "starttls" | "plaintext";
  auth: "plain" | "login" | "none";
  username: string | null;
  password: string | null;
  rejectUnauthorized: boolean;
  ehloName: string;
  dialer: SmtpDialer;
  /** A Record rather than a Partial of SMTP_TIMEOUTS: that object is as const, so its field types are its default literals. */
  timeouts?: Partial<Record<keyof typeof SMTP_TIMEOUTS, number>>;
}

export interface Envelope {
  from: string;
  to: string;
  message: string;
}

/** An address literal without mail.public_url; never os.hostname, which under Docker is a random container id. */
export function ehloNameFor(publicUrl: string | null): string {
  if (publicUrl === null) return "[127.0.0.1]";
  try {
    const host = new URL(publicUrl).hostname;
    return host.length > 0 ? host : "[127.0.0.1]";
  } catch {
    return "[127.0.0.1]";
  }
}

function capabilitiesOf(reply: Reply): Set<string> {
  return new Set(reply.lines.slice(1).map((line) => line.slice(4).trim().toUpperCase()));
}

function supportsAuth(capabilities: Set<string>, mechanism: string): boolean {
  for (const capability of capabilities) {
    if (capability === "AUTH" || capability.startsWith("AUTH ")) {
      return capability.slice(4).split(/\s+/).includes(mechanism);
    }
  }
  return false;
}

/** One message on one connection; every failure carries the step, the code and the server's first line. */
export async function sendMessage(options: SmtpClientOptions, envelope: Envelope): Promise<void> {
  const timeouts = { ...SMTP_TIMEOUTS, ...options.timeouts };
  const deadline = Date.now() + timeouts.total;

  const budget = (step: SmtpStep, want: number): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new SmtpError(step, `sending took longer than ${timeouts.total}ms`);
    return Math.min(want, left);
  };

  let connection: SmtpConnection;
  try {
    connection = await options.dialer.connect({
      host: options.host,
      port: options.port,
      implicitTls: options.security === "implicit_tls",
      servername: options.host,
      rejectUnauthorized: options.rejectUnauthorized,
      timeoutMs: budget("connect", timeouts.connect),
    });
  } catch (error) {
    if (error instanceof SmtpError) throw error;
    throw new SmtpError("connect", `could not reach ${options.host}:${options.port}: ${describe(error)}`);
  }

  let stream = connection.stream;
  const reader = new ReplyReader(stream);

  const write = (line: string): void => {
    stream.write(`${line}\r\n`);
  };

  const expect = async (step: SmtpStep, want: number, timeoutMs: number): Promise<Reply> => {
    const reply = await reader.read(step, budget(step, timeoutMs));
    if (Math.floor(reply.code / 100) !== Math.floor(want / 100)) {
      throw new SmtpError(
        step,
        `the server refused at ${step}: ${sanitizeReply(reply.lines[0] ?? "")}`,
        reply.code,
        reply.lines[0] ?? "",
      );
    }
    return reply;
  };

  try {
    await expect("greeting", 200, timeouts.greeting);

    write(`EHLO ${options.ehloName}`);
    let capabilities = capabilitiesOf(await expect("ehlo", 200, timeouts.ehlo));

    if (options.security === "starttls") {
      // The downgrade defence: stop before AUTH and MAIL FROM, so nothing is disclosed in the clear.
      if (!capabilities.has("STARTTLS")) {
        throw new SmtpError("starttls", `${options.host} does not offer STARTTLS, and this is configured to require it`);
      }
      write("STARTTLS");
      await expect("starttls", 200, timeouts.starttls);

      reader.release();

      const upgraded = await withDeadline(
        connection.startTls({
          servername: options.host,
          rejectUnauthorized: options.rejectUnauthorized,
        }),
        budget("starttls", timeouts.handshake),
        "starttls",
        `the TLS handshake with ${options.host} did not complete`,
        () => connection.close(),
      );
      if (upgraded === null) {
        throw new SmtpError("starttls", "the connection could not be upgraded to TLS");
      }
      stream = upgraded;
      reader.adopt(stream);

      // The second EHLO wins: servers often advertise AUTH only once the connection is encrypted.
      write(`EHLO ${options.ehloName}`);
      capabilities = capabilitiesOf(await expect("ehlo", 200, timeouts.ehlo));
    }

    if (options.auth !== "none" && options.username !== null && options.password !== null) {
      // No password in the clear: plaintext is for a loopback MTA that needs none.
      if (options.security === "plaintext") {
        throw new SmtpError("auth", "refusing to send a password over an unencrypted connection");
      }
      const mechanism = options.auth === "login" ? "LOGIN" : "PLAIN";
      if (capabilities.size > 0 && !supportsAuth(capabilities, mechanism)) {
        throw new SmtpError("auth", `${options.host} does not offer AUTH ${mechanism}`);
      }

      if (mechanism === "PLAIN") {
        const token = Buffer.from(`\0${options.username}\0${options.password}`, "utf8").toString("base64");
        write(`AUTH PLAIN ${token}`);
        await expect("auth", 200, timeouts.auth);
      } else {
        write("AUTH LOGIN");
        await expect("auth", 300, timeouts.auth);
        write(Buffer.from(options.username, "utf8").toString("base64"));
        await expect("auth", 300, timeouts.auth);
        write(Buffer.from(options.password, "utf8").toString("base64"));
        await expect("auth", 200, timeouts.auth);
      }
    }

    write(`MAIL FROM:<${envelope.from}>`);
    await expect("mail_from", 200, timeouts.envelope);

    write(`RCPT TO:<${envelope.to}>`);
    await expect("rcpt_to", 200, timeouts.envelope);

    write("DATA");
    await expect("data", 300, timeouts.data);

    stream.write(dotStuff(envelope.message));
    stream.write("\r\n.\r\n");
    await expect("body", 200, timeouts.dot);
  } catch (error) {
    connection.close();
    throw error instanceof SmtpError ? error : new SmtpError("body", describe(error));
  }

  // Best-effort and outside the try: the message was delivered at the 250, and a retry would double-send.
  try {
    write("QUIT");
    await reader.read("quit", Math.max(0, Math.min(timeouts.quit, deadline - Date.now())));
  } catch {
    // Delivered. Nothing to report and nothing to retry.
  }
  connection.close();
}

/** Kept here rather than importing describeError: nothing under mail/ imports from the repo-root src/. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** No SNI for an IP host: Node refuses an IP servername, and certificate checks still use the IP SANs. */
function sniFor(host: string): string | undefined {
  return isIP(host) === 0 ? host : undefined;
}

export function socketDialer(): SmtpDialer {
  return {
    connect(target: DialTarget): Promise<SmtpConnection> {
      return new Promise<SmtpConnection>((resolve, reject) => {
        const socket = target.implicitTls
          ? tlsConnect({
              host: target.host,
              port: target.port,
              servername: sniFor(target.servername),
              rejectUnauthorized: target.rejectUnauthorized,
            })
          : netConnect({ host: target.host, port: target.port });

        // node:net has no default socket timeout; cleared once connected, and the step budgets take over.
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new SmtpError("connect", `no answer from ${target.host}:${target.port} within ${target.timeoutMs}ms`));
        }, target.timeoutMs);
        timer.unref?.();

        const settled = (): void => {
          clearTimeout(timer);
          socket.removeListener("error", onError);
        };
        const onError = (error: Error): void => {
          settled();
          reject(new SmtpError("connect", `could not reach ${target.host}:${target.port}: ${error.message}`));
        };

        socket.once("error", onError);
        socket.once(target.implicitTls ? "secureConnect" : "connect", () => {
          settled();
          resolve({
            stream: socket,
            async startTls(options) {
              return await new Promise<Duplex | null>((resolveTls, rejectTls) => {
                const upgraded = tlsConnect(
                  {
                    socket,
                    servername: sniFor(options.servername),
                    rejectUnauthorized: options.rejectUnauthorized,
                  },
                  () => resolveTls(upgraded),
                );
                upgraded.once("error", (error: Error) =>
                  rejectTls(new SmtpError("starttls", `TLS failed: ${error.message}`)),
                );
              });
            },
            close(): void {
              socket.destroy();
            },
          });
        });
      });
    },
  };
}
