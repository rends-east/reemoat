---
paths:
  - packages/cli/src/*
  - scripts/relaycheck.cli-e2e.ts
---

# The external client: tasks and the board from anywhere, by API key

`packages/cli` (`@reemoat/cli`, `pnpm reemoat`) is how somebody's own logic — a CI job, a cron,
a server — creates and moves tasks on their machines. **There is no orchestrator agent**: the
owner took it out, and the orchestration is theirs, outside Reemoat (Q7.166). Q1.661 is the
binding, Q4.131 the package, `docs/API.md`'s *From a script* the reader's page.

## The path, and what each hop sees

API key → `GET /v1/me` → the key pair bound to that key (`PUT /v1/me/keys/current/binding`) →
`POST /v1/tokens`, which names the key in `cnf.jkt` → the same channel the app opens, through
the relay, to the daemon's own routes. **The Authority sees a machine and a public key; the
relay, bytes it cannot read; a brief, only the machine.** No route was added to a daemon.

- **Bound before the first mint** (`Reemoat.deviceKey`), or the token names no key and the
  channel refuses it. A `wrong_device` or `unbound_capability` before READY binds once more and
  asks once more; a `key_bound_elsewhere` is a sentence, never a silent `replace`, which only
  `reemoat device rebind` sends.
- **The client never imports `src/` or `packages/web`**, and nothing but `bin.ts` prints.
- **`pnpm client` stays loopback**; this one also speaks loopback when `REEMOAT_URL` is set.

## The key on disk

- **`clientHome()`**: `REEMOAT_CLIENT_HOME`, else `XDG_CONFIG_HOME/reemoat`, else
  `~/.config/reemoat`; **never `REEMOAT_HOME`**, which is a daemon's root. One key per server
  and account (`<server>/<user id>/device.json`), as the app's (Q1.651).
- **`0600` in a `0700` directory, set again after the write** (the umask only narrows), and
  linked into place so two first runs agree on one key. A file others can read is refused.
- `REEMOAT_DEVICE_KEY` is a key held as a CI secret and is never written.

## The machine's key (Q1.657)

`weighOfferedKey`, the protocol package's: the held key is dialled, pinned only once a
handshake proved the machine holds it. **A responder on another key closes without a word**, so
an unanswered handshake mints once more (a held token names the key from its own mint) and, if
the server names another key, is `MachineKeyChanged`; `trust` takes only the fingerprint on
offer. `REEMOAT_MACHINE_KEY` pins before first contact.

## Retries

- **Before the request frame went out, anything may be sent again**; after, only `GET`,
  `DELETE`, and `POST /tasks` with a `key`, which the client makes when none is given.
- `421` follows its relay once; `no_tunnel` waits 1.5 s once; `token_expired` mints once.
- `DeviceNotApproved` carries `approvalCode` of this key: the code the machine's list shows.

## Exit codes

0 done · 1 refused · 2 usage · 3 waiting to be let in · 4 the machine's key changed ·
5 unreachable · 6 a wait ran out. Stable: a script branches on them.

## Bounds

| | |
|---|---|
| An answer | 32 MiB unpacked (`MAX_RESPONSE_BYTES`); a listing passes a MiB with its briefs |
| A channel | 30 s per request; one connection per request, as a link's |
| Tokens | renewed 90 s before they expire, by the server's clock |
| `wait` | every 5 s by default, never under 2; an hour unless told |
