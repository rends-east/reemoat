---
paths:
  - packages/control-plane/src/mail/*
  - packages/control-plane/src/emails.ts
  - packages/control-plane/src/registration.ts
---

## Sending mail

**Every decision here follows from where this runs**: one process holds the API
listener, `serveStatic` and every relay tunnel in the fleet, and this is the
first outbound connection the service has ever made. **The threadpool is the
non-obvious coupling** — `net.connect(host)` resolves names on the **libuv
threadpool**, the same pool `scrypt` runs on and `serveStatic` draws from, so a
host that accepts the connection and never answers consumes slots until password
hashing queues behind it and the sign-in page stops loading.
**A mail outage must never become a sign-in outage.** What makes that true: one
message at a time fleet-wide, hard per-step budgets (10 s to connect, 30 s for
the body, 60 s for the final dot, 90 s wall-clock for the whole message), and a
breaker that stops dialling after five consecutive failures. Q1.603.

**Nothing is ever sent from a request.** `POST /v1/forgot` enqueues and returns,
and so does the admin's own test send — the one route where somebody would
happily hold the socket and therefore the worst place to allow it. It is also
what keeps a taken address and a fresh one indistinguishable. Q1.601.

**The client is hand-rolled, and the seam is the reason.** `sendMessage` takes an
`SmtpDialer` rather than opening a socket, which is what lets `relaycheck` prove
three things a library would only assert by having been imported: that **STARTTLS
is never silently downgraded** (and that no `AUTH` and no `MAIL FROM` were
written when it refuses), that **the second `EHLO` wins** — servers routinely
advertise `AUTH` only after TLS — and that a **`QUIT` failing after `250` is not
a send failure**, which is the one place a careful implementation sends the
message twice. Q1.600.

Both MIME parts are **base64 rather than quoted-printable**: it is 7-bit clean so
`8BITMIME` never needs negotiating, and its alphabet excludes `.` so no body line
can begin with one. Q1.602. RFC 2047 encoded-words are chunked **by code
point** — slicing UTF-8 bytes splits a character across two words that the
receiver decodes independently, and it only shows up once a subject needs a
second word.

**`smtp.host` is admin-supplied, so this is SSRF by construction** — accepted,
because an admin can already read the fleet signing key out of the volume. What
follows is that every reply line is bounded at RFC 5321's 1000 octets and the
whole reply at 64 KiB, and that error text is truncated and CR/LF-stripped before
it can reach a response body or the delivery log.

**An IP in `smtp.host` gets no SNI.** `sniFor` returns `undefined` when
`isIP(host) !== 0`, on **both** TLS paths — implicit TLS at `connect` and the
`startTls` upgrade — because Node refuses an IP as `servername` outright and
throws before a byte moves. Passed through, **every** message on such a host
failed for ever and did so disguised as something else; omitting it costs no
verification, since with `rejectUnauthorized` on an IP is still checked against
the certificate's IP SANs. **No driver asserts this**: `sniFor` is module-private
and the failure is inside `tls.connect`, which the `SmtpDialer` seam exists to
keep out of `relaycheck`. Q1.604.

**A queued message holds a live credential.** `mail_outbox.body` carries the
rendered message including its one-time link — the first plaintext credential in
this database, beside the key that mints every token in the fleet. Cleared in the
same statement that writes `sent_at`, kept on failure only until the token's own
expiry, and never returned by the admin log. Q7.79 records why an in-memory queue
lost.

**A mailed token rides the URL fragment**, never a path or a query: a fragment
never reaches the server, so it is absent from every proxy access log — and
corporate mail gateways `GET` every URL in an inbound message, which would burn a
single-use link before the human saw it. `/confirm` and `/reset` render a button
rather than firing on mount for the same reason, twice over.

## Layout

| File | Holds |
|---|---|
| `packages/control-plane/src/emails.ts` | The address on an account and the single-use links that prove or reset it. `email_folded` rides the token, so changing your address kills an outstanding reset |
| `packages/control-plane/src/mail/address.ts` | What may be used as an address. Structural, not canonical: the whole security content is "no control characters", because `MAIL FROM` and `To:` are line-oriented |
| `packages/control-plane/src/mail/message.ts` | A message as bytes. Pure, with the date, boundary and message-id injected so a driver asserts them byte for byte. **Every CRLF *inside a message* is produced here**; the transport knows exactly two lines of its own — `${line}\r\n` per SMTP command and the terminating `\r\n.\r\n` — so the line endings cannot half-agree |
| `packages/control-plane/src/mail/templates.ts` | What each message says. The notice to a real owner never names the account — the request that triggered it was anonymous |
| `packages/control-plane/src/mail/smtp.ts` | The client, and the `connect` seam that makes STARTTLS, capability ordering and the QUIT rule assertable with no mail server |
| `packages/control-plane/src/mail/outbox.ts` | The queue and the one thing that sends. Concurrency one, lease-based claim, deadline before dial, breaker. Why none of it may be `await`ed from a route |

## Bounds

| | |
|---|---|
| Mailed links | verify 24h · **reset 1h** · invite 48h, re-sendable past it by `POST /v1/admin/users/:id/invite` (Q1.609). Single-use by conditional `UPDATE`, and ended early five ways: `burnEmailTokens` on a password change, on an address change, on `disable`, and twice inside `POST /v1/reset` itself (a disabled account, and a token naming an address the account no longer has) — while `delete` uses `deleteEmailState`, which **removes** the rows rather than marking them, there being no user left for a forensic column to be about |
| Mail | **one send at a time, fleet-wide.** Per step 10s — connect/greeting/EHLO/STARTTLS/**handshake**/AUTH/envelope/DATA, eight of them, `handshake` being its own number rather than part of `starttls` (Q1.605). Then 30s body, 60s final dot, 5s QUIT, **90s for a whole message**. Reply line 1000 octets, whole reply 64 KiB. Retry 60s→1h with full jitter, 8 attempts, breaker at 5 consecutive failures for 5 min. Outbox 500 pending then `503`, terminal rows kept 7 days. Default port **587**, never 25 (Q1.608) |
| Mail per address | **3 an hour**, and `mayMail` is the only spender: `POST /v1/register` on all three of its arms — the fresh sign-up, the notice to a real owner, and the re-signup that *is* the resend — and `PUT /v1/me/email`. Two routes, so they cannot compose into six; there is no `POST /v1/register/resend` (Q1.606). Keyed on the *recipient*, the only bound here that follows the victim rather than the caller — `x-forwarded-for` is caller-supplied and rotates for free. **Reset mail has its own 3 an hour** under `RESET_MAIL_THROTTLE`, with no escalation (Q1.607). Plus one `register_notice` per address per 24h, which is a query against the outbox rather than a counter in memory, so a restart does not clear it |
