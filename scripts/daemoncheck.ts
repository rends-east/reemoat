#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { crc32, deflateRawSync, gunzipSync, gzipSync } from "node:zlib";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";

import { serve } from "@hono/node-server";
import { WebSocket } from "ws";

import {
  AGENT_IDS,
  AGENT_LOGIN,
  agentEnv,
  credentialEnvNames,
  resolveAgent,
  type AgentId,
  type AgentLaunchConfig,
} from "../src/acp/agents.js";
import { AgentLoginRuns, readFrom, sanitize } from "../src/agentauth.js";
import {
  importFolderName,
  isArchiveRoot,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_ENTRIES,
  MAX_IMPORT_PATH_CHARS,
  MAX_IMPORT_UNPACKED_BYTES,
  safeMemberPath,
  settleFolderName,
} from "../src/archive.js";
import { SignedTokenVerifier, type Scope } from "../src/auth.js";
import type { PluginManifest } from "../src/plugins/protocol.js";
import type { PluginRuntime } from "../src/plugins/runtime.js";
import { checkPluginWrite, type PluginDataStore, type PluginRecordStore } from "../src/plugins/store.js";
import { forgetStalled, isStalled, listDirs, makeDir, PathError, probeExists, resolveCwd } from "../src/browse.js";
import { isRemoteType, mountFor, parseBsdMounts, parseLinuxMounts, readMounts } from "../src/mounts.js";
import { CORS_ALLOW_METHODS } from "../src/cors.js";
import {
  MemoryEventStore,
  endedWithDaemon,
  estimateBytes,
  oldestAvailable,
  truncateEvent,
  type ExitReason,
  type PersistedSession,
  type SessionEvent,
  type SessionExit,
  type SessionStore,
  type SessionWorkspace,
  type ToolCallEvent,
} from "../src/events.js";
import {
  contentDispositionFor,
  inlinesImage,
  MAX_SESSION_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  uploadRateVerdict,
  UPLOAD_RATE_BYTES,
  UPLOAD_RATE_WINDOW_MS,
  MAX_UPLOADS_PER_SESSION,
  resolveUploadRoot,
  sanitizeUploadName,
  Uploads,
  type UploadIndex,
  type UploadRow,
} from "../src/uploads.js";
import {
  DEFAULT_MAX_CHANGED_FILES,
  DEFAULT_MAX_DIFF_BYTES,
  diffFile,
  listChanges,
  probeContained,
  probeRequestable,
  safeRelPath,
  type FileChange,
} from "../src/changes.js";
import { toolCallLineage } from "../src/acp/subagents.js";
import { atOrUnder, atOrUnderResolved, containedIn, containedInResolved } from "../src/paths.js";
import { gitArgs, gitEnv, GitError, hostGit, type GitExec, type GitRun } from "../src/git.js";
import {
  MAX_TITLE_CHARS,
  SessionRegistry,
  autoResumable,
  awaitingHuman,
  dedupeAliasChoices,
  deriveSessionTitle,
  normalizeTitle,
  resumeBackoffMs,
  sameCommands,
  SessionLimitError,
  ULTRACODE_CHOICE,
  ultracodeOptionId,
  usageWorthAnnouncing,
  validateElicitationContent,
  withUltracode,
} from "../src/registry.js";
import { sessionMetaFor } from "../src/acp/agents.js";
import { RelayTunnel } from "../src/relay/tunnel.js";
import { LocalRuntime, hostLoginArgs, loginBlockedReason, loginStdio, readLoginAnswer } from "../src/runtime/local.js";
import { toCommands } from "../src/session.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { EVENTS_PAGE_LIMIT, createApp } from "../src/server.js";
import { SCHEMA_VERSION, openStores } from "../src/store/sqlite.js";
import { createWorkspace, inspectRepo, removeWorkspace, WorktreeError } from "../src/worktree.js";
import { publicKeyToJwk, signToken, type TokenClaims } from "../src/token.js";

import { tmp } from "./tmp.js";
import { DAEMON_VERSION } from "../src/version.js";
import { RELAY_PROTOCOL_VERSION } from "../src/relay/protocol.js";

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
 *   pnpm daemoncheck
 */

let failures = 0;

/**
 * An `UploadIndex` with no database behind it.
 *
 * The interface lives in `uploads.ts` and `store/sqlite.ts` implements it, which
 * is what lets the block rules be driven here without a file on disk. The
 * durability half is asserted separately, against the real store.
 */
function memoryUploadIndex(): UploadIndex {
  const rows = new Map<string, UploadRow>();
  const key = (sessionId: string, uploadId: string): string => `${sessionId}/${uploadId}`;
  return {
    insert: (row) => void rows.set(key(row.sessionId, row.uploadId), row),
    get: (sessionId, uploadId) => rows.get(key(sessionId, uploadId)) ?? null,
    bytesFor: (sessionId) =>
      [...rows.values()].filter((row) => row.sessionId === sessionId).reduce((total, row) => total + row.bytes, 0),
    countFor: (sessionId) => [...rows.values()].filter((row) => row.sessionId === sessionId).length,
    markConsumed: (sessionId, ids, at) => {
      for (const id of ids) {
        const row = rows.get(key(sessionId, id));
        if (row !== undefined && row.consumedAt === null) rows.set(key(sessionId, id), { ...row, consumedAt: at });
      }
    },
    listFor: (sessionId) => [...rows.values()].filter((row) => row.sessionId === sessionId),
    listSessions: () => [...new Set([...rows.values()].map((row) => row.sessionId))],
    expired: (before) => [...rows.values()].filter((row) => row.consumedAt === null && row.createdAt < before),
    remove: (sessionId, uploadId) => void rows.delete(key(sessionId, uploadId)),
    removeSession: (sessionId) => {
      for (const [id, row] of rows) if (row.sessionId === sessionId) rows.delete(id);
    },
  };
}

/**
 * A `PluginDataStore` with no database behind it.
 *
 * `memoryUploadIndex`'s shape one subject over, and at module scope rather than
 * inside the section that first needed it because there are two callers now: the
 * scope gate is driven against this, and `SqlitePluginDataStore` is driven
 * against **both**. That pairing is the whole reason `checkPluginWrite` lives in
 * `src/plugins/store.ts` instead of beside the SQL — a quota that holds only
 * where there is a file is a quota nothing drives — and `entries` makes the same
 * claim about paging, which is why the byte accounting below is the real one
 * rather than a row count.
 *
 * ⚠ **Keyed on the pair, because the real one is.** This ignored `pluginId`
 * entirely and held one flat map, so it was structurally incapable of showing a
 * cross-plugin leak — the one property `PluginApi` namespacing every store call
 * on `manifest.id` exists to provide. `dropPlugin` cleared everything for the
 * same reason, which would have made "uninstalling one leaves the other's" pass
 * against a store that dropped both.
 */
function memoryPluginData(): PluginDataStore {
  const data = new Map<string, string>();
  /** `pluginId` and `key` are two fields, never one string somebody could forge. */
  const at = (id: string, key: string): string => `${id}\u0000${key}`;
  const keysOf = (id: string, prefix: string): string[] =>
    [...data.keys()]
      .filter((held) => held.startsWith(`${id}\u0000`))
      .map((held) => held.slice(id.length + 1))
      .filter((key) => key.startsWith(prefix));
  const sizeOf = (id: string, key: string): number | null => {
    const held = data.get(at(id, key));
    return held === undefined ? null : Buffer.byteLength(held, "utf8");
  };
  return {
    get: (id, key) => (data.has(at(id, key)) ? JSON.parse(data.get(at(id, key)) as string) : null),
    set: (id, key, value) => {
      /*
       * The shared bound, charged here rather than assumed. A fake that skipped
       * it would make every quota assertion in this file a claim about SQLite
       * alone, which is exactly the arrangement `checkPluginWrite` was extracted
       * to end — and the refusals are what a plugin author actually meets.
       */
      const held = keysOf(id, "");
      checkPluginWrite(key, value, {
        keys: held.length,
        bytes: held.reduce((total, one) => total + (sizeOf(id, one) ?? 0), 0),
        existing: sizeOf(id, key),
      });
      data.set(at(id, key), value);
    },
    delete: (id, key) => void data.delete(at(id, key)),
    // Sorted, because `keysStmt` is `ORDER BY key` and a driver comparing the two
    // answers would otherwise be comparing SQLite's collation against a Map's
    // insertion order.
    keys: (id, prefix) => keysOf(id, prefix).sort(),
    entries: (id, prefix, after, maxBytes) => {
      const out: { key: string; value: unknown }[] = [];
      let bytes = 0;
      for (const key of keysOf(id, prefix).sort()) {
        if (key <= after) continue;
        const text = data.get(at(id, key)) as string;
        // Charged as the bytes the answer carries, the way SQLite's does, so the
        // two implementations cut a page at the same place.
        bytes += Buffer.byteLength(text, "utf8") + Buffer.byteLength(JSON.stringify(key), "utf8");
        if (out.length > 0 && bytes > maxBytes) return { entries: out, more: true };
        out.push({ key, value: JSON.parse(text) });
      }
      return { entries: out, more: false };
    },
    dropPlugin: (id) => {
      for (const held of [...data.keys()]) if (held.startsWith(`${id}\u0000`)) data.delete(held);
    },
  };
}

function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(
    `  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`,
  );
}

/**
 * A property that holds, with the measurement beside it.
 *
 * `relaycheck` and `webcheck` both have this and this file did not, so every
 * assertion here that is really about a *bound* — "smaller than", "charged at
 * all" — had to be written as an equality against a number, which then pins the
 * number rather than the property and fails the day somebody legitimately
 * changes a cap. The detail string is what keeps the output readable when the
 * answer is `true`: "34 of 40 refused" says something that `ok` alone does not.
 */
function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    process.stdout.write(`  ok    ${name}  (${detail})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}  (${detail})\n`);
}

/* ------------------------------------------------------------------ *
 * Containment — the primitive everything else rests on
 * ------------------------------------------------------------------ */

process.stdout.write("\ncontainment\n");

// Realpathed up front: on macOS `/var` is a symlink to `/private/var`, and
// `resolveCwd` resolves before it compares — so an unresolved fixture would make
// every expectation below disagree with correct behaviour.
const sandbox = realpathSync(tmp("daemoncheck-"));
const users = join(sandbox, "users");
// The pair that a bare `startsWith` gets wrong: one id is a prefix of another.
const uAb = join(users, "u_ab");
const uAbcd = join(users, "u_abcd");
mkdirSync(join(uAb, "proj"), { recursive: true });
mkdirSync(join(uAbcd, "proj"), { recursive: true });

check("a tenant's own subdirectory is inside it", containedIn(join(uAb, "proj"), uAb), true);
check("the root is not strictly inside itself", containedIn(uAb, uAb), false);
check("but it is at-or-under itself", atOrUnder(uAb, uAb), true);
check("u_abcd is NOT inside u_ab  (segment-wise, not startsWith)", containedIn(uAbcd, uAb), false);
check("nor at-or-under it", atOrUnder(uAbcd, uAb), false);
check("a sibling is outside", containedIn(join(uAbcd, "proj"), uAb), false);

// A symlink planted inside one's own tree, pointing out of it. Textually the
// path is inside the root; it resolves somewhere else entirely.
const escape = join(uAb, "escape");
symlinkSync(uAbcd, escape);
/** A plain file, for the one refusal that is about shape rather than location. */
const aFile = join(uAb, "notes.txt");
writeFileSync(aFile, "hello\n");
check("a symlink out of the root is not inside it", containedIn(escape, uAb), false);
check("nor is anything under it", containedIn(join(escape, "proj"), uAb), false);

/* ------------------------------------------------------------------ *
 * Fixtures: a signed identity, a stub store, and a live app
 * ------------------------------------------------------------------ */

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const kid = "k_daemoncheck";
const identity = {
  machineId: "m_self",
  issuer: "reemoat-cp",
  keys: [{ kid, jwk: publicKeyToJwk(publicKey) }],
};
// The real clock, unlike `authcheck`'s fixed instant. Nothing here tests expiry
// or skew, and the routes below run against a live app that reads its own clock —
// a frozen `iat` would make every token not-yet-valid rather than prove anything.
const now = Date.now();
const iat = Math.floor(now / 1000);

function tokenWith(sub: string, scp: Scope[]): string {
  const claims: TokenClaims = {
    iss: "reemoat-cp",
    sub,
    aud: "m_self",
    jti: `t_${sub}`,
    iat,
    nbf: iat,
    exp: iat + 300,
    scp,
  };
  return signToken(claims, kid, privateKey);
}

function tokenFor(sub: string): string {
  return tokenWith(sub, ["session:read", "session:write", "machine:admin"]);
}

const verifier = new SignedTokenVerifier({ identity });

/** Enough of a store to drive `restore()`; nothing here is ever written back. */
function storeOf(rows: PersistedSession[]): SessionStore {
  return { put: () => {}, list: () => rows, remove: () => {} };
}

function rowFor(
  id: string,
  root: string,
  meta: { title?: string | null; pinned?: boolean } = {},
): PersistedSession {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "notes.txt"), "hi\n", "utf8");
  // Over `COMPRESS_MIN_BYTES` and trivially compressible, which is what makes the
  // download route's *exclusion* from gzip drivable rather than merely argued.
  writeFileSync(join(root, "big.txt"), "y".repeat(40 * 1024), "utf8");
  return {
    id,
    agent: "kimi",
    createdAt: now,
    workspace: {
      mode: "plain",
      root,
      requestedCwd: root,
      git: null,
      plainReason: "not_a_repo",
      createdAt: now,
    },
    agentSessionId: null,
    // No handle, so `restore()` reaps nothing — this driver must not signal anything.
    agentHandle: null,
    status: "exited",
    exit: { reason: "stopped", at: now, detail: null, agentHandle: null, agentConfirmedDead: true },
    turnCounter: 0,
    lastEventAt: now,
    askSeq: 0,
    askSalt: "salt",
    resumeGaveUp: null,
    lastSeq: 0,
    dropped: 0,
    title: meta.title ?? null,
    pinned: meta.pinned ?? false,
    // Nobody chose, which is what every row on disk says until somebody does.
    ultracode: null,
  };
}

const rows = [
  rowFor("s_one", join(users, "u_alice", "proj")),
  // Pinned, and second, so a `?limit=1` cut has to reorder to keep it. Both rows
  // are terminal, so pinning is the only thing separating them.
  rowFor("s_two", join(users, "u_alice", "other"), { pinned: true }),
  rowFor("s_three", join(users, "u_bob", "proj")),
];

const registry = new SessionRegistry(new MemoryEventStore(), storeOf(rows));
registry.restore({ reapOrphans: false });

/** A credential store with no database behind it. */
const credentialRows = new Map<string, { agent: string; envName: string; secret: string; updatedAt: number }>();
const credentials = {
  list() {
    return [...credentialRows.values()].map((row) => ({
      agent: row.agent,
      envName: row.envName,
      updatedAt: row.updatedAt,
    }));
  },
  envFor() {
    return {};
  },
  save(agent: string, envName: string, secret: string) {
    credentialRows.set(`${agent}|${envName}`, { agent, envName, secret, updatedAt: now });
  },
  remove(agent: string, envName: string) {
    credentialRows.delete(`${agent}|${envName}`);
  },
};

const { app, injectWebSocket } = createApp({
  registry,
  verifier,
  instanceId: "i_daemoncheck",
  startedAt: now,
  credentials,
  roots: [users],
  // No `logins`: the wizard routes answering 503 with none is the behaviour
  // under test here, and `LocalRuntime.login` is asserted directly further down.
});

async function get(path: string, sub: string): Promise<{ status: number; body: any }> {
  const response = await app.fetch(
    new Request(`http://d${path}`, { headers: { authorization: `Bearer ${tokenFor(sub)}` } }),
  );
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

/* ------------------------------------------------------------------ *
 * resolveCwd — what it still refuses, now that it confines nothing
 * ------------------------------------------------------------------ */

/*
 * This section used to assert the opposite of every line in it, and the
 * inversion is the point rather than an embarrassment: `resolveCwd` was confined
 * to a tenant root, and the reason — a worktree created outside a container's
 * mount — went with the container. What is left is not a weaker boundary, it is
 * not a boundary: the checks below are all about whether the request can be
 * carried out at all.
 */
process.stdout.write("\nresolveCwd\n");

/*
 * ⭐ **The request-body bound, which this daemon had none of.**
 *
 * Every JSON route reads the whole body before it looks at it, on the process
 * that owns the agent subprocesses, the event log and the relay tunnel. The
 * control plane added a bound for this reason and this side had never had one:
 * `REEMOAT_AUTH` answers *who* may ask, which is not an answer to *how much*, and
 * a grant is full access reached from a phone.
 *
 * Both directions are asserted, because the bound has one route it must not
 * reach: uploads stream to disk against `MAX_UPLOAD_BYTES` with their own
 * counter, and wrapping them here would refuse every real upload at a megabyte.
 */
{
  process.stdout.write("\nhow much one request may carry\n");

  const oversized = "x".repeat(2 * 1024 * 1024);
  const fat = await app.fetch(
    new Request("http://d/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_1")}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude", cwd: oversized }),
    }),
  );
  check("a body past the bound is refused", fat.status, 413);
  check(
    "in the envelope every client already parses",
    ((await fat.json()) as { error?: { code?: string } }).error?.code,
    "payload_too_large",
  );

  // The guard against a vacuous pass: an ordinary body must still get through,
  // or the assertion above would also hold for a daemon that refuses everything.
  const ordinary = await app.fetch(
    new Request("http://d/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_1")}`, "content-type": "application/json" },
      body: JSON.stringify({ agent: "claude", cwd: "/nowhere-in-particular" }),
    }),
  );
  report("while an ordinary one is not", ordinary.status !== 413, `status ${ordinary.status}`);
}

async function cwdCode(input: string): Promise<string> {
  try {
    await resolveCwd(input);
    return "(accepted)";
  } catch (error) {
    return error instanceof PathError ? error.code : "?";
  }
}

check("a directory is accepted", await cwdCode(join(uAb, "proj")), "(accepted)");
// The three that used to be refusals. Somebody keeping a repository in /opt or on
// an external volume is the case this exists to allow.
check("so is one somewhere else entirely", await cwdCode(join(uAbcd, "proj")), "(accepted)");
check("so is a path that walks up and back down", await cwdCode(join(uAb, "..", "u_abcd")), "(accepted)");
check("and so is a symlink pointing out of the tree", await cwdCode(escape), "(accepted)");
check("~ means the daemon user's home again", await resolveCwd("~"), realpathSync(homedir()));
// What survives, and all three are answers to "can this be done", not "may it be".
check("a relative path is refused", await cwdCode("proj"), "invalid_path");
check("an empty path is refused", await cwdCode("   "), "invalid_path");
check("a path that is not there is refused", await cwdCode(join(uAb, "nope")), "not_found");
check("and a file is not a directory", await cwdCode(aFile), "not_a_directory");

/* ------------------------------------------------------------------ *
 * A directory that never answers must not take the daemon with it
 * ------------------------------------------------------------------ */

/*
 * The bug this exists for, measured 2026-08-02 on a real machine.
 *
 * `~/OrbStack` is a hard NFS mount. When its server pauses — the VM sleeping,
 * restarting, or busy — `open()` on it never returns and cannot be interrupted.
 * `browse.ts` did that read **synchronously**, so one directory listing stopped
 * the event loop and the whole daemon died: `/health` accepted the connection and
 * answered nothing, at 0% CPU, until it was killed. The relay tunnel died
 * underneath it without even logging, because the logging needed the same thread.
 *
 * It was reachable only because the browse root became the daemon user's home;
 * while browsing was confined to a small tree there was no stalled mount in it.
 *
 * A stalled mount cannot be built in a driver, so what is asserted is the
 * property that makes one survivable: **these functions are async**, so the
 * filesystem work happens off the event loop. A regression to `readdirSync` would
 * be a type error at every call site, which is the point of asserting the shape
 * rather than the timing.
 */
process.stdout.write("\na stalled directory cannot block the daemon\n");
{
  const listing = listDirs(null, { roots: [uAb], showHidden: false });
  check("listDirs hands back a promise rather than a value", typeof (listing as { then?: unknown }).then, "function");
  check("and it resolves to the roots", (await listing).roots, [uAb]);

  const resolving = resolveCwd(uAb);
  check("resolveCwd is async too", typeof (resolving as { then?: unknown }).then, "function");
  await resolving;

  const making = makeDir(uAb, "async-check");
  check("and so is makeDir", typeof (making as { then?: unknown }).then, "function");
  check("which still creates the folder", (await making).endsWith("async-check"), true);

  /*
   * There was a fourth case here — "a timer can run while a listing is in
   * flight" — and it is **deleted rather than repaired**, because it could not
   * fail. It set a flag from a `setTimeout(…, 0)`, put that timer's promise into
   * a `Promise.all` beside the listing, awaited the pair, and then asserted the
   * flag: the flag is true after that await for a synchronous listing too, since
   * the timer resolves either way. A green line saying nothing is worse than no
   * line, and rewriting it as a real ordering assertion means racing a 1 ms timer
   * against one threadpool round trip — flaky in exactly the direction that
   * teaches a maintainer to ignore this driver. The shape assertions above are
   * what carries the property: `readdirSync` cannot be returned from any of these
   * three without failing the compiler at every call site.
   */
}

process.stdout.write("\nan unknown id is 404 on every per-session route\n");
// Each route is checked in *both* directions, and the positive control is the
// half that carries the weight. A "404 for an unknown id" assertion on its own
// passes for a route that 404s for everybody, which is exactly what happened to
// `stream`: `upgradeWebSocket` falls through on a plain `app.fetch` request, so
// a real id got 404 too and deleting its lookup left the check green. `stream`
// is therefore not tested here at all — it gets a real upgrade below — and the
// rest have to prove they answer an id that exists.
//
// This section used to be about the tenant boundary, and the boundary is gone.
// What it still catches is a route that stops resolving its id at all, which is
// a live way to break every one of them at once.
for (const [name, real, absent] of [
  ["events", "/sessions/s_one/events", "/sessions/s_nope/events"],
  ["changes", "/sessions/s_one/changes", "/sessions/s_nope/changes"],
  [
    "diff",
    "/sessions/s_one/changes/diff?path=notes.txt",
    "/sessions/s_nope/changes/diff?path=notes.txt",
  ],
  ["workspace", "/sessions/s_one/workspace", "/sessions/s_nope/workspace"],
  // `files` is not here: its positive control answers raw bytes, and `get` parses
  // JSON. Both directions are asserted in "serving one file out of a session",
  // where the helper reads a `Response` instead.
  ["upload download", "/sessions/s_one/uploads/u_x", "/sessions/s_nope/uploads/u_x"],
  // The positive control is the half that carries the weight here, exactly as the
  // note above says: a restored row has no live agent, and this route must still
  // answer it with an empty list rather than 404 — otherwise the assertion passes
  // for a route that 404s for everybody.
  ["commands", "/sessions/s_one/commands", "/sessions/s_nope/commands"],
] as const) {
  check(`${name} is 404 for an id that does not exist`, (await get(absent, "u_alice")).status, 404);
  check(`and ${name} answers one that does`, (await get(real, "u_alice")).status !== 404, true);
}

/*
 * And what the commands route *says* about a session with no live agent, which
 * the status alone cannot show.
 *
 * An empty list at revision 0, not a 409. Nothing is asked of the agent here —
 * this reads a field — and "no commands" is the honest answer for a restored row,
 * where a refusal would make the composer draw an error instead of no menu.
 * Revision 0 is also what tells a client there is nothing worth fetching at all.
 */
check("a session with no live agent has no commands", (await get("/sessions/s_one/commands", "u_alice")).body, {
  revision: 0,
  commands: [],
  dropped: 0,
});

// The mode/model/effort route is a POST, so it cannot ride the loop above. Both
// directions, same as the rest: the positive control answers 409
// (`session_not_ready`, since these rows have no live agent), and 409 is
// emphatically not 404.
const configTheirs = await app.fetch(
  new Request("http://d/sessions/s_nope/config", {
    method: "POST",
    headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
    body: JSON.stringify({ modeId: "plan" }),
  }),
);
check("config is 404 for an id that does not exist", configTheirs.status, 404);
const configMine = await app.fetch(
  new Request("http://d/sessions/s_one/config", {
    method: "POST",
    headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
    body: JSON.stringify({ modeId: "plan" }),
  }),
);
check("and config answers one that does", configMine.status !== 404, true);

/* ------------------------------------------------------------------ *
 * Listing sessions, and the reorder a cut depends on
 * ------------------------------------------------------------------ */

/**
 * `?limit=` is safe **only** because the order changes with it.
 *
 * Unbounded, the list is creation order and always has been — `scripts/client.ts`
 * prints it that way. With a limit it is `listRank` order: blocked first, then
 * pinned, then everything still live, then the most recent terminal rows. So
 * dropping the tail can only ever drop rows nobody is waiting on, where cutting
 * creation order could hide the one blocked session the whole product exists to
 * surface.
 *
 * The fixture for this has been staged since the rows were written — `s_two` is
 * pinned *and* second, so a `limit=1` that did not reorder would return `s_one` —
 * and nothing asserted it. This is that assertion.
 *
 * What is deliberately not here is the top of the rank: these rows are restored
 * and terminal, so none of them can hold a pending permission. Blocked-outranks-
 * everything is asserted where a session actually blocks, against a live agent.
 *
 * **This has to run above the `/meta` block, and finding that out is the reason
 * to say so.** Written below it, the cut returned `s_one` — because `setMeta` is
 * exercised there with `{pinned: true}` as the *positive control for renaming a
 * terminal session*, so a second row is pinned as a side effect of an assertion
 * about something else entirely, and two rows sharing a rank and a `createdAt`
 * fall back to insertion order. The registry is module state shared by every
 * section in this file, which is the same hazard `webcheck` writes down beside
 * `sessionGroups`: an assertion about ordering must sit above anything that
 * mutates what it orders.
 */
process.stdout.write("\nlisting sessions, and the cut that reorders\n");
{
  const unbounded = await get("/sessions", "u_alice");
  check(
    "with no limit the list is creation order, as it always was",
    unbounded.body.sessions.map((session: { id: string }) => session.id),
    ["s_one", "s_two", "s_three"],
  );
  check("and says it is whole", [unbounded.body.total, unbounded.body.truncated], [3, false]);

  const cut = await get("/sessions?limit=1", "u_alice");
  check(
    "a cut of one keeps the pinned row, not the first-created one",
    cut.body.sessions.map((session: { id: string }) => session.id),
    ["s_two"],
  );
  /*
   * Both are always present, because a client that prunes state for sessions
   * missing from a response has to tell "gone" from "outside the window" — and a
   * list that quietly stops short reads as complete.
   */
  check("while still reporting how many there really are", cut.body.total, 3);
  check("and saying that it stopped short", cut.body.truncated, true);

  const roomy = await get("/sessions?limit=10", "u_alice");
  check("a limit above the count truncates nothing", roomy.body.truncated, false);
  check("and still returns every row", roomy.body.sessions.length, 3);

  const none = await get("/sessions?limit=0", "u_alice");
  check("zero returns nothing rather than everything", none.body.sessions.length, 0);
  check("and is still honest about the total", [none.body.total, none.body.truncated], [3, true]);

  /*
   * A negative or unparseable limit clamps to zero rather than throwing or
   * wrapping to the whole list, which is the shape that would make a typo in a
   * query string return a hundred megabytes to a phone.
   */
  const negative = await get("/sessions?limit=-5", "u_alice");
  check("a negative limit clamps rather than inverting the cut", negative.body.sessions.length, 0);
  check("and still says the list is not whole", negative.body.truncated, true);

  /*
   * **The unparseable arm, which is a different code path and the one that
   * decides whether a typo returns everything.** `Math.max(0, clampInt(…))`
   * clamps a *number*; a non-numeric string never reaches the `Math.max` at all,
   * it takes `clampInt`'s own fallback. So `limit=-5` says nothing about
   * `limit=abc`, and the comment above claimed both while driving one.
   */
  for (const [name, query] of [
    ["a word", "abc"],
    ["an empty value", ""],
    ["a float", "1.9"],
    ["something enormous", "1e9"],
  ] as const) {
    const odd = await get(`/sessions?limit=${query}`, "u_alice");
    check(
      `${name} never returns more than the list holds`,
      odd.body.sessions.length <= 3 && odd.body.total === 3,
      true,
    );
  }
}

// Renaming is a POST too, and its positive control is stronger than `/config`'s:
// `setMeta` is deliberately allowed on a terminal session, so this asserts a real
// 200 and a real returned title rather than settling for "not 404". A route that
// 404s for everybody would pass the negative half alone — which is exactly how
// `stream` stayed green with its lookup deleted.
const metaOf = async (id: string, sub: string, body: unknown) =>
  app.fetch(
    new Request(`http://d/sessions/${id}/meta`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor(sub)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
check("meta is 404 for an id that does not exist", (await metaOf("s_nope", "u_alice", { title: "x" })).status, 404);
{
  const renamed = await metaOf("s_one", "u_alice", { title: "  Fix the\treconnect  " });
  check("and meta answers one that does", renamed.status, 200);
  // Normalized on the way in, and answered with the snapshot rather than an echo,
  // so a client never has to guess what was actually stored.
  check("with the normalized title, not the raw one", (await renamed.json() as any).session.title, "Fix the reconnect");
}
check(
  "renaming a session that has ended is allowed, not refused",
  (await metaOf("s_one", "u_alice", { pinned: true })).status,
  200,
);
check(
  "an over-long title is refused rather than silently clipped",
  (await metaOf("s_one", "u_alice", { title: "x".repeat(MAX_TITLE_CHARS + 1) })).status,
  400,
);
check("and an empty body is refused too", (await metaOf("s_one", "u_alice", {})).status, 400);
{
  // `null` clears, which is what re-arms derivation from the next prompt. It has
  // to be distinguishable from "field absent", which means leave it alone.
  const cleared = await metaOf("s_one", "u_alice", { title: null });
  check("null clears the title back to unnamed", (await cleared.json() as any).session.title, null);
}

// A DELETE with `machine:admin` still cannot invent a session. The scope widens
// what may be done to a row, never which rows exist.
const adminDelete = await app.fetch(
  new Request("http://d/sessions/s_nope/workspace", {
    method: "DELETE",
    headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
  }),
);
check("machine:admin cannot reach an id that does not exist", adminDelete.status, 404);

/**
 * A login id names its own run, and a superseded one names nothing.
 *
 * The rule used to be an ownership check across tenants; what it does now is stop
 * a **superseded** wizard — one whose client has not noticed it was replaced —
 * reading, or worse typing a one-time code into, its successor's stdin.
 *
 * The runtime is stubbed rather than the class, so everything real is exercised:
 * the identity check in `own`, the supersede rule, the `starting` serialisation,
 * the TTL sweep and the output cap. `login()` hands back three in-memory pipes
 * and a record of how it was stopped. Subclassing `LocalRuntime` rather than
 * hand-rolling the interface means a new required member of `SessionRuntime` is
 * a type error here rather than a silently untested path.
 */
process.stdout.write("\na login id names its own run\n");
{
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

  /** An `AgentProcess` that is three pipes, what was typed into it, and how it died. */
  function fakeLogin(): {
    process_: AgentProcess;
    typed: string[];
    stdout: PassThrough;
    stopped: string[];
  } {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const typed: string[] = [];
    const stopped: string[] = [];
    let exited = false;
    stdin.on("data", (chunk: Buffer) => void typed.push(chunk.toString("utf8")));
    const process_: AgentProcess = {
      stdin,
      stdout,
      stderr,
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      get hasExited(): boolean {
        return exited;
      },
      // EOF is the first rung of `dispose`'s ladder and both flows end on it, so
      // this stub never reaches SIGTERM — which is what makes `stopped` readable:
      // anything past "stdin" in it means the graceful path did not work.
      waitForExit: async () => {
        exited = true;
        return true;
      },
      endStdin: () => void stopped.push("stdin"),
      kill: async (signal: NodeJS.Signals) => void stopped.push(signal),
    };
    return { process_, typed, stdout, stopped };
  }

  class LoginRuntime extends LocalRuntime {
    readonly spawned: ReturnType<typeof fakeLogin>[] = [];
    override async login(_agent: AgentId): Promise<AgentProcess | null> {
      const made = fakeLogin();
      this.spawned.push(made);
      return made.process_;
    }
  }

  const runtime = new LoginRuntime();
  const warnings: string[] = [];
  const logins = new AgentLoginRuns({ runtime, onWarning: (detail) => void warnings.push(detail) });

  const claude = await logins.start("claude");
  if (claude === null) throw new Error("the stub runtime declined to start a login");
  check("a login run belongs to the agent it was started for", claude.agent, "claude");
  check("and starts with an empty transcript", claude.cursor, 0);

  // An id that names nothing gets nothing, on both verbs — a write is the half
  // that would otherwise type a one-time code into a flow it does not belong to.
  check("an id that names nothing reads nothing", logins.read("li_nope", 0), null);
  check("nor can it be written into", logins.write("li_nope", "123456").kind, "not_found");
  await settle();
  check("so nothing was typed into the live one", runtime.spawned[0]?.typed ?? ["?"], []);
  check("while its own id reads it", logins.read(claude.loginId, 0) !== null, true);
  logins.write(claude.loginId, "123456");
  await settle();
  // The newline is supplied here and not by the caller: these flows read a line,
  // and a client that had to remember it would be one that eventually forgot.
  check("and writes into it, with the newline supplied here", runtime.spawned[0]?.typed.join(""), "123456\n");

  check("cancelling by an id that is nobody's refuses", await logins.cancel("li_nope"), false);
  check("and the live one is untouched by that", logins.read(claude.loginId, 0) !== null, true);

  /*
   * A second login for the *same* agent supersedes rather than being refused.
   *
   * Refusing is the obvious choice and the wrong one: the commonest way one of
   * these ends is somebody closing the tab, which leaves a process waiting on
   * stdin with nobody to type into it — and "you already have a login in progress"
   * would then be a permanent wall in front of the one person who cannot get past
   * it any other way.
   */
  const again = await logins.start("claude");
  check("a second login for the same agent gets a new id", again?.loginId !== claude.loginId, true);
  check("the superseded one is stopped rather than left holding a pty", runtime.spawned[0]?.stopped, ["stdin"]);
  check("and its id no longer resolves", logins.read(claude.loginId, 0), null);

  /*
   * **A login for a different agent must not disturb it**, and leaving the agent
   * out of the key was a live defect rather than a hypothetical.
   *
   * Settings renders one wizard per agent, each with its own `sessionStorage`
   * entry, so both open at once is the normal state for somebody logging in to
   * claude *and* kimi. With one slot, starting the second superseded the first;
   * the superseded wizard's next 700ms poll answered 404 and it started over,
   * superseding the second. The two ping-ponged for ever with no backoff, each
   * cycle spawning a pty and then running the full kill ladder, and neither login
   * could ever complete.
   */
  const kimi = await logins.start("kimi");
  if (kimi === null) throw new Error("the stub runtime declined the second agent");
  check("a login for another agent leaves the first one alone", logins.read(again!.loginId, 0) !== null, true);
  check("and stopped nothing", runtime.spawned[1]?.stopped, []);
  check("and the two runs are on different agents", [again?.agent, kimi.agent], ["claude", "kimi"]);

  /*
   * The 64 KiB cap, from the front.
   *
   * A device-code flow produces a few hundred bytes, so reaching this at all means
   * something is spinning — and dropping the *newest* output would hide whatever
   * it is now saying. The gap flag is what stops a client silently stitching two
   * halves of a transcript together across the hole.
   */
  runtime.spawned[2]?.stdout.write("x".repeat(70 * 1024));
  await settle();
  const capped = logins.read(kimi.loginId, 0);
  check("a transcript past the cap keeps its tail", capped?.chunk.length, 64 * 1024);
  check("drops exactly the excess off the front", capped?.dropped, 70 * 1024 - 64 * 1024);
  check("counts everything ever produced, not what survives", capped?.cursor, 70 * 1024);
  check("and tells the client its cursor is behind the window", capped?.gap, true);

  /*
   * **The way round that cap, which is a chunk with no body at all.**
   *
   * `PARTIAL_ESCAPE`'s OSC branch matches an unterminated `\x1b]` of any length
   * anchored at the end, so a write that is *entirely* one yields `text === ""`
   * and a carry holding the whole thing — and that is precisely the shape the
   * `MAX_CARRY_BYTES` flush exists for. The flushed bytes went into the buffer
   * and then the function returned at `if (text.length === 0) return;`, which sat
   * *above* the only statement that trims the buffer. A CLI emitting one of these
   * per write grew this transcript with no ceiling at all for the run's whole
   * ten-minute TTL, while 64 KiB went on being documented as the bound, and the
   * wizard polls all of it.
   *
   * Thirty writes of a little over 4 KiB each: over `MAX_CARRY_BYTES` so every
   * one flushes, and 150 KiB in total so the cap has more than twice its own
   * width to bite on. Driven through the real pipes rather than by calling
   * `sanitize`, because `sanitize` was never the half that was wrong — it
   * returned exactly this pair all along.
   */
  const carrying = await logins.start("codex");
  if (carrying === null) throw new Error("the stub runtime declined the third agent");
  const opener = `\x1b]${"c".repeat(5_000)}`;
  for (let n = 0; n < 30; n += 1) runtime.spawned[3]?.stdout.write(opener);
  await settle();
  const flushed = logins.read(carrying.loginId, 0);
  // 5000 rather than 5002: `scrub` takes the `\x1b]` off, which is the second
  // half of the same fix and is asserted on its own two lines down.
  check("a transcript of nothing but unterminated escapes is still counted", flushed?.cursor, 30 * 5_000);
  check("and still bounded at the documented ceiling", flushed?.chunk.length, 64 * 1024);
  check("with the excess dropped off the front and reported", flushed?.dropped, 30 * 5_000 - 64 * 1024);
  /*
   * And what lands is scrubbed, which the flush used to skip. Those bytes reach
   * the buffer precisely *because* they are not an escape sequence, so they are
   * ordinary output — and raw they put ESC and the C0 range into a string the
   * client renders in a `<pre>`.
   */
  check("and no raw escape byte reaches a transcript rendered in a <pre>", flushed?.chunk.includes("\x1b"), false);

  /*
   * The TTL, on the clock rather than on traffic.
   *
   * The state it exists for produces no traffic at all: somebody closes the tab,
   * the polling stops, and nothing calls in again — so a sweep that ran only from
   * `start`/`read`/`write` could never observe the one case it was written for.
   * The clock is moved rather than the deadline, because `LOGIN_TTL_MS` is not
   * exported and a driver that reached for it would be shaping the code.
   */
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 11 * 60_000;
    check("an abandoned login is swept once its TTL passes", logins.read(kimi.loginId, 0), null);
  } finally {
    Date.now = realNow;
  }
  await settle();
  check("and its process is stopped, not left in the container", runtime.spawned[2]?.stopped, ["stdin"]);
  check("with a warning, since nothing in src/ prints", warnings.some((w) => w.includes("expired")), true);
}

/* ------------------------------------------------------------------ *
 * whether a login can be driven, which is two facts and not one
 *
 * `GET /agent-auth` reported `logins !== null` — that there is somewhere to
 * *record* a run — and called it `loginSupported`. The other half is whether the
 * host has a `script` to allocate a pty with, which `SessionRuntime` answers and
 * `LocalRuntime.login` refuses on by returning null. With only the first half a
 * daemon on a host without `script` said `true`, both clients drew the wizard off
 * it, and tapping it answered `503 login_unsupported` — the exact outcome the
 * field's own comment says it exists to prevent, on the one screen somebody
 * reaches when their agent has just refused a prompt.
 *
 * Driven through the route rather than by reading the property, because the bug
 * was never in the property: it was in the route not asking.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * the agent's command list, bounded at ingest
 *
 * `toCommands` is where the agent's own strings enter this process, and it is the
 * only place they are bounded: the list rides no event, so `truncateEvent` never
 * sees it, and it is served from its own route, so nothing downstream is willing
 * to shrink it. "Bounded by whatever the agent sent" is not a bound.
 *
 * Asserted directly rather than through a session, because what these are about
 * is a pathological *payload* — an MCP server publishing hundreds of prompts, a
 * description the length of a file — and standing up an agent that sends one is
 * not something a driver can do.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe agent's command list is bounded where it arrives\n");
{
  const plain = toCommands([
    { name: "compact", description: "Compact the conversation", input: { hint: "<instructions>" } },
    { name: "status", description: "Show status", input: null },
  ] as never);
  check("a well-formed list survives whole", plain.commands.length, 2);
  check("with its hint", plain.commands[0]?.hint, "<instructions>");
  check("and no hint is null rather than empty", plain.commands[1]?.hint, null);
  check("and nothing is reported dropped", plain.dropped, 0);

  // Dropped whole rather than half-stored — the rule `updateUsage` follows for a
  // reading it cannot read. A nameless command could never be typed anyway.
  const nameless = toCommands([
    { name: "", description: "no name", input: null },
    { name: "   ", description: "only spaces", input: null },
    { name: "ok", description: "fine", input: null },
  ] as never);
  check("a nameless command is dropped", nameless.commands.map((c) => c.name), ["ok"]);
  check("and counted", nameless.dropped, 2);

  // The agent's order is authoritative, so a duplicate keeps the first — and a
  // menu must never offer one name twice, since the second could not be reached.
  const dupes = toCommands([
    { name: "same", description: "first", input: null },
    { name: "same", description: "second", input: null },
  ] as never);
  check("a duplicate name keeps the first", dupes.commands.map((c) => c.description), ["first"]);
  // Counted, like every other cut. Skipping silently would make `dropped` say the
  // menu is complete when a row the agent published is missing from it.
  check("and the duplicate is counted, not swallowed", dupes.dropped, 1);

  /*
   * An over-long name is **refused**, not clipped, and it is the one field that
   * is. `clip` is a display truncator — it appends `…[truncated N bytes]` — which
   * is right for prose nobody types and wrong for a name, because a command is
   * invoked by *sending* `/<name>`. Clipping produced a row that could not be
   * used and, worse, dedup ran on the unclipped name while the stored one was
   * clipped, so two long names sharing a prefix became byte-identical with
   * `dropped` reporting none.
   */
  const longName = "n".repeat(70);
  const overlong = toCommands([
    { name: longName, description: "one", input: null },
    { name: `${longName}-and-more`, description: "two", input: null },
    { name: "ok", description: "fine", input: null },
  ] as never);
  check("a name too long to type is dropped rather than clipped", overlong.commands.map((c) => c.name), ["ok"]);
  check("and both of them are counted", overlong.dropped, 2);
  // The property the two above exist to protect, stated directly: whatever comes
  // out, no two rows may share a name, because the second could never be reached.
  const namesOf = (list: { commands: { name: string }[] }) => new Set(list.commands.map((c) => c.name)).size;
  check("no two commands ever share a name", [namesOf(overlong), namesOf(dupes)], [1, 1]);
  check("and every name that survives is sendable as typed", overlong.commands.every((c) => /^\S+$/.test(c.name)), true);

  const many = toCommands(
    Array.from({ length: 300 }, (_, index) => ({ name: `c${index}`, description: "x", input: null })) as never,
  );
  check("the list is capped", many.commands.length, 256);
  // Counted rather than swallowed, for the reason `truncateEvent`'s `agent_config`
  // arm gives: a picker missing rows silently offers the agent less than it has.
  check("and what was cut is reported, not swallowed", many.dropped, 44);

  const long = toCommands([{ name: "c", description: "d".repeat(4096), input: { hint: "h".repeat(500) } }] as never);
  // `<=` and not `===`: `clip` reserves room for its own note inside the budget,
  // so the ceiling is what is asserted rather than an exact length that would
  // change with the number of digits in the byte count.
  check("a runaway description is clipped to the ceiling", (long.commands[0]?.description.length ?? 0) <= 200, true);
  check("visibly, with this repo's own note", long.commands[0]?.description.endsWith("bytes]"), true);
  check("and so is a runaway hint", (long.commands[0]?.hint?.length ?? 0) <= 100, true);

  // The real thing, measured 2026-08-03 against claude 0.63.0: the longest hint
  // published on this machine is exactly 64 characters, which is why the cap is
  // above it rather than at it. A bound set to the largest thing you have seen is
  // a bound that clips the next one.
  const realHint = toCommands([
    { name: "effort", description: "Set effort level for model usage", input: { hint: "<low|medium|high|xhigh|max|ultracode|auto>" } },
  ] as never);
  check("a real hint is not clipped", realHint.commands[0]?.hint, "<low|medium|high|xhigh|max|ultracode|auto>");

  /*
   * The shapes an adapter can send that are not a well-formed list.
   *
   * The signature accepts `null | undefined` because `available_commands_update`
   * can arrive without the array, and every fixture above is well-formed — so the
   * arms that make the signature honest were the arms nothing reached.
   */
  check("nothing at all is an empty list", [toCommands(undefined), toCommands(null)], [
    { commands: [], dropped: 0 },
    { commands: [], dropped: 0 },
  ]);
  const malformed = toCommands([
    { name: "a", description: 42, input: { hint: "" } },
    { name: "b", description: null, input: {} },
  ] as never);
  // A description that is not a string collapses to empty rather than to the
  // literal `42`, and an empty hint is `null` — the same distinction the
  // well-formed case draws between "no hint" and "a hint of no characters".
  check("a description that is not a string becomes one", malformed.commands.map((c) => c.description), ["", ""]);
  check("and an empty hint is no hint", malformed.commands.map((c) => c.hint), [null, null]);
  check("neither is treated as a reason to drop the command", malformed.dropped, 0);

  /*
   * Whether a republished list is worth announcing.
   *
   * `usageWorthAnnouncing` one field over, and here for the same reason: the
   * *agent* decides the rate. claude republishes from `commands_changed`, which
   * fires as skills are discovered while it walks a subdirectory, so a byte-
   * identical list can arrive repeatedly inside one turn — and each bump costs a
   * snapshot, a row write and a frame per client here, plus a full refetch of the
   * list at every client over the relay.
   */
  const listOf = (...names: string[]) => toCommands(names.map((name) => ({ name, description: "d", input: null })) as never);
  check("an identical republish is not announced", sameCommands(listOf("a", "b"), listOf("a", "b")), true);
  check("a new command is", sameCommands(listOf("a", "b"), listOf("a", "b", "c")), false);
  check("and so is a reorder, since the agent's order is what a menu shows", sameCommands(listOf("a", "b"), listOf("b", "a")), false);
  check(
    "a description that changed under the same name is announced",
    sameCommands(listOf("a"), toCommands([{ name: "a", description: "different", input: null }] as never)),
    false,
  );
  check(
    "and so is a hint",
    sameCommands(listOf("a"), toCommands([{ name: "a", description: "d", input: { hint: "h" } }] as never)),
    false,
  );
  // `dropped` counts too: the same visible list with more cut off behind it is a
  // different answer to "is this menu complete", and a client draws that.
  check("a list that is the same but now cut is announced", sameCommands({ commands: [], dropped: 0 }, { commands: [], dropped: 3 }), false);
  check("withdrawing everything is announced", sameCommands(listOf("a"), { commands: [], dropped: 0 }), false);
  check("and an empty list republished empty is not", sameCommands({ commands: [], dropped: 0 }, { commands: [], dropped: 0 }), true);
}

/* ------------------------------------------------------------------ *
 * the login pty, on both platforms
 *
 * `hostLoginArgs` is pure for exactly this reason — the two `script`s take their
 * command differently and a machine is only ever one of them, so without an
 * assertion the other form is only ever exercised by shipping it. Getting it
 * wrong does not fail loudly either: the BSD form on Linux writes a file called
 * `claude` and records nothing, which looks like a login that simply never
 * printed anything.
 *
 * The quoting half matters for a reason the container version did not have: the
 * command is now an absolute path resolved off PATH or out of
 * `CLAUDE_CODE_EXECUTABLE`, so it can contain a space or a quote, and on the
 * util-linux side it is concatenated into one string handed to `/bin/sh -c`.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * is this agent signed in
 *
 * `available` only ever meant "the adapter is on PATH", so a logged-out agent
 * reported `true` and the person found out at `502 agent_auth_required`, after a
 * worktree had already been made. `loggedIn` is the real probe, and every branch
 * of it is about **disagreeing with the exit code**: measured 2026-07-31,
 * `claude auth status` prints `{"loggedIn": false, …}` and exits **1**, so a probe
 * that read the status could not tell a logged-out agent from a crash, a missing
 * binary, or a future version failing for its own reasons. The JSON says which.
 *
 * `boolean | null` for the same reason `Liveness` has three answers: kimi has no
 * non-interactive way to say, and rendering "cannot tell" as "logged out" puts a
 * login wizard in front of somebody whose agent works.
 *
 * Drivable at all because of `LocalRuntimeOptions.exec` and because
 * `resolveLoginBinary` reads `CLAUDE_CODE_EXECUTABLE` first — neither is a test
 * hook invented here, the second is the documented override for *which* build the
 * adapter drives.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * the reap fence
 *
 * `reap` is the only thing in this daemon that signals a process it did not
 * start, off a number read out of a database, so every arm of it is a decision
 * about whether to SIGKILL a stranger. Three of the four are assertable with no
 * process at all; the fourth uses this driver's own pid, which is alive and
 * predates nothing, and asserts the *decision* rather than delivering a signal.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe reap fence\n");
{
  const runtime = new LocalRuntime();
  const afterBoot = Date.now();

  const noHandle = runtime.reap(null, afterBoot, true);
  check("no recorded agent is confirmed dead", [noHandle.killed, noHandle.confirmedDead], [false, true]);

  // A row from the multi-tenant daemon. The number is a process group inside a
  // PID namespace that no longer exists, so it names nothing here — and guessing
  // would mean signalling whatever holds it on this host.
  const foreign = runtime.reap(
    { kind: "container", containerId: "c1", pgid: 4242, containerStartedAt: afterBoot },
    afterBoot,
    true,
  );
  check("a handle from the other runtime is not signalled", foreign.killed, false);
  check("and is not confirmed dead either, which would make the row terminal", foreign.confirmedDead, false);

  // The `os.uptime()` fence: a session created before this boot names a pid from
  // a numbering that has since been reset.
  const old = runtime.reap({ kind: "local", pid: process.pid }, 0, true);
  check("a pid predating this boot is left alone", [old.killed, old.confirmedDead], [false, false]);

  // Reaping disabled is a decision, not an absence of one: the pid is live and
  // recent, and it is still not signalled.
  const off = runtime.reap({ kind: "local", pid: process.pid }, afterBoot, false);
  check("and so is every pid when reaping is off", [off.killed, off.confirmedDead], [false, false]);

  // A pid nothing holds. `isAlive` says `dead`, which is the one answer that
  // confirms — `unknown` (EPERM, i.e. recycled to another user) must not.
  const gone = runtime.reap({ kind: "local", pid: 0x7ffffffe }, afterBoot, true);
  check("a pid nothing holds is confirmed dead without a signal", [gone.killed, gone.confirmedDead], [false, true]);
}

process.stdout.write("\nis this agent signed in\n");
{
  const previous = process.env["CLAUDE_CODE_EXECUTABLE"];
  process.env["CLAUDE_CODE_EXECUTABLE"] = join(sandbox, "claude-stub");

  let probeEnv: NodeJS.ProcessEnv = {};
  /**
   * What the probe was actually spawned as, per agent.
   *
   * The stub used to take `(_command, _args, env)` and drop everything but the
   * environment, which left the two facts that decide *which binary answers*
   * asserted nowhere: the resolved path, and the stream its answer is read from.
   * Both are table-driven now, and a table is only worth something if something
   * checks it is read — reverting `resolveLoginBinary` to `agent === "claude"`
   * kept every driver green while codex sessions ran one build and its login
   * drove another.
   */
  const spawned = new Map<string, { command: string; args: readonly string[]; stream: string }>();
  const probeAs = async (
    agent: AgentId,
    answer: string | null,
    secrets: Record<string, string> = {},
  ): Promise<boolean | null | undefined> => {
    const runtime = new LocalRuntime({
      exec: async (command, args, env, stream) => {
        probeEnv = env;
        spawned.set(`${command} ${args.join(" ")}`, { command, args, stream });
        return answer;
      },
      secrets: () => secrets,
    });
    const found = (await runtime.availability()).find((entry) => entry.id === agent);
    return found?.loggedIn;
  };
  const claudeSays = async (answer: string | null, secrets: Record<string, string> = {}) =>
    probeAs("claude", answer, secrets);

  check("logged in is what the JSON says", await claudeSays('{"loggedIn": true}'), true);
  // Exit 1 accompanies this in real life; the probe never sees the status.
  check("and so is logged out", await claudeSays('{"loggedIn": false}'), false);
  // The three ways of not knowing, which must never render as "logged out".
  check("output that is not JSON is `cannot tell`", await claudeSays("Error: something went wrong"), null);
  check("JSON without the field is too", await claudeSays('{"account": "someone"}'), null);
  check("and no output at all is too", await claudeSays(null), null);
  // The asymmetry the Settings screen depends on: a pasted credential is believed
  // over "cannot tell", because we are the ones who cannot tell — but a *clean*
  // false is the agent itself saying no, and that wins.
  check("a pasted credential beats not knowing", await claudeSays(null, { CLAUDE_CODE_OAUTH_TOKEN: "sk" }), true);
  // The other half, and it is the one that was wrong: the probe runs *with* the
  // pasted token, so an agent that still says no has seen it and rejected it.
  // Answering `true` there said "signed in" over a token the CLI would refuse,
  // and the first session then died on `502 agent_auth_required`.
  check(
    "but a clean `false` is believed over one",
    await claudeSays('{"loggedIn": false}', { CLAUDE_CODE_OAUTH_TOKEN: "sk" }),
    false,
  );
  check("because the probe was handed that token", probeEnv["CLAUDE_CODE_OAUTH_TOKEN"], "sk");
  // And the daemon's own configuration is not handed to it, for the same reason
  // an agent never sees it: this spawns a program and captures its output.
  check("and not this daemon's own environment", probeEnv["REEMOAT_TOKEN"], undefined);

  /*
   * **The override reaches the spawn, for every agent that has one.**
   *
   * `AGENT_LOGIN[agent].executableEnv` is asserted as data below; this is the
   * half that says it is *read*. Written as `agent === "claude"` — which is what
   * it was — codex's override chose the binary sessions ran while the login and
   * the probe went on resolving the vendored copy, and no driver noticed.
   *
   * Asserted through `availability()` rather than by calling the private method,
   * so what is pinned is the path a login and a status probe actually take.
   */
  const codexStub = join(sandbox, "codex-stub");
  const priorCodexPath = process.env["CODEX_PATH"];
  process.env["CODEX_PATH"] = codexStub;
  spawned.clear();
  check("codex reads as signed in from its own wording", await probeAs("codex", "Logged in using ChatGPT"), true);
  check("and as signed out", await probeAs("codex", "Not logged in"), false);
  // The third answer, which must never render as logged out.
  check("and anything else is cannot-tell", await probeAs("codex", "Checking…"), null);
  const codexProbe = [...spawned.values()].find((entry) => entry.command === codexStub);
  check("CODEX_PATH chose the binary the probe ran", codexProbe?.command, codexStub);
  check("with the status arguments from the table", codexProbe?.args, ["login", "status"]);
  /*
   * **And its answer is read from the stream that CLI answers on.**
   *
   * Measured: `codex login status` writes to stderr and nothing to stdout, while
   * `claude auth status` writes JSON to stdout. Reading the wrong one costs no
   * error anywhere — the probe sees an empty string, answers "cannot tell", and a
   * signed-in codex reports `status unknown` for ever. `LoginStatusProbe.stream`
   * existed and nothing asserted it was forwarded.
   */
  check("and read from stderr, where codex answers", codexProbe?.stream, "stderr");
  const claudeProbe = [...spawned.values()].find((entry) => entry.command !== codexStub);
  check("while claude's is read from stdout", claudeProbe?.stream, "stdout");
  check("and CLAUDE_CODE_EXECUTABLE chose its binary", claudeProbe?.command, join(sandbox, "claude-stub"));
  if (priorCodexPath === undefined) delete process.env["CODEX_PATH"];
  else process.env["CODEX_PATH"] = priorCodexPath;

  if (previous === undefined) delete process.env["CLAUDE_CODE_EXECUTABLE"];
  else process.env["CLAUDE_CODE_EXECUTABLE"] = previous;
}

process.stdout.write("\nthe login pty, on both platforms\n");
{
  // BSD keeps argv boundaries, so a space in the path needs no quoting and must
  // not acquire any: the path arrives as one element either way.
  check("BSD takes the command as argv after the typescript file", hostLoginArgs("darwin", "/usr/bin/claude", ["auth", "login"], "script"), {
    command: "script",
    args: ["-q", "/dev/null", "/usr/bin/claude", "auth", "login"],
  });
  check("a path with a space survives BSD as one argument", hostLoginArgs("darwin", "/Apps/My Tools/claude", ["auth"], "script").args, [
    "-q",
    "/dev/null",
    "/Apps/My Tools/claude",
    "auth",
  ]);

  // util-linux runs one string through `/bin/sh -c`, so every word is quoted.
  check("util-linux takes one shell string after -qec", hostLoginArgs("linux", "/usr/bin/claude", ["auth", "login"], "script"), {
    command: "script",
    args: ["-qec", "'/usr/bin/claude' 'auth' 'login'", "/dev/null"],
  });
  check(
    "and an unknown platform takes the util-linux form",
    hostLoginArgs("sunos" as NodeJS.Platform, "/usr/bin/kimi", ["login"], "script").args[0],
    "-qec",
  );
  check("a path with a space is one word to the shell", hostLoginArgs("linux", "/Apps/My Tools/claude", [], "script").args[1], "'/Apps/My Tools/claude'");
  // The one that would be a command injection if the escape were wrong: a single
  // quote must close, escape and reopen, so there is no way back out of the
  // string. `'` becomes `'\''`.
  check(
    "and a path with a quote cannot reopen the string",
    hostLoginArgs("linux", "/Apps/it's/claude", [], "script").args[1],
    String.raw`'/Apps/it'\''s/claude'`,
  );
  // The resolved `script` is used, not the bare name: a login is a child of the
  // daemon that runs your agents, and PATH order is not this module's to trust.
  check("the resolved script path is what is spawned", hostLoginArgs("linux", "/usr/bin/claude", [], "/usr/bin/script").command, "/usr/bin/script");

  /*
   * Whether the pty gets a stdin pipe, which is the fix for the defect above it.
   *
   * **The login wizard did not run on macOS at all, for any agent, and it was the
   * pipe.** BSD `script` reads its *own* stdin's termios to copy onto the pty it
   * is allocating, so a pipe makes it exit 1 with `script: tcgetattr/ioctl:
   * Operation not supported on socket` before the agent is reached. `/dev/null`
   * succeeds — so the fix is available exactly where the flow never reads input,
   * which `AGENT_LOGIN[agent].interactiveStdin` is what says.
   *
   * Both platforms from a machine that is only one of them, which is why this is
   * pure. All four combinations, because three of them are the ones that must
   * *not* change: claude keeps its pipe everywhere (its flow waits on a paste
   * prompt), and Linux keeps its pipe for everyone — util-linux `script` works
   * with one today, an immediate stdin EOF is a plausible way for it to decide
   * the session is over, and Linux is where this deploys.
   */
  check("a device-code flow on BSD gets no stdin", loginStdio("darwin", false), "ignore");
  check("an interactive flow on BSD keeps its pipe", loginStdio("darwin", true), "pipe");
  check("and Linux keeps its pipe either way", [loginStdio("linux", false), loginStdio("linux", true)], [
    "pipe",
    "pipe",
  ]);
  check(
    "which agents that leaves without an input box, per platform",
    AGENT_IDS.filter((id) => loginStdio("darwin", AGENT_LOGIN[id].interactiveStdin) === "ignore"),
    ["kimi", "codex"],
  );
  check(
    "claude is the one it cannot rescue, because its flow reads a code back",
    AGENT_LOGIN.claude.interactiveStdin,
    true,
  );

  /*
   * Which agents can be signed *out*, which is not the same set as signed in.
   *
   * Measured 2026-08-08 from each CLI's own `--help`: claude has `auth logout`,
   * codex has `logout` ("Remove stored authentication credentials"), kimi has no
   * such verb at all. Nullable rather than a third row of arguments precisely so
   * the client draws no button for the one that cannot, instead of one that
   * always errors — and pinned by name rather than by count, because the count
   * is the part that looks right.
   */
  check(
    "the agents with a sign-out command",
    AGENT_IDS.filter((id) => AGENT_LOGIN[id].logoutArgs !== null).map((id) => [
      id,
      AGENT_LOGIN[id].logoutArgs,
    ]),
    [
      ["claude", ["auth", "logout"]],
      ["codex", ["logout"]],
    ],
  );
  check("and kimi is the one without", AGENT_LOGIN.kimi.logoutArgs, null);
}

/*
 * The login table, which is data and is therefore assertable without a binary.
 *
 * Every agent added since has widened `Record<AgentId, …>` and been caught by the
 * compiler, so nothing here is guarding against a *missing* entry. What it guards
 * is the entries whose value is a measurement — a flag that turns a headless login
 * into one nobody can complete, a variable name the CLI does not actually read —
 * because those are wrong silently and only on the machine that has no browser.
 */
process.stdout.write("\neach agent's login, as it is written down\n");
{
  check("every agent in the union has a login entry", AGENT_IDS.every((id) => AGENT_LOGIN[id] !== undefined), true);

  /*
   * **Codex's login must stay `--device-auth`.**
   *
   * Measured 2026-08-07, and the flag is present on the vendored 0.145.0 the
   * adapter actually spawns as well as the 0.146.1 on PATH: a bare `codex login`
   * binds a local
   * server on port 1455 and waits for a browser to come back to it, which on this
   * daemon is a wizard that can never finish — nobody is at that machine's browser
   * and the relay does not carry 1455. The CLI says so itself, printing "On a
   * remote or headless machine? Use `codex login --device-auth` instead."
   *
   * Asserted rather than trusted because dropping the flag leaves a login that
   * still *starts*, prints a URL nobody can open, and times out — indistinguishable
   * from a network problem.
   */
  check("codex logs in by device code, not by browser", AGENT_LOGIN.codex.args, ["login", "--device-auth"]);
  check(
    "and its pty spawn carries that flag through",
    hostLoginArgs("darwin", "/usr/bin/codex", AGENT_LOGIN.codex.args, "script").args,
    ["-q", "/dev/null", "/usr/bin/codex", "login", "--device-auth"],
  );

  /*
   * The name of the variable a pasted credential is stored under, which is the one
   * field on this table that has been wrong before — kimi's entry and its own
   * `authHint` still disagree, in writing, at `resolveAgent`.
   *
   * Measured for codex rather than inferred: `CODEX_API_KEY` is sent (the API
   * answers `invalid_api_key`, i.e. it saw a key and refused it) while
   * `OPENAI_API_KEY` is not (the API answers "Missing bearer", i.e. nothing was
   * sent). The obvious name is the wrong one, which is exactly why this is pinned.
   */
  check("codex's pasted credential is CODEX_API_KEY", credentialEnvNames("codex"), ["CODEX_API_KEY"]);
  check("and OPENAI_API_KEY is not offered, because codex does not read it", credentialEnvNames("codex").includes("OPENAI_API_KEY"), false);

  /*
   * Which agents have a variable naming their binary, and it is **two**.
   *
   * This asserted "only claude" and was wrong: `CODEX_PATH` is read by codex-acp's
   * own `startAcpServer()` and chooses the CLI a *session* runs. Missing it meant
   * the login and the signed-in probe resolved the vendored copy while sessions ran
   * whatever `CODEX_PATH` named — a login that appears to work and changes nothing,
   * which is the failure the vendored-copy preference exists to prevent.
   *
   * Pinned by name rather than by count, because the count was the part that
   * looked right.
   */
  check(
    "the agents whose binary an env var names",
    AGENT_IDS.filter((id) => AGENT_LOGIN[id].executableEnv !== null).map((id) => [id, AGENT_LOGIN[id].executableEnv]),
    [
      ["claude", "CLAUDE_CODE_EXECUTABLE"],
      ["codex", "CODEX_PATH"],
    ],
  );
  // That neither survives only by accident is asserted where `agentEnv` is, below.
}

/*
 * Reading a CLI's own answer to "am I signed in", in both formats.
 *
 * Unreachable from a machine with neither CLI installed, which is what makes it
 * worth extracting and asserting: every branch is a way to be wrong quietly, and
 * the one that matters most is the third answer — anything unrecognised has to be
 * "cannot tell", never "logged out", or somebody whose agent works perfectly is
 * shown a wizard.
 */
process.stdout.write("\nwhat a login status command said\n");
{
  const claude = AGENT_LOGIN.claude.status;
  const codex = AGENT_LOGIN.codex.status;
  // Narrowed rather than cast, which also states the shapes: the two CLIs that can
  // answer answer in different formats, and reading one as the other is silent.
  if (claude === null || claude.reads !== "json") throw new Error("claude's status probe is supposed to read JSON");
  if (codex === null || codex.reads !== "text") throw new Error("codex's status probe is supposed to read prose");

  check("claude's JSON says signed in", readLoginAnswer(claude, `{"loggedIn": true}`), true);
  check("and says signed out", readLoginAnswer(claude, `{"loggedIn": false}`), false);
  // Output that is not JSON is a future version or an error on stdout. Neither is
  // "logged out", and reading it as one is what puts a login wizard in the way.
  check("and anything that is not JSON is cannot-tell", readLoginAnswer(claude, "command not found"), null);
  check("including JSON without the field", readLoginAnswer(claude, `{"account": "x"}`), null);

  // Every wording the codex binary carries, so a login by any of the four methods
  // reads as signed in. `Not logged in` is the only negative it prints.
  for (const line of [
    "Logged in using ChatGPT",
    "Logged in using an API key - sk-…",
    "Logged in using personal access token",
    "Logged in using Amazon Bedrock API key",
  ]) {
    check(`codex's "${line.slice(0, 24)}…" reads as signed in`, readLoginAnswer(codex, line), true);
  }
  check("codex's Not logged in reads as signed out", readLoginAnswer(codex, "Not logged in"), false);
  /*
   * **Which stream the answer is on**, which was assumed and was wrong.
   *
   * Measured: `codex login status` prints its answer on stderr and writes nothing
   * to stdout, while `claude auth status` prints JSON on stdout. Reading the wrong
   * one costs no error anywhere — the probe simply sees an empty string, answers
   * "cannot tell", and a signed-in codex reports `status unknown` in `GET /agents`
   * for ever. Pinned here because that is invisible until somebody looks at the
   * Settings screen and disbelieves it.
   */
  check("codex answers on stderr and claude on stdout", [codex.stream, claude.stream], ["stderr", "stdout"]);
  /*
   * The substring trap, which is why `signedOut` is tested first.
   *
   * "Logged in" is a substring of "Not logged in", so a pattern pair applied in the
   * other order — or either one loosened to drop its anchor — reports a logged-out
   * agent as signed in. That failure is invisible until somebody's first session
   * answers `502 agent_auth_required`.
   */
  check("and is not read as signed in by the substring", codex.signedIn.test("Not logged in"), false);
  // A CLI that grew a banner still has its answer read: the patterns are per-line.
  check("a preamble above the answer does not hide it", readLoginAnswer(codex, "codex 0.146.1\nNot logged in"), false);
  check("anything else is cannot-tell", readLoginAnswer(codex, "Checking…"), null);
}

/*
 * What a spawned agent inherits, which is hygiene rather than a fence — the agent
 * runs as this uid and can read the env file — but three of the four things it
 * prevents end up somewhere permanent.
 */
process.stdout.write("\nthe environment an agent is spawned with\n");
{
  const saved = { ...process.env };
  process.env["CODEX_THREAD_ID"] = "parent-thread";
  process.env["CODEX_SANDBOX_NETWORK_DISABLED"] = "1";
  process.env["CODEX_HOME"] = "/somewhere/else";
  process.env["CODEX_PATH"] = "/opt/codex";
  process.env["CLAUDE_CODE_SESSION_ID"] = "parent-session";
  process.env["CLAUDE_CODE_EXECUTABLE"] = "/opt/claude";
  process.env["REEMOAT_TOKEN"] = "secret";

  const env = agentEnv();
  /*
   * Both halves matter and they are opposite mistakes.
   *
   * A daemon started from inside a codex session inherits that session's
   * variables, and two of them are worse than untidy on the way down:
   * `CODEX_THREAD_ID` names the parent's conversation, and
   * `CODEX_SANDBOX_NETWORK_DISABLED=1` silently takes the network away from a
   * fresh agent nobody confined — which reads as "the model cannot fetch anything
   * today" rather than as configuration.
   */
  check("a parent codex session's thread does not reach the child", env["CODEX_THREAD_ID"], undefined);
  check("nor does its sandbox, which would confine an agent nobody confined", env["CODEX_SANDBOX_NETWORK_DISABLED"], undefined);
  check("nor a parent claude session", env["CLAUDE_CODE_SESSION_ID"], undefined);
  check("nor this daemon's own configuration", env["REEMOAT_TOKEN"], undefined);
  /*
   * The other direction: these three are deliberate overrides, and an operator who
   * set one meant it. Stripping them by a `CODEX_`/`CLAUDE_` prefix sweep would
   * point codex at the wrong credentials, codex at the wrong binary, and claude at
   * the wrong binary — the last two silently, since the wrong binary still runs.
   *
   * `CODEX_PATH` and `CODEX_HOME` are the pair most easily confused: one names the
   * binary and one names the credentials, and only the first is
   * `AGENT_LOGIN.codex.executableEnv`.
   */
  check("but CODEX_HOME survives, because it is an override and not a session", env["CODEX_HOME"], "/somewhere/else");
  check("and CODEX_PATH survives, which is the binary rather than the credentials", env["CODEX_PATH"], "/opt/codex");
  check("and so does CLAUDE_CODE_EXECUTABLE", env["CLAUDE_CODE_EXECUTABLE"], "/opt/claude");

  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
}

/*
 * Where each adapter is spawned from.
 *
 * Reads disk, so it is conditional on the adapter being installed — but it is the
 * one assertion that catches an adapter renamed, moved, or dropped from
 * `package.json`, which otherwise surfaces as `AgentUnavailableError` on somebody's
 * first session.
 */
process.stdout.write("\nhow each agent is launched\n");
{
  for (const id of AGENT_IDS) {
    let config: AgentLaunchConfig | null = null;
    try {
      config = resolveAgent(id);
    } catch {
      // Not installed here. kimi is resolved from PATH and is legitimately absent
      // on a machine that has never had it; the two vendored adapters are not.
    }
    if (id === "kimi") {
      /*
       * **A skip, never a fallback.** This read `config?.args ?? ["acp"]`, which
       * supplied the expected value whenever kimi was absent — so on CI and on any
       * machine without it, the check passed by construction and asserted nothing.
       * That is the outcome `pincheck`'s header calls the only one worse than no
       * check at all, reintroduced one file over.
       */
      if (config === null) {
        process.stdout.write("  skip  kimi is not installed here, so its launch shape is unasserted\n");
      } else {
        check("kimi is launched as an ACP subcommand of the CLI itself", config.args, ["acp"]);
      }
      continue;
    }
    // Both vendored adapters speak ACP on stdio with no arguments at all. An
    // argument appearing here would mean the adapter changed how it is started.
    check(`${id}'s adapter is resolvable and takes no arguments`, config?.args, []);
    check(`and ${id} says which binary it is`, (config?.displayName ?? "").length > 0, true);
  }
}

process.stdout.write("\nwhether a login can be driven\n");
{
  const appFor = (loginSupported: boolean) => {
    class PtyRuntime extends LocalRuntime {
      override get loginSupported(): boolean {
        return loginSupported;
      }
      override async login(): Promise<AgentProcess | null> {
        return null;
      }
    }
    const own = new SessionRegistry(new MemoryEventStore(), null, undefined, new PtyRuntime());
    return createApp({
      registry: own,
      verifier,
      instanceId: "i_pty",
      startedAt: now,
      credentials,
      roots: [users],
      logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
    }).app;
  };

  const listing = async (loginSupported: boolean): Promise<boolean> => {
    const response = await appFor(loginSupported).fetch(
      new Request("http://d/agent-auth", { headers: { authorization: `Bearer ${tokenFor("u_a")}` } }),
    );
    return (JSON.parse(await response.text()) as { loginSupported: boolean }).loginSupported;
  };

  check("a host with a pty to allocate says so", await listing(true), true);
  // The half that was missing. A run registry exists in both cases, so this is
  // false only if the route asks the runtime.
  check("a host without one says so too, rather than 503ing on tap", await listing(false), false);
}

process.stdout.write("\ntwo tabs, and the shutdown that follows\n");
{
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

  /** As above, but counted: what matters here is how many were ever spawned. */
  class CountingRuntime extends LocalRuntime {
    readonly stopped: string[][] = [];
    override async login(): Promise<AgentProcess | null> {
      const record: string[] = [];
      this.stopped.push(record);
      const stdin = new PassThrough();
      let exited = false;
      return {
        stdin,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        get hasExited(): boolean {
          return exited;
        },
        waitForExit: async () => {
          exited = true;
          return true;
        },
        endStdin: () => void record.push("stdin"),
        kill: async (signal: NodeJS.Signals) => void record.push(signal),
      };
    }
  }

  const runtime = new CountingRuntime();
  const logins = new AgentLoginRuns({ runtime });

  /*
   * Two concurrent starts, which is not a rare race: two tabs on Settings does
   * it, and React's development double-mount does it every time.
   *
   * `start` has two awaits before it records anything, so without the `starting`
   * map both callers got past the cancel (the map is still empty), both spawned,
   * and the second `set` won. The loser was then unreachable — not in `byAgent`,
   * so `sweep`, `cancel` and `shutdown` all iterate straight past it — and its
   * pty sat there until the daemon exited. Serialising is the
   * answer rather than refusing the second call, because the supersede above is
   * deliberate and has to keep working.
   */
  const [first, second] = await Promise.all([logins.start("claude"), logins.start("claude")]);
  await settle();
  check("two concurrent starts leave exactly one run reachable", [
    logins.read(first?.loginId ?? "", 0) !== null,
    logins.read(second?.loginId ?? "", 0) !== null,
  ], [false, true]);
  check("and the loser was disposed rather than orphaned", runtime.stopped[0], ["stdin"]);
  check("while the survivor is untouched", runtime.stopped[1], []);

  /*
   * Shutdown drains twice around the in-flight starts, and both halves are needed.
   * The flag makes a start that has not spawned yet refuse; awaiting `starting`
   * catches one that already has, because `doStart` re-checks the flag after its
   * awaits and disposes rather than recording. Draining the map alone left
   * whichever of those landed a microsecond later running past `process.exit(0)`.
   */
  await logins.shutdown();
  check("shutdown stops the live run", runtime.stopped[1], ["stdin"]);
  check("and a start afterwards refuses", await logins.start("claude"), null);
  check("without spawning anything to leave behind", runtime.stopped.length, 2);
}

/* ------------------------------------------------------------------ *
 * The database, across a restart
 * ------------------------------------------------------------------ */

/**
 * The store the daemon actually runs on, which no driver had ever opened.
 *
 * Every other section here builds a registry from a stub `SessionStore`, so
 * `openStores` had exactly one call site in the repository — `scripts/daemon.ts`
 * — and `migrate()`, the schema-version guard, the widened upsert and the credential
 * store were reached only by starting a real daemon.
 *
 * That matters more than it sounds because `put()`'s failure handler is a bare
 * `catch {}`, deliberately: it runs on the agent's state-change path, where a
 * bookkeeping fault must not unwind a turn. The cost is that a placeholder in the
 * statement that no key of `toParams` answers to would make **every session write
 * fail, silently and permanently**, and the daemon would look perfectly healthy
 * until it restarted with nothing to restore. Only a reopen can see that, so this
 * writes with one bundle and reads with a second.
 */
process.stdout.write("\nthe database, across a restart\n");
{
  const dbPath = join(sandbox, "store", "reemoat.db");
  const old = now - 30 * 24 * 60 * 60 * 1000;
  const week = 7 * 24 * 60 * 60 * 1000;
  const persisted = (id: string, meta: { title?: string | null; pinned?: boolean } = {}) =>
    rowFor(id, join(sandbox, "store-work", id), meta);

  {
    const first = openStores({ path: dbPath, instanceId: "i_writer" });
    first.sessions.put({ ...persisted("s_named"), title: "Fix the reconnect", pinned: true });
    first.sessions.put(persisted("s_plain"));
    first.credentials.save("claude", "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01");
    first.credentials.save("kimi", "KIMI_API_KEY", "kimi-key");
    first.uploads.insert({
      sessionId: "s_named",
      uploadId: "u_keepme",
      name: "shot.png",
      origName: "Screen Shot.png",
      mime: "image/png",
      bytes: 4096,
      createdAt: now,
      consumedAt: null,
    });
    first.close();
  }

  const second = openStores({ path: dbPath, instanceId: "i_reader" });
  const rows = second.sessions.list();
  // The assertion that catches a swallowed write: the rows are *there at all*.
  check("a session written by one daemon is there for the next", rows.map((r) => r.id).sort(), ["s_named", "s_plain"]);
  const named = rows.find((r) => r.id === "s_named");
  // v5's two columns, and the only ones on this table meant to change after
  // creation — so they are the only ones a `DO UPDATE` clause has to carry.
  check("a title survives the restart", named?.title, "Fix the reconnect");
  check("and so does a pin", named?.pinned, true);
  const plain = rows.find((r) => r.id === "s_plain");
  // `null` and `false`, never `"null"` and `true`: the columns are NULL for every
  // row written before v5, and `String(null)` would name a session "null".
  check("a session written without them reads back unnamed", plain?.title, null);
  check("and unpinned", plain?.pinned, false);

  check("the file is stamped with the version it now matches", Number(second.db.prepare("PRAGMA user_version").get()?.["user_version"]), SCHEMA_VERSION);

  /*
   * The half that decides SQLite over a map, and it is not the transcript half.
   *
   * A `prompt` event carries name/mime/bytes, so an attachment is describable
   * from the log alone — an in-memory registry would pass that test. What it
   * fails is the **accounting**: a restart would reset every session's byte total
   * to zero, and a daemon restart is the ordinary outcome of `deploy.sh`, so one
   * session could write the whole 100 MiB quota again after every one.
   *
   * These two assertions are what fail the day somebody simplifies the index
   * into a `Map`.
   */
  check("a staged upload survives the restart", second.uploads.get("s_named", "u_keepme")?.name, "shot.png");
  /*
   * `consumed_at` round-trips, and this is asserted against the **real** store on
   * purpose.
   *
   * It was hardcoded `NULL` in the insert while `keepAgentImage` set it, so every
   * image an agent returned counted as unconsumed and the 24-hour sweep would
   * have deleted it out from under a transcript still pointing at it. The
   * in-memory `UploadIndex` used elsewhere in this driver honours the field, so
   * the stub passed while the thing that ships did not — which is the whole
   * argument for checking the durable path here rather than only the fake one.
   */
  check("an unconsumed upload reads back unconsumed", second.uploads.get("s_named", "u_keepme")?.consumedAt, null);
  // A session of its own, so this does not perturb the byte-budget assertion
  // two lines up — the counters here are per session and shared fixtures drift.
  second.uploads.insert({
    sessionId: "s_agentimg",
    uploadId: "a_agentimage",
    name: "image-x.png",
    origName: "image-x.png",
    mime: "image/png",
    bytes: 12,
    createdAt: now,
    consumedAt: now,
  });
  check("and a consumed one reads back consumed", second.uploads.get("s_agentimg", "a_agentimage")?.consumedAt, now);
  // The consequence the field exists for: the TTL sweep must not see it.
  check(
    "so the unconsumed sweep never sees it",
    second.uploads.expired(now + 1).map((r) => r.uploadId),
    ["u_keepme"],
  );
  check("and so does what it spends of the session's budget", second.uploads.bytesFor("s_named"), 4096);
  // Keyed on the pair: an id belonging to another session reads as missing rather
  // than as somebody else's file, which is what lets the routes answer without
  // choosing between a 403 and a leak.
  check("but not under another session's id", second.uploads.get("s_plain", "u_keepme"), null);

  // v6 rekeyed this table to (agent, env_name). `envFor` is the one method that
  // hands a secret out, and it is keyed on the agent for that reason: the answer
  // is "what does *this* agent read", never "what is stored".
  check("a credential comes back as its agent's environment", second.credentials.envFor("claude"), {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01",
  });
  check("and another agent's is its own", second.credentials.envFor("kimi"), { KIMI_API_KEY: "kimi-key" });
  check("the listing is metadata only", second.credentials.list().map((c) => `${c.agent}:${c.envName}`).sort(), [
    "claude:CLAUDE_CODE_OAUTH_TOKEN",
    "kimi:KIMI_API_KEY",
  ]);
  check("and never the secret itself", JSON.stringify(second.credentials.list()).includes("sk-ant-oat01"), false);
  second.credentials.remove("kimi", "KIMI_API_KEY");
  check("removing one leaves the other", second.credentials.list().map((c) => c.agent), ["claude"]);
  check("and really removes it", second.credentials.envFor("kimi"), {});

  /*
   * **A pin survives the age sweep**, and it did not.
   *
   * `server.ts`'s `listRank` already treats a pin as durable — "a `?limit=` cut
   * that dropped it would make the pin a lie" — and this statement made it a lie by
   * a slower route: the API cut kept a pinned session and the startup prune deleted
   * it, with its whole transcript, at seven days. Two halves of one system
   * disagreeing about what a pin means, and the destructive half was the one that
   * disagreed. The bound is not lost, it moves to the count cap, where pins rank
   * first — so this asserts both directions on rows of exactly the same age.
   */
  second.sessions.put({ ...persisted("s_old_pinned", { pinned: true }), createdAt: old });
  second.sessions.put({ ...persisted("s_old_plain"), createdAt: old });
  second.sessions.prune({ retainMs: week, maxSessions: 200 });
  const afterAge = second.sessions.list().map((r) => r.id);
  check("an old unpinned session is swept", afterAge.includes("s_old_plain"), false);
  check("and an old pinned one of the same age is kept", afterAge.includes("s_old_pinned"), true);
  check("while a recent session is untouched either way", afterAge.includes("s_plain"), true);

  /*
   * A credential is deleted only when **both** halves are true, and the pairing is
   * the whole rule.
   *
   * Age alone would destroy a working token, since `updated_at` moves only when a
   * new one is pasted. "Nothing left" alone would destroy the token of somebody
   * who pasted it *before* their first session, which is precisely the flow
   * Settings encourages. Together they mean "nothing has run here in a retention
   * period and there is nothing left", which is the only state where destroying a
   * recoverable secret is obviously right.
   */
  const ageAll = (): void =>
    void second.db.prepare("UPDATE agent_credentials SET updated_at = ?").run(old);
  ageAll();
  second.sessions.prune({ retainMs: week, maxSessions: 200 });
  check("an old credential is kept while any session remains", second.credentials.list().length, 1);

  // Now empty the table of sessions, which is the other half of the condition.
  for (const row of second.sessions.list()) second.sessions.remove(row.id);
  second.sessions.prune({ retainMs: week, maxSessions: 200 });
  check("and is swept once nothing is left at all", second.credentials.list(), []);

  second.close();
}

/* ------------------------------------------------------------------ *
 * The v6 migration, which is the only step here that destroys data
 * ------------------------------------------------------------------ */

/*
 * A hand-built v5 file, opened by this daemon, inspected afterwards.
 *
 * What a session changed, against a real repository.
 *
 * `changes.ts` had no driver at all — and `server.ts` carries
 * `maxChangedFiles`/`maxDiffBytes` with the comment "both tunable so the
 * truncation paths can be exercised without 2000 files", seams built for tests
 * nobody wrote. This uses them.
 *
 * A real `git` rather than a stub runner, deliberately. Every rule worth
 * asserting here is a rule about what git actually *prints* — two commands that
 * disagree about field order, an exit status that means success, a header whose
 * replacement string has its own grammar — and a stub would be this driver
 * asserting its own idea of git's output.
 */
process.stdout.write("\nwhat a session changed\n");
{
  const repo = join(sandbox, "repo");
  mkdirSync(repo, { recursive: true });
  /*
   * `-c` for identity rather than a written config, and `--initial-branch` because
   * a host whose git predates the default-branch flag would otherwise print a
   * hint to stderr and pick something this driver did not choose.
   */
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", repo, "-c", "user.name=daemoncheck", "-c", "user.email=d@example.invalid", ...args], {
      stdio: "pipe",
    });
  };
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo], { stdio: "pipe" });
  /*
   * **Pinned in the repository's own config, because otherwise this fixture reads
   * the developer's `~/.gitconfig`.** `gitEnv` forwards `HOME` and
   * `XDG_CONFIG_HOME` and `gitArgs` prepends only `-C <dir>`, so every setting a
   * person carries in their global config reaches `hostGit` — and three of them
   * change what the parsers below are handed:
   *
   *   `diff.renames=false`      the rename becomes an add plus a delete, and the
   *                             `2` record this fixture exists to parse never
   *                             appears at all
   *   `diff.noprefix=true`      `--no-index` emits `+++ fresh.txt` with no `b/`,
   *                             so the header-rewrite assertions read a header
   *                             that was never in the shape being asserted
   *   `diff.mnemonicPrefix`     `a/`+`b/` become `i/`+`w/`, same failure
   *
   * Local config outranks global, so four lines here make this driver measure
   * `changes.ts` rather than measuring whoever is running it. Set on the fixture
   * rather than by clearing `HOME`, because the point is to pin the values the
   * parsers were written against, not to have no values.
   */
  git("config", "diff.renames", "true");
  git("config", "status.renames", "true");
  git("config", "diff.noprefix", "false");
  git("config", "diff.mnemonicPrefix", "false");
  writeFileSync(join(repo, "kept.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "moves.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
  writeFileSync(join(repo, "gone.txt"), "delete me\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");

  const info = await inspectRepo(repo, hostGit);
  check("the fixture really is a repository", [info.isRepo, info.insideWorkTree], [true, true]);

  const workspace: SessionWorkspace = {
    mode: "plain",
    root: repo,
    requestedCwd: repo,
    git: {
      repoRoot: info.mainRoot ?? repo,
      commonDir: info.commonDir ?? join(repo, ".git"),
      branch: info.headBranch,
      createdBranch: false,
      baseCommit: info.headCommit ?? "HEAD",
    },
    plainReason: null,
    createdAt: now,
  };

  // One of each shape the parsers have to tell apart.
  writeFileSync(join(repo, "kept.txt"), "one\nTWO CHANGED\nthree\n");
  execFileSync("git", ["-C", repo, "mv", "moves.txt", "moved.txt"], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "rm", "--quiet", "gone.txt"], { stdio: "pipe" });
  writeFileSync(join(repo, "fresh.txt"), "brand new\n");
  // The name that broke the header rewrite. `$&` is the whole match in a string
  // replacement, so a path carrying it spliced the absolute path back in.
  writeFileSync(join(repo, "a$&b.txt"), "dollar ampersand\n");
  // An untracked file with a NUL in it, which is git's own binary heuristic and
  // the one answer `--numstat` cannot give: an untracked path has no blob, so it
  // appears in no diff and nothing but reading the bytes can classify it.
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  symlinkSync(join(repo, "kept.txt"), join(repo, "link.txt"));
  // Two links, because git tells us about them differently — see below.
  symlinkSync(join(repo, "kept.txt"), join(repo, "staged-link.txt"));
  execFileSync("git", ["-C", repo, "add", "staged-link.txt"], { stdio: "pipe" });

  const listed = await listChanges(workspace, {
    runner: hostGit,
    base: "session",
    includeIgnored: false,
    limit: DEFAULT_MAX_CHANGED_FILES,
  });
  if (listed.supported) {
    const byPath = new Map(listed.files.map((file) => [file.path, file]));
    check(
      "every kind of change is found, and named by its new path",
      [...byPath.keys()].sort(),
      ["a$&b.txt", "blob.bin", "fresh.txt", "gone.txt", "kept.txt", "link.txt", "moved.txt", "staged-link.txt"],
    );
    check("an edit is modified", byPath.get("kept.txt")?.status, "modified");
    check("a file the agent made is untracked rather than added", byPath.get("fresh.txt")?.status, "untracked");

    /*
     * ⚠ **This answer used to be computed inside the parser, synchronously.**
     * `mergeStatus` called `lstatSync` + `openSync` + `readSync` + `closeSync`
     * once per untracked record, on the event loop, on a tree this daemon did not
     * create — up to the file cap before the cap even applies, and unbounded on a
     * mount that pauses. `stall.ts`'s own docblock cited it as an acceptable
     * exception because these are "paths git has just reported"; git having
     * listed a path says nothing about whether the *next* syscall returns, and
     * for a `plain` session the root is a directory the caller named.
     *
     * It is `markBinary` now — after the cap, through `probeBinary`'s deadline.
     * The behaviour has to be identical, which is what these two assert: new
     * files are the bulk of what an agent produces, and reporting every one of
     * them as text would offer a diff of a PNG.
     */
    check("an untracked file with a NUL in it is binary", byPath.get("blob.bin")?.binary, true);
    check("and an untracked text file is not", byPath.get("fresh.txt")?.binary, false);
    check("a removal is deleted", byPath.get("gone.txt")?.status, "deleted");

    /*
     * The rename, and the reason a shared "read two path tokens" helper would be
     * a bug rather than a simplification: `status --porcelain=v2` emits
     * `<newPath>` then `<origPath>`, while `diff --raw -z` and `--numstat -z`
     * emit `<srcPath>` then `<dstPath>`. `changes.ts` parses both, so one helper
     * would invert every rename in exactly one of them.
     */
    check("a rename is renamed", byPath.get("moved.txt")?.status, "renamed");
    check("naming where it came from, not just where it went", byPath.get("moved.txt")?.oldPath, "moves.txt");
    check("and never the other way round", byPath.get("moves.txt"), undefined);

    /*
     * **The listing knows a symlink only when git tells it the mode**, and git
     * tells it only for a path it is tracking: `symlink` comes off the worktree
     * mode of a porcelain-v2 `1`/`2`/`u` record, and an untracked path is a `?`
     * record with no mode at all. So the flag is a hint on the listing rather
     * than a guarantee — asserted in both directions, because a reader who found
     * only the `true` case would reasonably conclude it can be trusted.
     *
     * Nothing security-relevant rests on it. `diffFile` decides with its own
     * `lstat` on the path, which is what actually stops a link being followed,
     * and that is asserted below for the *untracked* one — the case this flag
     * gets wrong.
     */
    check("a tracked symlink is reported as one, from its mode", byPath.get("staged-link.txt")?.symlink, true);
    check("an untracked one is not, because git sends no mode for it", byPath.get("link.txt")?.symlink, false);
    check("and every path here can be asked about over JSON", listed.files.every((file) => file.addressable), true);
    check("the base is the commit the session started from", listed.base, info.headCommit);
    check("nothing was cut", listed.truncated, null);
  } else {
    check("the change set is supported", listed.supported, true);
  }

  const changeFor = (path: string): FileChange => {
    if (!listed.supported) throw new Error("unreachable: asserted above");
    const found = listed.files.find((file) => file.path === path);
    if (!found) throw new Error(`no change for ${path}`);
    return found;
  };
  const diffOpts = { runner: hostGit, base: "session" as const, contextLines: 3, maxBytes: DEFAULT_MAX_DIFF_BYTES };

  {
    const diff = await diffFile(workspace, changeFor("kept.txt"), diffOpts);
    check("an edit diffs as text", diff.kind, "text");
    check("with the line that changed", diff.patch?.includes("+TWO CHANGED"), true);
    check("and the line it replaced", diff.patch?.includes("-two"), true);
  }

  {
    /*
     * A file git has never seen goes through `diff --no-index`, which **exits 1
     * when the files differ** — that is the success case here, and the path every
     * newly created file takes. Treating it as a failure would make the diff
     * unavailable for exactly the files an agent just wrote.
     */
    const diff = await diffFile(workspace, changeFor("fresh.txt"), diffOpts);
    check("an untracked file still diffs, though git exits 1 saying so", diff.kind, "text");
    check("as all additions", diff.patch?.includes("+brand new"), true);
    /*
     * `--no-index` also names the *absolute* path in its header, which is
     * rewritten to repo-relative so `client diff … | git apply` works.
     */
    check("and the patch names the file the way a patch has to", diff.patch?.includes("+++ b/fresh.txt"), true);
    check("never the absolute path git printed", diff.patch?.includes(repo), false);
  }

  {
    /*
     * The `$&` case, measured: `String.replace(pattern, replacement)` expands
     * `$&`, `` $` ``, `$'` and `$$` in a **string** replacement, and the
     * replacement here is a path the agent chose. `a$&b.txt` rewrote to
     * `--- a/atmp/wt/a$&b.txtb.txt` — the absolute path the rewrite exists to
     * remove, spliced back into the one header that has to be right. A function
     * replacement has no such grammar.
     */
    const diff = await diffFile(workspace, changeFor("a$&b.txt"), diffOpts);
    check("a path with $& in it rewrites to itself", diff.patch?.includes("+++ b/a$&b.txt"), true);
    check("and does not splice the absolute path back in", diff.patch?.includes(repo), false);
  }

  {
    /*
     * ⚠ **git C-quotes a path, and the prefix test did not know it.** A name
     * containing a non-ASCII byte, a `"` or a `\` comes back as
     * `+++ "b/…"` with octal escapes — measured against real git on
     * `réz"me.txt`:
     *
     * ```
     * diff --git "a/r\303\251z\"me.txt" "b/r\303\251z\"me.txt"
     * --- /dev/null
     * +++ "b/<the daemon's absolute path>"
     * ```
     *
     * `startsWith("+++ b/")` matches neither, so that line was left alone while
     * the `diff --git` line above it *was* rewritten (it is replaced outright).
     * The patch came out **self-contradicting** — one header line naming the
     * relative path, the next the absolute one — which is un-appliable, and
     * leaks the daemon's layout in the exact header this rewrite exists to
     * clean. Both path lines are replaced outright now, so quoting cannot
     * matter.
     */
    const odd = 'réz"me.txt';
    writeFileSync(join(repo, odd), "unicode and a quote\n");
    const listed = await listChanges(workspace, {
      runner: hostGit,
      base: "session",
      includeIgnored: false,
      limit: DEFAULT_MAX_CHANGED_FILES,
    });
    const change = listed.supported ? listed.files.find((f) => f.path === odd) : undefined;
    check("a C-quoted name still reaches the listing under its real spelling", change !== undefined, true);
    if (change) {
      const diff = await diffFile(workspace, change, diffOpts);
      check("its patch names it the way a patch has to", diff.patch?.includes(`+++ b/${odd}`), true);
      // The half that was broken: the header agreed with itself only because the
      // `diff --git` line is replaced rather than matched.
      check("and the two header lines agree", diff.patch?.includes(`diff --git a/${odd} b/${odd}`), true);
      check("with the absolute path nowhere in it", diff.patch?.includes(repo), false);
    }
  }

  {
    /*
     * Never content-diffed. `git diff --no-index` *follows* the link, so
     * `ln -s ~/.ssh/id_rsa x` would otherwise serve the target's bytes to anyone
     * holding the bearer token. `lstat`, never `stat`.
     */
    const diff = await diffFile(workspace, changeFor("link.txt"), diffOpts);
    check("a symlink is never content-diffed", diff.kind, "symlink");
    check("it reports where it points instead", diff.symlinkTarget, join(repo, "kept.txt"));
    check("and carries no patch at all", diff.patch, null);
    /*
     * **The bytes of the target, checked as bytes.** This line used to read
     * `check(…, diff.patch === null, true)` — the same fact as the line above it,
     * spelled a second way, under a comment promising something stronger. What
     * has to be true is that the *content* of `kept.txt` reaches no field of the
     * answer, not merely that one named field is null, because a regression that
     * followed the link could surface it anywhere. `TWO CHANGED` is the string
     * written into the target at the top of this fixture.
     */
    check("so the target's contents are not served, in any field", JSON.stringify(diff).includes("TWO CHANGED"), false);
  }

  {
    // Both caps, through the seams `server.ts` exposes for exactly this.
    const capped = await listChanges(workspace, { runner: hostGit, base: "session", includeIgnored: false, limit: 2 });
    check("a file cap cuts the list", capped.supported && capped.files.length, 2);
    check("and says so rather than reading as complete", capped.supported && capped.truncated?.reason, "file_limit");
    check("naming the limit it hit", capped.supported && capped.truncated?.limit, 2);

    /*
     * A cut patch is cut **at the last complete line**, so it can never fabricate
     * a final line the file does not have — which is why a cap tight enough that
     * no whole line survives yields nothing rather than half of the `diff --git`
     * header. Both ends of that rule, because only asserting the roomy one would
     * pass for an implementation that simply sliced at the byte.
     */
    const clipped = await diffFile(workspace, changeFor("kept.txt"), { ...diffOpts, maxBytes: 120 });
    check("a byte cap cuts a patch", clipped.truncated, true);
    check("and what is left is shorter than the whole", (clipped.patch?.length ?? 0) < (await diffFile(workspace, changeFor("kept.txt"), diffOpts)).patch!.length, true);
    check("ending on a line break rather than mid-line", clipped.patch?.endsWith("\n"), true);

    const starved = await diffFile(workspace, changeFor("kept.txt"), { ...diffOpts, maxBytes: 16 });
    check("a cap too tight for one whole line carries no patch", starved.patch, null);
    // And it says which kind of nothing, rather than leaving a client to tell an
    // empty patch from a file that genuinely did not change.
    check("reporting itself as empty rather than as a patch of nothing", starved.kind, "empty");
    check("while still admitting it was cut", starved.truncated, true);
  }

  {
    // A directory that is not a repository is a supported answer, not an error —
    // "nothing changed" and "there is nothing to compare against" differ.
    const plain: SessionWorkspace = { ...workspace, git: null };
    const none = await listChanges(plain, {
      runner: hostGit,
      base: "session",
      includeIgnored: false,
      limit: DEFAULT_MAX_CHANGED_FILES,
    });
    check("a session outside a repository says so rather than failing", [none.vcs, none.supported], ["none", false]);
    check("with a reason a client can render", none.supported === false && none.reason, "not_a_git_repository");
  }

  /* -- a plain session rooted in a *subdirectory* of a repository --------- */

  {
    /*
     * ⚠ **The two git commands this file parses do not agree about what a path
     * is, and the whole API broke where they disagree.** `git diff` reports
     * **repo-root-relative**; `git status` reports **cwd-relative**
     * (`status.relativePaths` defaults to true). Those are the same string
     * whenever `root` *is* the repo root — every worktree session, and every
     * plain session opened at the top of a repository — which is exactly why
     * nothing caught it.
     *
     * Open a plain session in a subdirectory and one modified file becomes
     * **two rows**: `subdir/kept.txt` carrying the numstat and `kept.txt`
     * carrying the status, each missing half its fields. And both are
     * unaskable — `safeRelPath` resolves against `root`, so the first names a
     * file that is not there and the second never matches the first — which is
     * `GET /sessions/:id/changes/diff` returning `path_not_changed` for
     * everything, permanently, for that shape of session.
     *
     * Driven through real git in that exact shape, because the defect is what
     * the *commands* do rather than what the parsers do — both parsers were
     * correct about the bytes they were handed.
     */
    const nested = join(repo, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "inner.txt"), "one\n");
    // `git(...)`, not a bare `execFileSync`: the helper carries `-c user.name`
    // and `-c user.email`, and a commit without them fails with "Author identity
    // unknown" on any host that has no global git config. A laptop has one and
    // CI does not, which is the whole reason that helper exists.
    git("add", "-A");
    git("commit", "--quiet", "-m", "nested");
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { stdio: "pipe" }).toString().trim();
    writeFileSync(join(nested, "inner.txt"), "one\nCHANGED\n");
    writeFileSync(join(nested, "new.txt"), "fresh\n");
    // A file changed *outside* the session's tree, which only this shape can see.
    writeFileSync(join(repo, "kept.txt"), "one\nTWO CHANGED\nthree\nAND AGAIN\n");

    const sub: SessionWorkspace = {
      ...workspace,
      mode: "plain",
      root: nested,
      requestedCwd: nested,
      git: { ...workspace.git!, baseCommit: head },
    };
    const listed = await listChanges(sub, {
      runner: hostGit,
      base: "session",
      includeIgnored: false,
      limit: DEFAULT_MAX_CHANGED_FILES,
    });
    const paths = listed.supported ? listed.files.map((f) => f.path).sort() : [];
    check("one changed file is one row, not one per command", paths.filter((p) => p.endsWith("inner.txt")), ["inner.txt"]);
    check("and it is named relative to the session's own root", paths.includes("nested/inner.txt"), false);
    /*
     * Both halves land on that single row, which is the property the duplicate
     * hid: the numstat comes from `diff` and the `xy` from `status`, so a row
     * carrying only one of them is the split reappearing.
     */
    const inner = listed.supported ? listed.files.find((f) => f.path === "inner.txt") : undefined;
    /*
     * The row's existence is its own line, and every assertion below it names
     * `inner !== undefined` rather than reaching through `inner?.`. Optional
     * chaining answers `undefined` for a row that is not there, and
     * `undefined !== null` is *true* — so the three assertions here passed
     * loudest in exactly the case they exist to catch, a listing that produced no
     * `inner.txt` row at all.
     */
    check("the listing has that row at all", inner !== undefined, true);
    check("carrying the numstat that only `diff` knows", inner !== undefined && inner.added !== null && inner.deleted !== null, true);
    check("and the status that only `status` knows", inner !== undefined && inner.xy !== null, true);
    check("an untracked file in the same tree is addressable", listed.supported && listed.files.find((f) => f.path === "new.txt")?.addressable, true);
    /*
     * A file changed outside the tree is still *reported* — the agent touched
     * something and hiding it would be the lie this module is written against —
     * and marked unaskable, because `safeRelPath` refuses a `..` segment and
     * every route that serves bytes would answer `400 invalid_path`.
     */
    const outside = listed.supported ? listed.files.find((f) => f.path.startsWith("../")) : undefined;
    check("a change outside the tree is still shown", outside !== undefined, true);
    check("and marked as one nobody can ask about", outside?.addressable, false);

    /*
     * And the diff route answers, which is the whole point: this returned
     * `path_not_changed` for every path in the listing before, so the feature
     * was not degraded but absent for this shape of session.
     */
    if (inner) {
      const patch = await diffFile(sub, inner, diffOpts);
      check("the diff route answers for a path from that listing", patch.kind, "text");
      check("and its header names the path the caller asked for", patch.patch?.includes("a/inner.txt"), true);
      check("never the repository-relative one", patch.patch?.includes("nested/inner.txt"), false);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Making a worktree under a root that traverses a symlink
 *
 * `containedIn(root, worktreeRoot)` compared a leaf that **cannot exist yet** —
 * a fresh session id — against a root that resolves fully. `resolved()` falls
 * back to the literal string when `realpath` throws, which is right where a path
 * is merely not created yet and wrong when only *one* of the two sides is in
 * that state, which is exactly this call. On any host whose worktree root
 * traverses a symlink the two answers are in different namespaces, the prefix
 * test fails, and **every** session creation is refused with an error accusing
 * the daemon's own configured root of sitting outside itself.
 *
 * It is invisible on an ordinary Linux host and unavoidable on this one: `/tmp`
 * is a symlink to `/private/tmp` on macOS, which is also where every driver in
 * this file puts its sandbox — so the fixture below is the ordinary case rather
 * than a contrived one, and it is built explicitly rather than relying on that,
 * because CI is Linux and would otherwise assert nothing at all.
 * ------------------------------------------------------------------ */

process.stdout.write("\nmaking a worktree under a root that is a symlink\n");
{
  const repo = join(sandbox, "wtrepo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=daemoncheck", "-c", "user.email=d@example.invalid", ...args],
      { stdio: "pipe" },
    );
  };
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", repo], { stdio: "pipe" });
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");

  const realRoot = join(sandbox, "wt-real");
  mkdirSync(realRoot, { recursive: true });
  const linkedRoot = join(sandbox, "wt-link");
  symlinkSync(realRoot, linkedRoot);

  const make = async (sessionId: string, worktreeRoot: string) => {
    try {
      return { made: await createWorkspace({
        cwd: repo,
        sessionId,
        policy: "require",
        worktreeRoot,
        branchPrefix: "dcheck",
        runner: hostGit,
      }), code: null as string | null };
    } catch (error) {
      // Reported as a value rather than rethrown: a regression here refuses
      // *every* session, so it has to fail one line rather than take the rest of
      // this file's coverage down with it.
      return { made: null, code: error instanceof WorktreeError ? error.code : String(error) };
    }
  };

  const first = await make("s_sym", linkedRoot);
  check("a root that traverses a symlink is not outside itself", first.code, null);
  check("and the session really gets a worktree", first.made?.workspace.mode, "worktree");
  check("under the root it was asked for, as written", first.made?.workspace.root.startsWith(`${linkedRoot}/`), true);
  check("on a branch this daemon created", first.made?.workspace.git?.createdBranch, true);
  // The post-add check is untouched by any of this and runs against the tree that
  // now exists, so a creation that reported success really is inside the root.
  check("and it resolves inside the real one too", containedIn(first.made?.workspace.root ?? "", realRoot), true);

  /*
   * The guard that is **not** relaxed, kept as the control.
   *
   * `repoKey` is `<basename>-<sha256(commonDir)[0:8]>`, computable by an agent
   * that has read its own worktree's gitfile — so replacing that one directory
   * with a symlink redirects the *next* session's checkout anywhere this daemon
   * can write, and `existsSync(root)` never catches it because the leaf is a
   * fresh session id. The refusal is by `lstat` on the component rather than by
   * resolving it, because the question is whether this component *is* a link and
   * a resolving check would follow it and answer about the target.
   */
  const repoDir = dirname(first.made?.workspace.root ?? join(linkedRoot, "none"));
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", "--", first.made?.workspace.root ?? ""], {
    stdio: "pipe",
  });
  rmSync(repoDir, { recursive: true, force: true });
  symlinkSync(uAbcd, repoDir);
  const second = await make("s_sym2", linkedRoot);
  check("but a per-repository directory that is a symlink is still refused", second.code, "outside_worktree_root");
}

/* ------------------------------------------------------------------ *
 * Removing one, and the counts that are not zero
 *
 * `count()` and `countStatus` collapse a 5s/15s timeout, a 128 from a stale
 * gitfile, oversized output and an unparseable number into one `null`, and
 * `removeWorkspace` read that with `?? 0`. So "could not tell" became "nothing
 * to lose": a non-forced `DELETE …/workspace?deleteBranch=1` reached `git branch
 * -D` over commits that exist in no other ref and on no remote, and a failed
 * `git status` skipped the dirty refusal standing in front of the one `rmSync`
 * in this codebase. Both are refusals now, and `--force` still overrides both.
 *
 * The runner is scripted rather than real, and that is the point: what has to be
 * driven is git *failing to answer*, which a healthy repository will not do on
 * request. Every case ends by asking the filesystem whether the work is still
 * there, because that — not the return value — is what the defect destroyed.
 * ------------------------------------------------------------------ */

process.stdout.write("\nrefusing to remove a worktree on a count nobody could take\n");
{
  /** git as a script, plus every argv it was handed. */
  const scriptedGit = (answers: {
    status: "empty" | "throw";
    revList: string | "throw";
    remotes?: string;
    removeStderr?: string;
  }): { runner: GitExec; argv: () => string[][] } => {
    const argv: string[][] = [];
    const ok = (stdout: string): GitRun => ({
      stdout: Buffer.from(stdout, "utf8"),
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    const fail = (args: readonly string[], stderr: string): GitError =>
      new GitError("git_failed", args, 128, stderr, `git ${args[0] ?? ""} failed`);

    const run = async (args: readonly string[]): Promise<GitRun> => {
      argv.push([...args]);
      // Unregistered, which `inspectWorkspace` already tolerates by catching —
      // so nothing here has to reproduce `worktree list --porcelain`'s format.
      if (args[0] === "worktree" && args[1] === "list") throw fail(args, "not a working tree");
      if (args[0] === "worktree" && args[1] === "remove") {
        if (answers.removeStderr !== undefined) throw fail(args, answers.removeStderr);
        return ok("");
      }
      if (args[0] === "rev-parse") return ok("c0ffee\n");
      if (args[0] === "rev-list") {
        if (answers.revList === "throw") throw fail(args, "fatal: bad revision");
        return ok(`${answers.revList}\n`);
      }
      if (args[0] === "remote") return ok(answers.remotes ?? "");
      return ok("");
    };
    const readCapped = async (args: readonly string[]): Promise<GitRun> => {
      argv.push([...args]);
      if (args[0] === "status" && answers.status === "throw") throw fail(args, "fatal: not a git repository");
      return ok("");
    };
    return { runner: { run, readCapped }, argv: () => argv };
  };

  const removalRoot = join(sandbox, "removals");
  /** A checkout that really is on disk, holding a file the refusals are about. */
  const worktreeOf = (id: string): SessionWorkspace => {
    const root = join(removalRoot, "repo-abc", id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "work.txt"), "the work nobody could count\n", "utf8");
    return {
      mode: "worktree",
      root,
      requestedCwd: join(sandbox, "wtrepo"),
      git: {
        repoRoot: join(sandbox, "wtrepo"),
        commonDir: join(sandbox, "wtrepo", ".git"),
        branch: `dcheck/${id}`,
        createdBranch: true,
        baseCommit: "c0ffee",
      },
      plainReason: null,
      createdAt: now,
    };
  };
  /** `code:about` per refusal, which is the whole shape a client keys on. */
  const refusalsOf = (result: Awaited<ReturnType<typeof removeWorkspace>>): string[] =>
    result.kind === "refused"
      ? result.refusals.map((refusal) => `${refusal.code}${"about" in refusal ? `:${refusal.about}` : ""}`)
      : [`(${result.kind})`];
  const ran = (argv: string[][], verb: string, sub?: string): boolean =>
    argv.some((args) => args[0] === verb && (sub === undefined || args[1] === sub));

  {
    /*
     * The commit count, which is the one that was irreversible. `rev-list`
     * answers `null` and there are no remotes, so `orphaned` is unknown — and
     * with `?? 0` that is "nothing to lose" one line above `git branch -D`.
     */
    const workspace = worktreeOf("s_rm_commits");
    const git = scriptedGit({ status: "empty", revList: "throw", remotes: "" });
    const result = await removeWorkspace({
      runner: git.runner,
      workspace,
      worktreeRoot: removalRoot,
      force: false,
      deleteBranch: true,
    });
    check("a commit count nobody could take refuses the removal", result.kind, "refused");
    check("saying which count it was", refusalsOf(result), ["counts_unknown:commits"]);
    // The assertion the return value cannot make: the work is still on disk.
    check("the checkout is still there", existsSync(join(workspace.root, "work.txt")), true);
    check("git was never asked to remove it", ran(git.argv(), "worktree", "remove"), false);
    // The irreversible half, and the only copy of those commits.
    check("and the branch was never deleted", ran(git.argv(), "branch"), false);
  }

  {
    /*
     * The dirty count, whose failure was silent in the other direction: `git
     * status` not answering skipped the refusal standing in front of the guarded
     * `rmSync`, so the removal went ahead over changes nobody had been told about.
     * `exists === true` is the precondition — a directory that is genuinely gone
     * has nothing to hold, and refusing there would make the state this path
     * exists to clean up the one state it cannot.
     */
    const workspace = worktreeOf("s_rm_dirty");
    const git = scriptedGit({ status: "throw", revList: "0", remotes: "" });
    const result = await removeWorkspace({
      runner: git.runner,
      workspace,
      worktreeRoot: removalRoot,
      force: false,
      deleteBranch: false,
    });
    check("a dirty count nobody could take refuses too", refusalsOf(result), ["counts_unknown:dirty"]);
    check("and leaves the checkout alone", existsSync(join(workspace.root, "work.txt")), true);
  }

  {
    /*
     * **git refusing is not a partial removal**, and the fall-through treated it
     * as one: the failure was pushed onto `warnings` and execution carried
     * straight on into `rmSync(recursive, force)`, deleting exactly what git had
     * declined to delete — and answering `200 {removed: true}`. So somebody who
     * deliberately did not pass `force` got the forced behaviour with the refusal
     * reduced to a warning nobody has to read.
     *
     * Recognised by git's own words rather than by the call having failed, on the
     * same reasoning as `classifyAddFailure`: every *other* way this can fail is
     * precisely what the guarded rm and the prune exist to clean up.
     */
    const workspace = worktreeOf("s_rm_refused");
    const git = scriptedGit({
      status: "empty",
      revList: "0",
      remotes: "",
      removeStderr: `fatal: '${workspace.root}' contains modified or untracked files, use --force to delete it`,
    });
    const result = await removeWorkspace({
      runner: git.runner,
      workspace,
      worktreeRoot: removalRoot,
      force: false,
      deleteBranch: false,
    });
    check("git declining is a refusal rather than a warning", refusalsOf(result), ["remove_refused"]);
    check(
      "carrying git's own words, which are the only explanation there is",
      result.kind === "refused" && result.refusals[0]?.code === "remove_refused" && result.refusals[0].stderr.includes("use --force"),
      true,
    );
    // **The one that matters.** Falling through deleted this.
    check("and the work git would not delete is still on disk", existsSync(join(workspace.root, "work.txt")), true);
    // Skipping the prune is safe and deliberate: a worktree git has just declined
    // to remove is still registered and still present, so there is nothing stale.
    check("nothing was pruned on the way past", ran(git.argv(), "worktree", "prune"), false);
  }

  {
    /*
     * The control, without which every assertion above passes for a
     * `removeWorkspace` that refuses everything. Counts that answer, a git that
     * agrees, and the removal happens — including the branch.
     */
    const workspace = worktreeOf("s_rm_ok");
    const git = scriptedGit({ status: "empty", revList: "0", remotes: "" });
    const result = await removeWorkspace({
      runner: git.runner,
      workspace,
      worktreeRoot: removalRoot,
      force: false,
      deleteBranch: true,
    });
    check("a worktree with nothing to lose is removed", result.kind, "removed");
    check("its branch with it, and the prune runs regardless", result.kind === "removed" && [result.branchDeleted, result.pruned], [true, true]);
    check("and the directory really is gone", existsSync(workspace.root), false);
  }

  {
    /*
     * And `--force` still overrides both new refusals, which is what keeps them
     * from being a wall: the remedy `scripts/client.ts` already prints is the
     * remedy that has to work.
     */
    const workspace = worktreeOf("s_rm_forced");
    const git = scriptedGit({ status: "throw", revList: "throw", remotes: "" });
    const result = await removeWorkspace({
      runner: git.runner,
      workspace,
      worktreeRoot: removalRoot,
      force: true,
      deleteBranch: true,
    });
    check("force removes a worktree whose counts nobody could take", result.kind, "removed");
    check("passing git the flag rather than deciding for it", git.argv().some((args) => args[0] === "worktree" && args[1] === "remove" && args.includes("--force")), true);
    check("and the directory is gone", existsSync(workspace.root), false);
  }

  /* ---------------------------------------------------------------- *
   * And what the route says about a refusal, which is the only text
   * anybody reads
   *
   * `scripts/client.ts` prints `error.message` and walks nothing else — no
   * caller anywhere reads `detail.refusals` — so the sentence this route picks
   * *is* the answer. It picked one sentence for every refusal, "this worktree
   * still holds work", and `counts_unknown` exists precisely to say the daemon
   * could not tell whether it does. The `?? 0` that was removed from
   * `removeWorkspace` one level down is the same defect: a count nobody could
   * take turned into a claim. Restating it here put it straight back at the
   * boundary — and then invited an operator to force-delete on that evidence,
   * since the CLI's "pass --force" hint hangs off the code beside it.
   *
   * Driven through the real route rather than against the mapping, because the
   * mapping is three lines and the thing that can rot is the route reaching for
   * it.
   * ---------------------------------------------------------------- */

  /**
   * Whichever scripted git the next route call should see.
   *
   * It starts as one that answers everything, so a case which forgets to set its
   * own fails as a `200 {removed: true}` rather than quietly inheriting the
   * previous case's refusals and asserting them twice.
   */
  let routeGit: GitExec = scriptedGit({ status: "empty", revList: "0", remotes: "" }).runner;
  class ScriptedGitRuntime extends LocalRuntime {
    /*
     * Delegating per call rather than handing back `routeGit` itself, and that is
     * not a detail: `createApp` reads `registry.sessionRuntime.git()` **once**,
     * when the app is built, so a runtime returning the current value binds the
     * app to whichever script existed at construction — measured here first, as a
     * `200 {removed: true}` for a case whose whole point is a refusal.
     */
    override git(): GitExec {
      return {
        run: (args, options) => routeGit.run(args, options),
        readCapped: (args, options) => routeGit.readCapped(args, options),
      };
    }
  }

  /*
   * A restored row whose workspace is a worktree. `rowFor` already ends
   * `stopped`, which is the precondition: the route refuses a live session
   * before it ever asks git anything.
   */
  const removalRow = (id: string): PersistedSession => ({
    ...rowFor(id, join(sandbox, "rm-routes", id)),
    workspace: worktreeOf(id),
  });

  const rmRegistry = new SessionRegistry(
    new MemoryEventStore(),
    storeOf([removalRow("s_rm_route_unknown"), removalRow("s_rm_route_mixed")]),
    { worktreeRoot: removalRoot, branchPrefix: "dcheck/", defaultMode: "auto" },
    new ScriptedGitRuntime(),
  );
  rmRegistry.restore({ reapOrphans: false });
  const { app: rmApp } = createApp({
    registry: rmRegistry,
    verifier,
    instanceId: "i_rmroutes",
    startedAt: now,
    credentials,
    roots: [users],
  });

  const deleteWorkspace = async (id: string, query: string): Promise<any> => {
    const response = await rmApp.fetch(
      new Request(`http://d/sessions/${id}/workspace?${query}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
      }),
    );
    const body = (await response.json()) as any;
    return {
      status: response.status,
      code: body?.error?.code,
      message: body?.error?.message,
      refusals: (body?.error?.detail?.refusals ?? []).map((refusal: { code: string }) => refusal.code),
    };
  };

  {
    // `rev-list` will not answer and the branch is ours to delete, so the only
    // refusal is the one that means "I could not tell".
    routeGit = scriptedGit({ status: "empty", revList: "throw", remotes: "" }).runner;
    const refused = await deleteWorkspace("s_rm_route_unknown", "deleteBranch=1");
    check("a refusal nobody could measure is still a 409", refused.status, 409);
    check("but not one that claims there is work here", refused.code, "workspace_uncertain");
    check("and the sentence says which of the two it is", refused.message, "could not tell whether removing this worktree would lose work; force removes it anyway");
    // The remedy travels in the sentence rather than beside it, because the CLI
    // hangs its hint off `workspace_dirty` and a code it has never seen would
    // otherwise take the remedy away along with the lie.
    check("with the remedy in it, which the code no longer carries", refused.message.includes("force"), true);
    check("and the refusals themselves still ride along", refused.refusals, ["counts_unknown"]);
  }

  {
    /*
     * The mixed case, which is what decides the rule rather than restating it: a
     * count nobody could take *and* commits that really are unpushed. The
     * definite refusal wins, because "this worktree still holds work" is then
     * true and is the sentence worth reading.
     */
    routeGit = scriptedGit({ status: "throw", revList: "3", remotes: "" }).runner;
    const refused = await deleteWorkspace("s_rm_route_mixed", "deleteBranch=1");
    check("a refusal that did measure something says so", [refused.status, refused.code], [409, "workspace_dirty"]);
    check("in the words this arm always used", refused.message, "this worktree still holds work");
    check("with both refusals carried, in the order they were found", refused.refusals, ["counts_unknown", "unpushed_commits"]);
  }
}

/*
 * The transcript on disk, which is the half of the log nothing reached.
 *
 * Every registry case in this file backs its sessions with `MemoryEventStore`,
 * so the store that actually holds somebody's conversation across a restart was
 * never named by a driver. The three rules below are the ones whose failure is
 * *invisible* — a client is handed the wrong events under numbers it already
 * holds, with nothing on the wire to say so — which is exactly the class this
 * subsystem exists to prevent and the class a driver has to catch.
 */
process.stdout.write("\nthe transcript on disk\n");
{
  const evPath = join(sandbox, "events", "reemoat.db");
  const text = (n: number): SessionEvent => ({ type: "text", role: "agent", thought: false, text: `e${n}` });

  {
    const store = openStores({ path: evPath, instanceId: "i_ev" });
    const first = store.events.append("s_ev", text(1));
    store.events.append("s_ev", text(2));
    const third = store.events.append("s_ev", text(3));
    check("seqs are dense from one", [first.seq, third.seq], [1, 3]);
    check(
      "and read back in order",
      store.events.read("s_ev", 0, 100, 1 << 20).map((stored) => (stored.event as { text: string }).text),
      ["e1", "e2", "e3"],
    );
    // `read` is `seq > ?`, which is what makes a cursor a cursor rather than an index.
    check(
      "a cursor is exclusive, so resuming from it repeats nothing",
      store.events.read("s_ev", 2, 100, 1 << 20).map((stored) => stored.seq),
      [3],
    );
    store.sessions.put({ ...rowFor("s_ev", join(users, "u_alice", "ev")), lastSeq: 3, dropped: 0 });
    store.close();
  }

  {
    // The whole point of the store: a different process, the same transcript.
    const store = openStores({ path: evPath, instanceId: "i_ev2" });
    check(
      "another daemon reads what the first one wrote",
      store.events.read("s_ev", 0, 100, 1 << 20).map((stored) => (stored.event as { text: string }).text),
      ["e1", "e2", "e3"],
    );
    check("and carries on numbering rather than starting again", store.events.append("s_ev", text(4)).seq, 4);
    store.close();
  }

  {
    /*
     * Eviction takes a **prefix**, and that is what `dropped = firstSeq - 1`
     * rests on — the counters are rebuilt by deriving them at load rather than
     * persisting them, and deriving is only correct while the surviving rows are
     * contiguous and end at the newest.
     *
     * The numbers are asserted as *relationships* rather than as literals: the
     * slack is clamped to a quarter of the window precisely so a tiny log can be
     * driven, so pinning "exactly six survive" would be pinning the clamp rather
     * than the rule.
     */
    const evictPath = join(sandbox, "evict", "reemoat.db");
    const store = openStores({ path: evictPath, instanceId: "i_evict", maxEventsPerSession: 8 });
    for (let n = 1; n <= 10; n += 1) store.events.append("s_full", text(n));

    const stats = store.events.stats("s_full");
    check("the newest seq is every event ever appended", stats.lastSeq, 10);
    check("something was evicted", stats.count < 10, true);
    check("and everything is accounted for, dropped plus kept", stats.dropped + stats.count, 10);
    /*
     * The two halves of "a strict prefix": what survives starts exactly one past
     * what was dropped, and it runs to the end without a hole.
     */
    check("what survives begins one past what was dropped", stats.firstSeq, stats.dropped + 1);
    const survivors = store.events.read("s_full", 0, 100, 1 << 20);
    check("and runs contiguously to the newest", survivors.map((stored) => stored.seq), [
      ...Array.from({ length: survivors.length }, (_, i) => stats.firstSeq + i),
    ]);
    /*
     * The direction, which is the assertion a "count is bounded" test would pass
     * without: the oldest went and the newest stayed. Evicting the wrong end
     * bounds the log just as well and throws away the conversation somebody is
     * looking at.
     */
    check("the oldest event is gone", (survivors[0]?.event as { text: string }).text !== "e1", true);
    check("and the newest is not", (survivors.at(-1)?.event as { text: string }).text, "e10");
    // Never the last row: `lastSeq = MAX(seq)` has to stay derivable at load.
    check("eviction never takes the newest row", stats.count >= 1, true);
    store.close();
  }

  {
    /*
     * **And by default it never runs at all**, which is the assertion the block
     * above cannot make: it passes an explicit `maxEventsPerSession: 8`, so it
     * pins the mechanism and says nothing about what anybody actually gets.
     *
     * A session's log is not truncated. The old default was 5000 events / 8 MiB
     * evicting a *prefix*, and what that meant was measured rather than reasoned
     * about: a live session on the development machine reached `dropped: 6144`,
     * so its oldest surviving event was an agent `text` chunk containing the two
     * characters `" for"` — a conversation somebody was still working in had lost
     * its beginning, mid-word, permanently.
     *
     * Driven past **both** old defaults rather than at some round number, because
     * those are the two numbers that have to no longer bite — and they are
     * separate `break` conditions in `evict`, so a run that only exceeds the
     * event count leaves the byte bound completely undriven. 6000 events carrying
     * 2 KiB each is past 5000 *and* past 8 MiB; the padding is what makes the
     * second half of that sentence true, and without it this case is 360 KB and
     * asserts nothing about bytes at all.
     */
    const keepPath = join(sandbox, "keep", "reemoat.db");
    const store = openStores({ path: keepPath, instanceId: "i_keep" });
    const padding = "x".repeat(2_048);
    for (let n = 1; n <= 6_000; n += 1) {
      store.events.append("s_keep", { type: "text", role: "agent", thought: false, text: `e${n}${padding}` });
    }

    const stats = store.events.stats("s_keep");
    check("nothing is dropped past the old 5000-event window", stats.dropped, 0);
    check("nor past the old 8 MiB one", stats.approxBytes > 8 * 1024 * 1024, true);
    check("the log still begins at its first event", stats.firstSeq, 1);
    check("with every event still there", stats.count, 6_000);
    // The first event, by content — `firstSeq` alone would survive a store that
    // renumbered, and the thing being defended is the text somebody wrote.
    const first = store.events.read("s_keep", 0, 1, 1 << 20)[0];
    check("and the opening event reads back intact", (first?.event as { text: string }).text, `e1${padding}`);
    store.close();
  }

  {
    /*
     * **The floors, which are the case `firstSeq` alone cannot answer.**
     *
     * A session whose events are gone entirely — pruned, or a disk that rejected
     * every insert — leaves a table that knows nothing about it while the
     * session row still records how far the log got. Without `seedFloors` such a
     * session restarts at seq 1, and a client reconnecting with `since=500` is
     * clamped to 0 and replayed: it receives *different events under numbers it
     * has already seen*, and neither end can detect it.
     */
    const floorPath = join(sandbox, "floors", "reemoat.db");
    {
      const store = openStores({ path: floorPath, instanceId: "i_floor" });
      store.sessions.put({
        ...rowFor("s_pruned", join(users, "u_alice", "pruned")),
        lastSeq: 500,
        dropped: 500,
      });
      store.close();
    }
    const store = openStores({ path: floorPath, instanceId: "i_floor2" });
    const stats = store.events.stats("s_pruned");
    check("a session with no rows left still knows how far it got", stats.lastSeq, 500);
    check("and how much it lost", stats.dropped, 500);
    check("the next event continues the numbering rather than restarting it", store.events.append("s_pruned", text(1)).seq, 501);
    store.close();
  }

  {
    /*
     * `oldestAvailable`, and the measurement that put it in the shared
     * vocabulary rather than in one caller.
     *
     * `firstSeq` is 0 when the table holds no row for a session, so
     * `since < firstSeq - 1` is `since < -1` — false for every cursor, on the one
     * path where *everything* was lost. Measured: stats
     * `{firstSeq: 0, lastSeq: 500, count: 0}` answered a `since=0` attach with
     * `gap: false`, no backlog and `caught_up: 0`, then the next live event at
     * seq 501. Three places have to agree on this — the gap predicate, the
     * `firstSeq` on the wire, and the `firstSeq` on the snapshot — which is why
     * it is a function rather than an expression written out three times.
     */
    check("with rows, the oldest readable seq is the oldest row", oldestAvailable({ firstSeq: 7, lastSeq: 20, count: 14 }), 7);
    check(
      "with none, it is one past the end rather than minus one",
      oldestAvailable({ firstSeq: 0, lastSeq: 500, count: 0 }),
      501,
    );
    check("and an untouched session asks to be served from the start", oldestAvailable({ firstSeq: 0, lastSeq: 0, count: 0 }), 1);
  }

  {
    /*
     * A failed write becomes a placeholder at the **same** seq, never a hole and
     * never the real event.
     *
     * A cycle is the failure SQLite adds that the memory store does not have: it
     * survives `truncateEvent` — `jsonSize` swallows it and reports a few KiB, so
     * nothing is shrunk — and then throws in `JSON.stringify`.
     *
     * Both halves matter. A hole cannot spin the attach loop, because `read` is
     * `seq > ?` — it does something worse, since `lagged` is derived from
     * firstSeq/lastSeq and a hole in the *middle* is invisible on the wire. And
     * the placeholder is what `append` **returns**: handing a live client the
     * real text at a seq while a reconnecting client gets a placeholder there
     * makes the two disagree about what that seq is, undetectably. Both losing it
     * is better than diverging, because the loss is visible.
     */
    const cyclePath = join(sandbox, "cycle", "reemoat.db");
    const store = openStores({ path: cyclePath, instanceId: "i_cycle" });
    store.events.append("s_cycle", text(1));

    const cyclic: Record<string, unknown> = { command: "ls" };
    cyclic["self"] = cyclic;
    const returned = store.events.append("s_cycle", {
      type: "tool_call",
      toolCallId: "t1",
      title: "Terminal",
      kind: "other",
      status: "pending",
      locations: [],
      rawInput: cyclic,
      parentToolCallId: null,
      subagent: false,
    });

    check("the seq is spent rather than skipped", returned.seq, 2);
    check("and what comes back is the placeholder, not the event", returned.event.type, "error");
    store.events.append("s_cycle", text(3));

    const back = store.events.read("s_cycle", 0, 100, 1 << 20);
    check("so the log is contiguous", back.map((stored) => stored.seq), [1, 2, 3]);
    check(
      "and a reader is served exactly what the writer was handed",
      back.map((stored) => stored.event.type),
      ["text", "error", "text"],
    );
    check("with the failure said out loud rather than swallowed", /could not be recorded/.test((back[1]?.event as { message: string }).message), true);
    store.close();
  }

  {
    /*
     * The per-event ceiling is applied *at the store boundary*, which is where
     * retention is owned — `session.ts` passes through what the agent sent and
     * does not decide how much of it is kept. Truncation is visible rather than
     * silent, because a transcript that quietly stops mid-sentence reads as
     * something the agent said.
     */
    const bigPath = join(sandbox, "big", "reemoat.db");
    const store = openStores({ path: bigPath, instanceId: "i_big", maxEventBytes: 2048 });
    const stored = store.events.append("s_big", { type: "text", role: "agent", thought: false, text: "x".repeat(20_000) });
    const kept = (stored.event as { text: string }).text;
    check("an oversized event is clipped rather than refused", kept.length < 20_000, true);
    check("and says so, with this repo's own marker", /\[truncated \d+ bytes\]$/.test(kept), true);
    check("the clipped form is what lands on disk too", (store.events.read("s_big", 0, 10, 1 << 20)[0]?.event as { text: string }).text, kept);
    store.close();
  }
}

/*
 * Everything else in this driver asserts that a thing still works. This asserts
 * that an *upgrade* does not silently take something away — and the two tables it
 * touches are the two that hold secrets, so getting it wrong is unrecoverable
 * rather than inconvenient.
 *
 * Two behaviours, and they are deliberately different:
 *
 *   `agent_credentials` is **rewritten**. A pasted OAuth token is as useful as it
 *   ever was, so losing it would be gratuitous. SQLite cannot drop a primary-key
 *   member, hence create-copy-drop-rename. The copy collapses duplicates — which
 *   only exist in a file written by a multi-tenant daemon — and newest wins.
 *
 *   `forge_accounts` is **dropped**, because of what is in it: plaintext push
 *   tokens that do not expire and that nothing can now revoke, since the routes
 *   that could went with the feature. Leaving the table would leave those secrets
 *   on disk with no code path able to end one, so this is the last moment anybody
 *   can be told — and `migrate()` says so on stderr.
 */
process.stdout.write("\nthe v6 migration\n");
{
  const v5Path = join(sandbox, "v5", "reemoat.db");
  mkdirSync(join(sandbox, "v5"), { recursive: true });

  // The v5 shape, written by hand rather than by an old checkout: what matters is
  // the columns this migration keys on, and inlining them keeps the driver
  // runnable without git archaeology.
  {
    const raw = new DatabaseSync(v5Path);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(
      "CREATE TABLE agent_credentials (owner_subject TEXT NOT NULL, agent TEXT NOT NULL, " +
        "env_name TEXT NOT NULL, secret TEXT NOT NULL, updated_at INTEGER NOT NULL, " +
        "PRIMARY KEY (owner_subject, agent, env_name))",
    );
    raw.exec(
      "CREATE TABLE forge_accounts (owner_subject TEXT NOT NULL, host TEXT NOT NULL, " +
        "secret TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner_subject, host))",
    );
    const ins = raw.prepare(
      "INSERT INTO agent_credentials (owner_subject, agent, env_name, secret, updated_at) VALUES (?,?,?,?,?)",
    );
    // Two owners holding a credential for the *same* (agent, env_name) — the one
    // case where the rewrite has to choose, and the only one that loses a row.
    ins.run("u_old", "claude", "CLAUDE_CODE_OAUTH_TOKEN", "sk-OLD", now - 5_000);
    ins.run("u_new", "claude", "CLAUDE_CODE_OAUTH_TOKEN", "sk-NEWER", now);
    ins.run("u_new", "kimi", "KIMI_API_KEY", "kimi-key", now);
    raw
      .prepare("INSERT INTO forge_accounts (owner_subject, host, secret, updated_at) VALUES (?,?,?,?)")
      .run("u_new", "github.com", "ghp_secret", now);
    raw.exec("PRAGMA user_version = 5");
    raw.close();
  }

  // stderr is captured, because the drop and the collapse are the two places this
  // upgrade destroys something and the only place anybody is told. A count that
  // silently became zero would look identical to a clean migration.
  const said: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  const migrated = openStores({ path: v5Path, instanceId: "i_v6" });
  console.error = realError;
  check("the dropped credential is announced", said.some((line) => line.includes("pasted agent credential")), true);
  // Named, not counted: after the DROP there is no way to learn which forge to go
  // and revoke a token on, so the hosts are read before it.
  check("and the forge drop names the host", said.some((line) => line.includes("github.com")), true);
  const rows = migrated.credentials.list().map((c) => `${c.agent}:${c.envName}`).sort();
  check("both distinct credentials survive the rekey", rows, [
    "claude:CLAUDE_CODE_OAUTH_TOKEN",
    "kimi:KIMI_API_KEY",
  ]);
  // Newest wins, and this is the assertion that would catch the collapse choosing
  // by row order instead: `sk-OLD` is inserted first.
  check("a collision keeps the newer secret", migrated.credentials.envFor("claude"), {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-NEWER",
  });

  /*
   * A new *table* needs `schema.sql` and nothing else, and the version must not
   * move for it.
   *
   * `schema.sql` is re-applied on every open and is all `CREATE ... IF NOT
   * EXISTS`, which is idempotent for whole tables and useless for a new column —
   * that asymmetry is why `migrate()` exists. Leaving `SCHEMA_VERSION` alone is
   * the deliberate half: `refuseNewerSchema` throws on a file stamped newer than
   * the running build, so a bump here would turn every rollback into a daemon
   * that will not start, in exchange for nothing.
   */
  migrated.uploads.insert({
    sessionId: "s_x",
    uploadId: "u_x",
    name: "a.txt",
    origName: "a.txt",
    mime: null,
    bytes: 3,
    createdAt: now,
    consumedAt: null,
  });
  check("an upgraded file gains the uploads table", migrated.uploads.get("s_x", "u_x")?.bytes, 3);
  check(
    "and the version does not move for a new table",
    Number(migrated.db.prepare("PRAGMA user_version").get()?.["user_version"]),
    SCHEMA_VERSION,
  );
  check(
    "the owner column is gone from the table",
    migrated.db.prepare("PRAGMA table_info(agent_credentials)").all().map((c) => String(c["name"])),
    ["agent", "env_name", "secret", "updated_at"],
  );
  check(
    "forge_accounts is dropped rather than left holding tokens",
    migrated.db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='forge_accounts'")
      .get()?.["n"],
    0,
  );
  check(
    "and the file is stamped with the version it now matches",
    Number(migrated.db.prepare("PRAGMA user_version").get()?.["user_version"]),
    SCHEMA_VERSION,
  );
  migrated.close();

  // Idempotent: the guard is the column's presence, so a second open must not
  // rebuild the table or re-announce a drop that already happened.
  const again = openStores({ path: v5Path, instanceId: "i_v6b" });
  check("a second open changes nothing", again.credentials.list().length, 2);
  again.close();

  /*
   * **Refuse-newer, and that it happens before anything is written.**
   *
   * The SCHEMA_VERSION docblock calls this direction "load-bearing rather than
   * advisory" for v6 and nothing asserted it. It is also an *ordering* property,
   * not just a guard: `openStores` used to run `migrate()` first, so a file from
   * a newer daemon had `agent_credentials` rebuilt and `forge_accounts` dropped
   * before the refusal it was supposed to get. Stamping a table this build would
   * touch and checking it survives is what makes the order observable rather than
   * a matter of reading the two lines in the right sequence.
   */
  /*
   * The tiebreak, which nothing asserted and which a rewrite would silently lose.
   *
   * The collapse orders by `updated_at DESC, owner_subject ASC`. The first key is
   * covered above; the second only decides when two people updated a credential
   * in the same millisecond, so without a fixture that forces a tie a build that
   * dropped it — and became dependent on SQLite's row order — passes everything.
   */
  const tiePath = join(sandbox, "v5-tie", "reemoat.db");
  mkdirSync(join(sandbox, "v5-tie"), { recursive: true });
  {
    const raw = new DatabaseSync(tiePath);
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(
      "CREATE TABLE agent_credentials (owner_subject TEXT NOT NULL, agent TEXT NOT NULL, " +
        "env_name TEXT NOT NULL, secret TEXT NOT NULL, updated_at INTEGER NOT NULL, " +
        "PRIMARY KEY (owner_subject, agent, env_name))",
    );
    const ins = raw.prepare(
      "INSERT INTO agent_credentials (owner_subject, agent, env_name, secret, updated_at) VALUES (?,?,?,?,?)",
    );
    // Identical timestamps, inserted with the winner *second*, so row order and
    // the documented rule disagree.
    ins.run("u_zzz", "claude", "CLAUDE_CODE_OAUTH_TOKEN", "sk-LAST-ROW", now);
    ins.run("u_aaa", "claude", "CLAUDE_CODE_OAUTH_TOKEN", "sk-FIRST-OWNER", now);
    raw.exec("PRAGMA user_version = 5");
    raw.close();
  }
  const tied = openStores({ path: tiePath, instanceId: "i_tie" });
  check("a tie is broken by the owner, not by row order", tied.credentials.envFor("claude"), {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-FIRST-OWNER",
  });
  tied.close();

  const v7Path = join(sandbox, "v7", "reemoat.db");
  mkdirSync(join(sandbox, "v7"), { recursive: true });
  {
    const raw = new DatabaseSync(v7Path);
    raw.exec("PRAGMA journal_mode = WAL");
    // A table a v6 `migrate()` would drop on sight, so its survival is the proof.
    raw.exec(
      "CREATE TABLE forge_accounts (owner_subject TEXT NOT NULL, host TEXT NOT NULL, " +
        "secret TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner_subject, host))",
    );
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
  }
  let refused = false;
  try {
    openStores({ path: v7Path, instanceId: "i_v7" }).close();
  } catch {
    refused = true;
  }
  check("a file from a newer daemon is refused", refused, true);
  {
    const raw = new DatabaseSync(v7Path);
    check(
      "and was refused before this build could migrate it",
      raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='forge_accounts'").get()?.["n"],
      1,
    );
    check(
      "leaving its version untouched",
      Number(raw.prepare("PRAGMA user_version").get()?.["user_version"]),
      SCHEMA_VERSION + 1,
    );
    raw.close();
  }
}

process.stdout.write("\nnaming a session\n");
{
  // Pure functions, asserted with no session, for the same reason `containerRunArgs`
  // and `shouldSend` are: the rule they encode is the whole feature, and driving it
  // through a live agent would test the agent instead.
  check("a title is the first line, not the first 60 characters", deriveSessionTitle("Fix reconnect\n\nstack trace here"), "Fix reconnect");
  check("leading blank lines are skipped", deriveSessionTitle("\n\n  Rework the rail\n"), "Rework the rail");
  check("whitespace collapses", normalizeTitle("a   b\t\tc"), "a b c");
  // Controls are stripped rather than refused: on the derived path the input is a
  // prompt somebody wrote for an agent, and there is nobody to refuse to.
  check("control characters are stripped, not refused", normalizeTitle("a\u0000b\u001fc"), "a b c");
  check("and the paragraph separator counts as one", normalizeTitle("a\u2029b"), "a b");
  // `null` and never "": the column distinguishes "never named" from "named", and
  // "" would be a third state that renders as a blank header.
  check("nothing left means null, never an empty string", normalizeTitle("   \t  "), null);
  check("an empty prompt names nothing", deriveSessionTitle("\n\n"), null);
  check("a long title is clipped with an ellipsis", (normalizeTitle("x".repeat(200)) ?? "").length, MAX_TITLE_CHARS);
  {
    // Breaking on a nearby space is the difference between "the reconnect back"
    // and "the reconnect ba". Only a *nearby* one — a single 200-character word
    // has no space worth breaking on and must still be clipped.
    const derived = deriveSessionTitle("Rework the reconnect backoff so a dead tunnel does not spin for ever") ?? "";
    check("a derived title breaks on a word", derived.endsWith("…") && !/\s…$/.test(derived), true);
    check("and stays within its own shorter bound", derived.length <= 60, true);
    check("a single long word is still clipped", (deriveSessionTitle("x".repeat(300)) ?? "").length <= 60, true);
  }
}

process.stdout.write("\nan agent's own placeholder choices\n");
{
  /*
   * Measured 2026-07-31 against claude 0.63.0: its model list opens with a
   * placeholder, `default` / "Default (recommended)", whose description is
   * character-for-character that of `opus[1m]`. Offering both is offering one model
   * twice under two names, and a session left on the placeholder is why the control
   * read "Default" and answered nothing.
   *
   * Here rather than in `webcheck` because this is the only side that *has* every
   * description — `snapshotConfig` keeps only the selected choice's prose, so the
   * browser cannot see that two rows match.
   */
  const model = {
    id: "model",
    name: "Model",
    description: "AI model to use",
    category: "model",
    kind: "select" as const,
    value: "default",
    choices: [
      { value: "default", name: "Default (recommended)", description: "Opus 5 with 1M context · Best for everyday", group: null },
      { value: "opus[1m]", name: "Opus (1M context)", description: "Opus 5 with 1M context · Best for everyday", group: null },
      { value: "sonnet", name: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", group: null },
    ],
  };
  const deduped = dedupeAliasChoices(model);
  check("the placeholder leaves the menu", deduped.choices.map((c) => c.value), ["opus[1m]", "sonnet"]);
  // A rename of an equivalent, not an invention: the agent said they are the same
  // thing by giving them the same description.
  check("and the session is shown on the real one", deduped.value, "opus[1m]");

  // Where nothing duplicates, nothing is dropped — and that is right rather than a
  // gap. Claude's effort choices carry no descriptions at all, and there the
  // placeholder is the only way back to the agent's own default.
  const effort = {
    ...model,
    id: "effort",
    category: "thought_level",
    choices: [
      { value: "default", name: "Default", description: null, group: null },
      { value: "high", name: "High", description: null, group: null },
    ],
  };
  check("a control with no descriptions keeps every choice", dedupeAliasChoices(effort).choices.length, 2);
  check("and its selection is untouched", dedupeAliasChoices(effort).value, "default");

  // Empty strings are not a statement that two rows are the same thing.
  const blank = {
    ...model,
    choices: [
      { value: "a", name: "A", description: "", group: null },
      { value: "b", name: "B", description: "   ", group: null },
    ],
  };
  check("blank descriptions do not make two choices aliases", dedupeAliasChoices(blank).choices.length, 2);
}

process.stdout.write("\ncontext usage is fanned out on what a client can see\n");
{
  // Measured 2026-07-31 against claude-agent-acp 0.63.0: `usage_update` fires from
  // the `message_delta` handler, i.e. on every streaming token. `touchSafe()` costs
  // a snapshot, a row write and a WS frame *per attached client*, on the agent's
  // own synchronous emit path — so this predicate is the only thing between a
  // working context readout and thousands of unperceivable frames per turn.
  const at = (used: number, size = 200_000) => ({ used, size, cost: null });

  check("a token that does not move the percent is not announced", usageWorthAnnouncing(at(1000), at(1001)), false);
  check("crossing a whole percent is", usageWorthAnnouncing(at(1000), at(3000)), true);
  check("and it is the rounded value that decides", usageWorthAnnouncing(at(2000), at(2999)), false);
  // The window itself changing is rare and always visible — a model switch resizes
  // it, and every percentage on screen becomes wrong at once.
  check("a resized window is always announced", usageWorthAnnouncing(at(1000), at(1000, 100_000)), true);
  check("and so is a cost change", usageWorthAnnouncing({ ...at(1000), cost: null }, { ...at(1000), cost: { amount: 0.4, currency: "USD" } }), true);
  // `size: 0` is "cannot tell", and crossing into or out of it flips a client
  // between drawing a percentage and drawing nothing at all.
  check("entering cannot-tell is announced", usageWorthAnnouncing(at(1000), at(1000, 0)), true);
  check("leaving it is too", usageWorthAnnouncing(at(1000, 0), at(1000)), true);
  check("and inside it any movement counts, since nothing can be rounded", usageWorthAnnouncing(at(1000, 0), at(1001, 0)), true);
  check("a repeat of the same reading is not announced", usageWorthAnnouncing(at(1000), at(1000)), false);
}

process.stdout.write("\nevery verb this app registers is one a browser may send\n");
{
  // `CORS_ALLOW_METHODS`'s comment claims to be "every method any route uses",
  // and for two releases it was not: `PUT /agent-auth/:agent` shipped without
  // being added, so the paste-a-token path preflight-failed in every browser
  // while working perfectly from `curl` — the failure a literal list exists to
  // prevent rather than cause. That claim is checkable, and only here: this is
  // the one driver that mounts the real app, so it is the only place that can
  // see the routes and the list at the same time.
  //
  // The direction matters. A method the list carries and no route uses is
  // harmless; a method a route uses and the list omits is a route no browser can
  // reach. So this asserts containment one way only.
  const registered = [...new Set(app.routes.map((route) => route.method.toUpperCase()))]
    .filter((method) => method !== "ALL") // Hono's middleware wildcard, not a verb a client sends
    .sort();
  const advertised = new Set<string>(CORS_ALLOW_METHODS);
  check("no route uses a verb the CORS list withholds", registered.filter((m) => !advertised.has(m)), []);
  check("and OPTIONS is advertised, or nothing preflights at all", advertised.has("OPTIONS"), true);
}

process.stdout.write("\nbrowsing and health\n");
const roots = await get("/fs/roots", "u_alice");
check("the picker starts at the configured roots", roots.body.roots, [users]);
// Unfiltered now. Every recent cwd is one a session really can start in, so
// dropping the ones outside the roots would hide exactly the useful ones.
check("and every recent directory is offered", roots.body.recent.length > 0, true);

const outsideRoots = realpathSync(tmp("elsewhere-"));
const listOutside = await get(`/fs/list?path=${encodeURIComponent(outsideRoots)}`, "u_alice");
check("listing outside the roots is refused", listOutside.status, 403);
check("with a code naming what to change", listOutside.body.error.code, "outside_roots");

// And the asymmetry, asserted rather than left as prose: the roots narrow the
// *listing* and nothing else, so a directory the picker will not show is still a
// directory a session may start in. That is the point — somebody keeping a
// repository outside their browse roots must not be locked out of it.
//
// Asserted on `resolveCwd` directly, because that is where the property lives:
// `registry.create` resolves the cwd *before* it asks whether the agent exists,
// so this is the whole of the decision and it needs nothing installed.
check("but resolving it as a session cwd is not", await resolveCwd(outsideRoots), outsideRoots);

/*
 * The route agrees, and this asserts that it was **not refused for the path**
 * rather than that it succeeded.
 *
 * `check(..., 201)` was wrong in two directions at once. It failed in CI, where
 * no agent is installed and `create` therefore answers `503 agent_unavailable` —
 * the same lesson as the deleted `dockercheck` driver, which needed a real agent
 * on PATH and was removed because that is the one thing CI cannot have,
 * relearned one driver later. And it *passed* on a developer machine only by
 * really spawning `kimi` and completing an ACP
 * handshake, inside the driver whose own header promises no agent is involved,
 * leaving a session and a worktree behind for a line that was never about either.
 *
 * So what is checked is the refusal that would be a regression: `outside_roots`.
 * Anything else means the path was accepted and the request went on to fail, or
 * not, for reasons that have nothing to do with the browse roots.
 */
const createOutside = await app.fetch(
  new Request("http://d/sessions", {
    method: "POST",
    headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
    body: JSON.stringify({ agent: "kimi", cwd: outsideRoots }),
  }),
);
const outsideBody = (await createOutside.json()) as { error?: { code?: string } };
check("and the route does not refuse it for being outside them", outsideBody.error?.code === "outside_roots", false);
check("nor with the status that refusal carries", createOutside.status === 403, false);

process.stdout.write("\ncreating a folder\n");
{
  const mkdir = async (sub: string, body: unknown) =>
    app.fetch(
      new Request("http://d/fs/mkdir", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor(sub)}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const made = await mkdir("u_alice", { parent: join(users, "u_alice"), name: "fresh" });
  check("a folder is created where it was asked for", made.status, 201);
  check("and it is where they asked", (await made.json() as any).path, join(users, "u_alice", "fresh"));

  // The name is a single segment, so traversal is not a thing to normalize away
  // — there is nowhere to put a separator that the daemon then has to unpick.
  const climb = await mkdir("u_alice", { parent: join(users, "u_alice"), name: "../u_bob/sneaky" });
  check("a separator in the name is refused outright", climb.status, 400);
  check("with a code that says why", (await climb.json() as any).error.code, "invalid_path");
  check("and nothing was created", existsSync(join(users, "u_bob", "sneaky")), false);

  const dots = await mkdir("u_alice", { parent: join(users, "u_alice"), name: ".." });
  check("and `..` alone is not a folder name", dots.status, 400);

  // The parent is resolved exactly as `POST /sessions` resolves a cwd — which now
  // means neither is confined, so a folder can be made anywhere a session could
  // run. The single-segment rule above is what makes that safe to say: there is
  // still no way to express a traversal, only a place.
  const outside = await mkdir("u_alice", { parent: join(users, "u_bob"), name: "made-here" });
  check("a parent outside the browse roots is accepted", outside.status, 201);
  check("and the folder is there", existsSync(join(users, "u_bob", "made-here")), true);

  const missing = await mkdir("u_alice", { parent: join(users, "u_alice", "nowhere"), name: "x" });
  check("but a parent that does not exist is not", missing.status, 400);
  check("with a code that says which half was wrong", (await missing.json() as any).error.code, "not_found");
}

/* ------------------------------------------------------------------ *
 * Signing out, as a state of the machine
 *
 * A credential is read once, at spawn, so signing out used to reach nothing that
 * was already running: the conversation carried on answering for an account its
 * owner had just revoked, and the only sign anything had changed was a badge on
 * another screen. What is asserted here is that the sign-out ends them, that
 * nothing brings them back on its own, and that signing in brings back exactly
 * those and no others.
 *
 * The `null` rule is the one worth breaking the build over. `loginState` has
 * three answers, and kimi's permanent, correct one is "could not tell" — it
 * publishes no status verb. A refusal written as `!== true` would take every kimi
 * conversation on the machine off the air for ever, on the strength of a question
 * kimi cannot be asked.
 * ------------------------------------------------------------------ */

process.stdout.write("\nsigning out, as a state of the machine\n");
{
  const events = readFileSync(new URL("../src/events.ts", import.meta.url), "utf8");
  const reg = readFileSync(new URL("../src/registry.ts", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../src/runtime/local.ts", import.meta.url), "utf8");

  check("there is a reason for it", /\| "agent_signed_out"/.test(events), true);
  /*
   * **Not a daemon exit.** That list is "the daemon went away rather than anybody
   * deciding anything", and it is what the boot pass resumes. A person decided
   * this, so putting it there would have the daemon relaunch, at every restart,
   * an agent whose credential was deliberately taken away.
   */
  check(
    "and it is not one of the daemon's own",
    /DAEMON_EXIT_REASONS = \["daemon_restarted", "daemon_shutdown", "config_changed"\]/.test(events),
    true,
  );
  /*
   * ⚠ **A prompt resumes it and a boot pass does not**, which reverses half of
   * what this line used to assert (`return false;` on both triggers).
   *
   * The old rule made the state unreachable from inside the app: `reloadCredentials`
   * is the only other reversal and every one of its callers is an in-app credential
   * write, so a CLI that refreshed its own token — or somebody signing in from
   * their own terminal — left a conversation nothing could bring back. Asserted
   * against the *function* rather than its source text, which is what a regex on
   * `return false;` could never tell apart from the arm above it.
   */
  // The trigger split for this reason is asserted with the rest of the table, in
  // "what a restart brings back" — a regex over `return false;` could never tell
  // this arm from the one above it.

  check("signing out ends the live conversations", /async signOutSessions\(agent: AgentId\): Promise<number>/.test(reg), true);
  check("with that reason", /session\.stop\("agent_signed_out"\)/.test(reg), true);
  /*
   * Deliberately not filtered by `takesCredentialChange`: that spares a turn in
   * flight because a working turn is evidence of a working credential. Here the
   * credential is being taken away, and a turn still running on it is exactly
   * what somebody signing out means to stop.
   */
  check("including one mid-turn, unlike a credential being added", /takesCredentialChange/.test(
    /async signOutSessions[\s\S]*?\n  \}/.exec(reg)?.[0] ?? "",
  ), false);
  check("and the route waits for it before answering", /await registry\.signOutSessions\(agent\)/.test(routes), true);

  /*
   * **A credential that went away some other way is reported by the agent**, not
   * discovered by asking. The prompt path deliberately has no probe: one there
   * cost a spawn per message, was only ever as fresh as a 3s cache, and made this
   * driver depend on whether the person running it was signed in — a stub runtime
   * inherits the real probe, and `resolveLoginBinary` finds the adapter's own
   * vendored binary in `node_modules`, which on CI is signed in to nothing.
   */
  check("the prompt path asks no CLI whether anybody is signed in", /sessionRuntime\.signedOut\(/.test(routes), false);
  /*
   * Comments stripped, because the docblocks here quote the call this used to
   * make and the message it must never read — which is the point of writing them
   * down, and would otherwise make these assertions fail on their own
   * explanation.
   */
  const code = reg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("the agent's own failure is what it reacts to", /isAuthFailure\(event\)/.test(reg), true);
  /*
   * ⚠ **And it replaces the agent rather than ending the conversation.**
   *
   * This asserted `this.stop("agent_signed_out")` on the event pump, which is the
   * line Q7.99 had already measured wrong: a session idle 5h36m reported
   * `authentication_failed` while the token on disk was valid for another 1.4h,
   * and a fresh agent worked four minutes later. What was stale was the process.
   * Ending the conversation threw away the half that was fine.
   *
   * The error is in the log either way — `record` appends before this runs — so
   * what is asserted here is that nothing *else* is done to the session but give
   * it a new process.
   */
  check("and replaces the agent instead of ending the conversation", /onAgentUnusable\(\): void \{[\s\S]*?restartAgent\(\)/.test(reg), true);
  check("never stopping it on the pump", /onAgentUnusable\(\): void \{[\s\S]*?\n  \}/.exec(reg)?.[0].includes('stop("agent_signed_out")'), false);
  /*
   * ⚠ **And the second caller, which is the one a screenshot found.** An ACP
   * session that dies under a *live* process leaves `status: idle` and answers
   * every message with the same `-32603` — no `errorKind`, so `isAuthFailure`
   * quite correctly ignores it, and no way out of the conversation from inside
   * the app. Four messages, four identical errors.
   *
   * `failed` is the precise signal: reaching the pump's own `catch` means
   * `session.prompt()` **rejected** rather than streamed a failure, so the agent
   * never took the message. Anything that goes wrong *inside* a turn arrives
   * through `record` and never comes near it — which is what stops this firing
   * on an ordinary bad turn.
   */
  check("a prompt the agent never took also replaces it", /if \(failed\) this\.onAgentUnusable\(\);/.test(code), true);
  check("and the message is never what decides", /describeError\(error\)[\s\S]{0,400}onAgentUnusable/.test(code), false);
  /*
   * Armed per prompt, which is the difference between a retry and a loop: a
   * credential that really is gone fails the fresh agent too, and the second
   * failure must not start a third process.
   */
  check("one replacement per message somebody sends", /this\.authRestartArmed = true;/.test(reg), true);
  check("spent when it fires", /onAgentUnusable\(\): void \{[\s\S]*?this\.authRestartArmed = false;/.test(reg), true);
  /*
   * Still the only writer of the reason, so signing out still ends conversations.
   *
   * Counted with the comments stripped, which is not fastidiousness: the docblock
   * on `onAuthFailure` quotes the call it used to make, so a naive count reads 2
   * and the assertion would have to be loosened to a number that no longer means
   * "one call site".
   */
  check("only an explicit sign-out still writes the reason", (code.match(/stop\("agent_signed_out"\)/g) ?? []).length, 1);
  check("and it is the sign-out route's own sweep", /signOutSessions[\s\S]*?stop\("agent_signed_out"\)/.test(code), true);

  /*
   * The kind, never the message: `describeError`'s text is the agent's own prose
   * and moves with its version, and matching "authenticate" in it would end a
   * conversation because of a sentence somebody's CLI happens to print.
   */
  const { isAuthFailure } = await import("../src/events.js");
  check("an auth failure is recognised", isAuthFailure({ type: "error", data: { code: -32603, data: { errorKind: "authentication_failed" } } }), true);
  check("another agent error is not", isAuthFailure({ type: "error", data: { code: -32603, data: { errorKind: "something_else" } } }), false);
  check("nor is the message alone", isAuthFailure({ type: "error", data: { code: -32603, data: {} } }), false);
  check("a non-error event never is", isAuthFailure({ type: "text", data: { data: { errorKind: "authentication_failed" } } }), false);
  // Every shape it must survive rather than throw on, since this runs on the pump.
  for (const shape of [undefined, null, "text", 7, {}, { data: null }, { data: "x" }] as unknown[]) {
    check(`and a payload of ${JSON.stringify(shape) ?? "undefined"} is refused quietly`, isAuthFailure({ type: "error", data: shape }), false);
  }

  /*
   * The probe that used to sit on the prompt path is **deleted**, not merely
   * unused — with the note saying why in its place, for the reason `paths.ts`
   * gives about `atOrUnderReal`: a method with no callers and a docblock arguing
   * for itself reads as live policy to whoever finds it next.
   */
  check("the probe is gone rather than left for a future caller", /async signedOut\(/.test(runtime), false);
  check("with the reason it is gone written where it was", /`signedOut\(agent\)` used to live here/.test(runtime), true);
}

/* ------------------------------------------------------------------ *
 * A credential saved while an agent is already running
 *
 * Secrets are injected at spawn — `env: { ...agentEnv(), ...this.secrets(agent) }`
 * — so a token saved afterwards reaches a running agent never. Measured on a live
 * daemon: a token saved at 00:23:02, a prompt refused at 00:23:12 with
 * `Failed to authenticate`, and a session created four minutes later working at
 * once. The save updated the database, turned the badge green, and changed
 * nothing for the conversation somebody was looking at.
 *
 * What is asserted here is the *decision*, which is pure: which sessions take a
 * relaunch and which are left alone. The relaunch itself is `applyUltracode`'s
 * sequence, already covered, and the fan-out is deliberately not awaited.
 *
 * The refusals matter more than the acceptance. A mid-turn session is one whose
 * credential is demonstrably working, and stopping it would kill the turn; a
 * blocked one is somebody being waited on, and a relaunch drops the question
 * without answering it.
 * ------------------------------------------------------------------ */

process.stdout.write("\na credential saved while an agent is already running\n");
{
  const src = readFileSync(new URL("../src/registry.ts", import.meta.url), "utf8");

  // The guard set, read off the predicate itself: each of these is a state in
  // which a relaunch would destroy something a person is waiting on.
  const guard = /get takesCredentialChange\(\): boolean \{[\s\S]*?\n  \}/.exec(src)?.[0] ?? "";
  report("a relaunch is refused for a session that has ended", /this\.terminal \|\| this\.stopRequested/.test(guard), "terminal");
  report("and for one with a turn in flight", /this\.turn !== null/.test(guard), "mid-turn");
  report("and for one with somebody parked on a question", /this\.awaitingCount > 0/.test(guard), "blocked");
  // Both flags read, however the predicate happens to be phrased — the guard was
  // written as `!this.clearing && !this.restarting`, and pinning one spelling
  // would fail on a rewrite that changed nothing.
  report(
    "and while another process boundary is already open",
    /this\.clearing/.test(guard) && /this\.restarting/.test(guard),
    "clearing/restarting",
  );

  /*
   * The count has to be decided before the work starts. The first version
   * incremented and then decremented inside a `.then`, which resolves after the
   * return — so every refusal was still counted as a restart and the screen would
   * have reported chats it never touched.
   */
  /*
   * The parameter list is matched loosely on purpose: what these assertions are
   * about is the body, and pinning the signature here meant that adding `revive`
   * emptied `fan` — which the positive `.test()` checks below caught loudly, being
   * `false` against an expected `true`. The one that does **not** is the negated
   * one, `!/void session\.applyCredentialChange\(\)/`, which is vacuously true
   * against `""` and would have gone on passing while asserting nothing at all.
   * That asymmetry is the reason for the guard on the next line rather than for
   * the loosened regex: one negated assertion over an extracted string is enough
   * to need it.
   */
  const fan = /reloadCredentials\([^)]*\): number \{[\s\S]*?\n  \}/.exec(src)?.[0] ?? "";
  check("the fan-out was found at all, so the checks below mean something", fan.length > 0, true);
  check("the fan-out counts what it filtered", /session\.takesCredentialChange/.test(fan), true);
  check(
    "and returns that, not a number it hoped to correct later",
    /return restarting\.length \+ returning\.length;/.test(fan),
    true,
  );
  /*
   * Detached, and *within* that, serialised — two properties that pull opposite
   * ways and are both required.
   *
   * Detached is the old rule and the reason this method returns `number` rather
   * than `Promise<number>`: the caller answers with the count and does not wait
   * for a single teardown. Serialised is the new one. Each of these restarts is a
   * SIGTERM, a process teardown, a spawn and an ACP handshake; issued as N bare
   * `void` calls they all began at once, so one credential save on a full machine
   * was `DEFAULT_MAX_SESSIONS` of them against this one event loop — the
   * thundering herd `signOutSessions` refuses in this same file, over this same
   * work. The `void` therefore has to sit on the *loop* rather than on each call,
   * which is what these two assertions pin between them.
   */
  check("without awaiting the restarts", /void \(async \(\) => \{/.test(fan), true);
  check(
    "but one at a time inside that, not a herd of SIGTERMs at once",
    /await session\.applyCredentialChange\(\)/.test(fan) && !/void session\.applyCredentialChange\(\)/.test(fan),
    true,
  );
  /*
   * **Signing in reverses a sign-out and nothing else.** The reason is the record
   * of who ended a session: one this daemon ended because the credential went
   * away is owed a resume when a credential returns, and one a person stopped by
   * hand carries `stopped` and stays stopped. Keying on `terminal` alone would
   * revive both, which is the daemon overruling somebody.
   */
  check("and signing in brings back what the sign-out ended", /exit\?\.reason === "agent_signed_out"/.test(fan), true);
  check("keyed on the reason rather than on being terminal at all", /session\.terminal && session\.exit\?\.reason/.test(fan), true);

  /*
   * One sequence, two callers. It was written for `ultracode` and is subtle
   * enough — a synchronously-opened window, five guard sites, one `finally` — that
   * a second copy would drift.
   */
  check("the restart sequence has one definition", (src.match(/private async restartAgent\(/g) ?? []).length, 1);
  check("and ultracode goes through it", /await this\.restartAgent\(\);[\s\S]{0,80}\}/.test(src), true);
  check("and so does a credential change", /takesCredentialChange[\s\S]{0,400}await this\.restartAgent\(\)/.test(src), true);

  // The route reports it, so a client can say what happened rather than guessing.
  const routes = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  check("saving a credential relaunches and says how many", /saved: true, agent, envName, restarting/.test(routes), true);
  check("and so does removing one", /removed: true, agent, envName, restarting/.test(routes), true);

  /*
   * ⚠ **Which direction the credential went, which both routes used to lose.**
   *
   * `reloadCredentials` does two things: it restarts the sessions still running,
   * because a secret is injected at spawn and neither a save nor a removal reaches
   * one that is already up; and it resumes the sessions that were ended *because
   * there was no credential*. The first is right for both callers. The second is
   * right for exactly one — and DELETE reached it too, so removing a credential
   * revived every `agent_signed_out` conversation and handed each a fresh agent
   * with nothing to authenticate with, which is the `Internal error: Failed to
   * authenticate` this file argues against elsewhere. A removal is a sign-out's
   * second half, never its reversal.
   *
   * Three assertions rather than one, because each half can regress alone: that
   * the resume is gated at all, that DELETE asks for it not to happen, and that
   * PUT still leaves it on.
   */
  check("the resume half is gated on which way the change went", /revive\s*\?/.test(fan), true);
  check("and the default is the one that revives, so a save needs no argument", /revive = true/.test(fan), true);

  /*
   * Anchored to each handler rather than grepped over the whole file, because the
   * two calls differ only in an argument and the lines around them are identical
   * — so a file-wide test for both strings passes just as happily with the PUT and
   * the DELETE swapped, which is the one mistake these assertions exist to catch.
   */
  const put = /app\.put\("\/agent-auth\/:agent"[\s\S]*?\n  \}\);/.exec(routes)?.[0] ?? "";
  const del = /app\.delete\("\/agent-auth\/:agent"[\s\S]*?\n  \}\);/.exec(routes)?.[0] ?? "";
  check("both agent-auth handlers were found, so the two below mean something", [put.length > 0, del.length > 0], [true, true]);
  check("removing a credential does not revive what a sign-out ended", /reloadCredentials\(agent, false\)/.test(del), true);
  check("and saving one still does", /reloadCredentials\(agent\)/.test(put), true);
}

/* ------------------------------------------------------------------ *
 * A login that cannot be offered
 *
 * `loginStdio` fixed BSD `script` for the flows that read nothing, and the one
 * that reads something was left with an enabled button that opens a wizard and
 * dies in a `<pre>`. `loginBlockedReason` is the answer *before* the button is
 * drawn, and it is asserted for every platform from a machine that is one of
 * them — the same reason `loginStdio` and `hostLoginArgs` are pure.
 * ------------------------------------------------------------------ */

process.stdout.write("\na login that cannot be offered\n");
{
  const ok = (p: NodeJS.Platform, interactive: boolean) => loginBlockedReason(p, interactive, true, true);

  check("claude on macOS cannot be offered a wizard", ok("darwin", true), "interactive_pty");
  check("nor on the other BSDs", [ok("freebsd", true), ok("openbsd", true), ok("netbsd", true)], [
    "interactive_pty",
    "interactive_pty",
    "interactive_pty",
  ]);
  // The whole point of the distinction: the device-code flows are fine there,
  // because `loginStdio` can hand them /dev/null.
  check("a device-code flow on macOS is fine", ok("darwin", false), null);
  check("and everything is fine on Linux, including the interactive one", [ok("linux", true), ok("linux", false)], [
    null,
    null,
  ]);

  // The two older reasons still answer first, and in this order: a host with no
  // `script` cannot run any login, whatever the flow.
  check("no script outranks the platform", loginBlockedReason("darwin", true, false, true), "no_script");
  check("and a missing CLI outranks the flow", loginBlockedReason("darwin", true, true, false), "no_cli");
  check("with a present CLI and script on Linux clearing it", loginBlockedReason("linux", true, true, true), null);

  /*
   * `supported` is `blocked === null` and nothing else, asserted against the
   * **real** `loginSupport` rather than by re-deriving it here. Comparing the
   * pure function to itself is a tautology that passes whatever the runtime does,
   * which is precisely the "assertion passing for the wrong reason" this file
   * warns about elsewhere.
   */
  {
    const runtime = new LocalRuntime();
    for (const agent of AGENT_IDS) {
      const support = runtime.loginSupport(agent);
      check(
        `${agent}: supported is exactly "nothing is blocking it"`,
        support.supported,
        support.blocked === null,
      );
    }
    // On this machine, which is the one running the driver.
    const claude = runtime.loginSupport("claude");
    report(
      "and on a BSD host the interactive flow is the one that is blocked",
      process.platform !== "darwin" || claude.blocked === "interactive_pty" || claude.blocked === "no_cli",
      `${process.platform}: claude blocked=${String(claude.blocked)}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Importing a codebase
 *
 * The guard here is unlike every other one in this file, because this is the
 * only route that takes a *path* from somebody else and creates a file at it.
 * Everywhere else a path is either one this daemon made or one a person picked
 * out of a listing of what already exists; an archive member is a string written
 * by whoever built the archive, and `paths.ts` is explicit that none of the
 * containment primitives may be used to authorise an action on one.
 *
 * So the assertions below come in pairs on purpose: the refusal, and then that
 * **nothing was created** — including no staging directory. A refusal that
 * leaves half a tree behind is not a refusal, and the second half is the one
 * that would rot silently.
 *
 * The archives are built here rather than shelled out to `zip` and `tar`, for
 * two reasons: neither is guaranteed on a CI box, and neither will *produce*
 * most of what needs testing — GNU tar refuses to write a `../` member at all,
 * which is exactly the member worth being sure about.
 * ------------------------------------------------------------------ */

process.stdout.write("\nimporting a codebase\n");
{
  const pad512 = (n: number): number => (512 - (n % 512)) % 512;

  interface Member {
    name: string;
    data?: Buffer;
    dir?: boolean;
    /** tar typeflag; zip reads `mode` instead. */
    type?: string;
    link?: string;
    /** Unix st_mode for zip's external attributes: 0o120777 is a symlink. */
    mode?: number;
    method?: number;
    encrypted?: boolean;
    /** Raw name bytes, which also clears the UTF-8 flag. */
    rawName?: Buffer;
    /**
     * A tar size field that disagrees with the bytes that follow it.
     *
     * The whole point of a header field somebody else wrote: every archive this
     * driver builds honestly is one the reader could have trusted. Only a member
     * that *declares* more than it carries exercises the bound.
     */
    declaredSize?: number;
  }

  const tarHeader = (name: string, size: number, type: string, link = ""): Buffer => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, "utf8");
    h.write("000755 \0", 100);
    h.write("000000 \0", 108);
    h.write("000000 \0", 116);
    h.write(size.toString(8).padStart(11, "0") + " ", 124);
    h.write("00000000000 ", 136);
    h.write("        ", 148); // spaces while the checksum is summed over the block
    h.write(type, 156);
    h.write(link.slice(0, 100), 157, "utf8");
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };

  const buildTarGz = (members: Member[]): Buffer => {
    const parts: Buffer[] = [];
    for (const m of members) {
      const type = m.type ?? (m.dir === true ? "5" : "0");
      const data = m.dir === true || type === "2" || type === "1" ? Buffer.alloc(0) : (m.data ?? Buffer.alloc(0));
      parts.push(tarHeader(m.name, m.declaredSize ?? data.length, type, m.link ?? ""));
      if (data.length > 0) parts.push(data, Buffer.alloc(pad512(data.length)));
    }
    parts.push(Buffer.alloc(1024)); // the two zero blocks that end an archive
    return gzipSync(Buffer.concat(parts));
  };

  /** A pax `x` header carrying `path=`, then the member it renames. */
  const paxMember = (realPath: string, data: Buffer): Member[] => {
    const make = (len: number): string => `${len} path=${realPath}\n`;
    let len = make(0).length;
    for (let i = 0; i < 4; i += 1) len = make(len).length;
    return [
      { name: "PaxHeader/x", type: "x", data: Buffer.from(make(len), "utf8") },
      { name: "short-stand-in", type: "0", data },
    ];
  };

  const buildZip = (members: Member[]): Buffer => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const m of members) {
      const nameStr = m.dir === true && !m.name.endsWith("/") ? `${m.name}/` : m.name;
      const name = m.rawName ?? Buffer.from(nameStr, "utf8");
      const raw = m.dir === true ? Buffer.alloc(0) : (m.data ?? Buffer.alloc(0));
      const method = m.method ?? (raw.length === 0 ? 0 : 8);
      const body = method === 8 ? deflateRawSync(raw) : raw;
      const flags = (m.rawName ? 0 : 0x0800) | (m.encrypted === true ? 0x0001 : 0);

      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(flags, 6);
      lh.writeUInt16LE(method, 8);
      lh.writeUInt32LE(crc32(raw), 14);
      lh.writeUInt32LE(body.length, 18);
      lh.writeUInt32LE(raw.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, body);

      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(((3 << 8) | 20) >>> 0, 4); // "made by" UNIX, so the mode is read
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(flags, 8);
      ch.writeUInt16LE(method, 10);
      ch.writeUInt32LE(crc32(raw), 16);
      ch.writeUInt32LE(body.length, 20);
      ch.writeUInt32LE(raw.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE((((m.mode ?? (m.dir === true ? 0o040755 : 0o100644)) << 16) >>> 0), 38);
      ch.writeUInt32LE(offset, 42);
      centrals.push(ch, name);
      offset += 30 + name.length + body.length;
    }
    const local = Buffer.concat(locals);
    const central = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(members.length, 8);
    eocd.writeUInt16LE(members.length, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(local.length, 16);
    return Buffer.concat([local, central, eocd]);
  };

  let box = 0;
  /** A fresh empty directory to import into, so no case can see another's leavings. */
  const target = (): string => {
    const dir = join(users, "u_alice", `import-${box++}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const send = async (
    into: string,
    archive: Buffer,
    name = "a.zip",
  ): Promise<{ status: number; body: any; left: string[] }> => {
    const res = await app.fetch(
      new Request(`http://d/fs/import?path=${encodeURIComponent(into)}&name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
        body: new Uint8Array(archive),
        // Node refuses a streaming request body without it, and this is what a
        // browser sends too.
        duplex: "half",
      } as RequestInit),
    );
    return { status: res.status, body: await res.json(), left: readdirSync(into).sort() };
  };

  const good: Member[] = [
    { name: "app/", dir: true },
    { name: "app/src/", dir: true },
    { name: "app/src/index.js", data: Buffer.from("console.log(1)\n") },
    { name: "app/README.md", data: Buffer.from("# app\n") },
  ];

  /* The happy path, both formats, because they are two separate readers. */
  for (const [label, archive, name] of [
    ["a zip", buildZip(good), "app.zip"],
    ["a tar.gz", buildTarGz(good), "app.tar.gz"],
  ] as const) {
    const into = target();
    const out = await send(into, archive, name);
    check(`${label} unpacks`, out.status, 201);
    check(`${label} lands as the one folder the archive named`, out.body.import.name, "app");
    check(`${label} answers the path the picker walks into`, out.body.import.path, join(into, "app"));
    check(`${label} wrote the file that was in it`, readFileSync(join(into, "app/src/index.js"), "utf8"), "console.log(1)\n");
    check(`${label} counted the members rather than reporting zero`, out.body.import.entries > 0, true);
    check(`${label} left no staging directory behind`, out.left, ["app"]);
  }

  /* Every refusal, and its second half: that nothing was created. */
  const refusals: [string, Buffer, string, number, string][] = [
    ["a member that climbs out of the tree", buildZip([...good, { name: "app/../../out.txt", data: Buffer.from("x") }]), "escapes_root", 400, "archive_unsafe"],
    ["the same member in a tar", buildTarGz([...good, { name: "app/../../out.txt", data: Buffer.from("x") }]), "escapes_root", 400, "archive_unsafe"],
    ["an absolute member", buildZip([...good, { name: "/tmp/out.txt", data: Buffer.from("x") }]), "absolute_path", 400, "archive_unsafe"],
    ["a zip symlink, by its mode bits", buildZip([...good, { name: "app/link", mode: 0o120777, data: Buffer.from("/etc") }]), "not_a_regular_file", 400, "archive_unsafe"],
    ["a tar symlink, by its typeflag", buildTarGz([...good, { name: "app/link", type: "2", link: "/etc" }]), "not_a_regular_file", 400, "archive_unsafe"],
    ["a tar hardlink", buildTarGz([...good, { name: "app/hard", type: "1", link: "/etc/passwd" }]), "not_a_regular_file", 400, "archive_unsafe"],
    ["a device node", buildTarGz([...good, { name: "app/dev", type: "3" }]), "not_a_regular_file", 400, "archive_unsafe"],
    ["a .git the daemon would run hooks out of", buildZip([...good, { name: "app/.git/hooks/post-checkout", data: Buffer.from("#!/bin/sh\n") }]), "git_directory", 400, "archive_unsafe"],
    /*
     * ⚠ **The case variants, and they are not pedantry.** The exact-case
     * comparison these replaced was measured letting `.GIT/config` through, on
     * the APFS this is developed on — where the imported directory is then
     * reachable as `.git`, `git rev-parse --git-dir` answers `.git`, and the
     * `git status` in `changes.ts` runs the `core.fsmonitor` out of it. Both
     * readers, because the refusal is shared and a regression could reach either.
     */
    ["the same .git spelled .GIT, which APFS does not tell apart", buildZip([...good, { name: "app/.GIT/config", data: Buffer.from("[core]\n") }]), "git_directory", 400, "archive_unsafe"],
    ["and .Git in a tar", buildTarGz([...good, { name: "app/.Git/config", data: Buffer.from("[core]\n") }]), "git_directory", 400, "archive_unsafe"],
    /*
     * The one member body read whole rather than streamed, so the one whose
     * declared size becomes an allocation. Declared 200 MiB, carries nothing:
     * unbounded, this exact archive was measured at 2.2 GB resident and three
     * minutes of synchronous copying with the event loop stopped throughout,
     * and it finished by calling the archive *empty*.
     */
    ["a pax header that declares more than this daemon will hold", buildTarGz([{ name: "app/", dir: true }, { name: "PaxHeader/x", type: "x", data: Buffer.from("x"), declaredSize: 200 * 1024 * 1024 }]), "path_too_long", 400, "archive_unsafe"],
    ["and the GNU long-name header beside it", buildTarGz([{ name: "app/", dir: true }, { name: "././@LongLink", type: "L", data: Buffer.from("x"), declaredSize: 200 * 1024 * 1024 }]), "path_too_long", 400, "archive_unsafe"],
    ["an encrypted member", buildZip([...good, { name: "app/s", data: Buffer.from("x"), encrypted: true }]), "encrypted", 400, "archive_unsafe"],
    ["a compression this daemon does not read", buildZip([...good, { name: "app/b", data: Buffer.from("x"), method: 12 }]), "unsupported_method", 400, "archive_unsafe"],
    ["a name that is not UTF-8", buildZip([...good, { name: "x", rawName: Buffer.from([0x61, 0xff]), data: Buffer.from("x") }]), "unsupported_name_encoding", 400, "archive_unsafe"],
  ];
  for (const [label, archive, reason, status, code] of refusals) {
    const into = target();
    const out = await send(into, archive);
    check(`${label} is refused`, out.status, status);
    check(`and says which member and why`, [out.body.error.code, out.body.error.detail?.reason], [code, reason]);
    check(`and nothing at all was created`, out.left, []);
  }

  {
    const into = target();
    const out = await send(into, Buffer.from("this is not an archive at all"));
    check("something that is not an archive is refused", out.status, 400);
    check("on its bytes rather than its filename", out.body.error.code, "unsupported_archive");
    check("and left nothing behind", out.left, []);
  }

  {
    const into = target();
    const out = await send(into, buildZip([...good, { name: "__MACOSX/", dir: true }, { name: "__MACOSX/app/._x", data: Buffer.from("junk") }]));
    check("Finder's resource-fork tree does not count as a second root", out.status, 201);
    check("so the folder is still the real one", out.left, ["app"]);
  }

  {
    const into = target();
    const deep = "app/" + "a-long-segment-".repeat(9) + "end.txt";
    const out = await send(into, buildTarGz([{ name: "app/", dir: true }, ...paxMember(deep, Buffer.from("pax"))]), "app.tar.gz");
    check("a pax extended header is read rather than refused", out.status, 201);
    check("and the member takes the name the pax record gave it", readFileSync(join(into, deep), "utf8"), "pax");
    check("rather than the short stand-in beside it", existsSync(join(into, "app/short-stand-in")), false);
  }

  {
    const into = target();
    const out = await send(into, buildZip([{ name: "a.txt", data: Buffer.from("x") }, { name: "b.txt", data: Buffer.from("y") }]), "my-thing.zip");
    check("loose members at the root are gathered under the archive's own name", out.body.import.name, "my-thing");
    check("and that is the one folder in the target", out.left, ["my-thing"]);
  }

  /*
   * The containment gate itself, held against strings rather than archives.
   *
   * `safeMemberPath` is pure precisely so this is possible — its docblock says a
   * driver "can hold every hostile string ever published against it without a
   * temp directory" — and four of its eleven refusals had no assertion anywhere,
   * because reaching them through a built archive is awkward and reaching them
   * here is one line each.
   */
  {
    const rows: [string, string, string | null][] = [
      ["a plain member is allowed through", "app/src/index.ts", null],
      ["a NUL in a name", "app/a\0b.ts", "control_char"],
      ["and any other control character", "app/ab.ts", "control_char"],
      ["a backslash, never translated to a slash", "app\\b.ts", "backslash"],
      ["deeper than this daemon will nest", `${"a/".repeat(MAX_IMPORT_DEPTH + 1)}f.ts`, "too_deep"],
      ["exactly at the depth bound is still fine", `${"a/".repeat(MAX_IMPORT_DEPTH - 1)}f.ts`, null],
      ["longer than this daemon will read", "a".repeat(MAX_IMPORT_PATH_CHARS + 1), "path_too_long"],
      ["exactly at the length bound is still fine", "a".repeat(MAX_IMPORT_PATH_CHARS), null],
      [".git by any spelling — this one lower", "app/.git/config", "git_directory"],
      ["this one upper", "app/.GIT/config", "git_directory"],
      ["and this one mixed", "app/.GiT/config", "git_directory"],
      ["`..` refused rather than resolved", "app/../../x", "escapes_root"],
    ];
    for (const [label, raw, reason] of rows) {
      const verdict = safeMemberPath(raw);
      check(label, verdict.ok ? null : verdict.reason, reason);
    }

    /*
     * The archive's own root, which is a skip and not a refusal.
     *
     * `tar -czf x.tar.gz .` writes `./` first, and `safeMemberPath` answers
     * `escapes_root` for it — correctly, on its own terms: every segment dropped,
     * nothing left, the same shape as `a/../../x`. So one of the two ordinary ways
     * to make an archive was refused whole, under the message meant for a
     * traversal attempt. The line between the two is what this table is.
     */
    const roots: [string, string, boolean][] = [
      ["what bsdtar writes for the directory itself", "./", true],
      ["and the bare form", ".", true],
      ["a name that is only separators", "//", true],
      ["an empty name", "", true],
      ["but `..` is not a root, it is a climb", "..", false],
      ["nor is it one behind a dot", "./..", false],
      ["nor after a real segment", "app/..", false],
      ["a real member is not a root", "./app/index.ts", false],
      ["and neither is a name that merely starts with a dot", ".git", false],
    ];
    for (const [label, raw, want] of roots) check(label, isArchiveRoot(raw), want);
  }

  {
    /*
     * The whole archive, the way `tar -czf x.tar.gz .` actually arrives — the
     * `./` member first, then everything under it. Driven rather than left to the
     * pure table, because what broke was not the predicate but the reader
     * throwing on the first member and taking the archive with it.
     */
    const into = target();
    const out = await send(
      into,
      buildTarGz([
        { name: "./", dir: true },
        { name: "./src/", dir: true },
        { name: "./README.md", data: Buffer.from("# app\n") },
        { name: "./src/index.js", data: Buffer.from("console.log(1)\n") },
      ]),
      "myproj.tar.gz",
    );
    check("an archive of `.` is imported rather than refused", out.status, 201);
    check("its members are loose at the root, so it takes the archive's name", out.body.import.name, "myproj");
    check("and the root member is not counted as one", out.body.import.entries, 3);
    check("the nested file arrived", readFileSync(join(into, "myproj/src/index.js"), "utf8"), "console.log(1)\n");
    check("and no folder was made for the dot itself", readdirSync(join(into, "myproj")).sort(), ["README.md", "src"]);
    // The other half of the same rule: a name the *folder* takes, which is the
    // one place a query parameter becomes a directory.
    check("a folder named .git is refused whatever its case", importFolderName(".GIT.zip"), "imported");
    check("and so is the lowercase one", importFolderName(".git.tar.gz"), "imported");
  }

  /*
   * The last word on a folder name, which the *archive's* own choice used to skip.
   *
   * Both sources reach `settleFolderName` now; only the query parameter also gets
   * `importFolderName`'s allowlist in front of it. The pair of tables below is
   * that split: what must be settled either way, and what must survive when the
   * name came out of the archive rather than off the wire.
   */
  {
    const settled: [string, string, string][] = [
      ["a leading dash, which is what makes a name an option", "-rf", "rf"],
      ["several of them", "---exclude=x", "exclude=x"],
      ["a name that is nothing but dashes", "---", "imported"],
      ["an empty name", "", "imported"],
      ["a lone dot", ".", "imported"],
      ["two of them", "..", "imported"],
      [".git by any spelling, here too", ".GIT", "imported"],
      ["a name longer than anybody meant", "a".repeat(200), "a".repeat(100)],
      /*
       * ⚠ A hazard the sweeper created rather than one it found. `sweepStaleStaging`
       * deletes anything under the target wearing this exact name and older than an
       * hour, on the reasoning that only this daemon ever generates one. Publishing
       * an archive's folder under it would make that false — and the folder would be
       * deleted by the next import into the same directory, an hour after somebody
       * was told it existed.
       */
      ["a name this daemon would later mistake for its own litter", ".reemoat-import-00112233445566aa", "imported"],
      ["but only the exact shape of it", ".reemoat-import-nothex", ".reemoat-import-nothex"],
    ];
    for (const [label, raw, want] of settled) check(label, settleFolderName(raw), want);

    /*
     * And what it must NOT do, which is why this is not `importFolderName`.
     * Running the allowlist over an archive's own folder would answer `My-Project`
     * and turn every non-Latin name into a row of dashes — a worse answer than the
     * question deserves, and one nobody asked for.
     */
    check("a space is not a threat", settleFolderName("My Project"), "My Project");
    check("nor is an alphabet", settleFolderName("проект"), "проект");
    check("a cap never splits a surrogate pair", [...settleFolderName("🙂".repeat(200))].length, 100);
  }

  {
    const into = target();
    const out = await send(into, buildTarGz([{ name: "-rf/", dir: true }, { name: "-rf/a.txt", data: Buffer.from("x") }]), "app.tar.gz");
    check("an archive may not publish a folder that is an option", out.status, 201);
    check("the dash is taken off rather than the import refused", out.body.import.name, "rf");
    check("and that is what is on disk", out.left, ["rf"]);
  }

  /*
   * ⚠ **Litter from a run that never reached its `finally`.**
   *
   * `discardStaging` cleans up on every path the process survives, and an OOM is
   * not one — which the unbounded extended header above made reachable. Swept on
   * the way in, because staging lives inside a target this daemon only learns
   * about when somebody names it, so the next import is the one moment the path
   * is known. Three narrowings, one case each.
   */
  {
    const into = target();
    const hex = (n: string) => join(into, `.reemoat-import-${n}`);
    const old = Date.now() / 1000 - 7200;

    const stale = hex("00112233445566aa");
    mkdirSync(stale);
    writeFileSync(join(stale, "archive.bin"), "half an import");
    utimesSync(stale, old, old);

    const fresh = hex("00112233445566bb");
    mkdirSync(fresh);

    // Wearing the name but not a directory: `lstat` says so, and it is neither
    // followed nor removed.
    const elsewhere = join(into, "not-staging");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "mine");
    symlinkSync(elsewhere, hex("00112233445566cc"));

    // Shaped almost right, which is the whole reason the test is exact.
    const notOurs = join(into, ".reemoat-import-nothex");
    mkdirSync(notOurs);
    utimesSync(notOurs, old, old);

    const out = await send(into, buildZip(good));
    check("an import still succeeds with litter in the folder", out.status, 201);
    check("a stale staging directory is swept", existsSync(stale), false);
    check("one too young to be litter is left alone", existsSync(fresh), true);
    check("a symlink wearing the name is not followed", readFileSync(join(elsewhere, "keep.txt"), "utf8"), "mine");
    check("nor removed", existsSync(hex("00112233445566cc")), true);
    check("and a name this daemon never generates is not ours to delete", existsSync(notOurs), true);
  }

  /*
   * ⚠ **Two imports in flight at once, which is the assertion the 409 never had.**
   *
   * The guard used to read `importing` and then `await resolveCwd` before writing
   * it, so every request that arrived during that suspension read `false` — the
   * bound did not hold for the case the route's own docblock is about, which is
   * the 256 streams the relay allows arriving together. Firing without awaiting
   * is what tells the two apart: serialised, this passes either way.
   */
  {
    const first = target();
    const second = target();
    const [a, b] = await Promise.all([send(first, buildZip(good)), send(second, buildZip(good))]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    check("two imports at once: one is taken", statuses, [201, 409]);
    const refused = a.status === 409 ? a : b;
    check("and the other is told the machine is busy", refused.body.error.code, "import_busy");
    check("and the refused one created nothing", refused.left, []);
    // The flag is released rather than wedged: a third import after both settle
    // must still be accepted, or the route is dead for the daemon's whole life.
    const third = target();
    check("a later import still works", (await send(third, buildZip(good))).status, 201);
  }

  {
    const into = target();
    await send(into, buildZip(good));
    const again = await send(into, buildZip(good));
    check("a second import of the same name is refused", again.status, 409);
    check("with a code the client can act on", again.body.error.code, "import_exists");
    check("and the first one is untouched", readFileSync(join(into, "app/README.md"), "utf8"), "# app\n");
    check("and no staging directory survived the refusal", again.left, ["app"]);
  }

  {
    // The destination already being a symlink is the case `rename` answers
    // `ENOTDIR` to rather than `EEXIST`, and the one where getting it wrong means
    // writing through somebody's link.
    const into = target();
    mkdirSync(join(into, "elsewhere"));
    symlinkSync(join(into, "elsewhere"), join(into, "app"));
    const out = await send(into, buildZip(good));
    check("a destination that is already a symlink is refused", out.status, 409);
    check("rather than written through", existsSync(join(into, "elsewhere/README.md")), false);
  }

  {
    const into = target();
    /*
     * Built from one buffer repeated rather than a single half-gigabyte member,
     * so the *driver* does not need the memory the daemon is refusing to spend.
     * Zeros deflate to almost nothing, so the archive stays far under the wire
     * bound — which is the point: this refusal has to come from the unpacked
     * counter, not from the one on the way in.
     */
    const slab = Buffer.alloc(50 * 1024 * 1024);
    const slabs: Member[] = [{ name: "app/", dir: true }];
    for (let i = 0; i * slab.length <= MAX_IMPORT_UNPACKED_BYTES; i += 1) {
      slabs.push({ name: `app/zeros-${i}`, data: slab });
    }
    const bomb = buildZip(slabs);
    check("and the bomb itself is small enough to be accepted on the wire", bomb.length < MAX_IMPORT_BYTES, true);
    const out = await send(into, bomb);
    check("a bomb is refused on the bytes it actually produced", out.status, 413);
    check("rather than on the size it declared", out.body.error.code, "import_unpacked_too_large");
    check("and left nothing behind", out.left, []);
  }

  {
    const into = target();
    const many: Member[] = [{ name: "app/", dir: true }];
    for (let i = 0; i <= MAX_IMPORT_ENTRIES; i += 1) many.push({ name: `app/f${i}`, data: Buffer.alloc(0) });
    const out = await send(into, buildZip(many));
    check("more members than the ceiling is refused", out.status, 413);
    check("because a byte cap cannot see an inode", out.body.error.code, "import_too_many_entries");
    check("and left nothing behind", out.left, []);
  }

  {
    const into = target();
    const res = await app.fetch(
      new Request(`http://d/fs/import?path=${encodeURIComponent(into)}&name=a.zip`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-length": String(MAX_IMPORT_BYTES + 1) },
        body: new Uint8Array(buildZip(good)),
        duplex: "half",
      } as RequestInit),
    );
    check("an over-size archive is refused on the header", res.status, 413);
    check("before any of it is read", ((await res.json()) as any).error.code, "import_too_large");
    check("and nothing was created", readdirSync(into), []);
  }

  {
    // The exemption is a predicate over both streaming routes now, so the thing
    // worth pinning is that it is still *narrow*: every other POST is bounded.
    const into = target();
    const res = await app.fetch(
      new Request("http://d/fs/mkdir", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify({ parent: into, name: "x".repeat(2 * 1024 * 1024) }),
      }),
    );
    check("a route that is not a streaming one is still bounded at 1 MiB", res.status, 413);
    const big = await send(into, buildZip(good));
    check("while the import route takes a body past that bound", big.status, 201);
  }

  {
    const into = target();
    const res = await app.fetch(
      new Request(`http://d/fs/import?path=${encodeURIComponent(into)}&name=a.zip`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenWith("u_alice", ["session:read"])}` },
        body: new Uint8Array(buildZip(good)),
        duplex: "half",
      } as RequestInit),
    );
    check("a read-only grant may not import", res.status, 403);
    check("and nothing was created", readdirSync(into), []);
  }
}

/* ------------------------------------------------------------------ *
 * A directory that does not answer
 *
 * The failure this guards against was measured on 2026-08-02 and is the reason
 * `stalled` exists: `~/OrbStack` is a hard NFS mount inside the default browse
 * root, `describe`'s timeout bounds the *response* while libuv cannot cancel the
 * *work*, and each abandoned `readdir` keeps a threadpool slot for the life of
 * the process. Two listings of that home directory exhausted the default pool of
 * four, after which every `await` on `node:fs/promises` in the daemon queued for
 * ever — so `POST /fs/mkdir` and `POST /sessions` never answered and the browser
 * gave up at 15s with `TimeoutError: signal timed out`, while `/health`, which
 * touches no files, went on reporting the daemon up.
 *
 * A stalled mount is the one thing a driver cannot synthesize, which is what
 * `probeTimeoutMs` is for: at 0 the deadline fires before any filesystem call
 * can complete, so the *decision* is exercised on a perfectly healthy disk and
 * nothing is left wedged. What is asserted is the decision — refuse, remember,
 * and let the pending probe clear the memory when it settles.
 * ------------------------------------------------------------------ */

process.stdout.write("\na directory that does not answer\n");
{
  forgetStalled();
  const home = join(users, "u_alice");

  check("nothing is stalled to begin with", isStalled(home), false);

  // A deadline of 0 cannot be met by a syscall that has to cross a thread, so
  // this is the stall path taken against a directory that is in fact fine.
  let code: string | null = null;
  try {
    await resolveCwd(home, { probeTimeoutMs: 0 });
  } catch (error) {
    code = error instanceof PathError ? error.code : String(error);
  }
  check("a path that misses its deadline is refused", code, "unresponsive");
  check("and it is not reported as missing, which would be a lie", code === "not_found", false);
  check("and it is remembered, so the next caller spends nothing", isStalled(home), true);

  // The refusal is immediate and needs no filesystem call at all. This is the
  // half that turns one lost slot into exactly one, rather than one per attempt
  // — and a person whose folder did not appear taps the button again.
  const before = Date.now();
  let second: string | null = null;
  try {
    await makeDir(home, "never-created");
  } catch (error) {
    second = error instanceof PathError ? error.code : String(error);
  }
  check("a second attempt is refused without touching the disk", second, "unresponsive");
  check("immediately, rather than at the client's own timeout", Date.now() - before < 100, true);
  check("and nothing was created", existsSync(join(home, "never-created")), false);

  // The still-pending probe is the re-arm: when the mount answers again, the
  // memory clears itself. A TTL would re-arm the leak on a mount that is still
  // down, which is why there is not one.
  await new Promise((resolve) => setTimeout(resolve, 50));
  check("the memory clears itself once the probe settles", isStalled(home), false);
  check("so the path works again with no intervention", await resolveCwd(home), home);

  // A listing of a path that will not answer refuses on the same deadline, and
  // that is the whole point: before this, it queued behind a syscall that never
  // returns, held the request open until the client gave up, and spent three
  // more slots doing it.
  forgetStalled();
  let listCode: string | null = null;
  try {
    await listDirs(home, { roots: [users], showHidden: false, probeTimeoutMs: 0 });
  } catch (error) {
    listCode = error instanceof PathError ? error.code : String(error);
  }
  check("a listing that misses its deadline refuses too", listCode, "unresponsive");
  forgetStalled();

  // And the healthy listing is unchanged, which is the half that says the
  // deadline has not been put in front of ordinary use.
  const healthy = await listDirs(home, { roots: [users], showHidden: false });
  check("while a healthy listing is untouched", healthy.path, home);
  // The non-emptiness is its own line, the same shape the live mount table gets
  // below: `every` on an empty array is `true`, so a listing that came back with
  // no children at all would have passed the line under this one while proving
  // the opposite of what it claims.
  check("and it found children to describe", healthy.entries.length > 0, true);
  check("and still describes them", healthy.entries.every((e) => e.entries !== null), true);
}

/* The status a stalled path earns, which is not the one a missing path earns.
 * A client that read "not answering" as "gone" would prune a perfectly good
 * recent-directory row for a mount that is merely asleep. */
{
  const stalledStatus = await app.fetch(
    new Request("http://d/fs/list?path=" + encodeURIComponent(join(users, "u_alice", "proj")), {
      headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
    }),
  );
  check("a healthy listing is still a 200", stalledStatus.status, 200);
}

/* ------------------------------------------------------------------ *
 * The kernel's mount table
 *
 * Read so that a stall on a network filesystem is remembered as the *mount*
 * rather than as one directory on it: ask `~/OrbStack` once and every directory
 * beneath it is answered for free, where per-path memory would spend two
 * threadpool slots learning the same fact about each of them.
 *
 * The parsers are the part that cannot be checked by running this on one
 * machine — a host is only ever Linux or BSD, and getting the other format
 * wrong is silent — so both are driven from text here.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * a workspace on a filesystem that stopped answering
 *
 * The picker was not the only route reaching a caller-named path. For a `plain`
 * session `workspace.root` *is* the `cwd` that was asked for, and `server.ts`
 * checked it with `existsSync` in front of `GET /sessions/:id/changes` — a
 * synchronous filesystem call, on somebody else's path, reachable with
 * `session:read`. On a stalled mount that stops the event loop, which is the
 * whole daemon and not one request; `browse.ts` had already been rewritten to
 * avoid exactly this, which is why the mechanism lives in `stall.ts` now rather
 * than inside the module that first needed it.
 *
 * The other half is that "gone" and "did not answer" stopped being the same
 * answer. Telling somebody their working directory no longer exists, when what
 * happened is that a NAS went to sleep, is a confident lie about their work.
 * ------------------------------------------------------------------ */

process.stdout.write("\na workspace on a filesystem that stopped answering\n");
{
  const live = join(users, "u_alice", "proj");
  check("a directory that answers says so", await probeExists(live), true);
  check("and one that is genuinely absent says that", await probeExists(join(users, "u_alice", "no-such-dir")), false);
  // The third answer, forced with a deadline that has already passed — the same
  // seam `listDirs` uses, because a real stalled mount is the one thing a driver
  // cannot synthesize.
  check("a deadline that has passed is neither", await probeExists(live, { probeTimeoutMs: 0 }), null);

  // That probe left the path in the memory, so the route below is answered from
  // it without touching the disk at all. This is the behaviour that matters: the
  // cost is paid once, not once per request.
  check("and the path is remembered as not answering", isStalled(live), true);

  const changes = await get("/sessions/s_one/changes", "u_alice");
  check("the changes route refuses rather than hanging", changes.status, 503);
  check("with a code that does not claim the work is gone", changes.body.error.code, "workspace_unresponsive");
  const diff = await get("/sessions/s_one/changes/diff?path=notes.txt", "u_alice");
  check("and so does the diff route", diff.status, 503);

  // A session whose directory really is missing still gets the 409 it always
  // got: the two answers are distinct, which is the entire point of the third.
  forgetStalled();
  const changesLive = await get("/sessions/s_one/changes", "u_alice");
  check("once it answers again, so does the route", changesLive.status, 200);
}

/* ------------------------------------------------------------------ *
 * one stalled server answers for everything beneath it
 *
 * The parsers below are covered; what was not covered is the reason they exist.
 * `stallKeyFor` keys a path on a network filesystem by its **mount point**, so
 * probing one directory under a dead NAS teaches the daemon about every other —
 * and a local path keys by itself, because `/` is a mount point too and keying
 * local paths by their mount would let one unreadable directory mark the entire
 * filesystem as not answering.
 *
 * Without the `mounts` seam every probe in this driver took the `remote: false`
 * arm, so the whole payoff of reading the kernel's table was asserted nowhere.
 * ------------------------------------------------------------------ */

process.stdout.write("\none stalled server answers for everything beneath it\n");
{
  forgetStalled();
  const nas = join(sandbox, "nas");
  const inside = join(nas, "project");
  const sibling = join(nas, "other");
  mkdirSync(inside, { recursive: true });
  mkdirSync(sibling, { recursive: true });

  // A synthetic table: this sandbox directory declared an NFS mount, plus the
  // root filesystem underneath it so "longest match wins" is actually exercised.
  const mounts = [
    { point: "/", type: "apfs", remote: false },
    { point: nas, type: "nfs", remote: true },
  ];

  // One probe, against one directory, with a deadline that has already passed.
  // Navigating *into* it is refused rather than degraded: a listing of a
  // directory we cannot resolve has nothing to show, and saying so beats a
  // spinner until the client's own timeout.
  const listCode = await listDirs(inside, { roots: [sandbox], showHidden: false, probeTimeoutMs: 0, mounts }).then(
    () => "ok",
    (error: unknown) => (error as { code?: string }).code,
  );
  check("navigating into it is refused", listCode, "unresponsive");

  // What was learned is the *mount*, not the directory.
  check("the mount point is what is remembered", isStalled(nas), true);
  check("and not the directory that was asked about", isStalled(inside), false);

  // Which is the whole point: a sibling under the same dead server costs nothing.
  check("so a sibling under it is already known", isStalled(nas), true);
  const cwdCode = await resolveCwd(sibling, { mounts }).then(
    () => "ok",
    (error: unknown) => (error as { code?: string }).code,
  );
  check("and is refused without touching the disk", cwdCode, "unresponsive");

  // A local path that hangs is a fact about that path and nothing else, or one
  // bad `readdir` would mark the entire filesystem as not answering.
  forgetStalled();
  const localDir = join(sandbox, "plainly-local");
  mkdirSync(localDir, { recursive: true });
  await resolveCwd(localDir, { probeTimeoutMs: 0, mounts }).catch(() => undefined);
  check("a local path is remembered as itself", isStalled(localDir), true);
  check("and never as the filesystem it sits on", isStalled("/"), false);
  forgetStalled();
}

process.stdout.write("\nthe mount table\n");
{
  const linux = parseLinuxMounts(
    [
      "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
      "/dev/sda1 / ext4 rw,relatime 0 0",
      "server:/export /mnt/nas nfs4 rw,relatime 0 0",
      "//host/share /mnt/win\\040share cifs rw 0 0",
      "garbage",
    ].join("\n"),
  );
  check("procfs yields one entry per mount", linux.length, 4);
  check("with the point and the type off the right fields", [linux[1]?.point, linux[1]?.type], ["/", "ext4"]);
  check("a local filesystem is not remote", linux[1]?.remote, false);
  check("nfs4 is", linux[2]?.remote, true);
  // The kernel octal-escapes a space, and a point that keeps the escape matches
  // nothing at all — which would silently disable the bounding for that mount.
  check("an escaped space in a mount point is decoded", linux[3]?.point, "/mnt/win share");
  check("and cifs is remote too", linux[3]?.remote, true);

  const bsd = parseBsdMounts(
    [
      "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
      "OrbStack:/OrbStack on /Users/rends/OrbStack (nfs, nodev, nosuid, noatime, mounted by rends)",
      "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
      "",
    ].join("\n"),
  );
  check("mount(8) yields one entry per line", bsd.length, 3);
  check("the point is what follows ` on `", bsd[1]?.point, "/Users/rends/OrbStack");
  check("and the type is the first option", bsd[1]?.type, "nfs");
  check("apfs is local", bsd[0]?.remote, false);
  check("the measured OrbStack mount is remote", bsd[1]?.remote, true);

  check("sshfs over fuse is remote", isRemoteType("fuse.sshfs"), true);
  // FUSE is a transport, not a filesystem. Treating `fuse.*` as remote wholesale
  // would degrade an ordinary local disk.
  check("but ntfs over fuse is not", isRemoteType("fuse.ntfs"), false);
  check("an unknown type is not assumed remote", isRemoteType("madeup"), false);

  // Longest wins, because `/` is a mount point too — first-match would report
  // every path in the system as being on the root filesystem.
  const table = bsd;
  check("a path picks the deepest mount above it", mountFor("/Users/rends/OrbStack/x", table)?.point, "/Users/rends/OrbStack");
  check("and an unrelated path picks the root", mountFor("/Users/rends/code", table)?.point, "/");
  // Segment-wise, through the one containment primitive: a sibling that merely
  // shares a prefix is not on that mount.
  check("a sibling sharing a prefix is not on it", mountFor("/Users/rends/OrbStackOther", table)?.point, "/");
  check("nothing matches when the table is empty", mountFor("/anything", []), null);

  // And the real table on this machine, which is the only thing that proves the
  // platform dispatch and the reading path work at all.
  const live = await readMounts();
  check("the live table is readable on this platform", live.length > 0, true);
  check("and every entry is an absolute path", live.every((m) => m.point.startsWith("/")), true);
  check("the root filesystem is in it", live.some((m) => m.point === "/"), true);
}

/* The containment primitive the browse path now uses directly.
 *
 * `atOrUnderResolved` is the segment-wise comparison with the resolving step
 * lifted out, because both sides arrive resolved and `realpathSync` on a
 * caller-supplied path is exactly what this module must not do on the event
 * loop. It is the same rule, so it has to answer the same way — above all on
 * the prefix case that a bare `startsWith` gets wrong. */
{
  check("a root is at-or-under itself", atOrUnderResolved("/wt/proj", "/wt/proj"), true);
  check("but is not contained in itself", containedInResolved("/wt/proj", "/wt/proj"), false);
  check("a child is both", containedInResolved("/wt/proj/src", "/wt/proj"), true);
  // The one that a prefix test merges, and the guard on the only `rmSync` in
  // the codebase is downstream of it.
  check("a sibling sharing a prefix is neither", containedInResolved("/wt/proj-old", "/wt/proj"), false);
  check("nor at-or-under it", atOrUnderResolved("/wt/proj-old", "/wt/proj"), false);
  check("a trailing separator on the root changes nothing", containedInResolved("/wt/proj/src", "/wt/proj/"), true);
  // The resolving variants must agree with the pure ones on paths that need no
  // resolving, or the split has introduced the drift it exists to prevent.
  check("the resolving variant agrees on a real path", atOrUnder(users, users), atOrUnderResolved(users, users));
  check("and on a real child", containedIn(join(users, "u_alice"), users), containedInResolved(join(users, "u_alice"), users));
}

const worktrees = await get("/worktrees", "u_alice");
// The registry's own policy root, which is the same one `createWorkspace` uses —
// they disagreed once, and the containment check that guards the only `rmSync`
// in the codebase then refused every time while the route reported success.
check("the worktree root reported is the one sessions are created under", worktrees.body.root, registry.workspacePolicy.worktreeRoot);

const health = (await (await app.fetch(new Request("http://d/health"))).json()) as Record<string, unknown>;
check("health still answers without a token", health.ok, true);
check("and still carries the clock, which is what it is for", typeof health.time, "number");
check("but no longer counts other people's sessions", "sessions" in health, false);
check("nor how long one has been blocked", "blocked" in health, false);
/*
 * What this daemon is, on the one route a client can read before it holds a
 * token — which is the client that most needs to know, `packages/web` shipping
 * inside the control plane's image and therefore arriving newer than the daemon
 * it is pointed at every Tuesday.
 *
 * Asserted here rather than nowhere: `pincheck` said this literal could only be
 * read off the file because "no offline driver starts a daemon and a relay
 * together", which is true and is not the claim — this route needs no relay, and
 * this driver has been fetching the object three lines up all along.
 *
 * `version` against the constant and `protocol` against the negotiation's own
 * maximum, because that is the pair a client uses to tell an old machine from a
 * new one without either of them branching on it.
 */
check("health names the build this daemon is", health.version, DAEMON_VERSION);
check("and the tunnel protocol it speaks", health.protocol, RELAY_PROTOCOL_VERSION);

/* ------------------------------------------------------------------ *
 * A relay URL this daemon cannot dial
 *
 * `relaycheck` owns the tunnel's protocol; what is driven here is the one thing
 * about it that is not about the relay at all — whether a daemon whose
 * `REEMOAT_CP_RELAY_URL` is wrong still runs. `tunnel.ts`'s header promises a
 * relay that is down, unreachable or rejecting costs nothing but log lines, and
 * this was the input that broke that promise before any socket was involved.
 *
 * `target.protocol = "ws:"` is a **silent no-op** for a scheme the URL spec does
 * not call special, so `htps://relay.example` — which `new URL` accepts, and
 * which `enroll.ts` and the control plane's own validation both accept for the
 * same reason — kept its scheme, fell through the guard that looked like it had
 * normalized it, and threw out of `new WebSocket` *outside* the try. There is no
 * `uncaughtException` handler in `scripts/daemon.ts`, and under a unit carrying
 * `KeepAlive`/`RunAtLoad` that is a permanent crash loop whose every pass re-runs
 * `restore()` and auto-resume, spawning agents that are killed seconds later.
 *
 * Every assertion below is written so a regression fails a *line* rather than
 * taking the process down: the throw is caught here and reported as a value,
 * because the whole subject of this section is a throw nobody caught.
 * ------------------------------------------------------------------ */

process.stdout.write("\na relay URL this daemon cannot dial\n");
{
  const dialFrom = async (relayUrl: string): Promise<{ threw: string | null; events: string[] }> => {
    const events: string[] = [];
    let threw: string | null = null;
    let tunnel: RelayTunnel | null = null;
    try {
      tunnel = RelayTunnel.start({
        relayUrl,
        tunnelKey: "tk_daemoncheck",
        // Never reached on any path this section drives, and deliberately a port
        // nothing here is listening on: a refusal must happen before a socket.
        local: { host: "127.0.0.1", port: 1 },
        onEvent: (kind, detail) => void events.push(`${kind} ${detail}`),
      });
    } catch (error) {
      threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    await tunnel?.stop();
    return { threw, events };
  };

  const mistyped = await dialFrom("htps://relay.example");
  check("a mistyped scheme does not throw out of start()", mistyped.threw, null);
  check("it is reported as a refusal instead", mistyped.events.map((line) => line.split(" ")[0]), ["rejected"]);
  // Naming the scheme rather than saying "unusable", because the whole content of
  // this failure is one letter in an env file somebody has to find.
  check("naming the scheme it would not dial", mistyped.events[0]?.includes("htps"), true);
  check("and nothing was ever dialled", mistyped.events.some((line) => line.startsWith("connecting")), false);

  // The arm that already existed, kept as the control: a refusal that swallowed
  // everything would pass the three lines above without the guard meaning a thing.
  const unparseable = await dialFrom("not a url at all");
  check("a URL that does not parse is refused the same way", unparseable.events.map((line) => line.split(" ")[0]), ["rejected"]);

  /*
   * And the other half of the same edit: `ws`/`wss` were **added** to the allowed
   * set, because a relay URL already stored in that form is what an older
   * enrollment wrote and it still has to dial. Without this line the guard could
   * be "fixed" by refusing everything that is not http/https, which would take the
   * fleet off the network rather than off the crash loop.
   */
  const wsForm = await dialFrom("ws://127.0.0.1:1");
  check("a URL already stored in ws form is dialled rather than refused", wsForm.threw, null);
  check("and it really reached the dial", wsForm.events[0]?.split(" ")[0], "connecting");
  check("keeping the scheme it arrived with", wsForm.events[0]?.includes("ws://127.0.0.1:1"), true);
}

/* ------------------------------------------------------------------ *
 * The stream, over a real socket
 * ------------------------------------------------------------------ */

/**
 * The one route that cannot be checked with `app.fetch`.
 *
 * `upgradeWebSocket`'s handler only runs for an actual upgrade; a plain request
 * falls through and Hono answers 404 — for a real session id exactly as much as
 * for a made-up one. So any assertion built on `app.fetch` here was true no
 * matter what the handler did, and this route is the one that hands out a live
 * transcript feed. A real listener and a real `ws://` client is the only way to
 * tell the two 404s apart, and `relaycheck` already proves the technique works in
 * this repo.
 */
process.stdout.write("\nthe stream, over a real socket\n");

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
// The same cast `scripts/daemon.ts` makes: `serve` is typed as possibly
// returning an Http2Server, and `injectWebSocket` wants the http one.
injectWebSocket(server as unknown as Server);
await new Promise<void>((resolve) => server.once("listening", resolve));
const { port } = server.address() as AddressInfo;

/** Resolves how the socket ended: open with a frame, or refused. */
function attach(sessionId: string, sub: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/sessions/${sessionId}/stream?token=${tokenFor(sub)}`,
    );
    const done = (answer: string): void => {
      try {
        socket.close();
      } catch {
        // Already closing; the answer is what matters.
      }
      resolve(answer);
    };
    socket.on("message", () => done("frame"));
    socket.on("error", () => done("refused"));
    socket.on("unexpected-response", () => done("refused"));
    socket.on("close", () => resolve("closed"));
    setTimeout(() => done("silent"), 2_000);
  });
}

/**
 * Every frame one attach delivers, in order, up to and including `caught_up`.
 *
 * One function with two call sites rather than the same promise written twice,
 * because the two attach cases below differ only in which log they are pointed
 * at and what they are both measuring is the frame *sequence* — a collector that
 * drifted between them would have the two cases describing different protocols
 * while both stayed green. `port` is a parameter because the second case needs a
 * registry whose store evicts, which means its own app and its own listener.
 */
function streamFrames(
  atPort: number,
  sessionId: string,
  sub: string,
  since: number,
): Promise<Record<string, any>[]> {
  return new Promise((resolve) => {
    const out: Record<string, any>[] = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${atPort}/sessions/${sessionId}/stream?since=${since}&token=${tokenFor(sub)}`,
    );
    const done = (): void => {
      try {
        socket.close();
      } catch {
        // Already closing; what arrived is the answer.
      }
      resolve(out);
    };
    socket.on("message", (data: Buffer) => {
      let frame: Record<string, any>;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      out.push(frame);
      if (frame["type"] === "caught_up") done();
    });
    socket.on("error", done);
    setTimeout(done, 5_000);
  });
}

check("attaching to a real session opens and delivers", await attach("s_one", "u_alice"), "frame");
check("an id that exists nowhere is refused, over a real upgrade", await attach("s_nope", "u_alice"), "refused");

/* -- a request target the URL parser rejects ---------------------------- */

{
  /*
   * ⚠ **llhttp and the WHATWG URL parser disagree about what a request target
   * is**, and `@hono/node-ws`'s upgrade handler opens with an unguarded `new
   * URL(request.url ?? "/", "http://localhost")`. `GET //% HTTP/1.1` is accepted
   * by Node's HTTP parser and handed over verbatim; `new URL("//%", …)` throws.
   * Nothing then writes to the socket or destroys it — `requestTimeout` is
   * already cleared and `keepAliveTimeout` only arms once a response is sent —
   * so it is one leaked fd per line.
   *
   * Reachable through the relay with any token for this machine, because
   * `relay/proxy.ts`'s `readToken` reads the `Authorization` header *without*
   * touching the URL and then forwards `path: req.url` unchanged. That file
   * carries this exact guard, with a comment describing this exact failure; the
   * end it forwards to did not have one.
   *
   * Driven on a raw socket, because `fetch` and `ws` both normalize the target
   * through the very parser this is about — the same reason `relaycheck` drives
   * its copy this way.
   */
  const spoke = (target: string): Promise<string> =>
    new Promise((resolve) => {
      const socket = netConnect({ host: "127.0.0.1", port }, () => {
        socket.write(
          `GET ${target} HTTP/1.1\r\nHost: d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let seen = "";
      socket.on("data", (chunk: Buffer) => {
        seen += chunk.toString("utf8");
        if (seen.includes("\r\n")) {
          socket.destroy();
          resolve(seen.split("\r\n")[0] ?? "");
        }
      });
      socket.on("error", () => resolve("(socket error)"));
      socket.on("close", () => resolve(seen.split("\r\n")[0] ?? "(closed with nothing)"));
      setTimeout(() => {
        socket.destroy();
        resolve("(held open)");
      }, 2_000);
    });

  for (const target of ["//%", "/\\", "//["]) {
    check(`an unparseable target is answered rather than held: ${target}`, await spoke(target), "HTTP/1.1 400 Bad Request");
  }
  /*
   * And the ordinary handshake still works, which is the half that says the
   * guard wrapped the injected listener rather than replacing it — a sweep that
   * dropped the real handler would pass every line above and serve nothing.
   */
  check("while an ordinary handshake is untouched", await attach("s_one", "u_alice"), "frame");
}

/* ------------------------------------------------------------------ *
 * `?token=` is the handshake's exception, and only the handshake's
 *
 * The parameter has always been justified by one sentence — a browser cannot set
 * a header on a WebSocket handshake — and `readCredential` is called from the
 * single `app.use("*")` gate, so it authenticated *every* route. This section
 * exists because that gap could only be seen by asking two routes the same
 * question: the socket, which must still open on a query credential, and an
 * ordinary GET, which must not.
 *
 * The one it mattered on is `files`. `GET /sessions/:id/files?path=chart.png&
 * token=<jws>` answered with the bytes, which put a live bearer in
 * `location.search`, in browser history, in the `Referer` of whatever the page
 * loaded next and in every intermediary's log — on the same origin whose
 * `localStorage` holds `reemoat.credential`.
 * ------------------------------------------------------------------ */
{
  const query = `token=${encodeURIComponent(tokenFor("u_alice"))}`;
  // `async` rather than a bare arrow: Hono's own `fetch` is typed
  // `Response | Promise<Response>`, and awaiting copes with either.
  const bare = async (path: string): Promise<Response> => app.fetch(new Request(`http://d${path}`));

  check("an ordinary GET is not authenticated by a token in the URL", (await bare(`/sessions?${query}`)).status, 401);
  // The route the leak was actually reachable on, and the one whose whole answer
  // is bytes: a 200 here is a credential parked in the address bar of a tab
  // showing somebody's file.
  check("nor is the route that serves a file's bytes", (await bare(`/sessions/s_one/files?path=notes.txt&${query}`)).status, 401);
  // The positive control, and the half that carries the weight: the narrowing
  // must not have been done by simply deleting the parameter. `attach` above
  // already passes it as the only credential a `ws://` client can send, and this
  // says the same thing where the refusals are, so the two are read together.
  check("while the header is still all any route ever needed", (await get("/sessions", "u_alice")).status, 200);
  /*
   * And the rule is the `Upgrade` header rather than the stream route's path,
   * which is deliberate and therefore pinned. A route reader would have to be
   * kept in step with the routes and would fail *open* the day it fell behind.
   * Somebody who sets the header by hand gains nothing — they are holding the
   * token either way — because what this closes is the URL a browser follows,
   * and a browser following one never sends it.
   */
  const handshaking = await app.fetch(
    new Request(`http://d/sessions?${query}`, { headers: { upgrade: "websocket" } }),
  );
  check("a request that says it is a handshake may still carry it in the query", handshaking.status, 200);
}

{
  /*
   * **The attach is bounded where the history used to be.**
   *
   * A session's log is no longer truncated, so "attach at 0" can mean an
   * arbitrary number of events — and `attach` drains its whole backlog into the
   * outbound queue in one synchronous block, which past `MAX_QUEUE_EVENTS`
   * collapses and reports `lagged{slow_consumer}` about a client that was never
   * given the chance to be slow. That lie is what the old 5000-event retention
   * window was really buying, and paying for it with somebody's conversation was
   * the wrong trade.
   *
   * So the socket replays the newest `ATTACH_REPLAY_MAX` and says what it skipped,
   * with the one `lagged` reason that is **not** a loss: `backlog` means the
   * events are on disk and `GET /sessions/:id/events` serves them. Three separate
   * things have to hold, and only the first is obvious.
   */
  const many = registry.get("s_three");
  for (let n = 1; n <= 3_000; n += 1) {
    many?.log.append({ type: "text", role: "agent", thought: false, text: `w${n}` });
  }
  const lastSeq = many?.log.stats().lastSeq ?? 0;

  const frames = await streamFrames(port, "s_three", "u_alice", 0);

  const lagged = frames.filter((f) => f["type"] === "lagged");
  const delivered = frames
    .filter((f) => f["type"] === "events")
    .reduce((n, f) => n + (Array.isArray(f["events"]) ? f["events"].length : 0), 0);
  const caughtUp = frames.find((f) => f["type"] === "caught_up");

  check("a since=0 attach past the cap is told, with `backlog`", lagged.map((f) => f["reason"]), ["backlog"]);
  // Bounded, and by a real margin rather than "some events were skipped" — the
  // number that matters is that it stays under `MAX_QUEUE_EVENTS`, since going
  // over is what turns this into a `slow_consumer` close.
  check("and replays no more than the cap", delivered <= 2_000, true);
  check("but genuinely replays that much rather than nothing", delivered > 1_900, true);
  /*
   * The two that a "fewer events arrived" assertion would pass without.
   *
   * The skipped range has to be *named* — a client that is not told which seqs it
   * did not get cannot page them, and a silent skip is the contiguous-looking
   * transcript with a hole in the middle that this whole area exists to prevent.
   * And the cursor has to end at the head: `caught_up` is what says the socket is
   * live, and reporting it below `lastSeq` would leave the client believing it is
   * following a session it is 3000 events behind on.
   */
  check("the skipped range starts at the first event", lagged[0]?.["from"], 1);
  check("and ends where the replay begins", lagged[0]?.["to"], lastSeq - 2_000);
  check("the socket still goes live at the head of the log", caughtUp?.["seq"], lastSeq);
}

await new Promise<void>((resolve) => server.close(() => resolve()));

/* ------------------------------------------------------------------ *
 * An attach that is both evicted and behind
 * ------------------------------------------------------------------ */

/*
 * The hole in the case above, and the one place the arithmetic actually bites.
 *
 * `s_three`'s log has `dropped: 0`, so its attach emits exactly one `lagged`
 * frame and `Math.max(asked, oldest - 1)` is never exercised — replacing it with
 * the pre-diff `asked + 1` leaves every assertion up there green. Both frames
 * only appear together on a session that is *both* missing a prefix an older
 * daemon destroyed *and* further behind than `ATTACH_REPLAY_MAX`, which is
 * exactly the session that has been open longest.
 *
 * The two mean opposite things and the client draws them differently: `evicted`
 * is a loss, and the transcript ends there with a marker saying so; `backlog` is
 * not a loss at all — those events are on disk and `GET /sessions/:id/events`
 * serves them, so the client pages them in. Overlapping the ranges therefore
 * costs twice: the same seqs are reported destroyed *and* offered for paging,
 * and the two `dropped` counts a client adds up come to more than the log ever
 * held. Adjacency is the whole property, and it is one `Math.max` wide.
 */
process.stdout.write("\nan attach that is both evicted and behind\n");
{
  /*
   * The one registry in this driver whose store evicts. `dropped > 0` is the
   * entire precondition, and it cannot be reached on the main registry: a
   * session's log is unbounded by default, deliberately, which is why an
   * explicit window has to be built here rather than found.
   */
  const evicting = new MemoryEventStore({ maxEventsPerSession: 5_000 });
  const lagRegistry = new SessionRegistry(evicting, storeOf([rowFor("s_lag", join(users, "u_alice", "lag"))]));
  lagRegistry.restore({ reapOrphans: false });
  const { app: lagApp, injectWebSocket: injectLag } = createApp({
    registry: lagRegistry,
    verifier,
    instanceId: "i_lag",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const lagServer = serve({ fetch: lagApp.fetch, hostname: "127.0.0.1", port: 0 });
  injectLag(lagServer as unknown as Server);
  await new Promise<void>((resolve) => lagServer.once("listening", resolve));
  const lagPort = (lagServer.address() as AddressInfo).port;

  // Past the store's window *and* past the replay cap, which is what produces
  // both frames from one attach: a thousand evicted, three thousand skipped,
  // two thousand replayed.
  const managed = lagRegistry.get("s_lag");
  for (let n = 1; n <= 6_000; n += 1) {
    managed?.log.append({ type: "text", role: "agent", thought: false, text: `w${n}` });
  }
  const stats = managed?.log.stats() ?? { firstSeq: 0, lastSeq: 0, count: 0, dropped: 0, approxBytes: 0 };
  // The positive control. Without it every assertion below is about a session
  // that lost nothing, which is the case already covered — and a future default
  // that stopped this store evicting would make this whole section green and
  // meaningless rather than red.
  check("the store really did evict, or none of this is being driven", stats.dropped > 0, true);

  const frames = await streamFrames(lagPort, "s_lag", "u_alice", 0);
  const lagged = frames.filter((f) => f["type"] === "lagged");
  const delivered = frames
    .filter((f) => f["type"] === "events")
    .reduce((n, f) => n + (Array.isArray(f["events"]) ? f["events"].length : 0), 0);
  const caughtUp = frames.find((f) => f["type"] === "caught_up");

  // Order rather than membership: the loss is what ends the readable transcript,
  // so it has to be the frame a client sees first — it arrives before the range
  // that merely has to be fetched.
  check("both are reported, the loss before the backlog", lagged.map((f) => f["reason"]), ["evicted", "backlog"]);
  /*
   * **The load-bearing one.** With `asked + 1` the backlog range starts back at
   * 1 and swallows the evicted range whole, so a client is told to page seqs
   * that no longer exist — and every other assertion in this section except the
   * one below it still passes.
   */
  check(
    "and the second range begins exactly where the first ended",
    (lagged[0]?.["to"] ?? -1) + 1,
    lagged[1]?.["from"],
  );
  /*
   * Nothing is counted twice, stated against the socket's own behaviour rather
   * than against a copy of `attach`'s arithmetic: the client asked from 0, so
   * every seq up to `lastSeq` either arrived or was named in one of the two
   * frames, and in exactly one of them.
   */
  check(
    "so the two counts add up to exactly what was not delivered",
    lagged.reduce((n, f) => n + Number(f["dropped"] ?? 0), 0),
    stats.lastSeq - delivered,
  );
  // And the replay itself is unchanged by any of it. Exactly the cap, not
  // "about" it: the cursor is `lastSeq - ATTACH_REPLAY_MAX` and nothing in
  // between is dropped, so a delivery short of 2000 is a hole rather than a bound.
  check("the replay is still exactly the cap", delivered, 2_000);
  check("and the socket still goes live at the head of the log", caughtUp?.["seq"], stats.lastSeq);

  await new Promise<void>((resolve) => lagServer.close(() => resolve()));
}

/* ------------------------------------------------------------------ *
 * An attach that is small enough to replay and too large to send
 * ------------------------------------------------------------------ */

/*
 * **`ATTACH_REPLAY_MAX` bounds the count and `MAX_QUEUE_BYTES` bounds the bytes,
 * and only one of them was told the truth about which is which.**
 *
 * The constant is justified as sitting under `MAX_QUEUE_EVENTS` so that a big
 * attach can never be mistaken for a client that fell behind — but `enqueue`
 * collapses on *either* ceiling, and two thousand events of transcript is
 * comfortably past 16 MiB. The whole drain is one synchronous block and the first
 * `send` callback has not run, so at the moment of the collapse nothing has
 * drained and the client has not been given a single frame to be slow about. It
 * was told `slow_consumer` anyway, which the browser records as a permanent
 * "events lost" marker over a conversation the daemon still holds intact.
 *
 * The fixture is therefore deliberately *under* the count cap and over the byte
 * one: four hundred events at 48 KiB is a fifth of `ATTACH_REPLAY_MAX` and about
 * 19 MiB, so the frame this produces can only have come from the byte ceiling.
 *
 * What is **not** driven here is the other half of the same fix — that a backlog
 * collapse is not recorded in the window that closes the socket `4003`. One
 * attach can collapse only once (the cursor jumps to the head, so the drain loop
 * reads an empty slice and stops), and a second collapse on the same connection
 * needs a live client that genuinely stops reading, which is real TCP
 * backpressure and the one thing this driver cannot manufacture.
 */
process.stdout.write("\nan attach too large to replay down a socket\n");
{
  const fatRegistry = new SessionRegistry(
    new MemoryEventStore(),
    storeOf([rowFor("s_fatreplay", join(users, "u_alice", "fatreplay"))]),
  );
  fatRegistry.restore({ reapOrphans: false });
  const { app: fatApp, injectWebSocket: injectFat } = createApp({
    registry: fatRegistry,
    verifier,
    instanceId: "i_fat",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const fatServer = serve({ fetch: fatApp.fetch, hostname: "127.0.0.1", port: 0 });
  injectFat(fatServer as unknown as Server);
  await new Promise<void>((resolve) => fatServer.once("listening", resolve));
  const fatPort = (fatServer.address() as AddressInfo).port;

  const managed = fatRegistry.get("s_fatreplay");
  const fat = "b".repeat(48 * 1024);
  for (let n = 1; n <= 400; n += 1) {
    managed?.log.append({ type: "text", role: "agent", thought: false, text: fat });
  }
  const stats = managed?.log.stats() ?? { firstSeq: 0, lastSeq: 0, count: 0, dropped: 0, approxBytes: 0 };
  // The precondition, said as a measurement rather than as a restatement of the
  // constants: the replay is well inside the count cap and well past the byte
  // one, so a collapse here cannot be the count cap firing.
  check("the fixture is far under the replay cap", stats.lastSeq < 2_000, true);
  check("and far over the outbound byte ceiling", stats.approxBytes > 16 * 1024 * 1024, true);

  const frames = await streamFrames(fatPort, "s_fatreplay", "u_alice", 0);
  const lagged = frames.filter((f) => f["type"] === "lagged");
  const caughtUp = frames.find((f) => f["type"] === "caught_up");

  // Asked from 0 with nothing evicted and nothing skipped, so `attach` itself
  // emits no `lagged` at all — which is what makes the single frame below
  // unambiguously the collapse's own.
  check("exactly one lagged frame, and it is the collapse's", lagged.length, 1);
  /*
   * **The one that catches the revert.** With the reason hardcoded, this reads
   * `slow_consumer` — a client that has not yet received a frame being blamed for
   * not reading it, and a hole drawn over events that are all still on disk.
   */
  check("a replay too large in bytes is a backlog, not a slow consumer", lagged[0]?.["reason"], "backlog");
  // And it names the range, ending at the head, because `backlog` is an
  // instruction to page `GET /sessions/:id/events` rather than a report of loss.
  check("naming a range that ends at the head of the log", lagged[0]?.["to"], stats.lastSeq);
  check("and the socket still goes live there rather than being closed", caughtUp?.["seq"], stats.lastSeq);

  await new Promise<void>((resolve) => fatServer.close(() => resolve()));
}

/* ------------------------------------------------------------------ *
 * GET /sessions/:id/events — the page a lagged client is pointed at
 * ------------------------------------------------------------------ */

/*
 * The route the `backlog` frame above names, driven as more than a 404.
 *
 * It was in the unknown-id table and nowhere else, which was defensible while a
 * client only ever read history over the socket. It is not any more: the attach
 * is bounded and everything past the bound is *this* route's problem, so the
 * browser's whole paging loop rests on three properties of a page that nothing
 * asserted — where it starts, that it may be shorter than asked for, and which
 * end it is short at.
 *
 * The third is the one that shipped a defect. A page is filled by scanning
 * ascending from `since` and breaking on the byte budget, in **both** stores, so
 * a byte-capped page keeps its oldest events and drops its newest — a client
 * that anchors its window on the page's first event and assumes it received the
 * whole range it asked for splices the page's *last* event onto a window that
 * begins hundreds of seqs later, and loses everything in between with nothing
 * anywhere to say so. That direction is decided here, so it is pinned here.
 */
process.stdout.write("\nthe events page\n");
{
  /** The route's response shape, so the assertions below are not written against `any`. */
  interface EventPage {
    events: { seq: number; ts: number; event: unknown }[];
    firstSeq: number;
    lastSeq: number;
    dropped: number;
    gap: boolean;
  }

  const pagePath = join(sandbox, "paging", "reemoat.db");
  /*
   * Two opens, because `seedFloors` runs at open from `sessions.list()` — the
   * floors on a session whose events are *entirely* gone can only be picked up
   * by a daemon that finds the row already there, which is the same two-phase
   * shape the store's own floors case uses.
   */
  {
    const seed = openStores({ path: pagePath, instanceId: "i_page_seed" });
    seed.sessions.put(rowFor("s_page", join(users, "u_alice", "paging")));
    seed.sessions.put(rowFor("s_fat", join(users, "u_alice", "paging-fat")));
    // The case the route's own comment calls the one a paging client must not be
    // told history begins at 1: the table knows nothing about this session and
    // the row says the log reached 500.
    seed.sessions.put({
      ...rowFor("s_gone", join(users, "u_alice", "paging-gone")),
      lastSeq: 500,
      dropped: 500,
    });
    seed.close();
  }

  /*
   * **Both bounds have to be exercisable in one store, and that is what sets these
   * two numbers.** Eviction needs a log longer than `maxEventsPerSession`; the
   * route's count clamp needs more than `EVENTS_PAGE_LIMIT` events *above the
   * cursor the clamp is asked from*. When the page was 500 this was a cap of 5000
   * and 6000 events, and raising the page to 5000 left the second property
   * unprovable — the whole live log was smaller than one page, so the route
   * returning all of it proved nothing about honouring `limit`. Scaled off the
   * constant rather than re-typed, so the next move does not need this comment.
   */
  const pageCap = EVENTS_PAGE_LIMIT * 4;
  const store = openStores({ path: pagePath, instanceId: "i_page", maxEventsPerSession: pageCap });
  // Small enough that a page of them is nowhere near the byte budget, so the count
  // clamp is what bounds a page here and the byte cap is measured separately, on
  // `s_fat`.
  for (let n = 1; n <= pageCap + 1_000; n += 1) {
    store.events.append("s_page", { type: "text", role: "agent", thought: false, text: `p${n}` });
  }
  /*
   * And large enough that five hundred cannot fit: a `text` event is accounted
   * at `64 + text.length`, so 8 KiB apiece puts 500 of them at ~4 MiB against
   * the route's 2 MiB budget. Six hundred exist so the page is short of both the
   * count clamp and the end of the log — a page that stopped because it ran out
   * of events would prove nothing about the budget.
   */
  const fat = "f".repeat(8 * 1024);
  for (let n = 1; n <= 600; n += 1) {
    store.events.append("s_fat", { type: "text", role: "agent", thought: false, text: fat });
  }

  const pageRegistry = new SessionRegistry(store.events, store.sessions);
  pageRegistry.restore({ reapOrphans: false });
  const { app: pageApp } = createApp({
    registry: pageRegistry,
    verifier,
    instanceId: "i_page",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const pageOf = async (id: string, query: string): Promise<EventPage> => {
    const response = await pageApp.fetch(
      new Request(`http://d/sessions/${id}/events${query}`, {
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
      }),
    );
    return (await response.json()) as EventPage;
  };

  /*
   * `since` is a cursor and cursors here are exclusive — the same rule
   * `StreamConnection.attach` gets from `WHERE seq > ?`. A client pages by
   * handing back the seq it already holds, so an inclusive read would repeat one
   * event at every page boundary, forever, in a transcript nobody can tell it
   * from a repeated agent message.
   */
  const window = await pageOf("s_page", "?since=2000&limit=5");
  check("`since` is exclusive, so a client's own cursor is never repeated", window.events.map((stored) => stored.seq), [
    2001, 2002, 2003, 2004, 2005,
  ]);

  const clamped = await pageOf("s_page", "?since=2000&limit=1000000");
  // Asking for more than a page holds is answered with a page, not with the
  // whole log. This is the bound the socket's `backlog` reason hands the client
  // over to, so a route that honoured `limit` would move the unbounded read one
  // layer down rather than removing it. Against the constant, because a literal
  // here is a literal that goes stale the next time the page moves — which is
  // exactly what happened.
  check("a page is clamped to what one request may carry", clamped.events.length, EVENTS_PAGE_LIMIT);
  check(
    "and runs from the cursor to the clamp, ascending with no hole",
    clamped.events.every((stored, i) => stored.seq === 2001 + i),
    true,
  );

  /*
   * The byte cap, and then the direction of it.
   *
   * Short is the easy half — `limit` was 500 by default and fewer came back.
   * Which end it is short at is the half a "fewer events arrived" assertion
   * passes without, and it is the whole reason a client may not treat a page as
   * the range it asked for: the page begins at `since + 1` and stops early, so
   * what is missing is at the *new* end and the next request carries on from the
   * last seq received rather than from `since + limit`.
   */
  const capped = await pageOf("s_fat", "?since=0");
  check("a page of large events is cut short by bytes rather than by count", capped.events.length < 500, true);
  /*
   * **This one proves nothing on its own, and that is recorded rather than
   * hidden.** Both stores guard the byte break with `out.length > 0 &&` so a
   * single oversized record cannot wedge a reader that can never get past it.
   * Deleting that guard from either store — or from both at once — leaves this
   * whole suite green, because the branch is unreachable with this fixture and,
   * more to the point, unreachable in production: `truncateEvent` caps one event
   * at 128 KiB, sixteen times below `EVENTS_PAGE_BYTES`, so no event can be
   * larger than the page budget while both defaults stand.
   *
   * Kept because it is the assertion that would start meaning something the day
   * somebody raises the per-event cap or lowers the page budget, and because
   * `capped.events.length >= 1` is a precondition of the sibling below actually
   * reading `events[0]`. Not kept as evidence that the wedge guard works.
   */
  check("but never to nothing, since one oversized event must not wedge a reader", capped.events.length >= 1, true);
  check("what it keeps is the OLDEST requested seq", capped.events[0]?.seq, 1);
  check(
    "so it is short at the new end, and the next page carries on from the last seq received",
    capped.events.at(-1)?.seq,
    capped.events.length,
  );
  check(
    "the newest seq asked for is precisely the one that did not fit",
    capped.events.some((stored) => stored.seq === 500),
    false,
  );

  /*
   * `firstSeq` is `oldestAvailable(stats)` and not the raw column, in both of
   * the states where the two differ.
   *
   * A client reads this to decide whether there is anything left to page — the
   * browser draws "the start of this conversation is gone" from it — so a route
   * that reported the raw value would send it asking for history that cannot be
   * served, once per page, forever.
   */
  const evicted = await pageOf("s_page", "?since=0&limit=1");
  check("a log whose prefix is gone does not claim to begin at 1", evicted.firstSeq, evicted.dropped + 1);
  check("and a cursor below that floor is named as a gap", evicted.gap, true);
  // The boundary either side of it, because `since < oldestAvailable - 1` is the
  // one predicate that decides whether a client believes it lost anything.
  check(
    "a cursor exactly at the floor is not a gap",
    (await pageOf("s_page", `?since=${evicted.dropped}&limit=1`)).gap,
    false,
  );
  check(
    "and one seq below it is",
    (await pageOf("s_page", `?since=${evicted.dropped - 1}&limit=1`)).gap,
    true,
  );

  /*
   * And the case the raw column answers with **zero**: the log is empty and the
   * sequence is not. `firstSeq` is 0 there, so `firstSeq - 1` is -1 and every
   * gap predicate written against it silently answers "no gap" — on the one path
   * where absolutely everything was lost.
   */
  const gone = await pageOf("s_gone", "?since=0");
  check("a session whose events are all gone serves none", gone.events, []);
  check("while its sequence is intact", gone.lastSeq, 500);
  check("and history begins one past the end rather than at 1 or at 0", gone.firstSeq, gone.lastSeq + 1);
  check("with a cursor of 0 named as the gap it is", gone.gap, true);

  process.stdout.write("\nwhat crosses the wire, and what must not be touched\n");
  {
    /*
     * ⭐ **Nothing in this system compressed anything, and the scarce resource on
     * this path is the uplink of the machine an agent runs on.**
     *
     * Measured against the fleet's largest conversation: a page of 5000 events is
     * **1.23 MB** raw and **98 KB** gzipped, and every byte of it crosses that
     * uplink once to the relay and again to the browser. The relay cannot help —
     * it carries h2 frames, which are already framed — so the daemon is where it
     * has to happen.
     *
     * The second assertion is the load-bearing one and the reason `compressible`
     * keys on the **content type** rather than the path: `GET /sessions/:id/files`
     * streams arbitrary bytes and the client refuses an oversized file by reading
     * `content-length` *before* the body is resident. Compressed, that number
     * describes the packed size, so a 100 MiB guard measures the wrong thing.
     */
    const raw = async (path: string, headers: Record<string, string> = {}): Promise<Response> =>
      pageApp.fetch(
        new Request(`http://d${path}`, {
          headers: { authorization: `Bearer ${tokenFor("u_alice")}`, ...headers },
        }),
      );

    const query = "/sessions/s_page/events?since=0&limit=5000";
    const packed = await raw(query, { "accept-encoding": "gzip" });
    const packedBody = Buffer.from(await packed.arrayBuffer());
    check("a page a client will take gzipped is gzipped", packed.headers.get("content-encoding"), "gzip");
    check("and says so in its length", packed.headers.get("content-length"), String(packedBody.byteLength));
    check("and tells a cache what it varied on", (packed.headers.get("vary") ?? "").includes("accept-encoding"), true);

    const plain = await raw(query);
    const plainPage = (await plain.json()) as EventPage;
    check("a client that did not ask for it gets none", plain.headers.get("content-encoding"), null);

    /*
     * ⭐ **A compressible response *under* the threshold must still be readable,
     * and this is the assertion whose absence let a 500 reach production.**
     *
     * Deciding the size means reading the body, and reading it consumes it — so an
     * early `return` past that point leaves `c.res` holding a body already read, and
     * `@hono/node-server` answers `ERR_INVALID_STATE: ReadableStream is locked`. It
     * is a 500 with no body on **every** small JSON answer, `GET /sessions`
     * included. The compressed path was asserted and this one was not, which is
     * exactly the half that broke.
     */
    const small = await raw("/sessions/s_page/events?since=0&limit=2", { "accept-encoding": "gzip" });
    check("a small answer is not compressed", small.headers.get("content-encoding"), null);
    // Read through a catch, so a body left consumed is a *sentence* rather than a
    // throw that ends the driver before everything after it has run.
    const smallText = await small.text().then(
      (text) => text,
      (error: unknown) => `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    check("and it still has its body", smallText.slice(0, 11), '{"events":[');
    // Guarded, so an unreadable body is one FAIL rather than a throw that ends the
    // driver with everything after it unrun.
    const smallEvents = smallText.startsWith('{"events":[') ? (JSON.parse(smallText) as EventPage).events.length : -1;
    check("carrying what was asked for", smallEvents, 2);
    check("with the status it had", small.status, 200);
    const unpacked = JSON.parse(gunzipSync(packedBody).toString("utf8")) as EventPage;
    check(
      "and the two carry the same events, which is the only thing that matters",
      [unpacked.events.length, unpacked.events.at(-1)?.seq, unpacked.firstSeq],
      [plainPage.events.length, plainPage.events.at(-1)?.seq, plainPage.firstSeq],
    );
    // The uncompressed size is measured off the body rather than off a header:
    // `c.json` does not set `content-length`, which is itself why the middleware
    // has to *write* one when it packs a body.
    const plainBytes = Buffer.byteLength(JSON.stringify(plainPage));
    report(
      "measured on this fixture",
      packedBody.byteLength * 4 < plainBytes,
      `${(packedBody.byteLength / 1024).toFixed(0)} KiB gzipped from ${(plainBytes / 1024).toFixed(0)} KiB`,
    );

    store.close();
  }
}

/* ------------------------------------------------------------------ *
 * Subagent lineage — the one projection out of an agent-shaped blob
 * ------------------------------------------------------------------ */

process.stdout.write("\nsubagent lineage\n");
{
  const call = (meta: unknown, id = "toolu_child"): unknown =>
    toolCallLineage({ toolCallId: id, _meta: meta });

  check(
    "claude's spawn is a subagent with no parent of its own",
    call({ claudeCode: { toolName: "Agent", subagent: true } }),
    { parentToolCallId: null, subagent: true },
  );
  check(
    "and a call inside it carries the parent's id, byte for byte",
    call({ claudeCode: { toolName: "Read", parentToolUseId: "toolu_parent" } }),
    { parentToolCallId: "toolu_parent", subagent: false },
  );

  // Kimi sends no `_meta` on anything, ever, and filters its subagents' events
  // at the source. It gets `false` by absence rather than by us pattern-matching
  // its `Agent` tool, which would be a container that can never have contents.
  check("kimi sends no metadata, and that is the answer", call(undefined), {
    parentToolCallId: null,
    subagent: false,
  });
  check("a `_meta` without claude's key says nothing", call({ somethingElse: {} }), {
    parentToolCallId: null,
    subagent: false,
  });

  // Never coerced. `String(42)` as a tree edge names a call that will never
  // exist, and a reader cannot tell that from a parent that was merely evicted.
  for (const [label, value] of [
    ["a number", 42],
    ["an object", {}],
    ["the empty string", ""],
    ["null", null],
  ] as const) {
    check(
      `a parent id that is ${label} is no parent`,
      call({ claudeCode: { parentToolUseId: value } }),
      { parentToolCallId: null, subagent: false },
    );
  }

  // The `alg === "EdDSA"` discipline: an exact comparison makes a family of
  // near-misses impossible rather than defended one at a time.
  check(
    'the string "true" is not the boolean true',
    call({ claudeCode: { subagent: "true" } }),
    { parentToolCallId: null, subagent: false },
  );

  check(
    "a call cannot run inside itself",
    call({ claudeCode: { parentToolUseId: "toolu_self" } }, "toolu_self"),
    { parentToolCallId: null, subagent: false },
  );

  // Bounded at ingest, because there is nowhere later to bound it: `truncateEvent`
  // deliberately spreads `parentToolCallId` through untouched on both arms, so an
  // unshrinkable field with no ceiling walks an event straight past the per-event
  // cap that the bounds table calls enforced. A real ACP id is under 40
  // characters; anything over 256 was never an edge.
  check(
    "an id too long to be one is no parent",
    call({ claudeCode: { parentToolUseId: "t".repeat(257) } }),
    { parentToolCallId: null, subagent: false },
  );
  check(
    "and one exactly at the ceiling still is",
    (call({ claudeCode: { parentToolUseId: "t".repeat(256) } }) as { parentToolCallId: string | null })
      .parentToolCallId?.length,
    256,
  );

  // The assertion that fails if somebody later "simplifies" this into a
  // passthrough. `_meta` is an unbounded agent-shaped blob; two scalars is the
  // whole of what may cross.
  const huge = { claudeCode: { parentToolUseId: "toolu_parent", junk: "x".repeat(200_000) } };
  check(
    "a 200 KB blob beside the id contributes nothing but the id",
    JSON.stringify(call(huge)).length,
    JSON.stringify({ parentToolCallId: "toolu_parent", subagent: false }).length,
  );

  // So the per-event cap stays honest rather than becoming decorative.
  const base: ToolCallEvent = {
    type: "tool_call",
    toolCallId: "toolu_child",
    title: "Read",
    kind: "read",
    status: "pending",
    locations: [],
    rawInput: null,
    parentToolCallId: null,
    subagent: false,
  };
  check(
    "an accounted parent id costs exactly its own length",
    estimateBytes({ ...base, parentToolCallId: "toolu_parent" }) - estimateBytes(base),
    "toolu_parent".length,
  );

  /*
   * ⚠ **`locations` was charged nothing and cut by nothing**, on both tool-call
   * arms, while being an array of agent-chosen paths bounded by neither length
   * nor element size. That defeats three bounds at once and all three read this
   * number rather than the payload: the 128 KiB per-event cap, the per-session
   * byte budget (`schema.sql` stores what `estimateBytes` returns), and the WS
   * outbound queue's `MAX_QUEUE_BYTES`.
   *
   * Asserted as a *proportionality*, not as a constant: what made the defect
   * possible was a term being absent, so what has to be true is that the number
   * moves with the payload at all.
   */
  const sited: ToolCallEvent = {
    ...base,
    locations: Array.from({ length: 40 }, (_, i) => ({ path: `${"/deep/path".repeat(80)}/${i}`, line: null })),
  };
  report(
    "and a file list is charged rather than carried for free",
    estimateBytes(sited) - estimateBytes(base) > 20_000,
    `${estimateBytes(sited) - estimateBytes(base)} bytes for 40 long locations`,
  );
  // And shrinks, which the spread used to carry through untouched — so an event
  // over the cap stayed over it however often this ran.
  const cutSited = truncateEvent(sited, 4_096) as ToolCallEvent;
  report(
    "and truncating really shortens it",
    estimateBytes(cutSited) < estimateBytes(sited),
    `${estimateBytes(sited)} -> ${estimateBytes(cutSited)} bytes`,
  );
}


/* ------------------------------------------------------------------ *
 * git no longer fences, and that has to fail loudly if it comes back
 * ------------------------------------------------------------------ */

/*
 * The direct successor to `dockercheck`'s "the container runner deliberately
 * does not neutralise hooks", pointed the other way because the reason inverted.
 *
 * `GIT_NO_EXEC_CONFIG` and `GIT_CONFIG_GLOBAL=/dev/null` were confinement against
 * a repository on the other side of a trust boundary. There is no such boundary
 * now, and leaving them in place had a measured, silent cost: a blanked global
 * config disables `filter.lfs.smudge`, so `worktree add` checks out LFS pointer
 * files and the agent reads a spec URL where a binary should be.
 *
 * So this asserts an **absence**, exactly as the old rule did: somebody restoring
 * "just the hooks one, for safety" breaks a user's own repository with no error
 * anywhere, and should fail here instead.
 */
process.stdout.write("\ngit runs with the user's own configuration\n");
{
  const argv = gitArgs("/repo", ["worktree", "add", "--", "/repo/wt", "abc123"]);
  check("the directory is named with -C and nothing precedes it", argv[0], "-C");
  check("no -c override is prepended", argv.includes("-c"), false);
  check("and the caller's own arguments are untouched", argv.slice(2), [
    "worktree",
    "add",
    "--",
    "/repo/wt",
    "abc123",
  ]);

  const env = gitEnv();
  // The two that mattered, by name. Restoring either one silently changes what a
  // checkout produces: hooks stop running, and LFS content becomes pointer files.
  check("the user's global config is not blanked", env["GIT_CONFIG_GLOBAL"], undefined);
  check("nor is the system config suppressed", env["GIT_CONFIG_NOSYSTEM"], undefined);

  // Still an allowlist, and still for a reason — being launched from inside a
  // hook or a `rebase --exec` must not retarget us at somebody else's repository.
  check(
    "no GIT_* name that retargets a command is passed through",
    ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"].filter(
      (name) => env[name] !== undefined,
    ),
    [],
  );
  // What the user's own git legitimately needs, and what nothing may block on.
  check("HOME survives, so ~/.gitconfig is read", env["HOME"], process.env["HOME"]);
  check("and nothing may wait for a passphrase", env["GIT_TERMINAL_PROMPT"], "0");
}

/* ================================================================== *
 * Moved here from `scripts/dockercheck.ts` when the container runtime
 * was deleted. None of it was ever about Docker: it drives `sanitize`,
 * `readFrom`, a real `AcpClient` and a real `Session` over in-memory
 * pipes. Deleting that file without moving these would have removed the
 * only place any of them is asserted against itself rather than against
 * a copy of its own arithmetic.
 * ================================================================== */

/**
 * The launch config a stub runtime hands back instead of resolving a real agent.
 *
 * `LocalRuntime.describe` calls `resolveAgent`, which resolves the executable on
 * PATH eagerly and throws `AgentUnavailableError` when it is not there. Both stub
 * runtimes below already override `launch` to answer with in-memory pipes, so that
 * binary is never spawned — resolving it asserted nothing except that whoever ran
 * this driver happened to have `kimi` installed.
 *
 * Measured: `pnpm dockercheck` was green on a developer machine and failed on the
 * first CI run with `kimi not found on PATH`, from `Session.start` at the top of
 * "what the agent says, and what survives". That is exactly the property this
 * file's header disclaims — every driver here is meant to run "offline in one
 * process with no fleet, no agent and no deploy" — and the claim was true of the
 * Docker half and quietly false of this one.
 *
 * Nothing downstream reads these fields: `AcpClient.launch` touches `command` only
 * inside a spawn-failure message and `displayName` only inside handshake errors,
 * neither of which is reachable once `launch` is overridden.
 */
function stubAgentConfig(agent: AgentId): AgentLaunchConfig {
  return {
    id: agent,
    displayName: agent,
    // Deliberately not a path that could exist: if a change ever makes a stub
    // runtime spawn after all, the failure should name this line.
    command: `/nonexistent/dockercheck/${agent}`,
    args: [],
    env: {},
    authHint: "",
  };
}

process.stdout.write("\npty output sanitising\n");
{
  // What `script` hands back is a terminal recording, and a `<pre>` is not a
  // terminal. Stripping is the readable failure; the alternative is a pane full
  // of `\x1b[2K`.
  const plain = sanitize("\x1b[2K\x1b[1Gopen https://claude.ai/oauth\n");
  check("escape sequences are stripped", plain.text, "open https://claude.ai/oauth\n");
  check("and nothing is held back when the chunk ends cleanly", plain.carry, "");

  // A sequence split across a chunk boundary printed as literal text exactly
  // once per boundary, which is both ugly and unreproducible.
  const split = sanitize("code: \x1b[3");
  check("a partial escape is carried rather than printed", split.text, "code: ");
  check("as the carry", split.carry, "\x1b[3");
  check("and completes on the next chunk", sanitize(`${split.carry}1mABCD`).text, "ABCD");

  // `\r` means redraw. Honouring it properly needs a terminal emulator; dropping
  // it concatenates every spinner frame into one line.
  check("a lone carriage return becomes a newline", sanitize("a\rb").text, "a\nb");
  check("and CRLF stays one newline", sanitize("a\r\nb").text, "a\nb");
}

process.stdout.write("\nwhere a login client's cursor lands\n");
{
  /*
   * `readFrom` itself, not a model of it.
   *
   * `webcheck` has a section on this that defines its own copy of the arithmetic
   * and asserts against that — useful for the *client's* rule (assign the cursor,
   * never advance by `chunk.length`) and worthless as a guard on the daemon,
   * because it would stay green with this function deleted. `packages/web` cannot
   * import from `src/` — the two halves resolve modules differently, which is the
   * same reason `wire.ts` is hand-mirrored — so the daemon half is asserted here.
   *
   * A login transcript is where a lost line is the one with the code in it, which
   * is why the gap flag matters as much as the slice.
   */
  check("a fresh read returns the whole buffer", readFrom("open https://x", 0, 0).chunk, "open https://x");
  check("and reports no gap", readFrom("open https://x", 0, 0).gap, false);
  check("a read from the end returns nothing new", readFrom("open https://x", 0, 14).chunk, "");
  // Once the 64 KiB cap has trimmed the front, an old cursor is behind the window.
  check("a cursor behind the discarded prefix is a gap", readFrom("tail", 100, 40).gap, true);
  check("and is served the oldest output that survives", readFrom("tail", 100, 40).chunk, "tail");
  check("a cursor inside the window is not a gap", readFrom("tail", 100, 102).gap, false);
  check("and reads only what follows it", readFrom("tail", 100, 102).chunk, "il");
}

/* ------------------------------------------------------------------ *
 * The fs capability, enforced rather than announced
 * ------------------------------------------------------------------ */

/**
 * The one property that makes the sandbox a sandbox.
 *
 * `session.ts` implements ACP's `fs/read_text_file` and `fs/write_text_file` by
 * calling `readFile`/`writeFile` **in the daemon's own process**, so a container
 * around the agent does not contain them. `SessionRuntime.clientFileIo` is how a
 * sandboxing runtime declines them — but declining is a *statement to a party we
 * do not trust*, and until it was enforced the handlers were registered
 * unconditionally and ran the request anyway. An agent that ignored the
 * advertised capability, or anything else in the tenant's container able to
 * write to the agent's stdout, had a write primitive running outside the sandbox.
 *
 * So this drives a real `AcpClient` over in-memory pipes with a fake agent on
 * the other end, completes the handshake, and then sends the request the agent
 * was told not to send. No Docker, no image, no network.
 */
process.stdout.write("\nthe fs capability, enforced rather than announced\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const { AcpClient } = await import("../src/acp/client.js");
  const { PassThrough } = await import("node:stream");

  /** An `AgentProcess` that is two pipes and nothing else. */
  const fakeAgent = () => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    return {
      process: {
        stdin: toAgent,
        stdout: toClient,
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        hasExited: false,
        waitForExit: async () => true,
        endStdin: () => toAgent.end(),
        kill: async () => {},
      },
      toAgent,
      toClient,
    };
  };

  const capabilityFor = async (options: {
    fileIo: boolean;
    elicitation: boolean;
  }): Promise<{
    advertised: unknown;
    refused: boolean;
    elicitationRefused: boolean;
    caps: Record<string, unknown>;
    codeFor: (id: number) => number | undefined;
  }> => {
    const agent = fakeAgent();
    let advertised: unknown = null;
    let caps: Record<string, unknown> = {};
    let refused = false;
    let elicitationRefused = false;

    // The agent side: answer `initialize`, then send the forbidden request.
    let buffer = "";
    const replies: string[] = [];
    agent.toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        if (message["method"] === acp.methods.agent.initialize) {
          advertised = message["params"]?.clientCapabilities?.fs;
          caps = (message["params"]?.clientCapabilities ?? {}) as Record<string, unknown>;
          agent.toClient.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message["id"],
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            })}\n`,
          );
          continue;
        }
        // The client's answers to every probe we send below.
        if (typeof message["id"] === "number" && message["id"] >= 9001) replies.push(line);
      }
    });

    const client = await AcpClient.launch(
      { id: "kimi", displayName: "fake", command: "fake", args: [], env: {}, authHint: "" },
      agent.process as never,
      options,
    );

    // Both sent regardless of what was advertised — which is the entire point.
    agent.toClient.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 9001,
        method: acp.methods.client.fs.writeTextFile,
        params: { sessionId: "s_nope", path: "/etc/reemoat-probe", content: "x" },
      })}\n`,
    );
    // 9002 is the answerable shape; 9003-9005 are the three this client refuses
    // even when the capability is granted.
    const probes: Record<number, Record<string, unknown>> = {
      9002: {
        mode: "form",
        sessionId: "s_nope",
        message: "who are you",
        requestedSchema: { type: "object", properties: {} },
      },
      9003: { mode: "url", sessionId: "s_nope", message: "sign in", elicitationId: "e1", url: "https://x/" },
      9004: { mode: "_vendorThing", sessionId: "s_nope", message: "?" },
      9005: {
        mode: "form",
        requestId: "r1",
        message: "before any session",
        requestedSchema: { type: "object", properties: {} },
      },
    };
    for (const [id, params] of Object.entries(probes)) {
      agent.toClient.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: Number(id),
          method: acp.methods.client.elicitation.create,
          params,
        })}\n`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const answerTo = (id: number): Record<string, any> | null => {
      for (const line of replies) {
        const parsed = JSON.parse(line) as Record<string, any>;
        if (parsed["id"] === id) return parsed;
      }
      return null;
    };
    // -32601 is JSON-RPC's "method not found": indistinguishable from a client
    // that never implemented it, which is exactly the intent.
    refused = answerTo(9001)?.["error"]?.code === -32601;
    elicitationRefused = answerTo(9002)?.["error"]?.code === -32601;
    const codeFor = (id: number): number | undefined => answerTo(id)?.["error"]?.code;
    await client.close().catch(() => {});
    return { advertised, refused, elicitationRefused, caps, codeFor };
  };

  const declined = await capabilityFor({ fileIo: false, elicitation: false });
  check("a declining runtime advertises no fs capability", declined.advertised, {
    readTextFile: false,
    writeTextFile: false,
  });
  check("and refuses an fs write the agent sends anyway", declined.refused, true);

  const allowed = await capabilityFor({ fileIo: true, elicitation: true });
  check("a local runtime still advertises it", allowed.advertised, {
    readTextFile: true,
    writeTextFile: true,
  });
  // Routed, so it reaches `session.ts` — this one has no session registered, so
  // the refusal is `invalid_params` rather than `method_not_found`. What matters
  // is that it is NOT the same refusal as above.
  check("and does not refuse it as unimplemented", allowed.refused, false);

  /*
   * The elicitation capability, enforced the same way and for a sharper reason.
   *
   * Declaring `elicitation.form` is the one thing in this handshake that changes
   * what the *model* does rather than what the client renders: measured against
   * claude-agent-acp 0.63.0, `disallowedTools = elicitationSupport.form ? [] :
   * ["AskUserQuestion"]`, so leaving it out strips claude's own ask-the-user tool
   * before the CLI starts. That makes the gate worth having twice over — an
   * operator can withdraw a tool, and an agent that ignores the answer gets the
   * same `-32601` a client that never implemented it would send.
   *
   * The declined case is asserted as an **absence**, like the `_meta` pair below,
   * because ACP has no `form: false`: `ElicitationCapabilities.form` is an
   * empty-object marker, so omitting the key is the only way to say no and
   * `{form: false}` would typecheck against the open `_meta` while meaning
   * nothing.
   */
  check("a declining daemon advertises no elicitation capability at all", declined.caps["elicitation"], undefined);
  check("and refuses a question the agent asks anyway", declined.elicitationRefused, true);
  check("granting it advertises form mode", allowed.caps["elicitation"], { form: {} });
  check(
    "and never url mode, which would be a second settle path no human drives",
    "url" in ((allowed.caps["elicitation"] ?? {}) as Record<string, unknown>),
    false,
  );
  check("and the question is not refused as unimplemented", allowed.elicitationRefused, false);

  /*
   * The three shapes that are refused even though the capability was granted.
   *
   * `-32602` is `invalid_params` and deliberately not `-32601`: the method *is*
   * implemented, and answering "method not found" would tell the agent the whole
   * capability is absent — a statement the next form request immediately
   * contradicts.
   *
   * They are also errors rather than `{action: "decline"}`, which would be a lie:
   * nobody declined. Measured against claude's adapter, the error is the kindest
   * of the three anyway — it becomes `{behavior: "deny", message: "Could not
   * present the question to the user."}` and the model carries on knowing why,
   * where a decline tells it a person chose to skip.
   */
  check("url mode is refused even when the capability is granted", allowed.codeFor(9003), -32602);
  check("so is a mode this client has never heard of", allowed.codeFor(9004), -32602);
  check("and so is a question scoped to a request rather than a session", allowed.codeFor(9005), -32602);

  /*
   * The subagent transcript, refused by not asking for it.
   *
   * `claude-agent-acp` gates a subagent's own text and thinking on
   * `clientCapabilities._meta["subagent-transcript"] === true`; without it the
   * SDK is passed `forwardSubagentText: false` and never emits them at all. So
   * this daemon sees what a subagent *did* and what it *concluded*, and not what
   * it said.
   *
   * That is a budget decision, not a trust one — saying so plainly, because
   * reaching for the `fs` argument here would be dishonest: this grants the
   * agent permission to talk more, not a write primitive in our process. The log
   * is 5000 events / 8 MiB and eviction removes a *prefix*, so a second full
   * conversation per delegate, three to five at a time, does not degrade into
   * "less detail" — it evicts the operator's own prompt and the main agent's
   * reply to make room for a delegate's monologue.
   *
   * Asserted as an *absence*, so switching it on has to be deliberate and fails
   * loudly here rather than quietly doubling what a delegate costs.
   */
  check("no capability metadata is advertised at all", allowed.caps["_meta"], undefined);
  check(
    "so a subagent's transcript is never forwarded",
    (allowed.caps["_meta"] as Record<string, unknown> | undefined)?.["subagent-transcript"],
    undefined,
  );
}

/* ------------------------------------------------------------------ *
 * What a form is allowed to be
 * ------------------------------------------------------------------ */

/**
 * The projection, driven as a pure function.
 *
 * `toElicitationForm` is where an agent-chosen JSON Schema becomes the fixed
 * shape this system carries, and it is the only place the two rules that make
 * that safe are written: **structure is refused and prose is clipped**. Both
 * halves need driving, because each is silently wrong in a different direction —
 * a cap that clipped structure would deliver a form whose answer means something
 * else, and one that refused prose would refuse real forms over a long sentence.
 */
process.stdout.write("\nwhat a form is allowed to be\n");
{
  const { toElicitationForm, ElicitationRefusedError } = await import("../src/session.js");

  const refusalFrom = (schema: unknown): string | null => {
    try {
      toElicitationForm(schema as never);
      return null;
    } catch (error) {
      return error instanceof ElicitationRefusedError ? error.message : `unexpected: ${String(error)}`;
    }
  };

  // The measured AskUserQuestion shape, N=1: a titled single-select followed by
  // the adapter's own free-text "Other" box.
  const ask = toElicitationForm({
    type: "object",
    properties: {
      question_0: {
        type: "string",
        title: "Framework",
        oneOf: [
          { const: "React", title: "React", description: "Already in package.json" },
          { const: "Svelte", title: "Svelte" },
        ],
      },
      question_0_custom: {
        type: "string",
        title: "Other",
        description: "Type your own answer instead of choosing an option above (optional).",
      },
    },
  } as never);
  check(
    "a claude AskUserQuestion projects to a select and a free-text box",
    ask.fields.map((field) => [field.key, field.kind, field.title, field.required]),
    [
      ["question_0", "string", "Framework", false],
      ["question_0_custom", "string", "Other", false],
    ],
  );
  check(
    "an option keeps its own description, which is what makes rows worth drawing",
    ask.fields[0]?.options,
    [
      { value: "React", label: "React", description: "Already in package.json" },
      { value: "Svelte", label: "Svelte", description: null },
    ],
  );

  /*
   * The same question from the other agent that asks one, N=1, measured
   * 2026-08-07 against codex-acp 1.1.9.
   *
   * It arrives on `elicitation/create` like claude's — the adapters agree on the
   * method and disagree on everything nameable. The keys are the model's
   * (`license_choice`, not `question_0`), the free-text box is suffixed `__other`
   * rather than `_custom`, and each property carries a `_meta.codex` block naming
   * the question it belongs to.
   *
   * **Which is exactly why nothing here reads a field name.** Both projections
   * come out identical in shape — a titled single-select and a free-text box —
   * and a client that had keyed on `_custom`, or on `_meta`, would render one
   * agent's question and refuse the other's. `_meta` is dropped on the floor and
   * the suffix is never parsed; the second field is a field like any other, and
   * codex's own `isOtherAnswer` marker is left where it was sent.
   */
  const codexAsk = toElicitationForm({
    type: "object",
    required: [],
    properties: {
      license_choice: {
        type: "string",
        title: "License",
        description: "Which license should I add to this repository?",
        _meta: { codex: { isOther: true, isSecret: false } },
        oneOf: [
          { const: "MIT (Recommended)", title: "MIT (Recommended)", description: "A short, permissive license." },
          { const: "GPL-3.0", title: "GPL-3.0" },
        ],
      },
      license_choice__other: {
        type: "string",
        title: "Other",
        description: "Type your own answer instead of choosing an option above.",
        _meta: { codex: { questionId: "license_choice", isOtherAnswer: true, isSecret: false } },
      },
    },
  } as never);
  check(
    "a codex question projects to the same select and free-text box",
    codexAsk.fields.map((field) => [field.key, field.kind, field.title, field.required]),
    [
      ["license_choice", "string", "License", false],
      ["license_choice__other", "string", "Other", false],
    ],
  );
  check(
    "its options survive with their prose, and the agent's _meta does not",
    codexAsk.fields[0]?.options,
    [
      { value: "MIT (Recommended)", label: "MIT (Recommended)", description: "A short, permissive license." },
      { value: "GPL-3.0", label: "GPL-3.0", description: null },
    ],
  );

  // `enum` and `oneOf` are one shape by the time anything reads them, so a client
  // has one answer to "what is an option" and the daemon validates the reply
  // against the same list it sent.
  const bare = toElicitationForm({
    type: "object",
    required: ["pick"],
    properties: { pick: { type: "string", enum: ["a", "b"] } },
  } as never);
  check("a bare enum normalizes to the same option shape", bare.fields[0]?.options, [
    { value: "a", label: "a", description: null },
    { value: "b", label: "b", description: null },
  ]);
  check("and `required` is carried per field", bare.fields[0]?.required, true);

  const multi = toElicitationForm({
    type: "object",
    properties: {
      regions: { type: "array", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "eu", title: "Europe" }] } },
    },
  } as never);
  check("a titled multi-select is a multi_select with bounds", [
    multi.fields[0]?.kind,
    multi.fields[0]?.min,
    multi.fields[0]?.max,
    multi.fields[0]?.options,
  ], ["multi_select", 1, 2, [{ value: "eu", label: "Europe", description: null }]]);

  // Never coerced: a non-string wire value is one the agent will not recognise
  // coming back, so it is not an option at all rather than `String(42)`.
  const coerced = toElicitationForm({
    type: "object",
    properties: { n: { type: "string", oneOf: [{ const: 42, title: "forty-two" }, { const: "ok", title: "ok" }] } },
  } as never);
  check("an option whose value is not a string is dropped, never stringified", coerced.fields[0]?.options, [
    { value: "ok", label: "ok", description: null },
  ]);

  check("prose is clipped rather than refused", (() => {
    const long = toElicitationForm({
      type: "object",
      properties: { a: { type: "string", description: "x".repeat(5_000) } },
    } as never);
    const description = long.fields[0]?.description ?? "";
    return description.length < 5_000 && description.startsWith("x");
  })(), true);

  check("an empty form is a form, not an error", toElicitationForm({ type: "object", properties: {} } as never), {
    fields: [],
  });
  check("and so is a schema with nothing in it at all", toElicitationForm(null).fields.length, 0);

  /*
   * Every refusal names its cap in the message, because the agent is the only
   * party that can act on it — `handleAskUserQuestion` turns the error into a
   * `deny` the model reads.
   */
  const wideField: Record<string, unknown> = {};
  for (let i = 0; i < 40; i += 1) wideField[`f${i}`] = { type: "string" };
  check(
    "too many fields refuses the whole form",
    refusalFrom({ type: "object", properties: wideField })?.includes("24"),
    true,
  );
  check(
    "too many choices refuses it too",
    refusalFrom({
      type: "object",
      properties: { a: { type: "string", enum: Array.from({ length: 40 }, (_, i) => `o${i}`) } },
    })?.includes("24"),
    true,
  );
  // Refused rather than clipped, for the reason a command's name is: this string
  // goes back to the agent and has to round-trip exactly.
  check(
    "an option value too long to round-trip refuses it rather than being clipped",
    refusalFrom({
      type: "object",
      properties: { a: { type: "string", enum: ["x".repeat(600)] } },
    })?.includes("512"),
    true,
  );
  check(
    "a property type this client cannot draw refuses it, rather than leaving a hole",
    refusalFrom({ type: "object", properties: { c: { type: "color" } } })?.includes("color"),
    true,
  );
  check(
    "a vendor-reserved type earns no special case",
    refusalFrom({ type: "object", properties: { c: { type: "_claudeThing" } } })?.includes("_claudeThing"),
    true,
  );
  check(
    "a list with no choices is refused rather than drawn as an empty picker",
    refusalFrom({ type: "object", properties: { a: { type: "array", items: { type: "string" } } } })?.includes(
      "no choices",
    ),
    true,
  );

  /*
   * **The string arm's twin, and the two must not disagree about what `[]` is.**
   *
   * A `string` field whose choices all get dropped — `enum: []`, or a `oneOf`
   * whose every `const` is non-string — used to project `options: []`. The array
   * arm refuses that shape; the string arm let it through, and then the two ends
   * read it oppositely: the client draws a free-text box because `[].length > 0`
   * is false, and `validateElicitationContent` refuses every value because
   * `[] !== null` is true. Submit lit up and the route answered `400
   * not_an_option` for anything the person could type.
   */
  check(
    "an empty enum on a string is free text, not a choice of nothing",
    toElicitationForm({ type: "object", properties: { a: { type: "string", enum: [] } } } as never).fields[0]?.options,
    null,
  );
  check(
    "and so is a oneOf whose every const was dropped",
    toElicitationForm({
      type: "object",
      properties: { a: { type: "string", oneOf: [{ const: 42 }, { const: true }] } },
    } as never).fields[0]?.options,
    null,
  );
  /*
   * **The daemon's only check on what reaches an agent, driven directly.**
   *
   * Its docblock says it is module-scope and pure "so `daemoncheck` can drive
   * every rule with no session", and no driver imported it — so it was reached
   * only through the HTTP fixture, whose form is two `string` fields. Every
   * number, boolean and multi-select arm was unreachable by any assertion.
   *
   * The `duplicate` rule is the sharpest of them, because it is deliberately the
   * *inverse* of the client's: `elicitationAnswer` dedupes and `webcheck` pins
   * that it does, while the daemon refuses. Somebody unifying the two would have
   * changed only the half nothing watched.
   */
  {
    const kinds = {
      fields: [
        { key: "n", kind: "integer", title: null, description: null, required: false, options: null, min: 10, max: 20, format: null, default: null },
        { key: "b", kind: "boolean", title: null, description: null, required: false, options: null, min: null, max: null, format: null, default: null },
        { key: "m", kind: "multi_select", title: null, description: null, required: false,
          options: [
            { value: "us", label: "us", description: null },
            { value: "eu", label: "eu", description: null },
          ], min: 2, max: 2, format: null, default: null },
      ],
    } as never;
    const codes = (content: Record<string, unknown>): string[] =>
      validateElicitationContent(kinds, content).map((problem) => problem.code);

    check("an unknown field is refused rather than stripped", codes({ nope: 1 }), ["unknown_field"]);
    check("a string for an integer is not coerced", codes({ n: "15" }), ["wrong_type"]);
    check("nor is a fraction accepted as one", codes({ n: 1.5 }), ["wrong_type"]);
    check("below the minimum", codes({ n: 1 }), ["too_small"]);
    check("above the maximum", codes({ n: 99 }), ["too_large"]);
    check("a string for a boolean is not coerced either", codes({ b: "true" }), ["wrong_type"]);
    check("false is a value, not an absence", codes({ b: false }), []);
    check("too few choices", codes({ m: ["us"] }), ["too_few"]);
    check("a choice the form never offered", codes({ m: ["us", "nz"] }), ["not_an_option"]);
    // The inverse of the client's rule, and the reason this block exists.
    check("a repeated choice is refused here, where the client collapses it", codes({ m: ["us", "us"] }), ["duplicate"]);
    check("and a well-formed answer to every kind is accepted", codes({ n: 15, b: true, m: ["us", "eu"] }), []);
  }

  check(
    "a surviving choice is still a choice",
    toElicitationForm({
      type: "object",
      properties: { a: { type: "string", oneOf: [{ const: 42 }, { const: "ok" }] } },
    } as never).fields[0]?.options?.map((option) => option.value),
    ["ok"],
  );
  // The backstop the per-item caps cannot be: they bound one string, this bounds
  // a thousand of them.
  const heavy: Record<string, unknown> = {};
  for (let i = 0; i < 20; i += 1) {
    heavy[`f${i}`] = {
      type: "string",
      description: "y".repeat(300),
      enum: Array.from({ length: 20 }, (_, j) => `${"z".repeat(190)}${j}`),
    };
  }
  check(
    "and a form that is only large in total is refused by the byte backstop",
    refusalFrom({ type: "object", properties: heavy })?.includes("bytes"),
    true,
  );
}

/*
 * What the agent says, and what survives the daemon.
 *
 * Two things ACP sends that this daemon used to throw away, driven through a real
 * `Session` over in-memory pipes with a fake agent on the other end — the same
 * shape as the fs-capability case above, and for the same reason: both are about
 * what happens to a *notification the agent chose to send*, which no amount of
 * reading the types can settle.
 *
 *   usage_update   — fell into the `other` bucket, so the context window was on the
 *                    wire and unreachable. It must reach `Session.contextUsage` and
 *                    fire `onUsageChanged`, because it never enters the log at all
 *                    and those are its only exits.
 *   tool content   — `emitDiffs` kept `type: "diff"` blocks and dropped the rest, so
 *                    the output of every command an agent ran was discarded here.
 */
process.stdout.write("\nwhat the agent says, and what survives\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const { Session } = await import("../src/session.js");
  const { LocalRuntime } = await import("../src/runtime/local.js");
  const { PassThrough } = await import("node:stream");

  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const send = (message: unknown) => toClient.write(`${JSON.stringify(message)}\n`);
  const notify = (update: unknown) =>
    send({ jsonrpc: "2.0", method: acp.methods.client.session.update, params: { sessionId: "s_fake", update } });

  /** Every `session/new` this driver's agent was asked, as it was asked. */
  const openParams: any[] = [];

  // The fake agent: answer the handshake, then say the two things under test and
  // end the turn. Notifications are sent from inside the `session/prompt` handler
  // so they land while the queue is draining — which is the only time it does.
  let buffer = "";
  toAgent.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as Record<string, any>;
      const id = message["id"];
      switch (message["method"]) {
        case acp.methods.agent.initialize:
          send({ jsonrpc: "2.0", id, result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] } });
          break;
        case acp.methods.agent.session.new:
          // What the daemon actually put on the wire, which is the only place the
          // `_meta` that carries `ultracode` can be observed — it is a request
          // parameter, so no notification listener ever sees it.
          openParams.push(message["params"]);
          send({ jsonrpc: "2.0", id, result: { sessionId: "s_fake" } });
          /*
           * Commands, pushed the way both real adapters push them: *after* the
           * response, so they arrive outside any turn and before the first prompt
           * exists to drain the queue. That timing is the whole bug this replaced
           * — sent from inside the prompt handler like everything else here, it
           * would pass without ever testing it.
           *
           * The delay models the pipe rather than the adapter's own `setTimeout(…,
           * 0)`. `AcpClient` drops an update for a session it has not registered
           * yet (`router.sessions.get(...)?.onUpdate`), and registration happens in
           * the microtask that follows parsing the `session/new` result — so with
           * both ends in *this* process and one PassThrough between them, a
           * zero-delay push is routed before the handler exists and is lost. That
           * is an artefact of having no kernel in the way, not a bug this driver
           * should be pinning: measured 2026-08-03 against real claude 0.63.0 over
           * a real pipe, `Session.agentCommands` is empty the instant `start`
           * resolves and holds 99 commands 1ms later. The window is real and the
           * transport closes it.
           */
          setTimeout(() => {
            notify({
              sessionUpdate: "available_commands_update",
              availableCommands: [
                { name: "compact", description: "Compact the conversation", input: { hint: "<instructions>" } },
                { name: "status", description: "Show status", input: null },
              ],
            });
          }, 10);
          break;
        case acp.methods.agent.session.prompt:
          notify({ sessionUpdate: "usage_update", used: 40_000, size: 200_000 });
          // A spawn and one step inside it, shaped as claude sends them. The
          // *projection* is asserted further up this file; what nothing could reach
          // until now is the wiring — that `_meta` actually becomes two fields on
          // the event union rather than being read and dropped.
          notify({
            sessionUpdate: "tool_call",
            toolCallId: "spawn",
            title: "Task",
            kind: "think",
            status: "pending",
            _meta: { claudeCode: { toolName: "Agent", subagent: true } },
          });
          notify({
            sessionUpdate: "tool_call",
            toolCallId: "step",
            title: "Read",
            kind: "read",
            status: "pending",
            _meta: { claudeCode: { toolName: "Read", parentToolUseId: "spawn" } },
          });
          // The completing update of the spawn, which measurably *loses*
          // `subagent` — the reason the update arm carries only the edge.
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "spawn",
            status: "completed",
            _meta: { claudeCode: { parentToolUseId: "spawn" } },
          });
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            status: "completed",
            rawInput: { command: "ls -la" },
            content: [
              { type: "content", content: { type: "text", text: "total 4\ndrwxr-xr-x  x" } },
              // Dropped on purpose: a terminal is a live handle, not a value, and
              // showing somebody an id they cannot use is worse than showing nothing.
              { type: "terminal", terminalId: "term_1" },
            ],
          });
          /*
           * codex's shape, measured against codex-acp 1.1.9: a finished command
           * with **no content block at all** and its stdout on `rawOutput`. Every
           * one of these was dropped, so a Bash card on a codex session showed the
           * command, a tick, and nothing else.
           */
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "t2",
            status: "completed",
            rawOutput: { formatted_output: "hello from the shell\n", exit_code: 0 },
          });
          /*
           * And the case that must NOT double: blocks and `rawOutput` together,
           * which is what claude sends. The blocks win, and the raw copy is not
           * appended after them.
           */
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "t3",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "the blocks" } }],
            rawOutput: { formatted_output: "the raw copy", exit_code: 0 },
          });
          // A tool whose raw output is not this shape at all. Nothing is invented
          // from it: `rawOutput` is `unknown` in the schema and reading further
          // would be guessing at somebody else's result object.
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "t4",
            status: "completed",
            rawOutput: { stdout: "not the key we read" },
          });
          /*
           * ⭐ The model typing a tool's **arguments** into the content channel,
           * one token at a time. Measured 2026-08-13 against this daemon's own
           * database: one `Write` produced 715 of these, every block a strict
           * extension of the last, and they are 55.8% of every byte in it.
           *
           * The shape below is that run, shortened, with the two things that must
           * survive it: the update that first says `in_progress` (a status the
           * reader has not seen, so it may not be held back — the card draws it as
           * a spinner) and the one that ends the run.
           */
          notify({ sessionUpdate: "tool_call", toolCallId: "w1", title: "Write", kind: "edit", status: "pending" });
          for (const block of ["{", '{"path"', '{"path": "a.py"', '{"path": "a.py", "content": "x"}']) {
            notify({
              sessionUpdate: "tool_call_update",
              toolCallId: "w1",
              status: "in_progress",
              content: [{ type: "content", content: { type: "text", text: block } }],
            });
          }
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "w1",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "Wrote 1 byte to a.py" } }],
          });
          /*
           * A block that extends the last, with a **diff beside it**. `toolOutput`
           * drops a diff block, so the rendered content is a single string and the
           * hold's own test cannot tell this apart from a draft — held, it would
           * take the `emitDiffs` call with it and lose a `file_change` for a patch
           * that really was written. The guard is on the raw block count.
           */
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "w1",
            status: "completed",
            content: [
              { type: "content", content: { type: "text", text: "Wrote 1 byte to a.py more" } },
              { type: "diff", path: "/w/a.py", oldText: null, newText: "x" },
            ],
          });
          /*
           * A status-only update, then one block of real output. There is nothing
           * for that block to be a draft *of*, so it must go out at once — with an
           * empty-string base it would look like an extension of nothing (every
           * string starts with "") and sit held until the next event.
           */
          notify({ sessionUpdate: "tool_call", toolCallId: "w3", title: "Read", kind: "read", status: "pending" });
          notify({ sessionUpdate: "tool_call_update", toolCallId: "w3", status: "in_progress" });
          notify({
            sessionUpdate: "tool_call_update",
            toolCallId: "w3",
            status: "in_progress",
            content: [{ type: "content", content: { type: "text", text: "the only output" } }],
          });
          // A cumulative run that is never followed by another update for its call:
          // the turn's own end has to flush the block it is holding, or the only
          // complete copy is lost.
          notify({ sessionUpdate: "tool_call", toolCallId: "w2", title: "Write", kind: "edit", status: "pending" });
          for (const block of ["a", "ab", "abc"]) {
            notify({
              sessionUpdate: "tool_call_update",
              toolCallId: "w2",
              status: "in_progress",
              content: [{ type: "content", content: { type: "text", text: block } }],
            });
          }
          send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
          break;
        default:
          if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
      }
    }
  });

  // A runtime that is the local one in every respect except where the agent is:
  // subclassing rather than hand-rolling the interface means a new required member
  // is a type error here rather than a silently untested path.
  class PipeRuntime extends LocalRuntime {
    // The agent is these pipes, so where the agent *is* on disk is not a question
    // this runtime should be answering — see stubAgentConfig.
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }

    override async launch(): Promise<any> {
      return {
        stdin: toAgent,
        stdout: toClient,
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        hasExited: false,
        waitForExit: async () => true,
        endStdin: () => toAgent.end(),
        kill: async () => {},
      };
    }
  }

  const session = await Session.start({ agent: "kimi", cwd: process.cwd(), runtime: new PipeRuntime() });
  const announced: { used: number; size: number }[] = [];
  const off = session.onUsageChanged((usage) => announced.push({ used: usage.used, size: usage.size }));
  const commandPushes: number[] = [];
  // Awaited rather than slept on: the push is asynchronous by construction, and a
  // fixed delay here would be a race that passes on this machine. The turn below
  // finishes in well under a millisecond, so without this the session is disposed
  // before the notification is even written.
  const commandsLanded = new Promise<void>((resolve) => {
    const offFirst = session.onCommandsChanged(() => {
      offFirst();
      resolve();
    });
  });
  const offCommands = session.onCommandsChanged((c) => commandPushes.push(c.commands.length));
  await commandsLanded;

  const events: any[] = [];
  for await (const event of session.prompt("hi")) events.push(event);
  off();
  offCommands();
  await session.dispose().catch(() => {});

  /*
   * The commands arrived before any turn did, which is the point.
   *
   * This is the assertion that would have failed before: the notification landed
   * in `onUpdate`'s `default:` arm, became an `other` event on a queue that only
   * drains inside a turn, and was first in line for eviction there. Now it is held
   * out of band and announced, exactly like the config and the usage above.
   */
  check("commands reach the session, from a push outside any turn", session.agentCommands.commands.map((c) => c.name), [
    "compact",
    "status",
  ]);
  check("with the hint the agent gave", session.agentCommands.commands[0]?.hint, "<instructions>");
  check("announced out of band", commandPushes, [2]);
  check(
    "and NOT in the log, where a prefix eviction would take them",
    events.some((e) => e.type === "other" && e.sessionUpdate === "available_commands_update"),
    false,
  );

  check("context usage reaches the session", session.contextUsage, { used: 40_000, size: 200_000, cost: null });
  check("and is announced out of band, since it never enters the log", announced, [{ used: 40_000, size: 200_000 }]);
  check("and is NOT in the log", events.some((e) => e.type === "other" && e.sessionUpdate === "usage_update"), false);

  // By id, not just by type: this section now sends several updates, and a bare
  // find-by-type silently reads whichever one happens to be first.
  const update = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "t1");
  check("a tool update carries what the tool said", update?.content, ["total 4\ndrwxr-xr-x  x"]);
  check("and the arguments it was given", update?.rawInput, { command: "ls -la" });
  // A terminal handle is not output. If this ever starts passing with a second
  // entry, something decided an id was worth showing a person.
  check("but not a terminal handle", update?.content?.length, 1);

  /*
   * The other place a tool's output can be, and the rule that keeps it from
   * being counted twice. See `rawToolOutput`.
   */
  const rawOnly = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "t2");
  const bothWays = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "t3");
  const unknownShape = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "t4");
  check("output that arrives only on rawOutput is carried", rawOnly?.content, ["hello from the shell"]);
  check("blocks win where an agent sends both, so nothing is doubled", bothWays?.content, ["the blocks"]);
  check("and a raw output of another shape invents nothing", unknownShape?.content, null);

  /*
   * ⭐ **The arguments being typed, and what reaches the log instead of them.**
   *
   * Four streamed blocks went in. What comes out is the one that first said
   * `in_progress` — a status the reader has not seen, which may never be held
   * back, because `EventList` draws it as a spinning `Loader` and `pending` as a
   * static glyph — then the final, complete form of the run, then the result.
   * The two blocks in the middle are drafts of the fourth and reach nothing.
   *
   * Asserted as the whole sequence rather than as a count: a count stays green if
   * the *wrong* two survive, and which two survive is the entire rule.
   */
  const w1 = events.filter((e) => e.type === "tool_call_update" && e.toolCallId === "w1");
  check("a streamed run reaches the log as its first block, its last, and the result", w1.map((e) => e.content), [
    ["{"],
    ['{"path": "a.py", "content": "x"}'],
    ["Wrote 1 byte to a.py"],
    ["Wrote 1 byte to a.py more"],
  ]);
  check("and the status that draws the spinner is not held back", w1[0]?.status, "in_progress");
  /*
   * The last of those extends the one before it and would have been held on the
   * rendered content alone — but it arrived with a diff beside it, and holding it
   * would have taken the `file_change` with it. The guard is the raw block count;
   * this is the only thing that says so.
   */
  check("a diff beside an extending block is never held back", events.some((e) => e.type === "file_change" && e.path === "/w/a.py"), true);

  /*
   * The run nothing follows. `onUpdate` cannot flush it — there is no next update
   * — so the turn's own end must, or the only complete copy of the block is lost.
   * This is the case that makes holding safe rather than a way to drop content.
   */
  const w2 = events.filter((e) => e.type === "tool_call_update" && e.toolCallId === "w2");
  check("a run the turn ends still delivers its last block", w2.map((e) => e.content), [["a"], ["abc"]]);

  /*
   * The base for the prefix test is `null` and not `""`. Every string starts with
   * the empty one, so an empty base makes the first block after a status-only
   * update look like a draft and holds it until something else happens — on a
   * tool whose whole output is that one block, until the end of the turn.
   */
  const w3 = events.filter((e) => e.type === "tool_call_update" && e.toolCallId === "w3");
  check("a lone output block is never mistaken for a draft", w3.map((e) => e.content), [null, ["the only output"]]);

  /*
   * And what the daemon *asks* for at the door.
   *
   * `_meta` is a request parameter, so it is invisible to every listener this
   * driver has: the only way to see it is to be the agent. The unit test of
   * `sessionMetaFor` proves the shape; this proves `Session` actually spreads it
   * onto `session/new` — and that a session which asked for nothing sends no
   * `_meta` key at all rather than an explicit `undefined`, which is a different
   * message to whatever is parsing it on the far side.
   */
  check("a session that asked for nothing carries no _meta", "_meta" in (openParams[0] ?? {}), false);

  /*
   * Lineage, from an agent's `_meta` to the event union.
   *
   * The section above asserts `toolCallLineage` in isolation; this is the only place
   * that proves `session.ts` actually spreads the result onto the event. Two
   * decisions ride on it and both are silent if reversed: the `tool_call` arm
   * carries **both** fields, and the `tool_call_update` arm carries **only** the
   * edge — measured 2026-08-01, claude drops `subagent` on a spawn's own
   * completing update, so mirroring it there would say "not a subagent any more"
   * about the call that just finished being one.
   */
  const calls = events.filter((e) => e.type === "tool_call");
  check(
    "a spawn arrives declared, with no parent of its own",
    calls.find((e) => e.toolCallId === "spawn"),
    { type: "tool_call", toolCallId: "spawn", title: "Task", kind: "think", status: "pending", locations: [], rawInput: null, parentToolCallId: null, subagent: true },
  );
  check(
    "and a call inside it carries the edge, byte for byte",
    [
      calls.find((e) => e.toolCallId === "step")?.parentToolCallId,
      calls.find((e) => e.toolCallId === "step")?.subagent,
    ],
    ["spawn", false],
  );
  // Asserted as an *absence*: the update arm must never grow a `subagent` key,
  // however tempting the symmetry looks.
  const spawnDone = events.find((e) => e.type === "tool_call_update" && e.toolCallId === "spawn");
  check("a spawn's completing update never restates the flag", "subagent" in (spawnDone ?? {}), false);
  check("and an update with no lineage at all reports none", update?.parentToolCallId, null);

  /*
   * The first prompt names the session.
   *
   * The *derivation* is pure and asserted further up this file; what is asserted here
   * is the **wiring**, which nothing else can reach. `ManagedSession.prompt`
   * refuses without a live agent, so the restored rows above — which have
   * none — can only ever prove the negative half. This drives a real registry over
   * the same in-memory pipes, so the naming actually happens.
   *
   * Placement is the part that would break silently: the assignment sits *below*
   * the terminal/busy/not-ready guards, so a prompt the daemon refused never names
   * anything. A session called "hi" that never ran would be worse than one called
   * by its path.
   */
  const { SessionRegistry } = await import("../src/registry.js");
  const { MemoryEventStore } = await import("../src/events.js");

  // A second fake agent, because the first one's pipes are spent.
  const toAgent2 = new PassThrough();
  const toClient2 = new PassThrough();
  const send2 = (m: unknown) => toClient2.write(`${JSON.stringify(m)}\n`);
  let buffer2 = "";
  toAgent2.on("data", (chunk: Buffer) => {
    buffer2 += chunk.toString("utf8");
    for (let nl = buffer2.indexOf("\n"); nl >= 0; nl = buffer2.indexOf("\n")) {
      const line = buffer2.slice(0, nl);
      buffer2 = buffer2.slice(nl + 1);
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as Record<string, any>;
      const id = message["id"];
      if (message["method"] === acp.methods.agent.initialize) {
        send2({ jsonrpc: "2.0", id, result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] } });
      } else if (message["method"] === acp.methods.agent.session.new) {
        send2({ jsonrpc: "2.0", id, result: { sessionId: "s_named" } });
        // Scheduled *after* the answer, which is what both real adapters do.
        //
        // The delay is named rather than left at 0 on purpose, and so is what it
        // does *not* cover: this lands after the registry has subscribed, so what
        // it exercises is the announcement path. `onStarted`'s read-once — the
        // guard for a notification arriving in the gap between `Session.start`
        // resolving and that subscription — is not raced here, because with both
        // ends in one process and a `PassThrough` between them there is no kernel
        // to hold the write and the gap is not reproducible on demand. Saying so
        // beats an assertion that would pass either way and read as coverage.
        setTimeout(() => {
          send2({
            jsonrpc: "2.0",
            method: acp.methods.client.session.update,
            params: {
              sessionId: "s_named",
              update: {
                sessionUpdate: "available_commands_update",
                availableCommands: [
                  { name: "compact", description: "Compact", input: { hint: "<how>" } },
                  { name: "status", description: "Status", input: null },
                ],
              },
            },
          });
        }, 5);
      } else if (message["method"] === acp.methods.agent.session.prompt) {
        send2({
          jsonrpc: "2.0",
          method: acp.methods.client.session.update,
          params: { sessionId: "s_named", update: { sessionUpdate: "usage_update", used: 61_000, size: 200_000 } },
        });
        send2({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      } else if (id !== undefined) {
        send2({ jsonrpc: "2.0", id, result: {} });
      }
    }
  });

  class NamingRuntime extends LocalRuntime {
    // Overridden so this does not probe the host for a real `kimi` — the point is
    // the registry's wiring, not whether this machine has an agent installed.
    override async availability(): Promise<any> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null }];
    }

    // The same intent, and it was half-applied: `availability` was overridden and
    // `describe` was not, so `registry.create` still resolved a real binary on
    // PATH by way of `Session.start`. Unreached until the section above stopped
    // throwing first.
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<any> {
      return {
        stdin: toAgent2,
        stdout: toClient2,
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        hasExited: false,
        waitForExit: async () => true,
        endStdin: () => toAgent2.end(),
        kill: async () => {},
      };
    }
  }

  /** Let the in-flight turn drain, since `prompt` refuses while one is running. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

  // `undefined` for the policy so the registry's own default applies — it is not
  // exported, and exporting it to satisfy a driver would be the driver shaping the
  // code rather than the other way round.
  const registry = new SessionRegistry(new MemoryEventStore(), null, undefined, new NamingRuntime());
  const workdir = tmp("namecheck-");
  const managed = await registry.create({ agent: "kimi", cwd: workdir });

  check("a fresh session has no name", managed.title, null);
  check("the first prompt names it", managed.prompt("Rework the reconnect backoff\nand the rest").kind, "accepted");
  check("after the first meaningful line", managed.title, "Rework the reconnect backoff");

  // The *snapshot* is what a browser reads, and it is a different object from the
  // `Session` asserted above — the registry has to mirror it there or the context
  // readout is on the wire and unreachable, which is where it started.
  await settle();
  check("and the registry mirrors it onto the snapshot", managed.snapshot().contextUsage, {
    used: 61_000,
    size: 200_000,
    cost: null,
  });
  // Copied, not referenced: `Object.freeze` is shallow, and a frame built now must
  // describe now.
  check(
    "as a copy, not a reference",
    managed.snapshot().contextUsage !== managed.snapshot().contextUsage,
    true,
  );

  // Written once. A second prompt must not rename what the first named, or a
  // session's identity would change under somebody every time they typed.
  managed.prompt("something else entirely");
  check("and a later prompt does not rename it", managed.title, "Rework the reconnect backoff");

  // A rename wins for ever, because the derivation is guarded on `null`.
  managed.setMeta({ title: "Mine" });
  await settle();
  managed.prompt("and another");
  check("a manual rename survives every later prompt", managed.title, "Mine");

  // Clearing re-arms it — the only sensible reading of clearing a name.
  managed.setMeta({ title: null });
  await settle();
  managed.prompt("Fresh start here");
  check("clearing re-arms the derivation", managed.title, "Fresh start here");

  /*
   * The command list on a real `ManagedSession`, which is where every rule about
   * it lives and where nothing reached before.
   *
   * The route-level assertion further up drives an unknown id and a session with
   * no live agent, so it could only ever prove the empty end — it stays green for
   * an implementation whose counter is hardwired to 0. What has to be true is the
   * *movement*: the list arrives, the number moves once for it, it does not move
   * for a republish that says nothing new, and it moves again — never back to
   * zero — when the agent goes.
   */
  check("the agent's commands reach the managed session", managed.agentCommands.commands.map((c) => c.name), [
    "compact",
    "status",
  ]);
  const firstRevision = managed.commandsRevision;
  check("and the revision moved exactly once to announce them", firstRevision, 1);
  check("which is what the snapshot carries", managed.snapshot().commandsRevision, firstRevision);

  /*
   * An identical republish is not an announcement.
   *
   * claude republishes from `commands_changed` as it discovers skills while
   * walking a subdirectory, so a byte-identical list arriving repeatedly inside
   * one turn is the ordinary case rather than the pathological one. Each bump
   * costs a snapshot, a row write and a frame per attached client on the agent's
   * own emit path — and then a full refetch of the list at every client, over the
   * relay. `usageWorthAnnouncing` guards the same shape one field over.
   */
  const republish = (commands: unknown[]) => {
    send2({
      jsonrpc: "2.0",
      method: acp.methods.client.session.update,
      params: {
        sessionId: "s_named",
        update: { sessionUpdate: "available_commands_update", availableCommands: commands },
      },
    });
    return settle();
  };
  await republish([
    { name: "compact", description: "Compact", input: { hint: "<how>" } },
    { name: "status", description: "Status", input: null },
  ]);
  check("the same list published again does not move the revision", managed.commandsRevision, firstRevision);
  await republish([
    { name: "compact", description: "Compact", input: { hint: "<how>" } },
    { name: "status", description: "Status", input: null },
    { name: "usage", description: "Usage", input: null },
  ]);
  check("a list that actually changed does", managed.commandsRevision, firstRevision + 1);
  check("and the new command is there to be fetched", managed.agentCommands.commands.length, 3);

  const beforeStop = managed.commandsRevision;
  await registry.stop(managed.id).catch(() => {});

  /*
   * The agent is gone, so the commands are — and the revision is *bumped* rather
   * than reset. It is a change marker, not a count: zeroing it would leave a
   * client holding revision 1 comparing 1 to 1 and keeping a menu whose agent no
   * longer exists.
   */
  check("stopping the agent withdraws its commands", managed.agentCommands, { commands: [], dropped: 0 });
  check("and moves the revision forward rather than back to zero", managed.commandsRevision, beforeStop + 1);
  check("which a client sees as a change, not as the daemon falling behind", managed.snapshot().commandsRevision > 0, true);
}

/* ------------------------------------------------------------------ *
 * Attachments — the pure rules
 *
 * A filename is a *label* here, not a location: the file is created inside a
 * directory named by 64 fresh random bits, so containment comes from the path
 * and not from the name. That is why this sanitizes where `safeRelPath` refuses,
 * and the two are asserted side by side so nobody later makes them agree.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat a filename becomes\n");
{
  const named = (input: string): string =>
    sanitizeUploadName(input).ok ? (sanitizeUploadName(input) as { name: string }).name : `!${(sanitizeUploadName(input) as { reason: string }).reason}`;

  // Traversal is a *rename*, not a refusal: a browser's `File.name` has carried a
  // path on some platforms, and the directory it lands in is already unguessable.
  check("a traversal is reduced to its basename", named("../../etc/passwd"), "passwd");
  check("so is a windows path", named("C:\\Users\\me\\b.png"), "b.png");
  check("and an ordinary one", named("a/b/c.txt"), "c.txt");
  check("a dotfile keeps its dot", named(".gitignore"), ".gitignore");

  // These are refusals, and the CR one is the reason: this string is echoed into
  // a `Content-Disposition` header, where a CR is response splitting.
  check("a NUL is refused", named("x\u0000y"), "!nul_byte");
  check("a newline is refused", named("a\r\nb"), "!control_char");
  check("and so is a bare dot", named("."), "!reserved");
  check("or two", named(".."), "!reserved");
  check("a name of nothing but controls has nothing left", named("\u0001\u0002"), "!control_char");
  check("and an empty one is empty", named(""), "!empty");

  // Windows drops trailing dots and spaces silently, so a name that round-trips
  // differently there stops matching what was stored.
  check("trailing dots and spaces go", named("name.  "), "name");
  // Free, and this daemon will not always run on this platform.
  check("a device name is prefixed rather than refused", named("CON.txt"), "_CON.txt");
  check("case-insensitively", named("com1"), "_com1");

  const long = named(`${"x".repeat(400)}.png`);
  check("a long name is shortened to the cap", Buffer.byteLength(long, "utf8") <= 200, true);
  // Kept, because the extension is what a person and their OS both read.
  check("and keeps its extension", long.endsWith(".png"), true);
  // No `…[truncated N bytes]` marker: right for prose nobody types, wrong for a
  // name. Safe only because the response echoes the original.
  check("with no truncation marker", long.includes("truncated"), false);

  // Greek and an emoji on purpose, and the fixture stays non-ASCII: the byte
  // cap above counts UTF-8 bytes, so two- and four-byte code points are the only
  // input that tells a byte-wise truncation apart from a character-wise one.
  check("unicode survives byte for byte", named("αναφορά-📊.pdf"), "αναφορά-📊.pdf");

  /*
   * ⭐ **The clip may not reconstruct a name this function refuses.**
   *
   * `clipName` keeps the extension and cuts the stem to the **last** dot, so a
   * leading dot with the last dot at index 1 collapses the stem to `"."` while a
   * tail too long to be an extension is dropped entirely. Measured before the
   * fix: this input returned `{ok: true, name: "."}` — the value refused earlier
   * in the same function — because the reserved check ran on the input and never
   * on the result.
   */
  check("a clip may not rebuild a reserved name", sanitizeUploadName("..".concat("a".repeat(300))).ok, false);
  check("nor the bare current directory", sanitizeUploadName(".".concat(".", "b".repeat(400))).ok, false);
  // The ordinary long name still clips rather than being refused, which is the
  // property the arm above must not have cost.
  check("while an ordinary over-long name still clips", named("z".repeat(400).concat(".png")).endsWith(".png"), true);

  // **Accepted here on purpose.** Escaping quotes is the download header's job,
  // and asserting it in this direction is what stops the two being conflated.
  check("a quote is not this function's problem", named('a"b.txt'), 'a"b.txt');
}

process.stdout.write("\nwhat a download says its filename is\n");
{
  // The other door onto the same hazard: `safeRelPath` rejects NUL but **not**
  // CR or LF, and a workspace filename is a path component an *agent* chose.
  const injected = contentDispositionFor("a\r\nX-Evil: 1");
  check("no header value can contain a newline", /^[^\r\n]*$/.test(injected), true);
  check("a quote cannot end the quoted string", contentDispositionFor('a"b.txt').includes('filename="ab.txt"'), true);
  check("nor can a backslash", contentDispositionFor("a\\b.txt").includes('filename="ab.txt"'), true);
  check("always attachment, never inline", contentDispositionFor("a.txt").startsWith("attachment;"), true);
  check("unicode rides the RFC 5987 half", contentDispositionFor("αναφορά.pdf").includes("filename*=UTF-8''"), true);
  check(
    "and is percent-encoded there",
    contentDispositionFor("αναφορά.pdf").endsWith("%CE%B1%CE%BD%CE%B1%CF%86%CE%BF%CF%81%CE%AC.pdf"),
    true,
  );
  // A name that survives neither half still has to produce a usable header.
  check("a name with nothing ASCII left still gets one", contentDispositionFor("📊").includes('filename="_"'), true);
}

process.stdout.write("\nwhere uploads live\n");
{
  check("the default sits beside the database", resolveUploadRoot(undefined), join(homedir(), ".reemoat", "uploads"));
  check("a tilde expands", resolveUploadRoot("~/staged"), join(homedir(), "staged"));
  check(
    "a relative path is refused",
    (() => {
      try {
        resolveUploadRoot("staged");
        return "(accepted)";
      } catch {
        return "refused";
      }
    })(),
    "refused",
  );

  /*
   * The check that actually protects the second `rm` site in this codebase.
   *
   * `removeWorkspace` guards its `rmSync` with `containedIn(root, worktreeRoot)`
   * and the upload sweep guards its own with the mirror. If either root nested in
   * the other, one remover could reach into the other's tree and neither guard
   * would mean what it says. `daemon.ts` refuses to start on this; here it is
   * asserted in **both** directions, because nesting either way is the failure.
   */
  const uploadsRoot = resolveUploadRoot(undefined);
  const worktrees = join(homedir(), ".reemoat", "worktrees");
  check("the two roots do not nest", atOrUnder(uploadsRoot, worktrees), false);
  check("in either direction", atOrUnder(worktrees, uploadsRoot), false);
}

/* ------------------------------------------------------------------ *
 * Taking a file in, and letting the sender go on every refusal
 *
 * `Uploads.receive`'s running byte counter is the **only bound on a request
 * body anywhere in this system** — nothing in `src/`, the relay or the control
 * plane configures one, and the relay pipes bodies straight through. So this is
 * the path, and until now nothing drove it.
 *
 * The cancelling is the part worth the machinery. Refusing a half-read body and
 * simply stopping parks the sender against the relay's per-stream window, which
 * is granted on consumption; the next valve above that is the tunnel's 8 MiB
 * socket-buffer check, and it closes the **whole tunnel for this machine** —
 * every other session on it goes too. Every refusal below therefore asserts two
 * things: the answer, and that the body was released.
 *
 * **Which of those assertions pins `cancelBody` itself is worth writing down,
 * because it is only half of them.** Measured, by deleting each call in turn:
 * removing the one on the *post-loop* path — `too_large`, `quota` — changes
 * nothing here, because breaking out of a `for await` calls the async iterator's
 * `return()`, which cancels the stream anyway. Removing the one on a refusal
 * that happens **before the loop** — `too_many`, an unusable session id — fails
 * two cases immediately, and those are the paths where nothing else would ever
 * release the sender. So the `pulled: 0` assertions below are the load-bearing
 * ones, and the mid-body pair assert the property rather than the call.
 * ------------------------------------------------------------------ */

process.stdout.write("\ntaking a file in\n");
{
  /*
   * **The upload root is nested one level inside its own temp directory**, so the
   * traversal case below can assert about a path this run owns.
   *
   * Flat, `root` was the `mkdtemp` directory itself and `join(root, "..",
   * "escape")` normalized to `<tmpdir>/escape` — `/tmp/escape` on CI, which this
   * driver neither creates nor removes. Two failure modes, both silent: a single
   * run in which the refusal genuinely regressed leaves the file behind and the
   * case stays red on that machine for ever, and any unrelated `/tmp/escape` from
   * anything else on the host is a red that no other assertion explains.
   */
  const receiveHome = tmp("reemoat-receive-");
  const root = join(receiveHome, "root");
  mkdirSync(root, { recursive: true });
  const index = memoryUploadIndex();
  const uploads = await Uploads.open({ root, index, onWarning: () => {} });

  /** A body that records whether anybody read it and whether it was released. */
  const bodyOf = (chunks: Uint8Array[]) => {
    const state = { cancelled: false, pulled: 0 };
    let next = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next >= chunks.length) {
          controller.close();
          return;
        }
        state.pulled += 1;
        controller.enqueue(chunks[next]!);
        next += 1;
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return { stream, state };
  };
  const chunk = (bytes: number, fill = 7): Uint8Array => new Uint8Array(bytes).fill(fill);
  /** Directories under a session, which is what a leaked refusal would leave. */
  const dirsFor = (sessionId: string): string[] =>
    existsSync(join(root, sessionId)) ? readdirSync(join(root, sessionId)) : [];

  {
    const body = bodyOf([chunk(4), chunk(6)]);
    const result = await uploads.receive("s_take", {
      name: "notes.txt",
      origName: "notes.txt",
      mime: "text/plain",
      body: body.stream,
    });
    check("an ordinary upload is accepted", result.kind, "ok");
    if (result.kind === "ok") {
      check("counting every byte that arrived", result.row.bytes, 10);
      check("and telling the client what the session has spent", [result.sessionBytes, result.sessionCount], [10, 1]);
      check(
        "the bytes really are on disk",
        readFileSync(join(root, "s_take", result.row.uploadId, "notes.txt")).length,
        10,
      );
      // Named by 64 fresh random bits, which is where containment comes from —
      // the filename is a label and never a location.
      check("under an id nothing else could name", /^u_[0-9a-f]{16}$/.test(result.row.uploadId), true);
      check("and it can be resolved by that id", uploads.resolve("s_take", [result.row.uploadId]).ok, true);
    }
    check("an id nobody staged resolves to nothing", uploads.resolve("s_take", ["u_nope"]), {
      ok: false,
      missing: "u_nope",
    });
  }

  {
    /*
     * The refusals that happen **before a byte is read**, which is where
     * forgetting to cancel would be completely silent: the answer is correct, the
     * disk is untouched, and the sender is left parked. `pulled: 0` is what makes
     * this assertion about `cancelBody` rather than about the `for await` loop's
     * own cleanup.
     */
    for (let n = 0; n < MAX_UPLOADS_PER_SESSION; n += 1) {
      index.insert({
        sessionId: "s_many",
        uploadId: `u_pad${n}`,
        name: "pad",
        origName: "pad",
        mime: null,
        bytes: 1,
        createdAt: now,
        consumedAt: null,
      });
    }
    const body = bodyOf([chunk(4)]);
    const result = await uploads.receive("s_many", {
      name: "one-too-many.txt",
      origName: "one-too-many.txt",
      mime: null,
      body: body.stream,
    });
    check("the hundred-and-first file is refused", result.kind, "too_many");
    check("without reading a byte of it", body.state.pulled, 0);
    check("and the sender is released rather than parked", body.state.cancelled, true);
    check("with nothing left on disk", dirsFor("s_many"), []);
  }

  {
    // A session id that cannot be a path segment is refused the same way, and it
    // is the one refusal that protects the root itself rather than a budget.
    const body = bodyOf([chunk(4)]);
    const result = await uploads.receive("../escape", {
      name: "x.txt",
      origName: "x.txt",
      mime: null,
      body: body.stream,
    });
    check("an unusable session id is refused", result.kind, "write_failed");
    check("before anything is read", body.state.pulled, 0);
    check("and the body is still released", body.state.cancelled, true);
    // `receiveHome`, not `<tmpdir>` — the negative space being asserted about has
    // to be owned by this run, or an unrelated file on the host decides the case.
    check("with nothing created outside the root", existsSync(join(receiveHome, "escape")), false);
  }

  {
    /*
     * The per-session budget, reached without writing 100 MiB: the index is the
     * accounting and `receive` reads `bytesFor` before it opens anything. That is
     * also why the index is SQLite in production rather than a map — a restart
     * would otherwise reset every total to zero, and a restart is the ordinary
     * outcome of a deploy.
     */
    index.insert({
      sessionId: "s_full",
      uploadId: "u_prior",
      name: "prior",
      origName: "prior",
      mime: null,
      bytes: MAX_SESSION_UPLOAD_BYTES,
      createdAt: now,
      consumedAt: null,
    });
    /*
     * More chunks than it takes to trip the budget, so the refusal genuinely
     * happens mid-body. A body that has already been drained to its end has
     * nothing left to release — cancelling it is a no-op — so a single-chunk
     * fixture would assert nothing about the path that matters.
     */
    const body = bodyOf(Array.from({ length: 8 }, () => chunk(64)));
    const result = await uploads.receive("s_full", {
      name: "over.txt",
      origName: "over.txt",
      mime: null,
      body: body.stream,
    });
    check("a session already at its budget refuses the next file", result.kind, "quota");
    check("saying how much of it is already spent", result.kind === "quota" && result.used, MAX_SESSION_UPLOAD_BYTES);
    check("the refusal is immediate rather than after the whole body", body.state.pulled < 8, true);
    check("the body is released", body.state.cancelled, true);
    check("and the directory it had started is removed again", dirsFor("s_full"), []);
  }

  {
    /*
     * The running counter itself — the backstop for a chunked body and for a
     * client that lies about `content-length`, which is the only reason the route
     * can trust a declared length at all.
     *
     * Streamed rather than allocated whole: the check runs *before* each write,
     * so at most one chunk past the limit is ever in memory and none of it
     * reaches the disk.
     *
     * ⚠ **This drives the real constant, so it costs a real `MAX_UPLOAD_BYTES` of
     * writes**, and that quadrupled when the cap did. Two things keep it honest
     * rather than merely slow. The chunk is **one buffer, enqueued repeatedly** —
     * nothing here mutates it, and building an array of a hundred separate
     * mebibytes put the whole cap on the heap to test a bound that exists so it
     * never is. And the chunk is 8 MiB rather than 1, which is the same journey
     * in an eighth of the pulls; the assertion below is `pulled < chunks.length`,
     * a claim about stopping early rather than about a particular count, so the
     * granularity is free to be coarse.
     *
     * Driving a smaller injected cap was the alternative and was declined: the
     * number this asserts is the number the daemon actually enforces, and a
     * driver that agrees with a parameter it passed in has asserted nothing.
     */
    const step = 8 * 1024 * 1024;
    const shared = chunk(step, 3);
    // Deliberately more than it takes to cross the line, so "it stopped early"
    // is a claim with something to be wrong about.
    const chunks = Array.from({ length: Math.ceil(MAX_UPLOAD_BYTES / step) + 3 }, () => shared);
    const body = bodyOf(chunks);
    const result = await uploads.receive("s_big", {
      name: "huge.bin",
      origName: "huge.bin",
      mime: null,
      body: body.stream,
    });
    check("a file over the per-file cap is refused", result.kind, "too_large");
    check("part-way through rather than after taking all of it", body.state.pulled < chunks.length, true);
    check("the body is released", body.state.cancelled, true);
    // Unlink, then rmdir, then cancel — a refusal that left the partial file
    // would be a bound on the *answer* and not on the disk.
    check("and the partial file is gone, not merely unreferenced", dirsFor("s_big"), []);
    check("with nothing recorded against the session", index.bytesFor("s_big"), 0);
  }

  await uploads.shutdown();
}

/* ------------------------------------------------------------------ *
 * How fast one session may spend this machine's disk
 *
 * The soft bound beside the hard ones. `MAX_SESSION_UPLOAD_BYTES` and
 * `MAX_UPLOADS_PER_SESSION` are totals that never refill; this is a window, and
 * it exists because the per-file cap went up 4× in the same change that added it.
 *
 * Driven as the pure decision rather than through `receive`, and that is the only
 * way it *can* be driven: reaching `UPLOAD_RATE_BYTES` end-to-end means writing
 * 300 MiB to a temp directory, per run, offline — which is not a cost this repo
 * pays, so the alternative to asserting the function is asserting nothing. The
 * class around it holds a `Map` and calls this; there is no second decision in it.
 * ------------------------------------------------------------------ */

process.stdout.write("\nhow fast one session may upload\n");
{
  const now = 1_700_000_000_000;
  const full = [{ at: now - 1_000, bytes: UPLOAD_RATE_BYTES }];

  check("a session that has uploaded nothing goes ahead", uploadRateVerdict([], now).waitMs, 0);
  check(
    "and one still under the budget does too",
    uploadRateVerdict([{ at: now - 1_000, bytes: UPLOAD_RATE_BYTES - 1 }], now).waitMs,
    0,
  );

  // Exactly the budget is refused rather than allowed one more, which is the
  // boundary `uploadRateVerdict` states explicitly so it cannot drift by a `<=`.
  check("spending precisely the budget is already too much", uploadRateVerdict(full, now).waitMs > 0, true);
  /*
   * The wait is *when the oldest entry falls out*, to the millisecond — an
   * arbitrary backoff would be a number nobody can check, and one that is too
   * short is a client retrying into the same refusal.
   */
  check("and the wait is when the oldest spend ages out", uploadRateVerdict(full, now).waitMs, UPLOAD_RATE_WINDOW_MS - 1_000);

  /*
   * The window really is a window: the same bytes, older, decide nothing.
   * `at > floor` is strict, so an entry exactly `UPLOAD_RATE_WINDOW_MS` old is
   * already out — the boundary again, and stated in the same direction.
   */
  const stale = [{ at: now - UPLOAD_RATE_WINDOW_MS, bytes: UPLOAD_RATE_BYTES * 4 }];
  check("bytes older than the window are not spent at all", uploadRateVerdict(stale, now).waitMs, 0);
  check("and are dropped rather than carried", uploadRateVerdict(stale, now).kept, []);

  // Half in and half out: only what is still inside counts, so a session cannot
  // be held down by what it did an hour ago.
  const straddling = [
    { at: now - UPLOAD_RATE_WINDOW_MS - 1, bytes: UPLOAD_RATE_BYTES },
    { at: now - 10, bytes: 1 },
  ];
  check("a mixed window counts only what is inside it", uploadRateVerdict(straddling, now).waitMs, 0);
  check("keeping exactly those entries", uploadRateVerdict(straddling, now).kept.length, 1);

  // Never zero while refusing: `Retry-After: 0` invites the retry it refuses.
  const onTheEdge = [{ at: now - UPLOAD_RATE_WINDOW_MS + 1, bytes: UPLOAD_RATE_BYTES }];
  check("a refusal never says to retry immediately", uploadRateVerdict(onTheEdge, now).waitMs >= 1, true);
}

/* ------------------------------------------------------------------ *
 * What an attachment becomes on the wire to the agent
 *
 * One function holds every block rule, so a driver can assert the exact array
 * against a fake capability set rather than against a live agent.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat an attachment becomes\n");
{
  const uploadRoot = tmp("reemoat-uploads-");
  const index = memoryUploadIndex();
  const uploads = await Uploads.open({ root: uploadRoot, index, onWarning: () => {} });

  const stage = (name: string, mime: string | null, bytes: Buffer): UploadRow => {
    const row: UploadRow = {
      sessionId: "s_one",
      uploadId: `u_${name}`,
      name,
      origName: name,
      mime,
      bytes: bytes.length,
      createdAt: now,
      consumedAt: null,
    };
    mkdirSync(join(uploadRoot, row.sessionId, row.uploadId), { recursive: true });
    writeFileSync(join(uploadRoot, row.sessionId, row.uploadId, name), bytes);
    index.insert(row);
    return row;
  };

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const small = stage("shot.png", "image/png", png);
  const text = stage("log.txt", "text/plain", Buffer.from("hello\n"));
  const unknown = stage("blob.bin", null, Buffer.from("x"));
  const huge = stage("big.png", "image/png", Buffer.alloc(6 * 1024 * 1024, 1));

  // Every attachment gets one of these and it is the block that is never wrong —
  // ACP requires every agent to support `resource_link`. That is the whole reason
  // the composer's paperclip needs no capability gate.
  const linksOnly = await uploads.blocksFor([small, text, unknown], { image: false });
  check("with no image capability, every file is a link", linksOnly.map((b) => b.type), [
    "resource_link",
    "resource_link",
    "resource_link",
  ]);
  check("carrying the stored name", (linksOnly[0] as { name: string }).name, "shot.png");
  check("its size", (linksOnly[0] as { size: number }).size, png.length);
  // `file://`, because the agent runs as this user on this machine and can open
  // it. An HTTP URL would need a token it does not have.
  check("and a file URL", (linksOnly[0] as { uri: string }).uri.startsWith("file://"), true);

  const withImage = await uploads.blocksFor([small], { image: true });
  check("an image agent gets the link and the bytes", withImage.map((b) => b.type), ["resource_link", "image"]);
  // Round-tripped rather than merely present: base64 of the wrong file would look
  // identical to this assertion's neighbours.
  check(
    "and the bytes are the file's",
    Buffer.from((withImage[1] as { data: string }).data, "base64").equals(png),
    true,
  );

  check("a text file is never inlined", (await uploads.blocksFor([text], { image: true })).map((b) => b.type), [
    "resource_link",
  ]);
  check("nor is one with no declared type", (await uploads.blocksFor([unknown], { image: true })).map((b) => b.type), [
    "resource_link",
  ]);
  // 6 MiB raw is ~8 MiB of base64 in one JSON-RPC write to the agent's stdin.
  check("nor an image over the inline cap", (await uploads.blocksFor([huge], { image: true })).map((b) => b.type), [
    "resource_link",
  ]);

  // The same decision the recorded `inlined` flag is built from, which is what
  // stops the event and the blocks disagreeing.
  check("and `inlinesImage` agrees with all four", [
    inlinesImage(small.mime, small.bytes, { image: true }),
    inlinesImage(text.mime, text.bytes, { image: true }),
    inlinesImage(unknown.mime, unknown.bytes, { image: true }),
    inlinesImage(huge.mime, huge.bytes, { image: true }),
  ], [true, false, false, false]);
  check("and says no when the agent cannot take one", inlinesImage(small.mime, small.bytes, { image: false }), false);

  /*
   * An image the agent handed back is kept rather than dropped.
   *
   * Measured before this existed: `renderContentBlock` hit its `default:` arm and
   * returned the literal string `[image]`, three times in one real database, all
   * from `Read` on a picture — so asking an agent about a screenshot produced a
   * transcript that could not show the screenshot.
   */
  const returned = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
  const kept = uploads.keepAgentImage("s_agent", "image/png", returned.toString("base64"));
  // Its own line, above the guard, for the two reasons this file keeps making:
  // `kept!` was a non-null assertion over precisely the failure these lines catch,
  // so a dropped row threw a TypeError out of the driver instead of failing one
  // check and letting the rest of the file run; and a check that reads through
  // `kept?.` still has to say what it wants when there is no row.
  check("an agent image gets a row", kept !== null, true);
  if (kept) {
    check("carrying the bytes it was handed", kept.bytes, returned.length);
    check("named from its declared type", kept.name.endsWith(".png"), true);
    /*
     * Already consumed: it is referenced by an event the instant it exists, so
     * the unconsumed TTL must never reach it. Read into a local and asserted in
     * two halves, because `index.get(...)?.consumedAt !== null` is *true* when
     * `get` returns nothing — the row having never reached the index is the
     * failure, and it used to pass.
     */
    const indexed = index.get("s_agent", kept.uploadId);
    check("the index really holds it", indexed !== null, true);
    check("and is consumed immediately, so no TTL reaches it", indexed !== null && indexed.consumedAt !== null, true);
    // The write is deferred because the caller is the emit path, which never
    // awaits — so the bytes land a tick later, not before this returns.
    await new Promise((resolve) => setTimeout(resolve, 50));
    check("the bytes land on disk shortly after", existsSync(join(uploadRoot, "s_agent", kept.uploadId, kept.name)), true);
    check("and round-trip", readFileSync(join(uploadRoot, "s_agent", kept.uploadId, kept.name)).equals(returned), true);
  }
  // The same per-session ceiling user uploads have. An agent returning a
  // thousand screenshots spends the budget and then stops, rather than filling
  // the disk silently.
  check("an unusable session id is refused", uploads.keepAgentImage("../escape", "image/png", returned.toString("base64")), null);
  check("and so is an empty payload", uploads.keepAgentImage("s_agent", "image/png", ""), null);

  /*
   * A session id shaped like a traversal removes nothing.
   *
   * Ids come from the registry and never from a request, so this is
   * self-protection in exactly the sense `worktree.ts` means it: what it guards
   * is the second `rm` in this codebase.
   */
  const sentinel = join(uploadRoot, "..", "sentinel-must-survive");
  writeFileSync(sentinel, "keep", "utf8");
  await uploads.forgetSession("../escape");
  check("an unusable session id removes nothing outside the root", existsSync(sentinel), true);

  await uploads.forgetSession("s_one");
  check("forgetting a session takes its directory", existsSync(join(uploadRoot, "s_one")), false);
  check("and its rows", index.countFor("s_one"), 0);
  await uploads.shutdown();
}

/* ------------------------------------------------------------------ *
 * A prompt event that carries files
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat an attachment costs an event\n");
{
  const refs = Array.from({ length: 10 }, (_, i) => ({
    uploadId: `u_${"x".repeat(60)}${i}`,
    name: "n".repeat(200),
    mime: "m".repeat(128),
    bytes: 1234,
    inlined: false,
  }));
  const bare = { type: "prompt", text: "hi", attachments: null } as const;
  const laden = { type: "prompt" as const, text: "hi", attachments: refs };

  check("an attachment is accounted rather than ignored", estimateBytes(laden) > estimateBytes(bare), true);
  // The arithmetic written into the comment on `attachmentBytes`, asserted: the
  // worst legal case has to sit well under the per-event cap.
  check("and ten maximal ones stay far under the per-event cap", estimateBytes(laden) < 128 * 1024, true);

  const long = { type: "prompt" as const, text: "y".repeat(200 * 1024), attachments: refs };
  const cut = truncateEvent(long, 128 * 1024) as typeof long;
  // Untouched, for the reason `parentToolCallId` is: a clipped attachment is not
  // a smaller attachment, it is a reference to a file that cannot be found.
  check("every attachment survives truncation byte for byte", cut.attachments, refs);
  check("the text is what gets clipped", cut.text.length < long.text.length, true);
  /*
   * The assertion that catches the boundary bug rather than the obvious one.
   *
   * Clipping the text to the *full* budget leaves an event whose attachments push
   * it back over, and comparing only the text length passes with that bug present.
   */
  check("and the result really is under the cap", estimateBytes(cut) <= 128 * 1024, true);
}

/* ------------------------------------------------------------------ *
 * Serving a file, and refusing to
 * ------------------------------------------------------------------ */

process.stdout.write("\nserving one file out of a session\n");
{
  const raw = async (path: string): Promise<Response> =>
    app.fetch(new Request(`http://d${path}`, { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }));

  // The pair the loop above could not carry, and the positive control is the half
  // that matters: a "404 for an unknown id" assertion alone stays green for a
  // route that 404s for everybody, which is exactly how `stream` once did.
  check("an unknown id is 404 here too", (await raw("/sessions/s_nope/files?path=notes.txt")).status, 404);

  const ok = await raw("/sessions/s_one/files?path=notes.txt");
  check("a real file is served", ok.status, 200);
  check("and its bytes are its bytes", await ok.text(), "hi\n");
  /*
   * The four headers, and they are the security of this route rather than
   * decoration.
   *
   * The reason used to be the credential in the URL — `readCredential` took
   * `?token=` anywhere, so a download opened in a tab carried a live daemon token
   * in `location.search` for script in a rendered response to read. That door is
   * shut (see "`?token=` is the handshake's exception" above, which asserts it),
   * and these headers are not one bit less load-bearing for it: this route serves
   * **any regular file under a session's workspace**, so a rendered HTML or SVG
   * response executes on the daemon's own origin, where it reaches every route
   * with whatever credential the page embedding it holds — and a `blob:` made
   * from it inherits that origin.
   */
  check("never a type a browser will render", ok.headers.get("content-type"), "application/octet-stream");
  check("always a save", ok.headers.get("content-disposition")?.startsWith("attachment;"), true);
  // Not redundant beside `attachment`: it also stops a proxy or a CDN in front of
  // this daemon re-typing the body into something renderable.
  check("nothing may re-sniff it", ok.headers.get("x-content-type-options"), "nosniff");
  // A private file, fetched under a bearer credential: a cacheable response is
  // that file sitting in a shared cache.
  check("and nothing may cache it", ok.headers.get("cache-control"), "no-store");

  /*
   * ⭐ **And it is never gzipped, which is a fifth header with the same standing.**
   *
   * `gzipResponses` runs on every route in this app, and the client refuses an
   * oversized file by reading `content-length` **before** the body is resident —
   * `Content-Length` being the one size header CORS exposes without
   * `Access-Control-Expose-Headers`. Compressed, that number would describe the
   * packed size, so the 100 MiB guard would silently measure the wrong quantity and
   * a file that does not fit would walk through it.
   *
   * What excludes it is `compressible`, keyed on the **content type** asserted three
   * lines up rather than on this path — a path test does the same job today and
   * fails open the day somebody adds a route that streams bytes. Driven on a 40 KiB
   * file, because a 3-byte one is under the threshold and would pass either way.
   */
  const big = await app.fetch(
    new Request("http://d/sessions/s_one/files?path=big.txt", {
      headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "accept-encoding": "gzip" },
    }),
  );
  check("a download a client would take gzipped is not gzipped", big.headers.get("content-encoding"), null);
  check("and its length is the file's own", big.headers.get("content-length"), String(40 * 1024));
  check("which is the number the client's own cap reads", (await big.arrayBuffer()).byteLength, 40 * 1024);

  const refusal = async (path: string): Promise<string> => {
    const answer = await raw(path);
    const body = (await answer.json()) as { error?: { code?: string; detail?: { reason?: string } } };
    return `${answer.status} ${body.error?.detail?.reason ?? body.error?.code ?? ""}`.trim();
  };

  // These prove the *route* uses `safeRelPath`, which is the only place it can be
  // proved: each `reason` is one of its own rejections.
  check("a path is required", (await raw("/sessions/s_one/files")).status, 400);
  check("climbing out is refused", await refusal("/sessions/s_one/files?path=../../etc/passwd"), "400 dot_segment");
  check("an absolute path is refused", await refusal("/sessions/s_one/files?path=/etc/passwd"), "400 absolute");
  // Serving `.git/config` would leak remote URLs and the credential helper.
  check("and so is the git directory", await refusal("/sessions/s_one/files?path=.git/config"), "400 git_dir");

  const root = join(users, "u_alice", "proj");
  mkdirSync(join(root, "sub"), { recursive: true });
  symlinkSync("/etc/passwd", join(root, "escape.txt"));
  // Refused by *shape*, never by where it points — the general form of the
  // `ln -s ~/.ssh/id_rsa x` measurement `changes.ts` records for the diff route.
  check("a symlink is not a regular file", await refusal("/sessions/s_one/files?path=escape.txt"), "404 not_a_regular_file");
  check("nor is a directory", await refusal("/sessions/s_one/files?path=sub"), "404 not_a_regular_file");
  check("nor is something that is not there", await refusal("/sessions/s_one/files?path=absent.txt"), "404 not_a_regular_file");

  /* ---- containment, in the two halves it is now answered in ---- */

  /*
   * **`safeRelPath` used to finish with two `realpathSync` calls, on
   * `<workspace.root>/<whatever the caller typed>`.**
   *
   * That is the one thing `stall.ts` exists to prevent, reached by a route nobody
   * had counted: for a `plain` session — which `s_one` is, and which every
   * session created without a worktree is — `workspace.root` *is* the `cwd` the
   * caller named, so a hard NFS mount underneath it took every session, every
   * socket and `/health` down at 0% CPU. `workspaceReady` could not save it: it
   * probes the root, which answers instantly, while the stall is one directory
   * further down. An agent reaches the same call with one `ln -s /mnt/nas nas`
   * inside its own worktree.
   *
   * So the string rules stayed synchronous and the filesystem question became
   * `probeContained`, bounded and remembered like every other caller-named path
   * here. The pair below is what says the move was a move: the syntactic half
   * **accepts** a symlink out of the tree, and the route still refuses it.
   */
  // Pointing at a real directory outside this session's tree, which is what makes
  // the parent resolve somewhere the containment rule has to reject.
  symlinkSync(uAbcd, join(root, "out"));
  /*
   * **The half-revert catcher, and the security property.** `safeRelPath` no
   * longer answers this, so a `requestedPath` that forgot to await
   * `probeContained` would serve the bytes of a file outside the workspace to
   * anyone holding a `session:read` token — with every other assertion in this
   * section still green.
   */
  check("a symlinked parent still cannot leave the tree", await refusal("/sessions/s_one/files?path=out/notes.txt"), "400 escapes_tree");
  // And the same input, syntactically. This one is the direct revert catcher: put
  // the `realpathSync` pair back and it answers `escapes_tree` here instead.
  check("while the string rules alone accept it, having stopped asking the disk", safeRelPath(root, "out/notes.txt").ok, true);
  check(
    "and still refuse everything that is genuinely about the string",
    ["../x", "/x", ".git/x", "a\u0000b", "a\\b", ""].map((input) => safeRelPath(root, input).ok),
    [false, false, false, false, false, false],
  );

  /*
   * The filesystem half on its own, with **"could not tell" as a real third
   * answer** — the same shape `probeExists` and `Liveness` already carry, and for
   * the same reason: a file on a sleeping mount is not a file outside the tree.
   *
   * Two of these are deliberately *not* refusals. The **parent** is resolved and
   * never the leaf, because a symlink whose target is outside the tree is a
   * legitimate changed file that git tracks as a link; and a path that resolves
   * to nothing at all is `true`, because "not there" is not a traversal and the
   * caller has a better word for it — `path_not_changed` for the diff route,
   * `not_a_regular_file` for this one, both asserted above.
   */
  forgetStalled();
  const under = (rel: string): string => join(root, rel);
  check("a path inside the tree is contained", await probeContained(root, under("notes.txt")), true);
  check("one whose parent resolves out of it is not", await probeContained(root, under("out/notes.txt")), false);
  check("one that is simply not there is, because that is not a traversal", await probeContained(root, under("nowhere/x.txt")), true);
  /*
   * The third answer, forced with a deadline that has already passed — the same
   * seam every other probe in this file uses, because a genuinely stalled mount
   * is the one thing a driver cannot synthesize. `requestedPath` turns this into
   * `503 path_unresponsive`; that route arm is *not* reachable offline, because
   * `workspaceReady` probes the root first and answers its own 503, so producing
   * it needs a root that answers with a stall underneath it — and the memory that
   * makes a stall observable here clears itself the moment the abandoned probe
   * settles, which happens during `workspaceReady`'s own `stat`.
   */
  check("and a deadline that has passed is neither", await probeContained(root, under("notes.txt"), { probeTimeoutMs: 0 }), null);
  forgetStalled();

  /*
   * ⚠ **The `.git` refusal was purely syntactic, and one symlink walked past
   * it.** `safeRelPath` reads the segments the caller *typed*, and its own
   * comment gives the reason as a security rule — `.git/config` carries remote
   * URLs and the credential helper configuration. With `g -> .git` inside the
   * tree, `?path=g/config` contains no `.git` segment to refuse, and containment
   * genuinely holds, because `.git` really is inside the workspace. Both checks
   * passed and the bytes went out to a read-only grant.
   *
   * The link is the shape that actually occurs: git's hardening covers writing
   * *through* such a link, not its existence, so one survives a clone — and an
   * agent makes one with a single `ln -s`.
   *
   * Asserted on the resolved answer rather than on the route alone, so the rule
   * is pinned where it is decided.
   */
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[remote]\n  url = git@github.com:someone/private.git\n");
  symlinkSync(join(root, ".git"), join(root, "g"));
  forgetStalled();
  check("a path the caller spells with .git is refused syntactically", safeRelPath(root, ".git/config").ok, false);
  check(
    "and one that reaches the same directory through a link is refused too",
    await probeRequestable(root, under("g/config")),
    "git_dir",
  );
  check("while an ordinary file beside it still resolves", await probeRequestable(root, under("notes.txt")), "ok");
  /*
   * The root's *own* absolute path is not the caller's doing, so a workspace that
   * legitimately lives under a directory called `.git` — a backup tree, a
   * fixture — must not be unservable in its entirety. Only the part below the
   * root is examined, and this is what says so.
   */
  {
    const oddRoot = tmp("gitnamed-");
    const nested = join(oddRoot, ".git", "workspace");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "notes.txt"), "ordinary\n");
    check(
      "a workspace whose own path contains .git is still servable",
      await probeRequestable(nested, join(nested, "notes.txt")),
      "ok",
    );
  }
  forgetStalled();

  /*
   * Text is required only when nothing came with it.
   *
   * The route used to validate `text` *before* it had looked at `attachments`,
   * which made a message that is only a screenshot impossible — an ordinary thing
   * to send. Both refusals are asserted, because relaxing one is how the other
   * gets relaxed by accident.
   */
  const prompted = async (body: unknown): Promise<string> => {
    const answer = await app.fetch(
      new Request("http://d/sessions/s_one/prompt", {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const parsed = (await answer.json()) as { error?: { code?: string; message?: string } };
    return `${answer.status} ${parsed.error?.code ?? "ok"}`;
  };
  // Still refused: an empty prompt with nothing attached is a mis-tap, and
  // answering it would start a turn about nothing.
  check("an empty prompt with no files is refused", await prompted({ text: "   " }), "400 bad_request");
  check("and a missing text is still a type error", await prompted({ attachments: [] }), "400 bad_request");
  /*
   * Empty text *with* an attachment gets past the text guard and is refused
   * later, by the upload store this driver does not have. That is the assertion:
   * `503 uploads_unavailable` proves the text check no longer fires, which a
   * `400` would not distinguish from the old behaviour.
   */
  check("but an empty prompt carrying a file gets past it", await prompted({ text: "", attachments: ["u_x"] }), "503 uploads_unavailable");

  // This driver builds the app with no upload store, so the routes that need one
  // say so rather than pretending. Same shape as `credentials` and `logins`.
  check("with no upload store, staged files are unavailable", await refusal("/sessions/s_one/uploads/u_x"), "503 uploads_unavailable");
  const staged = await app.fetch(
    new Request("http://d/sessions/s_one/uploads?name=a.txt", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "text/plain" },
      body: "hello",
    }),
  );
  check("and staging one is too", staged.status, 503);
}

/*
 * Which sessions come back by themselves, and how a status is derived.
 *
 * Pure and offline: this is the rule the whole feature turns on — "a session is
 * stopped only if a human stopped it" — and the two ways to get it wrong are
 * both silent. Widen it and a session somebody deliberately killed is handed a
 * fresh agent on the next deploy; narrow it and a conversation quietly does not
 * come back, which nobody notices until they go looking for it.
 */
process.stdout.write("\nwhich sessions the daemon brings back\n");
{
  const exitOf = (reason: ExitReason): SessionExit => ({
    reason,
    at: now,
    detail: null,
    agentHandle: null,
    agentConfirmedDead: true,
  });
  const boot = (reason: ExitReason): boolean => autoResumable(exitOf(reason), "a_1", "boot");
  const typed = (reason: ExitReason): boolean => autoResumable(exitOf(reason), "a_1", "prompt");

  // The whole table, both triggers. Exhaustiveness needs no assertion here — the
  // `switch` has no `default` arm, so a new `ExitReason` is a compile error.
  check("a graceful restart comes back at boot", boot("daemon_shutdown"), true);
  check("and so does a crash", boot("daemon_restarted"), true);
  /*
   * ⚠ **Stopped: never at boot, and now yes on a prompt.** The `false` on both
   * triggers was how the daemon avoided overruling a person — and a prompt is not
   * the daemon deciding anything, it is that person typing into the conversation.
   * What forced it is the composer becoming unconditional: a box that answers
   * `409 session_terminal` is worse than no box.
   */
  check("a session somebody stopped never comes back on its own", boot("stopped"), false);
  check("but typing into it starts it again", typed("stopped"), true);
  check("nor does one that never started", [boot("start_failed"), boot("start_timeout")], [false, false]);
  /*
   * `agent_kill_failed` is legacy and stays out, and this line is the guard
   * against somebody "fixing" it: it used to *replace* the caller's reason
   * whenever a kill went unconfirmed, so a row carrying it may be a user's Stop
   * wearing a different word — and `agentConfirmedDead: false` means the old
   * agent may still be holding the conversation file.
   */
  check("nor an ambiguous legacy kill", [boot("agent_kill_failed"), typed("agent_kill_failed")], [false, false]);
  /*
   * The one asymmetry, and the reason it exists: an agent that quit on its own
   * under a daemon that never went anywhere was not ended *by* the daemon. The
   * boot pass has no recency fence, so resuming it would hand a fresh process to
   * a conversation whose owner watched it die three days ago. A prompt is
   * somebody explicitly asking, and "it crashed, let me carry on" should work.
   */
  check("an agent that quit on its own waits to be asked", [boot("agent_exited"), typed("agent_exited")], [false, true]);
  /*
   * ⚠ **The second asymmetry, and it is a reversal.** `agent_signed_out` answered
   * `false` on both triggers, and that made the state unreachable from inside the
   * app: `reloadCredentials` is the only other reversal and every one of its
   * callers is an in-app credential write, so a CLI that refreshed its own token —
   * or somebody signing in from their own terminal — was left with a conversation
   * nothing could bring back, under a notice claiming they were signed out.
   *
   * It follows `agent_exited`'s split for `agent_exited`'s reason. A prompt is a
   * person asking for *this* conversation now, and by then the credential
   * situation may be anything at all; a boot pass is nobody asking, and starting
   * an agent that cannot authenticate at 4am is how a fleet spends a morning on
   * it. What a revoked credential now costs is one error row per message somebody
   * chooses to send — see `onAuthFailure`, which no longer ends anything.
   */
  check("a signed-out conversation waits to be asked too", [boot("agent_signed_out"), typed("agent_signed_out")], [false, true]);
  // No conversation to return to means nothing to return to it with, whatever
  // the reason says.
  check(
    "and nothing resumes without an agent session id",
    (["daemon_shutdown", "daemon_restarted", "agent_exited"] as ExitReason[]).map((reason) =>
      autoResumable(exitOf(reason), null, "prompt"),
    ),
    [false, false, false],
  );

  const statusOf = (reason: ExitReason): string => {
    const store = storeOf([
      { ...rowFor(`s_${reason}`, join(users, "u_alice", "proj")), exit: exitOf(reason), agentSessionId: "a_1" },
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store);
    own.restore({ reapOrphans: false });
    return own.get(`s_${reason}`)?.status ?? "missing";
  };

  /*
   * `daemon_shutdown` derives `interrupted`, and that is the correction this
   * whole change rests on. It used to derive `exited` — the *same value* as a
   * user's Stop — so the ordinary deploy, much the commonest way a session is
   * interrupted, was indistinguishable from somebody ending it on purpose, while
   * `interrupted` was reachable only through the hard-kill path.
   *
   * Both are pinned, so a future edit cannot swap them and stay green.
   */
  check("a graceful shutdown reads as interrupted", statusOf("daemon_shutdown"), "interrupted");
  check("and so does a crash", statusOf("daemon_restarted"), "interrupted");
  check("a stop reads as exited", statusOf("stopped"), "exited");
  check("an agent quitting reads as exited", statusOf("agent_exited"), "exited");
  check("a failed start reads as failed", [statusOf("start_failed"), statusOf("start_timeout")], ["failed", "failed"]);

  // Full jitter — drawn from `[0, capped)` — and not the ±20% band the relay
  // uses. A boot pass retries N sessions whose attempts began together, so a
  // narrow band keeps them synchronised and they collide again every round.
  check("no jitter means no wait at all", [1, 2, 5].map((n) => resumeBackoffMs(n, () => 0)), [0, 0, 0]);
  check(
    "and the ceiling grows then clamps",
    [1, 2, 3, 4, 5, 6, 9].map((n) => resumeBackoffMs(n, () => 0.999999)),
    [1999, 3999, 7999, 15999, 31999, 59999, 59999],
  );
}

/*
 * The boot pass, against a fake agent that really answers `session/resume`.
 *
 * The assertion that carries this section is not "the status changed" — it is
 * that the agent was sent `session/resume` with the id and cwd it was supposed
 * to get. A resume that silently sent `session/new` would leave the session
 * `idle` with a fresh, empty conversation, which is indistinguishable from
 * success at every level above this one and is the exact failure the whole
 * feature exists to avoid.
 */
process.stdout.write("\nputting agents back on interrupted sessions\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  interface Rig {
    runtime: LocalRuntime;
    launches: () => number;
    resumes: () => { sessionId: string; cwd: string; mcpServers: unknown }[];
    fileIoAtResume: () => boolean[];
    peak: () => number;
    /**
     * How many of this rig's agents have been shut down.
     *
     * `endStdin` rather than `kill`, because that is the first rung of
     * `AcpClient.doClose`'s ladder and this stub's `waitForExit` answers `true`,
     * so a signal is never reached — which is what makes the count readable at
     * all. It exists for one case: an agent that is *never* disposed is an
     * orphan, and an orphan is invisible from every other observable this rig
     * has.
     */
    disposed: () => number;
  }

  /**
   * A runtime whose agent is a pair of pipes, made fresh per launch.
   *
   * Fresh per launch because a `PassThrough` that has been ended is spent — the
   * older cases in this file work around it by declaring a second fake agent by
   * hand, which does not scale to a pass that starts one per session.
   */
  const rigWith = (options: {
    resume: boolean;
    failResume?: boolean;
    /** Answer `session/resume` with JSON-RPC -32002, as claude does for a lost conversation. */
    forgotten?: boolean;
    /**
     * Refuse `session/resume` with -32603 *only* while the client declares the
     * file-IO capability — kimi 0.29.2's behaviour for a session left in plan
     * mode, measured 2026-08-05.
     */
    hatesFileIo?: boolean;
    stallMs?: number;
  }): Rig => {
    let launched = 0;
    let opened = 0;
    let live = 0;
    let peak = 0;
    let ended = 0;
    let declaredFileIo = false;
    const fileIoAtResume: boolean[] = [];
    const resumes: { sessionId: string; cwd: string; mcpServers: unknown }[] = [];

    class ResumeRig extends LocalRuntime {
      override describe(agent: AgentId): AgentLaunchConfig {
        return stubAgentConfig(agent);
      }

      override async launch(): Promise<AgentProcess> {
        launched += 1;
        const toAgent = new PassThrough();
        const toClient = new PassThrough();
        const send = (message: unknown): void => {
          toClient.write(`${JSON.stringify(message)}\n`);
        };
        let buffer = "";
        toAgent.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.trim().length === 0) continue;
            const message = JSON.parse(line) as Record<string, any>;
            const id = message["id"];
            switch (message["method"]) {
              case acp.methods.agent.initialize:
                declaredFileIo =
                  (message["params"] as any)?.clientCapabilities?.fs?.readTextFile === true;
                send({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    protocolVersion: acp.PROTOCOL_VERSION,
                    // The capability is a marker object, exactly as both real
                    // adapters send it — `supportsSessionResume` reads `!= null`
                    // rather than `=== true` for that reason.
                    agentCapabilities: options.resume ? { sessionCapabilities: { resume: {} } } : {},
                    authMethods: [],
                  },
                });
                break;
              // Needed by the recovery path — a cleared conversation the agent
              // never wrote down is replaced with a fresh one, and that goes
              // through `session/new` rather than `session/resume`.
              case acp.methods.agent.session.new:
                opened += 1;
                send({ jsonrpc: "2.0", id, result: { sessionId: `conv_${opened}` } });
                break;
              case acp.methods.agent.session.resume: {
                const params = message["params"] as Record<string, any>;
                fileIoAtResume.push(declaredFileIo);
                resumes.push({
                  sessionId: String(params["sessionId"]),
                  cwd: String(params["cwd"]),
                  mcpServers: params["mcpServers"],
                });
                live += 1;
                peak = Math.max(peak, live);
                // A real handshake is not instantaneous, and without a gap here
                // every resume would complete before the next began — which
                // would make the concurrency bound below unfalsifiable.
                setTimeout(() => {
                  live -= 1;
                  if (options.hatesFileIo === true && declaredFileIo) {
                    send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
                  } else if (options.forgotten === true) {
                    // Byte-for-byte what `RequestError.resourceNotFound` produces.
                    send({
                      jsonrpc: "2.0",
                      id,
                      error: { code: -32002, message: `Resource not found: ${String(params["sessionId"])}` },
                    });
                  } else if (options.failResume === true) {
                    send({ jsonrpc: "2.0", id, error: { code: -32000, message: "no such conversation" } });
                  } else {
                    send({ jsonrpc: "2.0", id, result: {} });
                  }
                }, options.stallMs ?? 15);
                break;
              }
              case acp.methods.agent.session.prompt:
                send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
                break;
              default:
                if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
            }
          }
        });
        return {
          stdin: toAgent,
          stdout: toClient,
          stderr: new PassThrough(),
          handle: null,
          onceStartError: () => () => {},
          onceExit: () => () => {},
          hasExited: false,
          waitForExit: async () => true,
          endStdin: () => {
            ended += 1;
            toAgent.end();
          },
          kill: async () => {},
        } as unknown as AgentProcess;
      }
    }

    return {
      runtime: new ResumeRig(),
      launches: () => launched,
      resumes: () => resumes,
      fileIoAtResume: () => fileIoAtResume,
      peak: () => peak,
      disposed: () => ended,
    };
  };

  const interruptedRow = (id: string, reason: ExitReason, agentSessionId: string | null, create = true) => {
    const root = join(users, "u_alice", `wt_${id}`);
    const row = create
      ? rowFor(id, root)
      : { ...rowFor(id, join(users, "u_alice", "proj")), workspace: { ...rowFor(id, join(users, "u_alice", "proj")).workspace, root: join(users, "u_alice", "gone_forever"), requestedCwd: join(users, "u_alice", "gone_forever") } };
    return {
      ...row,
      agentSessionId,
      // One turn, because that is what a session with a conversation *has*.
      // Zero would say the agent never ran anything, which is now a fact the
      // resume path reads: an untouched conversation has no transcript on disk,
      // so it is opened fresh rather than resumed. A fixture claiming both an
      // agent session id and no turns describes a session that cannot exist.
      turnCounter: 1,
      exit: { reason, at: now, detail: null, agentHandle: null, agentConfirmedDead: true },
    };
  };

  // No wall clock anywhere in the pass: `random` pins the jitter and `delay`
  // makes the backoff free, so these run at the speed of the pipes.
  const options = { random: () => 0, delay: async (): Promise<void> => {} };

  {
    const rig = rigWith({ resume: true });
    const store = storeOf([
      // Three turns already spent, so "numbering continues" below is a claim
      // with something to be wrong about.
      { ...interruptedRow("s_back", "daemon_restarted", "a_back"), turnCounter: 3 },
      interruptedRow("s_stopped", "stopped", "a_stopped"),
      interruptedRow("s_noid", "daemon_shutdown", null),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    const back = own.get("s_back");
    check("an interrupted session comes back idle", back?.status, "idle");
    check("with its exit cleared", back?.exit, null);
    check("and the agent's own id untouched", back?.agentSessionId, "a_back");
    check("a stopped one is left alone", own.get("s_stopped")?.status, "exited");
    check("and one with nothing to reattach to is not even considered", own.get("s_noid")?.status, "interrupted");
    check("the report counts what it did", [report.considered, report.resumed], [1, 0 + 1]);

    /*
     * The load-bearing assertion of this whole file's new section. `session/new`
     * would leave the session `idle` too, with an empty conversation and no way
     * to tell from the outside.
     */
    check("the agent was actually asked to resume", rig.resumes().length, 1);
    check(
      "with the id and cwd it was supposed to get",
      rig.resumes()[0],
      { sessionId: "a_back", cwd: back?.cwd, mcpServers: [] },
    );

    /*
     * Turn numbering continues from the persisted counter rather than starting
     * again. A resume that reset it would make "turn 4" mean the fourth turn
     * since the last crash instead of the fourth of the conversation — which is
     * wrong in a way nobody would notice until they were reading a transcript
     * trying to work out what happened.
     */
    const promptResult = back?.prompt("hello");
    check(
      "a prompt after a resume continues the turn count",
      promptResult?.kind === "accepted" ? promptResult.turn : promptResult?.kind,
      4,
    );
    await own.shutdown();
  }

  /*
   * What bounds session creation, which used to be nothing at all.
   *
   * `create()` resolved a cwd, ran a real `git worktree add` and spawned an
   * agent, once per request, unbounded. The only thing counting sessions was
   * `SqliteSessionStore.prune`, and that counts in order to **delete**: it keeps
   * the newest `maxSessions` and takes every other transcript with it at the next
   * boot. So a loop of `POST /sessions` on a shared machine was a way to destroy
   * the owner's conversations, and `sqlite.ts`'s own comment beside the cap had
   * written the precondition down — "with one person there is nobody to take it
   * from" — which a grant makes false.
   *
   * Driven here rather than through the route because the rig is what makes a
   * *live* session reachable in an offline driver: `autoResume` clears the exit
   * record, which is exactly what `terminal` reads.
   */
  {
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_live", "daemon_restarted", "a_live")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });

    check("a restored session is not live until it is resumed", own.liveSessionCount, 0);
    await own.autoResume({ ...options, concurrency: 1 });
    check("and is live once an agent is back in front of it", own.liveSessionCount, 1);

    const refusal = async (cwd: string): Promise<string> =>
      own.create({ agent: "kimi", cwd }).then(
        () => "created",
        (error: unknown) => (error instanceof SessionLimitError ? error.reason : (error as Error).name),
      );

    /*
     * **The ordering is the assertion.** The cwd below does not exist, so
     * `resolveCwd` would throw `PathError` — and it must never get the chance.
     * A refusal that reaches the filesystem first is one that spends a bounded
     * probe and a libuv threadpool slot per request, on the one path a caller can
     * aim at a stalled network mount.
     */
    const gone = join(users, "u_alice", "no_such_dir_at_all");
    own.setSessionLimits({ live: 1 });
    check("a daemon at its live ceiling refuses before it touches the path", await refusal(gone), "too_many_sessions");

    /*
     * Raising it lets the same request through to the ordinary failure, which is
     * what says the guard above refused for the reason it claimed rather than
     * because everything here fails.
     */
    own.setSessionLimits({ live: 8 });
    check("and with room it reaches the path check as before", await refusal(gone), "PathError");

    /*
     * The other half, and it is needed: stopping a session makes it non-live, so
     * a create-and-stop loop walks straight past a ceiling while still writing
     * the rows the prune deletes. A refused create **does** spend a slot, which
     * is the deliberate trade — the alternative is doing the expensive part
     * before deciding whether to.
     */
    own.setSessionLimits({ burst: 2, refillMs: 600_000 });
    check("the first creation inside the burst is only refused by the path", await refusal(gone), "PathError");
    check("and so is the second", await refusal(gone), "PathError");
    check("the third is rate limited", await refusal(gone), "session_rate_limited");

    const waited = await own.create({ agent: "kimi", cwd: gone }).then(
      () => -1,
      (error: unknown) => (error instanceof SessionLimitError ? error.retryAfterSeconds : -1),
    );
    report("and says how long to wait", waited > 0 && waited <= 600, `retryAfterSeconds: ${waited}`);

    /*
     * The bucket refills by elapsed time rather than on a timer, so a short
     * refill is the whole of what a driver needs — no clock seam, no wall time
     * spent, and the arithmetic is the one that runs in production.
     */
    own.setSessionLimits({ burst: 1, refillMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    check("a slot comes back on its own", await refusal(gone), "PathError");

    await own.shutdown();
  }

  {
    // An agent that cannot reattach at all. Two sessions on it, so the per-agent
    // memo has something to prove: the second must cost no spawn.
    const rig = rigWith({ resume: false });
    const store = storeOf([
      interruptedRow("s_u1", "daemon_restarted", "a_u1"),
      interruptedRow("s_u2", "daemon_restarted", "a_u2"),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    const one = own.get("s_u1");
    check("an agent that cannot resume leaves the session interrupted", one?.status, "interrupted");
    // The `previousExit` restore, reached through the automatic door. Letting
    // `onStartFailed`'s `start_failed` stand would rewrite the reason out of
    // existence and with it every chance of ever bringing the session back.
    check("with its original reason intact", one?.exit?.reason, "daemon_restarted");
    check("and it says so on the snapshot", one?.snapshot().resume?.state, "failed");
    check("both are skipped", report.skipped, 2);
    // One spawn, not two: the capability can only be read *after* an agent has
    // started, so the first is unavoidable and every one after it is not.
    check("but only one agent was ever started", rig.launches(), 1);
    await own.shutdown();
  }

  {
    // An agent that starts and then refuses the resume itself.
    const rig = rigWith({ resume: true, failResume: true });
    const store = storeOf([interruptedRow("s_fail", "daemon_shutdown", "a_fail")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1, maxAttempts: 2 });

    const failed = own.get("s_fail");
    check("a refused resume leaves the reason alone", failed?.exit?.reason, "daemon_shutdown");
    check("and the status with it", failed?.status, "interrupted");
    check("the budget is spent, not looped", [rig.resumes().length, report.failed], [2, 1]);
    // Exactly one, on the last attempt. A per-attempt event would spend the
    // operator's own first prompt to say the same thing three times, in a log
    // that evicts a prefix.
    const written = failed?.log.read(0, 1000, 1024 * 1024) ?? [];
    check(
      "and says so once rather than per attempt",
      written.filter((stored) => stored.event.type === "error").length,
      1,
    );
    /*
     * And leaves no status churn at all.
     *
     * Each attempt used to append three — `starting`, a momentary `failed` that
     * is a lie about the session, and `interrupted` as the original exit went
     * back — describing a round trip that ended where it began. Nine dead
     * sessions on a real machine had their transcripts filled with the machinery
     * of their own failed revival, in a log that evicts a prefix and therefore
     * pays for it with the operator's own first prompt.
     */
    check(
      "and writes no status churn for attempts nobody asked for",
      written.filter((stored) => stored.event.type === "status").length,
      0,
    );
    await own.shutdown();
  }

  {
    /*
     * The agent starts, and says it no longer holds the conversation.
     *
     * Measured in production 2026-08-04 on ten sessions at once — transcripts
     * that did not survive the move off containers — where it cost three spawns
     * each on *every* restart. Both halves of the fix are pinned here: one
     * attempt rather than three, and a verdict that outlives the daemon.
     */
    const rig = rigWith({ resume: true, forgotten: true });
    // A store that actually writes back, unlike `storeOf` — persistence is the
    // property under test, so a stub that discards `put` would assert nothing.
    const saved = new Map<string, PersistedSession>();
    const store: SessionStore = {
      put: (row) => void saved.set(row.id, row),
      list: () => [...saved.values()],
      remove: (id) => void saved.delete(id),
    };
    saved.set("s_lost", interruptedRow("s_lost", "daemon_restarted", "a_lost"));

    const first = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    first.restore({ reapOrphans: false });
    const report = await first.autoResume({ ...options, concurrency: 1, maxAttempts: 3 });

    const lost = first.get("s_lost");
    check("a forgotten conversation is not a failure to retry", rig.resumes().length, 1);
    check("so the budget is untouched", [report.skipped, report.failed], [1, 0]);
    check("the session keeps its original reason", lost?.exit?.reason, "daemon_restarted");
    check("and says why nobody is coming", lost?.snapshot().resume?.error?.code, "agent_forgot_session");
    await first.shutdown();

    /*
     * The restart. A second registry over the same rows is exactly what the next
     * boot does, and the assertion is that it spawns **nothing** — the one place
     * this codebase persists a retry verdict, because it is a fact about the
     * agent's disk rather than about an attempt of ours.
     */
    const spawnsBefore = rig.launches();
    const second = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    second.restore({ reapOrphans: false });
    const after = await second.autoResume({ ...options, concurrency: 1 });
    check("a restart does not try again", rig.launches() - spawnsBefore, 0);
    check("and does not even consider it", after.considered, 0);
    check("the verdict was on disk, not in memory", saved.get("s_lost")?.resumeGaveUp, "forgotten");
    await second.shutdown();
  }

  {
    /*
     * An agent that refuses to resume while the file-IO capability is declared.
     *
     * Measured 2026-08-05 against kimi 0.29.2, deterministically: a session left
     * in plan mode answers `session/resume` with `-32603` when the client
     * declares `clientCapabilities.fs`, and resumes perfectly without it.
     * Leaving plan mode first cures it — so this is "somebody ended their day in
     * plan mode", not a corner.
     *
     * The retry uses the seam this codebase already keeps rather than a new one:
     * `fileIo` exists so the capability *can* be declined, and the cost was
     * measured long before this — with it, kimi made five reverse-RPC calls and
     * claude none; without it, neither made any.
     */
    const rig = rigWith({ resume: true, hatesFileIo: true });
    const store = storeOf([interruptedRow("s_fio", "daemon_restarted", "a_fio")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a session refused with the capability still comes back", report.resumed, 1);
    check("and is idle rather than stranded", own.get("s_fio")?.status, "idle");
    // Two attempts, in this order: the capability is declared first because it is
    // what the daemon wants, and dropped only after the agent has refused it.
    check("having been asked twice, with then without", rig.fileIoAtResume(), [true, false]);
    // One retry, not a loop: the second failure would be a real one.
    check("and no retry budget was spent on it", own.get("s_fio")?.resumeAttemptCount, 0);
    await own.shutdown();
  }

  {
    /*
     * A cleared conversation the agent never wrote down is recreated, not mourned.
     *
     * `clearContext` mints an empty conversation and claude writes the transcript
     * with the **first turn**, so a restart landing between the clear and the
     * next message finds an id naming nothing. Measured the hard way in
     * production: the session came back `resourceNotFound` and could not be
     * resumed at all — a worse outcome than the bug the clear interception was
     * built to fix.
     *
     * Opening another empty conversation is identical rather than approximate:
     * there was nothing in the old one, and empty is what clearing asked for.
     */
    const rig = rigWith({ resume: true, forgotten: true });
    const store = storeOf([interruptedRow("s_clr", "daemon_restarted", "a_clr")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    own.get("s_clr")?.log.append({
      type: "context_cleared",
      agentSessionId: "a_clr",
      previousAgentSessionId: "a_older",
    });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a cleared-and-unused conversation is recreated", report.resumed, 1);
    check("the session is idle rather than stranded", own.get("s_clr")?.status, "idle");
    /*
     * And the doomed resume is never attempted — one agent spawn, not two.
     *
     * The point of deciding up front rather than recovering in a catch. We
     * already know the conversation is empty, so asking the agent to restore it
     * can only fail, and the failure would cost a process and a line in the log.
     */
    check("without asking the agent to resume what is not there", rig.resumes().length, 0);
    check("and one agent started, not two", rig.launches(), 1);
    // The id moved to the one the agent just handed us, which is the whole point:
    // a resume that stored the dead id would fail again on the next boot.
    check("on a conversation the agent gave us", own.get("s_clr")?.agentSessionId, "conv_1");

    /*
     * And again on the next restart, which is the case that actually broke.
     *
     * The first version of the gate compared the marker's `agentSessionId` to
     * the current one, so it worked exactly once: the recovery opens *another*
     * empty conversation and appends no marker for it, so the restart after that
     * found no record naming the new id and gave up — measured in production, on
     * the very session this was built for. Which id is current is not the
     * question; whether anything has been said since the clear is.
     */
    /*
     * A older clear with a whole conversation after it must not decide the
     * answer — only the last marker or prompt does.
     *
     * Measured wrong twice on the live session: first the gate compared ids and
     * worked once, then it returned on the first prompt following the first
     * marker and answered about a conversation two generations dead.
     */
    const clr = own.get("s_clr");
    clr?.log.append({ type: "prompt", text: "we talked about it", attachments: [] });
    clr?.log.append({ type: "context_cleared", agentSessionId: "a_newer", previousAgentSessionId: "conv_1" });

    own.get("s_clr")?.markInterrupted(true, null);
    const again = await own.autoResume({ ...options, concurrency: 1 });
    check("and again on the restart after that", again.resumed, 1);
    check("on yet another fresh conversation", own.get("s_clr")?.agentSessionId, "conv_2");
    check("still without a doomed resume", rig.resumes().length, 0);
    await own.shutdown();
  }

  {
    /*
     * A session created and never spoken to is empty for the *other* reason.
     *
     * Measured 2026-08-05, on a session made at 13:56 and left alone: it failed
     * to resume exactly the way a cleared one did, because claude writes a
     * transcript with the first **turn** and this conversation never had one.
     * The gate knew only "cleared" and stranded it.
     *
     * `turnCounter` is what says so — persisted on the row beside the agent
     * session id, so the two always describe the same life. Deliberately not "no
     * `prompt` in the log": an empty log is evidence of an empty log, not of an
     * empty conversation, and that version broke twenty-four other cases.
     */
    const rig = rigWith({ resume: true, forgotten: true });
    const store = storeOf([
      { ...interruptedRow("s_untouched", "daemon_restarted", "a_untouched"), turnCounter: 0 },
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a session nobody ever spoke to is opened fresh", report.resumed, 1);
    check("without asking the agent for a conversation that never existed", rig.resumes().length, 0);
    check("and it is usable rather than stranded", own.get("s_untouched")?.status, "idle");
    await own.shutdown();
  }

  {
    /*
     * And the guard, which matters more than the recovery above.
     *
     * Same lost conversation, but nothing says it was cleared — so it had
     * content, and that content is gone. Silently handing somebody a fresh agent
     * while they expect their history restored is the same class of quiet lie as
     * handing back what they asked to forget.
     */
    const rig = rigWith({ resume: true, forgotten: true });
    const store = storeOf([interruptedRow("s_lost3", "daemon_restarted", "a_lost3")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a lost conversation nobody cleared is not silently replaced", report.resumed, 0);
    check("it stays interrupted", own.get("s_lost3")?.status, "interrupted");
    check("and says why", own.get("s_lost3")?.snapshot().resume?.error?.code, "agent_forgot_session");
    // The verdict a previous life wrote must not veto a recovery this one knows
    // how to make — but here there is no recovery to make, so it stands.
    check("with the verdict standing", own.get("s_lost3")?.resumeAbandoned, "forgotten");
    await own.shutdown();
  }

  {
    // A worktree that is simply gone. The assertion is the *absence* of a spawn:
    // claude's adapter rejects a nonexistent cwd, so starting one to find that
    // out is a process spawned to learn something already known.
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_gone", "daemon_restarted", "a_gone", false)]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 1 });

    check("a missing workspace spawns nothing at all", rig.launches(), 0);
    check("and leaves the session interrupted", own.get("s_gone")?.status, "interrupted");
    check("marked as given up rather than pending", own.get("s_gone")?.snapshot().resume?.state, "failed");
    check("counted as skipped, not failed", [report.skipped, report.failed], [1, 0]);
    await own.shutdown();
  }

  {
    // Shutdown wins. Starting an agent the very next statement is going to kill
    // is the one outcome worse than not starting it.
    const rig = rigWith({ resume: true });
    const store = storeOf([interruptedRow("s_late", "daemon_restarted", "a_late")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    await own.shutdown();
    const report = await own.autoResume(options);
    check("a shutting-down daemon resumes nothing", [report.resumed, rig.launches()], [0, 0]);
  }

  {
    // The concurrency bound, which is the only thing standing between a deploy
    // and forty simultaneous agent processes on somebody's laptop.
    const rig = rigWith({ resume: true, stallMs: 25 });
    const store = storeOf(
      Array.from({ length: 6 }, (_unused, index) =>
        interruptedRow(`s_c${index}`, "daemon_restarted", `a_c${index}`),
      ),
    );
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const report = await own.autoResume({ ...options, concurrency: 2 });
    check("every session comes back", [report.considered, report.resumed], [6, 6]);
    check("and never more than two at once", rig.peak() <= 2, true);
    await own.shutdown();
  }

  {
    /*
     * The other door: a message to an interrupted session resumes it first.
     *
     * Through a real route, because the whole point is that the client sends the
     * request it always sent. Two assertions and they are a pair — the second is
     * what stops this from being "resume everything on any prompt".
     */
    const rig = rigWith({ resume: true });
    const store = storeOf([
      interruptedRow("s_typed", "daemon_shutdown", "a_typed"),
      interruptedRow("s_killed", "stopped", "a_killed"),
      // `create = false` points this row's workspace at a directory that was
      // never made — the fixture for "somebody deleted the folder".
      interruptedRow("s_gone", "daemon_shutdown", "a_gone", false),
    ]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const routed = createApp({
      registry: own,
      verifier,
      instanceId: "i_resume",
      startedAt: now,
      credentials,
      roots: [users],
      logins: new AgentLoginRuns({ runtime: own.sessionRuntime, onWarning: () => {} }),
    }).app;

    const say = async (id: string): Promise<number> => {
      const response = await routed.fetch(
        new Request(`http://d/sessions/${id}/prompt`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
          body: JSON.stringify({ text: "carry on" }),
        }),
      );
      return response.status;
    };

    /*
     * ⚠ **A prompt is refused when the workspace is gone, and it is checked on
     * every message rather than only before a resume.**
     *
     * The guard sat inside the resume branch, so a session whose folder vanished
     * *while it was open* kept a live agent standing in a directory that no
     * longer existed — and the first anybody heard was the agent's own
     * `Internal error: Path "…" does not exist`, in the transcript, with no
     * remedy on the screen. `409 workspace_missing` is a sentence the client
     * already draws.
     */
    check("a message to a session whose folder is gone is refused", await say("s_gone"), 409);

    check("a message to an interrupted session is accepted", await say("s_typed"), 202);
    check("because the daemon resumed it first", rig.resumes()[0]?.sessionId, "a_typed");
    /*
     * ⚠ **And a message to a stopped one is accepted too, which reverses this
     * pair.** It asserted `409` and "no agent was started for it", on the rule
     * that Stop must mean stopped — which it still does *for the daemon*: nothing
     * revives it on a boot pass, and `autoResumable` keeps answering `false` there.
     * What changed is that a prompt was never the daemon deciding anything. It is
     * the person who pressed Stop typing into that conversation again, and the
     * composer is now unconditional, so the alternative is a box whose only
     * possible answer is a refusal.
     */
    check("a message to a stopped one starts it again", await say("s_killed"), 202);
    check("because that one was resumed as well", rig.resumes().length, 2);
    await own.shutdown();
  }

  {
    /*
     * **A launch that came back late, after its session had moved on.**
     *
     * Nothing bounds `session/new` or `session/resume` end to end, so a launch
     * timing out at 45s and resolving at 48s is ordinary rather than exotic. Its
     * only guard was `startAbandoned`, and `armForStart()` clears that on the
     * very next resume — so the late agent arrived to find the flag already reset
     * by the retry, was adopted as `this.session`, and was overwritten by the
     * retry's own agent moments later. The displaced one is `detached`, holds the
     * session's worktree, is referenced by nothing (`doStop` awaits
     * `startPromise`, `shutdown` collects `session.agentHandle`) and survives this
     * daemon's exit — invisible to the next boot's reaper, because the pid
     * persisted for that session is the other agent's.
     *
     * The launch identifies itself to its own callbacks now, which is the same
     * `this.session !== session` check every other late notification in that class
     * already makes — and the decline **disposes** before assigning, because
     * adopting first is what let a superseded agent be the live one for the two
     * seconds until the real launch resolved.
     *
     * The whole case rests on ordering that this rig can produce and a real agent
     * cannot be asked for: a stall longer than the first launch's budget, so the
     * first resolves while the second is still in flight.
     */
    const rig = rigWith({ resume: true, stallMs: 150 });
    const store = storeOf([interruptedRow("s_late", "daemon_restarted", "a_late")]);
    const own = new SessionRegistry(new MemoryEventStore(), store, undefined, rig.runtime);
    own.restore({ reapOrphans: false });
    const managed = own.get("s_late");

    // A budget the handshake cannot meet. `doResume` puts the original exit back
    // on the way out, which is what leaves the session resumable for the retry.
    const timedOut = await managed
      ?.resume(20)
      .then(() => "(resumed)", (error: unknown) => (error instanceof Error ? error.name : String(error)));
    check("a launch that misses its budget is abandoned", timedOut, "StartTimeoutError");
    check("and its session is terminal again, as it was", managed?.terminal, true);
    check("with the reason it actually ended on, not the failed revival", managed?.exit?.reason, "daemon_restarted");

    // The retry, which re-arms the session and therefore clears `startAbandoned`
    // — the window the old guard could not see. It starts while the first launch
    // is still in flight and outlives it.
    await managed?.resume(5_000);
    check("the retry brings the session back", managed?.status, "idle");
    check("and two agents really were started", rig.launches(), 2);
    check("both of which reached the agent's resume", rig.resumes().length, 2);

    /*
     * **The load-bearing line.** One agent is live and the other has been shut
     * down, *before* anything has been stopped — so the count is the abandoned
     * launch's own dispose rather than a teardown. Adopt it instead and this
     * reads 0, with every assertion above still green and a live agent left
     * holding the worktree for the rest of the machine's uptime.
     */
    check("the abandoned launch's agent was disposed rather than orphaned", rig.disposed(), 1);

    await own.shutdown();
    // And the survivor is shut down exactly once by the shutdown, which is what
    // says the count above was not the adopted agent being disposed by mistake.
    check("and the live one goes with the daemon", rig.disposed(), 2);
  }
}

/*
 * Answering the agent, which is the interaction this whole product exists for
 * and the one nothing reached.
 *
 * Every route in this file could be exercised against a restored row because a
 * restored row is a *record*. A permission is not: it is a live `resolve`
 * closure held open across an HTTP request, so nothing short of a real agent
 * asking a real question could get near it. That is why it went uncovered, and
 * it is why the fake agent below **waits** — the turn does not end until the
 * answer comes back, so the assertions are about a session that is genuinely
 * blocked rather than one that once was.
 *
 * The statement order inside `settle` is the load-bearing part and it is
 * asserted through its only observable consequence: the agent gets the option id
 * a client chose. `pending.delete` is the compare-and-swap, and the agent is
 * unblocked *before* anything is logged — a throw while appending would
 * otherwise leave the request recorded as answered, gone from `pending`, and the
 * agent's RPC never responded to. That is a permanent hang which also switches
 * off `status: "blocked"`, the one signal that would have revealed it.
 */
/**
 * Answering a permission over HTTP, shared by the two blocks that do it.
 *
 * One helper rather than two near-identical closures: the block below and the
 * expired-id block after it built the same `Request`, the same bearer header and
 * the same response tail, differing only in which app and which session.
 *
 * **The parse is deliberately defensive**, for the same reason `waitingOn` exists
 * one screen down. Not every non-2xx this route can produce is JSON — an id that
 * is not a path segment leaves Hono matching no route and answering its own
 * plain-text `404 Not Found` — and a `JSON.parse` that throws here takes the
 * process down mid-run, deleting every later section's coverage instead of
 * failing one case. Measured, by writing exactly that bug and hitting it.
 */
const answerPermission = async (
  // Hono's own `fetch` is `Response | Promise<Response>`, and narrowing it here
  // to the promise alone is a type error at both call sites rather than at this
  // one — `await` copes with either.
  target: { fetch: (request: Request) => Response | Promise<Response> },
  sessionId: string,
  permissionId: string,
  body: unknown,
): Promise<{ status: number; body: any }> => {
  const response = await target.fetch(
    new Request(`http://d/sessions/${sessionId}/permissions/${permissionId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  if (text.length === 0) return { status: response.status, body: null };
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    // Reported as a value rather than thrown, so a case can assert on it.
    return { status: response.status, body: { nonJsonBody: text } };
  }
};

process.stdout.write("\nanswering a permission the agent is waiting on\n");
{
  // Only the SDK is loaded here. `LocalRuntime`, `SessionRegistry`,
  // `MemoryEventStore`, `PassThrough`, `tmp` and `join` are all imported at the
  // top of this file already, and re-importing them read as a deliberate
  // deferral of something that is not deferred.
  const acp = await import("@agentclientprotocol/sdk");

  /**
   * What the client sent back, in the agent's own words.
   *
   * Typed structurally rather than as `acp.RequestPermissionResponse`: `acp` is
   * a dynamic import here, so it is a value and not a namespace, and the only
   * field any assertion below reads is the one the agent was waiting for.
   */
  const answered: { outcome?: { outcome?: string; optionId?: string } }[] = [];

  /**
   * A fresh pipe pair per launch, because two sessions means two agents.
   *
   * One pair shared between them would put two `AcpClient`s on one stream and
   * cross their routing — the same reason `rigWith` builds its own per launch.
   *
   * Typed as `AgentProcess` rather than `any`, which is the whole reason
   * `src/runtime/types.ts` keeps that interface with one implementation: adding a
   * member to it has to fail `pnpm typecheck` *here*, in the driver that
   * substitutes its own runtime, or the seam is documented and unenforced.
   */
  let launches = 0;
  const spawnAgent = (): AgentProcess => {
    launches += 1;
    const mine = launches;
    const sessionId = `s_perm_${mine}`;
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);

    /** The prompt whose turn is being held open by an unanswered permission. */
    let heldPromptId: unknown = null;
    let askId = 9000;
    /** Which options the *next* request offers, so one agent can pose several. */
    let offer: { optionId: string; name: string; kind: string }[] = [];

    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];

        // A response rather than a call: this is the answer to the permission
        // this agent asked for, and the turn has been waiting on it.
        if (message["method"] === undefined && id !== undefined) {
          answered.push(message["result"]);
          if (heldPromptId !== null) {
            send({ jsonrpc: "2.0", id: heldPromptId, result: { stopReason: "end_turn" } });
            heldPromptId = null;
          }
          continue;
        }

        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new:
            send({ jsonrpc: "2.0", id, result: { sessionId } });
            break;
          case acp.methods.agent.session.prompt: {
            // The prompt text chooses the option set, so one agent can pose
            // several differently-shaped questions across several turns.
            const text = JSON.stringify(message["params"]?.["prompt"] ?? "");
            /*
             * The second agent never asks; it exists to be the row a cut has to
             * drop in favour of the blocked one.
             *
             * `run it` is the override, and it is the policy block's door in:
             * that block needs a *third* agent that does ask, and keying which
             * spawn asks purely on its ordinal made "which session number am I"
             * a hidden coupling between two sections of this file.
             */
            if (mine !== 1 && !text.includes("run it")) {
              send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
              break;
            }
            offer = text.includes("narrow")
              ? [{ optionId: "o_yes", name: "Yes", kind: "allow_once" }]
              : [
                  { optionId: "o_yes", name: "Yes", kind: "allow_once" },
                  { optionId: "o_always", name: "Always", kind: "allow_always" },
                  { optionId: "o_no", name: "No", kind: "reject_once" },
                  { optionId: "o_never", name: "Never", kind: "reject_always" },
                ];
            /*
             * The two shapes an agent can send that nothing used to bound, and
             * they are here rather than in a pure case because the whole defect
             * was that the *route from the wire to the snapshot* had no cap on
             * it. Asserting `clip` would have passed all along.
             */
            if (text.includes("shouting")) {
              offer = [{ optionId: "o_yes", name: "Y".repeat(4_000), kind: "allow_once" }];
            }
            if (text.includes("swarming")) {
              offer = Array.from({ length: 200 }, (_, i) => ({
                optionId: `o_${i}`,
                name: `Option ${i}`,
                kind: i === 0 ? "allow_once" : "reject_once",
              }));
            }
            heldPromptId = id;
            askId += 1;
            send({
              jsonrpc: "2.0",
              id: askId,
              method: acp.methods.client.session.requestPermission,
              params: {
                sessionId,
                toolCall: {
                  toolCallId: `tc_${mine}_${askId}`,
                  title: text.includes("shouting") ? "T".repeat(50_000) : "Terminal",
                  rawInput: { command: "rm -rf /" },
                  content: [{ type: "content", content: { type: "text", text: "Requesting approval to run it" } }],
                },
                options: offer,
              },
            });
            break;
          }
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });

    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    };
  };

  class PermissionRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnAgent();
    }
  }

  const permRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new PermissionRuntime());
  const { app: permApp } = createApp({
    registry: permRegistry,
    verifier,
    instanceId: "i_perm",
    startedAt: now,
    credentials,
    roots: [users],
  });

  const answer = (sessionId: string, permissionId: string, body: unknown) =>
    answerPermission(permApp, sessionId, permissionId, body);

  /**
   * Long enough for a prompt to reach the pipes and the request to come back.
   *
   * Named `quiesce` rather than `settle` deliberately: `SessionRegistry.settle` is
   * the *subject* of this whole block, argued about three lines above in prose, so
   * one word for the method under test and for a timeout beside it is exactly the
   * collision this file spends paragraphs avoiding elsewhere.
   */
  const quiesce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  /**
   * The id of the question the agent is waiting on, or `""` when there is none.
   *
   * **Never `pendingPermissions[0]!`, and this is the reason.** That non-null
   * assertion is erased at runtime, so a regression in the code under test does
   * not fail a case — it throws `TypeError: Cannot read properties of undefined`
   * and takes the whole process down mid-run. Measured: commenting out
   * `this.pending.delete(permissionId)` in `registry.ts` printed ten `FAIL` lines
   * and then died, with no failure count and with **every later section of this
   * file — the permission-expired block and `/clear` — never executed at all**.
   *
   * In a repository where the drivers are the entire safety net, a broken
   * invariant has to produce a red line and a total, not a stack trace that
   * silently deletes the rest of the coverage.
   *
   * The fallback is a **real path segment** rather than `""`, and that took a
   * correction: an empty one leaves `/sessions/:id/permissions/` matching no
   * route at all, so Hono answers its own plain-text 404 and the JSON parse in
   * `answer` throws — reintroducing the crash one layer out. A token that cannot
   * be a minted id reaches the handler instead and is refused as one.
   */
  const NOTHING_PENDING = "no-pending-permission";
  const waitingOn = (): string => blocked.snapshot().pendingPermissions[0]?.permissionId ?? NOTHING_PENDING;

  const workdir = tmp("permcheck-");
  const blocked = await permRegistry.create({ agent: "kimi", cwd: workdir });
  const idle = await permRegistry.create({ agent: "kimi", cwd: workdir });
  // Pinned, so the ordering assertion below has something to beat: pinned is the
  // rank immediately under blocked, and every other row here is live.
  idle.setMeta({ pinned: true });

  blocked.prompt("do the thing");
  await quiesce();

  /* ---- the session is genuinely blocked ---- */

  check("a session waiting on the agent's question is blocked", blocked.status, "blocked");
  const pending = blocked.snapshot().pendingPermissions;
  check("and carries exactly one question", pending.length, 1);
  check("naming the tool call it belongs to", pending[0]?.toolCallId, "tc_1_9001");
  check("with the agent's own title", pending[0]?.title, "Terminal");
  check(
    "and every option it offered, in order",
    pending[0]?.options.map((option) => option.optionId),
    ["o_yes", "o_always", "o_no", "o_never"],
  );
  /*
   * Both of these ride the *snapshot*, which `GET /sessions` returns for every
   * session at once — so they are clamped an order tighter than a per-event cap.
   * Carrying them at all is the fix for the measured kimi case: its `tool_call`
   * arrives with `rawInput: null` and the command appears only as a text block
   * on the request, so a card joining against the log alone drew an approve
   * button above an empty box every single time.
   */
  check("the raw arguments come with it", (pending[0]?.rawInput as any)?.command, "rm -rf /");
  check("and so does the text block, which is where kimi puts the command", Array.isArray(pending[0]?.content), true);

  /*
   * Blocked outranks everything, which is what makes `?limit=` safe at all —
   * promised where `listRank` is asserted above and only provable here, because
   * a restored row cannot hold a pending permission.
   */
  const cut = await permApp.fetch(
    new Request("http://d/sessions?limit=1", { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }),
  );
  check(
    "a cut of one keeps the blocked session, over a pinned one",
    ((await cut.json()) as any).sessions.map((s: { id: string }) => s.id),
    [blocked.id],
  );

  /* ---- the answer reaches the agent ---- */

  const permissionId = pending[0]?.permissionId ?? "";
  const ok = await answer(blocked.id, permissionId, { optionId: "o_always" });
  check("answering it is a 200", ok.status, 200);
  check("recorded, and not a repeat", [ok.body.recorded, ok.body.repeat], [true, false]);
  check("with the outcome and the option that was picked", [ok.body.outcome, ok.body.optionId], ["selected", "o_always"]);
  /*
   * "recorded", never "the agent continued": once the agent's connection is gone
   * the SDK swallows the send, so delivery cannot be proven from here. Only a
   * later event in the log proves effect — which is the next assertion.
   */
  check("and an honest word about delivery rather than a claim of effect", ok.body.delivered, "sent");

  await quiesce();
  /*
   * The one observable that proves the ordering inside `settle`: the agent was
   * handed the option a human chose. If the append ran first and threw, this
   * array would be empty while the route had already answered 200.
   */
  check("the agent really was unblocked, with the option a human picked", answered.length, 1);
  check("and it is the one they picked, not the agent's own preference", (answered[0]?.outcome as any)?.optionId, "o_always");
  check("the session stops being blocked", blocked.status, "idle");
  check("and its snapshot holds no question", blocked.snapshot().pendingPermissions.length, 0);

  /*
   * The registry appends this, not `session.ts` — `settle()` appends
   * *synchronously*, in the statement after the agent's own promise is resolved, so
   * routing it through the `EventQueue` would put a microtask between the two and a
   * client answering inside it could beat its own request into the log.
   */
  const resolvedEvents = blocked.log
    .read(0, 200, 1 << 20)
    .map((stored) => stored.event)
    .filter((event) => event.type === "permission_resolved");
  check("the resolution is in the log", resolvedEvents.length, 1);
  check("attributed to the client rather than to a sweep", (resolvedEvents[0] as any)?.by, "client");

  /* ---- answering twice ---- */

  /*
   * **A 409 carrying a success-shaped body**, and this is the daemon end of an
   * invariant only the client end was pinned on. `packages/web/src/http.ts`
   * reads `error.code`/`error.detail` and `webcheck` asserts it copes with this
   * shape — but nothing here asserted the daemon still *sends* it, so the two
   * could drift and a successful approval would start rendering as a failure
   * with raw JSON for a message.
   */
  const again = await answer(blocked.id, permissionId, { optionId: "o_yes" });
  check("answering the same one twice is a 409", again.status, 409);
  check("but the body says it landed, because it did", again.body.recorded, true);
  check("and says which time this was", again.body.repeat, true);
  check("carrying the outcome of the answer that won, not the one just sent", again.body.optionId, "o_always");
  check("with no error envelope at all, which is what a client keys on", "error" in again.body, false);
  check("and the agent was not told twice", answered.length, 1);

  /* ---- two clients answering at once ---- */

  /*
   * `pending.delete` is the compare-and-swap. Two answers run in separate
   * macrotasks with no await between the `get` and the `delete`, so exactly one
   * wins — and the loser must be told its answer did not decide anything rather
   * than being handed a second 200.
   */
  blocked.prompt("do another thing");
  await quiesce();
  const second = waitingOn();
  const [a, b] = await Promise.all([
    answer(blocked.id, second, { optionId: "o_yes" }),
    answer(blocked.id, second, { optionId: "o_no" }),
  ]);
  check(
    "two simultaneous answers settle it exactly once",
    [a.status, b.status].sort((x, y) => x - y),
    [200, 409],
  );
  check("the winner is not a repeat and the loser is", [a.body.repeat, b.body.repeat].sort(), [false, true]);
  await quiesce();
  check("and the agent heard one answer, not two", answered.length, 2);

  /* ---- what a body may say ---- */

  process.stdout.write("\nwhat an answer is allowed to say\n");

  blocked.prompt("do a third thing");
  await quiesce();
  const third = waitingOn();

  /*
   * Exactly one of the three forms, so an ambiguous body is never silently
   * resolved one way. Each of these leaves the permission pending, which is the
   * half worth having: a refused body must not settle anything.
   */
  const badBodies: Array<[string, unknown]> = [
    ["an empty body decides nothing", {}],
    ["two forms at once are ambiguous, not a preference", { optionId: "o_yes", cancel: true }],
    ["a decision and an option are too", { optionId: "o_yes", decision: "allow" }],
    ["a word that is not a decision is refused", { decision: "maybe" }],
    ["and cancel must be true rather than merely present", { cancel: false }],
    ["an option id that is not a string is not an option id", { optionId: 7 }],
  ];
  for (const [name, body] of badBodies) {
    const bad = await answer(blocked.id, third, body);
    check(name, [bad.status, bad.body.error?.code], [400, "bad_request"]);
  }
  check("and none of them settled it", blocked.snapshot().pendingPermissions.length, 1);

  {
    const wrong = await answer(blocked.id, third, { optionId: "o_nonexistent" });
    check("an option the agent never offered is refused", [wrong.status, wrong.body.error?.code], [400, "invalid_option"]);
    // The options come back with the refusal, so a client that is out of date can
    // redraw rather than guess.
    check(
      "and the refusal carries what was actually on offer",
      wrong.body.error?.detail?.options?.map((option: { optionId: string }) => option.optionId),
      ["o_yes", "o_always", "o_no", "o_never"],
    );
  }

  /*
   * A decision word is a *preference order* over kinds, not an id — which is
   * what lets one client vocabulary drive agents that name their options
   * differently. `allow` prefers `allow_once` and falls back to `allow_always`;
   * `reject_always` prefers `reject_always` and falls back to `reject_once`.
   */
  check("a decision word picks by kind, not by id", (await answer(blocked.id, third, { decision: "reject_always" })).body.optionId, "o_never");
  await quiesce();

  for (const [word, want] of [
    ["allow", "o_yes"],
    ["allow_always", "o_always"],
    ["reject", "o_no"],
  ] as const) {
    blocked.prompt(`do a ${word} thing`);
    await quiesce();
    const id = waitingOn();
    check(`"${word}" resolves to the option it prefers`, (await answer(blocked.id, id, { decision: word })).body.optionId, want);
    await quiesce();
  }

  {
    /*
     * The narrow offer: one `allow_once` and nothing else. It still parks —
     * `session.ts` forwards only when there is something a human could actually
     * pick — so a `reject` has a live permission to fail against rather than
     * falling through to the cancel path.
     */
    blocked.prompt("a narrow question");
    await quiesce();
    const narrow = waitingOn();
    const none = await answer(blocked.id, narrow, { decision: "reject" });
    check(
      "a decision with nothing of that kind on offer is refused",
      [none.status, none.body.error?.code],
      [400, "no_matching_option"],
    );
    check("and it is still waiting for an answer it can take", blocked.snapshot().pendingPermissions.length, 1);
    check("which cancel always is", (await answer(blocked.id, narrow, { cancel: true })).body.outcome, "cancelled");
    await quiesce();
  }

  check("an id nothing ever minted is a 404", (await answer(blocked.id, "not-a-permission", { cancel: true })).status, 404);
  check("and so is a session that does not exist", (await answer("s_nope", "perm-1-abc", { cancel: true })).status, 404);

  /*
   * The stand-in `waitingOn` answers with when nothing is pending, asserted
   * rather than merely tolerated: a regression that empties `pendingPermissions`
   * makes several cases above send it, and they have to fail on a 404 that says
   * so rather than on a crash inside the driver.
   */
  const standIn = await answer(blocked.id, NOTHING_PENDING, { cancel: true });
  check("and so is the stand-in a broken run would send", standIn.status, 404);
  check("answered by the handler in this daemon's own envelope", standIn.body?.error?.code, "permission_not_found");

  await permRegistry.shutdown();

  /* ---- and the two fields that used to have no bound at all ---- */

  {
    /*
     * ⚠ **`title` and `options` were passed through exactly as the agent sent
     * them**, while `rawInput` and `content` beside them were clamped at 8 KiB
     * each *because they ride the snapshot* — which these two do as well.
     * `truncateEvent` then declined to cut the event on the written ground that
     * permissions are "already clamped far tighter upstream by `clampBlob`":
     * true of the two fields that are not on the event, false of the two that
     * are. So the amplifier was the snapshot rather than the log — one huge
     * title re-sent on every four-second `GET /sessions`, for every session on
     * the machine, over the relay, to a phone.
     *
     * Driven through the wire rather than asserted against `clip`, because what
     * was missing was a call site and every pure function involved was correct.
     */
    const shouted = await permRegistry.create({ agent: "kimi", cwd: workdir });
    shouted.prompt("run it, shouting");
    await quiesce();
    const parked = shouted.snapshot().pendingPermissions[0];
    check("an agent shouting a 50 KB title is still asked", shouted.status, "blocked");
    report(
      "but the snapshot carries a clipped one",
      (parked?.title.length ?? 0) <= 256,
      `${parked?.title.length ?? -1} chars from 50000`,
    );
    report(
      "and a 4 KB option name likewise",
      (parked?.options[0]?.name.length ?? 0) <= 256,
      `${parked?.options[0]?.name.length ?? -1} chars from 4000`,
    );
    await permRegistry.stop(shouted.id);
  }

  {
    /*
     * **Refused whole rather than trimmed**, and this is the one arm where that
     * is the only honest answer: an `optionId` round-trips verbatim in the
     * response, so a clipped one is an answer the agent will not recognise, and
     * dropping options removes choices it offered — the thing `drawableOptions`
     * spends four rules being careful about one layer up.
     *
     * What has to be true is that the session does not end up *blocked* on a
     * card nobody bounded: the agent is told, and the turn carries on.
     */
    const swarmed = await permRegistry.create({ agent: "kimi", cwd: workdir });
    swarmed.prompt("run it, swarming");
    await quiesce();
    check("200 options is refused rather than parked", swarmed.snapshot().pendingPermissions.length, 0);
    check("so the session is not left blocked on it", swarmed.status === "blocked", false);
    await permRegistry.stop(swarmed.id);
  }
}

/*
 * An id this daemon really did mint, for a life that is over.
 *
 * `resolved` is in memory and `askSeq`/`askSalt` are on the row,
 * so a restart is exactly the state where an id is recognisably ours and no
 * longer answerable. That asymmetry is the whole of `looksLikeOurs`, and the
 * rule it exists for is one line in `registry.ts`: **"too old to report" must
 * never come back as "never existed"** — a client holding a permission id from
 * before a deploy is owed a 409 saying it was settled and forgotten, not a 404
 * telling it the daemon never heard of a request it can see in its own
 * transcript.
 *
 * Driven off a restored row with no agent anywhere, which is the only way to
 * reach it: nothing in a live session can empty `resolved` while keeping the
 * counter.
 */
/* ------------------------------------------------------------------ *
 * Answering a question the agent is waiting on
 * ------------------------------------------------------------------ */

/**
 * The elicitation half of the permission block above, against an agent that
 * really is waiting.
 *
 * Same shape and the same reason: the settle order is only observable through its
 * one consequence — the agent is handed the content a person actually typed — and
 * an agent that answers its own prompt immediately would assert nothing.
 *
 * What this pins that the permission block cannot: that `status === "blocked"`
 * and `listRank` read *both* maps. A session holding only a question is the one
 * state where deleting the `pendingElicitations` term from `awaitingCount` fails
 * a case and nothing else does.
 */
process.stdout.write("\nanswering a question the agent is waiting on\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  /** What the client sent back, in the agent's own words. */
  const answered: { action?: string; content?: Record<string, unknown> }[] = [];

  const spawnAgent = (): AgentProcess => {
    const sessionId = "s_ask_1";
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);

    let heldPromptId: unknown = null;
    let askId = 7000;

    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];

        // The answer to the question this agent asked; the turn was waiting on it.
        if (message["method"] === undefined && id !== undefined) {
          answered.push(message["result"]);
          if (heldPromptId !== null) {
            send({ jsonrpc: "2.0", id: heldPromptId, result: { stopReason: "end_turn" } });
            heldPromptId = null;
          }
          continue;
        }

        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new:
            send({ jsonrpc: "2.0", id, result: { sessionId } });
            break;
          case acp.methods.agent.session.prompt: {
            heldPromptId = id;
            askId += 1;
            // The measured AskUserQuestion shape: a titled single-select and the
            // adapter's own free-text box beside it.
            send({
              jsonrpc: "2.0",
              id: askId,
              method: acp.methods.client.elicitation.create,
              params: {
                mode: "form",
                sessionId,
                toolCallId: `tc_ask_${askId}`,
                message: "Which framework should I use?",
                requestedSchema: {
                  type: "object",
                  required: ["question_0"],
                  properties: {
                    question_0: {
                      type: "string",
                      title: "Framework",
                      oneOf: [
                        { const: "React", title: "React", description: "Already in package.json" },
                        { const: "Svelte", title: "Svelte" },
                      ],
                    },
                    question_0_custom: { type: "string", title: "Other", maxLength: 80 },
                  },
                },
              },
            });
            break;
          }
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });

    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    };
  };

  class AskRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnAgent();
    }
  }

  const askRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new AskRuntime());
  const { app: askApp } = createApp({
    registry: askRegistry,
    verifier,
    instanceId: "i_ask",
    startedAt: now,
    credentials,
    roots: [users],
  });

  const quiesce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  /**
   * Guarded for the reason `waitingOn` is guarded one block up: an erased
   * non-null assertion turns a regression into a `TypeError` that kills the run
   * and silently deletes every later section's coverage. The stand-in is a real
   * path segment so Hono still matches the route and the handler refuses it.
   */
  const NOTHING_PENDING = "no-pending-elicitation";
  const askingOn = (): string =>
    asked.snapshot().pendingElicitations[0]?.elicitationId ?? NOTHING_PENDING;

  /** Answering over HTTP, with a parse that cannot throw. */
  const reply = async (elicitationId: string, body: unknown): Promise<{ status: number; body: any }> => {
    const response = await askApp.fetch(
      new Request(`http://d/sessions/${asked.id}/elicitations/${elicitationId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed };
  };

  const workdir = tmp("askcheck-");
  const asked = await askRegistry.create({ agent: "kimi", cwd: workdir });
  const idle = await askRegistry.create({ agent: "kimi", cwd: workdir });
  idle.setMeta({ pinned: true });

  asked.prompt("pick one");
  await quiesce();

  /* ---- blocked on a question, with no permission anywhere ---- */

  check("a session waiting on a question is blocked", asked.status, "blocked");
  // The case that pins `awaitingCount`. Deleting the `pendingElicitations` term
  // from it fails this and nothing else in the file.
  check("with no permission outstanding at all", asked.snapshot().pendingPermissions.length, 0);
  const waiting = asked.snapshot().pendingElicitations;
  check("and exactly one question", waiting.length, 1);
  check("naming the tool call it belongs to", waiting[0]?.toolCallId, "tc_ask_7001");
  check("carrying the agent's prompt", waiting[0]?.message, "Which framework should I use?");
  // The form is deliberately *not* on the snapshot — a question cannot be
  // answered from a list, so only enough to say one is waiting rides the poll.
  check("and only a field count, not the form", waiting[0]?.fieldCount, 2);
  check(
    "the two derivations of 'somebody is waiting' agree",
    awaitingHuman(asked.snapshot()),
    asked.status === "blocked",
  );

  const cut = await askApp.fetch(
    new Request("http://d/sessions?limit=1", { headers: { authorization: `Bearer ${tokenFor("u_alice")}` } }),
  );
  check(
    "a cut of one keeps the session with a question, over a pinned one",
    ((await cut.json()) as any).sessions?.[0]?.id,
    asked.id,
  );

  /* ---- the form is fetched, not polled ---- */

  const formResponse = await askApp.fetch(
    new Request(`http://d/sessions/${asked.id}/elicitations/${askingOn()}`, {
      headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
    }),
  );
  const form = (await formResponse.json()) as any;
  check("the form comes from its own route", formResponse.status, 200);
  check(
    "with the fields in the order the agent declared them",
    form.fields?.map((field: any) => [field.key, field.kind, field.required]),
    [
      ["question_0", "string", true],
      ["question_0_custom", "string", false],
    ],
  );
  check("and each option's label", form.fields?.[0]?.options?.map((o: any) => o.label), ["React", "Svelte"]);

  /* ---- what an answer is allowed to say ---- */

  const badBodies: [string, unknown, string][] = [
    ["an empty body names no form", {}, "bad_request"],
    ["two forms at once are never resolved one way", { content: {}, cancel: true }, "bad_request"],
    ["nor are the other two", { decline: true, cancel: true }, "bad_request"],
    ["a false flag is not a form", { cancel: false }, "bad_request"],
    ["null content is not an object", { content: null }, "bad_request"],
    ["an array is not an object either", { content: [] }, "bad_request"],
    ["a key the form never had is refused, never stripped", { content: { nope: "x" } }, "invalid_content"],
    ["a required field left out is refused", { content: { question_0_custom: "x" } }, "invalid_content"],
    ["a number for a string is not coerced", { content: { question_0: 7 } }, "invalid_content"],
    ["a value the form never offered is refused", { content: { question_0: "Vue" } }, "invalid_content"],
    [
      "and one over a field's own maxLength",
      { content: { question_0: "React", question_0_custom: "y".repeat(200) } },
      "invalid_content",
    ],
  ];
  for (const [label, body, code] of badBodies) {
    const result = await reply(askingOn(), body);
    check(label, [result.status, result.body?.error?.code], [400, code]);
  }
  // The half worth having: none of them settled it.
  check("and none of them settled it", asked.status, "blocked");
  check("nor was the agent told anything", answered.length, 0);

  /* ---- the answer lands, and the agent hears it ---- */

  const settledId = askingOn();
  const ok = await reply(settledId, { content: { question_0: "React" } });
  check("a valid answer is recorded", [ok.status, ok.body?.recorded, ok.body?.action], [200, true, "accept"]);
  await quiesce();

  /*
   * The one observable that pins `settleElicitation`'s statement order: the agent
   * was unblocked with the content a person typed, before anything was logged.
   */
  check("and the agent really was handed it", answered[0]?.content, { question_0: "React" });
  check("the session is no longer blocked", asked.status, "idle");
  check("and holds no question", asked.snapshot().pendingElicitations.length, 0);

  /*
   * The resolution renders with no join back to the request.
   *
   * This is the `permissionDecisions` lesson pinned rather than repeated: a
   * `permission_resolved` carries only an `optionId`, so a refused command was
   * once drawn with a check mark. `value` is the option's **label** — what the
   * person read and tapped — and never its wire value.
   */
  const log = asked.log.read(0, 1000, 1024 * 1024).map((stored) => stored.event);
  const resolved = log.find((event) => event.type === "elicitation_resolved");
  check("the log records the answer", resolved?.type, "elicitation_resolved");
  check(
    "already rendered, so a transcript needs no join",
    resolved?.type === "elicitation_resolved" ? resolved.answers : null,
    [{ key: "question_0", label: "Framework", value: "React" }],
  );
  check(
    "and says a human did it",
    resolved?.type === "elicitation_resolved" ? resolved.by : null,
    "client",
  );

  /* ---- answering twice ---- */

  const again = await reply(settledId, { content: { question_0: "Svelte" } });
  check(
    "answering again is a 409 carrying a success-shaped body",
    [again.status, again.body?.recorded, again.body?.repeat],
    [409, true, true],
  );
  // The action that *won*, not the one just sent.
  check("naming the answer that won", again.body?.action, "accept");
  check("and it is not an error envelope", again.body?.error, undefined);

  /* ---- decline and cancel are distinct on the wire ---- */

  asked.prompt("pick again");
  await quiesce();
  await reply(askingOn(), { decline: true });
  await quiesce();
  check("declining reaches the agent as a decline, so its turn carries on", answered[1]?.action, "decline");

  asked.prompt("once more");
  await quiesce();
  await reply(askingOn(), { cancel: true });
  await quiesce();
  check("and cancelling as a cancel, which aborts the tool call", answered[2]?.action, "cancel");

  /* ---- the sweep ---- */

  asked.prompt("and again");
  await quiesce();
  check("a question is outstanding before the stop", asked.snapshot().pendingElicitations.length, 1);
  await asked.stop();
  check("stopping sweeps it rather than leaving the agent parked", asked.snapshot().pendingElicitations.length, 0);
  const swept = asked.log
    .read(0, 1000, 1024 * 1024)
    .map((stored) => stored.event)
    .filter((event) => event.type === "elicitation_resolved")
    .at(-1);
  check(
    "and says who settled it",
    swept?.type === "elicitation_resolved" ? [swept.action, swept.by] : null,
    ["cancel", "session_stopped"],
  );

  await askRegistry.shutdown();
}

/* ------------------------------------------------------------------ *
 * Stopping the turn without stopping the session
 * ------------------------------------------------------------------ */

/**
 * `POST /sessions/:id/cancel`, against agents that behave three different ways.
 *
 * **The stub carries an explicit `session/cancel` arm, and that is the point of
 * the whole block.** It is a *notification* — no `id` — so without an arm it
 * lands in the `default:` case, where `if (id !== undefined)` discards it in
 * silence. Every assertion below would then pass just as well against a daemon
 * that never sent the notification at all, which is the one failure a driver for
 * this feature exists to catch. `cancelsSeen` is asserted before anything else.
 *
 * Three behaviours, because the interesting cases are the ones where the agent
 * does not simply comply:
 *
 *   "ask me"       parks a permission and answers `cancelled` only once the
 *                  client has settled it — which is ACP's actual contract and
 *                  the reason the daemon sweeps *after* sending. An agent
 *                  blocked on a human cannot see a cancel until it is answered,
 *                  so a daemon that waited before sweeping would hang here.
 *   "work quietly" answers `cancelled` as soon as it is asked. The ordinary case.
 *   "ignore me"    never answers at all, which is legal: cancellation is a
 *                  notification and nothing obliges an agent to act on it. This
 *                  is what proves `settled: false` is reachable and honest.
 */
process.stdout.write("\nstopping the turn without stopping the session\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  /** Every `session/cancel` this daemon sent, by the session id it named. */
  const cancelsSeen: string[] = [];
  /** What the client answered the parked permission with, in the agent's words. */
  const answered: { outcome?: { outcome?: string; optionId?: string } }[] = [];

  const spawnAgent = (): AgentProcess => {
    const sessionId = "s_cancel_1";
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);

    let heldPromptId: unknown = null;
    /** Whether this turn was asked to stop, so the stop reason can be honest. */
    let cancelled = false;
    /** The one behaviour that answers nothing, ever. See the block's docblock. */
    let stubborn = false;
    /** Set by a prompt that asks, so the cancel arm knows not to self-answer. */
    let pendingAsk: string | null = null;
    let askId = 5000;

    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];

        // The client's answer to the permission this agent parked. A real agent
        // only reaches its own turn end here, which is why the daemon has to send
        // one after cancelling rather than wait for the turn to notice.
        if (message["method"] === undefined && id !== undefined) {
          answered.push(message["result"]);
          if (heldPromptId !== null) {
            send({
              jsonrpc: "2.0",
              id: heldPromptId,
              result: { stopReason: cancelled ? "cancelled" : "end_turn" },
            });
            heldPromptId = null;
          }
          continue;
        }

        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new:
            send({ jsonrpc: "2.0", id, result: { sessionId } });
            break;
          case acp.methods.agent.session.cancel: {
            cancelsSeen.push(message["params"]?.["sessionId"]);
            cancelled = true;
            // Nothing is parked, so this agent is free to end its own turn — the
            // path an agent that is merely thinking takes. The stubborn one does
            // not, and neither does one waiting on a permission: that one answers
            // above, when the client finally settles it.
            if (heldPromptId !== null && !stubborn && pendingAsk === null) {
              send({ jsonrpc: "2.0", id: heldPromptId, result: { stopReason: "cancelled" } });
              heldPromptId = null;
            }
            break;
          }
          case acp.methods.agent.session.prompt: {
            const text = JSON.stringify(message["params"]?.["prompt"] ?? "");
            cancelled = false;
            stubborn = text.includes("ignore me");
            heldPromptId = id;
            if (!text.includes("ask me")) {
              pendingAsk = null;
              break;
            }
            askId += 1;
            pendingAsk = `tc_cancel_${askId}`;
            send({
              jsonrpc: "2.0",
              id: askId,
              method: acp.methods.client.session.requestPermission,
              params: {
                sessionId,
                toolCall: {
                  toolCallId: pendingAsk,
                  title: "Terminal",
                  rawInput: { command: "sleep 600" },
                },
                options: [
                  { optionId: "o_yes", name: "Yes", kind: "allow_once" },
                  { optionId: "o_no", name: "No", kind: "reject_once" },
                ],
              },
            });
            break;
          }
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });

    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    };
  };

  class CancelRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnAgent();
    }
  }

  const cancelRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new CancelRuntime());
  const { app: cancelApp } = createApp({
    registry: cancelRegistry,
    verifier,
    instanceId: "i_cancel",
    startedAt: now,
    credentials,
    roots: [users],
  });

  const postCancel = async (sessionId: string): Promise<{ status: number; body: any }> => {
    const response = await cancelApp.fetch(
      new Request(`http://d/sessions/${sessionId}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) };
  };

  const quiesce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  const workdir = tmp("cancelcheck-");
  const live = await cancelRegistry.create({ agent: "kimi", cwd: workdir });
  const eventsOf = (type: string) =>
    live.log
      .read(0, 1000, 1 << 20)
      .map((stored) => stored.event)
      .filter((event) => event.type === type);

  /* ---- nothing is running ---- */

  /*
   * A 200 and not a 409, which is the one shape in this route worth arguing
   * about. Nothing was stopped and nothing is wrong: the caller asked for an
   * agent that is not working and it is not working. That state is also what an
   * ordinary lost race looks like — the tap and the turn's own end are not
   * ordered by anything — so a red error here would make the control look broken
   * at the exact moment it got what it wanted.
   */
  const idleAnswer = await postCancel(live.id);
  check("cancelling with nothing in flight is a 200", idleAnswer.status, 200);
  check("saying plainly that nothing was cancelled", [idleAnswer.body.cancelled, idleAnswer.body.turn], [false, null]);
  check("and that there is nothing left to wait for", idleAnswer.body.settled, true);
  check("with no notification sent to the agent at all", cancelsSeen.length, 0);

  /* ---- an agent that is simply working ---- */

  live.prompt("work quietly");
  await quiesce();
  check("a turn is in flight", live.status, "running");

  const quiet = await postCancel(live.id);
  check("cancelling it is a 200", quiet.status, 200);
  check("naming the turn it stopped", [quiet.body.cancelled, quiet.body.turn], [true, 1]);
  check("and reporting that the agent really finished", quiet.body.settled, true);
  /*
   * The assertion the stub's `session/cancel` arm exists for. Without it every
   * case in this block passes against a daemon that sends nothing, because a
   * notification with no `id` is discarded in silence by the `default:` arm.
   */
  check("the notification reached the agent", cancelsSeen, ["s_cancel_1"]);
  check("naming the agent's own session id, never ours", cancelsSeen[0] !== live.id, true);

  await quiesce();
  check("the session is idle again rather than ended", live.status, "idle");
  check("with no exit recorded — this is not a stop", live.snapshot().exit, null);
  check(
    "the turn ended as cancelled, which the transcript draws",
    eventsOf("turn_end").map((event) => (event.type === "turn_end" ? event.stopReason : null)),
    ["cancelled"],
  );
  check("and the marker is cleared with the turn", live.snapshot().cancelRequestedAt, null);

  /* ---- an agent blocked on a human ---- */

  /*
   * The ordering case, and the reason `cancelTurn` sweeps *after* it sends rather
   * than before or instead. This agent answers its prompt only once the client
   * settles the permission — which is ACP's contract, not a quirk of the stub —
   * so a daemon that sent the notification and then waited would spend its whole
   * budget and report `settled: false`, and one that never swept would leave the
   * session `blocked` for ever on a turn nobody can end.
   */
  live.prompt("ask me first");
  await quiesce();
  check("a session parked on a permission is blocked", live.status, "blocked");

  const parked = await postCancel(live.id);
  check("cancelling it is still a 200", parked.status, 200);
  check("and the turn really did settle, because the sweep unblocked it", parked.body.settled, true);
  check("the agent was answered rather than left holding the promise", answered.length, 1);
  check("and it was answered with a cancellation", answered[0]?.outcome?.outcome, "cancelled");
  check("nothing is parked any more", live.snapshot().pendingPermissions.length, 0);
  check("the session is idle, not blocked and not ended", live.status, "idle");

  /*
   * **The assertion that makes the ordering claim true**, and without it the
   * whole block above passes for a daemon that sweeps first.
   *
   * Everything asserted so far is satisfied by either order: `outcome:
   * "cancelled"` is this daemon's own constant, so it says what *we* sent and
   * nothing about what the agent heard, and the session goes idle either way.
   * The stop reason is the agent's word — this stub answers `cancelled` only if
   * `session/cancel` arrived before the answer that freed its turn, and
   * `end_turn` otherwise, which is exactly what a real agent does. Measured by
   * putting one yield between the send and the sweep: the wire order becomes
   * answer → `turn_end{end_turn}` → cancel, and this line is the only one in the
   * file that goes red.
   */
  check(
    "and this turn ended as cancelled too, which only send-then-sweep achieves",
    eventsOf("turn_end").map((event) => (event.type === "turn_end" ? event.stopReason : null)),
    ["cancelled", "cancelled"],
  );

  const sweptBy = eventsOf("permission_resolved").at(-1);
  /*
   * Its own reason and not `session_stopped`, which is the nearest existing
   * member and says the opposite of what happened: that one means the session is
   * over, and this session is idle and still holding its conversation.
   */
  check(
    "attributed to the cancel rather than to a stop or a turn that ended",
    sweptBy?.type === "permission_resolved" ? sweptBy.by : null,
    "turn_cancelled",
  );

  /* ---- an agent that ignores it ---- */

  /*
   * Legal, and the honest half of this feature: `session/cancel` is a
   * notification with no response, so nothing here can make an agent stop. What
   * the daemon promises is that it asked — and `settled: false` is how it says
   * the agent had not finished by the time anybody stopped watching.
   */
  live.prompt("ignore me");
  await quiesce();
  const ignored = await postCancel(live.id);
  check("cancelling an agent that will not stop is still a 200", ignored.status, 200);
  check("the daemon says it asked", ignored.body.cancelled, true);
  check("and says honestly that the agent has not finished", ignored.body.settled, false);
  check("the turn is still in flight, so the session still reads running", live.status, "running");
  /*
   * The field the composer's Stop button is drawn from. It has to survive an
   * unsettled cancel — that is the entire state it exists for — or the control
   * springs back to armed and invites the second tap that does nothing.
   */
  check("and the snapshot still says somebody asked", typeof live.snapshot().cancelRequestedAt, "number");

  // Not memoised, unlike `stop()`: asking twice is a person tapping again, and
  // the honest answer is to ask the agent again rather than replay the first.
  const twice = await postCancel(live.id);
  check("asking twice is allowed rather than deduplicated", twice.body.cancelled, true);
  check("and really did send a second notification for this turn", cancelsSeen.length, 4);

  /* ---- a session that has ended ---- */

  await live.stop();
  const dead = await postCancel(live.id);
  check("cancelling a session that has ended is a 409", dead.status, 409);
  check("saying which, so a client can offer resume rather than retry", dead.body.error?.code, "session_terminal");
  check("and a session id nothing minted is still a 404", (await postCancel("s_nope")).status, 404);

  await cancelRegistry.shutdown();
}

process.stdout.write("\na permission id from a life that has ended\n");
{
  const restored: PersistedSession = {
    ...rowFor("s_perm_old", join(users, "u_alice", "perms")),
    askSeq: 3,
    askSalt: "abc",
  };
  const oldRegistry = new SessionRegistry(new MemoryEventStore(), storeOf([restored]));
  oldRegistry.restore({ reapOrphans: false });
  const { app: oldApp } = createApp({
    registry: oldRegistry,
    verifier,
    instanceId: "i_perm_old",
    startedAt: now,
    credentials,
    roots: [users],
  });
  const ask = (permissionId: string) => answerPermission(oldApp, "s_perm_old", permissionId, { cancel: true });

  const settled = await ask("perm-2-abc");
  check("an id this daemon minted before the restart is a 409", settled.status, 409);
  check("saying it was settled and forgotten, not that it never existed", settled.body.error.code, "permission_expired");

  /*
   * The two halves of the pattern, each of which alone would make the 409 a
   * blanket answer: a sequence above anything ever minted, and a salt from
   * somebody else's daemon.
   */
  check("a sequence this daemon never reached is a 404", (await ask("perm-9-abc")).status, 404);
  check("and another daemon's salt is too, however well formed", (await ask("perm-2-def")).status, 404);
  check("as is something that is not an id at all", (await ask("perm-x-abc")).status, 404);
  check("the boundary is inclusive: the last id it minted is still recognised", (await ask("perm-3-abc")).status, 409);

  /*
   * The same rule, through the same `looksLikeOurs`, for the other kind of
   * question — and the case that proves one counter serves two prefixes without
   * either answering for the other.
   *
   * A shared counter is what let an elicitation id survive a restart with no
   * second persisted column, and therefore with no `migrate()` and no
   * `SCHEMA_VERSION` argument. The cost is gaps in each kind's numbering, which
   * nothing reads as a count; what must *not* happen is a `perm-` id being
   * recognised as an `elic-` one or the reverse.
   */
  const askElic = async (elicitationId: string): Promise<{ status: number; body: any }> => {
    const response = await oldApp.fetch(
      new Request(`http://d/sessions/s_perm_old/elicitations/${elicitationId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify({ cancel: true }),
      }),
    );
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed };
  };

  const oldQuestion = await askElic("elic-2-abc");
  check("a question id from before the restart is a 409 too", oldQuestion.status, 409);
  check("with its own code", oldQuestion.body.error.code, "elicitation_expired");
  check("a sequence never reached is a 404", (await askElic("elic-9-abc")).status, 404);
  check("another daemon's salt likewise", (await askElic("elic-2-def")).status, 404);
  check("and the boundary is inclusive here as well", (await askElic("elic-3-abc")).status, 409);
  // One counter, two prefixes: neither route answers for the other's ids.
  check("a permission id is not a question", (await askElic("perm-2-abc")).status, 404);
  check("and a question id is not a permission", (await ask("elic-2-abc")).status, 404);

  await oldRegistry.shutdown();
}

/*
 * `/clear` is carried out by the daemon, not forwarded.
 *
 * Measured 2026-08-05: forwarding it makes claude's CLI fork *underneath* ACP —
 * our session id does not move, the file it names keeps the pre-clear history,
 * and the live conversation gets an id nobody tells us. The next boot's resume
 * then reattached to the abandoned one and handed back a codeword somebody had
 * cleared. Opening the session ourselves removes the cause, and the assertion
 * that matters is that the recorded id is the one *we* were given.
 */
process.stdout.write("\ncarrying out a clear\n");
{
  const acp = await import("@agentclientprotocol/sdk");
  const { Session } = await import("../src/session.js");

  let opened = 0;
  const closed: string[] = [];
  const prompts: string[] = [];
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);

  let buffer = "";
  toAgent.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as Record<string, any>;
      const id = message["id"];
      const params = (message["params"] ?? {}) as Record<string, any>;
      switch (message["method"]) {
        case acp.methods.agent.initialize:
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: acp.PROTOCOL_VERSION,
              // `close` advertised, so the old session really is closed rather
              // than leaked — one per clear, inside a long-lived agent process.
              agentCapabilities: { sessionCapabilities: { close: {} } },
              authMethods: [],
            },
          });
          break;
        case acp.methods.agent.session.new:
          opened += 1;
          send({ jsonrpc: "2.0", id, result: { sessionId: `conv_${opened}` } });
          break;
        case acp.methods.agent.session.close:
          closed.push(String(params["sessionId"]));
          send({ jsonrpc: "2.0", id, result: {} });
          break;
        case acp.methods.agent.session.prompt:
          prompts.push(`${String(params["sessionId"])}:${String(params["prompt"]?.[0]?.text ?? "")}`);
          send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
          break;
        default:
          if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
      }
    }
  });

  class ClearRuntime extends LocalRuntime {
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return {
        stdin: toAgent,
        stdout: toClient,
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        hasExited: false,
        waitForExit: async () => true,
        endStdin: () => toAgent.end(),
        kill: async () => {},
      } as unknown as AgentProcess;
    }
  }

  const session = await Session.start({
    agent: "claude",
    cwd: process.cwd(),
    runtime: new ClearRuntime(),
  });
  check("a session starts on the agent's first conversation", session.sessionId, "conv_1");

  const moved = await session.clearContext();
  check("a clear opens a second one", [moved.previous, moved.next], ["conv_1", "conv_2"]);
  // The whole point: the id is one we were *given*, not one we noticed later.
  check("and the session is now on it", session.sessionId, "conv_2");
  check("the old conversation is closed rather than leaked", closed, ["conv_1"]);
  /*
   * Nothing was sent to the agent as text. Forwarding `/clear` is what produced
   * the fork we could not see; if this ever regresses to a passthrough, the
   * daemon and the agent go back to disagreeing about which conversation is
   * live, silently.
   */
  check("and `/clear` was never forwarded as a prompt", prompts, []);

  /*
   * And the next turn goes to the new conversation, which is the observable end
   * of the same fact: the session is addressing `conv_2`, so a resume that
   * stores this id lands where the agent actually is.
   */
  for await (const _event of session.prompt("hello")) {
    // Drained rather than ignored: the generator is what runs the turn.
  }
  check("the next prompt goes to the new conversation", prompts, ["conv_2:hello"]);

  await session.dispose();
}

/* ------------------------------------------------------------------ *
 * A clear is a turn as far as everything else is concerned
 *
 * `clearContext` re-keys the ACP session underneath the daemon — `session/new`,
 * then `session/close` on the old id, measured at ~600ms and bounded at 15s —
 * and for that whole window `this.turn` was `null`. So a prompt arriving beside
 * a `/clear` passed every guard and was issued against the conversation about to
 * be closed: its updates went to `router.sessions.get(<the old id>)`, which is
 * `undefined` and drops them silently, and the turn died with the `session/close`
 * — a message written into the transcript that reached no model and produced no
 * reply. A second `/clear` in the same window is the same hole with a worse
 * ending: both capture the same `previous`, both close it, and the conversation
 * the first one opened is left live inside the agent with nothing left to close
 * it.
 *
 * The marker is a second field beside `turn` rather than a reuse of it, because a
 * clear is not a turn: it burns no turn number and produces no `turn_end`. What
 * it shares is the only thing it is read for.
 *
 * **This is a second agent rig for a subject the section above already has one
 * for, and the split is the point.** That one drives `Session` directly through a
 * single shared pipe pair, which is exactly right for "what does a clear do to
 * the agent" and cannot answer this: what is under test here is
 * `ManagedSession`'s guard and the route's 409, so it needs a registry, an app,
 * and — above all — a `session/new` that does **not** answer immediately, because
 * the window this defect lived in is the one where the agent has not replied yet.
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat else may talk to the agent during a clear\n");
{
  const acp = await import("@agentclientprotocol/sdk");

  /** How long the *next* `session/new` takes to answer. The window, in one number. */
  let newDelayMs = 0;
  let conversations = 0;
  const closed: string[] = [];

  const spawnClearing = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        const params = (message["params"] ?? {}) as Record<string, any>;
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                // Advertised so the old conversation is really closed, which is
                // the second half of the re-key and the slower one.
                agentCapabilities: { sessionCapabilities: { close: {} } },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.session.new: {
            conversations += 1;
            const sessionId = `conv_${conversations}`;
            const answer = (): void => send({ jsonrpc: "2.0", id, result: { sessionId } });
            if (newDelayMs > 0) setTimeout(answer, newDelayMs);
            else answer();
            break;
          }
          case acp.methods.agent.session.close:
            closed.push(String(params["sessionId"]));
            send({ jsonrpc: "2.0", id, result: {} });
            break;
          case acp.methods.agent.session.prompt:
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    } as unknown as AgentProcess;
  };

  class ClearingRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnClearing();
    }
  }

  const clearRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new ClearingRuntime());
  const { app: clearApp } = createApp({
    registry: clearRegistry,
    verifier,
    instanceId: "i_clearwindow",
    startedAt: now,
    credentials,
    roots: [users],
  });

  const workdir = tmp("clearcheck-");
  const managed = await clearRegistry.create({ agent: "kimi", cwd: workdir });
  check("the session starts on the agent's first conversation", managed.agentSessionId, "conv_1");

  const sendText = async (text: string): Promise<{ status: number; body: any }> => {
    const response = await clearApp.fetch(
      new Request(`http://d/sessions/${managed.id}/prompt`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }),
    );
    const raw = await response.text();
    return { status: response.status, body: raw.length > 0 ? JSON.parse(raw) : null };
  };

  // Wide enough that everything below runs inside it, and short enough that this
  // section costs a fifth of a second.
  newDelayMs = 200;
  const clearing = managed.clearContext("/clear");
  /*
   * Everything from here to the `await` runs while the agent's session id is
   * being replaced. The marker is set *before* `clearContext`'s own first await,
   * so it is already true by the time the call above has returned its promise —
   * which is the only reason a synchronous `prompt()` can see it at all.
   */
  check("a prompt beside an in-flight clear is refused", managed.prompt("hello").kind, "busy");
  check("and a second clear is refused the same way", (await managed.clearContext("/clear")).kind, "busy");
  /*
   * And through the route, which is where a client meets it: the same `409
   * turn_in_flight` a mid-turn message gets. The `status` beside it still reads
   * `idle`, deliberately — the marker is not a turn, it burns no turn number, and
   * putting a "working" timer on the snapshot for something the agent is not
   * thinking about would be the wrong lie. Pinned because it looks like a bug.
   */
  const refused = await sendText("hello over http");
  check("over HTTP it is the 409 a mid-turn message gets", [refused.status, refused.body?.error?.code], [409, "turn_in_flight"]);
  check("with a status that still says idle, because a clear is not a turn", refused.body?.error?.detail?.status, "idle");

  /*
   * **And the other two ways to talk to the agent, which the marker's own
   * docblock claimed and the code did not do.**
   *
   * `setConfigOption` and `setMode` reach `Session`, which reads `this.sessionId`
   * at request time — the id `clearContext` is in the middle of replacing. So a
   * mode tap inside this window either addresses the conversation `session/close`
   * is about to destroy, or lands during `restoreConfig`, which is putting back a
   * `wanted` snapshot captured *before* the tap and therefore silently reverts it.
   * Neither shows up anywhere: both answer `{kind: "ok"}` with a snapshot that
   * looks right. `AgentConfigBar` sits beside the composer, so `/clear` then a
   * mode change is one gesture apart.
   *
   * The refusal is `busy` rather than `not_ready`, and the route's code is
   * `session_busy` rather than the prompt's `turn_in_flight`: no turn is in
   * flight, and a client told one is would wait for a `turn_end` that never
   * comes.
   */
  check("a config change beside an in-flight clear is refused", (await managed.setConfigOption("thinking", "high")).kind, "busy");
  check("and so is a mode change, which is the one restoreConfig reverts", (await managed.setMode("plan")).kind, "busy");
  const configRefused = await clearApp.fetch(
    new Request(`http://d/sessions/${managed.id}/config`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
      body: JSON.stringify({ modeId: "plan" }),
    }),
  );
  const configBody = (await configRefused.json()) as any;
  check(
    "over HTTP that is a 409 that does not claim a turn is running",
    [configRefused.status, configBody?.error?.code],
    [409, "session_busy"],
  );
  /*
   * Refused *before* validation, which is what makes the guard a guard: the
   * agent's advertised set is read from a live session, and answering
   * `unknown_mode` here would be this daemon reporting on a conversation it is
   * halfway through discarding. A mode nothing has ever advertised is the case
   * that tells the two apart.
   */
  check("and refused before the mode is even looked up", (await managed.setMode("no-such-mode")).kind, "busy");

  /*
   * **The fifth method, which arrived exactly as the marker's docblock predicted.**
   *
   * A cancel inside this window would notify the id `session/close` is about to
   * destroy — stopping nothing, and looking from outside like an agent ignoring
   * it. `busy` and not `no_turn`, which is the answer the other guard order would
   * have given: a clear holds no turn, so testing `turn === null` first would tell
   * the caller "nothing is running, you have what you asked for" about a session
   * in the middle of an ACP round trip.
   */
  check("and a cancel beside an in-flight clear is refused too", (await managed.cancelTurn()).kind, "busy");
  const cancelRefused = await clearApp.fetch(
    new Request(`http://d/sessions/${managed.id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenFor("u_alice")}` },
    }),
  );
  const cancelBody = (await cancelRefused.json()) as any;
  check(
    "over HTTP with the same code a config change gets, for the same reason",
    [cancelRefused.status, cancelBody?.error?.code],
    [409, "session_busy"],
  );

  const done = await clearing;
  check("the clear itself still lands", done.kind, "cleared");
  check("on a conversation the agent gave us", managed.agentSessionId, "conv_2");
  check("with the one it replaced closed rather than leaked", closed, ["conv_1"]);
  /*
   * And the marker is released in a `finally`, which is what stops a clear that
   * failed from leaving the session refusing every prompt for the rest of its
   * life. This is the control: without it every assertion above passes for a
   * session that has simply stopped accepting anything.
   */
  const after = await sendText("now it lands");
  check("and the session takes messages again once it is over", after.status, 202);
  /*
   * The control for the five `busy` answers above, and it is the same one the
   * prompt half gets: without it every assertion here passes for a session that
   * has simply stopped accepting anything. `unknown_mode` rather than `ok`
   * because this stub agent advertises no modes at all — which is exactly what
   * makes it the control, since it is the *validation* the guard was standing in
   * front of, now reached.
   */
  check("and config changes reach their own validation again", (await managed.setMode("plan")).kind, "unknown_mode");
  check("on the new conversation rather than the one that was closed", managed.agentSessionId, "conv_2");
  check("with exactly two conversations opened in total", conversations, 2);

  await clearRegistry.shutdown();
}

/* ------------------------------------------------------------------ *
 * The one control that is not the agent's
 * ------------------------------------------------------------------ */

process.stdout.write("\nwhat the agent says after its turn has ended\n");
{
  /*
   * ⭐ **A conversation stopped dead while the agent went on working, and then a
   * message produced five minutes of dialog that had nothing to do with it.**
   *
   * `session/prompt` resolves while claude drives work it has spawned. The
   * generator in `Session.prompt` returns on `turn_end`, and everything the agent
   * emitted after that went into an `EventQueue` whose only consumer had gone —
   * held until the *next* prompt started a new generator, which drained the whole
   * backlog in one microtask cascade. Measured on a live log: `turn_end` at seq
   * 835, then 294,907 ms of silence, then a `prompt` at seq 836 followed by 57
   * events all stamped inside a **2 ms** span, whose content was the agent saying
   * "waiting on the reviewers" over and over. Past `MAX_BUFFERED_EVENTS` it was not
   * held at all — the head was shifted and replaced by an error placeholder.
   *
   * The agent below is that behaviour reduced: it answers `session/prompt` at once
   * and keeps talking afterwards, on demand.
   */
  const acp = await import("@agentclientprotocol/sdk");
  /** Pushed by the test between turns; each entry becomes one `session/update`. */
  const hook: {
    emit: (update: Record<string, unknown>) => void;
    stderr: (line: string) => void;
  } = { emit: () => {}, stderr: () => {} };

  const spawnTalkative = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const stderr = new PassThrough();
    hook.stderr = (line) => void stderr.write(`${line}\n`);
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    let sessionId = "conv_1";
    hook.emit = (update) => send({
      jsonrpc: "2.0",
      method: acp.methods.client.session.update,
      params: { sessionId, update },
    });
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        const params = (message["params"] ?? {}) as Record<string, any>;
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: { sessionCapabilities: { resume: {} } },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.session.new:
            sessionId = params["sessionId"] === undefined ? sessionId : String(params["sessionId"]);
            send({ jsonrpc: "2.0", id, result: { sessionId, modes: null, configOptions: [] } });
            break;
          case acp.methods.agent.session.prompt:
            // Answered at once, which is the whole premise: the turn is over and
            // the agent is not.
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return {
      stdin: toAgent,
      stdout: toClient,
      stderr,
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    } as unknown as AgentProcess;
  };

  class TalkativeRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnTalkative();
    }
  }

  const store = new MemoryEventStore();
  const talkRegistry = new SessionRegistry(store, null, undefined, new TalkativeRuntime());
  const talkDir = tmp("draincheck-");
  const managed = await talkRegistry.create({ agent: "kimi", cwd: talkDir });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
  const say = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const texts = (): string[] =>
    managed.log
      .read(0, 10_000, 4 * 1024 * 1024)
      .filter((stored) => stored.event.type === "text")
      .map((stored) => (stored.event as unknown as { text: string }).text);

  managed.prompt("go");
  await settle();
  check("the turn ends by itself", managed.status, "idle");

  /*
   * The bug, exactly: the agent talks with no turn in flight. Before the drain
   * these three landed nowhere until somebody sent another message.
   */
  hook.emit(say("still working on it"));
  hook.emit(say("nearly there"));
  await settle();
  check(
    "what the agent says after the turn is recorded without a second prompt",
    texts(),
    ["still working on it", "nearly there"],
  );
  check("and the session is still idle, because the turn really did end", managed.status, "idle");

  /*
   * Order is arrival order, and it is checked over a burst large enough that the
   * old code would not merely have delayed it — `MAX_BUFFERED_EVENTS` is 2000, and
   * past that the head was shifted out and replaced by an error placeholder, so
   * this is the half of the bug that lost content rather than postponing it.
   */
  for (let index = 0; index < 2_500; index += 1) hook.emit(say(`burst ${index}`));
  await settle();
  const burst = texts().slice(2);
  check("a burst past the queue's own bound loses nothing", burst.length, 2_500);
  check("and arrives in the order it was sent", [burst[0], burst[2_499]], ["burst 0", "burst 2499"]);

  /*
   * ⚠ **`agent_log` and `other` are dropped out of turn, and that is today's
   * behaviour preserved rather than a new loss.** They were exactly what the queue
   * evicted first, which is why a count over five of this fleet's database
   * snapshots — 95,618 events — holds zero `agent_log` rows. Recording them now
   * would put an unbounded stderr stream into a log that is deliberately
   * unbounded, and spend the tab's 16 MiB ceiling and `ATTACH_REPLAY_MAX`, both of
   * which evict from the oldest, on machinery nothing draws.
   */
  const before = managed.log.read(0, 10_000, 4 * 1024 * 1024).length;
  // An `other` (an update shape nothing here models) and an `agent_log` (a line on
  // the agent's stderr) — the exact two the queue evicted first.
  hook.emit({ sessionUpdate: "session_info_update", info: { title: "ignored" } });
  hook.stderr("[debug] a line nothing draws");
  await settle();
  check("machinery nobody draws is not recorded out of turn", managed.log.read(0, 10_000, 4 * 1024 * 1024).length, before);

  // And the next turn still works, which is what proves the hand-back: the drain
  // holds the queue right up to the moment `prompt` claims it.
  managed.prompt("again");
  await settle();
  hook.emit(say("after the second turn"));
  await settle();
  check("a later turn takes the queue back and gives it back again", texts().at(-1), "after the second turn");

  await talkRegistry.shutdown();
}

process.stdout.write("\nwho owns a session's events\n");
{
  /*
   * The handover itself, driven through `Session.prompt` rather than asserted on
   * the queue — `EventQueue` is module-private, and the property that matters is
   * the one a caller can observe: two turns cannot both be consuming.
   *
   * ⚠ The release is identity-checked, and that is the load-bearing half. A stale
   * release clearing the turn's hold would route a live turn's events to a drain,
   * park its generator for ever and pin `ManagedSession.turn` — `409
   * turn_in_flight` for the rest of the session's life, with nothing running.
   */
  const acp = await import("@agentclientprotocol/sdk");
  const hook: { emit: (update: Record<string, unknown>) => void; answer: () => void } = {
    emit: () => {},
    answer: () => {},
  };

  const spawnHeld = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    hook.emit = (update) => send({
      jsonrpc: "2.0",
      method: acp.methods.client.session.update,
      params: { sessionId: "conv_1", update },
    });
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: { sessionCapabilities: { resume: {} } },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.session.new:
            send({ jsonrpc: "2.0", id, result: { sessionId: "conv_1", modes: null, configOptions: [] } });
            break;
          case acp.methods.agent.session.prompt:
            // Held open until the test says so, so the turn is genuinely in flight
            // while events are emitted at it.
            hook.answer = () => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    } as unknown as AgentProcess;
  };

  class HeldRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnHeld();
    }
  }

  const heldRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new HeldRuntime());
  const heldDir = tmp("owncheck-");
  const managed = await heldRegistry.create({ agent: "kimi", cwd: heldDir });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
  const say = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const texts = (): string[] =>
    managed.log
      .read(0, 10_000, 4 * 1024 * 1024)
      .filter((stored) => stored.event.type === "text")
      .map((stored) => (stored.event as unknown as { text: string }).text);

  /*
   * ⚠ **`session_started` has moved, and this is where that is written down.**
   *
   * It is pushed by `Session.adopt`, i.e. before `onStarted` runs — and until there
   * was a drain, nothing read the queue until the first prompt, so it landed in the
   * log *after* that prompt's own event. Every version of this daemon's notes says
   * so, and it is why the registry appends its own `status` row at seq 1. It now
   * lands where it happens. Nothing draws it (`TRANSCRIPT_SILENT`), so this is a
   * fact about the log rather than about a screen — pinned because the old order is
   * asserted in prose in several places and somebody will check.
   */
  const kinds = (): string[] =>
    managed.log.read(0, 100, 1024 * 1024).map((stored) => stored.event.type);
  check(
    "a session's start is logged when it starts, not at the first prompt",
    kinds().slice(0, 5),
    ["workspace", "status", "agent_config", "status", "session_started"],
  );

  // A drain is running: the agent has been adopted and no turn has started.
  hook.emit(say("before any turn"));
  await settle();
  check("a drain reads before the first prompt", texts(), ["before any turn"]);

  managed.prompt("work");
  await settle();
  check("and a turn takes the queue from it", managed.status, "running");
  hook.emit(say("inside the turn"));
  await settle();
  check("what arrives inside a turn is recorded once, by the turn", texts(), ["before any turn", "inside the turn"]);

  hook.answer();
  await settle();
  check("the turn hands the queue back when it ends", managed.status, "idle");
  hook.emit(say("after the turn"));
  await settle();
  check("and the drain has it again", texts().at(-1), "after the turn");

  await heldRegistry.shutdown();
}

process.stdout.write("\nultracode, which claude offers and ACP has no field for\n");

{
  const effort = (choices: string[], value = "default") => ({
    modes: null,
    options: [
      {
        id: "mode",
        name: "Mode",
        description: null,
        category: "mode",
        kind: "select" as const,
        value: "default",
        choices: [{ value: "default", name: "Default", description: null, group: null }],
      },
      {
        id: "effort",
        name: "Effort",
        description: null,
        category: "thought_level",
        kind: "select" as const,
        value,
        choices: choices.map((choice) => ({ value: choice, name: choice, description: null, group: null })),
      },
    ],
  });
  const claude = effort(["default", "low", "medium", "high", "xhigh", "max"]);

  // What goes on the wire, which is the only thing the agent ever sees of this.
  check("claude is asked for it in the one shape its adapter reads", sessionMetaFor("claude", { ultracode: true }), {
    claudeCode: { options: { settings: { ultracode: true } } },
  });
  check("and asked nothing at all when it is off", sessionMetaFor("claude", { ultracode: false }), undefined);
  check("kimi is never asked, whatever the session says", sessionMetaFor("kimi", { ultracode: true }), undefined);
  check("nor codex", sessionMetaFor("codex", { ultracode: true }), undefined);

  // Which control the extra row belongs on — by category, never by id.
  check("the row goes on claude's effort control", ultracodeOptionId(claude, "claude"), "effort");
  check(
    "and not on a model that cannot carry it, which is the agent's own answer",
    ultracodeOptionId(effort(["default", "low", "medium", "high"]), "claude"),
    null,
  );
  check("kimi gets no row", ultracodeOptionId(effort(["low", "xhigh"]), "kimi"), null);
  check("nor codex", ultracodeOptionId(effort(["low", "xhigh"]), "codex"), null);
  check(
    "an agent with no effort control at all gets none either",
    ultracodeOptionId({ modes: null, options: [] }, "claude"),
    null,
  );
  check(
    "and an agent that ships its own ultracode takes the row back",
    ultracodeOptionId(effort(["low", "xhigh", ULTRACODE_CHOICE]), "claude"),
    null,
  );

  const off = withUltracode(claude, "claude", false);
  const on = withUltracode(claude, "claude", true);
  const effortOf = (config: { options: { id: string }[] }) =>
    config.options.find((option) => option.id === "effort") as never as {
      value: string;
      choices: { value: string }[];
    };
  check(
    "the row is drawn whether or not it is chosen",
    [effortOf(off).choices.map((choice) => choice.value), effortOf(on).choices.at(-1)?.value],
    [["default", "low", "medium", "high", "xhigh", "max", ULTRACODE_CHOICE], ULTRACODE_CHOICE],
  );
  check("and it is the selection while it is on", effortOf(on).value, ULTRACODE_CHOICE);
  check("while off leaves the agent's own value alone", effortOf(off).value, "default");
  check("nothing else on the strip moves", off.options[0], claude.options[0]);
  check(
    "and a session on an agent with no row is untouched, object for object",
    withUltracode(claude, "kimi", true) === claude,
    true,
  );

  /*
   * The property the whole split rests on: the overlay is for drawing, and the
   * state `setConfigOption` validates against never grows this choice. Mutating
   * the input here is the one mistake that would let `"ultracode"` through
   * validation and out to the agent as an ordinary value — which is precisely
   * what it must never be, since the agent has never heard of it.
   */
  check(
    "the live config the daemon validates against is not touched",
    claude.options[1]?.choices.map((choice) => choice.value),
    ["default", "low", "medium", "high", "xhigh", "max"],
  );

  /*
   * And the exit reason the restart writes. `config_changed` is a *daemon* exit:
   * nobody asked for the session to end, so if the resume that follows never
   * lands, the boot pass owes it another try.
   */
  /*
   * And what actually goes on the wire, which no listener can see.
   *
   * `_meta` is a *request* parameter, so the only way to observe it is to be the
   * agent. The checks above prove the shape; this proves `Session` spreads it onto
   * `session/new` at all — the wiring between them, which is where a boolean that
   * never reaches `sessionMetaFor` would hide with every unit test still green.
   */
  const acp = await import("@agentclientprotocol/sdk");
  const { Session } = await import("../src/session.js");
  const { PassThrough } = await import("node:stream");
  const opened: any[] = [];
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  let line = "";
  toAgent.on("data", (chunk: Buffer) => {
    line += chunk.toString("utf8");
    for (let nl = line.indexOf("\n"); nl >= 0; nl = line.indexOf("\n")) {
      const message = JSON.parse(line.slice(0, nl)) as Record<string, any>;
      line = line.slice(nl + 1);
      const reply = (result: unknown) =>
        toClient.write(`${JSON.stringify({ jsonrpc: "2.0", id: message["id"], result })}\n`);
      if (message["method"] === acp.methods.agent.initialize) {
        reply({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] });
      } else if (message["method"] === acp.methods.agent.session.new) {
        opened.push(message["params"]);
        reply({ sessionId: "s_meta" });
      } else if (message["id"] !== undefined) {
        reply({});
      }
    }
  });
  class MetaRuntime extends LocalRuntime {
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<any> {
      return {
        stdin: toAgent,
        stdout: toClient,
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        hasExited: false,
        waitForExit: async () => true,
        endStdin: () => toAgent.end(),
        kill: async () => {},
      };
    }
  }
  const asking = await Session.start({
    agent: "claude",
    cwd: process.cwd(),
    runtime: new MetaRuntime(),
    ultracode: true,
  });
  await asking.dispose().catch(() => {});
  check("the flag reaches session/new in the shape claude's adapter reads", opened[0]?._meta, {
    claudeCode: { options: { settings: { ultracode: true } } },
  });
  check("beside the parameters that were always there", [opened[0]?.cwd === process.cwd(), opened[0]?.mcpServers], [
    true,
    [],
  ]);

  const changed = { reason: "config_changed" as const, at: now, detail: null, agentHandle: null, agentConfirmedDead: true };
  check("a restart for a setting is resumed at the next boot", autoResumable(changed, "conv_1", "boot"), true);
  check("and on the next prompt", autoResumable(changed, "conv_1", "prompt"), true);
  check("and reads as interrupted rather than ended", endedWithDaemon(changed), true);
}

process.stdout.write("\nthe mode a person chose, across the restart a setting causes\n");
{
  /*
   * ⭐ **Choosing `ultracode` on the effort control put the *mode* back to Manual.**
   *
   * Two controls that have nothing to do with each other, and the coupling is the
   * restart: `applyUltracode` is `stop("config_changed")` then `resume()`, `doStop`
   * clears `agentConfigState`, and `onStarted` assigns whatever the fresh
   * conversation published — which for claude is the mode it calls `Manual`.
   * `/clear` has had `Session.restoreConfig` for exactly this since it was written;
   * this path did the structurally identical thing with the capture missing.
   *
   * The agent below is the measured shape of all three: it answers `session/set_mode`
   * and remembers the answer for as long as this *process* lives, so a fresh one
   * starts back at `default` — which is what makes the assertion about a restart
   * rather than about a variable.
   */
  const acp = await import("@agentclientprotocol/sdk");
  /*
   * ⚠ **The vocabulary narrows across the restart, and it has to.**
   *
   * `restoreConfig`'s two withdrawal guards ask whether the conversation that came
   * up still *offers* what is being put back — and with one fixture handing every
   * conversation the identical lists, neither guard can ever refuse and the option
   * loop never even reaches `setConfigOption`, because `now.value === option.value`
   * skips it a line earlier. Measured by mutation: reverting the option guard to
   * `option.choices` (the predicate the docblock calls true by construction) and
   * deleting the mode guard outright left this driver **all green**.
   *
   * So the first conversation is wide and every one after it is narrow, which is
   * the real shape the guards name: claude drops `bypassPermissions` from its modes
   * under root, and an agent restart can land on a new binary with fewer choices.
   */
  let conversations = 0;
  const wide = (): boolean => conversations <= 1;
  const modes = () =>
    wide()
      ? [
          { id: "default", name: "Manual", description: null },
          { id: "acceptEdits", name: "Accept Edits", description: null },
          { id: "bypassPermissions", name: "Bypass Permissions", description: null },
        ]
      : [
          { id: "default", name: "Manual", description: null },
          { id: "acceptEdits", name: "Accept Edits", description: null },
        ];
  /*
   * ⚠ `effort` keeps **all three** choices on every conversation, and `xhigh` is
   * the reason: `ultracodeOptionId` reads it as a capability test off the agent's
   * own answer, so narrowing it away takes the ultracode row off the control and
   * every toggle below answers `invalid_value`. The narrowing that tests the option
   * guard is therefore carried by a second control, and effort carries the restart
   * and the positive path.
   */
  const effort = (value: string) => ({
    id: "effort",
    name: "Effort",
    description: null,
    category: "thought_level",
    type: "select",
    currentValue: value,
    options: [
      { value: "default", name: "default", description: null },
      { value: "high", name: "high", description: null },
      { value: "xhigh", name: "xhigh", description: null },
    ],
  });
  /** The control that loses a choice across the restart. */
  const verbosity = (value: string) => ({
    id: "verbosity",
    name: "Verbosity",
    description: null,
    category: "output_style",
    type: "select",
    currentValue: value,
    options: wide()
      ? [
          { value: "terse", name: "terse", description: null },
          { value: "normal", name: "normal", description: null },
          { value: "verbose", name: "verbose", description: null },
        ]
      : [
          { value: "terse", name: "terse", description: null },
          { value: "normal", name: "normal", description: null },
        ],
  });

  /**
   * What the daemon actually sent, which is the only thing that can tell a guard
   * that refused from a value that happened to match.
   *
   * Outside `spawnModal` so it survives the restart the whole block is about.
   */
  const sent: string[] = [];

  /**
   * Fired once, from inside the fixture, on the first RPC `restoreConfig` makes.
   *
   * The only deterministic way into the window `restarting` closes. Racing it from
   * the test lands in the *stop* phase, where `stopRequested` refuses with
   * `terminal` all by itself — the honest answer there, and not the one this is
   * about. The window that needs a marker is strictly later: after `onStarted` has
   * assigned the new agent and while the restore is still putting values back, at
   * which point the fixture receiving a restore call *is* that moment.
   */
  let restoreHook: (() => void) | null = null;
  const fireRestoreHook = (): void => {
    const armed = restoreHook;
    if (armed === null) return;
    restoreHook = null;
    armed();
  };

  /**
   * Fired once, on the conversation-opening RPC of a restart — i.e. inside the
   * window with **no agent at all**, before `onStarted` has published anything.
   *
   * Deliberately not keyed on `session/resume`: nothing in this block ever sends a
   * prompt, so `turnCounter === 0` makes `conversationKnownEmpty` true and the
   * restart **opens** a conversation rather than resuming one. Keyed on the method
   * it never fired at all, and the assertion passed vacuously on `<the hook never
   * fired>` being compared to nothing. What scopes it is the arming, not the method.
   *
   * The other half of {@link restoreHook}, and it guards the opposite mistake. The
   * hold that stops the mode flashing must not extend backwards over this window:
   * an empty config is how a client is told there is nobody to ask, and
   * `packages/web`'s `drawnControls` reads it as `stale` and draws its own memory
   * dimmed and untappable. Serve the held config here and those chips become
   * enabled, onto a certain 409.
   *
   * Armed only when a test wants it, so the very first `session/new` — which
   * happens inside `registry.create`, before `managed` is even assigned — fires
   * nothing.
   */
  let resumeHook: (() => void) | null = null;
  const fireResumeHook = (): void => {
    const armed = resumeHook;
    if (armed === null) return;
    resumeHook = null;
    armed();
  };

  const spawnModal = (): AgentProcess => {
    // Per *process*, which is the whole point: this is the state that does not
    // survive, exactly as a real agent's does not.
    let mode = "default";
    let level = "default";
    let verb = "terse";
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        const params = (message["params"] ?? {}) as Record<string, any>;
        const state = () => ({
          sessionId: String(params["sessionId"] ?? "conv_1"),
          modes: { currentModeId: mode, availableModes: modes() },
          configOptions: [effort(level), verbosity(verb)],
        });
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: { sessionCapabilities: { resume: {} } },
                authMethods: [],
              },
            });
            break;
          case acp.methods.agent.session.new:
          case acp.methods.agent.session.resume:
            // Before the answer, so the snapshot it samples is the one taken while
            // this daemon genuinely has no agent — `onStarted` runs off this reply.
            fireResumeHook();
            // Counted before `state()` reads it, so the conversation this answer
            // describes is the one the count names.
            conversations += 1;
            send({ jsonrpc: "2.0", id, result: state() });
            break;
          case acp.methods.agent.session.setMode:
            fireRestoreHook();
            sent.push(`mode=${String(params["modeId"])}`);
            mode = String(params["modeId"]);
            send({ jsonrpc: "2.0", id, result: {} });
            break;
          case acp.methods.agent.session.setConfigOption:
            fireRestoreHook();
            sent.push(`${String(params["configId"])}=${String(params["value"])}`);
            if (String(params["configId"]) === "effort") level = String(params["value"]);
            if (String(params["configId"]) === "verbosity") verb = String(params["value"]);
            send({ jsonrpc: "2.0", id, result: { configOptions: [effort(level), verbosity(verb)] } });
            break;
          case acp.methods.agent.session.prompt:
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    } as unknown as AgentProcess;
  };

  class ModalRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "claude", displayName: "fake", available: true, loggedIn: true, hint: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnModal();
    }
  }

  const modalRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new ModalRuntime());
  const modalDir = tmp("modecheck-");
  const managed = await modalRegistry.create({ agent: "claude", cwd: modalDir });
  const modeOf = (): string => managed.snapshot().agentConfig?.modes?.current ?? "<none>";
  const optionOf = (id: string): string =>
    String(managed.snapshot().agentConfig?.options.find((option) => option.id === id)?.value ?? "<none>");
  const effortOf = (): string => optionOf("effort");

  check("a fresh conversation starts on the agent's own mode", modeOf(), "default");
  check("and its own effort", effortOf(), "default");

  /*
   * ⭐ **What the restore may *not* put back, which is the half no driver reached.**
   *
   * Both choices below exist only on the wide first conversation. The restart lands
   * on a narrow one, so replaying either would send the agent a value it does not
   * offer — refused over the wire, and then swallowed at `restoreConfig`'s own
   * `.catch(() => {})`, so the failure is silent in both directions. Asserted on
   * `sent` rather than on the snapshot, because a guard that refused and a value
   * that happened to match read identically from outside.
   */
  await managed.setMode("bypassPermissions");
  await managed.setConfigOption("verbosity", "verbose");
  check("the wide conversation takes both", [modeOf(), optionOf("verbosity")], ["bypassPermissions", "verbose"]);
  sent.length = 0;
  await managed.setConfigOption("effort", "ultracode");
  check("a restart onto a narrower agent replays nothing it withdrew", sent, []);
  check("so the mode is the new conversation's own, not one nothing accepted", modeOf(), "default");
  check("and so is the option", optionOf("verbosity"), "terse");

  // And back off, to land on a narrow conversation for the positive round below —
  // where every value *is* still offered and the restore has to fire.
  await managed.setConfigOption("effort", "default");
  await managed.setMode("acceptEdits");
  check("which takes what somebody chooses", modeOf(), "acceptEdits");
  await managed.setConfigOption("effort", "high");
  await managed.setConfigOption("verbosity", "normal");
  sent.length = 0;

  // The reported bug, exactly. `ultracode` is intercepted before it reaches the
  // agent and restarts it; the mode is a different control and must not move.
  /*
   * ⭐ **The window `restarting` closes, driven rather than described.**
   *
   * Fired from inside the restore, which is the only moment it means anything:
   * every other guard has gone quiet by then — `stopRequested` is cleared,
   * `terminal` is false, `session` is non-null and `clearing` was never set — so
   * without the marker this `setMode` **succeeds and answers 200**, and the restore
   * still in flight puts the pre-restart mode back over it with nothing recorded
   * anywhere. That is `clearing`'s own documented `/clear` defect, reproduced on
   * the one path `clearing` does not cover.
   *
   * Collected into an array rather than a variable so "the hook never fired" is a
   * distinguishable answer: an assertion that passes because nothing ran is the
   * shape this whole block was added to remove.
   */
  const raced: { kind: string }[] = [];
  /*
   * ⭐ **The mode chip flashed `Manual` for the whole restart, and this is where it
   * was visible.**
   *
   * `onStarted` assigns the *fresh* conversation's own config, and `restoreConfig`
   * does not run until several fan-outs later — so between them the snapshot said
   * the mode was the agent's own default. Not one bad frame: every touch in that
   * window composes from the same field, so a client had no frame to hold against
   * and drew `Manual` until the mode's own round trip landed.
   *
   * Sampled from `restoreHook`, which fires on the restore's **first** RPC —
   * strictly after `onStarted` and strictly before the mode is put back, i.e.
   * inside the flash. Reads `default` without the fix, which is the report verbatim.
   */
  const duringRestore: string[] = [];
  restoreHook = () => {
    duringRestore.push(modeOf(), optionOf("verbosity"));
    void managed.setMode("default").then((result) => void raced.push(result));
  };
  // The opposite mistake, sampled in the same restart: while there is no agent the
  // snapshot must still report none, or a client draws enabled chips onto a 409.
  const duringStop: string[] = [];
  resumeHook = () => {
    const snap = managed.snapshot();
    duringStop.push(
      snap.agentConfig?.modes?.current ?? "<none>",
      String(snap.agentConfig?.options.length ?? -1),
      snap.status,
    );
  };
  // Every frame fanned out across the whole restart, for the totality check below.
  const frames: string[] = [];
  const unwatch = managed.watch((snap) => void frames.push(snap.agentConfig?.modes?.current ?? "<none>"));
  const toggled = await managed.setConfigOption("effort", "ultracode");
  unwatch();
  check(
    "the mode does not flash to the fresh agent's own while the restore runs",
    duringRestore[0] ?? "<the hook never fired>",
    "acceptEdits",
  );
  check(
    "and the controls held are the ones the restore is putting back",
    duringRestore[1] ?? "<the hook never fired>",
    "normal",
  );
  check(
    "the window with no agent still reports none, so a client draws its own memory",
    duringStop.slice(0, 2),
    ["<none>", "0"],
  );
  check("which is the state it is drawn over", duringStop[2] ?? "<the hook never fired>", "starting");
  /*
   * The totality form, and the one that catches the next fan-out somebody adds
   * between `onStarted` and the release without routing it through `snapshot()`.
   * `<none>` is expected and correct — that is the empty window above.
   */
  check("and no frame anywhere in the restart carries the fresh agent's own mode", frames.includes("default"), false);
  check(
    "a mode chosen while the agent is restarting is refused",
    raced[0]?.kind ?? "<the hook never fired>",
    "busy",
  );
  // Deliberately weaker than it looks, and paired rather than standalone: this
  // reads `acceptEdits` whether the refusal above happened or the change landed and
  // was overwritten. That is the point — the silent revert is *indistinguishable*
  // from the outside, which is why the assertion that carries the rule is the one
  // on the caller's own answer.
  check("and the mode is the one chosen before the restart either way", modeOf(), "acceptEdits");
  /*
   * The positive path, which the withdrawal assertions above cannot stand for: the
   * loop has to *reach* `setConfigOption`, and with one vocabulary it never did —
   * `now.value === option.value` skipped it a line earlier on every conversation.
   */
  check("a value the new conversation still offers is put back", sent.includes("effort=high"), true);
  check("and so is one on a control that lost a *different* choice", sent.includes("verbosity=normal"), true);
  check("and so is the mode", sent.includes("mode=acceptEdits"), true);
  check("turning ultracode on is accepted", toggled.kind, "ok");
  check("and the mode somebody chose survives the restart it causes", modeOf(), "acceptEdits");
  /*
   * Read off the snapshot the call itself returned, not off a later poll: the
   * restore is awaited *inside* `applyUltracode`, so a client folding this response
   * never sees the agent's default. Without that, the fix would still be right and
   * the screen would still flash "Manual".
   */
  check(
    "and it is in the answer the caller already has",
    toggled.kind === "ok" ? (toggled.config?.modes?.current ?? "<none>") : "<not ok>",
    "acceptEdits",
  );
  check("with ultracode reported as the effort, which the agent cannot report itself", effortOf(), "ultracode");

  // And back off again, which is the same restart in the other direction.
  await managed.setConfigOption("effort", "default");
  check("turning it off keeps the mode too", modeOf(), "acceptEdits");

  {
    /*
     * ⭐ **Sending a message during a restart waits it out; it is not refused.**
     *
     * Somebody flips ultracode and then types. They did not ask for a restart, and
     * with the spinner gone and the strip drawing the change as already done, they
     * cannot see one either — so `409 turn_in_flight` was the daemon refusing a
     * message on account of work it had started itself.
     *
     * Driven through the **real route** rather than `ManagedSession`, because that
     * is where the wait lives and the placement is the rule: `ManagedSession.prompt`
     * is synchronous by contract — it sets `turn` before any await — so the route is
     * the only place a transparent step can go. Asserted both ways below.
     */
    const { app } = createApp({
      registry: modalRegistry,
      verifier,
      instanceId: "i_modal",
      startedAt: now,
      credentials,
      roots: [modalDir],
    });
    // `Promise.resolve` because `app.fetch` is typed `Response | Promise<Response>`.
    const send = async (text: string): Promise<Response> =>
      await app.fetch(
        new Request(`http://d/sessions/${managed.id}/prompt`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokenFor("u_alice")}`, "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }),
      );

    // Fired from inside the restore, the one window that is unambiguously mid-restart.
    const sessionSaid: string[] = [];
    const inFlight: Promise<Response>[] = [];
    restoreHook = () => {
      // The session's own answer, which must stay a refusal: it is what makes the
      // route's 409 exact for a real turn, and waiting there would put an await in
      // front of the assignment that guard depends on.
      sessionSaid.push(managed.prompt("during").kind);
      inFlight.push(send("during the restart"));
    };
    await managed.setConfigOption("effort", "ultracode");
    check("the session itself still refuses a prompt mid-restart", sessionSaid[0] ?? "<the hook never fired>", "busy");
    const answered = inFlight[0] === undefined ? null : await inFlight[0];
    check("but the route waits and sends it", answered?.status ?? -1, 202);
    check("and by the time it lands the restart is over", modeOf(), "acceptEdits");
  }

  await modalRegistry.shutdown();
}

process.stdout.write("\ntwo config changes at once\n");
{
  /*
   * ⭐ **Two changes in flight corrupted the config, and nothing on the daemon
   * stopped them.**
   *
   * `Session.updateConfig` replaces the option list *wholesale* with whatever the
   * response carried — correctly, since ACP defines `configOptions` as the complete
   * list. So with A and B overlapping, whichever response landed last won, and it
   * had been computed by the agent before the other change existed: the session
   * then reported a configuration that never was, and kept reporting it.
   *
   * The only thing holding it off was `locked` in `AgentConfigBar`, which is half a
   * guard — the composer's `/model` and `/effort` menus call `applyConfigChange`
   * directly and never see it, and `pnpm client config` knows of no such thing. So
   * this was reachable in a browser by choosing on the strip and then in the menu.
   *
   * The agent below is that race reduced: it applies each change on arrival and
   * answers with both options, and the first answer can be held so the second
   * overtakes it. Held rather than delayed by a timer, so the ordering is decided
   * by the test rather than by a race the test would also have.
   */
  const acp = await import("@agentclientprotocol/sdk");
  /** Requests the agent has actually received, which is what serialization is about. */
  const seen: string[] = [];
  const held: (() => void)[] = [];
  let holdNext = false;

  const spawnPair = (): AgentProcess => {
    const state: Record<string, string> = { a: "a0", b: "b0" };
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): void => void toClient.write(`${JSON.stringify(message)}\n`);
    const options = () =>
      ["a", "b"].map((id) => ({
        id,
        name: id.toUpperCase(),
        description: null,
        category: id === "a" ? "model" : "thought_level",
        type: "select",
        currentValue: state[id],
        options: [`${id}0`, "X", "Y"].map((value) => ({ value, name: value, description: null })),
      }));
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        const params = (message["params"] ?? {}) as Record<string, any>;
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new:
            send({ jsonrpc: "2.0", id, result: { sessionId: "conv_1", modes: null, configOptions: options() } });
            break;
          case acp.methods.agent.session.setConfigOption: {
            const configId = String(params["configId"]);
            seen.push(`${configId}=${String(params["value"])}`);
            // Applied on arrival, and the answer built now — so a held answer is a
            // *stale complete list*, which is exactly the shape that corrupts.
            state[configId] = String(params["value"]);
            const reply = { jsonrpc: "2.0", id, result: { configOptions: options() } };
            if (holdNext) {
              holdNext = false;
              held.push(() => send(reply));
            } else {
              send(reply);
            }
            break;
          }
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return {
      stdin: toAgent,
      stdout: toClient,
      stderr: new PassThrough(),
      handle: null,
      onceStartError: () => () => {},
      onceExit: () => () => {},
      hasExited: false,
      waitForExit: async () => true,
      endStdin: () => toAgent.end(),
      kill: async () => {},
    } as unknown as AgentProcess;
  };

  class PairRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<AgentProcess> {
      return spawnPair();
    }
  }

  const pairRegistry = new SessionRegistry(new MemoryEventStore(), null, undefined, new PairRuntime());
  const pairDir = tmp("paircheck-");
  const managed = await pairRegistry.create({ agent: "kimi", cwd: pairDir });
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));
  const valueOf = (id: string): string =>
    String(managed.snapshot().agentConfig?.options.find((option) => option.id === id)?.value ?? "<none>");

  check("both controls start where the agent put them", [valueOf("a"), valueOf("b")], ["a0", "b0"]);

  holdNext = true;
  const first = managed.setConfigOption("a", "X");
  const second = managed.setConfigOption("b", "Y");
  await settle();
  /*
   * The property itself, and the one that reads as the fix rather than as its
   * consequence: the second change has not reached the agent, because the first
   * has not been answered. Unserialized this is 2 — both are in flight, and the
   * corruption below is already inevitable.
   */
  check("a second change waits for the first to be answered", seen.length, 1);

  held[0]?.();
  await Promise.all([first, second]);
  check("both are then applied, in the order they were made", seen, ["a=X", "b=Y"]);
  /*
   * The damage, stated as the outcome somebody would report. Unserialized the
   * stale complete list lands last and `b` reads `b0` — a value nobody chose,
   * on a snapshot that keeps saying so.
   */
  check("and neither is lost to the other's answer", [valueOf("a"), valueOf("b")], ["X", "Y"]);

  /*
   * A refused change must not take the queue with it. `configChain` swallows every
   * outcome for this reason: a rejected tail would make one bad value the end of
   * that control for the life of the session.
   */
  const refused = await managed.setConfigOption("a", "nonexistent");
  check("an invalid value is refused without stopping the queue", refused.kind, "invalid_value");
  const after = await managed.setConfigOption("b", "X");
  check("so the next change still runs", after.kind, "ok");
  check("and lands", valueOf("b"), "X");

  await pairRegistry.shutdown();
}

/* ------------------------------------------------------------------------- *
 * Plugins
 *
 * Everything here runs against a **fake `PluginRuntime`** rather than a real
 * `fork`, which is the reason that interface exists at all: a timeout, a crash,
 * an exhausted restart budget and a child that never answers are the paths that
 * matter, and none of them is reachable in an offline driver by spawning a
 * process and hoping. One case at the end drives the real `ForkedPluginRuntime`,
 * so the path production takes is walked rather than assumed.
 * ------------------------------------------------------------------------- */

process.stdout.write("\nwhat a plugin manifest may say\n");
{
  const { parseManifest } = await import("../src/plugins/manifest.js");
  const { PLUGIN_API_VERSION, negotiatePluginApi } = await import("../src/plugins/protocol.js");

  const base = {
    id: "board",
    name: "Task board",
    version: "0.1.0",
    api: PLUGIN_API_VERSION,
    scopes: ["store"],
    contributes: { screen: { title: "Board" }, settings: true, actions: [], hooks: ["turn.ended"] },
  };
  const of = (patch: Record<string, unknown>): ReturnType<typeof parseManifest> =>
    parseManifest(JSON.stringify({ ...base, ...patch }));
  const codeOf = (patch: Record<string, unknown>): string => {
    const answer = of(patch);
    return answer.ok ? "ok" : answer.code;
  };

  check("a manifest this daemon can run", codeOf({}), "ok");
  check("and it comes back parsed rather than as text", of({}).ok ? of({}) : null, {
    ok: true,
    manifest: {
      id: "board",
      name: "Task board",
      version: "0.1.0",
      api: PLUGIN_API_VERSION,
      description: null,
      scopes: ["store"],
      net: [],
      contributes: { screen: { title: "Board" }, settings: true, actions: [], hooks: ["turn.ended"] },
    },
  });

  /*
   * Every refusal, because the refusals are the whole value of that file — a
   * validator whose error paths are only reachable by building a real archive is
   * a validator whose error paths are not driven. This is what `parseManifest`
   * taking *text* rather than a path buys.
   */
  // Through one narrowing rather than two calls, so the type is what proves the
  // second read is on the refusal arm rather than the caller remembering.
  const rawCode = (text: string): string => {
    const answer = parseManifest(text);
    return answer.ok ? "ok" : answer.code;
  };
  check("not JSON at all", rawCode("{"), "manifest_unreadable");
  check("JSON that is not an object", rawCode("[]"), "manifest_unreadable");
  check("an id with a capital in it", codeOf({ id: "Board" }), "manifest_invalid");
  check("an id with a slash in it", codeOf({ id: "a/b" }), "manifest_invalid");
  check("an id that is empty", codeOf({ id: "" }), "manifest_invalid");
  check("no name", codeOf({ name: "" }), "manifest_invalid");
  check("a version that is not three numbers", codeOf({ version: "1.0" }), "manifest_invalid");
  check("a version with a suffix", codeOf({ version: "1.0.0-beta" }), "manifest_invalid");
  check("an api that is not a number", codeOf({ api: "1" }), "manifest_invalid");
  check("an unknown scope", codeOf({ scopes: ["sessions.admin"] }), "manifest_invalid");
  check("a scope listed twice", codeOf({ scopes: ["store", "store"] }), "manifest_invalid");
  check("an unknown hook", codeOf({ contributes: { ...base.contributes, hooks: ["session.slept"] } }), "manifest_invalid");
  check(
    "an action with no id",
    codeOf({ contributes: { ...base.contributes, actions: [{ title: "Go", on: "session" }] } }),
    "manifest_invalid",
  );
  check(
    "an action on a surface that does not exist",
    codeOf({ contributes: { ...base.contributes, actions: [{ id: "go", title: "Go", on: "rail" }] } }),
    "manifest_invalid",
  );
  check(
    "two actions with one id",
    codeOf({
      contributes: {
        ...base.contributes,
        actions: [
          { id: "go", title: "Go", on: "session" },
          { id: "go", title: "Go again", on: "screen" },
        ],
      },
    }),
    "manifest_invalid",
  );

  /*
   * `net` and its scope have to agree in **both** directions, and neither
   * direction is the obvious one on its own: hosts with no scope is a manifest
   * that under-declares, and a scope with no hosts is one that reads, to whoever
   * is approving it, as a plugin talking to nowhere.
   */
  check("hosts listed without the scope", codeOf({ net: ["api.example.com"] }), "manifest_invalid");
  check("the scope declared with no hosts", codeOf({ scopes: ["net"] }), "manifest_invalid");
  check("the scope declared with an empty list", codeOf({ scopes: ["net"], net: [] }), "manifest_invalid");
  check("both, agreeing", codeOf({ scopes: ["net"], net: ["api.example.com"] }), "ok");
  check("a host with a scheme on it", codeOf({ scopes: ["net"], net: ["https://api.example.com"] }), "manifest_invalid");
  check("a host with a port on it", codeOf({ scopes: ["net"], net: ["api.example.com:443"] }), "manifest_invalid");
  check("an address rather than a name", codeOf({ scopes: ["net"], net: ["127.0.0.1"] }), "manifest_invalid");
  check("a name for this machine", codeOf({ scopes: ["net"], net: ["thing.localhost"] }), "manifest_invalid");

  /*
   * The two api refusals are separate codes because their remedies are opposite:
   * too old means republish the plugin, too new means update the machine. One
   * "unsupported" sends half of everybody to the wrong place.
   */
  check("an api older than this daemon accepts", codeOf({ api: 0 }), "plugin_api_too_old");
  check("an api newer than it speaks", codeOf({ api: PLUGIN_API_VERSION + 1 }), "plugin_api_too_new");
  check(
    "and the negotiation itself is a range, not an equality",
    [negotiatePluginApi(PLUGIN_API_VERSION), negotiatePluginApi(PLUGIN_API_VERSION + 1), negotiatePluginApi(-1)],
    ["ok", "too_new", "too_old"],
  );

  // Absence is the one thing repaired rather than refused, because an omitted
  // optional has an obvious meaning and a wrong value does not.
  check("no contributes at all is a plugin that contributes nothing", of({ contributes: undefined }).ok, true);
  check("and no scopes is a plugin that may do nothing", of({ scopes: undefined }).ok, true);

  /* ---------------------------------------------------------------- *
   * The other eighteen.
   *
   * `manifest.ts` refuses in **thirty-seven** places: nine in `parseManifest`
   * itself and twenty-eight spread over the five readers it delegates to. The
   * cases above drive nineteen. These are the other eighteen, plus three
   * conditions *inside* branches those already reach from the opposite side — a
   * name too long rather than empty, an api that is a number and not a whole one,
   * a screen title that is only spaces. Most of what was missing is the type
   * refusals ("must be an array", "must be a string", "must be true or false"),
   * which is the half of a hand-written validator nobody writes a case for and
   * the half a `plugin.json` written by a person hits first.
   *
   * ⚠ **Asserted on the sentence rather than on the code**, because twenty-eight
   * of the thirty-seven answer `manifest_invalid` and a case that reads only the
   * code proves a manifest was refused rather than that it was refused for the
   * reason it was written to catch — `{ contributes: { hooks: 7 } }` and
   * `{ contributes: 7 }` are the same code and different bugs. The fragment is
   * short on purpose: it names the branch and does not pin the prose around it.
   *
   * ⚠ **Nothing derives the thirty-seven and a thirty-eighth needs a line here.**
   * Those refusals are prose returned from five different helpers — a bare string,
   * a template literal, an `invalid(…)` and a `{ ok: false, code }` are all in
   * there — so a grep for them is a check on a regular expression rather than on
   * the file, which is the failure `docscheck` avoids by holding a file to what it
   * says about *itself*. The count is stated instead, and it is the reason this
   * comment is here rather than in a commit message.
   * ---------------------------------------------------------------- */
  const says = (name: string, patch: Record<string, unknown>, fragment: string): void => {
    const answer = of(patch);
    const message = answer.ok ? "(accepted)" : answer.message;
    report(name, message.includes(fragment), message);
  };
  const contributing = (patch: Record<string, unknown>): Record<string, unknown> => ({
    contributes: { ...base.contributes, ...patch },
  });

  says("a description longer than a manifest carries", { description: "x".repeat(201) }, "description must be");
  says("a name past its ceiling rather than empty", { name: "n".repeat(65) }, "name must be 1–64");
  says("an api that is a number and not a whole one", { api: 1.5 }, "api must be a whole number");
  says("scopes that are not a list", { scopes: "store" }, "scopes must be an array");
  says("a scope that is not a string", { scopes: [7] }, "every scope must be a string");
  says("net that is not a list", { scopes: ["net"], net: "api.example.com" }, "net must be an array");
  says("a net entry that is not a string", { scopes: ["net"], net: [7] }, "every net entry must be a string");
  says(
    "more hosts than a plugin talks to",
    { scopes: ["net"], net: Array.from({ length: 9 }, (_, index) => `h${index}.example.com`) },
    "net may name at most",
  );
  says(
    "the same host twice",
    { scopes: ["net"], net: ["api.example.com", "api.example.com"] },
    "is listed twice",
  );
  says("contributes that is a list", { contributes: [] }, "contributes must be an object");
  says("a screen that is a string", contributing({ screen: "Board" }), "contributes.screen must be an object");
  says("a screen title past forty", contributing({ screen: { title: "t".repeat(41) } }), "contributes.screen.title");
  says("a screen title of nothing", contributing({ screen: { title: "   " } }), "contributes.screen.title");
  says("settings that is neither", contributing({ settings: "yes" }), "contributes.settings must be true or false");
  says("actions that are not a list", contributing({ actions: {} }), "contributes.actions must be an array");
  /*
   * Eight, and the bound is on what a plugin may put on *somebody's screen*
   * rather than on what it costs to hold: a session's kebab menu has never held
   * eight rows, and a plugin able to declare forty would be a plugin able to make
   * that menu unusable for everything else on it.
   */
  says(
    "more actions than a menu has room for",
    contributing({
      actions: Array.from({ length: 9 }, (_, index) => ({ id: `a${index}`, title: "Go", on: "session" })),
    }),
    "at most 8 actions",
  );
  says("an action that is a string", contributing({ actions: ["go"] }), "every action must be an object");
  says(
    "an action with no title",
    contributing({ actions: [{ id: "go", title: "", on: "session" }] }),
    "needs a title of 1–40",
  );
  says("hooks that are not a list", contributing({ hooks: "turn.ended" }), "contributes.hooks must be an array");
  says("a hook that is not a string", contributing({ hooks: [7] }), "every hook must be a string");
  says("the same hook twice", contributing({ hooks: ["turn.ended", "turn.ended"] }), "is listed twice");
}

process.stdout.write("\nwhat a plugin may keep\n");
{
  const { checkPluginWrite, MAX_PLUGIN_KEYS, MAX_PLUGIN_DATA_BYTES, MAX_PLUGIN_VALUE_BYTES, PluginStoreError } =
    await import("../src/plugins/store.js");

  const refusal = (
    key: string,
    value: string,
    current: { keys: number; bytes: number; existing: number | null },
  ): string => {
    try {
      checkPluginWrite(key, value, current);
      return "ok";
    } catch (error) {
      return error instanceof PluginStoreError ? error.code : "threw";
    }
  };
  const empty = { keys: 0, bytes: 0, existing: null };

  check("an ordinary write", refusal("a", "1", empty), "ok");
  check("an empty key", refusal("", "1", empty), "bad_request");
  check("a key with a newline in it", refusal("a\nb", "1", empty), "bad_request");
  check("a key with a NUL in it", refusal("a\u0000b", "1", empty), "bad_request");
  check("a value over the per-value cap", refusal("a", "x".repeat(MAX_PLUGIN_VALUE_BYTES + 1), empty), "value_too_large");
  check(
    "a write that would take the plugin over its total",
    refusal("a", "x".repeat(1000), { keys: 1, bytes: MAX_PLUGIN_DATA_BYTES, existing: null }),
    "store_full",
  );
  /*
   * The replaced value is credited back before the new one is charged. Without
   * that, a plugin rewriting one key climbs to its own ceiling and stays there —
   * which is the shape of every settings pane written against this API.
   */
  check(
    "but rewriting a key charges only the difference",
    refusal("a", "x".repeat(1000), { keys: 1, bytes: MAX_PLUGIN_DATA_BYTES, existing: 1000 }),
    "ok",
  );
  check(
    "a new key past the key ceiling",
    refusal("new", "1", { keys: MAX_PLUGIN_KEYS, bytes: 0, existing: null }),
    "store_full",
  );
  check(
    "and rewriting an existing one is still allowed there",
    refusal("held", "1", { keys: MAX_PLUGIN_KEYS, bytes: 0, existing: 1 }),
    "ok",
  );
}

process.stdout.write("\nwhere a plugin's data actually lives\n");
{
  const { MAX_PLUGIN_VALUE_BYTES, PluginStoreError } = await import("../src/plugins/store.js");
  const { openStores } = await import("../src/store/sqlite.js");

  /**
   * One script, run against both implementations and compared line for line.
   *
   * ⚠ **The comparison is the point, and it is why this is a function rather than
   * a run of assertions.** Everything above this in the plugin sections drives the
   * host, the API and the quota against `memoryPluginData`, so the whole of what
   * `daemoncheck` knows about a plugin's storage is what a Map does — while what
   * the fleet runs is `LIKE … ESCAPE`, a keyset cursor and a byte budget charged
   * per row. Two of those cannot be reproduced by a Map on purpose, which is
   * exactly why the script is run against the real store *first*: the fake is
   * being held to SQLite rather than the other way round.
   *
   * A labelled record rather than an array, so a mismatch names the property
   * instead of an index and so the readouts below can be asserted one at a time.
   */
  const script = (store: PluginDataStore): Record<string, unknown> => {
    const refusal = (run: () => void): string => {
      try {
        run();
        return "ok";
      } catch (error) {
        return error instanceof PluginStoreError ? error.code : "threw";
      }
    };

    // Two plugins, one key name. Neither may see the other's, and nothing in the
    // API namespaces this — `manifest.id` is passed down and the store is what
    // keeps them apart.
    const sameKey = [
      refusal(() => store.set("one", "shared", JSON.stringify("first"))),
      refusal(() => store.set("two", "shared", JSON.stringify("second"))),
      store.get("one", "shared"),
      store.get("two", "shared"),
    ];

    /*
     * ⚠ **A key holding `%` or `_` is a key somebody wrote.** Those are `LIKE`'s
     * two wildcards, so a prefix built without the escape matches every row the
     * plugin has — `a%` would answer for `axb` and `ab` as readily as for the one
     * key it names. The fake filters with `startsWith` and *cannot* reproduce the
     * bug, which is what makes this the one property in this file that had to be
     * driven against the real store or not at all.
     */
    for (const key of ["a%b", "axb", "a_b", "ab"]) refusal(() => store.set("one", key, JSON.stringify(key)));

    /*
     * ⚠ **Mixed case, because `LIKE` folds ASCII and this column does not** — and
     * because the comment in `store/sqlite.ts` that records this defect also
     * records why the assertion above did not catch it: the fake filters with
     * `startsWith`, which is case sensitive, so **the parity line at the bottom of
     * this block passed only while every fixture key was lower case**. That is a
     * gap described in prose and left open, which is the one shape of gap this
     * file exists to close.
     *
     * These are the three keys the defect was measured with, in the order it
     * answered them: against this exact DDL `LIKE 'card:%'` gave
     * `['CARD:3', 'Card:2', 'card:1']` where the plugin had named one namespace
     * and `card:1` was the only key in it. A third plugin id so that nothing above
     * moves — `everyKey` and `unprefixed` are asserted as literals.
     */
    for (const key of ["CARD:3", "Card:2", "card:1"]) {
      refusal(() => store.set("three", key, JSON.stringify(key)));
    }

    const bounds = [
      // The shared bound, met from the far side: a value one byte past the cap,
      // an empty key, a key holding a control character.
      refusal(() => store.set("one", "big", JSON.stringify("x".repeat(MAX_PLUGIN_VALUE_BYTES)))),
      refusal(() => store.set("one", "", JSON.stringify("x"))),
      refusal(() => store.set("one", `a${String.fromCharCode(10)}b`, JSON.stringify("x"))),
    ];

    /*
     * Six rows of four thousand bytes against a ten-thousand-byte budget, which
     * puts the cut two rows in and leaves the third to the next page. Coarse on
     * purpose: SQLite charges twenty bytes of scaffolding a pair that the fake
     * does not, so a fixture whose rows were a few bytes each would have the two
     * implementations cutting in different places for a reason that says nothing
     * about either of them.
     */
    for (let index = 0; index < 6; index += 1) {
      refusal(() => store.set("two", `card:${index}`, JSON.stringify("y".repeat(4_000))));
    }
    refusal(() => store.set("two", "note", JSON.stringify("not a card")));
    const first = store.entries("two", "card:", "", 10_000);
    // The cursor is the last key of the page, echoed back rather than computed —
    // a caller deriving the next one itself is a caller guessing at a collation.
    const second = store.entries("two", "card:", String(first.entries.at(-1)?.key ?? ""), 10_000);
    const rest = store.entries("two", "card:", String(second.entries.at(-1)?.key ?? ""), 10_000);

    const answer = {
      sameKey,
      percentPrefix: store.keys("one", "a%"),
      // The half-open binary range against the same prefix, read both ways: a
      // regression to `LIKE` takes all three on SQLite and one on the fake, so it
      // fails the literal below *and* the parity line.
      casedPrefix: store.keys("three", "card:"),
      casedEntries: store.entries("three", "card:", "", 1_000_000).entries.map((one) => one.key),
      underscorePrefix: store.keys("one", "a_"),
      everyKey: store.keys("one", "a"),
      bounds,
      page: [first.entries.map((one) => one.key), first.more],
      nextPage: [second.entries.map((one) => one.key), second.more],
      lastPage: [rest.entries.map((one) => one.key), rest.more],
      // The prefix is a filter on the page as well as on the listing, or a board
      // reading its cards would get whatever else that plugin keeps. Asked with a
      // budget nothing can cut, so what this shows is the two rows the three
      // `card:` pages above never saw rather than a page that ended early.
      unprefixed: store.entries("two", "", "", 1_000_000).entries.map((one) => one.key),
      // What one card actually is, so this is a page of *pairs* rather than of
      // keys with a shape asserted about them.
      firstValue: first.entries[0]?.value === "y".repeat(4_000),
    };

    // Uninstalling is the only thing that drops data, and it drops one plugin's.
    store.dropPlugin("one");
    return { ...answer, afterDrop: [store.keys("one", ""), store.keys("two", "").length] };
  };

  const stores = openStores({ path: join(tmp("plugin-data-"), "d.db"), instanceId: "i_plugin_data" });
  const real = script(stores.pluginData);

  /*
   * ⚠ **What a key nobody set reads as, pinned on both implementations at once.**
   *
   * `PluginDataStore.get` is typed `unknown`, so the type promises nothing and a
   * plugin author has to guess. One guessed `undefined`, wrote `held !== undefined`
   * as an idempotency check, and every session took the "already done" branch —
   * for weeks, silently, because a hook that returns early leaves no key, no log
   * and no history to distinguish it from a hook that was never called. The whole
   * plugin looked dead while every part of the daemon was working.
   *
   * The two implementations already agreed — SQLite answers `null`, and
   * `memoryPluginData` answers `null` — and **nothing said so**. Two stores behind
   * one interface, agreeing by coincidence, is the pair this file exists to stop
   * drifting, and it was the one pair with no assertion on it.
   *
   * ⚠ **A stored `null` is indistinguishable from a key nobody set**, which is
   * asserted rather than left to be discovered: a plugin that needs the difference
   * has to store a wrapper, and this is the line that tells its author so before
   * they find out from a bug.
   */
  {
    const fake = memoryPluginData();
    for (const [name, store] of [["sqlite", stores.pluginData], ["the driver's own", memoryPluginData()]] as const) {
      check(`a key nobody set reads as null on ${name}, never undefined`, store.get("p", "no_such_key"), null);
    }
    fake.set("p", "held", JSON.stringify(null));
    stores.pluginData.set("p", "held", JSON.stringify(null));
    check("a stored null is the same answer as a missing key, on both", [fake.get("p", "held"), stores.pluginData.get("p", "held")], [null, null]);
    // And the value that is *not* null round-trips, so the two lines above are not
    // green about a store that answers null to everything.
    fake.set("p", "real", JSON.stringify({ a: 1 }));
    stores.pluginData.set("p", "real", JSON.stringify({ a: 1 }));
    check("while an ordinary value comes back as itself", [fake.get("p", "real"), stores.pluginData.get("p", "real")], [{ a: 1 }, { a: 1 }]);
  }

  check("one plugin's key and another's of the same name", real["sameKey"], ["ok", "ok", "first", "second"]);
  check("a prefix holding a % names one key rather than every key", real["percentPrefix"], ["a%b"]);
  check("a prefix is case sensitive, because the column is", real["casedPrefix"], ["card:1"]);
  check("and the paged read agrees with the listing about that", real["casedEntries"], ["card:1"]);
  check("and one holding an _ likewise", real["underscorePrefix"], ["a_b"]);
  check("while a prefix holding neither takes them all", real["everyKey"], ["a%b", "a_b", "ab", "axb"]);
  check("the bounds are the shared ones", real["bounds"], ["value_too_large", "bad_request", "bad_request"]);
  check("a page cut by the byte budget says so", real["page"], [["card:0", "card:1"], true]);
  check("and asking again with the last key continues rather than repeats", real["nextPage"], [["card:2", "card:3"], true]);
  check("until there is nothing left to say more about", real["lastPage"], [["card:4", "card:5"], false]);
  check("the prefix filters the page as well as the listing", real["unprefixed"], [
    "card:0",
    "card:1",
    "card:2",
    "card:3",
    "card:4",
    "card:5",
    "note",
    "shared",
  ]);
  check("and a page is pairs rather than keys", real["firstValue"], true);
  check("dropping one plugin takes its rows and only its rows", real["afterDrop"], [[], 8]);

  /*
   * ⚠ **And the fake this driver runs everything else against answers the same.**
   * `checkPluginWrite` is shared for exactly this — a quota that holds only where
   * there is a file is a quota nothing drives — and `entries` makes the same claim
   * about paging. Without this line the fake could drift into refusing less or
   * paging differently, and every plugin assertion in this file would go on
   * passing while describing a store nobody runs.
   */
  check("and the memory store the rest of this file uses answers all of it", script(memoryPluginData()), real);

  stores.close();
}

process.stdout.write("\na plugin row this build cannot read\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { parseManifest } = await import("../src/plugins/manifest.js");
  const { openStores } = await import("../src/store/sqlite.js");

  const manifestFor = (id: string): PluginManifest => {
    const parsed = parseManifest(
      JSON.stringify({ id, name: id, version: "1.0.0", api: 1, scopes: [], contributes: {} }),
    );
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.manifest;
  };

  const degraded: string[] = [];
  const stores = openStores({
    path: join(tmp("plugin-degraded-"), "d.db"),
    instanceId: "i_degraded",
    onDegraded: (detail) => degraded.push(detail),
  });
  for (const id of ["p", "q"]) {
    stores.plugins.put({
      id,
      version: "1.0.0",
      manifest: manifestFor(id),
      // Off, so opening the host below launches nothing: what is being driven is
      // a row rather than a process.
      enabled: false,
      installedAt: 1,
      updatedAt: 1,
      source: null,
    });
  }
  check("two rows, both readable", stores.plugins.list().map((one) => one.id), ["p", "q"]);
  check("and nothing to report about either", degraded.length, 0);

  /*
   * ⚠ **A downgrade, and nothing more exotic than that.** Install a plugin
   * declaring `api: 2`, roll the daemon back to a build whose
   * `PLUGIN_API_VERSION` is 1, and `negotiatePluginApi` answers `too_new` for a
   * row that was perfectly good yesterday. Written straight into the column here
   * because this build has no future api to declare — the manifest is what a
   * newer daemon would have written, and `toRecord` re-validates on **every**
   * read, which is the whole reason that column holds the manifest whole rather
   * than a field per column.
   */
  stores.db
    .prepare("UPDATE plugins SET manifest_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...manifestFor("p"), api: 9_999 }), "p");
  stores.pluginData.set("p", "card:1", JSON.stringify("kept"));

  check("the listing skips it", stores.plugins.list().map((one) => one.id), ["q"]);
  check("and so does get", stores.plugins.get("p"), null);
  report(
    "but somebody is told, once per read rather than never",
    degraded.some((one) => one.includes("plugin p") && one.includes("cannot read")),
    degraded[0] ?? "nothing reported",
  );
  /*
   * ⚠ **`has` is the method that exists because `get` cannot answer this.** Both
   * `list` and `get` report `null` for a row they cannot parse, so neither can
   * tell "nobody ever installed this" from "installed here, and unreadable by
   * this build" — and that difference is the whole of what `remove` is asking.
   * `SELECT 1`, so it parses nothing.
   */
  check("the row is still a row", [stores.plugins.has("p"), stores.plugins.has("nobody")], [true, false]);

  const registry = new SessionRegistry(stores.events, stores.sessions);
  const host = await PluginHost.open({
    root: join(tmp("plugin-degraded-root-"), "plugins"),
    records: stores.plugins,
    data: stores.pluginData,
    registry,
    api: { git: hostGit },
  });
  check("the host builds nothing for it", host.list().map((one) => one.id), ["q"]);
  check("and cannot find it", host.find("p"), null);

  /*
   * ⚠ **The one kind of plugin somebody most wants gone used to be the one kind
   * that needed a shell.** `remove` consulted `this.live`, which never held this
   * row, so `DELETE /plugins/:id` answered 404 and the row, its `plugin_data` and
   * its directory stayed on the machine for good. Falling through to the store is
   * what closes it, and the assertions after it are the closing half: a 404 that
   * turned into a 200 while leaving the row behind would be worse than the 404.
   */
  check("removing it is still possible", await host.remove("p"), true);
  check("the row goes", stores.plugins.has("p"), false);
  check("what it kept goes with it", stores.pluginData.keys("p", ""), []);
  check("its readable neighbour does not", host.list().map((one) => one.id), ["q"]);
  // The other half of the fall-through, and the reason it is not simply `true`:
  // an id nobody ever installed has no row and no directory either.
  check("and an id nobody ever installed is still a no", await host.remove("nothing"), false);

  await host.shutdown();
  await registry.shutdown();
  stores.close();
}

process.stdout.write("\nwhat a plugin returns, and what is forwarded\n");
{
  const { clampView, fitView, noteClamp, PLUGIN_BLOCK_TYPES, PLUGIN_SETTINGS_BLOCK_TYPES, PLUGIN_VIEW_LIMITS } =
    await import("../src/plugins/protocol.js");
  const { MAX_PLUGIN_MESSAGE_BYTES } = await import("../src/plugins/runtime.js");

  /*
   * The whole record, field for field, rather than a spot check — which is why
   * adding `unknownBlocks` failed here first. That is the assertion working: a new
   * field on this type is a new thing every caller of `clampView` now receives,
   * and it should not arrive without one line somewhere saying what it is on the
   * quietest possible input.
   */
  check("nothing at all is an empty view rather than a throw", clampView(null), {
    view: { title: null, refreshMs: null, blocks: [] },
    clamped: false,
    substituted: false,
    unknownBlocks: [],
  });
  check("a block this daemon does not draw is dropped", clampView({ blocks: [{ type: "canvas" }] }).view.blocks, []);
  /*
   * ⚠ **Reported as a *shape* problem, never as a size one — and this assertion
   * used to pin the wrong one of the two.**
   *
   * It read `.clamped === true`, which was written when there was a single flag
   * and never revisited when it became two. So the one check covering this line
   * asserted the same misunderstanding the code had, and the pair passed together
   * for a release.
   *
   * What it cost, measured: a real plugin returned a one-row list and a block type
   * its author had invented. Nothing exceeded any ceiling — and the screen said
   * *"some of what this plugin returned was too large to show"*, which sends
   * somebody to count rows and measure bytes when the answer is a list of five
   * type names. The invented block itself rendered as nothing and said nothing.
   *
   * Both halves are asserted, because "it is reported" is what the old line said
   * and is exactly what stayed true while being useless.
   */
  const invented = clampView({ blocks: [{ type: "canvas" }] });
  check("and dropping one is reported as a shape it does not know", invented.substituted, true);
  check("and never as something that was too large", invented.clamped, false);
  const drawn = noteClamp(invented).blocks.filter((block) => block.type === "notice");
  check(
    "so the notice a person reads names the protocol rather than the bounds",
    drawn.map((block) => (block as { text: string }).text.includes("too large")),
    [false],
  );
  /*
   * ⚠ **And it names the type, and the five that exist.** A notice that says only
   * *not a shape this machine recognises* is true and leaves an author with the
   * whole protocol to search — and an author has no copy of it, so the only way
   * left to find the cause is to obtain this repository and run `clampView` over
   * the payload by hand. That is what actually happened.
   */
  check(
    "and it names the type nobody here knows",
    drawn.map((block) => (block as { text: string }).text.includes('"canvas"')),
    [true],
  );
  check(
    "and the ones it does",
    PLUGIN_BLOCK_TYPES.every((type) => (drawn[0] as { text: string }).text.includes(type)),
    true,
  );
  /*
   * The name comes from the plugin and is repeated to a person, so it is bounded
   * on both axes: clipped for length, deduplicated, and capped in number. A
   * broken plugin can invent a different type in every one of its blocks, and
   * twenty-four names is the wall of text the notice replaced.
   */
  const many = clampView({
    blocks: [
      { type: "a".repeat(400) },
      { type: "b" },
      { type: "b" },
      { type: "c" },
      { type: "d" },
      { type: "" },
    ],
  });
  check("a long invented type is clipped before it is repeated back", (many.unknownBlocks[0] ?? "").length <= 40, true);
  check("repeats of one type are named once", many.unknownBlocks.includes("b"), true);
  check("and the list stops rather than growing with the plugin", many.unknownBlocks.length <= 3, true);
  check("every one of those blocks was still dropped", many.view.blocks, []);
  /*
   * A block with no `type` at all is the same shape problem and must not become an
   * empty pair of quotes in a sentence somebody reads.
   */
  const nameless = clampView({ blocks: [{ notype: true }] });
  check("a block with no type says so rather than naming nothing", nameless.unknownBlocks, ["(no type)"]);
  /*
   * The other direction, so the two are pinned as opposites rather than one at a
   * time: a list past its ceiling is a size clamp and says nothing about shape.
   */
  const overRows = clampView({ blocks: [{ type: "list", rows: new Array(PLUGIN_VIEW_LIMITS.rows + 1).fill({ id: "r" }) }] });
  check("a list past its ceiling is the other flag", [overRows.clamped, overRows.substituted], [true, false]);

  const rows = Array.from({ length: PLUGIN_VIEW_LIMITS.rows + 10 }, (_, index) => ({ id: String(index), title: "x" }));
  const big = clampView({ blocks: [{ type: "list", rows, empty: "" }] });
  const first = big.view.blocks[0];
  report(
    "a list past the row bound is cut rather than refused",
    first?.type === "list" && first.rows.length === PLUGIN_VIEW_LIMITS.rows,
    `${first?.type === "list" ? first.rows.length : -1} of ${rows.length} forwarded`,
  );
  check("and the cut is reported so the screen can say so", big.clamped, true);

  const long = clampView({ blocks: [{ type: "text", text: "x".repeat(PLUGIN_VIEW_LIMITS.text + 50), tone: "muted" }] });
  const text = long.view.blocks[0];
  report(
    "an oversized string is clipped",
    text?.type === "text" && text.text.length === PLUGIN_VIEW_LIMITS.text,
    `${text?.type === "text" ? text.text.length : -1} chars`,
  );
  check("and that is reported too", long.clamped, true);

  /*
   * A tone this daemon does not know falls to the ordinary one, which is the safe
   * direction: a plugin cannot make a destructive control look harmless by
   * misspelling the word, only fail to make an ordinary one look dangerous.
   */
  const toned = clampView({ blocks: [{ type: "notice", text: "hi", tone: "catastrophic" }] });
  check("an unknown tone is the ordinary one", toned.view.blocks[0], { type: "notice", text: "hi", tone: "default" });

  const field = clampView({
    blocks: [{ type: "form", submit: "Go", action: "save", fields: [{ key: "k", label: "L", kind: "quantum" }] }],
  });
  const form = field.view.blocks[0];
  check(
    "an unknown field kind becomes a text input rather than nothing",
    form?.type === "form" ? form.fields[0]?.kind : null,
    "text",
  );

  /* ---------------------------------------------------------------- *
   * ...and the bound that was enforced on the wrong side of the wire.
   *
   * ⚠ **`PLUGIN_VIEW_LIMITS` could never do its job, because `clampView` ran in
   * the host — one hop after the child had already refused to send.** The two
   * bounds sit two lines apart in the author's guide as though both applied, and
   * only `MAX_PLUGIN_MESSAGE_BYTES` ever fired: a view inside every documented
   * limit came back as "this plugin returned more than can be sent", and the
   * clamp that exists to cut it never saw it.
   *
   * Measured 2026-08-23 against a real forked child, the reference plugin and a
   * real store: its board fits at 903 cards and not at 904, while the store lets
   * a plugin keep 1000 and the session prune never removes them. `fitView` runs
   * in the child now, so the count bound applies first and a byte bound finishes
   * the job — and rows are the lever because they are the only dimension a
   * plugin's data grows without limit.
   * ---------------------------------------------------------------- */
  {
    const budget = MAX_PLUGIN_MESSAGE_BYTES - 1024;
    const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
    const rowsOf = (n: number): unknown[] =>
      Array.from({ length: n }, (_, i) => ({ id: `s_${i}`, title: "an ordinary session title", subtitle: "claude" }));

    const small = fitView({ title: "T", blocks: [{ type: "list", rows: rowsOf(10), empty: "" }] }, budget);
    check("a view that already fits is passed through untouched", small.clamped, false);

    // The board's own shape: three columns, more cards than a column may hold.
    const board = fitView(
      { title: "Board", blocks: [{ type: "columns", columns: [0, 1, 2].map(() => ({ title: "c", rows: rowsOf(400) })) }] },
      budget,
    );
    const cols = board.view.blocks[0];
    check(
      "a column past the row bound is cut to it, and says so",
      [cols?.type === "columns" ? cols.columns.map((one) => one.rows.length) : null, board.clamped],
      [[PLUGIN_VIEW_LIMITS.rows, PLUGIN_VIEW_LIMITS.rows, PLUGIN_VIEW_LIMITS.rows], true],
    );

    /*
     * A view at every documented ceiling — which the counts alone do **not** make
     * fit, and which is the half a smaller `PLUGIN_VIEW_LIMITS` could not have
     * fixed without making the honest cases smaller too.
     */
    const worst = {
      title: "W",
      blocks: Array.from({ length: PLUGIN_VIEW_LIMITS.blocks }, () => ({
        type: "columns",
        columns: Array.from({ length: PLUGIN_VIEW_LIMITS.columns }, () => ({ title: "c", rows: rowsOf(PLUGIN_VIEW_LIMITS.rows) })),
      })),
    };
    report("every count at its ceiling is still too large for the channel", bytesOf(clampView(worst).view) > budget, `${bytesOf(clampView(worst).view)} bytes clamped by counts alone`);
    const fitted = noteClamp(fitView(worst, budget));
    report("but it is cut until it fits rather than refused", bytesOf(fitted) <= budget, `${bytesOf(fitted)} bytes`);
    report(
      "and the cut is said rather than swallowed",
      JSON.stringify(fitted).includes("too large to show"),
      "the notice rides the view",
    );

    /*
     * The tail of the halving, at budgets no real channel has. It keeps the
     * largest cap that fits rather than the first that is small — one row at 200
     * bytes, none at 120 — and at a budget below even the empty block it stops
     * with nothing left rather than spinning. That last case is where `post`'s own
     * refusal is still the answer, which is why it was kept after `fitted`.
     */
    const tight = fitView({ blocks: [{ type: "list", rows: rowsOf(PLUGIN_VIEW_LIMITS.rows), empty: "" }] }, 200);
    const kept = tight.view.blocks[0];
    check(
      "the cut keeps as many rows as the budget allows, not as few",
      [kept?.type === "list" ? kept.rows.length : -1, bytesOf(tight.view) <= 200, tight.clamped],
      [1, true, true],
    );
    const airless = fitView({ blocks: [{ type: "list", rows: rowsOf(PLUGIN_VIEW_LIMITS.rows), empty: "" }] }, 50);
    const nothing = airless.view.blocks[0];
    check(
      "and a budget that not even an empty block fits stops with no rows rather than spinning",
      [nothing?.type === "list" ? nothing.rows.length : -1, airless.clamped],
      [0, true],
    );
  }

  check("a view that is already fine is not reported as clamped", clampView({ title: "T", blocks: [] }).clamped, false);

  /*
   * ⚠ **A substitution is a clamp, and used to be the one kind nobody was told
   * about.** `plugins.ts`'s fail-open rule is right and stays — an unknown field
   * kind becomes a text input and still round-trips, nothing throws. What it did
   * not do is *say so*, and that is worse for a substitution than for a
   * truncation: a cut list is visibly short, while a form whose fields all lost
   * their `key` renders perfectly, submits nothing, and looks like it works.
   *
   * Every case below is one a real plugin shipped to the market with, and it
   * survived two releases: fields sending `id` where `clampField` reads `key`,
   * `submit` sent where the action identifier belongs, and `kind: "string"` /
   * `"boolean"` — neither of which is in the enum. The plugin's own driver was
   * green throughout, because it asserted the author's misunderstanding
   * (`form.submit === "save"`) rather than the protocol.
   */
  const shipped = clampView({
    blocks: [
      {
        type: "form",
        submit: "save",
        fields: [
          { id: "apiKey", kind: "string", label: "Anthropic API key", value: "" },
          { id: "rename", kind: "boolean", label: "Rename new sessions", value: "true" },
        ],
      },
    ],
  });
  check(
    "a form that shipped broken is reported as substituted rather than silently drawn",
    [shipped.substituted, shipped.clamped],
    [true, false],
  );
  /*
   * The two halves of the flag are independent facts and are asserted apart,
   * because they send an author to two different places: "too large" means look
   * at the bounds, "not a shape this daemon knows" means look at the protocol.
   */
  const keyless = clampView({ blocks: [{ type: "form", action: "save", fields: [{ label: "A" }] }] });
  check("a field with no key cannot round-trip, and says so", keyless.substituted, true);
  const actionless = clampView({ blocks: [{ type: "form", submit: "Save", fields: [{ key: "a", label: "A" }] }] });
  check("a form with no action submits nowhere, and says so", actionless.substituted, true);
  const unknownKind = clampView({
    blocks: [{ type: "form", action: "save", fields: [{ key: "a", label: "A", kind: "string" }] }],
  });
  check("a kind this daemon does not know is a substitution", unknownKind.substituted, true);
  /*
   * ⚠ **Absence is a default, not a substitution.** Omitting `kind` means "an
   * ordinary text field" and is a perfectly good thing for a plugin to do — if
   * that raised the flag, every well-formed plugin in the world would draw a
   * notice saying it was broken, and the notice would stop meaning anything.
   */
  const plain = clampView({
    blocks: [{ type: "form", action: "save", fields: [{ key: "a", label: "A" }] }],
  });
  check("but omitting kind entirely is a default rather than a substitution", plain.substituted, false);
  /*
   * ⚠ **And `null` spelled out is the same default, which the line above does not
   * cover.** The guard is `kind !== undefined && kind !== null` — two spellings of
   * absence — and only one of them was driven. Delete the `!== null` half and this
   * file stays green while **every plugin that serialises a missing field as
   * `null`** starts drawing "not in a shape this machine recognises" on a form
   * that is perfectly fine.
   *
   * It is not the unlikely spelling, either. This crosses as JSON, which has no
   * `undefined` at all: an author writing `kind: config.kind ?? null`, or reading
   * a row out of a database, sends `null` and cannot send anything else. The half
   * that was covered is the one that only arises from leaving the key out.
   *
   * Found by the author of a plugin who had just been bitten by the mirror of it —
   * `store.get` answering `null` where they expected `undefined` — and then again
   * by their own driver, where a parameter with a default value made passing
   * `undefined` impossible and silently ran the `null` case twice. Three of one
   * shape in a day: the spelling of absence is not a detail.
   */
  const nulled = clampView({
    blocks: [{ type: "form", action: "save", fields: [{ key: "a", label: "A", kind: null }] }],
  });
  check("and neither is null spelled out", nulled.substituted, false);
  /*
   * The other half of the pair: not raising the flag is only right if the field
   * came out as a text input. A `clampField` that dropped the field entirely would
   * pass the two lines above and lose the control off the form.
   */
  const kindOf = (view: typeof plain.view): unknown => {
    const block = view.blocks[0];
    return block !== undefined && block.type === "form" ? block.fields[0]?.kind : "<not a form>";
  };
  check("both spellings still give an ordinary text field", [kindOf(plain.view), kindOf(nulled.view)], ["text", "text"]);

  /*
   * And the notice itself: two facts, two lines, both where both happened —
   * `noteClamp` is the half a person actually reads, and the half the author
   * sees by opening their own plugin.
   */
  const noticed = noteClamp(shipped);
  const lines = noticed.blocks.filter((one) => one.type === "notice").length;
  check("the substitution is said out loud rather than swallowed", lines, 1);
  check(
    "and it names the consequence rather than the size",
    noticed.blocks.some((one) => one.type === "notice" && one.text.includes("will not work")),
    true,
  );
  const both = noteClamp({ view: shipped.view, clamped: true, substituted: true, unknownBlocks: [] });
  check(
    "both facts get their own line, because they have different remedies",
    both.blocks.filter((one) => one.type === "notice").length,
    2,
  );

  /* ---------------------------------------------------------------- *
   * What v2 added.
   * ---------------------------------------------------------------- */
  const { PLUGIN_REFRESH_MIN_MS, PLUGIN_REFRESH_MAX_MS } = await import("../src/plugins/protocol.js");

  check(
    "a refresh interval is floored and capped rather than refused",
    [
      clampView({ refreshMs: 10, blocks: [] }).view.refreshMs,
      clampView({ refreshMs: 5_000, blocks: [] }).view.refreshMs,
      clampView({ refreshMs: 999_999_999, blocks: [] }).view.refreshMs,
      clampView({ refreshMs: 0, blocks: [] }).view.refreshMs,
      clampView({ refreshMs: -1, blocks: [] }).view.refreshMs,
      clampView({ refreshMs: "soon", blocks: [] }).view.refreshMs,
      clampView({ blocks: [] }).view.refreshMs,
    ],
    [PLUGIN_REFRESH_MIN_MS, 5_000, PLUGIN_REFRESH_MAX_MS, null, null, null, null],
  );
  /*
   * Clamped **silently**, unlike a cut list. The difference is what anybody could
   * do about it: a shortened list is a wrong number on screen, while an interval
   * moved from 500ms to 2000ms is invisible to everyone and actionable by nobody.
   */
  check("and moving one is not reported as a clamp", clampView({ refreshMs: 10, blocks: [] }).clamped, false);

  /*
   * ⚠ **The field a plugin would most like to put a URL in.** Anything that is
   * not one of this app's own two destinations becomes a row that does not go
   * anywhere — a URL above all, in either shape somebody would try it.
   */
  const opened = clampView({
    blocks: [
      {
        type: "list",
        empty: "",
        rows: [
          { id: "a", open: { session: "s_1" } },
          { id: "b", open: { screen: true } },
          { id: "c", open: { url: "https://evil.example" } },
          { id: "d", open: "https://evil.example" },
          { id: "e", open: { session: "" } },
          { id: "f", open: { screen: false } },
          { id: "g", open: { session: "s_2", url: "https://evil.example" } },
          { id: "h" },
        ],
      },
    ],
  });
  const openedRows = opened.view.blocks[0];
  check(
    "only a session on this machine or the plugin's own screen survives",
    openedRows?.type === "list" ? openedRows.rows.map((row) => row.open) : null,
    [{ session: "s_1" }, { screen: true }, null, null, null, null, { session: "s_2" }, null],
  );

  const rowTones = clampView({
    blocks: [{ type: "list", empty: "", rows: [{ id: "a", tone: "danger" }, { id: "b", tone: "puce" }, { id: "c" }] }],
  });
  const tonedRows = rowTones.view.blocks[0];
  check(
    "a tone this daemon knows survives, and one it does not is no tone",
    tonedRows?.type === "list" ? tonedRows.rows.map((row) => row.tone) : null,
    ["danger", null, null],
  );

  /* ---------------------------------------------------------------- *
   * A settings pane draws less than a screen does.
   *
   * ⚠ **Two vocabularies over one protocol, and the whole risk is that the
   * narrow one silently becomes the wide one again.** A settings pane is a form
   * plus the words around it — three block types, three field kinds — while a
   * plugin's own screen keeps all five of each. Nothing in the type system
   * expresses "narrower", so every assertion below is paired with its negative
   * control on the other surface: dropping a `list` is only correct if a screen
   * still draws one, and downgrading `password` is only correct if a screen
   * still masks one.
   * ---------------------------------------------------------------- */
  {
    const listBlock = { type: "list", empty: "nothing", rows: [{ id: "a", title: "A" }] };
    const onScreen = clampView({ blocks: [listBlock] }, "screen");
    const onSettings = clampView({ blocks: [listBlock] }, "settings");
    check("a screen draws a list", onScreen.view.blocks.map((one) => one.type), ["list"]);
    check("a settings pane does not", onSettings.view.blocks, []);
    /*
     * ⚠ **`substituted`, never `clamped`.** Nothing here was too large — the two
     * flags send an author to two different places, and reported as a size clamp
     * this one sends them to go and count rows in a list that was the wrong shape
     * for the surface rather than too long.
     */
    check(
      "and says so as a shape problem rather than a size one",
      [onSettings.substituted, onSettings.clamped, [...onSettings.unknownBlocks]],
      [true, false, ["list"]],
    );
    check("while the screen reports neither", [onScreen.substituted, onScreen.clamped], [false, false]);
    /*
     * ⚠ **The notice must not say "this machine does not draw a list".** It does
     * draw one, one surface over — told that, an author goes looking for a typo in
     * a block type they spelled correctly, which is the wrong-diagnosis failure
     * the naming branch exists to end. And it names what a settings pane *does*
     * draw, because the author has no copy of this protocol.
     */
    const settingsNotice = noteClamp(onSettings, "settings").blocks.filter((one) => one.type === "notice");
    const settingsText = settingsNotice[0]?.type === "notice" ? settingsNotice[0].text : "";
    check("the notice is about the surface, not about the machine", settingsText.startsWith("A settings pane"), true);
    check("and names the three block types a pane draws", /text, notice, form/.test(settingsText), true);
    check("and does not offer the two it just refused", /list|columns/.test(settingsText.split(" It draws")[1] ?? ""), false);
    check("and never says anything was too large", /too large/.test(settingsText), false);
    /*
     * ⚠ **A danger notice keeps its tone on a settings pane, and that is
     * load-bearing rather than cosmetic.** Found by the first plugin this
     * narrowing hit: it has no screen — a screen for one function is a page nobody
     * visits — and its pane carried the only record of *refusals*. A hook's
     * failure has nobody waiting on it, so nothing is owed an error and there is
     * no session left to warn through; `notice` is the entire diagnostic channel
     * for a plugin shaped like that. Drawn in the ordinary ink it is a diagnostic
     * nobody reads, so the tone is asserted and not merely the block.
     */
    const danger = clampView(
      { blocks: [{ type: "notice", text: "could not rename", tone: "danger" }] },
      "settings",
    ).view.blocks[0];
    check(
      "a settings pane keeps a danger notice, and its tone",
      danger?.type === "notice" ? [danger.tone, danger.text] : null,
      ["danger", "could not rename"],
    );

    /*
     * The field kinds. `password` and `number` are spellings of a text box rather
     * than a fourth and fifth kind of setting — see `PLUGIN_SETTINGS_FIELD_KINDS`
     * — so on a settings pane they become `text` **and are reported**, which is
     * the half that matters: a masked box that silently stops being masked is the
     * one substitution here that looks like it worked.
     */
    const form = (kind: unknown): unknown => ({
      blocks: [{ type: "form", action: "save", submit: "Save", fields: [{ key: "k", label: "L", kind }] }],
    });
    const kindOn = (surface: "screen" | "settings", kind: unknown): string | null => {
      const block = clampView(form(kind), surface).view.blocks[0];
      return block?.type === "form" ? (block.fields[0]?.kind ?? null) : null;
    };
    check(
      "a screen keeps all five field kinds",
      ["text", "password", "number", "toggle", "select"].map((kind) => kindOn("screen", kind)),
      ["text", "password", "number", "toggle", "select"],
    );
    check(
      "a settings pane keeps three and spells the other two as a text box",
      ["text", "password", "number", "toggle", "select"].map((kind) => kindOn("settings", kind)),
      ["text", "text", "text", "toggle", "select"],
    );
    check(
      "and reports the two it changed, so an author finds out",
      ["text", "password", "number", "toggle", "select"].map((kind) => clampView(form(kind), "settings").substituted),
      [false, true, true, false, false],
    );
    check(
      "while the screen reports none of them",
      ["text", "password", "number", "toggle", "select"].map((kind) => clampView(form(kind), "screen").substituted),
      [false, false, false, false, false],
    );
    /*
     * ⚠ **Absence is still a default on both surfaces.** Omitting `kind` means an
     * ordinary text box and is a perfectly good thing for a plugin to do — if it
     * raised the flag, every well-written plugin would draw the notice and it
     * would stop meaning anything. Both spellings of absence, because JSON has no
     * `undefined` and `null` is the likelier one on the wire.
     */
    check(
      "a field with no kind is a default rather than a substitution",
      [
        clampView({ blocks: [{ type: "form", action: "s", fields: [{ key: "k" }] }] }, "settings").substituted,
        clampView(form(null), "settings").substituted,
      ],
      [false, false],
    );
    /*
     * The notice for a substitution *inside* a block, where no block was refused:
     * on a settings pane the commonest cause is a kind the machine recognises and
     * declines, so "not in a shape this machine recognises" is exactly wrong and
     * the three kinds are named instead.
     */
    const inner = noteClamp(clampView(form("password"), "settings"), "settings").blocks.filter(
      (one) => one.type === "notice",
    );
    const innerText = inner[0]?.type === "notice" ? inner[0].text : "";
    check("a refused field kind names the three that are not", /text, toggle, select/.test(innerText), true);

    /*
     * ⚠ **The default is the wide surface**, and that direction is the safe one:
     * a call site nobody has told about surfaces draws a settings pane as though
     * it were a screen — today's behaviour — rather than silently deleting
     * controls off somebody's pane.
     */
    check(
      "an untold caller gets the screen's vocabulary",
      clampView({ blocks: [listBlock] }).view.blocks.map((one) => one.type),
      ["list"],
    );
    check(
      "and `fitView` carries the surface through the size pass",
      fitView({ blocks: [listBlock] }, 64_000, "settings").view.blocks,
      [],
    );
    /*
     * A settings type that is not a screen type is a value `PluginView` has no arm
     * for: it would render as nothing and say nothing about itself. Asserted as a
     * subset rather than as two lists, so adding a block type to the wide set
     * cannot quietly fail to be considered for the narrow one.
     */
    check(
      "what a pane draws is a subset of what a screen draws",
      PLUGIN_SETTINGS_BLOCK_TYPES.filter((one) => !PLUGIN_BLOCK_TYPES.some((two) => two === one)),
      [],
    );
  }
}

/* ------------------------------------------------------------------ *
 * A tar writer, small enough to read.
 *
 * Built here rather than shelled out for the reason the import section's own
 * builder gives: neither `tar` nor `zip` is guaranteed on a CI box. This one is
 * deliberately *separate* from that builder rather than hoisted out of it — that
 * one exists to write archives no honest tool will produce, and lifting it here
 * would couple a plugin's happy path to a fixture whose whole job is to be
 * malformed.
 *
 * At module scope because three sections build one now: installing, the hooks a
 * freshly-installed plugin is seeded with, and `POST /plugins` over HTTP. Two of
 * those want the same bytes an install already proved good, and a second copy of
 * a tar writer is a second place for a checksum to be wrong.
 * ------------------------------------------------------------------ */
const tarOf = (files: Record<string, string>): Buffer => {
  const parts: Buffer[] = [];
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.from(body, "utf8");
    const head = Buffer.alloc(512);
    head.write(name, 0, "utf8");
    head.write("000644 \0", 100);
    head.write("000000 \0", 108);
    head.write("000000 \0", 116);
    head.write(data.length.toString(8).padStart(11, "0") + " ", 124);
    head.write("00000000000 ", 136);
    head.write("        ", 148);
    head.write("0", 156);
    head.write("ustar\0", 257);
    head.write("00", 263);
    let sum = 0;
    for (const byte of head) sum += byte;
    head.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(head, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
};

const bodyOf = (bytes: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });

/**
 * The same bytes, plus whether anybody released the stream.
 *
 * ⚠ **The one property of this route that is argued everywhere and asserted
 * nowhere.** `PluginHost.install` cancels the request body on the busy path and
 * again in its `finally`, and `POST /plugins`'s own docblock spends a paragraph
 * on why: the relay grants a stream's window on consumption, so a reader that
 * stops parks the sender at one window, and the valve after that closes the
 * **whole tunnel for this machine**. Every plugin fixture here used `bodyOf` or
 * `stallingBody`, neither of which records a cancel — so both calls could have
 * been deleted and this driver would have stayed green. The uploads section has
 * had exactly this fixture since Q5.72.
 */
const watchedBody = (bytes: Buffer): { body: ReadableStream<Uint8Array>; state: { cancelled: boolean; pulled: number } } => {
  const state = { cancelled: false, pulled: 0 };
  return {
    state,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        state.pulled += 1;
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    }),
  };
};

/**
 * The same bytes, held until the returned `release` is called.
 *
 * What it buys is the *middle* of an install, which no other body here can reach:
 * `PluginHost.install` claims the daemon-wide mutex and then awaits the stream, so
 * this is the window in which a `remove` or a `setEnabled` arrives — the window a
 * measured `DELETE` used to walk straight through, dropping the row and every
 * `plugin_data` key of a plugin the install then re-created.
 */
const stallingBody = (bytes: Buffer): { body: ReadableStream<Uint8Array>; release: () => void } => {
  let release = (): void => {};
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    body: new ReadableStream({
      async pull(controller) {
        await parked;
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
  };
};

process.stdout.write("\ninstalling a plugin, and updating one\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { openStores } = await import("../src/store/sqlite.js");

  const manifestOf = (patch: Record<string, unknown> = {}): string =>
    JSON.stringify({
      id: "board",
      name: "Task board",
      version: "0.1.0",
      api: 1,
      scopes: ["store"],
      contributes: { settings: true, actions: [{ id: "save", title: "Save", on: "screen" }], hooks: ["turn.ended"] },
      ...patch,
    });

  /** A plugin whose `server.js` answers everything out of its own store. */
  const SERVER = `
    export async function settings(ctx) {
      const held = await ctx.store.get("v");
      return { title: null, blocks: [{ type: "text", text: String(held ?? "unset"), tone: "default" }] };
    }
    export async function action(ctx, event) {
      await ctx.store.set("v", event.form?.v ?? "set");
      return { kind: "toast", text: "saved", tone: "default" };
    }
    export async function hook(ctx, event) {
      await ctx.store.set("last", event.hook);
    }
  `;

  const root = tmp("plugin-root-");
  const stores = openStores({ path: join(tmp("plugin-db-"), "d.db"), instanceId: "i_plugins" });
  const registry = new SessionRegistry(stores.events, stores.sessions);
  const warnings: string[] = [];
  const host = await PluginHost.open({
    root: join(root, "plugins"),
    records: stores.plugins,
    data: stores.pluginData,
    registry,
    api: { git: hostGit },
    onWarning: (detail) => warnings.push(detail),
    timeouts: { start: 3_000, invoke: 3_000 },
  });

  const install = (files: Record<string, string>, name = "p.tar.gz"): ReturnType<typeof host.install> =>
    host.install({ body: bodyOf(tarOf(files)), name });

  const first = await install({ "plugin.json": manifestOf(), "server.js": SERVER });
  check("a plugin installs", first.kind === "ok" ? [first.summary.id, first.summary.version, first.replaced] : first, [
    "board",
    "0.1.0",
    null,
  ]);
  check("and it is running", host.list().map((one) => [one.id, one.state, one.enabled]), [["board", "running", true]]);

  /*
   * A directory rather than loose members, which is what somebody who compresses
   * a folder produces. Both shapes have to work — the one thing `findManifestRoot`
   * exists for — and nothing deeper than one level is searched.
   */
  const nested = await install({ "board/plugin.json": manifestOf({ version: "0.1.1" }), "board/server.js": SERVER });
  check("an archive holding one folder is the same plugin", nested.kind === "ok" ? nested.replaced : nested, "0.1.0");

  /* ---------------------------------------------------------------- *
   * What an update keeps, which is the whole of what makes it an update.
   * ---------------------------------------------------------------- */
  const plugin = host.find("board");
  if (plugin === null) throw new Error("the plugin vanished");
  await plugin.invoke("action", "save", { action: "save", form: { v: "kept" } });
  const before = await plugin.invoke("view", "settings", {});
  check(
    "a plugin can write to its own store and read it back",
    before.kind === "view" ? before.view.blocks[0] : null,
    { type: "text", text: "kept", tone: "default" },
  );

  const updated = await install({ "plugin.json": manifestOf({ version: "0.2.0" }), "server.js": SERVER });
  check("installing the same id again is an update", updated.kind === "ok" ? updated.replaced : updated, "0.1.1");
  check("and the row is the new version", host.list().map((one) => one.version), ["0.2.0"]);
  const after = await host.find("board")?.invoke("view", "settings", {});
  check(
    "what it stored survived the update",
    after?.kind === "view" ? after.view.blocks[0] : null,
    { type: "text", text: "kept", tone: "default" },
  );
  check(
    "the old version's directory is gone",
    [existsSync(join(root, "plugins", "board", "0.1.1")), existsSync(join(root, "plugins", "board", "0.2.0"))],
    [false, true],
  );

  // Reinstalling the same version is how somebody iterates on a plugin they are
  // writing. It used to fail `ENOTEMPTY`, because the guard on the removal was
  // comparing an unresolved root against a path that did not exist yet.
  const again = await install({ "plugin.json": manifestOf({ version: "0.2.0" }), "server.js": SERVER });
  check("reinstalling the same version works", again.kind, "ok");

  /* ---------------------------------------------------------------- *
   * A refusal changes nothing, which is the second half of every one of them.
   * ---------------------------------------------------------------- */
  const refusals: [string, Record<string, string>, string][] = [
    ["no manifest at all", { "server.js": SERVER }, "manifest_missing"],
    ["no server.js beside it", { "plugin.json": manifestOf({ version: "9.9.9" }) }, "entry_missing"],
    ["a manifest that is not JSON", { "plugin.json": "{", "server.js": SERVER }, "manifest_unreadable"],
    ["an id this daemon will not make a directory of", { "plugin.json": manifestOf({ id: "A B" }), "server.js": SERVER }, "manifest_invalid"],
    ["an api from the future", { "plugin.json": manifestOf({ api: 99, version: "9.9.9" }), "server.js": SERVER }, "plugin_api_too_new"],
  ];
  for (const [name, files, code] of refusals) {
    const answer = await install(files);
    check(name, answer.kind === "refused" ? answer.code : answer.kind, code);
  }
  check(
    "and after every one of them the machine is exactly as it was",
    [host.list().map((one) => [one.id, one.version, one.state]), existsSync(join(root, "plugins", "board", "9.9.9"))],
    [[["board", "0.2.0", "running"]], false],
  );

  const empty = await host.install({ body: bodyOf(gzipSync(Buffer.alloc(1024))), name: "empty.tar.gz" });
  check("an archive with nothing in it", empty.kind === "refused" ? empty.code : empty.kind, "archive_empty");
  const junk = await host.install({ body: bodyOf(Buffer.from("not an archive")), name: "x.tar.gz" });
  check("something that is not an archive", junk.kind === "refused" ? junk.code : junk.kind, "unsupported_archive");

  /* ---------------------------------------------------------------- *
   * The archive reader's own refusals, in this route's vocabulary.
   *
   * ⚠ **`unpackArchive` is shared with `POST /fs/import` and the codes are not.**
   * One unpacker, one set of containment rules — `..` refused rather than
   * normalised, the ceiling charged against what the decompressor produced — and
   * then each caller translates an `ArchiveError` into its own namespace: an
   * import answers `archive_too_large` where a plugin answers
   * `plugin_unpacked_too_large`. The import section drives every one of these
   * *shapes* already; what it cannot drive is `archiveCode`, which is the whole
   * translation and which nothing reached.
   *
   * `PLUGIN_LIMITS` is the other half of the same argument: 2 MiB on the wire,
   * 8 MiB unpacked and 500 members, against the import's 50 MiB / 500 MiB /
   * 20,000. The same archive is refused at wildly different sizes depending on
   * which door it arrived at, which is exactly why the numbers are a parameter and
   * nothing in `safeMemberPath` is.
   *
   * Four arms rather than five: `ArchiveError("empty")` is raised only inside
   * `importArchive`, so the `archive_empty` arm of `archiveCode` is unreachable
   * from here — `unpackArchive` reports an empty archive as a *kind* and `install`
   * answers that itself, which is the case two assertions up.
   * ---------------------------------------------------------------- */
  const { PLUGIN_LIMITS } = await import("../src/archive.js");

  /**
   * A tar whose header lies about how long its member is.
   *
   * ⚠ **Every archive `tarOf` writes is one the reader could have trusted**, which
   * is why none of them can reach `archive_unreadable`: the size field is computed
   * from the bytes that follow it. Only a member *declaring* more than it carries
   * walks the reader off the end of the stream, and a size field somebody else
   * wrote is the entire reason that arm exists. The import section's own builder
   * makes the same point with its `declaredSize`, and it is deliberately not
   * borrowed — that one exists to write archives no honest tool produces.
   */
  const lyingTarGz = (): Buffer => {
    const head = Buffer.alloc(512);
    head.write("plugin.json", 0, "utf8");
    head.write("000644 \0", 100);
    head.write("000000 \0", 108);
    head.write("000000 \0", 116);
    // Four kilobytes promised; five hundred and twelve bytes follow.
    head.write((4096).toString(8).padStart(11, "0") + " ", 124);
    head.write("00000000000 ", 136);
    head.write("        ", 148);
    head.write("0", 156);
    head.write("ustar\0", 257);
    head.write("00", 263);
    let sum = 0;
    for (const byte of head) sum += byte;
    head.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return gzipSync(Buffer.concat([head, Buffer.alloc(512, 0x7a)]));
  };

  const crowded: Record<string, string> = {};
  for (let index = 0; index <= PLUGIN_LIMITS.maxEntries; index += 1) crowded[`f${index}.txt`] = "x";
  const archiveRefusals: [string, Buffer, string][] = [
    ["a member that climbs out of the tree", tarOf({ "plugin.json": manifestOf(), "../escaped.txt": "x" }), "archive_unsafe"],
    ["more members than a plugin has", tarOf(crowded), "plugin_too_many_entries"],
    [
      "one that unpacks past what a plugin may be",
      tarOf({ "plugin.json": manifestOf(), "big.js": "x".repeat(PLUGIN_LIMITS.maxUnpackedBytes + 1) }),
      "plugin_unpacked_too_large",
    ],
    ["one this daemon cannot read to the end", lyingTarGz(), "archive_unreadable"],
  ];
  for (const [name, bytes, code] of archiveRefusals) {
    const answer = await host.install({ body: bodyOf(bytes), name: "p.tar.gz" });
    check(name, answer.kind === "refused" ? answer.code : answer.kind, code);
  }
  /*
   * The second half of every one of them, and `readdirSync` rather than an
   * `existsSync` per case: three of those four are refused *after* members have
   * already been written, so what has to be true is that the plugin root holds
   * nothing but the plugin that was there — no staging directory, no partial tree
   * under a name nobody will look for again.
   */
  check(
    "and after every one of those the machine is exactly as it was",
    [host.list().map((one) => [one.id, one.version, one.state]), readdirSync(join(root, "plugins"))],
    [[["board", "0.2.0", "running"]], ["board"]],
  );

  /* ---------------------------------------------------------------- *
   * One install at a time, for the whole daemon.
   *
   * Q7.97's argument for `POST /fs/import` verbatim: this is a route with **no
   * accounting that outlives the request** — an installed plugin is charged
   * against nothing once it has landed — and the relay allows 256 concurrent
   * streams, so a per-request size cap cannot see what a hundred of them do to a
   * disk. The bound has to be on arrival, and a person installs a plugin about as
   * often as they install anything.
   *
   * The version is the one already there, so whichever of the two wins leaves the
   * machine where the cases below expect to find it — and the losing body is
   * cancelled rather than read, which is what keeps a refusal from parking a
   * sender against the relay's window.
   * ---------------------------------------------------------------- */
  const contended = tarOf({ "plugin.json": manifestOf({ version: "0.2.0" }), "server.js": SERVER });
  const overlapping = await Promise.all([
    host.install({ body: bodyOf(contended), name: "a.tar.gz" }),
    host.install({ body: bodyOf(contended), name: "b.tar.gz" }),
  ]);
  check(
    "two at once, and exactly one of them is turned away",
    overlapping.map((one) => one.kind).sort(),
    ["busy", "ok"],
  );
  check("the one that landed is still the only plugin", host.list().map((one) => [one.id, one.version]), [["board", "0.2.0"]]);

  /* ---------------------------------------------------------------- *
   * A throw *after* the row is written, which is the window the rollback
   * exists for and the one nothing reached.
   *
   * ⚠ **`target` carries the version, so the incumbent is only ever moved aside
   * on a reinstall of the version already there** — which is the documented way
   * somebody iterates on a plugin they are writing, not a rare race. On that path
   * `aside` is the running plugin's own directory and `published` is the same
   * path, so destroying `aside` before the last fallible statement meant a throw
   * from `seed` ran a catch that discarded the new tree and found the old one
   * already gone: both trees lost, the row naming a directory that is not there,
   * the plugin permanently failed.
   *
   * A registry whose `list()` throws is how `seed` is made to fail, and `seed`
   * is not an invented source — the catch's own docblock names it.
   * ---------------------------------------------------------------- */
  {
    let listThrows = false;
    const shaky = {
      watchSessions: () => () => {},
      list: () => {
        if (listThrows) throw new Error("the registry was being torn down");
        return [];
      },
      get: () => undefined,
    } as unknown as SessionRegistry;

    const shakyStores = openStores({ path: join(tmp("plugin-shaky-db-"), "d.db"), instanceId: "i_shaky" });
    const shakyRoot = join(tmp("plugin-shaky-root-"), "plugins");
    const shakyHost = await PluginHost.open({
      root: shakyRoot,
      records: shakyStores.plugins,
      data: shakyStores.pluginData,
      registry: shaky,
      api: { git: hostGit },
      timeouts: { start: 3_000, invoke: 3_000 },
    });
    const put = (files: Record<string, string>): ReturnType<typeof shakyHost.install> =>
      shakyHost.install({ body: bodyOf(tarOf(files)), name: "p.tar.gz" });

    await put({ "plugin.json": manifestOf({ version: "2.0.0" }), "server.js": SERVER });
    shakyStores.pluginData.set("board", "card:1", JSON.stringify({ keep: true }));

    listThrows = true;
    const blown = await put({ "plugin.json": manifestOf({ version: "2.0.0" }), "server.js": SERVER });
    listThrows = false;

    check(
      "a reinstall that throws after the row is written is refused",
      blown.kind === "refused" ? blown.code : blown.kind,
      "plugin_write_failed",
    );
    /*
     * Id and version, and that it is not `failed` — deliberately not `running`.
     * The rollback restarts the incumbent with `void existing.ensureStarted(...)`,
     * so `install` answers without waiting to find out: at this instant the state
     * is `starting`, and asserting `running` here would be pinning the scheduler
     * rather than the recovery. (That the answer goes out before the restart is
     * known to have worked is its own open question, and a separate one.)
     */
    const back = shakyHost.list().map((one) => [one.id, one.version, one.state !== "failed"]);
    check("and the plugin somebody was iterating on is still there, and not failed", back, [["board", "2.0.0", true]]);
    // The half that used to be gone: the row named this directory and nothing was
    // in it, so every start burned a budget on ENOENT.
    check("with the tree its row names", existsSync(join(shakyRoot, "board", "2.0.0")), true);
    check("and nothing moved aside left behind", readdirSync(join(shakyRoot, "board")), ["2.0.0"]);
    check("and its data untouched", shakyStores.pluginData.keys("board", ""), ["card:1"]);

    /*
     * The other half of the same catch. A **first** install that fails is
     * documented to leave nothing — and it left the `plugin_data` rows, which
     * afterwards nothing can reach: no row and no directory means `installed()`
     * is false on both halves, so `DELETE /plugins/:id` answers 404 and
     * `dropPlugin` is unreachable for good. They then reappear under the next
     * install of that id, because `plugin_data` is keyed by id rather than by
     * version.
     */
    shakyStores.pluginData.set("ghost", "card:9", JSON.stringify({ stale: true }));
    listThrows = true;
    const fresh = await put({ "plugin.json": manifestOf({ id: "ghost", version: "1.0.0" }), "server.js": SERVER });
    listThrows = false;
    check(
      "a first install that throws after the row is written is refused too",
      fresh.kind === "refused" ? fresh.code : fresh.kind,
      "plugin_write_failed",
    );
    check(
      "and leaves nothing — the row, the tree and the data",
      [
        shakyStores.plugins.has("ghost"),
        existsSync(join(shakyRoot, "ghost")),
        shakyStores.pluginData.keys("ghost", "").length,
      ],
      [false, false, 0],
    );

    await shakyHost.shutdown();
    shakyStores.close();
  }

  /*
   * ...and the sentence above about the losing body, now asserted rather than
   * asserted-in-prose. Two paths, because they cancel in two different places:
   * the busy arm cancels before it returns (`install`'s first statement), and a
   * refusal cancels in the `finally` that covers every other exit.
   */
  {
    const held = stallingBody(tarOf({ "plugin.json": manifestOf({ version: "0.2.0" }), "server.js": SERVER }));
    const flight = host.install({ body: held.body, name: "held.tar.gz" });
    const turned = watchedBody(tarOf({ "plugin.json": manifestOf({ version: "0.2.0" }), "server.js": SERVER }));
    const busy = await host.install({ body: turned.body, name: "turned.tar.gz" });
    check(
      "an install turned away for busy is released rather than left parked",
      [busy.kind, turned.state.cancelled, turned.state.pulled],
      ["busy", true, 0],
    );
    held.release();
    await flight;

    /*
     * ⚠ **A refusal that stops *mid-stream*, which is the only kind that has
     * anything left to release.** `manifest_missing` and its neighbours are
     * decided after the whole archive has been unpacked, so by then the body has
     * ended on its own and `cancelBody` is correctly a no-op — asserting a cancel
     * there would pin the wrong thing. The reachable case is the ceiling:
     * `unpackArchive` stops reading at `PLUGIN_LIMITS.maxBytes` and refuses, and
     * everything the sender still has queued is what parks against the relay's
     * window if nobody releases it.
     */
    let sent = 0;
    const endless = { cancelled: false };
    const flood = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        endless.cancelled = true;
      },
    });
    const answer = await host.install({ body: flood, name: "endless.tar.gz" });
    check(
      "and one refused while the sender was still sending is released mid-stream",
      [answer.kind === "refused" ? answer.code : answer.kind, endless.cancelled, sent > 0],
      ["plugin_too_large", true, true],
    );
  }

  /* ---------------------------------------------------------------- *
   * An update that will not start puts everything back.
   *
   * The most important case here: a person pushing a broken update to a machine
   * they are not sitting in front of must end up with the plugin they had, not
   * with none.
   * ---------------------------------------------------------------- */
  const broken = await install({
    "plugin.json": manifestOf({ version: "0.3.0" }),
    "server.js": 'throw new Error("this plugin is broken");',
  });
  check("a plugin that throws on load is refused", broken.kind === "refused" ? broken.code : broken.kind, "plugin_start_failed");
  report(
    "and the refusal says what the plugin said",
    broken.kind === "refused" && broken.message.includes("this plugin is broken"),
    broken.kind === "refused" ? broken.message.slice(0, 60) : broken.kind,
  );
  check("the old version is still the installed one", host.list().map((one) => one.version), ["0.2.0"]);
  check("its directory was not touched", existsSync(join(root, "plugins", "board", "0.2.0")), true);
  check("and the broken one left nothing behind", existsSync(join(root, "plugins", "board", "0.3.0")), false);
  const survived = await host.find("board")?.invoke("view", "settings", {});
  check(
    "the plugin that was there is running again",
    survived?.kind === "view" ? survived.view.blocks[0] : null,
    { type: "text", text: "kept", tone: "default" },
  );

  /* ---------------------------------------------------------------- *
   * The same refusal, at the version that is already installed.
   *
   * ⚠ **The case above passes for a reason that is not the rule.** It pushes
   * 0.3.0 over 0.2.0, so the two live in different directories and the rollback
   * has somewhere to roll back *to*. Reinstalling the version that is already
   * there is the documented way to iterate on a plugin somebody is writing —
   * `docs/PLUGINS.md` opens on it — and there the destination *is* the running
   * plugin's own directory. Clearing it first destroyed the working copy and
   * then removed the broken one on top, leaving a row naming a version whose
   * tree was gone and a plugin that could not be started again. Measured before
   * `install` moved the old tree aside instead: "Cannot find module
   * .../board/0.2.0/server.js".
   * ---------------------------------------------------------------- */
  const clobber = await install({
    "plugin.json": manifestOf({ version: "0.2.0" }),
    "server.js": 'throw new Error("broken at the same version");',
  });
  check("a broken build at the installed version is refused", clobber.kind === "refused" ? clobber.code : clobber.kind, "plugin_start_failed");
  check("the tree it would have replaced is still there", existsSync(join(root, "plugins", "board", "0.2.0", "server.js")), true);
  check("and nothing was left lying beside it", readdirSync(join(root, "plugins", "board")), ["0.2.0"]);
  const clobbered = await host.find("board")?.invoke("view", "settings", {});
  check(
    "the plugin that was there is still the one running",
    clobbered?.kind === "view" ? clobbered.view.blocks[0] : null,
    { type: "text", text: "kept", tone: "default" },
  );

  /* ---------------------------------------------------------------- *
   * And the same again for a plugin somebody has switched off.
   *
   * ⚠ **`enabled` used to gate the whole proof.** A disabled plugin's update was
   * committed without the new build ever having run: the row was rewritten and
   * the previous version's directory removed, so re-enabling it was the first
   * anybody heard it was broken, with nothing to go back to. The build is now
   * started whatever the switch says and stopped again straight after, which is
   * what the third case here is for — a *good* update to a disabled plugin must
   * still be off when it lands.
   * ---------------------------------------------------------------- */
  /*
   * `setEnabled` answers `"busy"` while an install holds the daemon-wide mutex —
   * see the case at the end of this section. None of the calls below is racing
   * one, so a `"busy"` here would be a defect rather than a state to assert
   * around: it is turned into `null` so the existing `?.` reads on, and the
   * dedicated case is what proves the refusal actually happens.
   */
  const switched = async (id: string, on: boolean) => {
    const answer = await host.setEnabled(id, on);
    return answer === "busy" ? null : answer;
  };
  check("switching it off before an update", (await switched("board", false))?.enabled, false);
  const offBroken = await install({
    "plugin.json": manifestOf({ version: "0.4.0" }),
    "server.js": 'throw new Error("broken while switched off");',
  });
  check("a broken update is refused even for a plugin that would not have run", offBroken.kind === "refused" ? offBroken.code : offBroken.kind, "plugin_start_failed");
  check("the row still names the version that works", host.list().map((one) => [one.version, one.enabled]), [["0.2.0", false]]);
  check("whose tree is still there", existsSync(join(root, "plugins", "board", "0.2.0", "server.js")), true);
  check("and the broken one left nothing behind", existsSync(join(root, "plugins", "board", "0.4.0")), false);
  const offGood = await install({ "plugin.json": manifestOf({ version: "0.5.0" }), "server.js": SERVER });
  check("a good update to a switched-off plugin lands", offGood.kind === "ok" ? offGood.replaced : offGood, "0.2.0");
  check("and is still switched off, at the new version", host.list().map((one) => [one.version, one.state, one.enabled]), [["0.5.0", "stopped", false]]);
  check("with what it kept", stores.pluginData.keys("board", "").length > 0, true);
  check("switching it back on", (await switched("board", true))?.state, "running");

  /* ---------------------------------------------------------------- *
   * Switching one off, and removing it.
   * ---------------------------------------------------------------- */
  check("switching it off", (await switched("board", false))?.enabled, false);
  check("and it stops", host.list().map((one) => one.state), ["stopped"]);
  check("a plugin that is off will not draw", await host.find("board")?.invoke("view", "settings", {}).then(
    () => "drew",
    (error: unknown) => (error as { code?: string }).code ?? "threw",
  ), "plugin_unavailable");
  check("switching it back on", (await switched("board", true))?.enabled, true);
  const revived = await host.find("board")?.invoke("view", "settings", {});
  check(
    "and it still has what it kept",
    revived?.kind === "view" ? revived.view.blocks[0] : null,
    { type: "text", text: "kept", tone: "default" },
  );

  /* ---------------------------------------------------------------- *
   * One mutation at a time, for the whole daemon.
   *
   * The mutex used to cover installs against each other and nothing else, so a
   * `DELETE` landing while an archive was still being read took the row, the
   * directory and every `plugin_data` key — and the install then re-created the
   * row and left the plugin running with its data gone, answering `replaced:
   * null` because `existing` had been captured before the removal. Both halves
   * are asserted: that the mutation is refused while the install holds the flag,
   * and that what the plugin kept is still there when the install lands.
   * ---------------------------------------------------------------- */
  {
    const stalled = stallingBody(tarOf({ "plugin.json": manifestOf({ version: "0.6.0" }), "server.js": SERVER }));
    const flight = host.install({ body: stalled.body, name: "board.tgz" });
    check("a remove during an install is refused rather than run", await host.remove("board"), "busy");
    check("and so is a switch", await host.setEnabled("board", false), "busy");
    stalled.release();
    const landed = await flight;
    check("and the install it was racing still lands", landed.kind === "ok" ? landed.replaced : landed.kind, "0.5.0");
    check("with what the plugin kept", stores.pluginData.keys("board", "").length > 0, true);
    check("and the switch is answerable again", (await switched("board", true))?.enabled, true);
  }

  check("removing one that is not there", await host.remove("nothing"), false);
  check("removing one that is", await host.remove("board"), true);
  check("takes its row", host.list(), []);
  check("its directory", existsSync(join(root, "plugins", "board")), false);
  // Its data goes with it, and only here — an update keeps it, which is the pair
  // this assertion makes with the one above.
  check("and everything it kept", stores.pluginData.keys("board", ""), []);

  await host.shutdown();
  await registry.shutdown();
  stores.close();
}

process.stdout.write("\nwhat a plugin is allowed to ask the daemon for\n");
{
  const { MAX_PLUGIN_FETCH_BYTES, PluginApi, PluginApiError } = await import("../src/plugins/api.js");
  const { MAX_PLUGIN_MESSAGE_BYTES } = await import("../src/plugins/runtime.js");
  const { parseManifest } = await import("../src/plugins/manifest.js");
  const { PLUGIN_SCOPES } = await import("../src/plugins/protocol.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");

  /*
   * `id` is a parameter because `PluginApi` keys its fetch window on it and
   * nothing gives the window back: the 40-request spray below spends `p`'s budget
   * for the rest of the process, so a later section wanting a real `net.fetch`
   * answer has to ask under a different name. (That the window outlives the
   * plugin is its own finding — a plugin uninstalled and reinstalled under one id
   * inherits the previous one's spent budget.)
   */
  const manifestWith = (scopes: string[], net: string[] = [], id = "p"): PluginManifest => {
    const parsed = parseManifest(
      JSON.stringify({ id, name: "P", version: "1.0.0", api: 1, scopes, net, contributes: {} }),
    );
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.manifest;
  };

  const reached: string[] = [];
  const warned: string[] = [];
  /*
   * What the far end says, swappable — because the *response* half of `net.fetch`
   * was driven by nothing at all. This answered `"hi"` and only ever `"hi"`, so
   * neither the `content-length` refusal nor `readBounded` — a function whose
   * whole reason for existing is that `response.text()` arrived too late to be a
   * measurement — was ever reached.
   */
  let answers: () => Response = () => new Response("hi", { status: 200 });

  const api = new PluginApi({
    registry: new SessionRegistry(),
    /*
     * Written out here once, and hoisted to {@link memoryPluginData} the moment
     * `SqlitePluginDataStore` had to be driven against the same object: the two
     * implementations refuse and page identically or `checkPluginWrite` is shared
     * for nothing, and a second copy of the fake is exactly how that stops being
     * true. Its docblock keeps the argument for why it is keyed on the *pair*.
     */
    data: memoryPluginData(),
    git: hostGit,
    onWarning: (detail) => warned.push(detail),
    fetchImpl: ((url: URL) => {
      reached.push(String(url));
      return Promise.resolve(answers());
    }) as unknown as typeof fetch,
  });

  const codeOf = async (manifest: PluginManifest, method: string, args: unknown = {}): Promise<string> => {
    try {
      await api.call(manifest, method, args);
      return "ok";
    } catch (error) {
      return error instanceof PluginApiError ? error.code : "threw";
    }
  };

  /*
   * **Every method, refused for a plugin that declared nothing.** Written as a
   * sweep over one manifest rather than as a case per method, so a method added
   * without a `SCOPE_OF` entry is caught here rather than being reachable by
   * everybody — which is the failure mode that gate has.
   */
  const nothing = manifestWith([]);
  const METHODS: [string, unknown][] = [
    ["sessions.list", {}],
    ["sessions.get", { id: "s" }],
    ["sessions.events", { id: "s" }],
    ["sessions.changes", { id: "s" }],
    ["sessions.diff", { id: "s", path: "a" }],
    ["sessions.workspace", { id: "s" }],
    ["sessions.create", { agent: "claude", cwd: "/tmp" }],
    ["sessions.prompt", { id: "s", text: "hi" }],
    ["sessions.cancel", { id: "s" }],
    ["sessions.stop", { id: "s" }],
    ["sessions.setMeta", { id: "s" }],
    ["sessions.answerPermission", { id: "s", permissionId: "p", optionId: "o" }],
    ["sessions.answerElicitation", { id: "s", elicitationId: "e" }],
    ["agents.list", {}],
    ["files.read", { sessionId: "s", path: "a" }],
    ["store.get", { key: "k" }],
    ["store.set", { key: "k", value: 1 }],
    ["store.delete", { key: "k" }],
    ["store.keys", {}],
    ["store.entries", {}],
    ["net.fetch", { url: "https://api.example.com/" }],
    /*
     * The one method that spends the operator's quota rather than the machine's
     * access. In this sweep for the same reason as every other: the plugin
     * declaring nothing must be refused *before* anything is asked of an agent —
     * the scope gate runs ahead of the availability check, so this is refused on
     * a daemon that has no asker wired at all.
     */
    ["model.complete", { agent: "claude", prompt: "hi" }],
    /*
     * And its sibling, which spends no quota and still spawns an agent — so it
     * sits behind the same scope and is refused on the same terms. In this sweep
     * for the same reason as every other: the gate runs ahead of the availability
     * check, so a plugin declaring nothing is refused on a daemon with no asker
     * wired at all.
     */
    ["model.list", { agent: "claude" }],
  ];
  const denied: string[] = [];
  for (const [method, args] of METHODS) {
    if ((await codeOf(nothing, method, args)) !== "plugin_scope_denied") denied.push(method);
  }
  check("every method needs a scope, and a plugin with none reaches nothing", denied, []);
  report(
    "and every scope in the union is the gate for at least one of them",
    PLUGIN_SCOPES.length === 6,
    `${METHODS.length} methods behind ${PLUGIN_SCOPES.length} scopes`,
  );
  /*
   * ⚠ **The number is written here and has to be moved by hand, which is the
   * whole of what this line is worth.** `SCOPE_OF` holds twenty-three entries —
   * twenty-two scoped methods plus `log`, which needs none and is driven on its
   * own below — and the table above is a hand-written mirror of it. The sweep
   * claims "every method", and that claim is only as good as somebody having
   * added a row here; nothing on this side can derive the list, because `SCOPE_OF`
   * is module-private and exporting it so a driver could read it would make the
   * gate importable by anything else that wanted to reason about it. **Measured
   * while writing this**: `store.entries` had been added to `SCOPE_OF` and never
   * here, so the assertion above was true of twenty of the twenty-one and said
   * "every method" about a table missing one. A further scoped method needs
   * a row and this count moved in the same edit — which `model.complete` duly
   * did, failing all three of these lines until it was written down here — and
   * `model.list` after it.
   */
  check("and the sweep is the whole of that table", METHODS.length, 23);

  /*
   * ⚠ **Every method a plugin may call is one it can *reach*, and this assertion
   * exists because one was not.**
   *
   * `model.complete` had an entry in `SCOPE_OF`, an arm in the dispatcher, a row
   * in the table above, a sentence on the consent screen and a version bump — and
   * no line in the object the child process is handed. `ctx.model` was
   * `undefined`, so a plugin calling it got a `TypeError` before a byte crossed
   * the IPC channel. Eight drivers were green: every one of them tested the host's
   * half, and the two halves meet at `api.ts` and part at `context.ts`.
   *
   * That is the sixth bug of the same shape in one day — *the only check of a
   * place contained the same misunderstanding as the code* — and the first in this
   * direction. The table above says what a plugin is *allowed* to call; this says
   * what a plugin can *say*, and the gap between the two was invisible.
   *
   * Two properties, and the second is the one a smoke test would miss: the
   * function is there, **and** it asks for the method it is named for. A branch
   * calling the wrong string is reachable, well-typed, and answers
   * `unknown_method` at runtime.
   */
  {
    const { pluginContext } = await import("../src/plugins/context.js");
    const asked: string[] = [];
    const ctx = pluginContext(
      (method) => {
        asked.push(method);
        return Promise.resolve(null);
      },
      { id: "p", version: "1.0.0" },
    ) as Record<string, unknown>;

    const unreachable: string[] = [];
    const misnamed: string[] = [];
    for (const [method] of METHODS) {
      const [group, name] = method.split(".");
      const holder = group === undefined ? undefined : ctx[group];
      const fn = holder !== null && typeof holder === "object" ? (holder as Record<string, unknown>)[name ?? ""] : undefined;
      if (typeof fn !== "function") {
        unreachable.push(method);
        continue;
      }
      const before = asked.length;
      // Three empty objects: every builder either ignores its arguments or spreads
      // them, so this reaches the `call` without depending on any one signature.
      void (fn as (...args: unknown[]) => unknown)({}, {}, {});
      if (asked[before] !== method) misnamed.push(`${method} asked for ${asked[before] ?? "nothing"}`);
    }
    check("every method a plugin may call is one it can reach", unreachable, []);
    check("and each one asks the host for the method it is named for", misnamed, []);
    /*
     * `log` is not in the table above because it needs no scope — and it is the
     * one method whose absence would leave a plugin unable to say anything about
     * itself, so it is asserted separately rather than left out with its scope.
     */
    check("and logging is reachable too, though it is behind no scope", typeof ctx["log"], "function");
    check("nothing was asked for that the table does not hold", asked.length, METHODS.length);
  }

  check("a method that does not exist", await codeOf(manifestWith(["store"]), "sessions.destroy"), "unknown_method");
  // The one method with no scope at all, because it is how a plugin says anything
  // about itself and refusing it would make a plugin that declared nothing silent.
  check("logging needs nothing", await codeOf(nothing, "log", { message: "hello" }), "ok");
  report("and it reaches the warning sink", warned.some((one) => one.includes("hello")), `${warned.length} warnings`);

  /*
   * A scope is refused **and reported**. A plugin exceeding what it told somebody
   * it needed is exactly the thing an operator would want to know about, and it is
   * invisible from the plugin's own screens.
   */
  const before = warned.length;
  await codeOf(nothing, "store.get", { key: "k" });
  report("a refused scope is reported as well as refused", warned.length > before, warned[warned.length - 1] ?? "");

  const stored = manifestWith(["store"]);
  check("with the scope it works", await codeOf(stored, "store.set", { key: "k", value: { a: 1 } }), "ok");
  check("and reads back parsed rather than as text", await api.call(stored, "store.get", { key: "k" }), { a: 1 });
  check("a key that was never written", await api.call(stored, "store.get", { key: "nope" }), null);
  check("and a prefix listing is a prefix listing", await api.call(stored, "store.keys", { prefix: "k" }), ["k"]);

  /* ---------------------------------------------------------------- *
   * The one outbound door.
   * ---------------------------------------------------------------- */
  const netted = manifestWith(["net"], ["api.example.com"]);
  check("a host the manifest lists", await codeOf(netted, "net.fetch", { url: "https://api.example.com/x" }), "ok");
  check("and it really went there", reached, ["https://api.example.com/x"]);
  check("a host it does not list", await codeOf(netted, "net.fetch", { url: "https://elsewhere.example/" }), "host_not_allowed");
  check("http rather than https", await codeOf(netted, "net.fetch", { url: "http://api.example.com/" }), "insecure_url");
  check("something that is not a URL", await codeOf(netted, "net.fetch", { url: "api.example.com" }), "invalid_url");
  // A refusal on the *host* must not have gone out first.
  check("and nothing refused was ever requested", reached, ["https://api.example.com/x"]);

  const spray: string[] = [];
  for (let i = 0; i < 40; i += 1) spray.push(await codeOf(netted, "net.fetch", { url: "https://api.example.com/" }));
  report(
    "a plugin cannot poll a host as fast as it likes",
    spray.includes("fetch_rate_limited"),
    `${spray.filter((one) => one === "ok").length} of ${spray.length} allowed`,
  );

  /* ---------------------------------------------------------------- *
   * `files.read`, which had no behavioural assertion at all.
   *
   * ⚠ **The one host method that hands a plugin the contents of a file, and it
   * appeared in this section exactly twice — both times as a row in the scope
   * table.** So what was proven is that it needs the `files.read` scope, and
   * nothing whatever about what it does once it has it. Its five refusals include
   * the pair `files-paths-git.md` calls load-bearing: `safeRelPath` refuses a
   * `.git` segment somebody *typed*, and the resolved re-test through
   * `probeRequestable` is what refuses the same directory reached through a
   * symlink. `server.ts` has a second caller of that pair and drives it; this one
   * did not, and it is the caller that answers a plugin rather than a person.
   *
   * A stub registry rather than the section's real one: this method reads exactly
   * `managed.workspace.root`, and standing up a real session to hand it one path
   * would be a fixture about `SessionRegistry` rather than about this arm.
   * ---------------------------------------------------------------- */
  {
    const tree = join(homedir(), ".reemoat-check-files");
    rmSync(tree, { recursive: true, force: true });
    mkdirSync(join(tree, "sub"), { recursive: true });
    mkdirSync(join(tree, ".git"), { recursive: true });
    writeFileSync(join(tree, "notes.txt"), "hello\n");
    writeFileSync(join(tree, ".git", "config"), "[core]\n");
    writeFileSync(join(tree, "fat.bin"), "z".repeat(64 * 1024 + 1));
    // The link is the whole reason the resolved re-test exists.
    symlinkSync(join(tree, ".git"), join(tree, "g"));

    const filed = new PluginApi({
      registry: {
        get: (id: string) => (id === "s" ? { workspace: { root: tree } } : undefined),
      } as unknown as SessionRegistry,
      data: memoryPluginData(),
      git: hostGit,
      onWarning: () => {},
    });
    const reads = async (path: string): Promise<string> => {
      try {
        return String(await filed.call(manifestWith(["files.read"], [], "files"), "files.read", { sessionId: "s", path }));
      } catch (error) {
        return error instanceof PluginApiError ? error.code : String(error);
      }
    };

    check("a file inside the tree reads", await reads("notes.txt"), "hello\n");
    check("one above it does not", await reads("../secret"), "invalid_path");
    check("nor an absolute path", await reads("/etc/hosts"), "invalid_path");
    check("nor .git spelled out", await reads(".git/config"), "invalid_path");
    // The half `safeRelPath` alone cannot answer, and the reason `probeRequestable`
    // is called at all.
    check("nor .git reached through a link", await reads("g/config"), "invalid_path");
    check("a directory is not a file", await reads("sub"), "not_a_file");
    check("and a file past the ceiling is refused rather than truncated", await reads("fat.bin"), "file_too_large");
    // The stub answers `undefined` for every other id, which is what a registry
    // does for a session that is not here.
    check("and a path is never even looked at for a session this machine does not have", await (async () => {
      try {
        await filed.call(manifestWith(["files.read"], [], "files"), "files.read", { sessionId: "gone", path: "notes.txt" });
        return "no refusal";
      } catch (error) {
        return error instanceof PluginApiError ? error.code : String(error);
      }
    })(), "session_not_found");
    rmSync(tree, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- *
   * What comes back, which nothing asked about.
   *
   * Two bounds and they catch different servers: a `content-length` is refused
   * before a byte is read, and a server that declares nothing is refused *while*
   * it is still sending. The second is the one that matters — a plugin's own
   * allowlisted host answering an endless chunked body could otherwise spend the
   * whole 10s window growing this daemon's heap, which is the measurement
   * `readBounded`'s docblock records.
   * ---------------------------------------------------------------- */
  {
    const fresh = manifestWith(["net"], ["late.example.com"], "late");
    answers = () =>
      new Response("x", { status: 200, headers: { "content-length": String(8 * 1024 * 1024) } });
    check(
      "a response that declares more than a plugin may read",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/a" }),
      "response_too_large",
    );

    // The case the header cannot see: no `content-length`, and it never stops.
    let pulls = 0;
    answers = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(64 * 1024));
          },
        }),
        { status: 200 },
      );
    check(
      "and one that simply keeps sending",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/b" }),
      "response_too_large",
    );
    // Charged per chunk rather than once the body is whole, which is the whole
    // point: a bound that reads everything first is not a bound.
    report("refused while it was still arriving", pulls > 0 && pulls < 64, `${pulls} chunks read`);

    /*
     * ⚠ **Refused before a byte of it is read — which the `/a` case above cannot
     * show.** Its body was the two-character string `"x"`, so a header gate that
     * read the whole thing first and refused it afterwards would have passed that
     * assertion unchanged. A body that counts its own pulls is what separates the
     * two, and the assertion is zero.
     *
     * ⚠ **`highWaterMark: 0`, or this fails against its own fixture.** A
     * `ReadableStream` built with no strategy gets a `CountQueuingStrategy` of one
     * and calls `pull` once at construction — before any reader exists, whatever
     * this daemon does, and `body.cancel()` does not undo it. Measured: one pull
     * with the default, none at zero. At zero the only thing that can move this
     * counter is somebody reading.
     */
    let declaredPulls = 0;
    answers = () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              declaredPulls += 1;
              controller.enqueue(new Uint8Array(1024));
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200, headers: { "content-length": String(MAX_PLUGIN_FETCH_BYTES + 1) } },
      );
    check(
      "one byte past the bound, honestly declared",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/c" }),
      "response_too_large",
    );
    report("and its body was never pulled at all", declaredPulls === 0, `${declaredPulls} chunks read`);

    /*
     * ⚠ **The bound against the channel it has to cross, which nothing checked.**
     * `MAX_PLUGIN_FETCH_BYTES` was `1024 * 1024` while one IPC message carries
     * `MAX_PLUGIN_MESSAGE_BYTES`, so every answer past roughly 250 KiB was
     * fetched in full, charged to the plugin's thirty a minute, read into this
     * daemon's heap — and then refused by `ForkedPlugin.send`, which was the only
     * place the two numbers ever met. So the largest answer the API will hand
     * back is built here and measured inside the `{"t":"answer",…}` envelope
     * `LivePlugin.onChildMessage` actually sends.
     *
     * A body that is all `"` because that is a body's worst *realistic* escape:
     * `JSON.stringify` doubles it, and a JSON payload — the thing `net.fetch`
     * exists to go and fetch — is already a third quotes. Measured at this bound:
     * 131,182 bytes of the 262,144 the channel takes, against 262,254 for the
     * half-channel bound this would otherwise have inherited from `store.entries`.
     */
    answers = () =>
      new Response('"'.repeat(MAX_PLUGIN_FETCH_BYTES), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const largest = (await api.call(fresh, "net.fetch", { url: "https://late.example.com/d" })) as {
      body: string;
    };
    check("a body of exactly the bound is answered rather than refused", largest.body.length, MAX_PLUGIN_FETCH_BYTES);
    const wire = Buffer.byteLength(JSON.stringify({ t: "answer", id: 1, ok: true, value: largest }), "utf8");
    report(
      "and the largest answer it will hand back still crosses the channel it is delivered on",
      wire <= MAX_PLUGIN_MESSAGE_BYTES,
      `${wire} of ${MAX_PLUGIN_MESSAGE_BYTES} bytes`,
    );

    // The other side of that boundary, undeclared, so `readBounded` is the only
    // thing that can catch it. `new Response(string)` sets no `content-length` —
    // measured — which is what makes this the chunked path rather than the header
    // one, with a body one byte over instead of an endless stream.
    answers = () => new Response("a".repeat(MAX_PLUGIN_FETCH_BYTES + 1), { status: 200 });
    check(
      "and one byte more than that is refused",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/e" }),
      "response_too_large",
    );

    /*
     * ⚠ **Inside the read bound and still undeliverable**, which is the case the
     * assembled-answer check at the end of `fetch` exists for. Every C0 control
     * byte is a six-character `\u00XX` escape, so a body at exactly the read bound
     * serialises to 393,326 against a 262,144-byte channel. Refused here with the
     * code the docs publish, rather than assembled, charged and then dropped by
     * `ForkedPlugin.send` naming a limit the plugin was never given.
     */
    answers = () =>
      new Response(String.fromCharCode(1).repeat(MAX_PLUGIN_FETCH_BYTES), { status: 200 });
    check(
      "a body inside the bound that could not be delivered is refused here, not at the channel",
      await codeOf(fresh, "net.fetch", { url: "https://late.example.com/f" }),
      "response_too_large",
    );

    answers = () => new Response("hi", { status: 200 });
  }

  /*
   * `agents.list` sits behind `sessions.read` rather than a scope of its own: it
   * is the fact a plugin needs *before* `sessions.create`, and a fifth scope for
   * one method would be a fifth line somebody has to understand in the install
   * list.
   */
  report(
    "asking what this machine could run needs only sessions.read",
    Array.isArray(await api.call(manifestWith(["sessions.read"]), "agents.list", {})),
    "an array of availability rows",
  );

  check("a session this machine does not have", await codeOf(manifestWith(["sessions.read"]), "sessions.get", { id: "s_nope" }), "session_not_found");
  check("and an argument that is not a string", await codeOf(manifestWith(["sessions.read"]), "sessions.get", { id: 7 }), "bad_request");

  /* ---------------------------------------------------------------- *
   * Which scope, and not merely that there is one.
   *
   * ⚠ **The sweep above proves every method needs *a* scope. It cannot prove any
   * of them needs the right one** — it runs one manifest declaring nothing, so a
   * table mapping `"sessions.stop"` to `"sessions.read"` would satisfy every
   * assertion in this file up to here while handing a read-only plugin the verb
   * that ends somebody's session. The two halves are not the same claim and only
   * one of them was being made.
   *
   * Derived rather than restated: each method is asked five times, once per
   * manifest holding four of the five scopes, and the scope whose absence is the
   * one that draws `plugin_scope_denied` is the scope that method actually needs.
   * That is what a driver can find out from outside `api.ts`. The comparison at
   * the end is against a literal, which is the copy — **exporting `SCOPE_OF` would
   * let this be derived instead, and it is deliberately not exported**: it is the
   * gate, and a gate exported so a test can read it is a gate anything else can
   * import and reason about.
   *
   * Every probe is sent `{}`, so the four that pass the gate fail immediately on
   * `bad_request` or `session_not_found` rather than doing the thing. That is not
   * tidiness — with real arguments this loop would call `sessions.create` sixteen
   * times and `sessions.stop` on whatever it made.
   * ---------------------------------------------------------------- */
  const scopeNeededBy = async (method: string): Promise<string> => {
    const refused: string[] = [];
    for (const missing of PLUGIN_SCOPES) {
      const held = PLUGIN_SCOPES.filter((one) => one !== missing);
      // A manifest declaring `net` must name hosts, so the list rides the scope
      // rather than being constant — `readNet` refuses the pair that disagrees.
      const manifest = manifestWith([...held], held.includes("net") ? ["api.example.com"] : []);
      if ((await codeOf(manifest, method, {})) === "plugin_scope_denied") refused.push(missing);
    }
    // Never "the first one refused": a method behind two scopes, or behind none
    // once somebody edits the table, is a different fact from a mis-mapping and
    // has to read differently in the output.
    return refused.length === 1 ? String(refused[0]) : `${refused.length} scopes: ${refused.join("+")}`;
  };
  const mapping: [string, string][] = [];
  for (const [method] of METHODS) mapping.push([method, await scopeNeededBy(method)]);
  check("and each of them is behind the right one", mapping, [
    ["sessions.list", "sessions.read"],
    ["sessions.get", "sessions.read"],
    ["sessions.events", "sessions.read"],
    ["sessions.changes", "sessions.read"],
    ["sessions.diff", "sessions.read"],
    ["sessions.workspace", "sessions.read"],
    ["sessions.create", "sessions.write"],
    ["sessions.prompt", "sessions.write"],
    ["sessions.cancel", "sessions.write"],
    ["sessions.stop", "sessions.write"],
    ["sessions.setMeta", "sessions.write"],
    ["sessions.answerPermission", "sessions.write"],
    ["sessions.answerElicitation", "sessions.write"],
    // The one that is not obvious from its name, and the one a refactor would get
    // wrong first. See the comment on `SCOPE_OF` for why it is not its own scope.
    ["agents.list", "sessions.read"],
    ["files.read", "files.read"],
    ["store.get", "store"],
    ["store.set", "store"],
    ["store.delete", "store"],
    ["store.keys", "store"],
    ["store.entries", "store"],
    ["net.fetch", "net"],
    ["model.complete", "model"],
    // Not `sessions.read`, which is where a method called "list" would land by
    // reflex — reading an agent's model list spawns that agent, so it belongs
    // with the one that spends, not with the ones that only look.
    ["model.list", "model"],
  ]);
}

process.stdout.write("\nasking an agent one question, and every way that is refused\n");
{
  const { AgentAskRuns, AgentAskError, MAX_ASK_PROMPT_BYTES, MAX_CONCURRENT_ASKS } = await import(
    "../src/agentask.js"
  );

  /**
   * A runtime that answers `availability()` and nothing else.
   *
   * ⚠ **Every case below is refused *before* `launch` is reached**, which is the
   * property that makes this fake honest rather than convenient: `launch` throws,
   * so any assertion that accidentally got past the gate would fail loudly rather
   * than pass on a stub. The refusals that need a real ACP session — the deadline,
   * the output ceiling, the text collection — are not here and are named at the
   * foot of this section rather than left to look covered.
   */
  const runtimeWith = (agents: { id: string; available: boolean; loggedIn: boolean | null; hint?: string }[]): never =>
    ({
      availability: () =>
        Promise.resolve(
          agents.map((one) => ({
            id: one.id,
            displayName: one.id,
            available: one.available,
            hint: one.hint ?? null,
            loggedIn: one.loggedIn,
          })),
        ),
      launch: () => {
        throw new Error("this driver refuses before anything is launched");
      },
    }) as never;

  const codeOfAsk = async (runs: InstanceType<typeof AgentAskRuns>, agent: string, prompt = "hi"): Promise<string> => {
    try {
      await runs.ask(agent as never, prompt);
      return "none";
    } catch (error) {
      return error instanceof AgentAskError ? error.code : `unexpected: ${String(error)}`;
    }
  };

  const claudeOnly = runtimeWith([{ id: "claude", available: true, loggedIn: true }]);
  const runs = new AgentAskRuns({ runtime: claudeOnly, cwd: tmp("ask-") });

  check("an agent this machine does not have", await codeOfAsk(runs, "kimi"), "model_agent_unknown");
  check(
    "a prompt larger than a prompt may be",
    await codeOfAsk(runs, "claude", "x".repeat(MAX_ASK_PROMPT_BYTES + 1)),
    "model_prompt_too_large",
  );
  check("and nothing to ask at all", await codeOfAsk(runs, "claude", "   "), "model_prompt_empty");

  /*
   * ⚠ **`loggedIn` is three-valued, and `null` must be attempted rather than
   * refused.** Q7.99 records this exact mistake one subsystem over: `null` means
   * *this agent has no non-interactive way to answer*, which is permanently true
   * of kimi — so reading it as "not signed in" refuses an agent that works, and
   * on this path there is no screen on which anybody could discover otherwise.
   *
   * The assertion is that `null` gets **past** the gate: it reaches `launch`,
   * which this fake throws from, so `model_failed` here is the proof that the
   * check did not short-circuit. `false` is refused before that.
   */
  const mixed = new AgentAskRuns({
    runtime: runtimeWith([
      { id: "claude", available: true, loggedIn: false },
      { id: "kimi", available: true, loggedIn: null },
      { id: "codex", available: false, loggedIn: null, hint: "install codex first" },
    ]),
    cwd: tmp("ask-"),
  });
  check("an agent that is installed and signed out", await codeOfAsk(mixed, "claude"), "model_agent_signed_out");
  check(
    "an agent that cannot say whether it is signed in is tried, not refused",
    await codeOfAsk(mixed, "kimi"),
    "model_failed",
  );
  check("an agent that is not installed carries the runtime's own hint", await codeOfAsk(mixed, "codex"), "model_agent_unavailable");
  check(
    "and the hint is what it says rather than a sentence this file invented",
    await mixed.ask("codex" as never, "hi").catch((error: unknown) => (error as Error).message),
    "install codex first",
  );

  /*
   * ⚠ **The daemon-wide cap, and it counts starts as well as running turns.** A
   * cap that only counted `live` would let N calls all get past the check while
   * every one of them was still inside `Session.start` — which is a subprocess
   * spawn and an ACP handshake, i.e. the expensive part. `inFlight` is the sum,
   * and `starting` is why.
   */
  const slow = new AgentAskRuns({
    runtime: {
      availability: () => Promise.resolve([{ id: "claude", displayName: "claude", available: true, hint: null, loggedIn: true }]),
      // `Session.start` asks for this *before* it launches, so a fake without it
      // throws there and never reaches the park — which is how the first version
      // of this case measured `model_failed` and an empty `starting`.
      describe: () => ({ displayName: "claude", authHint: "" }),
      clientFileIo: false,
      // Never resolves, so every accepted ask stays in `starting`.
      launch: () => new Promise(() => {}),
    } as never,
    cwd: tmp("ask-"),
  });
  const parked = Array.from({ length: MAX_CONCURRENT_ASKS }, () => slow.ask("claude" as never, "hi").catch(() => "parked"));
  // Let each of them get past the availability await and into `starting`.
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("one more than the machine will run at once", await codeOfAsk(slow, "claude"), "model_busy");
  check("and the cap counted the ones still starting", slow.inFlight, MAX_CONCURRENT_ASKS);

  /*
   * ⚠ **Shutdown waits for what was still being born.** An ask accepted moments
   * before SIGTERM is inside `Session.start` when the drain runs; without
   * awaiting `starting` it would spawn *after* the drain and outlive
   * `process.exit(0)` with nothing holding it. `AgentLoginRuns` records the same
   * measurement. Driven here by leaving two parked starts and asserting that a
   * shutdown does not race past them — and that the door is shut afterwards.
   */
  const closing = slow.shutdown();
  check("an ask arriving during shutdown is refused rather than started", await codeOfAsk(slow, "claude"), "model_unavailable");
  void parked;
  void closing;

  /*
   * ⚠ **Not covered here, and said rather than left looking covered:** the wall
   * clock, the output ceiling and the text collection all need a real ACP
   * handshake, so they are exercised by `pnpm harness` against a live agent
   * rather than by this driver. What this section does cover is every refusal
   * that happens before a process is spawned — which is every refusal a plugin
   * author can actually provoke by getting the call wrong.
   */
}

process.stdout.write("\nwhich model a one-shot ask runs on\n");
{
  /* ---------------------------------------------------------------- *
   * ⚠ **This daemon has no list of models and could not have one.** There is no
   * field called `model` anywhere in `src/`: selection travels over ACP's
   * `session/set_config_option`, where "model" is one value of the option's
   * `category`, and what exists is whatever the agent's CLI decided this week. So
   * the only honest answer to *which models are there* is to start the agent and
   * read what it publishes — and the only way to drive that offline is a real
   * `Session` over pipes with a fake agent on the far end, which is what this is.
   *
   * The three things a refusal-only fake could never reach: that the list really
   * comes off `session/new`, that a chosen model really reaches
   * `session/set_config_option`, and that a *stale* choice is refused against the
   * agent standing in front of us rather than against the cache somebody read.
   * ---------------------------------------------------------------- */
  const acp = await import("@agentclientprotocol/sdk");
  const { LocalRuntime } = await import("../src/runtime/local.js");
  const { PassThrough } = await import("node:stream");
  const { AgentAskRuns, AgentAskError, MODELS_TTL_MS } = await import("../src/agentask.js");

  /** Every `session/set_config_option` the daemon sent, as it sent it. */
  const configured: { configId: string; value: unknown }[] = [];
  /** How many `session/new` calls this fake has answered. Feeds the cache case. */
  let opened = 0;
  /** What the agent claims its models are. Rewritten mid-section, on purpose. */
  let models = [
    { value: "opus", name: "Opus 5", description: "the big one" },
    { value: "haiku", name: "Haiku 4.5", description: null },
  ];

  /*
   * ⚠ **A fresh pair of pipes per launch, not one pair shared.** Every case here
   * starts and disposes a session, and `dispose` ends the agent's stdin — so a
   * single pair works exactly once and every case after the first dies with "ACP
   * connection closed". That is an artefact of both ends being in this process,
   * and it is the reason the peer is built inside `launch` rather than around it.
   */
  /*
   * ⚠ **A turn that never answers, opt-in, so every assertion below keeps the fake
   * it already had.** The cancellation case needs an agent that has started and is
   * still talking — a `session/prompt` that resolves at once can only ever be
   * raced by a deadline, never by a caller walking away.
   */
  let hangPrompt = false;
  const speak = (): { toAgent: PassThrough; toClient: PassThrough } => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (message: unknown): boolean => toClient.write(`${JSON.stringify(message)}\n`);
    let buffer = "";
    toAgent.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, any>;
        const id = message["id"];
        switch (message["method"]) {
          case acp.methods.agent.initialize:
            send({
              jsonrpc: "2.0",
              id,
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new:
            opened += 1;
            /*
             * ⚠ **Two options, and the model one is *not* first.** Found by
             * `category`, never by id or position — the standing rule about every
             * agent control in this fleet, and the one a reflex `options[0]` would
             * break silently on the agent that happens to order them the other way.
             */
            send({
              jsonrpc: "2.0",
              id,
              result: {
                sessionId: "s_models",
                configOptions: [
                  {
                    id: "effort",
                    name: "Effort",
                    category: "thought_level",
                    type: "select",
                    currentValue: "default",
                    options: [{ value: "default", name: "Default" }],
                  },
                  {
                    id: "model-picker",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: "opus",
                    options: models,
                  },
                ],
              },
            });
            break;
          case acp.methods.agent.session.setConfigOption:
            configured.push({ configId: message["params"]?.configId, value: message["params"]?.value });
            // ACP defines the response's `configOptions` as the complete list, so
            // this answers with the whole thing rather than a delta.
            send({
              jsonrpc: "2.0",
              id,
              result: {
                configOptions: [
                  {
                    id: "model-picker",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: message["params"]?.value,
                    options: models,
                  },
                ],
              },
            });
            break;
          case acp.methods.agent.session.prompt:
            // Deliberately unanswered where the case under test is a caller that
            // leaves mid-turn; see {@link hangPrompt}.
            if (hangPrompt) break;
            send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
            break;
          default:
            if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
        }
      }
    });
    return { toAgent, toClient };
  };

  // A runtime that is the local one in every respect except where the agent is —
  // subclassing rather than hand-rolling, so a new required member is a type
  // error here rather than a silently untested path.
  class ModelPipes extends LocalRuntime {
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override availability(): Promise<any> {
      return Promise.resolve([{ id: "claude", displayName: "claude", available: true, hint: null, loggedIn: true }]);
    }
    override async launch(): Promise<any> {
      const { toAgent, toClient } = speak();
      return {
        stdin: toAgent,
        stdout: toClient,
        stderr: new PassThrough(),
        handle: null,
        onceStartError: () => () => {},
        onceExit: () => () => {},
        hasExited: false,
        waitForExit: async () => true,
        endStdin: () => toAgent.end(),
        kill: async () => {},
      };
    }
  }

  const runs = new AgentAskRuns({ runtime: new ModelPipes() as never, cwd: process.cwd() });

  const listed = await runs.models("claude" as never);
  check(
    "the models are the ones the agent published, not a list this daemon holds",
    listed.map((one) => [one.id, one.name, one.description]),
    [
      ["opus", "Opus 5", "the big one"],
      ["haiku", "Haiku 4.5", null],
    ],
  );
  check("and it cost one agent to find out", opened, 1);

  /*
   * ⚠ **Cached, because the answer costs a subprocess and an ACP handshake.** A
   * settings pane opened twice must not spawn twice. The negative control is the
   * whole assertion: without it, "the list is right" passes on a build that spawns
   * every time.
   */
  const again = await runs.models("claude" as never);
  check("asking again spawns nothing", opened, 1);
  check("and answers the same thing", again.length, listed.length);
  report("the cache is a ceiling on staleness rather than for ever", MODELS_TTL_MS > 0, `${MODELS_TTL_MS}ms`);

  /*
   * ⚠ **A chosen model reaches `session/set_config_option`, with the option's own
   * id.** `model-picker` is deliberately not `model`: a build that sent the
   * *category* as the id would look right in every log and be refused by every
   * real agent.
   */
  await runs.ask("claude" as never, "hi", "haiku");
  check("a chosen model is sent as the option the agent named", configured, [{ configId: "model-picker", value: "haiku" }]);

  /*
   * ⚠ **Three spellings of "not chosen", and all three mean the agent's own
   * default.** Absent, `null` and `""` arrive from shapes nobody controls — a
   * field left out of a JSON body, a `ctx.store.get` for a key nobody wrote, and a
   * form submitting an untouched control. Picking one as *the* spelling makes the
   * other two an error a plugin author discovers in production, which is exactly
   * what the store contract cost somebody a day of. Swept rather than sampled.
   */
  configured.length = 0;
  const spellings: [string, string | undefined][] = [
    ["left out", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ];
  /*
   * ⚠ **Both halves, because "set nothing" alone passes on a build that
   * *threw*.** An implementation reading `""` as a chosen model refuses it as
   * unknown — which also configures nothing, so an assertion about `configured`
   * would be green while every plugin storing an untouched setting was broken.
   * The refusals are collected rather than allowed to reject, so the difference is
   * a named failure rather than a driver that dies here.
   */
  const refused: string[] = [];
  for (const [name, model] of spellings) {
    await runs.ask("claude" as never, "hi", model).catch((error: unknown) => refused.push(`${name}: ${String(error)}`));
  }
  check("no model chosen, in any of its spellings, is refused", refused, []);
  check("and none of them sets anything", configured, []);

  const codeOfAsk = async (model: string): Promise<string> => {
    try {
      await runs.ask("claude" as never, "hi", model);
      return "none";
    } catch (error) {
      return error instanceof AgentAskError ? error.code : `unexpected: ${String(error)}`;
    }
  };
  const messageOf = async (model: string): Promise<string> =>
    await runs.ask("claude" as never, "hi", model).then(
      () => "none",
      (error: unknown) => (error as Error).message,
    );

  check("a model this agent does not offer", await codeOfAsk("gpt-9"), "model_unknown");
  /*
   * ⚠ **The refusal names what is really there.** "Unknown model" and a full stop
   * sends somebody to guess — and a plugin author has no copy of the agent's list,
   * so guessing is all that is left.
   */
  report("and says what it does offer", (await messageOf("gpt-9")).includes("opus"), await messageOf("gpt-9"));
  check("and nothing was sent for the one it refused", configured, []);

  /*
   * ⚠ **Validated against the agent in front of us, never against the cache.**
   * The list somebody chose from may be up to `MODELS_TTL_MS` old and a CLI update
   * can retire a model in between — so a choice that was valid when the dropdown
   * was drawn has to be refused *by name* rather than sent. Driven by retiring a
   * model behind the cache's back: `models()` still answers the old pair, and the
   * ask still refuses.
   */
  models = [{ value: "opus", name: "Opus 5", description: "the big one" }];
  const stale = await runs.models("claude" as never);
  check("the cache still believes the retired model exists", stale.map((one) => one.id), ["opus", "haiku"]);
  check("but using it is refused against what the agent says now", await codeOfAsk("haiku"), "model_unknown");

  /*
   * ⚠ **A caller that walks away ends the turn, rather than the turn outliving it
   * by nearly two minutes.** `ASK_TIMEOUT_MS` is 120 s and the only caller this
   * has is a plugin invocation with `PLUGIN_INVOKE_TIMEOUT_MS` — 10 s — to answer
   * in, three of those stopping the plugin altogether. So the measured shape was a
   * plugin timed out, then stopped, then removed with its row and tree deleted,
   * and an agent subprocess still holding one of the two slots this machine allows
   * for another 110 seconds. `LivePlugin.hostCallsAbort` is what now says so, and
   * this is the far end of that signal.
   *
   * ⚠ **Its own `AgentAskRuns`, with a driver-only half-second deadline.** Reusing
   * the section's `runs` would leave a build with the signal reverted hanging out
   * the full two minutes before failing; here it fails in half a second, and as
   * `model_timeout` rather than `model_cancelled`, which is the difference the
   * assertion is about. `timeoutMs` is documented as existing for exactly this.
   */
  const leaving = new AgentAskRuns({ runtime: new ModelPipes() as never, cwd: process.cwd(), timeoutMs: 500 });
  hangPrompt = true;
  const walkAway = new AbortController();
  const asked = leaving.ask("claude" as never, "hi", undefined, walkAway.signal);
  // Long enough for the handshake, `session/new` and the prompt to be in flight —
  // the window this is about is the one *after* the agent has started.
  await new Promise((resolve) => setTimeout(resolve, 50));
  walkAway.abort(new Error("plugin board was stopped"));
  check(
    "a caller that has gone ends the turn rather than waiting the deadline out",
    await asked.then(
      () => "none",
      (error: unknown) => (error instanceof AgentAskError ? error.code : `unexpected: ${String(error)}`),
    ),
    "model_cancelled",
  );
  /*
   * ⚠ **And the agent it started is disposed rather than merely unwaited-for.**
   * The refusal travelling is half the fix; `ask`'s `finally` letting go of the
   * subprocess is the half that gives the slot back, and `inFlight` counts
   * `reserved`, `starting` and `live` together — so this is also the assertion
   * that the abort did not corrupt that accounting.
   */
  check("and the agent it started is let go of", leaving.inFlight, 0);
  hangPrompt = false;
  await leaving.shutdown();

  await runs.shutdown();
}

process.stdout.write("\na plugin that will not start, or will not answer\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { parseManifest } = await import("../src/plugins/manifest.js");
  const { openStores } = await import("../src/store/sqlite.js");

  const parsed = parseManifest(
    JSON.stringify({ id: "p", name: "P", version: "1.0.0", api: 1, scopes: [], contributes: { settings: true } }),
  );
  if (!parsed.ok) throw new Error(parsed.message);
  const manifest = parsed.manifest;

  /**
   * A child this driver controls completely.
   *
   * **This is why `PluginRuntime` is an interface.** A start that never completes,
   * an invocation that is never answered and a crash after `ready` are the three
   * paths worth being sure about, and none of them is reachable by spawning a real
   * process and hoping it misbehaves on cue.
   */
  const scripted = (
    behaviour: { init: "ready" | "fail" | "silent"; answer: "yes" | "silent" },
  ): { runtime: PluginRuntime; launches: () => number; stops: () => number; crash: () => void } => {
    let launches = 0;
    let stops = 0;
    let crash = (): void => undefined;
    const runtime: PluginRuntime = {
      launch(options) {
        launches += 1;
        crash = () => options.onExit("exited with code 1");
        return Promise.resolve({
          send(message) {
            if (message.t === "init") {
              if (behaviour.init === "ready") queueMicrotask(() => options.onMessage({ t: "ready" }));
              if (behaviour.init === "fail") queueMicrotask(() => options.onMessage({ t: "fail", error: "no" }));
              return true;
            }
            if (message.t === "invoke" && behaviour.answer === "yes") {
              queueMicrotask(() =>
                options.onMessage({ t: "done", id: message.id, ok: true, value: { title: null, blocks: [] } }),
              );
            }
            // Reports the write, as `ForkedPlugin` does; nothing here ever refuses one.
            return true;
          },
          stop() {
            stops += 1;
            return Promise.resolve();
          },
          recentLogs: () => ["a line the child printed"],
        });
      },
    };
    return { runtime, launches: () => launches, stops: () => stops, crash: () => crash() };
  };

  const openWith = async (
    runtime: PluginRuntime,
  ): Promise<{ host: Awaited<ReturnType<typeof PluginHost.open>>; warnings: string[]; close: () => Promise<void> }> => {
    const stores = openStores({ path: join(tmp("plugin-life-"), "d.db"), instanceId: `i_${Math.floor(Math.random() * 1e6)}` });
    stores.plugins.put({
      id: "p",
      version: "1.0.0",
      manifest,
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      source: null,
    });
    const registry = new SessionRegistry(stores.events, stores.sessions);
    const warnings: string[] = [];
    const host = await PluginHost.open({
      root: join(tmp("plugin-life-root-"), "plugins"),
      records: stores.plugins,
      data: stores.pluginData,
      registry,
      api: { git: hostGit },
      onWarning: (detail) => warnings.push(detail),
      runtime,
      timeouts: { start: 60, invoke: 60 },
    });
    return {
      host,
      warnings,
      close: async () => {
        await host.shutdown();
        await registry.shutdown();
        stores.close();
      },
    };
  };

  const codeOf = async (run: Promise<unknown>): Promise<string> => {
    try {
      await run;
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? "threw";
    }
  };

  {
    const silent = scripted({ init: "silent", answer: "yes" });
    const { host, close } = await openWith(silent.runtime);
    const plugin = host.find("p");
    if (plugin === null) throw new Error("no plugin");
    check("a child that never says it is ready", await codeOf(plugin.invoke("view", "settings", {})), "plugin_unavailable");
    check("is stopped rather than left running", silent.stops() > 0, true);
    report("and its failure carries what it printed", plugin.failure?.includes("a line the child printed") === true, plugin.failure ?? "");
    check("the row says so", host.list().map((one) => one.state), ["failed"]);
    await close();
  }

  {
    const broken = scripted({ init: "fail", answer: "yes" });
    const { host, close } = await openWith(broken.runtime);
    const plugin = host.find("p");
    if (plugin === null) throw new Error("no plugin");
    /*
     * Three attempts and then no more, for the reason `autoResume` has a budget:
     * a plugin that cannot start will not start because it was asked a fourth
     * time, and a daemon that keeps trying spends a core on it.
     *
     * ⚠ **Who is asking decides whether the attempt is charged**, so this drives
     * both halves. A `view` is `read`-scoped and `PluginScreen` re-reads it on a
     * timer, so a passive caller must be able to hammer a broken plugin without
     * moving the counter — otherwise a grant that can press nothing on a screen
     * spends a budget only `machine:admin` can give back. A `hook` is this
     * daemon's own traffic and pays. See `StartIntent`.
     */
    const launchedBefore = broken.launches();
    const codes: string[] = [];
    for (let i = 0; i < 5; i += 1) codes.push(await codeOf(plugin.invoke("view", "settings", {})));
    check("five read-only views against a broken plugin start nothing", broken.launches(), launchedBefore);
    check("and every attempt still answers rather than hanging", new Set(codes).has("plugin_unavailable"), true);
    /*
     * The supervised half. `deliver` is what the daemon's own hook traffic goes
     * through, and it drains through `ensureStarted("supervised")` — so this is
     * the caller that walks the budget down, and the one the refusal is written for.
     */
    const hookCodes: string[] = [];
    for (let i = 0; i < 5; i += 1) hookCodes.push(await codeOf(plugin.invoke("hook", "turn.ended", {})));
    report("but the daemon's own traffic does spend it", broken.launches() > launchedBefore, `${broken.launches()} launches`);
    check("and a hook that cannot be delivered still answers", new Set(hookCodes).has("plugin_unavailable"), true);
    report("and stops at three", broken.launches() <= 3, `${broken.launches()} launches`);
    report(
      "the last refusal says it has given up",
      plugin.failure?.includes("will not be tried again") === true,
      plugin.failure ?? "",
    );
    // Switching it off and on is new information, exactly as a restart is for
    // auto-resume, so the budget comes back.
    const beforeToggle = broken.launches();
    await host.setEnabled("p", false);
    await host.setEnabled("p", true);
    report("switching it back on returns the budget", broken.launches() > beforeToggle, `${broken.launches()} launches`);
    await close();
  }

  {
    const mute = scripted({ init: "ready", answer: "silent" });
    const { host, close } = await openWith(mute.runtime);
    const plugin = host.find("p");
    if (plugin === null) throw new Error("no plugin");
    check("a child that never answers", await codeOf(plugin.invoke("view", "settings", {})), "plugin_timeout");
    check("and again", await codeOf(plugin.invoke("view", "settings", {})), "plugin_timeout");
    check("and a third time", await codeOf(plugin.invoke("view", "settings", {})), "plugin_timeout");
    // Three in a row and it is stopped rather than asked a fourth. A person is
    // waiting behind each of these, so what matters is that they all *end*.
    report("three of those stop it", mute.stops() > 0, `${mute.stops()} stops`);
    await close();
  }

  {
    const crashy = scripted({ init: "ready", answer: "yes" });
    const { host, warnings, close } = await openWith(crashy.runtime);
    const plugin = host.find("p");
    if (plugin === null) throw new Error("no plugin");
    check("a plugin that is up answers", (await plugin.invoke("view", "settings", {})).kind, "view");
    crashy.crash();
    check("a child that dies on its own is a failure", host.list().map((one) => one.state), ["failed"]);
    report("and it is reported", warnings.some((one) => one.includes("exited with code 1")), `${warnings.length} warnings`);
    await close();
  }
}

process.stdout.write("\nhooks reaching a plugin\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { openStores } = await import("../src/store/sqlite.js");
  const { PLUGIN_HOOKS } = await import("../src/plugins/protocol.js");

  /**
   * A plugin whose answers this driver holds until it lets go.
   *
   * The `hold`/`release` pair is what makes the queue drivable at all. `drain` is
   * sequential — one hook in flight, the next taken only once the last has been
   * answered — so a runtime that answers immediately empties the queue as fast as
   * `deliver` fills it and the bound is never reached. Holding the first answer
   * parks the drain with the queue growing behind it, which is exactly the state
   * {@link MAX_HOOK_QUEUE} exists for: a plugin that has stopped answering while
   * the machine keeps working.
   */
  const scripted = (): {
    runtime: PluginRuntime;
    seen: () => { kind: string; hook: string; session: string; mark: number }[];
    launches: () => number;
    hold: () => void;
    release: () => void;
  } => {
    let launches = 0;
    let holding = false;
    const seen: { kind: string; hook: string; session: string; mark: number }[] = [];
    const held: number[] = [];
    let answer: (id: number) => void = () => undefined;
    const runtime: PluginRuntime = {
      launch(options) {
        launches += 1;
        answer = (id) => queueMicrotask(() => options.onMessage({ t: "done", id, ok: true, value: null }));
        return Promise.resolve({
          send(message) {
            if (message.t === "init") {
              queueMicrotask(() => options.onMessage({ t: "ready" }));
              return true;
            }
            if (message.t === "invoke") {
              const input = message.input as { hook?: unknown; session?: { id?: unknown }; mark?: unknown } | null;
              seen.push({
                kind: message.kind,
                /*
                 * Read off the **payload** rather than off `name`, because they
                 * are two writes and only one of them is what a plugin sees: the
                 * host sends the hook as the invocation's name *and* folds it into
                 * the object the child is handed, and `runner.ts` passes the
                 * second one to `hook(ctx, event)`. A plugin switching on
                 * `event.hook` is switching on this.
                 */
                hook: String(input?.hook ?? ""),
                session: String(input?.session?.id ?? ""),
                mark: typeof input?.mark === "number" ? input.mark : -1,
              });
              if (holding) held.push(message.id);
              else answer(message.id);
            }
            return true;
          },
          stop: () => Promise.resolve(),
          recentLogs: () => [],
        });
      },
    };
    return {
      runtime,
      seen: () => seen,
      launches: () => launches,
      hold: () => {
        holding = true;
      },
      release: () => {
        holding = false;
        for (const id of held.splice(0)) answer(id);
      },
    };
  };

  /**
   * Wait until a counter stops moving.
   *
   * A fixed sleep would be a guess: one hook is a handful of microtasks and the
   * queue case below is two hundred and fifty-seven of them in a row. This ends
   * on the first round that added nothing, so the ordinary case costs one tick.
   */
  const settle = async (of: () => number): Promise<void> => {
    let last = -1;
    for (let round = 0; round < 400 && last !== of(); round += 1) {
      last = of();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  /**
   * An agent that cannot be started, on purpose.
   *
   * ⚠ **What is being driven here is the announcement, not the agent.**
   * `registry.create` calls `announce(managed, "created")` *before*
   * `managed.start()` — the ordering is written into that function so an observer
   * is attached before the first thing the agent says — so a runtime whose
   * `launch` throws produces the real announcement, the real `observe` and a real
   * snapshot in the hook's payload, without this section standing up a second ACP
   * handshake over pipes. The throw is not incidental either: a start that failed
   * is an exit, and an exit is the only thing `session.ended` is derived from.
   */
  class NoAgent extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "fake", available: true, loggedIn: true, hint: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return stubAgentConfig(agent);
    }
    override async launch(): Promise<never> {
      throw new Error("this driver has no agent to start");
    }
  }

  const root = tmp("hooks-");
  // Populated *before* the host is opened, which is what makes `seed` a real
  // question: a board installed on a working machine is empty until somebody
  // starts something, unless the install offers it what is already there.
  const registry = new SessionRegistry(
    new MemoryEventStore(),
    storeOf([rowFor("s_restored", join(root, "wt"))]),
    undefined,
    new NoAgent(),
  );
  registry.restore({ reapOrphans: false });

  const plugin = scripted();
  const stores = openStores({ path: join(tmp("hooks-db-"), "d.db"), instanceId: "i_hooks" });
  const warnings: string[] = [];
  const host = await PluginHost.open({
    root: join(root, "plugins"),
    records: stores.plugins,
    data: stores.pluginData,
    registry,
    api: { git: hostGit },
    onWarning: (detail) => warnings.push(detail),
    runtime: plugin.runtime,
    timeouts: { start: 500, invoke: 500 },
  });

  const installed = await host.install({
    body: bodyOf(
      tarOf({
        "plugin.json": JSON.stringify({
          id: "watcher",
          name: "Watcher",
          version: "1.0.0",
          api: 1,
          scopes: [],
          // Every one of them, so a hook added to the union without a `fan` arm
          // shows up here as a hook nothing ever produced rather than as nothing.
          contributes: { hooks: [...PLUGIN_HOOKS] },
        }),
        "server.js": "export function hook() {}",
      }),
    ),
    name: "watcher.tar.gz",
  });
  check("a plugin declaring hooks installs", installed.kind === "ok" ? installed.summary.id : installed, "watcher");
  check(
    "and its manifest is what decides which it is sent",
    installed.kind === "ok" ? installed.summary.contributes.hooks : null,
    [...PLUGIN_HOOKS],
  );

  await settle(() => plugin.seen().length);
  /*
   * `seed`, which is the one delivery that is not an event: every session this
   * daemon already knows about, offered to a plugin that has only just arrived.
   * It is `install`'s last act and it is why `session.created` is the only hook
   * with two producers.
   */
  check(
    "and it is offered the session that was already here",
    plugin.seen().map((one) => [one.kind, one.hook, one.session]),
    [["hook", "session.created", "s_restored"]],
  );

  const failed = await registry
    .create({ agent: "kimi", cwd: tmp("hooks-cwd-") })
    .then(() => null, (error: unknown) => error);
  report("a session whose agent will not start still threw", failed !== null, String(failed).slice(0, 48));
  await settle(() => plugin.seen().length);
  const born = registry.list().map((one) => one.id).filter((id) => id !== "s_restored");
  check("but the session exists, and there is one of it", born.length, 1);
  check(
    "the plugin was told it appeared, and then that it was over",
    plugin.seen().slice(1).map((one) => [one.hook, one.session === born[0]]),
    [
      ["session.created", true],
      ["session.ended", true],
    ],
  );

  /*
   * ⚠ **The echo of a plugin's own write is not sent back to it**, which is what
   * keeps `ctx.sessions.create` inside a `session.created` handler from making
   * sessions until `MAX_LIVE_SESSIONS` — each one a worktree and an agent
   * process. `src/agentask.ts`'s header records the same recursion against a
   * session nobody can address; this is the one a plugin is handed on purpose.
   *
   * Driven through `registry.create`'s own `origin` rather than through the API,
   * because that argument *is* the mechanism: the announcement happens inside
   * `create`, so there is no moment afterwards at which anything could stamp it.
   */
  const before = plugin.seen().length;
  await registry
    .create({ agent: "kimi", cwd: tmp("hooks-own-"), origin: "watcher" })
    .then(() => null, () => null);
  await settle(() => plugin.seen().length);
  const echoed = plugin.seen().slice(before).map((one) => one.hook);
  check("a plugin is not told about the session it asked for itself", echoed.includes("session.created"), false);
  /*
   * ⚠ **And `session.ended` still arrives, which is a named non-goal rather than
   * an oversight.** A create whose `start()` throws is an exit, so the plugin
   * that asked is told its own session ended — and a handler answering *that* by
   * creating another still loops. `MAX_LIVE_SESSIONS` does not bound it, because
   * `liveSessionCount` skips terminal sessions; what is left is
   * `SESSION_CREATE_BURST` and a worktree left behind each time round. Closing it
   * needs a per-plugin create budget. Asserted so the gap is written down as
   * behaviour rather than left to be rediscovered.
   */
  check("but it is still told that session ended, which the loop above does not close", echoed, ["session.ended"]);

  /* ---------------------------------------------------------------- *
   * The three hooks derived from the log.
   *
   * ⚠ **Derived, never forwarded.** A plugin is told `turn.ended`, not a
   * `StoredEvent` — the event union is the wire three agents move, and coupling a
   * plugin to it would make every ACP change somebody else's breaking change.
   * Appending straight to the log is therefore the honest way to drive these: it
   * is exactly what the pump does, and what crosses to the plugin is a summary
   * this daemon built rather than the row that produced it.
   * ---------------------------------------------------------------- */
  const restored = registry.get("s_restored");
  if (restored === undefined) throw new Error("the restored session vanished");
  const fromLog = plugin.seen().length;
  restored.log.append({ type: "turn_end", stopReason: "end_turn", usage: null });
  restored.log.append({
    type: "permission_request",
    permissionId: "perm_1",
    toolCallId: null,
    title: "Run the tests?",
    options: [],
    decision: null,
  });
  restored.log.append({
    type: "permission_resolved",
    permissionId: "perm_1",
    toolCallId: null,
    title: "Run the tests?",
    outcome: "selected",
    optionId: "allow",
    by: "client",
  });
  await settle(() => plugin.seen().length);
  check(
    "a turn ending, a question asked and the same question answered",
    plugin.seen().slice(fromLog).map((one) => one.hook),
    ["turn.ended", "permission.requested", "permission.resolved"],
  );

  /* ---------------------------------------------------------------- *
   * A throwing subscriber is reported and **kept**.
   *
   * ⚠ This is the opposite of what `SessionLog.append` does to a listener that
   * throws, and the difference is the whole reason the guard exists. There a
   * listener is one WebSocket and evicting it costs that socket its events; here
   * it is every plugin hook for this session, its unsubscribe is recorded in
   * `watching`, and `observe` reads that map as "already handled" — so one throw
   * out of `managed.snapshot()` ended hooks for that session **for the life of the
   * daemon**, with nothing anywhere saying so and no path back short of a
   * restart. The second append is the half that matters: a report with the
   * subscription gone would look identical in the warnings.
   * ---------------------------------------------------------------- */
  const realSnapshot = restored.snapshot.bind(restored);
  (restored as unknown as { snapshot: () => unknown }).snapshot = () => {
    throw new Error("a snapshot this driver broke");
  };
  const beforeThrow = warnings.length;
  const seenBeforeThrow = plugin.seen().length;
  restored.log.append({ type: "turn_end", stopReason: "end_turn", usage: null });
  await settle(() => warnings.length);
  report(
    "a hook payload that throws is reported",
    warnings.slice(beforeThrow).some((one) => one.includes("a snapshot this driver broke")),
    warnings.at(-1) ?? "nothing reported",
  );
  check("and nothing was delivered for it", plugin.seen().length, seenBeforeThrow);
  (restored as unknown as { snapshot: () => unknown }).snapshot = realSnapshot;
  restored.log.append({ type: "turn_end", stopReason: "end_turn", usage: null });
  await settle(() => plugin.seen().length);
  check(
    "but the next one still arrives, which is the whole property",
    plugin.seen().slice(seenBeforeThrow).map((one) => one.hook),
    ["turn.ended"],
  );

  /* ---------------------------------------------------------------- *
   * What a plugin that has stopped answering misses.
   *
   * Drop-**oldest**, because the newest events are the ones still worth acting
   * on: a board catching up cares about the turn that just ended and not about
   * the one from an hour ago. The count is what keeps that honest — it goes to
   * `onWarning` rather than being swallowed, since a plugin quietly missing half
   * its events looks exactly like a plugin with a bug in it.
   *
   * `deliver` is called directly rather than through a session, because what is
   * being driven is the queue and three hundred real turns would be three hundred
   * fixtures for one bound.
   * ---------------------------------------------------------------- */
  const live = host.find("watcher");
  if (live === null) throw new Error("the plugin vanished");
  plugin.hold();
  const beforeFlood = plugin.seen().length;
  const warnedBeforeFlood = warnings.length;
  for (let mark = 1; mark <= 300; mark += 1) live.deliver("turn.ended", { hook: "turn.ended", mark });
  report(
    "a plugin falling behind is said out loud",
    warnings
      .slice(warnedBeforeFlood)
      .some((one) => one.includes("is behind") && one.includes("hook deliveries dropped")),
    warnings.at(-1) ?? "nothing reported",
  );
  plugin.release();
  await settle(() => plugin.seen().length);
  const delivered = plugin.seen().slice(beforeFlood).map((one) => one.mark);
  // The first was taken by `drain` before the queue could hold anything, so it is
  // in flight rather than queued and no bound can reach it.
  check("the one already in flight was delivered", delivered[0], 1);
  const queued = delivered.slice(1);
  report(
    "and what survived is a contiguous run ending at the newest",
    queued.length > 0 &&
      queued.length < 299 &&
      queued.at(-1) === 300 &&
      queued.every((mark, index) => mark === (queued[0] ?? 0) + index),
    `${delivered.length} of 300 delivered, ${String(queued[0])}…${String(queued.at(-1))}`,
  );

  /* ---------------------------------------------------------------- *
   * Two invocations arriving together join one launch.
   *
   * `this.starting ??=` written out longhand, because the passive gate has to sit
   * between the join and the launch: joining a start somebody else is paying for
   * is free and starting one is not. Without the memo the second caller loses to a
   * half-started child and spends a second of the three `MAX_PLUGIN_STARTS`
   * allows, which is a budget only `machine:admin` can give back.
   * ---------------------------------------------------------------- */
  await live.stop();
  const launchedBefore = plugin.launches();
  const together = await Promise.all([
    live.invoke("hook", "turn.ended", { hook: "turn.ended" }).then(() => "answered", () => "refused"),
    live.invoke("hook", "turn.ended", { hook: "turn.ended" }).then(() => "answered", () => "refused"),
  ]);
  check("both are answered", together, ["answered", "answered"]);
  report(
    "and one launch served both",
    plugin.launches() - launchedBefore === 1,
    `${plugin.launches() - launchedBefore} launches for 2 invocations`,
  );

  await host.shutdown();
  await registry.shutdown();
  stores.close();
}

process.stdout.write("\nthe plugin routes\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { parseManifest } = await import("../src/plugins/manifest.js");
  const { PLUGIN_API_VERSION } = await import("../src/plugins/protocol.js");
  const { openStores } = await import("../src/store/sqlite.js");

  const parsed = parseManifest(
    JSON.stringify({
      id: "p",
      name: "P",
      version: "1.0.0",
      api: 1,
      scopes: [],
      contributes: { screen: { title: "P" }, settings: true, actions: [{ id: "go", title: "Go", on: "screen" }] },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.message);

  const runtime: PluginRuntime = {
    launch(options) {
      return Promise.resolve({
        send(message) {
          if (message.t === "init") {
            queueMicrotask(() => options.onMessage({ t: "ready" }));
            return true;
          }
          if (message.t === "invoke") {
            queueMicrotask(() =>
              options.onMessage({
                t: "done",
                id: message.id,
                ok: true,
                /*
                 * ⚠ **A `list` beside the text, and it is here to be *refused* on
                 * one of the two surfaces.** The clamp's own section drives
                 * `clampView` directly; this is the other half — that the surface
                 * actually reaches it from the route, which is a wiring question
                 * no pure-function assertion can answer. It was on the wire the
                 * whole time (`viewId` is the invoke's `name`) and neither side
                 * read it.
                 */
                value: {
                  title: message.name,
                  blocks: [
                    { type: "text", text: message.name, tone: "default" },
                    { type: "list", empty: "nothing", rows: [{ id: "a", title: "A" }] },
                  ],
                },
              }),
            );
          }
          // Reports the write, as `ForkedPlugin` does; nothing here ever refuses one.
          return true;
        },
        stop: () => Promise.resolve(),
        recentLogs: () => [],
      });
    },
  };

  const stores = openStores({ path: join(tmp("plugin-routes-"), "d.db"), instanceId: "i_routes" });
  stores.plugins.put({
    id: "p",
    version: "1.0.0",
    manifest: parsed.manifest,
    enabled: true,
    installedAt: 1,
    updatedAt: 1,
    source: null,
  });
  const registry = new SessionRegistry(stores.events, stores.sessions);
  const host = await PluginHost.open({
    root: join(tmp("plugin-routes-root-"), "plugins"),
    records: stores.plugins,
    data: stores.pluginData,
    registry,
    api: { git: hostGit },
    runtime,
    timeouts: { start: 500, invoke: 500 },
  });

  const { app: pluginApp } = createApp({
    registry,
    verifier,
    instanceId: "i_routes",
    startedAt: Date.now(),
    plugins: host,
  });
  const { app: bareApp } = createApp({
    registry,
    verifier,
    instanceId: "i_bare",
    startedAt: Date.now(),
  });

  const call = async (
    app: typeof pluginApp,
    path: string,
    init: RequestInit = {},
    token = tokenFor("routes"),
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };
  const codeOf = (body: Record<string, unknown>): string =>
    ((body["error"] as { code?: string } | undefined)?.code ?? "none");

  const listing = await call(pluginApp, "/plugins");
  // The api is read from the constant rather than written down, so this assertion
  // survives the next accept-both step instead of pinning today's ceiling.
  check(
    "the listing",
    [listing.status, (listing.body["plugins"] as unknown[]).length, listing.body["api"]],
    [200, 1, PLUGIN_API_VERSION],
  );

  /*
   * **A daemon built without a plugin host answers 503, never an empty list.**
   * "There are none" and "this daemon does not do that" are different answers, and
   * a client shown the first has no way to discover the second. Same shape
   * `credentials`, `logins` and `uploads` already use.
   */
  const off = await call(bareApp, "/plugins");
  check("a daemon with plugins switched off", [off.status, codeOf(off.body)], [503, "plugins_unavailable"]);
  /*
   * ⚠ **And the same answer from all six, not from the one route somebody
   * happened to drive.** That refusal is written once now — `withPlugins` wraps
   * every one of them — and it was written six times before, with the sentence
   * retyped at five of them and each free to drift into saying something slightly
   * different about the same state. The collapse does not make the sweep
   * unnecessary; the sweep is what keeps the collapse true, because a seventh
   * route written outside the wrapper answers 404 or 500 here rather than 503.
   *
   * `POST /plugins` is the one worth being deliberate about: it is a streaming
   * route, so this refusal is also a body nobody read being released, which is
   * what the exemption middleware's `finally` is for.
   */
  const sweep: [string, RequestInit][] = [
    ["/plugins", {}],
    ["/plugins", { method: "POST", body: "an archive nobody will look at" }],
    /*
     * ⚠ **The list is the assertion, which is why a seventh route has to be
     * added here by hand.** Every one of these goes through `withPlugins`, and a
     * route written outside it on a daemon with `REEMOAT_PLUGINS=0` would not
     * answer `503` — it would throw, or worse, act. `installFromSource` is the
     * one that would act: it opens a socket to GitHub.
     */
    [
      "/plugins/source",
      {
        method: "POST",
        body: JSON.stringify({ source: { kind: "github", repo: "o/r", commit: "a".repeat(40) } }),
      },
    ],
    ["/plugins/p", { method: "DELETE" }],
    ["/plugins/p/state", { method: "POST", body: JSON.stringify({ enabled: true }) }],
    ["/plugins/p/views/screen", {}],
    ["/plugins/p/actions/go", { method: "POST", body: "{}" }],
  ];
  const swept: [number, string][] = [];
  for (const [path, init] of sweep) {
    const answer = await call(bareApp, path, init);
    swept.push([answer.status, codeOf(answer.body)]);
  }
  check(
    "and so does every one of the seven",
    swept,
    sweep.map(() => [503, "plugins_unavailable"]),
  );

  check(
    "no credential at all",
    (await pluginApp.request("/plugins")).status,
    401,
  );

  const blocksOf = (body: Record<string, unknown>): string[] => {
    const shown = (body["result"] as { view?: { blocks?: { type?: string }[] } } | undefined)?.view?.blocks ?? [];
    return shown.map((one) => one.type ?? "?");
  };
  const view = await call(pluginApp, "/plugins/p/views/screen");
  check("a screen", [view.status, ((view.body["result"] as { view?: { title?: string } })?.view?.title ?? null)], [200, "screen"]);
  const settings = await call(pluginApp, "/plugins/p/views/settings");
  check("and a settings pane", ((settings.body["result"] as { view?: { title?: string } })?.view?.title ?? null), "settings");
  /*
   * ⚠ **The surface reaches the clamp, over HTTP, on the route that knows it.**
   * Both answers are the same bytes from the same plugin; the only difference is
   * the last segment of the URL. A screen keeps the list, a settings pane drops it
   * and says so — and asserting the *pair* is what makes this a wiring check
   * rather than a second copy of the clamp's own assertions: either one alone
   * passes for a build that clamps both surfaces the same way.
   */
  check("a screen keeps a list", blocksOf(view.body), ["text", "list"]);
  check("and a settings pane drops it, with a line saying so", blocksOf(settings.body), ["text", "notice"]);

  const noView = await call(pluginApp, "/plugins/p/views/board");
  check("a view that is not one of the two", [noView.status, codeOf(noView.body)], [404, "view_not_found"]);
  const noPlugin = await call(pluginApp, "/plugins/nope/views/screen");
  check("a plugin that is not installed", [noPlugin.status, codeOf(noPlugin.body)], [404, "plugin_not_found"]);

  const acted = await call(pluginApp, "/plugins/p/actions/go", { method: "POST", body: "{}" });
  check("an action the manifest declares", acted.status, 200);
  /*
   * An action id reaching a plugin is a string somebody put in a URL. Checked here
   * rather than inside the plugin, because a plugin author writing a `switch` over
   * their own ids should not also have to defend against ones they never declared.
   */
  const undeclared = await call(pluginApp, "/plugins/p/actions/nope", { method: "POST", body: "{}" });
  check("one it does not", [undeclared.status, codeOf(undeclared.body)], [404, "action_not_found"]);

  const state = await call(pluginApp, "/plugins/p/state", { method: "POST", body: JSON.stringify({ enabled: false }) });
  check("switching one off over HTTP", [state.status, ((state.body["plugin"] as { enabled?: boolean })?.enabled ?? null)], [200, false]);
  const badState = await call(pluginApp, "/plugins/p/state", { method: "POST", body: JSON.stringify({ enabled: "no" }) });
  check("with something that is not a boolean", [badState.status, codeOf(badState.body)], [400, "bad_request"]);

  /* ---------------------------------------------------------------- *
   * The other axis.
   *
   * These scopes are the **caller's**, and they are not the plugin's. A read-only
   * grant may look at a plugin's screen and may press nothing on it; installing
   * needs `machine:admin`, which is the same scope removing a workspace needs and
   * the only other route that asks for it. Neither has anything to say about what
   * the plugin itself may reach, which is `manifest.scopes` and is checked
   * somewhere else entirely.
   * ---------------------------------------------------------------- */
  const readOnly = tokenWith("reader", ["session:read"]);
  const writer = tokenWith("writer", ["session:read", "session:write"]);
  const readList = await call(pluginApp, "/plugins", {}, readOnly);
  check("a read-only grant may list plugins", readList.status, 200);
  /*
   * ⚠ **The positive half, which is the half that was only ever asserted in
   * prose.** "May look at a plugin's screen and press nothing on it" is one
   * sentence and two claims, and a `read` that had drifted to `write` would break
   * the sheet for every read-only grant on the machine while every assertion here
   * went on passing — the negative half below cannot see it.
   *
   * Switched back on with an admin token first, because the pair is only a pair
   * while there is something to look at: a disabled plugin answers 503 for a
   * reason that has nothing to do with who is asking, and a 503 read as "allowed"
   * would make this assertion pass against a route nobody may reach.
   */
  await call(pluginApp, "/plugins/p/state", { method: "POST", body: JSON.stringify({ enabled: true }) });
  const readView = await call(pluginApp, "/plugins/p/views/screen", {}, readOnly);
  check(
    "and may look at its screen",
    [readView.status, ((readView.body["result"] as { view?: { title?: string } })?.view?.title ?? null)],
    [200, "screen"],
  );
  const readAction = await call(pluginApp, "/plugins/p/actions/go", { method: "POST", body: "{}" }, readOnly);
  check("and may press nothing", [readAction.status, codeOf(readAction.body)], [403, "insufficient_scope"]);
  const writerInstall = await call(pluginApp, "/plugins", { method: "POST", body: "" }, writer);
  check("installing needs more than session:write", [writerInstall.status, codeOf(writerInstall.body)], [403, "insufficient_scope"]);
  const writerRemove = await call(pluginApp, "/plugins/p", { method: "DELETE" }, writer);
  check("and so does removing", [writerRemove.status, codeOf(writerRemove.body)], [403, "insufficient_scope"]);
  const writerState = await call(pluginApp, "/plugins/p/state", { method: "POST", body: JSON.stringify({ enabled: true }) }, writer);
  check("and switching one off", [writerState.status, codeOf(writerState.body)], [403, "insufficient_scope"]);

  /*
   * Only `GET`, `POST` and `DELETE`, which is what `CORS_ALLOW_METHODS` advertises
   * — the driver asserts that containment globally, and this is the note saying
   * these six routes were written inside it deliberately.
   */
  const removed = await call(pluginApp, "/plugins/p", { method: "DELETE" });
  check("removing one", [removed.status, removed.body["removed"]], [200, true]);
  const gone = await call(pluginApp, "/plugins/p", { method: "DELETE" });
  check("and removing it again", [gone.status, codeOf(gone.body)], [404, "plugin_not_found"]);

  const verbs = new Set(
    pluginApp.routes.filter((route) => route.path.startsWith("/plugins")).map((route) => route.method.toUpperCase()),
  );
  check("the plugin routes use no verb the CORS list withholds", [...verbs].sort(), ["DELETE", "GET", "POST"]);

  /*
   * ⚠ **`shutting_down` is the first thing the install handler tests**, before
   * the name, before the declared length and before a byte of the body is read.
   * A daemon on its way out has 20 seconds of shutdown budget and a hard exit
   * behind it, so unpacking an archive it will never finish starting is work that
   * ends as a half-published tree with no process to prove it. Driven last here
   * because it is a one-way flag on the registry, and the routes above need one
   * that is still serving.
   */
  await registry.shutdown();
  const late = await call(pluginApp, "/plugins", { method: "POST", body: "an archive that arrived too late" });
  check("installing into a daemon that is going away", [late.status, codeOf(late.body)], [503, "shutting_down"]);

  await host.shutdown();
  await registry.shutdown();
  stores.close();
}

process.stdout.write("\ninstalling a plugin over HTTP, and what each refusal is worth\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { openStores } = await import("../src/store/sqlite.js");
  const { PLUGIN_LIMITS } = await import("../src/archive.js");

  /**
   * A child that comes straight up, or one whose build will not run.
   *
   * `fail` rather than silence for the second, because what is being driven here
   * is `pluginInstallStatus` and not the start deadline: a start that times out
   * takes the whole `timeouts.start` window to reach the same code, and the code
   * is the subject.
   */
  const childThat = (starts: boolean): PluginRuntime => ({
    launch(options) {
      return Promise.resolve({
        send(message) {
          if (message.t === "init") {
            queueMicrotask(() =>
              options.onMessage(starts ? { t: "ready" } : { t: "fail", error: "this build will not run" }),
            );
            return true;
          }
          if (message.t === "invoke") {
            queueMicrotask(() => options.onMessage({ t: "done", id: message.id, ok: true, value: null }));
          }
          return true;
        },
        stop: () => Promise.resolve(),
        recentLogs: () => [],
      });
    },
  });

  const manifestOf = (patch: Record<string, unknown> = {}): string =>
    JSON.stringify({ id: "board", name: "Board", version: "1.0.0", api: 1, scopes: [], contributes: {}, ...patch });
  const archiveOf = (patch: Record<string, unknown> = {}): Buffer =>
    tarOf({ "plugin.json": manifestOf(patch), "server.js": "export function settings() { return {}; }" });

  /**
   * A daemon whose plugin host is scripted, and the HTTP surface in front of it.
   *
   * `refusesToWrite` swaps the record store for one whose `put` throws, which is
   * the only honest way to reach `plugin_write_failed` — the alternative is a
   * filesystem that has actually failed, and `PluginRecordStore` is an interface
   * precisely so that a driver does not need one. It also drives the half of
   * `install`'s catch nothing else reaches: a throw **after** the tree has been
   * published used to leave the new `LivePlugin` running out of a directory the
   * catch had just deleted.
   */
  const rigFor = async (
    name: string,
    options: {
      starts: boolean;
      refusesToWrite?: boolean;
      /**
       * What `POST /plugins/source` gets back instead of reaching GitHub.
       *
       * The seam exists so this driver can hold every refusal on that path — a
       * 404, a redirect, a body over the bound — with no network. See
       * `PluginHostOptions.fetchArchive`.
       */
      fetchArchive?: (url: string, signal: AbortSignal) => Promise<Response>;
    } = { starts: true },
  ): Promise<{
    host: Awaited<ReturnType<typeof PluginHost.open>>;
    app: ReturnType<typeof createApp>["app"];
    /** The real store behind the host, so a case can ask what is durably there. */
    rows: PluginRecordStore;
    close: () => Promise<void>;
  }> => {
    const stores = openStores({ path: join(tmp(`plugin-http-${name}-`), "d.db"), instanceId: `i_http_${name}` });
    const registry = new SessionRegistry(stores.events, stores.sessions);
    const records: PluginRecordStore =
      options.refusesToWrite === true
        ? {
            // Delegated one method at a time rather than spread, because a spread
            // of a class instance copies its fields and loses its prototype.
            list: () => stores.plugins.list(),
            get: (id) => stores.plugins.get(id),
            has: (id) => stores.plugins.has(id),
            put: () => {
              throw new Error("the database would not take that row");
            },
            setEnabled: (id, enabled, at) => stores.plugins.setEnabled(id, enabled, at),
            remove: (id) => stores.plugins.remove(id),
          }
        : stores.plugins;
    const host = await PluginHost.open({
      root: join(tmp(`plugin-http-root-${name}-`), "plugins"),
      records,
      data: stores.pluginData,
      registry,
      api: { git: hostGit },
      runtime: childThat(options.starts),
      timeouts: { start: 500, invoke: 500 },
      ...(options.fetchArchive === undefined ? {} : { fetchArchive: options.fetchArchive }),
    });
    const { app } = createApp({
      registry,
      verifier,
      instanceId: `i_http_${name}`,
      startedAt: Date.now(),
      plugins: host,
    });
    return {
      host,
      app,
      rows: stores.plugins,
      close: async () => {
        await host.shutdown();
        await registry.shutdown();
        stores.close();
      },
    };
  };

  const post = async (
    app: ReturnType<typeof createApp>["app"],
    query: string,
    body: Uint8Array | null,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const init: RequestInit = { method: "POST", headers: { authorization: `Bearer ${tokenFor("http")}`, ...headers } };
    // Assigned rather than passed as `null`, because a `body: null` and no body at
    // all are the same Request and the route's own `body === null` arm needs the
    // second one.
    if (body !== null) init.body = body;
    const response = await app.request(`/plugins${query}`, init);
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };
  const errorOf = (body: Record<string, unknown>): { code: string; detail: unknown } => {
    const error = body["error"] as { code?: string; detail?: unknown } | undefined;
    return { code: error?.code ?? "none", detail: error?.detail ?? null };
  };

  const good = await rigFor("good");

  /*
   * ⚠ **201 and 200 are the answer to "which of the two happened".** Install and
   * update are one verb because the manifest is what says which — a separate
   * `PUT` would need the caller to know whether the plugin is already there,
   * which is a question the archive answers on arrival. `replaced` carries the
   * version that went, and the status carries the same fact for anything reading
   * only that.
   */
  const created = await post(good.app, "?name=board.tar.gz", new Uint8Array(archiveOf()));
  check("a plugin arrives over HTTP", [created.status, created.body["replaced"]], [201, null]);
  const updated = await post(good.app, "?name=board.tar.gz", new Uint8Array(archiveOf({ version: "1.1.0" })));
  check(
    "and the same id again is an update rather than a second plugin",
    [updated.status, updated.body["replaced"], (updated.body["plugin"] as { version?: string } | undefined)?.version],
    [200, "1.0.0", "1.1.0"],
  );

  /*
   * The name is a **label** — recorded beside the row, never turned into a path —
   * and it is sanitized anyway, because it is echoed back and a control character
   * in an echoed string is the response-splitting `sanitizeUploadName` exists to
   * refuse. The same function the upload and import routes use, so all three
   * agree about what a filename may be.
   *
   * The empty case is not a corner: the route reads `?name=` with `?? ""`, so a
   * client that forgets the query is refused rather than storing `null`.
   */
  const badNames: [string, string, string][] = [
    ["with no name at all", "", "empty"],
    [
      "with a name holding a control character",
      `?name=${encodeURIComponent(`a${String.fromCharCode(7)}b.tgz`)}`,
      "control_char",
    ],
    ["with a name that is a directory rather than a file", "?name=..", "reserved"],
  ];
  for (const [label, query, reason] of badNames) {
    const answer = await post(good.app, query, new Uint8Array(archiveOf()));
    const error = errorOf(answer.body);
    check(label, [answer.status, error.code, (error.detail as { reason?: string } | null)?.reason ?? null], [
      400,
      "invalid_name",
      reason,
    ]);
  }

  /*
   * ⚠ **A `content-length` is honoured to refuse and never to accept.** Refusing
   * on one this daemon believes costs nothing; *trusting* one would let a body
   * that lies walk past `unpackArchive`'s counter, which is the thing actually
   * enforcing the bound. Both halves are here: a header claiming more than a
   * plugin may be is refused with nothing read, and a body that really is larger
   * is refused by the counter with the same code.
   */
  const overDeclared = await post(good.app, "?name=board.tar.gz", new Uint8Array(archiveOf()), {
    "content-length": String(PLUGIN_LIMITS.maxBytes + 1),
  });
  check(
    "a request declaring more than a plugin may be",
    [overDeclared.status, errorOf(overDeclared.body).code],
    [413, "plugin_too_large"],
  );
  const overSent = await post(good.app, "?name=board.tar.gz", new Uint8Array(Buffer.alloc(PLUGIN_LIMITS.maxBytes + 1)));
  check(
    "and one that simply is",
    [overSent.status, errorOf(overSent.body).code],
    [413, "plugin_too_large"],
  );

  /*
   * The rest of `pluginInstallStatus`, one case per arm. **The split is by whose
   * problem it is**: `413` for the bounds so a client can tell "too big" from
   * "wrong", `409` for a plugin that will not start — the tree is unchanged and
   * the old version is still running, which is a conflict rather than a failure —
   * and `400` for everything about the archive or the manifest, all of which are
   * things the person who built it can fix.
   */
  const crowded: Record<string, string> = {};
  for (let index = 0; index <= PLUGIN_LIMITS.maxEntries; index += 1) crowded[`f${index}.txt`] = "x";
  const installRefusals: [string, Buffer, number, string][] = [
    ["more members than a plugin has", tarOf(crowded), 413, "plugin_too_many_entries"],
    [
      "one that unpacks past what a plugin may be",
      tarOf({ "plugin.json": manifestOf(), "big.js": "x".repeat(PLUGIN_LIMITS.maxUnpackedBytes + 1) }),
      413,
      "plugin_unpacked_too_large",
    ],
    ["an archive with no manifest in it", tarOf({ "server.js": "export function settings() {}" }), 400, "manifest_missing"],
    ["a manifest this daemon will not read", tarOf({ "plugin.json": "{", "server.js": "x" }), 400, "manifest_unreadable"],
    ["something that is not an archive at all", Buffer.from("not an archive"), 400, "unsupported_archive"],
    ["an archive holding nothing", gzipSync(Buffer.alloc(1024)), 400, "archive_empty"],
  ];
  for (const [label, bytes, status, code] of installRefusals) {
    const answer = await post(good.app, "?name=board.tar.gz", new Uint8Array(bytes));
    check(label, [answer.status, errorOf(answer.body).code], [status, code]);
  }

  // A `POST` with no body at all, which is what a client that built its request
  // wrong sends. Refused before the host is reached, so there is nothing to undo.
  const bodyless = await post(good.app, "?name=board.tar.gz", null);
  check("a request with no body", [bodyless.status, errorOf(bodyless.body).code], [400, "bad_request"]);

  /*
   * One install at a time, for the whole daemon, and this is the half that is
   * actually reachable from outside: the relay allows 256 concurrent streams, so
   * "a person installs a plugin about as often as they install anything" is a
   * statement about people rather than about what can arrive.
   */
  const both = await Promise.all([
    post(good.app, "?name=a.tar.gz", new Uint8Array(archiveOf({ version: "1.2.0" }))),
    post(good.app, "?name=b.tar.gz", new Uint8Array(archiveOf({ version: "1.2.0" }))),
  ]);
  report(
    "two installs at once, and one of them is told to come back",
    both.some((one) => one.status === 409 && errorOf(one.body).code === "plugin_busy") &&
      both.some((one) => one.status === 200),
    both.map((one) => `${one.status} ${errorOf(one.body).code}`).join(", "),
  );
  check("and the machine holds one plugin either way", good.host.list().map((one) => one.id), ["board"]);
  await good.close();

  /*
   * ⚠ **`409` rather than `400` for a build that will not run, and the reason is
   * what the machine looks like afterwards.** The tree is unchanged, the row is
   * untouched and the version that was there is running again — that is a
   * conflict with the state of the machine, not a malformed request, and a `400`
   * would tell somebody to go and fix an archive that is fine.
   */
  const broken = await rigFor("broken", { starts: false });
  const refused = await post(broken.app, "?name=board.tar.gz", new Uint8Array(archiveOf()));
  check(
    "a plugin whose build will not start",
    [refused.status, errorOf(refused.body).code],
    [409, "plugin_start_failed"],
  );
  check("and nothing was installed", broken.host.list(), []);
  await broken.close();

  /*
   * `503`, because the remedy is on this machine and the request itself was fine
   * — which is what that status says and what a `400` would deny. The row is
   * where the throw happens, so everything the try moved has to move back: the
   * published tree is discarded and the plugin is not left running out of a
   * directory that is no longer there.
   */
  const unwritable = await rigFor("unwritable", { starts: true, refusesToWrite: true });
  const notWritten = await post(unwritable.app, "?name=board.tar.gz", new Uint8Array(archiveOf()));
  check(
    "a row the database would not take",
    [notWritten.status, errorOf(notWritten.body).code],
    [503, "plugin_write_failed"],
  );
  check("and no row was written", unwritable.rows.has("board"), false);
  check("and the tree it had published is gone", existsSync(join(unwritable.host.pluginRoot, "board", "1.0.0")), false);
  /*
   * ⚠ **The half that used to be missing, and it was the worse half.**
   * `install`'s catch restored `existing` and had no arm for the case where there
   * was none — while the `plugin_start_failed` path a few lines above it did, and
   * the catch's own docblock claimed it made "the same restore" and named
   * `records.put` on a busy database as its case. So a *first* install that threw
   * after the tree was published answered `503` and left a `LivePlugin` in `live`
   * with a child running, no row behind it and no directory under it: `list()`
   * reported `running` at the version that had just been refused, and went on
   * doing so until the daemon was restarted, at which point the plugin silently
   * disappeared. `<root>/board` was left behind as well, which
   * `PluginHost.installed` reads as something installed — so `remove` of an id
   * nobody ever installed answered `true`.
   *
   * All four are asserted rather than the two that happened to hold, because the
   * two that held are exactly what made the other two easy to miss.
   */
  check("and the listing does not report a plugin that is not installed", unwritable.host.list(), []);
  check("nor is one left running out of a tree that is gone", await unwritable.host.remove("board"), false);
  check(
    "and the directory made to hold it went with it",
    existsSync(join(unwritable.host.pluginRoot, "board")),
    false,
  );
  await unwritable.close();

  /* ── installing from a commit, rather than from a file ─────────────────── */

  const SHA = "a".repeat(40);
  const REPO_NAME = "rends-east/reemoat-board";

  /** What the far end said, scripted. The daemon never reaches a network here. */
  const sourceRig = async (
    name: string,
    answer: (url: string) => Response | Promise<Response>,
  ): Promise<Awaited<ReturnType<typeof rigFor>> & { urls: string[] }> => {
    const urls: string[] = [];
    const rig = await rigFor(name, {
      starts: true,
      fetchArchive: async (url) => {
        urls.push(url);
        return await answer(url);
      },
    });
    return { ...rig, urls };
  };

  const postSource = async (
    app: ReturnType<typeof createApp>["app"],
    body: unknown,
    scopes: Scope[] = ["session:read", "session:write", "machine:admin"],
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await app.request("/plugins/source", {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokenWith("http", scopes)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
  };

  const tarball = (patch: Record<string, unknown> = {}): Response =>
    new Response(new Uint8Array(archiveOf(patch)), { status: 200 });

  /*
   * ⚠ **The address is built by the daemon and asserted here, because that is the
   * whole of the fence.** Nothing on the wire names a host: a caller who could
   * would have a daemon that fetches arbitrary addresses as its owner. `codeload`
   * directly rather than `github.com/<repo>/archive/<sha>.tar.gz`, which answers
   * `302` — and this path refuses redirects, so building the redirecting spelling
   * would make every install fail.
   */
  const fromSource = await sourceRig("source", () => tarball());
  const arrived = await postSource(fromSource.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: [], net: [], hooks: [] },
  });
  check("a plugin arrives from a commit", [arrived.status, arrived.body["replaced"]], [201, null]);
  check("and the daemon built the address itself", fromSource.urls, [
    `https://codeload.github.com/${REPO_NAME}/tar.gz/${SHA}`,
  ]);
  /*
   * The row records where it came from, and on this path that is the pin rather
   * than a filename somebody's browser happened to choose. Written and never read
   * for a decision — the same standing this column already had.
   */
  check("and the row records the commit it came from", fromSource.rows.get("board")?.source, `github:${REPO_NAME}@${SHA}`);

  const again = await postSource(fromSource.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: [], net: [], hooks: [] },
  });
  check("and the same id again is an update, exactly as an upload would be", [again.status, again.body["replaced"]], [200, "1.0.0"]);
  await fromSource.close();

  /*
   * ⚠ **The normalisation case, and it is the one worth a named test.**
   * `parseManifest` synthesises an absent `contributes` into
   * `{screen: null, settings: false, actions: [], hooks: []}` and turns an absent
   * `description` into `null`. A consent check comparing the manifest field for
   * field would therefore fire on a plugin that simply did not write a
   * `contributes` block — which is most of them — and an alarm that cries wolf is
   * an alarm people learn to click through. `consentGap` compares three fields
   * that survive normalisation as plain string arrays, and this asserts that the
   * plainest possible manifest installs without one.
   */
  const plainest = await sourceRig("plain", () => tarball({ contributes: undefined, description: undefined }));
  const plain = await postSource(plainest.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: [], net: [], hooks: [] },
  });
  check("a manifest that writes no contributes at all is not a consent breach", plain.status, 201);
  await plainest.close();

  /*
   * ⚠ **Refused, and refused *before the plugin ran*.** On the upload path the
   * browser opened the archive itself and `consentBroken` reports afterwards —
   * tolerable, because the reader there read the very bytes that were sent. Here
   * nothing local ever opened the archive, so this one has to be a refusal rather
   * than a notification, and it has to land before `ensureStarted`. The second
   * assertion is the half that matters: not merely a 409, but nothing installed.
   */
  const sneaky = await sourceRig("sneaky", () =>
    tarball({ scopes: ["store", "sessions.read"], contributes: { hooks: ["permission.requested"] } }),
  );
  const overreached = await postSource(sneaky.app, {
    source: { kind: "github", repo: REPO_NAME, commit: SHA },
    consent: { scopes: [], net: [], hooks: [] },
  });
  check(
    "a commit asking for more than was shown",
    [overreached.status, errorOf(overreached.body).code],
    [409, "plugin_consent_broken"],
  );
  check("and nothing was installed", [sneaky.host.list(), sneaky.rows.has("board")], [[], false]);

  /*
   * A caller that sends no consent at all is not a client bug: `pnpm client` has
   * no screen to have shown anybody, and `install` skips the check for it. What
   * that costs is stated rather than hidden — the archive is still validated, and
   * the scopes still land on the row where somebody can read them.
   */
  const unasked = await postSource(sneaky.app, { source: { kind: "github", repo: REPO_NAME, commit: SHA } });
  check("a caller that consented to nothing at all is not held to nothing", unasked.status, 201);
  await sneaky.close();

  /*
   * ⚠ **The bound holds with no `content-length`, which is the only way it is
   * ever exercised in the fleet.** Measured: codeload sends none — the tarball is
   * generated as it is sent. So a guard reading that header would bound precisely
   * nothing on the one URL this path fetches, and the real bound is
   * `unpackArchive` charging each chunk against `PLUGIN_LIMITS.maxBytes` as it
   * reads. This drives exactly that shape: a streamed body, no header, over the
   * ceiling.
   */
  const flood = await sourceRig("flood", () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= PLUGIN_LIMITS.maxBytes + chunk.byteLength) {
            controller.close();
            return;
          }
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
      { status: 200 },
    );
  });
  const flooded = await postSource(flood.app, { source: { kind: "github", repo: REPO_NAME, commit: SHA } });
  check(
    "an archive over the ceiling, arriving with no content-length",
    [flooded.status, errorOf(flooded.body).code],
    [413, "plugin_too_large"],
  );
  await flood.close();

  /*
   * What the far end said, as codes a person can act on. `404` keeps its own,
   * because "that commit is not there, or the repository is private" is the one
   * refusal here somebody can do something about; everything else is `502`,
   * because nothing was wrong with the request and this daemon is not the thing
   * that is unwell.
   */
  const farEnd: [string, () => Response | Promise<Response>, number, string][] = [
    ["a commit that is not there", () => new Response("no", { status: 404 }), 502, "plugin_source_not_found"],
    ["a forge having a bad day", () => new Response("no", { status: 500 }), 502, "plugin_source_unavailable"],
    [
      // What `redirect: "error"` produces, which is a throw rather than a status.
      // The `github.com/<repo>/archive` spelling is the one that redirects, and it
      // is built nowhere — this is the guard that says so.
      "a redirect, which this path refuses to follow",
      () => Promise.reject(new Error("unexpected redirect")),
      502,
      "plugin_source_unavailable",
    ],
  ];
  for (const [label, answer, status, code] of farEnd) {
    const rig = await sourceRig(`far-${code}-${status}-${label.length}`, answer);
    const said = await postSource(rig.app, { source: { kind: "github", repo: REPO_NAME, commit: SHA } });
    check(label, [said.status, errorOf(said.body).code], [status, code]);
    await rig.close();
  }

  /*
   * ⚠ **A tag and a short sha are refused, and that is a security decision.** A
   * tag moves under `git tag -f`, so a plugin pinned "at v1.2.0" is a plugin whose
   * code can change under an identifier that did not — and what is being pinned is
   * code that runs as this machine's owner with no sandbox. Both are well-formed
   * enough to look like an oversight when refused, which is why the message names
   * them.
   */
  const bad = await sourceRig("bad", () => tarball());
  const shapes: [string, unknown][] = [
    ["no source at all", {}],
    ["a forge this daemon does not install from", { source: { kind: "gitlab", repo: REPO_NAME, commit: SHA } }],
    ["a repo that is not owner/name", { source: { kind: "github", repo: "board", commit: SHA } }],
    ["a repo reaching for a third path segment", { source: { kind: "github", repo: "a/b/c", commit: SHA } }],
    ["a tag where a commit belongs", { source: { kind: "github", repo: REPO_NAME, commit: "v1.2.0" } }],
    ["a short sha", { source: { kind: "github", repo: REPO_NAME, commit: SHA.slice(0, 7) } }],
  ];
  const refusals: [number, string][] = [];
  for (const [, body] of shapes) {
    const said = await postSource(bad.app, body);
    refusals.push([said.status, errorOf(said.body).code]);
  }
  check(
    `every malformed source, refused before a socket is opened (${shapes.map(([label]) => label).join("; ")})`,
    refusals,
    shapes.map(() => [400, "plugin_source_invalid"]),
  );
  check("and none of them reached the far end", bad.urls, []);

  /*
   * ⚠ **Both axes, on the newest route.** A route's scope is the caller's;
   * `manifest.scopes` is the plugin's, and neither implies the other. Installing
   * is `machine:admin` — a grant that can drive sessions all day may not put code
   * on the machine — and this is the route where getting that wrong would let a
   * `session:write` grant fetch and run somebody else's code as the owner.
   */
  const asWriter = await postSource(
    bad.app,
    { source: { kind: "github", repo: REPO_NAME, commit: SHA } },
    ["session:read", "session:write"],
  );
  check(
    "a session:write grant may not install from a commit",
    [asWriter.status, errorOf(asWriter.body).code],
    [403, "insufficient_scope"],
  );
  check("and it reached the far end no more than the malformed ones did", bad.urls, []);
  await bad.close();
}

process.stdout.write("\nwhat a plugin's own refusal becomes over HTTP\n");
{
  const { PluginHost } = await import("../src/plugins/host.js");
  const { SessionRegistry } = await import("../src/registry.js");
  const { hostGit } = await import("../src/git.js");
  const { openStores } = await import("../src/store/sqlite.js");
  const { parseManifest } = await import("../src/plugins/manifest.js");

  const parsed = parseManifest(
    JSON.stringify({
      id: "p",
      name: "P",
      version: "1.0.0",
      api: 1,
      scopes: [],
      contributes: { screen: { title: "P" }, settings: true },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.message);

  /**
   * A child scripted per bucket of `pluginErrorStatus`.
   *
   * ⚠ **Read the code, never the status.** That function exists so the statuses
   * are at least not misleading, not so anybody branches on them, and the split is
   * by *whose problem it is*: a plugin that is off or broken is on this machine
   * and the request was fine (`503`), a plugin that did not answer in time is
   * worth asking again (`504`), and everything else is something downstream of
   * this daemon answering badly (`502`).
   */
  const childThat = (behaviour: "up" | "wontStart" | "silent" | "throws" | "asks" | "oversize" | "greedy"): PluginRuntime => ({
    launch(options) {
      /** Which invocation the `asks` child is still holding while it asks. */
      let holding = 0;
      /** The `greedy` child's tally: how many answers came back, and how many said no. */
      let answered = 0;
      let refused = 0;
      return Promise.resolve({
        send(message) {
          if (message.t === "init") {
            queueMicrotask(() =>
              options.onMessage(
                behaviour === "wontStart" ? { t: "fail", error: "this build will not run" } : { t: "ready" },
              ),
            );
            return true;
          }
          if (message.t === "answer") {
            if (behaviour === "greedy") {
              // Counted rather than reported one at a time: the question is how
              // many of the twenty-four the host would carry at once.
              if (message.ok === false && String(message.error).includes("calls out")) refused += 1;
              answered += 1;
              if (answered === 24) {
                queueMicrotask(() =>
                  options.onMessage({ t: "done", id: holding, ok: true, value: { title: `refused ${refused}`, blocks: [] } }),
                );
              }
              return true;
            }
            // Whatever the host said about the call below, handed back as this
            // plugin's own view — which is the only way it is visible from
            // outside the child at all.
            const said = message.ok ? "allowed" : message.error;
            queueMicrotask(() =>
              options.onMessage({ t: "done", id: holding, ok: true, value: { title: said, blocks: [] } }),
            );
            return true;
          }
          if (message.t === "invoke" && behaviour === "asks") {
            holding = message.id;
            queueMicrotask(() => options.onMessage({ t: "call", id: 1, method: "store.get", args: { key: "k" } }));
            return true;
          }
          /*
           * ⚠ **A channel that refuses the write, which every fake here reported
           * as succeeding.** `plugin_request_too_large` is raised where
           * `child.send` answers `false`, so with five runtimes all returning
           * `true` the arm — and the status it maps to — was unreachable from
           * this driver. It settles the invocation immediately on purpose: the
           * measured defect it replaced was three oversized forms spending the
           * whole invoke deadline each and exhausting the timeout budget.
           */
          if (message.t === "invoke" && behaviour === "oversize") return false;
          /*
           * A plugin doing the obvious thing an author of a task board does:
           * asking about every session at once. All of them are emitted inside a
           * single microtask, so every one is counted before the first answer
           * releases its slot — which is exactly the fan-out
           * `MAX_INFLIGHT_HOST_CALLS` exists to bound, and which nothing bounded
           * before. What the child hands back is how many it was refused.
           */
          if (message.t === "invoke" && behaviour === "greedy") {
            holding = message.id;
            queueMicrotask(() => {
              for (let i = 1; i <= 24; i += 1) {
                options.onMessage({ t: "call", id: i, method: "store.get", args: { key: `k${i}` } });
              }
            });
            return true;
          }
          if (message.t === "invoke" && behaviour !== "silent") {
            queueMicrotask(() =>
              options.onMessage(
                behaviour === "throws"
                  ? { t: "done", id: message.id, ok: false, error: "the plugin threw" }
                  : { t: "done", id: message.id, ok: true, value: { title: "screen", blocks: [] } },
              ),
            );
          }
          return true;
        },
        stop: () => Promise.resolve(),
        recentLogs: () => [],
      });
    },
  });

  const rigFor = async (
    name: string,
    behaviour: "up" | "wontStart" | "silent" | "throws" | "asks" | "oversize" | "greedy",
  ): Promise<{ app: ReturnType<typeof createApp>["app"]; close: () => Promise<void> }> => {
    const stores = openStores({ path: join(tmp(`plugin-code-${name}-`), "d.db"), instanceId: `i_code_${name}` });
    stores.plugins.put({
      id: "p",
      version: "1.0.0",
      manifest: parsed.manifest,
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      source: null,
    });
    const registry = new SessionRegistry(stores.events, stores.sessions);
    const host = await PluginHost.open({
      root: join(tmp(`plugin-code-root-${name}-`), "plugins"),
      records: stores.plugins,
      data: stores.pluginData,
      registry,
      api: { git: hostGit },
      runtime: childThat(behaviour),
      // Short, because two of these cases are a deadline being reached and the
      // production ten seconds each would put most of a minute into `pnpm check`.
      timeouts: { start: 100, invoke: 100 },
    });
    const { app } = createApp({
      registry,
      verifier,
      instanceId: `i_code_${name}`,
      startedAt: Date.now(),
      plugins: host,
    });
    return {
      app,
      close: async () => {
        await host.shutdown();
        await registry.shutdown();
        stores.close();
      },
    };
  };

  const view = async (
    app: ReturnType<typeof createApp>["app"],
  ): Promise<{ status: number; code: string; title: string | null }> => {
    const response = await app.request("/plugins/p/views/screen", {
      headers: { authorization: `Bearer ${tokenFor("codes")}` },
    });
    const text = await response.text();
    const body = text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
    return {
      status: response.status,
      code: (body["error"] as { code?: string } | undefined)?.code ?? "none",
      // Carried out of the view, because the last case below is a plugin
      // reporting what the daemon told *it* and the route's status says nothing
      // about that.
      title: (body["result"] as { view?: { title?: string | null } } | undefined)?.view?.title ?? null,
    };
  };

  const up = await rigFor("up", "up");
  check("a plugin that answers", await view(up.app), { status: 200, code: "none", title: "screen" });

  /*
   * Eight at once is the bound and the ninth is **refused rather than queued**:
   * the caller is an HTTP request somebody is waiting on, and holding it behind
   * seven others only moves the timeout. `503` and not `502` for the same reason
   * a 429 is not a 400 — the remedy is to ask again.
   */
  const flood = await Promise.all(Array.from({ length: 9 }, () => view(up.app)));
  report(
    "and nine at once, one of which is told the plugin is busy",
    flood.some((one) => one.status === 503 && one.code === "plugin_overloaded"),
    flood.map((one) => `${one.status} ${one.code}`).join(", "),
  );
  await up.close();

  const wontStart = await rigFor("wontStart", "wontStart");
  check("a plugin that will not start", await view(wontStart.app), {
    status: 503,
    code: "plugin_unavailable",
    title: null,
  });
  await wontStart.close();

  /*
   * A timeout is its own code and its own status, because the remedy differs:
   * `plugin_failed` is the plugin author's problem and `plugin_timeout` is "ask
   * again, or look at whether this machine is busy".
   */
  const silent = await rigFor("silent", "silent");
  check("a plugin that never answers", await view(silent.app), { status: 504, code: "plugin_timeout", title: null });
  await silent.close();

  const throws = await rigFor("throws", "throws");
  check("a plugin that answers with a failure", await view(throws.app), {
    status: 502,
    code: "plugin_failed",
    title: null,
  });
  await throws.close();

  /*
   * ⚠ **`413`, and it used to be `502` by falling off the end.**
   * `pluginErrorStatus` had no arm for `plugin_request_too_large`, so it took the
   * default — whose stated reason is "something downstream of this daemon
   * answered badly", when nothing downstream answered at all: the message never
   * reached the child because it does not fit one IPC frame. `docs/API.md` said
   * `503`, a third answer agreeing with neither. `413` is what this daemon already
   * says for `payload_too_large` and both import ceilings, and it is the one that
   * points at the caller, where the remedy is.
   */
  const oversize = await rigFor("oversize", "oversize");
  check("a request too large for the channel", await view(oversize.app), {
    status: 413,
    code: "plugin_request_too_large",
    title: null,
  });
  await oversize.close();

  /*
   * ⚠ **The other direction, which had no ceiling at all.**
   * `MAX_INFLIGHT_INVOCATIONS` bounds host → child and was published in both
   * bounds tables; nothing bounded child → host, and the two are not symmetric in
   * cost — `sessions.changes` and `sessions.diff` each fork git. Twenty-four at
   * once is one line an author of a task board writes without thinking about it,
   * and the answer is a refusal per excess call rather than a queue: the child
   * asked for them now, and holding them only moves the deadline it is already
   * waiting on.
   */
  const greedy = await rigFor("greedy", "greedy");
  check("a plugin that asks for everything at once is answered, and told no past the bound", await view(greedy.app), {
    status: 200,
    code: "none",
    title: "refused 8",
  });
  await greedy.close();

  /*
   * ⚠ **`plugin_scope_denied → 403` is the one arm of `pluginErrorStatus` that
   * nothing can reach, and it is unreachable rather than undriven.** A scope
   * refusal is raised inside `PluginApi.call`, which is only ever entered from the
   * child's own `call` message — `LivePlugin.onMessage` catches it and sends the
   * plugin an `answer` carrying that code, so it crosses back to the **plugin**
   * and never out of `invoke`. The two axes really are two: the caller's scope
   * decided this request at the route, and the plugin's decided this call inside
   * the child, and the second one has no way to become the first one's status.
   *
   * Driven from the only side it is visible from rather than written down as a
   * note: a child that asks for a method its manifest does not declare, and hands
   * back whatever it was told as its own view. What the route answers is `200`,
   * because from where it is standing the plugin did its job.
   */
  const asks = await rigFor("asks", "asks");
  const asked = await view(asks.app);
  check("a plugin asking for something it did not declare is still a 200", [asked.status, asked.code], [200, "none"]);
  report(
    "and what it was told is the refusal, delivered to it rather than to the caller",
    asked.title?.startsWith("plugin_scope_denied: store.get needs") === true,
    asked.title ?? "nothing came back",
  );
  await asks.close();
}

process.stdout.write("\nbeing told a session appeared\n");
{
  const { SessionRegistry } = await import("../src/registry.js");

  const root = tmp("observer-");
  mkdirSync(root, { recursive: true });
  const warnings: string[] = [];
  const registry = new SessionRegistry(
    undefined,
    storeOf([rowFor("s_one", root), rowFor("s_two", root)]),
    undefined,
    undefined,
    undefined,
    (detail) => warnings.push(detail),
  );

  /*
   * ⚠ **A throwing observer is reported, kept, and does not stop the ones after
   * it.** All three are asserted here because all three are the opposite of what
   * `SessionLog.append` does to a throwing listener, and the difference is
   * deliberate: there, a listener is one WebSocket and evicting it costs that
   * socket its events; here it is a whole subsystem, and dropping it on one bad
   * frame would stop every plugin hook on the machine for the life of the daemon
   * with nothing anywhere saying so.
   *
   * Registered **first**, so "the ones after it" is a real position rather than a
   * hope about iteration order.
   */
  let threw = 0;
  const unstable = registry.watchSessions(() => {
    threw += 1;
    throw new Error("this observer is broken");
  });
  const seen: [string, string][] = [];
  const stop = registry.watchSessions((managed, arrival) => seen.push([managed.id, arrival]));

  registry.restore({ reapOrphans: false });

  check(
    "every session already here is announced, as restored",
    seen,
    [
      ["s_one", "restored"],
      ["s_two", "restored"],
    ],
  );
  report("a throwing observer is called for every one of them", threw === 2, `${threw} calls`);
  report(
    "each throw is reported rather than swallowed",
    warnings.filter((one) => one.includes("this observer is broken")).length === 2,
    `${warnings.length} warnings`,
  );

  unstable();
  stop();
  const before = seen.length;
  registry.restore({ reapOrphans: false });
  check("and unsubscribing really stops it", seen.length, before);

  await registry.shutdown();
}

process.stdout.write(
  failures === 0 ? "\nall green\n" : `\n${failures} failure(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
