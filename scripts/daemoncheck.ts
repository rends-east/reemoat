#!/usr/bin/env node
import { finish } from "./daemoncheck.env.js";

/**
 * The regression driver for the daemon's HTTP surface and its durable state.
 *
 * Same role as `authcheck.ts`, one layer up: `authcheck` proves a token is who it
 * says it is, and this drives what the daemon does once it believes one. Offline
 * and in one process — the registry is populated through `restore()` from a stub
 * store rather than by starting agents, so there is no fleet and no `claude`
 * login involved.
 *
 * **It was `tenantcheck`, and the rename is the point rather than tidiness.** Its
 * subject was `owner_subject` — that being someone did not get you someone else's
 * sessions — and that boundary is gone with the tenancy, not weakened: a grant on
 * this machine is access to everything on it. A driver whose stated subject is a
 * property nobody enforces is exactly how somebody "restores" that property
 * believing it was always there, which is the same reason `owned` became
 * `sessionOf` rather than keeping its name.
 *
 * What it covers now: every per-session route against an unknown id, the schema
 * v6 migration and its refusal of a newer file, the login pty on both platforms,
 * the login run registry, browsing and the memory of paths that do not answer,
 * the mount table, the WS over a real socket — including the two `lagged` frames
 * one attach can emit at once and the `GET /sessions/:id/events` page the second
 * of them hands a client off to — subagent lineage, and the ACP `fs`
 * capability driven against a real client over in-memory pipes — plus four
 * subsystems that had no driver at all: the permission state machine, against an
 * agent that genuinely waits; the SQLite event store, which is what actually
 * holds a conversation across a restart; what a session changed, against a real
 * repository rather than a stub runner; and `Uploads.receive`, the one bound on a
 * request body anywhere in this system.
 *
 * And five more that arrived with the sweep that found them: making and removing
 * a worktree — the symlinked root that refused every session, and the three
 * refusals that stand in front of the one `rmSync` in this codebase, driven
 * against a **scripted** git because what has to be produced is git failing to
 * answer; the two halves a caller-named path is now contained in; what a clear
 * may run beside; a launch that came back after its session had moved on; and the
 * relay URL a daemon cannot dial, which is here rather than in `relaycheck`
 * because the property is that a misconfigured daemon still *runs* and no relay is
 * involved in reaching it.
 *
 * That sentence is kept in step with `CLAUDE.md`'s own row for this file on
 * purpose. It went stale once — a 1200-line diff added all four of the above and
 * updated the table but not this header, so the two disagreed about the subject
 * of the file, and this is the copy a reader opening it sees first.
 *
 * This file is the running order and nothing else: nineteen subject modules
 * beside it hold the assertions, and `daemoncheck.env`, `.fixtures` and
 * `.bodies` hold what they share. It was one 22 964-line file until it was past
 * the point of being openable, and the cut is a pure move — the emitted output
 * is what it was, line for line.
 *
 * They are **siblings rather than a `daemoncheck/` directory**, and that is not
 * a preference: thirteen assertions read a source file off disk through
 * `readFileSync(new URL("../src/…", import.meta.url))`, a runtime path no
 * tsconfig alias touches, and one reads `../scripts/daemon.ts`. One directory
 * down, every one of them resolves somewhere that does not exist.
 *
 * **This list is the order, not a table of contents.** The modules share one
 * live `app` over one `registry` and one sandbox tree, and sections mutate all
 * three: the `?limit=` reorder in the first module has to run before the `POST
 * /sessions/:id/meta` that pins `s_one` — the rule the block at the top of that
 * module states in full — `registry.restore()` has to precede the `/fs/roots`
 * `recent` assertion four modules later, and the listener opened for the stream
 * section is closed inside it. So `await import` one at a time, rather than
 * static imports that would evaluate the lot before the first line of this body
 * ran.
 *
 *   pnpm daemoncheck
 */

await import("./daemoncheck.containment-and-session-routes.js");
await import("./daemoncheck.agent-login-and-launch.js");
await import("./daemoncheck.store-and-worktrees.js");
await import("./daemoncheck.browsing-and-signing-out.js");
await import("./daemoncheck.import-and-mounts.js");
await import("./daemoncheck.stream-and-events.js");
await import("./daemoncheck.git-pty-and-fs.js");
await import("./daemoncheck.agent-output-and-uploads.js");
await import("./daemoncheck.restart-and-resume.js");
await import("./daemoncheck.permissions-and-turns.js");
await import("./daemoncheck.after-the-turn-and-config.js");
await import("./daemoncheck.plugin-manifest-and-store.js");
await import("./daemoncheck.plugin-surfaces.js");
await import("./daemoncheck.plugin-install-and-rollback.js");
await import("./daemoncheck.plugin-scopes-and-hooks.js");
await import("./daemoncheck.plugin-routes.js");
await import("./daemoncheck.systems-and-harnesses.js");
await import("./daemoncheck.contributions-and-launch.js");
await import("./daemoncheck.agent-routes-and-capabilities.js");

finish();
