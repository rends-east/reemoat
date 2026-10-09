import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { SignedTokenVerifier } from "../src/auth.js";
import { parseEnrollResponse } from "../src/enroll.js";
import { weighAnnouncement, type KeysetHeld } from "../src/keyset.js";
import { RelayTunnel } from "../src/relay/tunnel.js";
import { KEYSET_TYP, ROOT_TYP, publicKeyToJwk, signCompact, signToken, type TokenClaims } from "../src/token.js";
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
import { applyControlPlaneSchema } from "../packages/control-plane/src/store.js";
import {
  announcedKeyset,
  ensureTrustRoot,
  liveRoot,
  machinesBehind,
  newestStatement,
  retireKey,
  rotateSigningKey,
  statementIsCurrent,
} from "../packages/control-plane/src/trustroot.js";

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

    const offered = announcedKeyset(rdb);
    check("the relay is handed the newest statement", [offered.version, offered.statement === newestStatement(rdb)?.statement], [2, true]);
    check("and one endorsement, by the key that was active when the root was made", offered.endorsements.length, 1);
    const introduced = weighAnnouncement({ issuer, keys: [{ kid: oldest.kid, jwk: oldest.jwk }], root: null, keysetVersion: null }, offered);
    check("which is what introduces the root to a daemon enrolled before there was one", [introduced.next.root?.kid, introduced.refused, introduced.next.keysetVersion], [shown.root.kid, null, 2]);

    const retired = await call("DELETE", `/v1/admin/signing-keys/${oldest.kid}`);
    check("retiring the old key is the switch", [retired.status, retired.body["statement"], retired.body["statementCurrent"], retired.body["behind"]], [200, { version: 3 }, true, 0]);
    check("the newer key signs from here", signer(), newer);
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

  process.stdout.write("\na root kept off the host\n");
  {
    const leaving = liveRoot(rdb);
    const signerNow = tokenSigningKey(rdb);
    const offline = generateKeyPairSync("ed25519");
    const offlineJwk = publicKeyToJwk(offline.publicKey);
    const offlineKid = keyIdFor(offlineJwk);
    const stranger = generateKeyPairSync("ed25519");
    const sign = (draft: Record<string, unknown>, key = offline.privateKey, kid = offlineKid): string =>
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
    const follows = (held: KeysetHeld): string | undefined => weighAnnouncement(held, offered).next.root?.kid;
    const key = (one: { kid: string; jwk: unknown } | null): { kid: string; jwk: unknown }[] => (one === null ? [] : [{ kid: one.kid, jwk: one.jwk }]);
    check("a daemon holding the old root follows the handover", follows({ issuer, keys: key(signerNow), root: leaving, keysetVersion: 3 }), offlineKid);
    check("one that never held a root is introduced by the key that signs", follows({ issuer, keys: key(signerNow), root: null, keysetVersion: null }), offlineKid);
    check(
      "and one holding only a since-retired key gets there through the root that key endorsed",
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
    check(
      "and retiring it is refused until a statement names the key that would sign next",
      outcome(await call("DELETE", `/v1/admin/signing-keys/${signerNow?.kid ?? ""}`)),
      [409, "statement_stale"],
    );
    check("a refusal that retired nothing", signingKeyRows(rdb).filter((row) => row.retiredAt === null).length, 2);

    const draft = (await call("GET", "/v1/admin/keyset/draft")).body;
    check("the draft is the active keys under the next version", [draft["iss"], draft["v"], (draft["keys"] as { kid: string }[]).map((one) => one.kid).sort()], [issuer, 4, [signerNow?.kid, third].sort()]);
    check("a statement signed by somebody else is refused", outcome(await call("POST", "/v1/admin/keyset", { statement: sign(draft, stranger.privateKey) })), [400, "bad_statement"]);
    check(
      "and one signed by a key that only claims to be the root",
      outcome(await call("POST", "/v1/admin/keyset", { statement: sign(draft, stranger.privateKey, keyIdFor(publicKeyToJwk(stranger.publicKey))) })),
      [400, "bad_statement"],
    );
    check(
      "one that leaves an active key out is refused: the signer must be in it",
      outcome(await call("POST", "/v1/admin/keyset", { statement: sign({ ...draft, keys: (draft["keys"] as unknown[]).slice(0, 1) }) })),
      [409, "keyset_mismatch"],
    );
    check("one for another issuer is refused", outcome(await call("POST", "/v1/admin/keyset", { statement: sign({ ...draft, iss: "somebody-else" }) })), [400, "bad_statement"]);
    check("one at a version already installed is refused", outcome(await call("POST", "/v1/admin/keyset", { statement: sign({ ...draft, v: 3 }) })), [409, "statement_not_newer"]);
    check("a token is not a statement", outcome(await call("POST", "/v1/admin/keyset", { statement: "a.b.c" })), [400, "bad_statement"]);
    check("none of which installed anything", newestStatement(rdb)?.version, 3);
    check("an ordinary account cannot install one", (await call("POST", "/v1/admin/keyset", { statement: sign(draft) }, plainKey.key)).status, 403);

    const installed = await call("POST", "/v1/admin/keyset", { statement: sign(draft) });
    check("the root's own statement is installed", [installed.status, installed.body["version"], statementIsCurrent(rdb)], [201, 4, true]);
    check("and the same one twice is not", outcome(await call("POST", "/v1/admin/keyset", { statement: sign(draft) })), [409, "statement_not_newer"]);

    const retired = await call("DELETE", `/v1/admin/signing-keys/${signerNow?.kid ?? ""}`);
    check("now the old key may be retired", [retired.status, retired.body["statementCurrent"], tokenSigningKey(rdb)?.kid], [200, false, third]);
    const next = (await call("GET", "/v1/admin/keyset/draft")).body;
    check("and the next draft drops it", [next["v"], (next["keys"] as { kid: string }[]).map((one) => one.kid)], [5, [third]]);
    check("installed, it is current again", [(await call("POST", "/v1/admin/keyset", { statement: sign(next) })).status, statementIsCurrent(rdb)], [201, true]);

    const second = generateKeyPairSync("ed25519");
    const secondJwk = publicKeyToJwk(second.publicKey);
    const handover = (by = offline.privateKey, kid = offlineKid): string =>
      signCompact(ROOT_TYP, { iss: issuer, iat: Math.floor(Date.now() / 1000), root: { kid: keyIdFor(secondJwk), jwk: secondJwk } }, kid, by);
    check("from a root that is not here, a handover is its holder's to sign", outcome(await call("POST", "/v1/admin/root", { jwk: secondJwk })), [409, "handover_required"]);
    check("one signed by anybody else is refused", outcome(await call("POST", "/v1/admin/root", { jwk: secondJwk, handover: handover(stranger.privateKey) })), [400, "bad_handover"]);
    check("neither moved the root", liveRoot(rdb)?.kid, offlineKid);
    check("the holder's own is taken", [(await call("POST", "/v1/admin/root", { jwk: secondJwk, handover: handover() })).status, liveRoot(rdb)?.kid], [201, keyIdFor(secondJwk)]);
    check("a root that was handed over from cannot come back", outcome(await call("POST", "/v1/admin/root", { jwk: offlineJwk, handover: "a.b.c" })), [409, "root_retired"]);
    check(
      "a daemon two roots behind is still led to the live one",
      weighAnnouncement({ issuer, keys: key(signerNow), root: leaving, keysetVersion: 3 }, announcedKeyset(rdb)).next.root?.kid,
      keyIdFor(secondJwk),
    );
    rdb.close();
  }

  process.stdout.write("\na rotation, taken off the tunnel\n");
  {
    const kdb = freshDb();
    const k1 = ensureSigningKey(kdb);
    const root = ensureTrustRoot(kdb, issuer);
    const machineId = "m_rotating";
    kdb.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(machineId, machineId, Date.now(), Date.now());
    const tunnelKey = issueTunnelKey(kdb, machineId);
    const tunnels = new TunnelRegistry();
    const listener = createRelayListener({ db: kdb, issuer, host: "127.0.0.1", port: 0, registry: tunnels, tunnelPingMs: 30 });
    await new Promise<void>((resolve) => listener.server.once("listening", () => resolve()));
    const relayUrl = `http://127.0.0.1:${(listener.server.address() as AddressInfo).port}`;

    // A daemon enrolled before there was a root: one signing key, nothing else.
    let held: KeysetHeld = { issuer, keys: [{ kid: k1.kid, jwk: k1.jwk }], root: null, keysetVersion: null };
    const verifier = new SignedTokenVerifier({ identity: { machineId, issuer, keys: [...held.keys] } });
    const refusals: string[] = [];
    let dials = 0;
    const tunnel = RelayTunnel.start({
      relayUrl,
      tunnelKey,
      local: { host: "127.0.0.1", port: 9 },
      random: () => 0,
      keysetVersion: () => held.keysetVersion,
      onKeyset: (announced) => {
        const weighed = weighAnnouncement(held, announced);
        if (weighed.refused !== null) refusals.push(weighed.refused);
        if (weighed.next === held) return;
        held = weighed.next;
        if (weighed.keysChanged) verifier.replaceKeys(held.keys);
      },
      onEvent: (kind) => {
        if (kind === "connected") dials += 1;
      },
    });
    const announcedByDaemon = (): unknown => kdb.prepare("SELECT daemon_keyset FROM machines WHERE id = ?").get(machineId)?.["daemon_keyset"];
    const seconds = Math.floor(Date.now() / 1000);
    const signedBy = (key: { kid: string; privateKey: typeof k1.privateKey }): string =>
      signToken({ iss: issuer, sub: "u_r", aud: machineId, jti: newId("t"), iat: seconds, nbf: seconds, exp: seconds + 300, scp: ["session:read"] }, key.kid, key.privateKey);
    const verdict = (token: string): string => {
      const result = verifier.verify(token);
      return result.ok ? "accepted" : result.code;
    };

    check("the first dial introduces the root and hands over the statement", [await until(() => held.keysetVersion === 1), held.root?.kid], [true, root.kid]);
    check("having announced that it held none", announcedByDaemon(), 0);

    const rotated = rotateSigningKey(kdb, issuer);
    check("before it is told, the daemon does not know the new key", verdict(signedBy(rotated.key)), "unknown_key");
    check("a ping naming a newer statement makes it redial and take it", [await until(() => held.keysetVersion === 2), held.keys.length], [true, 2]);
    check("with no visit, both keys verify", [verdict(signedBy(rotated.key)), verdict(signedBy(k1))], ["accepted", "accepted"]);
    check("and the redial announced what it held going in", announcedByDaemon(), 1);

    const retired = retireKey(kdb, issuer, k1.kid);
    check("retiring the old key issues the next statement", [retired.ok, newestStatement(kdb)?.version], [true, 3]);
    check("which the daemon takes the same way", await until(() => held.keysetVersion === 3), true);
    check("and the retired key stops verifying while the new one goes on", [verdict(signedBy(k1)), verdict(signedBy(rotated.key))], ["unknown_key", "accepted"]);

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
    await sleep(400);
    check("and never again, however often the ping names it", dials, before + 1);
    check("it moved neither the version nor the keys", [held.keysetVersion, held.keys.map((key) => key.kid)], [3, [rotated.key.kid]]);
    check("and the daemon is still dialled in, verifying as before", [tunnels.isOnline(machineId), verdict(signedBy(rotated.key))], [true, "accepted"]);

    await tunnel.stop();
    listener.close();
    kdb.close();
  }
}
