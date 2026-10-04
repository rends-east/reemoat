---
paths:
  - packages/control-plane/src/mail/*
  - packages/control-plane/src/emails.ts
  - packages/control-plane/src/registration.ts
---

## Sending mail

**A mail outage must never become a sign-in outage.** One process holds the API, the
`serveStatic` and every relay tunnel, and `net.connect(host)` resolves names on the
**libuv threadpool** that `scrypt` and `serveStatic` share, so a host that accepts and
never answers would queue password hashing behind it. Hence: one message at a time
fleet-wide, hard per-step budgets, and a breaker after five consecutive failures. Q1.603.

**Nothing is ever sent from a request**: `POST /v1/forgot` and the admin's test send
enqueue and return, which also keeps a taken address indistinguishable from a fresh one.
Q1.601.

**The client is hand-rolled for its seam**: `sendMessage` takes an `SmtpDialer`, so
`relaycheck` proves that **STARTTLS is never silently downgraded** (no `AUTH` and no
`MAIL FROM` written on refusal), that **the second `EHLO` wins**, and that **a `QUIT`
failing after `250` is not a send failure** (else the message goes twice). Q1.600.

Both MIME parts are **base64**, 7-bit clean (no `8BITMIME`) and with no `.` to start a
line. Q1.602. RFC 2047 encoded-words are chunked **by code point**, never by UTF-8 byte.

**`smtp.host` is admin-supplied SSRF by construction**, accepted (an admin can already
read the signing key). So reply lines are bounded at 1000 octets, the reply at 64 KiB, and
error text is truncated and CR/LF-stripped before reaching a response or the log.

**An IP in `smtp.host` gets no SNI**: `sniFor` returns `undefined` when
`isIP(host) !== 0`, on **both** TLS paths (implicit at `connect`, and `startTls`), since Node throws on an
IP `servername`; with `rejectUnauthorized` the certificate's IP SANs are still checked. **No driver asserts this**
(`sniFor` is module-private, the failure inside `tls.connect`). Q1.604.

**A queued message holds a live credential**: `mail_outbox.body` carries the one-time
link. Cleared in the statement that writes `sent_at`, kept on failure only until the
token's expiry, never returned by the admin log. Q7.79.

**A mailed token rides the URL fragment**, never a path or query: it never reaches the
server or a proxy log. Gateways that `GET` every URL are why the gate screens render a
button rather than submitting on mount (`cp-accounts.md`).

## Layout

| File | Holds |
|---|---|
| `packages/control-plane/src/emails.ts` | An account's address and the links proving or resetting it. `email_folded` rides the token, so changing your address kills an outstanding reset |
| `packages/control-plane/src/mail/address.ts` | Structural, not canonical: the security content is "no control characters" (`MAIL FROM` and `To:` are line-oriented) |
| `packages/control-plane/src/mail/message.ts` | A message as bytes, pure, with date, boundary and message-id injected. **Every CRLF inside a message is produced here**; the transport writes only `${line}\r\n` per command and the final `\r\n.\r\n` |
| `packages/control-plane/src/mail/templates.ts` | What each says. The notice to a real owner never names the account (the trigger was anonymous) |
| `packages/control-plane/src/mail/smtp.ts` | The client and the `connect` seam |
| `packages/control-plane/src/mail/outbox.ts` | The queue and the one sender: concurrency one, lease-based claim, deadline before dial, breaker. None of it may be `await`ed from a route |

## Bounds

| | |
|---|---|
| Mailed links | verify 24h · **reset 1h** · invite 48h, re-sendable by `POST /v1/admin/users/:id/invite` (Q1.609). Single-use by conditional `UPDATE`; ended early by `burnEmailTokens` on a password change, an address change, `disable`, and twice in `POST /v1/reset` (a disabled account; a token naming an address no longer the account's). `delete` uses `deleteEmailState`, which **removes** the rows |
| Mail | **One send at a time, fleet-wide.** 10s per step — connect/greeting/EHLO/STARTTLS/**handshake**/AUTH/envelope/DATA, `handshake` its own step (Q1.605) — then 30s body, 60s final dot, 5s QUIT, **90s per message**. Reply line 1000 octets, reply 64 KiB. Retry 60s→1h, full jitter, 8 attempts; breaker at 5 consecutive failures for 5 min. Outbox 500 pending then `503`; terminal rows kept 7 days. Default port **587**, never 25 (Q1.608) |
| Mail per address | **3 an hour**, `mayMail` the only spender: `POST /v1/register` on all three arms (fresh sign-up, notice to a real owner, re-signup as resend) and `PUT /v1/me/email`; there is no `POST /v1/register/resend` (Q1.606). Keyed on the *recipient*, the one bound following the victim. **Reset mail has its own 3 an hour** (`RESET_MAIL_THROTTLE`, no escalation; Q1.607). One `register_notice` per address per 24h, queried from the outbox so a restart does not clear it |
