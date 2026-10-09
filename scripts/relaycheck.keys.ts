import { spawn, spawnSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { SignedTokenVerifier } from "../src/auth.js";
import { parseEnrollResponse } from "../src/enroll.js";
import { createKeysetTaker, weighAnnouncement, type KeysetHeld } from "../src/keyset.js";
import { MAX_KEYSET_ENDORSEMENTS, MAX_ROOT_HANDOVERS } from "../src/relay/protocol.js";
import { RelayTunnel } from "../src/relay/tunnel.js";
import { openStores, type StoredIdentity } from "../src/store/sqlite.js";
import {
  KEYSET_TYP,
  MAX_STATEMENT_KEYS,
  ROOT_TYP,
  publicKeyToJwk,
  signCompact,
  signToken,
  type PublicKeyJwk,
  type TokenClaims,
} from "../src/token.js";
import { createControlPlaneApp } from "../packages/control-plane/src/app.js";
import {
  KeySecretError,
  activePublicKeys,
  activeSigningKeys,
  configureKeySecret,
  ensureSigningKey,
  isWrapped,
  issueTunnelKey,
  keyIdFor,
  keySecretProblem,
  mintEnrollmentCode,
  mintSigningKey,
  newApiKey,
  newId,
  signingKeyRows,
  tokenSigningKey,
  unwrapStoredKeys,
  wrapStoredKeys,
} from "../packages/control-plane/src/keys.js";
import { createRelayListener } from "../packages/control-plane/src/relay/listener.js";
import { TunnelRegistry } from "../packages/control-plane/src/relay/registry.js";
import { applyControlPlaneSchema, openControlStore } from "../packages/control-plane/src/store.js";
import {
  adoptRoot,
  announcedKeyset,
  ensureTrustRoot,
  liveRoot,
  machinesBehind,
  newestStatement,
  rotateSigningKey,
  statementIsCurrent,
} from "../packages/control-plane/src/trustroot.js";
import { tmp } from "./tmp.js";

export interface KeysContext {
  issuer: string;
  check: (name: string, got: unknown, want: unknown) => void;
  report: (name: string, ok: boolean, detail: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(holds: () => boolean, timeoutMs = 6_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (holds()) return true;
    await sleep(15);
  }
  return holds();
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  applyControlPlaneSchema(db);
  return db;
}

const CPCTL = fileURLToPath(new URL("../packages/control-plane/scripts/cpctl.ts", import.meta.url));

/** cpctl as the process an operator runs. Its root verbs reach no control plane, so none is needed for them here. */
function cpctl(args: string[], input = ""): { status: number | null; out: string; err: string } {
  const run = spawnSync(process.execPath, [...process.execArgv, CPCTL, ...args], { encoding: "utf8", input });
  return { status: run.status, out: run.stdout.trim(), err: run.stderr };
}

/** The verbs that do reach one, against a listener in this process: not spawnSync, which would stop that listener answering. */
function cpctlAt(url: string, key: string, args: string[]): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, CPCTL, ...args], {
      env: { ...process.env, REEMOAT_CP_URL: url, REEMOAT_CP_KEY: key },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("close", (status) => resolve({ status, out: out.trim(), err }));
  });
}

/** Who signed a compact JWS, read off its header with no verification: for the order of an announcement only. */
function signerOf(jws: string): string {
  return String((JSON.parse(Buffer.from(jws.split(".")[0] ?? "", "base64url").toString("utf8")) as { kid?: unknown }).kid);
}

/** Private keys at rest, which key signs, the root and its statements, and a rotation taken off a real tunnel. */
export async function signingKeysAndRoot(ctx: KeysContext): Promise<void> {
  const { issuer, check, report } = ctx;
  const storedKey = (db: DatabaseSync, table: string, kid: string): string =>
    String(db.prepare(`SELECT private_pem FROM ${table} WHERE kid = ?`).get(kid)?.["private_pem"] ?? "");
  const problemOf = (run: () => unknown): string => {
    try {
      run();
      return "(none)";
    } catch (error) {
      return error instanceof KeySecretError ? error.reason : "(another error)";
    }
  };

  process.stdout.write("\nprivate keys at rest\n");
  try {
    const plain = freshDb();
    configureKeySecret(null);
    const first = ensureSigningKey(plain);
    check("with no secret a private key is stored as the PEM it always was", storedKey(plain, "signing_keys", first.kid).startsWith("-----BEGIN PRIVATE KEY-----"), true);
    check("and there is nothing to wrap", wrapStoredKeys(plain), 0);
    check("nor anything a start would refuse", keySecretProblem(plain), null);
    const root = ensureTrustRoot(plain, issuer);

    // The upgrade path: a database written before the secret existed, opened by a process that now has one.
    configureKeySecret("correct horse");
    check("a plain row still loads once a secret is set, so the wrap is not a flag day", activeSigningKeys(plain)[0]?.kid, first.kid);
    check("and a start refuses nothing", keySecretProblem(plain), null);
    check("every stored private key is wrapped in place, the root's with them", wrapStoredKeys(plain), 2);
    const wrapped = storedKey(plain, "signing_keys", first.kid);
    check("and what is stored no longer contains the key", [isWrapped(wrapped), wrapped.includes("BEGIN")], [true, false]);
    check("the root's is wrapped too", isWrapped(storedKey(plain, "trust_roots", root.kid)), true);
    check("a second pass finds nothing left", wrapStoredKeys(plain), 0);
    check("the key keeps its id, so nothing a daemon holds moved", activeSigningKeys(plain).map((key) => key.kid), [first.kid]);

    const seconds = Math.floor(Date.now() / 1000);
    const claims: TokenClaims = { iss: issuer, sub: "u_w", aud: "m_w", jti: "t_w", iat: seconds, nbf: seconds, exp: seconds + 300, scp: ["session:read"] };
    const verifier = new SignedTokenVerifier({ identity: { machineId: "m_w", issuer, keys: [{ kid: first.kid, jwk: first.jwk }] } });
    const unwrapped = tokenSigningKey(plain);
    check("and it still signs what the same public half verifies", verifier.verify(signToken(claims, unwrapped?.kid ?? "", unwrapped!.privateKey)).ok, true);

    const minted = mintSigningKey(plain);
    check("a key minted under the secret is wrapped from the start", isWrapped(storedKey(plain, "signing_keys", minted.kid)), true);
    report("each under its own salt", storedKey(plain, "signing_keys", minted.kid).split(":")[2] !== wrapped.split(":")[2], "two rows, two salts");

    configureKeySecret("a different secret");
    check("a different secret opens nothing", keySecretProblem(plain), "wrong");
    check("and loading says so rather than answering a key", problemOf(() => activeSigningKeys(plain)), "wrong");

    configureKeySecret(null);
    check("wrapped rows with no secret are a refusal, not a fresh key", keySecretProblem(plain), "missing");
    check("for the signer", problemOf(() => tokenSigningKey(plain)), "missing");
    check("and for whoever would mint beside it", problemOf(() => ensureSigningKey(plain)), "missing");
    check("nothing was minted by asking", signingKeyRows(plain).length, 2);

    // The way back, which a rollback to a build that cannot read a wrapped key needs first.
    configureKeySecret("correct horse");
    check("every wrapped key can be stored as its PEM again", unwrapStoredKeys(plain), 3);
    check("as the PEM a build with no secret reads", storedKey(plain, "signing_keys", first.kid).startsWith("-----BEGIN PRIVATE KEY-----"), true);
    configureKeySecret(null);
    check("so with the secret gone it opens, the same keys under the same ids", [keySecretProblem(plain), activeSigningKeys(plain).map((key) => key.kid).sort()], [null, [first.kid, minted.kid].sort()]);
    check("and there is nothing left to unwrap", unwrapStoredKeys(plain), 0);

    // The kid is bound into the blob: a wrapped key copied onto another row must not open there.
    configureKeySecret("correct horse");
    wrapStoredKeys(plain);
    plain.prepare("UPDATE signing_keys SET private_pem = ? WHERE kid = ?").run(storedKey(plain, "signing_keys", first.kid), minted.kid);
    check("a wrapped key moved onto another row does not open", keySecretProblem(plain), "wrong");
    plain.close();
  } finally {
    configureKeySecret(null);
  }

  // On a real file: what a write leaves behind is a property of pages and of the log, and :memory: has neither.
  process.stdout.write("\nwhat a wrapped or erased key leaves in the file\n");
  try {
    const bodyOf = (pem: string): string => pem.split("\n").filter((line) => line.length > 0 && !line.startsWith("-----")).join("");
    const bytesOf = (path: string): string =>
      [path, `${path}-wal`].map((file) => (existsSync(file) ? readFileSync(file).toString("latin1") : "")).join("\n");
    const holds = (path: string, pems: string[]): boolean[] => pems.map((pem) => bytesOf(path).includes(bodyOf(pem)));

    const path = join(tmp("reemoat-relaycheck-keys-"), "control-plane.db");
    const written = openControlStore({ path });
    const pems = [ensureSigningKey(written.db), mintSigningKey(written.db)].map((key) => storedKey(written.db, "signing_keys", key.kid));
    written.close();
    report("two signing keys are stored as plain PEM", pems.every((pem) => bodyOf(pem).length > 40), `${bodyOf(pems[0] ?? "").length} characters each`);
    check("and the search finds both in the file while they are", holds(path, pems), [true, true]);

    const started = openControlStore({ path });
    configureKeySecret("correct horse");
    check("the first start with the secret wraps both", wrapStoredKeys(started.db), 2);
    check("and neither is left in the file or in its log, with the service still holding it open", holds(path, pems), [false, false]);
    check("both still open under the secret", activeSigningKeys(started.db).length, 2);
    started.close();
    configureKeySecret(null);

    const rootPath = join(tmp("reemoat-relaycheck-root-"), "control-plane.db");
    const rooted = openControlStore({ path: rootPath });
    const leaving = ensureTrustRoot(rooted.db, issuer);
    const rootPem = [storedKey(rooted.db, "trust_roots", leaving.kid)];
    rooted.close();
    check("a root kept on the host is in the file too", holds(rootPath, rootPem), [true]);
    const handing = openControlStore({ path: rootPath });
    const successor = publicKeyToJwk(generateKeyPairSync("ed25519").publicKey);
    check("handing it over", adoptRoot(handing.db, issuer, successor, null).ok, true);
    check("erases its private half from the file and the log, not only from the row", holds(rootPath, rootPem), [false]);
    handing.close();
  } finally {
    configureKeySecret(null);
  }

  process.stdout.write("\nwhich key signs, and what a statement says\n");
  const rdb = freshDb();
  const oldest = ensureSigningKey(rdb);
  const adminKey = newApiKey();
  const plainKey = newApiKey();
  const at = Date.now();
  rdb.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_ra', 'rootadmin', 1, ?)").run(at);
  rdb.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_rp', 'rootplain', 0, ?)").run(at);
  for (const [user, key] of [["u_ra", adminKey], ["u_rp", plainKey]] as const) {
    rdb.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(newId("ak"), user, key.prefix, key.hash, at);
  }
  const app = createControlPlaneApp({ db: rdb, issuer, tokenTtlSeconds: 300, relayUrl: "http://relay.invalid" });
  const as = (key: string | null): Record<string, string> =>
    key === null ? { "content-type": "application/json" } : { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown, key: string | null = adminKey.key): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await app.request(path, { method, headers: as(key), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };
  const outcome = (answer: { status: number; body: Record<string, unknown> }): [number, unknown] => [
    answer.status,
    (answer.body["error"] as { code?: string } | undefined)?.code ?? null,
  ];
  const signer = (): string | undefined => tokenSigningKey(rdb)?.kid;
  const statedKids = (): string[] | undefined => newestStatement(rdb)?.kids;
  const publicHalf = (kid: string): { kid: string; jwk: PublicKeyJwk }[] => activePublicKeys(rdb).filter((key) => key.kid === kid);
  /** Minted through the route, as an app's capability is: which key signed it is read off the header. */
  const mintedBy = async (machine: string): Promise<string> => signerOf(String((await call("POST", "/v1/tokens", { machine })).body["token"]));

  {
    const enrollWith = async (db: DatabaseSync, target: typeof app, machineId: string): Promise<Record<string, unknown>> => {
      db.prepare("INSERT INTO machines (id, name, created_at) VALUES (?, ?, ?)").run(machineId, machineId, Date.now());
      const minted = mintEnrollmentCode(db, machineId, "u_ra", 60_000);
      const response = await target.request("/v1/enroll", { method: "POST", headers: as(null), body: JSON.stringify({ code: minted.code }) });
      return (await response.json()) as Record<string, unknown>;
    };

    const before = await enrollWith(rdb, app, "m_rootless");
    check("before there is a root, enrollment names none", [before["root"], before["keyset"]], [null, null]);
    const rootless = parseEnrollResponse(before);
    check("and a daemon enrolls exactly as it did", [rootless.root, rootless.keysetVersion, rootless.keys.map((key) => key.kid)], [null, null, [oldest.kid]]);

    check("the root is nobody's without a credential", (await call("GET", "/v1/admin/root", undefined, null)).status, 401);
    check("nor an ordinary account's", (await call("GET", "/v1/admin/root", undefined, plainKey.key)).status, 403);
    const shown = (await call("GET", "/v1/admin/root")).body as {
      issuer: string;
      root: { kid: string; jwk: unknown; online: boolean };
      statement: { version: number; current: boolean } | null;
    };
    check("an instance makes its own root and keeps it here", [shown.root.online, shown.root.kid === liveRoot(rdb)?.kid, shown.issuer], [true, true, issuer]);
    check("with a first statement naming the one signing key", [shown.statement?.version, shown.statement?.current, statedKids()], [1, true, [oldest.kid]]);
    check("asking again makes neither a second root nor a second statement", [ensureTrustRoot(rdb, issuer).kid, newestStatement(rdb)?.version], [shown.root.kid, 1]);
    report("the answer carries no private half", !JSON.stringify(shown).includes("PRIVATE"), "public JWK only");

    const rotated = await call("POST", "/v1/admin/signing-keys");
    const newer = String(rotated.body["kid"]);
    check("minting a key publishes it in the next statement", [rotated.status, rotated.body["active"], rotated.body["statement"], rotated.body["rootOnline"]], [201, 2, { version: 2 }, true]);
    check("which names both", statedKids(), [oldest.kid, newer].sort());
    check("and the oldest key goes on signing, so nothing a daemon holds stops verifying", signer(), oldest.kid);
    const listed = (await call("GET", "/v1/admin/signing-keys")).body["keys"] as { kid: string; signs: boolean }[];
    check("the listing says which one signs", listed.filter((key) => key.signs).map((key) => key.kid), [oldest.kid]);
    check("with the newest still first", listed[0]?.kid, newer);

    const enrolled = await enrollWith(rdb, app, "m_rooted");
    const read = parseEnrollResponse(enrolled);
    check("enrollment now hands over the root", [(enrolled["root"] as { kid?: string } | null)?.kid, read.root?.kid], [shown.root.kid, shown.root.kid]);
    check("and the statement in force, which the daemon verifies under it", [read.keysetVersion, read.keys.map((key) => key.kid).sort()], [2, [oldest.kid, newer].sort()]);
    rdb.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES ('u_ra', 'm_rooted', 'session:read', ?)").run(at);
    check("with two keys active, a capability minted through the route is the oldest key's", await mintedBy("m_rooted"), oldest.kid);

    const offered = announcedKeyset(rdb);
    check("the relay is handed the newest statement", [offered.version, offered.statement === newestStatement(rdb)?.statement], [2, true]);
    check("and the root's endorsement by each active key, the oldest first", offered.endorsements.map(signerOf), [oldest.kid, newer]);
    const introduced = weighAnnouncement({ issuer, keys: [{ kid: oldest.kid, jwk: oldest.jwk }], root: null, keysetVersion: null }, offered);
    check("which is what introduces the root to a daemon enrolled before there was one", [introduced.next.root?.kid, introduced.refused, introduced.next.keysetVersion], [shown.root.kid, null, 2]);
    const byNewer = weighAnnouncement({ issuer, keys: publicHalf(newer), root: null, keysetVersion: null }, offered);
    check(
      "a daemon holding only the key minted after the root, and no root, is introduced by it and takes the statement",
      [publicHalf(newer).length, byNewer.next.root?.kid, byNewer.refused, byNewer.next.keysetVersion],
      [1, shown.root.kid, null, 2],
    );

    // A database rotated in before a new key endorsed the root: the next start writes what is missing, once.
    rdb.prepare("DELETE FROM root_endorsements WHERE signer_kid = ?").run(newer);
    check("without its endorsement that daemon is told of no root", weighAnnouncement({ issuer, keys: publicHalf(newer), root: null, keysetVersion: null }, announcedKeyset(rdb)).refused, "no_root");
    ensureTrustRoot(rdb, issuer);
    check("which the next start repairs", announcedKeyset(rdb).endorsements.map(signerOf), [oldest.kid, newer]);
    const repaired = rdb.prepare("SELECT endorsement FROM root_endorsements WHERE signer_kid = ?").get(newer)?.["endorsement"];
    ensureTrustRoot(rdb, issuer);
    check(
      "once, and with no new statement",
      [rdb.prepare("SELECT endorsement FROM root_endorsements WHERE signer_kid = ?").get(newer)?.["endorsement"] === repaired, newestStatement(rdb)?.version],
      [true, 2],
    );

    const retired = await call("DELETE", `/v1/admin/signing-keys/${oldest.kid}`);
    check("retiring the old key is the switch", [retired.status, retired.body["statement"], retired.body["statementCurrent"], retired.body["behind"]], [200, { version: 3 }, true, 0]);
    check("the newer key signs from here", signer(), newer);
    check("through the route as well", await mintedBy("m_rooted"), newer);
    check("and the next statement no longer names the retired one", statedKids(), [newer]);
    check("the last active key still cannot be retired", outcome(await call("DELETE", `/v1/admin/signing-keys/${newer}`)), [409, "last_active"]);
    check("and that refusal stated nothing", newestStatement(rdb)?.version, 3);
    check("a key that is not active is a 404", outcome(await call("DELETE", `/v1/admin/signing-keys/${oldest.kid}`)), [404, "key_not_found"]);

    // The inventory behind `behind`: only a machine dialled in that has not been offered the statement counts.
    const stated = newestStatement(rdb);
    rdb.prepare("UPDATE machines SET enrolled_at = ?, daemon_keyset = 2, daemon_seen_at = ? WHERE id = 'm_rooted'").run(at, (stated?.createdAt ?? 0) + 1);
    rdb.prepare("UPDATE machines SET enrolled_at = ?, daemon_keyset = NULL, daemon_seen_at = ? WHERE id = 'm_rootless'").run(at, (stated?.createdAt ?? 0) + 1);
    check("a daemon too old to say what it holds is behind", machinesBehind(rdb, stated, () => true), 1);
    rdb.prepare("UPDATE machines SET daemon_keyset = 1, daemon_seen_at = ? WHERE id = 'm_rootless'").run((stated?.createdAt ?? 0) - 1);
    check("and so is one that has not dialled since the statement was issued", machinesBehind(rdb, stated, () => true), 1);
    check("but not while it is not dialled in at all: it takes the statement when it does", machinesBehind(rdb, stated, () => false), 0);
    const fleet = (await call("GET", "/v1/admin/fleet")).body as { keyset: { version: number } | null; machines: { id: string; keyset: number | null }[] };
    check("the fleet report names the statement in force", fleet.keyset?.version, 3);
    check("and what each machine announced on its last dial", fleet.machines.find((machine) => machine.id === "m_rooted")?.keyset, 2);
  }

  process.stdout.write("\nas many keys as a statement may name\n");
  {
    const fdb = freshDb();
    ensureSigningKey(fdb);
    fdb.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_fa', 'fulladmin', 1, ?)").run(at);
    const fullKey = newApiKey();
    fdb.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_fa', ?, ?, ?)").run(newId("ak"), fullKey.prefix, fullKey.hash, at);
    const full = createControlPlaneApp({ db: fdb, issuer, tokenTtlSeconds: 300, relayUrl: "http://relay.invalid" });
    const rotate = async (): Promise<[number, unknown]> => {
      const response = await full.request("/v1/admin/signing-keys", { method: "POST", headers: as(fullKey.key) });
      const body = (await response.json()) as Record<string, unknown>;
      return [response.status, (body["error"] as { code?: string } | undefined)?.code ?? body["active"]];
    };
    const statuses: unknown[] = [];
    for (let active = 2; active <= MAX_STATEMENT_KEYS; active += 1) statuses.push(await rotate());
    check("rotation goes on up to the reader's limit", [statuses.length, statuses.at(-1)], [MAX_STATEMENT_KEYS - 1, [201, MAX_STATEMENT_KEYS]]);
    const atLimit = announcedKeyset(fdb);
    const before = [signingKeyRows(fdb).length, newestStatement(fdb)?.version, fdb.prepare("SELECT COUNT(*) AS n FROM root_endorsements").get()?.["n"]];
    report(
      "the statement naming that many is one a daemon still takes",
      weighAnnouncement({ issuer, keys: activePublicKeys(fdb).slice(-1), root: null, keysetVersion: null }, atLimit).refused === null,
      `v${String(atLimit.version)}, ${newestStatement(fdb)?.kids.length ?? 0} keys`,
    );
    check("one more is refused", await rotate(), [409, "too_many_keys"]);
    check("by the function too, for a caller that is not the route", rotateSigningKey(fdb, issuer), { ok: false, reason: "too_many_keys" });
    check(
      "and neither wrote a key, a statement or an endorsement",
      [signingKeyRows(fdb).length, newestStatement(fdb)?.version, fdb.prepare("SELECT COUNT(*) AS n FROM root_endorsements").get()?.["n"]],
      before,
    );

    const rootless = freshDb();
    for (let minted = 0; minted < MAX_STATEMENT_KEYS; minted += 1) mintSigningKey(rootless);
    check(
      "where there is no root yet the refusal comes before one is made",
      [rotateSigningKey(rootless, issuer).ok, liveRoot(rootless), newestStatement(rootless), signingKeyRows(rootless).length],
      [false, null, null, MAX_STATEMENT_KEYS],
    );
    rootless.close();

    const served = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const started = serve({ fetch: full.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    });
    const fullUrl = `http://127.0.0.1:${(served.address() as AddressInfo).port}`;
    const told = await cpctlAt(fullUrl, fullKey.key, ["admin", "rotatekey"]);
    check("cpctl says what to do about it and mints nothing", [told.status, told.out, /retire one first/.test(told.err), signingKeyRows(fdb).length], [1, "", true, MAX_STATEMENT_KEYS]);
    const shownKeys = (await cpctlAt(fullUrl, fullKey.key, ["admin", "signingkeys"])).out.split("\n");
    check(
      "and its listing marks the one key that signs, the oldest",
      [shownKeys.length, shownKeys.filter((line) => line.includes("(signs)")).length, shownKeys.at(-1)?.includes("(signs)")],
      [MAX_STATEMENT_KEYS, 1, true],
    );
    served.close();
    fdb.close();
  }

  // Not the real app on purpose: what a control plane from before statements answers, which no build in this tree does any more.
  process.stdout.write("\ncpctl, against a control plane that predates statements\n");
  {
    const reached: string[] = [];
    const old = createServer((req, res) => {
      reached.push(`${req.method ?? ""} ${req.url ?? ""}`);
      const answer = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/v1/admin/signing-keys") {
        return answer(200, {
          keys: [
            { kid: "k_newest", createdAt: 3, retiredAt: null },
            { kid: "k_older", createdAt: 2, retiredAt: null },
            { kid: "k_retired", createdAt: 1, retiredAt: 2 },
          ],
        });
      }
      if (req.url?.startsWith("/v1/admin/signing-keys") === true) return answer(req.method === "POST" ? 201 : 200, { kid: "k_minted", active: 3, retired: true });
      return answer(404, { error: { code: "not_found", message: "no such route", detail: null } });
    });
    await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", () => resolve()));
    const oldUrl = `http://127.0.0.1:${(old.address() as AddressInfo).port}`;
    const mutated = (): string[] => reached.filter((line) => !line.startsWith("GET "));

    const rotating = await cpctlAt(oldUrl, "rk_any", ["admin", "rotatekey"]);
    check("rotatekey stops and says to update the control plane first", [rotating.status, rotating.out, /Update the control plane first/.test(rotating.err)], [1, "", true]);
    const retiring = await cpctlAt(oldUrl, "rk_any", ["admin", "retirekey", "k_older", "--force"]);
    check("and so does retirekey, forced or not", [retiring.status, retiring.out, /Update the control plane first/.test(retiring.err)], [1, "", true]);
    check("neither sent the request that would have darkened the fleet", [mutated(), reached.includes("GET /v1/admin/root")], [[], true]);
    const listing = (await cpctlAt(oldUrl, "rk_any", ["admin", "signingkeys"])).out.split("\n");
    check(
      "its listing, where no row says which key signs, marks the newest active one: that is the one that does there",
      listing.map((line) => [line.split(" ")[0], line.includes("(signs)")]),
      [["k_newest", true], ["k_older", false], ["k_retired", false]],
    );
    old.close();
  }

  process.stdout.write("\na root kept off the host\n");
  {
    const leaving = liveRoot(rdb);
    const signerNow = tokenSigningKey(rdb);
    const stranger = generateKeyPairSync("ed25519");
    const strangerJwk = publicKeyToJwk(stranger.publicKey);
    const parsed = (text: string): Record<string, unknown> => {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        // A run that printed no JSON is the failure the check beside it reports.
        return {};
      }
    };

    // The root's own key is made, and everything it really signs is signed, by cpctl as an operator runs it.
    const keyFile = join(tmp("reemoat-relaycheck-rootkey-"), "root.pem");
    const made = cpctl(["root", "new", "--out", keyFile, "--json"]);
    const offlineJwk = (parsed(made.out)["jwk"] ?? { kty: "", crv: "", x: "" }) as PublicKeyJwk;
    const offlineKid = keyIdFor(offlineJwk);
    check(
      "cpctl root new writes a key file only its owner reads, and prints the public half under the id the server derives",
      [made.status, parsed(made.out)["kid"], existsSync(keyFile) ? statSync(keyFile).mode & 0o777 : null],
      [0, offlineKid, 0o600],
    );
    const keyBytes = existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "";
    const again = cpctl(["root", "new", "--out", keyFile, "--json"]);
    check(
      "and refuses to write over a key file that exists, leaving it as it was",
      [again.status, again.out, /could not write/.test(again.err), readFileSync(keyFile, "utf8") === keyBytes],
      [1, "", true, true],
    );
    const offlinePrivate = createPrivateKey(keyBytes);
    const rootSign = (draft: unknown, ...flags: string[]): ReturnType<typeof cpctl> => cpctl(["root", "sign", "--key", keyFile, ...flags], JSON.stringify(draft));
    /** Signed here rather than by cpctl: a statement its signer would never make, under the real root's key or somebody else's. */
    const forge = (draft: Record<string, unknown>, key: KeyObject = offlinePrivate, kid = offlineKid): string =>
      signCompact(KEYSET_TYP, { ...draft, iat: Math.floor(Date.now() / 1000) }, kid, key);

    check("a key that is not Ed25519 cannot be the root", outcome(await call("POST", "/v1/admin/root", { jwk: { kty: "oct", k: "x" } })), [400, "bad_request"]);
    check("an ordinary account cannot hand the root over", (await call("POST", "/v1/admin/root", { jwk: offlineJwk }, plainKey.key)).status, 403);
    check("the root already live is not adopted again", outcome(await call("POST", "/v1/admin/root", { jwk: leaving?.jwk })), [409, "root_unchanged"]);

    const adopted = await call("POST", "/v1/admin/root", { jwk: offlineJwk });
    check("a key made elsewhere becomes the root", [adopted.status, liveRoot(rdb)?.kid, liveRoot(rdb)?.online], [201, offlineKid, false]);
    check(
      "the root it replaced keeps no private half here",
      rdb.prepare("SELECT private_pem FROM trust_roots WHERE kid = ?").get(leaving?.kid ?? "")?.["private_pem"],
      null,
    );
    check("and the statement in force is no longer this root's", statementIsCurrent(rdb), false);

    const offered = announcedKeyset(rdb);
    const follows = (held: KeysetHeld): string | null => weighAnnouncement(held, offered).next.root?.kid ?? null;
    const key = (one: { kid: string; jwk: unknown } | null): { kid: string; jwk: unknown }[] => (one === null ? [] : [{ kid: one.kid, jwk: one.jwk }]);
    check(
      "what is announced is the handover, then the new root's endorsement by the key that signs, then the retired key's of the root it knew",
      offered.endorsements.map(signerOf),
      [leaving?.kid, signerNow?.kid, oldest.kid],
    );
    check("a daemon holding the old root follows the handover", follows({ issuer, keys: key(signerNow), root: leaving, keysetVersion: 3 }), offlineKid);
    check("one that never held a root is introduced by the key that signs", follows({ issuer, keys: key(signerNow), root: null, keysetVersion: null }), offlineKid);
    check(
      "one that slept through the rotation, holding no root and only a since-retired key, is still led there by that key",
      follows({ issuer, keys: key(oldest), root: null, keysetVersion: null }),
      offlineKid,
    );
    check("the root it left has its statement withdrawn from the dial, since nobody who follows the handover would take it", [offered.statement, offered.version], [null, null]);
    const followed = weighAnnouncement({ issuer, keys: key(signerNow), root: leaving, keysetVersion: 2 }, offered);
    check("so a daemon takes the new root and keeps the keys it held", [followed.refused, followed.keysChanged, followed.next.keys.length], ["absent", false, 1]);

    const rotated = await call("POST", "/v1/admin/signing-keys");
    const third = String(rotated.body["kid"]);
    check("with the root off the host a new key is published and stated by nobody", [rotated.status, rotated.body["statement"], rotated.body["rootOnline"]], [201, null, false]);
    check("so the key every daemon holds goes on signing", tokenSigningKey(rdb)?.kid, signerNow?.kid);
    check("the new key endorses the root all the same, which needs no private half of the root", announcedKeyset(rdb).endorsements.map(signerOf), [leaving?.kid, signerNow?.kid, third, oldest.kid]);
    check(
      "and retiring it is refused until a statement names the key that would sign next",
      outcome(await call("DELETE", `/v1/admin/signing-keys/${signerNow?.kid ?? ""}`)),
      [409, "statement_stale"],
    );
    check("a refusal that retired nothing", signingKeyRows(rdb).filter((row) => row.retiredAt === null).length, 2);

    const draft = (await call("GET", "/v1/admin/keyset/draft")).body;
    const draftKeys = draft["keys"] as { kid: string; jwk: PublicKeyJwk }[];
    const draftKids = [signerNow?.kid ?? "", third].sort();
    check("the draft is the active keys under the next version", [draft["iss"], draft["v"], draftKeys.map((one) => one.kid).sort()], [issuer, 4, draftKids]);
    check("a statement signed by somebody else is refused", outcome(await call("POST", "/v1/admin/keyset", { statement: forge(draft, stranger.privateKey) })), [400, "bad_statement"]);
    check(
      "and one signed by a key that only claims to be the root",
      outcome(await call("POST", "/v1/admin/keyset", { statement: forge(draft, stranger.privateKey, keyIdFor(strangerJwk)) })),
      [400, "bad_statement"],
    );
    check(
      "one that leaves an active key out is refused: the signer must be in it",
      outcome(await call("POST", "/v1/admin/keyset", { statement: forge({ ...draft, keys: draftKeys.slice(0, 1) }) })),
      [409, "keyset_mismatch"],
    );
    // The active ids over somebody else's key: a kid is a name, and the root would be vouching for bytes nobody here holds.
    const renamed = { ...draft, keys: draftKeys.map((one) => (one.kid === third ? { kid: third, jwk: strangerJwk } : one)) };
    check(
      "one naming the active ids over a different key is refused, though the real root signed it",
      outcome(await call("POST", "/v1/admin/keyset", { statement: forge(renamed) })),
      [409, "keyset_mismatch"],
    );
    const unsigned = rootSign(renamed);
    check("and cpctl would not have signed it: an id that is not its key's is refused on stdin", [unsigned.status, unsigned.out, /nothing was signed/.test(unsigned.err)], [1, "", true]);
    check("one for another issuer is refused", outcome(await call("POST", "/v1/admin/keyset", { statement: forge({ ...draft, iss: "somebody-else" }) })), [400, "bad_statement"]);
    check("one at a version already installed is refused", outcome(await call("POST", "/v1/admin/keyset", { statement: forge({ ...draft, v: 3 }) })), [409, "statement_not_newer"]);
    check("a token is not a statement", outcome(await call("POST", "/v1/admin/keyset", { statement: "a.b.c" })), [400, "bad_statement"]);
    check("none of which installed anything", newestStatement(rdb)?.version, 3);

    const unexpected = rootSign(draft, "--expect", `${signerNow?.kid ?? ""},${oldest.kid}`);
    check("cpctl root sign refuses a draft that does not name exactly the keys it was told to expect", [unexpected.status, unexpected.out, /nothing was signed/.test(unexpected.err)], [1, "", true]);
    const short = rootSign(draft, "--expect", third);
    check("a subset of them included", [short.status, short.out], [1, ""]);
    const signed = rootSign(draft, "--expect", draftKids.join(","));
    check("and signs the one that does, with only the statement on stdout so the pipe still works", [signed.status, /^[\w-]+\.[\w-]+\.[\w-]+$/.test(signed.out)], [0, true]);
    check(
      "having said on stderr what it is vouching for: the issuer, the version and every key",
      [signed.err.includes(issuer), signed.err.includes("statement v4"), draftKids.every((kid) => signed.err.includes(kid))],
      [true, true, true],
    );
    check("an ordinary account cannot install one", (await call("POST", "/v1/admin/keyset", { statement: signed.out }, plainKey.key)).status, 403);

    const installed = await call("POST", "/v1/admin/keyset", { statement: signed.out });
    check("the root's own statement is installed", [installed.status, installed.body["version"], statementIsCurrent(rdb)], [201, 4, true]);
    check("and the same one twice is not", outcome(await call("POST", "/v1/admin/keyset", { statement: signed.out })), [409, "statement_not_newer"]);
    const byThird = weighAnnouncement({ issuer, keys: publicHalf(third), root: null, keysetVersion: null }, announcedKeyset(rdb));
    check(
      "a daemon holding only the key minted under the off-host root is introduced to it and takes that statement",
      [byThird.next.root?.kid, byThird.refused, byThird.next.keysetVersion],
      [offlineKid, null, 4],
    );

    const retired = await call("DELETE", `/v1/admin/signing-keys/${signerNow?.kid ?? ""}`);
    check("now the old key may be retired", [retired.status, retired.body["statementCurrent"], tokenSigningKey(rdb)?.kid], [200, false, third]);
    const next = (await call("GET", "/v1/admin/keyset/draft")).body;
    check("and the next draft drops it", [next["v"], (next["keys"] as { kid: string }[]).map((one) => one.kid)], [5, [third]]);
    check("signed without --expect and installed, it is current again", [(await call("POST", "/v1/admin/keyset", { statement: rootSign(next).out })).status, statementIsCurrent(rdb)], [201, true]);

    const second = generateKeyPairSync("ed25519");
    const secondJwk = publicKeyToJwk(second.publicKey);
    const elsewhere = publicKeyToJwk(generateKeyPairSync("ed25519").publicKey);
    const forgedHandover = signCompact(
      ROOT_TYP,
      { iss: issuer, iat: Math.floor(Date.now() / 1000), root: { kid: keyIdFor(secondJwk), jwk: secondJwk } },
      offlineKid,
      stranger.privateKey,
    );
    const handover = cpctl(["root", "handover", "--key", keyFile, "--issuer", issuer, JSON.stringify(secondJwk)]);
    check("cpctl root handover prints the old root naming its successor", [handover.status, /^[\w-]+\.[\w-]+\.[\w-]+$/.test(handover.out), signerOf(handover.out || "e30.e30.e30")], [0, true, offlineKid]);
    check("from a root that is not here, a handover is its holder's to sign", outcome(await call("POST", "/v1/admin/root", { jwk: secondJwk })), [409, "handover_required"]);
    check("one signed by anybody else is refused", outcome(await call("POST", "/v1/admin/root", { jwk: secondJwk, handover: forgedHandover })), [400, "bad_handover"]);
    check(
      "and so is the holder's own, offered beside a different key than it names",
      outcome(await call("POST", "/v1/admin/root", { jwk: elsewhere, handover: handover.out })),
      [400, "bad_handover"],
    );
    check("none of which moved the root or filed a row for one", [liveRoot(rdb)?.kid, rdb.prepare("SELECT COUNT(*) AS n FROM trust_roots").get()?.["n"]], [offlineKid, 2]);
    check("the holder's own is taken beside the key it names", [(await call("POST", "/v1/admin/root", { jwk: secondJwk, handover: handover.out })).status, liveRoot(rdb)?.kid], [201, keyIdFor(secondJwk)]);
    check("a root that was handed over from cannot come back", outcome(await call("POST", "/v1/admin/root", { jwk: offlineJwk, handover: "a.b.c" })), [409, "root_retired"]);
    check(
      "a daemon two roots behind is still led to the live one",
      weighAnnouncement({ issuer, keys: key(signerNow), root: leaving, keysetVersion: 3 }, announcedKeyset(rdb)).next.root?.kid,
      keyIdFor(secondJwk),
    );
    rdb.close();
  }

  process.stdout.write("\nhandovers along a chain, under the cap\n");
  {
    const cdb = freshDb();
    const first = ensureSigningKey(cdb);
    const origin = ensureTrustRoot(cdb, issuer);
    const added = rotateSigningKey(cdb, issuer);
    const roots = [1, 2, 3, 4, 5].map(() => {
      const made = generateKeyPairSync("ed25519");
      const jwk = publicKeyToJwk(made.publicKey);
      return { kid: keyIdFor(jwk), jwk, privateKey: made.privateKey };
    });
    const [r2, r3, r4, r5, r6] = roots as [(typeof roots)[0], (typeof roots)[0], (typeof roots)[0], (typeof roots)[0], (typeof roots)[0]];
    const handedBy = (from: (typeof roots)[0], to: (typeof roots)[0]): string =>
      signCompact(ROOT_TYP, { iss: issuer, iat: Math.floor(Date.now() / 1000), root: { kid: to.kid, jwk: to.jwk } }, from.kid, from.privateKey);
    const held = (root: { kid: string; jwk: unknown } | null, keys: { kid: string; jwk: unknown }[]): KeysetHeld => ({ issuer, keys, root, keysetVersion: 2 });
    const one = [{ kid: first.kid, jwk: first.jwk }];
    const ledTo = (root: { kid: string; jwk: unknown } | null, keys = one): string | null => weighAnnouncement(held(root, keys), announcedKeyset(cdb)).next.root?.kid ?? null;

    // Two signing keys are active at every adoption, so each root is filed with a handover and two endorsements.
    check("two signing keys are active when the first root is handed over", [added.ok, activePublicKeys(cdb).length], [true, 2]);
    check("the root made here hands over to one kept elsewhere", adoptRoot(cdb, issuer, r2.jwk, null).ok, true);
    check("which hands over to the next", adoptRoot(cdb, issuer, r3.jwk, handedBy(r2, r3)).ok, true);
    check("and that one to a fourth", adoptRoot(cdb, issuer, r4.jwk, handedBy(r3, r4)).ok, true);
    const announced = announcedKeyset(cdb);
    check(
      "the dial carries the three handovers first, newest hop first, then the live root's endorsement by each active key",
      announced.endorsements.map(signerOf),
      [r3.kid, r2.kid, origin.kid, first.kid, added.ok ? added.key.kid : ""],
    );
    check("a daemon three roots behind is led to the live one", ledTo(origin), r4.kid);
    check("and so is one that never held a root", ledTo(null), r4.kid);

    // More active keys than the cap leaves room for: what is cut has to be an introduction, never a hop.
    const later: string[] = [];
    for (let minted = 0; minted < MAX_KEYSET_ENDORSEMENTS; minted += 1) {
      const rotated = rotateSigningKey(cdb, issuer);
      if (rotated.ok) later.push(rotated.key.kid);
    }
    const crowded = announcedKeyset(cdb);
    check("past the cap the announcement is cut to it", [later.length, crowded.endorsements.length], [MAX_KEYSET_ENDORSEMENTS, MAX_KEYSET_ENDORSEMENTS]);
    check("with every handover still in it, and the oldest keys' endorsements in what room is left", crowded.endorsements.map(signerOf).slice(0, 5), [r3.kid, r2.kid, origin.kid, first.kid, added.ok ? added.key.kid : ""]);
    check("so the daemon three roots behind still follows", ledTo(origin), r4.kid);
    check("and one holding only the oldest key is still introduced", ledTo(null), r4.kid);

    check("two more handovers", [adoptRoot(cdb, issuer, r5.jwk, handedBy(r4, r5)).ok, adoptRoot(cdb, issuer, r6.jwk, handedBy(r5, r6)).ok], [true, true]);
    report("the depth announced is the depth a daemon follows", announcedKeyset(cdb).endorsements.map(signerOf).slice(0, MAX_ROOT_HANDOVERS).join() === [r5.kid, r4.kid, r3.kid, r2.kid].join(), `${MAX_ROOT_HANDOVERS} hops`);
    check("a daemon that many roots behind is led all the way", ledTo(r2), r6.kid);
    check("and one a root further back is left where it was, to be re-enrolled", ledTo(origin), origin.kid);
    cdb.close();
  }

  process.stdout.write("\na rotation, taken off the tunnel\n");
  {
    const kdb = freshDb();
    const k1 = ensureSigningKey(kdb);
    const root = ensureTrustRoot(kdb, issuer);
    const machineId = "m_rotating";
    const silentId = "m_silent";
    for (const id of [machineId, silentId]) {
      kdb.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(id, id, Date.now(), Date.now());
    }
    const tunnelKey = issueTunnelKey(kdb, machineId);
    const tunnels = new TunnelRegistry();
    const listener = createRelayListener({ db: kdb, issuer, host: "127.0.0.1", port: 0, registry: tunnels, tunnelPingMs: 30 });
    await new Promise<void>((resolve) => listener.server.once("listening", () => resolve()));
    const relayUrl = `http://127.0.0.1:${(listener.server.address() as AddressInfo).port}`;

    // The retire route beside a registry that knows who is dialled in, which is the only place `behind` is more than zero.
    const opsKey = newApiKey();
    kdb.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES ('u_ka', 'keysadmin', 1, ?)").run(Date.now());
    kdb.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, 'u_ka', ?, ?, ?)").run(newId("ak"), opsKey.prefix, opsKey.hash, Date.now());
    const ops = createControlPlaneApp({ db: kdb, issuer, tokenTtlSeconds: 300, relayUrl, relay: tunnels });
    const retire = async (kid: string, query = ""): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await ops.request(`/v1/admin/signing-keys/${kid}${query}`, { method: "DELETE", headers: as(opsKey.key) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const opsServer = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const started = serve({ fetch: ops.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    });
    const opsUrl = `http://127.0.0.1:${(opsServer.address() as AddressInfo).port}`;
    const rotate = (): { kid: string; privateKey: KeyObject } => {
      const answer = rotateSigningKey(kdb, issuer);
      if (!answer.ok) throw new Error(`the rotation was refused: ${answer.reason}`);
      return answer.key;
    };

    // The daemon's half as scripts/daemon.ts wires it: enrolled before there was a root, its identity in a real file.
    const identityPath = join(tmp("reemoat-relaycheck-identity-"), "reemoat.db");
    const stores = openStores({ path: identityPath, instanceId: "i_keys_first" });
    const enrolled: StoredIdentity = {
      machineId,
      issuer,
      keys: [{ kid: k1.kid, jwk: k1.jwk }],
      controlPlane: "https://cp.example",
      codeFp: "relaycheck",
      enrolledAt: Date.now(),
      tunnelKey,
      relayUrl,
      root: null,
      keysetVersion: null,
    };
    stores.identity.save(enrolled);
    const verifier = new SignedTokenVerifier({ identity: enrolled });
    const refusals: string[] = [];
    const saveFailures: string[] = [];
    let diskFull = false;
    const taker = createKeysetTaker<StoredIdentity>({
      held: enrolled,
      store: {
        save(next) {
          if (diskFull) throw new Error("database or disk is full");
          stores.identity.save(next);
        },
      },
      verifier,
      onRefused: (reason) => refusals.push(reason),
      onSaveFailed: (error) => saveFailures.push(error instanceof Error ? error.message : String(error)),
    });
    const held = (): StoredIdentity => taker.held();
    const RETRY_MS = 300;
    let dials = 0;
    const tunnel = RelayTunnel.start({
      relayUrl,
      tunnelKey,
      local: { host: "127.0.0.1", port: 9 },
      random: () => 0,
      keysetVersion: taker.keysetVersion,
      onKeyset: taker.onKeyset,
      keysetRetryMs: RETRY_MS,
      onEvent: (kind) => {
        if (kind === "connected") dials += 1;
      },
    });
    const announcedBy = (id: string): unknown => kdb.prepare("SELECT daemon_keyset FROM machines WHERE id = ?").get(id)?.["daemon_keyset"];
    const seconds = Math.floor(Date.now() / 1000);
    const signedBy = (key: { kid: string; privateKey: KeyObject }): string =>
      signToken({ iss: issuer, sub: "u_r", aud: machineId, jti: newId("t"), iat: seconds, nbf: seconds, exp: seconds + 300, scp: ["session:read"] }, key.kid, key.privateKey);
    const verdict = (token: string): string => {
      const result = verifier.verify(token);
      return result.ok ? "accepted" : result.code;
    };

    check("the first dial introduces the root and hands over the statement", [await until(() => held().keysetVersion === 1), held().root?.kid], [true, root.kid]);
    check("having announced that it held none", announcedBy(machineId), 0);

    const second = rotate();
    check("before it is told, the daemon does not know the new key", verdict(signedBy(second)), "unknown_key");
    check("a ping naming a newer statement makes it redial and take it", [await until(() => held().keysetVersion === 2), held().keys.length], [true, 2]);
    check("with no visit, both keys verify", [verdict(signedBy(second)), verdict(signedBy(k1))], ["accepted", "accepted"]);
    check("and the redial announced what it held going in", announcedBy(machineId), 1);

    // A second daemon, dialled in and too old to say what it holds: the one machine a retire would darken.
    const silent = RelayTunnel.start({ relayUrl, tunnelKey: issueTunnelKey(kdb, silentId), local: { host: "127.0.0.1", port: 9 }, random: () => 0 });
    check("a daemon that announces no key set dials in beside it", [await until(() => tunnels.isOnline(silentId)), announcedBy(silentId)], [true, null]);
    const refusedRetire = await retire(k1.kid);
    check(
      "retiring is refused while a dialled-in machine has not been offered the statement, with how many",
      [...outcome(refusedRetire), (refusedRetire.body["error"] as { detail?: unknown } | undefined)?.detail],
      [409, "machines_behind", { behind: 1 }],
    );
    check("a refusal that retired nothing and stated nothing", [tokenSigningKey(kdb)?.kid, newestStatement(kdb)?.version], [k1.kid, 2]);
    check("a key that is not active is still a 404 first, whoever is behind", outcome(await retire("k_nobody")), [404, "key_not_found"]);
    check("a force spelled any other way is not one", outcome(await retire(k1.kid, "?force=true")), [409, "machines_behind"]);
    const stopped = await cpctlAt(opsUrl, opsKey.key, ["admin", "retirekey", k1.kid]);
    check(
      "cpctl stops there, names the machine as the fleet report does, and says what --force is for",
      [stopped.status, stopped.out, /1 machine\(s\)/.test(stopped.err), /m_silent\s+\S+\s+announces none/.test(stopped.err), stopped.err.includes(machineId), /--force.*leaked key/s.test(stopped.err)],
      [1, "", true, true, false, true],
    );
    check("having retired nothing", tokenSigningKey(kdb)?.kid, k1.kid);
    const forced = await cpctlAt(opsUrl, opsKey.key, ["admin", "retirekey", k1.kid, "--force", "--json"]);
    const forcedBody = forced.status === 0 ? (JSON.parse(forced.out) as Record<string, unknown>) : {};
    check(
      "with --force it is retired through the same route, and the answer still says how many were behind",
      [forced.status, forcedBody["retired"], forcedBody["behind"], forcedBody["statement"]],
      [0, true, 1, { version: 3 }],
    );
    await silent.stop();
    check("the daemon that was offered every statement takes this one the same way", await until(() => held().keysetVersion === 3), true);
    check("and the retired key stops verifying while the new one goes on", [verdict(signedBy(k1)), verdict(signedBy(second))], ["unknown_key", "accepted"]);

    // The identity file refuses the write. Nothing is taken, it is said once, and the redial for it comes after a wait, not per ping.
    diskFull = true;
    const failingFrom = dials;
    const third = rotate();
    check(
      "a key set that cannot be stored is not taken: the verifier and the version stay where the file is",
      [await until(() => dials === failingFrom + 1 && saveFailures.length === 1), held().keysetVersion, verdict(signedBy(third)), verdict(signedBy(second))],
      [true, 3, "unknown_key", "accepted"],
    );
    await sleep(RETRY_MS / 2);
    check("it is not redialled for at every ping, which would cut every stream each time", dials, failingFrom + 1);
    check(
      "the next try comes after the wait, fails the same way and is not reported twice",
      [await until(() => dials === failingFrom + 2), saveFailures, held().keysetVersion],
      [true, ["database or disk is full"], 3],
    );
    diskFull = false;
    check(
      "and once the file takes the write, the daemon takes the key set",
      [await until(() => held().keysetVersion === 4), dials, verdict(signedBy(third))],
      [true, failingFrom + 3, "accepted"],
    );

    // A statement the daemon will never take: it redials for it once, refuses it, and must not dial for it again.
    const bogusRoot = generateKeyPairSync("ed25519");
    const bogus = signCompact(
      KEYSET_TYP,
      { iss: issuer, v: 99, iat: seconds, keys: activePublicKeys(kdb) },
      keyIdFor(publicKeyToJwk(bogusRoot.publicKey)),
      bogusRoot.privateKey,
    );
    const before = dials;
    // Filed under the live root so the relay announces it; what it says about itself is another root's.
    kdb.prepare("INSERT INTO key_statements (version, root_kid, statement, created_at) VALUES (99, ?, ?, ?)").run(root.kid, bogus, Date.now());
    check("a statement signed by another root is chased once", await until(() => dials === before + 1 && refusals.includes("wrong_root")), true);
    await sleep(RETRY_MS + 200);
    check("and never again, however often the ping names it: a refusal is not a failure to store", dials, before + 1);
    check("it moved neither the version nor the keys", [held().keysetVersion, held().keys.map((key) => key.kid).sort()], [4, [second.kid, third.kid].sort()]);
    check("and the daemon is still dialled in, verifying as before", [tunnels.isOnline(machineId), verdict(signedBy(second))], [true, "accepted"]);

    await tunnel.stop();
    const took = held();
    stores.close();
    const restarted = openStores({ path: identityPath, instanceId: "i_keys_second" });
    check("after a restart the file holds the key set that was taken, with its root and its version", restarted.identity.load(), took);
    check("which is not what it enrolled with", [took.keysetVersion, took.root?.kid, took.keys.some((key) => key.kid === k1.kid)], [4, root.kid, false]);
    restarted.close();
    opsServer.close();
    listener.close();
    kdb.close();
  }
}
