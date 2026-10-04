---
paths:
  - packages/control-plane/src/app.ts
  - packages/control-plane/src/main.ts
  - packages/control-plane/src/store.ts
  - packages/control-plane/src/schema.sql
---

<!-- `docs/AUTHORITY.md` is deliberately not in the globs: `docscheck` matches globs against `SOURCE_DIRS`, which excludes `docs/`, so it would be a dead glob. -->

# The Authority, and the line it may not cross

`packages/control-plane` is the **Authority**: who somebody is, which devices they
signed in from, which machines exist, who owns them and who may reach them — not where
the work is. `docs/AUTHORITY.md` is the document. **The directory keeps its name**: a
rename would touch the Dockerfile and `.dockerignore`, `RELAY_INPUTS`, `compose.yml`,
deploy scripts, `paths:` globs and imports for no behaviour (`CLAUDE.md`'s `remoslop`
warning). The boundary is **checked** instead.

## What may not arrive here

Agents, conversations, prompts, responses, diffs, worktrees, source, shell, running
processes, approvals, plugins: each is the daemon's, on its machine. A daemon never asks
this service anything after enrollment (Q1.9, Q1.10), so an Authority outage stops new
sign-ins and nothing running — only while nothing running *needs* a read from here. And
this process holds the Ed25519 key that mints every token; it must not also hold
anybody's source.

**Four facts it keeps**, each about reachability or its own: tunnel presence
(`relay_tunnels`, `machine_last_seen`), what a daemon announced on the handshake
(`machines.daemon_*`), which of one owner's machines may open a channel to which
(`machine_links`, withheld by `account_permissions` and `machine_permissions`), and mail
waiting to go out. A message between agents waits on the sending daemon, never here
(Q7.150). A session title, transcript index, file listing or turn count would not
qualify.

## The two ratchets

In `relaycheck` under **"what the Authority may reach"**, compared against the tree as
it is, so widening is a diff. Neither is a security boundary.

1. **Imports.** `packages/control-plane/src/**` reaches the root for exactly five files:
   `src/{token,auth,cors,http}.js` and `src/relay/protocol.js`. **That list is also
   `deploy/docker/Dockerfile`'s COPY lines**: a sixth import changes both, or the image
   fails at runtime. A negative control asserts nothing under `src/session`,
   `src/registry`, `src/acp/` or `src/runtime/` is in it.
2. **Route paths.** No path names `sessions`, `prompts`, `agents`, `worktrees`,
   `files`, `diffs` or `events`. **The four `/v1/me/sessions` routes are the exception,
   named by literal** (a sign-in is a credential with an expiry), which keeps
   `/v1/sessions` refused.

**`packages/control-plane` may import from `src/`; nothing in `src/` may ever import
from it.**

## It serves the gate, never the app

**Nine addresses** from `packages/web/dist-gate`: the five gate screens, the three legal
documents, `/app`. **A closed list, not an SPA fallback**: `/` and every app address
answer the error envelope; the product is not in the image.

- **The gate has no off switch.** `/confirm`, `/reset` and `/verify` are opened by a mail
  client and `POST /v1/forgot` is the only password recovery, so `main.ts` resolves the
  directory and reads no environment value for it.
- **No variable serves the app; `REEMOAT_CP_WEB` is deleted.** A browser holds no device
  key and could reach no machine. The app compiles `packages/web` into its binary.
- **`REEMOAT_CP_INSTALL` is the one boolean-or-path variable left**; `deploycheck` reads
  its three spellings of off and three of the default off `main.ts`. It has a default
  because `deploy/bootstrap.sh` is in the image.
- **`mail.public_url` must name whatever serves the gate**, since every mailed link is
  built from it. `mailConfigured` reports a mismatch as **non-blocking**, worded without
  *"is not set"* (`isMissing` keys on those words and would stop all mail). It needs the
  API's own origin, a property of the request, so `GET /v1/admin/settings` is the one
  caller, passing it only while this process serves no gate (`servesGate` in `app.ts`).
- **The gate takes a pasted link or code**, for a mail client that drops the `#` the
  token rides on.

## Migrations

- **`migrate()` may only add, and `CP_SCHEMA_VERSION` may not move for an addition**:
  an older build ignores a nullable column it never selects. A bump makes
  `checkSchemaVersion` refuse the file, `main.ts` exit 2, and the unit crash-loop,
  taking the relay and the fleet's reachability with it.
- **Each table touched needs its own `table_info` reader.** `has()` asks `machines`;
  reusing it keeps the guard false for ever, re-attempting the `ALTER` on every open by
  both processes, with only `addColumn`'s duplicate-name clause (a one-shot window, not a
  licence) between that and `exit(2)`.
- **An index over a migrated column cannot live in `schema.sql`**, which runs *before*
  `migrate()` and fails `no such column` on existing databases.
  `idx_user_sessions_device` sits in `migrate()` after its `ALTER`; `deploycheck` allows
  `CREATE INDEX IF NOT EXISTS` there, named explicitly.
- **`deploycheck` reads the whole body, comments included, and refuses the two
  destructive keywords anywhere in it.** Prose must avoid them too.
