import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { SignedTokenVerifier, type Scope } from "../src/auth.js";
import { checkPluginWrite, type PluginDataStore } from "../src/plugins/store.js";
import { MemoryEventStore, type PersistedSession, type SessionStore } from "../src/events.js";
import type { UploadIndex, UploadRow } from "../src/uploads.js";
import { SessionRegistry } from "../src/registry.js";
import { createApp } from "../src/server.js";
import { publicKeyToJwk, signToken, type TokenClaims } from "../src/token.js";
import { tmp } from "./tmp.js";

export function memoryUploadIndex(): UploadIndex {
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

/** Keyed on the (pluginId, key) pair like the real store, so a cross-plugin leak stays observable. */
export function memoryPluginData(): PluginDataStore {
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
      // Charges the shared bound through checkPluginWrite, so quota refusals hold against both stores.
      const held = keysOf(id, "");
      checkPluginWrite(key, value, {
        keys: held.length,
        bytes: held.reduce((total, one) => total + (sizeOf(id, one) ?? 0), 0),
        existing: sizeOf(id, key),
      });
      data.set(at(id, key), value);
    },
    delete: (id, key) => void data.delete(at(id, key)),
    // Sorted to match the SQLite store's key ordering.
    keys: (id, prefix) => keysOf(id, prefix).sort(),
    entries: (id, prefix, after, maxBytes) => {
      const out: { key: string; value: unknown }[] = [];
      let bytes = 0;
      for (const key of keysOf(id, prefix).sort()) {
        if (key <= after) continue;
        const text = data.get(at(id, key)) as string;
        // Charged in answer bytes like SQLite, minus its per-pair scaffolding, which is why paging fixtures use coarse rows.
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

// Realpathed: on macOS /var is a symlink to /private/var, and resolveCwd resolves before it compares.
export const sandbox = realpathSync(tmp("daemoncheck-"));
export const users = join(sandbox, "users");
// The pair that a bare `startsWith` gets wrong: one id is a prefix of another.
export const uAb = join(users, "u_ab");
export const uAbcd = join(users, "u_abcd");
mkdirSync(join(uAb, "proj"), { recursive: true });
mkdirSync(join(uAbcd, "proj"), { recursive: true });

// A symlink planted inside one's own tree, pointing out of it. Textually the
// path is inside the root; it resolves somewhere else entirely.
export const escape = join(uAb, "escape");
symlinkSync(uAbcd, escape);
/** A plain file, for the one refusal that is about shape rather than location. */
export const aFile = join(uAb, "notes.txt");
writeFileSync(aFile, "hello\n");

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const kid = "k_daemoncheck";
const identity = {
  machineId: "m_self",
  issuer: "reemoat-cp",
  keys: [{ kid, jwk: publicKeyToJwk(publicKey) }],
};
// The real clock: the app reads its own, so a frozen iat would make every token not-yet-valid.
export const now = Date.now();
const iat = Math.floor(now / 1000);

export function tokenWith(sub: string, scp: Scope[], cnf?: { jkt: string }): string {
  const claims: TokenClaims = {
    iss: "reemoat-cp",
    sub,
    aud: "m_self",
    jti: `t_${sub}`,
    iat,
    nbf: iat,
    exp: iat + 300,
    scp,
    ...(cnf === undefined ? {} : { cnf }),
  };
  return signToken(claims, kid, privateKey);
}

/** A capability bound to one device key; only the encrypted path has a channel to bind it to. */
export function boundToken(sub: string, thumbprint: string): string {
  return tokenWith(sub, ["session:read", "session:write", "machine:admin"], { jkt: thumbprint });
}

export function tokenFor(sub: string): string {
  return tokenWith(sub, ["session:read", "session:write", "machine:admin"]);
}

/** Claims of the caller's choosing over the defaults, signed with the key the verifier trusts: a link capability, or a broken one. */
export function signedClaims(extra: Record<string, unknown>, scp: string[] = ["session:message"]): string {
  const claims = { iss: "reemoat-cp", sub: "u_alice", aud: "m_self", jti: `t_${extra["lnk"] ?? "x"}`, iat, nbf: iat, exp: iat + 300, scp, ...extra };
  return signToken(claims as TokenClaims, kid, privateKey);
}

export const verifier = new SignedTokenVerifier({ identity });

/** Enough of a store to drive `restore()`; nothing here is ever written back. */
export function storeOf(rows: PersistedSession[]): SessionStore {
  return { put: () => {}, list: () => rows, remove: () => {} };
}

export function rowFor(
  id: string,
  root: string,
  meta: { title?: string | null; pinned?: boolean; rank?: number | null } = {},
): PersistedSession {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "notes.txt"), "hi\n", "utf8");
  // Over COMPRESS_MIN_BYTES and compressible, so the download route's exclusion from gzip is drivable.
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
    rank: meta.rank ?? null,
    ultracode: null,
    customAgent: null,
    agentState: null,
  };
}

const rows = [
  rowFor("s_one", join(users, "u_alice", "proj")),
  // Pinned and second, so a limit of one has to reorder to keep it.
  rowFor("s_two", join(users, "u_alice", "other"), { pinned: true }),
  rowFor("s_three", join(users, "u_bob", "proj")),
];

export const registry = new SessionRegistry(new MemoryEventStore(), storeOf(rows));
registry.restore({ reapOrphans: false });

const credentialRows = new Map<string, { agent: string; envName: string; secret: string; updatedAt: number }>();
export const credentials = {
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

export const { app, injectWebSocket } = createApp({
  registry,
  verifier,
  instanceId: "i_daemoncheck",
  startedAt: now,
  credentials,
  roots: [users],
  // No logins: the wizard routes answering 503 without one is behaviour under test.
});

export async function get(path: string, sub: string): Promise<{ status: number; body: any }> {
  const response = await app.fetch(
    new Request(`http://d${path}`, { headers: { authorization: `Bearer ${tokenFor(sub)}` } }),
  );
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

/** Launch config for stub runtimes that override launch, so no agent binary has to exist on PATH. */
export function stubAgentConfig(agent: AgentId): AgentLaunchConfig {
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
