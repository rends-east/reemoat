import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import { dotStuff } from "./message.js";

/**
 * An SMTP client, and the seam that makes it drivable without a mail server.
 *
 * **This is the first outbound connection this service has ever made.** The
 * process holding it also carries the API listener, `serveStatic`, and every
 * relay tunnel in the fleet, which is why every step below is bounded and why
 * the pump above this file runs exactly one send at a time.
 *
 * ## The seam
 *
 * `sendMessage` takes an {@link SmtpDialer} rather than opening a socket, for
 * the reason `AcpClient` takes an `AgentProcess` rather than spawning: it is the
 * only way a driver can reach the interesting states. Three properties are
 * otherwise unassertable, and each is a real failure somebody ships:
 *
 *   1. **No silent downgrade.** With `security: "starttls"` against a server
 *      that does not advertise it, this fails — and a driver can prove that
 *      *no `AUTH` and no `MAIL FROM` were ever written*. Asserting only that it
 *      throws passes even when the credentials went out in the clear first.
 *   2. **The second `EHLO` wins.** Servers routinely advertise `AUTH` only after
 *      TLS, so the capability list from before the upgrade must be discarded. A
 *      client that caches the first list works against every server that
 *      advertises `AUTH` twice and fails against the ones that do not.
 *   3. **Ordering.** A fake records the sequence of writes and of `startTls`
 *      calls, so `STARTTLS → upgrade → EHLO → AUTH` is asserted as an order
 *      rather than as a set.
 *
 * `startTls` is a method on the *connection* rather than a second dialer call
 * because the real implementation is `tls.connect({ socket, … })` and needs the
 * underlying socket. Handing that back out through the interface would leak
 * `node:net` into the seam and make a `PassThrough` fake implement something it
 * does not have.
 *
 * ## What this deliberately does not do
 *
 * No pooling and no pipelining: this service sends a handful of messages a day,
 * and a pooled connection is state held on the event loop that carries every
 * tunnel, whose failure mode — a half-dead socket discovered at send time —
 * costs somebody their password reset. No CRAM-MD5 (it needs the server to hold
 * the plaintext password) and no XOAUTH2 (that is a provider abstraction, and
 * this file's whole scope decision was not to grow one). No DKIM: a key, a
 * selector, DNS, and two canonicalization algorithms is a second system.
 *
 * ## The host is admin-supplied
 *
 * `smtp.host` comes from the settings screen, so this dials wherever an admin
 * says — `169.254.169.254`, a loopback port, a container address. That is
 * accepted rather than defended against: an admin can already read the fleet
 * signing key out of the volume. What follows from it is that **every reply is
 * bounded** (a line at RFC 5321's 1000 octets, the whole reply at 64 KiB), so an
 * HTTP server streaming a megabyte is not a memory bug reachable from a settings
 * form, and that error text is truncated and stripped of CR/LF before it can
 * reach a response body or the delivery log.
 */

/* ------------------------------------------------------------------ *
 * The seam
 * ------------------------------------------------------------------ */

export interface SmtpConnection {
  readonly stream: Duplex;
  /**
   * Upgrade in place, returning the stream to talk on afterwards.
   *
   * `null` means this connection cannot be upgraded — which is what a
   * plaintext-only fake answers, and what makes the refusal a *value* rather
   * than a throw the client would have to tell apart from a network error.
   */
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

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

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

/** How much of a server's own words to carry back. */
const MAX_REPLY_TEXT = 300;

/**
 * Bound a step that is not a read.
 *
 * **Every other await in `sendMessage` polices itself, and this is why that is
 * not enough.** `ReplyReader.read` carries its own timer, and the whole-message
 * `total` budget is consulted inside `budget()` — which runs only when the next
 * read is *set up*. A step that never reaches another read is therefore outside
 * both: nothing re-checks `total` on its behalf, and there is no reply timer to
 * fire. The TLS handshake is the one such step, and left unbounded it does not
 * merely stall a message — `outbox.ts` clears its `running` flag in a `finally`,
 * so an await that never settles retires the fleet's only mail pump for the life
 * of the process, silently.
 *
 * `onTimeout` runs **before** the rejection so the socket is destroyed rather
 * than leaked; with the real dialer that is also what makes the abandoned
 * handshake promise settle instead of being pinned for ever.
 *
 * The timer is deliberately not `unref`'d, for `ReplyReader.read`'s reason: a
 * send in flight is work this process is doing.
 */
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
  /** The SMTP reply code, or `null` when there was no reply at all. */
  readonly code: number | null;
  /** The first reply line, truncated and stripped of CR/LF. */
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

/**
 * A server's words, made safe to store and to render.
 *
 * CR and LF go because this string lands in `mail_outbox.last_error`, which an
 * admin screen draws and which nothing else escapes; a newline there is a log
 * entry somebody else wrote.
 */
export function sanitizeReply(raw: string): string {
  const flat = raw.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "").trim();
  return flat.length > MAX_REPLY_TEXT ? `${flat.slice(0, MAX_REPLY_TEXT)}…` : flat;
}

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/** RFC 5321 §4.5.3.1.5: a reply line, including CRLF. */
const MAX_REPLY_LINE = 1000;
/** Everything one command may be answered with, before this gives up. */
const MAX_REPLY_TOTAL = 64 * 1024;

/**
 * Per-step budgets, far below RFC 5321 §4.5.3.2's.
 *
 * The RFC allows ten minutes for the final dot. That is a reasonable number for
 * a mail server whose whole job is mail, and an unreasonable one for a process
 * that is also the only way anybody reaches their machines. `TOTAL_MS` bounds
 * the whole message on top, so a server that answers every step just fast enough
 * cannot hold the single pump slot indefinitely.
 */
export const SMTP_TIMEOUTS = {
  connect: 10_000,
  greeting: 10_000,
  ehlo: 10_000,
  starttls: 10_000,
  /*
   * The TLS handshake, which is **not** the `starttls` reply.
   *
   * `starttls` bounds waiting for the server's `220`; this bounds the negotiation
   * that follows it, and it is a separate number because it is the one step here
   * with no `read` behind it. Every other budget is enforced by `ReplyReader`
   * asking for bytes, and `total` is only ever re-checked *at* a read — so a
   * handshake that stalls is a step no existing ceiling can see.
   */
  handshake: 10_000,
  auth: 10_000,
  envelope: 10_000,
  data: 10_000,
  body: 30_000,
  dot: 60_000,
  quit: 5_000,
  total: 90_000,
} as const;

/* ------------------------------------------------------------------ *
 * The reply reader
 * ------------------------------------------------------------------ */

interface Reply {
  code: number;
  lines: string[];
}

/**
 * Reads one SMTP reply off a stream.
 *
 * Multiline handling is the whole of it: continuation lines are `250-`, the last
 * is `250` with a **space**. That one character is the terminator, and matching
 * on the code alone hangs for ever against any server that advertises
 * capabilities.
 */
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

  /**
   * Re-point at the upgraded stream after STARTTLS, carrying nothing over.
   *
   * The buffer is cleared rather than kept, and that is the point: anything the
   * server sent before the upgrade belongs to the cleartext conversation and
   * must not be read as part of the encrypted one. This is the read side of the
   * same rule the second `EHLO` is the write side of.
   */
  adopt(stream: Duplex): void {
    this.release();
    this.buffer = "";
    this.closed = false;
    this.failure = null;
    this.attach(stream);
  }

  /**
   * Stop reading the stream this reader is on, without adopting another yet.
   *
   * **Called before `startTls`, and the ordering is the point.** Left attached,
   * the cleartext socket keeps a `data` handler competing with the TLS layer for
   * the handshake bytes — and, worse, its `close` fires once the upgrade takes
   * the handle over and sets `closed` on a reader that is by then reading the
   * *encrypted* stream, so the next `read` reports "the server closed the
   * connection without replying" about a connection that is fine.
   *
   * The `error` listener is replaced rather than simply removed. `node:net`
   * emits `error` on a socket with no listener as an **uncaught exception**, and
   * this process holds every relay tunnel in the fleet; after the upgrade the
   * TLS socket surfaces the same failure through its own handler, so the raw
   * one has nothing left to say and swallowing it is the whole intent.
   */
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
      // Swallowed on purpose: see the docblock. Never left with zero listeners.
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
      /*
       * One timer racing one wake-up, rather than a poll.
       *
       * The timer is deliberately **not** `unref`'d. A send in flight is work
       * this process is doing, and an unreferenced timer stops keeping the loop
       * alive — so against a server that accepts the connection and then says
       * nothing, the timeout never fires and the await never settles. It is
       * bounded by the step budget, which is bounded by `total`, so the longest
       * it can hold anything is one message.
       */
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

  /** A complete reply, or `null` if more bytes are needed. Throws on garbage. */
  private take(step: SmtpStep): Reply | null {
    if (this.buffer.length > MAX_REPLY_TOTAL) {
      throw new SmtpError(step, `the server sent more than ${MAX_REPLY_TOTAL} bytes in one reply`);
    }
    const lines: string[] = [];
    let cursor = 0;
    for (;;) {
      const end = this.buffer.indexOf("\r\n", cursor);
      // Some servers (and every hand-rolled fake) send a bare LF. Accepted on
      // the way in and never produced on the way out — the ordinary robustness
      // rule, and refusing it would fail against real servers for nothing.
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
      // A space (or nothing after the code) terminates; a hyphen continues.
      if (match[2] !== "-") {
        this.buffer = this.buffer.slice(cursor);
        return { code: Number.parseInt(match[1] ?? "0", 10), lines };
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * The client
 * ------------------------------------------------------------------ */

export interface SmtpClientOptions {
  host: string;
  port: number;
  security: "implicit_tls" | "starttls" | "plaintext";
  auth: "plain" | "login" | "none";
  username: string | null;
  password: string | null;
  rejectUnauthorized: boolean;
  /** What to say in EHLO. Never `os.hostname()`; see below. */
  ehloName: string;
  dialer: SmtpDialer;
  /**
   * Per-step overrides, in milliseconds.
   *
   * `Record<…, number>` and **not** `Partial<typeof SMTP_TIMEOUTS>`: that object
   * is `as const`, so each field's declared type is its own default literal and
   * `{handshake: 50}` was a type error. The seam exists so a driver can make a
   * timeout fire in fifty milliseconds instead of ten seconds, and the one
   * override it was written for did not compile — which a driver can only work
   * around with a cast, i.e. by giving up the checking this type is for.
   */
  timeouts?: Partial<Record<keyof typeof SMTP_TIMEOUTS, number>>;
}

export interface Envelope {
  from: string;
  to: string;
  /** The full RFC 5322 message, exactly as `buildMessage` produced it. */
  message: string;
}

/**
 * What to send as the EHLO argument.
 *
 * RFC 5321 says to send an address literal when there is no FQDN, and that is
 * what an operator who has not set `mail.public_url` gets. **Never
 * `os.hostname()`**: under Docker it is a random hex container id, which some
 * servers refuse outright and all of them log.
 */
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
  // The first line is the greeting text; the rest are capabilities. Upper-cased
  // because RFC 5321 says keywords are case-insensitive and servers disagree
  // about which case they use.
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

/**
 * Send one message, on one connection, and close it.
 *
 * Every `expect` failure carries the step, the code and the server's own first
 * line, because "could not send mail" is a support ticket and
 * `535 5.7.8 Username and Password not accepted` is an answer.
 */
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
      // **The downgrade defence.** If the server does not offer STARTTLS this
      // stops here, before AUTH and before MAIL FROM, so no credential and no
      // recipient has been disclosed on a cleartext connection.
      if (!capabilities.has("STARTTLS")) {
        throw new SmtpError("starttls", `${options.host} does not offer STARTTLS, and this is configured to require it`);
      }
      write("STARTTLS");
      await expect("starttls", 200, timeouts.starttls);

      // Let go of the cleartext socket *before* the TLS layer takes its handle
      // over. `ReplyReader.release` is where the two reasons are written down.
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

      // **The second EHLO wins, and the first list is discarded.** Servers
      // routinely advertise AUTH only once the connection is encrypted, so
      // reusing the pre-TLS capabilities means never authenticating against
      // exactly the servers that were careful.
      write(`EHLO ${options.ehloName}`);
      capabilities = capabilitiesOf(await expect("ehlo", 200, timeouts.ehlo));
    }

    if (options.auth !== "none" && options.username !== null && options.password !== null) {
      // Refused in the clear. `plaintext` is for a loopback dev MTA, which needs
      // no credential; somebody who configures both has said something
      // contradictory and this is where it is caught rather than on the wire.
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

  /*
   * **QUIT is best-effort and is never fatal.**
   *
   * The message is delivered the moment the server answers 250 to the final
   * dot; everything after that is politeness. Treating a QUIT failure as a send
   * failure means the outbox retries a message the server already accepted, and
   * somebody gets two password-reset links. This is the one place a careful
   * implementation double-sends, which is why it is outside the try above.
   */
  try {
    write("QUIT");
    await reader.read("quit", Math.max(0, Math.min(timeouts.quit, deadline - Date.now())));
  } catch {
    // Delivered. Nothing to report and nothing to retry.
  }
  connection.close();
}

/**
 * An error as a sentence.
 *
 * Exported so `outbox.ts` shares it rather than declaring a byte-identical copy
 * — `src/http.ts` already records what four private copies of this cost. It stays
 * here rather than being taken from `describeError` one directory up, because
 * nothing under `mail/` imports from the repo-root `src/`: that is the condition
 * under which `.dockerignore` and the Dockerfile did not have to grow a line for
 * this subsystem, and it is cheaper to keep than to re-argue.
 */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ *
 * The real dialer — the only outbound socket in this package
 * ------------------------------------------------------------------ */

/**
 * The SNI name to send, or `undefined` when there must not be one.
 *
 * **`smtp.host` is free text, and an IP is a thing operators really type** — a
 * docker gateway, an internal MTA, `172.17.0.1` from inside the container
 * `compose.sh` runs. Node refuses an IP as `servername` outright:
 * *"Setting the TLS ServerName to an IP address is not permitted"*, thrown out
 * of `tls.connect` before a byte moves. Passed through, that made **both** TLS
 * paths fail for ever on such a host, and the failure was doubly disguised: it
 * is not an `SmtpError`, so `sendMessage`'s wrapper files it under step `body`
 * for a connection that died at the upgrade, and `permanent` is false, so every
 * message spent all eight attempts before giving up. On an instance where mail
 * is the only account recovery there is, that is silent and total.
 *
 * Omitting it is also what the RFCs want: SNI carries a *name*, and there is no
 * name to send when the operator addressed a number. Certificate verification is
 * unaffected — with `rejectUnauthorized` on, an IP is still checked against the
 * certificate's IP SANs.
 */
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

        // `node:net` has no default socket timeout, so a host that accepts the
        // SYN and says nothing would hold this for ever. Cleared as soon as the
        // connection is up; the per-step budgets take over from there.
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
