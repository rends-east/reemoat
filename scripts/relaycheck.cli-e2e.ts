import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer as createTcpServer, connect, type AddressInfo, type Server as TcpServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { ChannelExchange, approvalCode, generateStaticKey, keyFingerprint, localStaticKey, type ChannelOutcome } from "@reemoat/protocol";
import { DeviceNotApproved, MachineKeyChanged, ReemoatError, reemoat, type ReemoatClient } from "../packages/cli/src/index.js";
import { RELAY_CHANNEL_PATH as CLIENT_CHANNEL_PATH, RELAY_URL_HEADER as CLIENT_RELAY_URL_HEADER, channelRequest } from "../packages/cli/src/channel.js";
import { CompositeVerifier, SharedSecretVerifier, SignedTokenVerifier } from "../src/auth.js";
import { DeviceGate } from "../src/devices.js";
import { MemoryEventStore } from "../src/events.js";
import { SessionRegistry } from "../src/registry.js";
import { RELAY_URL_HEADER } from "../src/relay/protocol.js";
import { RelayTunnel } from "../src/relay/tunnel.js";
import { createApp } from "../src/server.js";
import { SqliteKnownDeviceStore } from "../src/store/sqlite.js";
import { TaskDesk } from "../src/tasks/desk.js";
import { MemoryBoardConfigStore, MemoryTaskStore } from "../src/tasks/store.js";
import { jwkThumbprint, x25519Jwk } from "../src/token.js";
import { activeSigningKeys, issueTunnelKey, newApiKey, newId } from "../packages/control-plane/src/keys.js";
import { setMachineKey } from "../packages/control-plane/src/machinekeys.js";
import { createControlPlaneApp } from "../packages/control-plane/src/app.js";
import { RELAY_CHANNEL_PATH } from "../packages/control-plane/src/relay/listener.js";
import type { PeerEndToEnd } from "./relaycheck.peer-e2e.js";
import { stubAgents } from "./relaycheck.peer-e2e.js";
import { tmp } from "./tmp.js";

const TSX = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
const BIN = new URL("../packages/cli/src/bin.ts", import.meta.url).pathname;

/** The external client against a daemon of the shipped shape, the shipped relay and a served Authority: a script with an API key, from anywhere (Q1.661). */
export async function cliEndToEnd(ctx: PeerEndToEnd & { relayPort: number }): Promise<void> {
  const { db, issuer, relayUrl, check } = ctx;
  process.stdout.write("\na script with an API key, through the relay (pnpm reemoat)\n");
  check("the client dials the path the relay listens on", CLIENT_CHANNEL_PATH, RELAY_CHANNEL_PATH);
  check("and reads a 421 off the header the relay names", CLIENT_RELAY_URL_HEADER, RELAY_URL_HEADER);

  const now = Date.now();
  const ownerId = newId("u");
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)").run(ownerId, "cli-owner", now);
  const keyRow = (): { key: string; id: string } => {
    const minted = newApiKey();
    const id = newId("ak");
    db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, ownerId, minted.prefix, minted.hash, Date.now());
    return { key: minted.key, id };
  };

  // Everything the script sends the relay is recorded here, so what it carried can be asserted unreadable.
  const carried: Buffer[] = [];
  const tap: TcpServer = createTcpServer((client) => {
    const upstream = connect(ctx.relayPort, "127.0.0.1");
    client.on("data", (chunk: Buffer) => {
      carried.push(chunk);
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      carried.push(chunk);
      client.write(chunk);
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    // Either end going away is how a channel ends here; the other is closed above.
    client.on("error", () => {});
    upstream.on("error", () => {});
  });
  await new Promise<void>((resolve) => tap.listen(0, "127.0.0.1", resolve));
  const tapUrl = `http://127.0.0.1:${(tap.address() as AddressInfo).port}`;

  const cp = createControlPlaneApp({ db, issuer, tokenTtlSeconds: 300, relayUrl: tapUrl, relay: ctx.registry });
  const cpServer = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch: cp.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
  });
  const server = `http://127.0.0.1:${(cpServer.address() as AddressInfo).port}`;

  // One machine: a task desk, the machine's own device list, and REEMOAT_AUTH=both's verifier.
  const machineId = newId("m");
  let machineStatic = generateStaticKey();
  const machinePublic = (): string => Buffer.from(machineStatic.publicKey).toString("base64url");
  db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(machineId, `ci-${machineId}`, now, now);
  db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(machineId, ownerId, "ci", now);
  db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(ownerId, machineId, "session:read session:write machine:admin", now);
  setMachineKey(db, machineId, machinePublic());

  const { stubs, StubRuntime } = await stubAgents("s_cli");
  const registry = new SessionRegistry(
    new MemoryEventStore(),
    null,
    { worktreeRoot: tmp("cli-wt-"), branchPrefix: "reemoat", defaultMode: "auto" },
    new StubRuntime(),
    null,
  );
  const desk = new TaskDesk({ registry, store: new MemoryTaskStore(), configs: new MemoryBoardConfigStore(), tickMs: 0 });
  const knownDb = new DatabaseSync(":memory:");
  knownDb.exec(readFileSync(new URL("../src/store/schema.sql", import.meta.url), "utf8"));
  const gate = new DeviceGate(new SqliteKnownDeviceStore(knownDb), machinePublic);
  const keys = activeSigningKeys(db).map((one) => ({ kid: one.kid, jwk: one.jwk }));
  const verifier = new CompositeVerifier(new SignedTokenVerifier({ identity: { machineId, issuer, keys } }), new SharedSecretVerifier("hunter2"));
  const { app } = createApp({ registry, verifier, instanceId: "i_cli", startedAt: now, roots: ["/"], peers: null, tasks: desk, devices: gate });
  const daemon = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
  });
  const tunnelKey = issueTunnelKey(db, machineId);
  const dial = (): RelayTunnel =>
    RelayTunnel.start({
      relayUrl,
      tunnelKey,
      local: { host: "127.0.0.1", port: (daemon.address() as AddressInfo).port },
      staticKey: localStaticKey(machineStatic.secretKey),
      machineKey: machinePublic(),
      verifier,
      devices: gate,
    });
  let tunnel = dial();
  check("the machine dials in", await ctx.waitForTunnel(machineId), true);

  const folder = tmp("cli-task-");
  const owner = keyRow();
  const home = tmp("cli-home-");
  const failure = async (call: () => Promise<unknown>): Promise<unknown> => {
    try {
      await call();
      return "(answered)";
    } catch (error) {
      return error;
    }
  };
  const codeOf = async (call: () => Promise<unknown>): Promise<string> => {
    const caught = await failure(call);
    return caught instanceof ReemoatError ? `${caught.where} ${caught.code}` : String(caught);
  };

  const r: ReemoatClient = await reemoat({ server, apiKey: owner.key, home, deviceName: "relaycheck script" });
  const listed = await r.machines();
  check("the key lists the machine it reaches, with the key it announced", listed.map((row) => [row.id, row.key]), [[machineId, machinePublic()]]);

  const brief = `the brief nobody between may read ${randomBytes(12).toString("hex")}`;
  const made = await r.tasks.create(machineId, { brief, cwd: folder, agent: "kimi", key: "ci-1", worktree: "never" });
  check("a task is made on a machine elsewhere", [made.existing, made.task.key, made.task.status], [false, "ci-1", "ready"]);
  const deviceFile = join(home, `127.0.0.1_${new URL(server).port}`, ownerId, "device.json");
  check("its device key was made on first use, readable by its owner alone", [statSync(deviceFile).mode & 0o777, statSync(join(deviceFile, "..")).mode & 0o777], [0o600, 0o700]);
  const devicePublic = (JSON.parse(readFileSync(deviceFile, "utf8")) as { publicKey: string }).publicKey;
  check("and bound to the API key it came with", db.prepare("SELECT public_key FROM api_keys WHERE id = ?").get(owner.id)?.["public_key"], devicePublic);
  const minted = (await (await fetch(`${server}/v1/tokens`, { method: "POST", headers: { authorization: `Bearer ${owner.key}`, "content-type": "application/json" }, body: JSON.stringify({ machine: machineId }) })).json()) as { token: string };
  const claims = JSON.parse(Buffer.from(minted.token.split(".")[1] ?? "", "base64url").toString("utf8")) as { cnf?: { jkt: string }; dev?: string };
  check(
    "so a token minted for it names that key, and the key's own id",
    [claims.cnf?.jkt, claims.dev],
    [jwkThumbprint(x25519Jwk(new Uint8Array(Buffer.from(devicePublic, "base64url")))), owner.id],
  );

  const repeated = await r.tasks.create(machineId, { brief, cwd: folder, agent: "kimi", key: "ci-1", worktree: "never" });
  check("the same key again answers the task it made", [repeated.existing, repeated.task.id], [true, made.task.id]);
  check("and the machine holds one", (await r.tasks.list(machineId)).filter((one) => one.key === "ci-1").length, 1);
  const wire = Buffer.concat(carried);
  check("the relay carried the requests", wire.length > 1_000, true);
  check("and could read none of the brief", wire.includes(Buffer.from(brief)), false);

  const started = await r.tasks.create(machineId, { brief: `start this: ${brief}`, cwd: folder, agent: "kimi", key: "ci-2", start: true, worktree: "never" });
  check("a task made with start starts its agent", started.session !== null, true);
  const sent = [...stubs.values()].flatMap((stub) => stub.prompts);
  check("whose first message is the brief", sent.some((prompt) => prompt.includes(`start this: ${brief}`)), true);
  for (const stub of stubs.values()) stub.finish();

  // Each brief is random, so the answer stays past a MiB on the wire as well as unpacked.
  for (let at = 0; at < 100; at++) {
    desk.create({ title: `bulk ${at}`, brief: randomBytes(12_000).toString("base64url"), agent: "kimi", customAgent: null, assignee: "nobody", status: "ready", column: null, cwd: folder, key: `bulk-${at}`, labels: [] });
  }
  check("a listing past a MiB arrives whole", (await r.tasks.list(machineId)).length, 102);

  const board = await r.board.get(machineId);
  const changed = await r.board.put(machineId, `${board.text.replace(/\n$/, "")}\n# written by a script\n`, { revision: board.revision });
  check("the board is written over the revision it was read at", [changed.changed, changed.revision], [true, board.revision + 1]);
  check("and one written over an older revision is refused", await codeOf(() => r.board.put(machineId, board.text, { revision: board.revision })), "machine board_revision");

  // The command itself, as a script runs it: asynchronously, since the Authority, the relay and the daemon are this process.
  const asOwner = { REEMOAT_API_KEY: owner.key, REEMOAT_CLIENT_HOME: home };
  const run = (args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) =>
      execFile(
        TSX,
        [BIN, ...args],
        { env: { ...process.env, REEMOAT_SERVER: server, REEMOAT_MACHINE: machineId, REEMOAT_URL: "", REEMOAT_TOKEN: "", REEMOAT_DEVICE_KEY: "", ...env }, timeout: 60_000 },
        (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : -1, stdout, stderr }),
      ),
    );
  const added = await run(["task", "add", "--cwd", folder, "--agent", "kimi", "--brief", "from the command line", "--key", "cli-1", "--worktree", "never", "--json"], asOwner);
  check(
    "pnpm reemoat task add makes it, and says so as JSON",
    [added.code, added.code === 0 ? (JSON.parse(added.stdout) as { task: { key: string } }).task.key : added.stderr],
    [0, "cli-1"],
  );
  const again = await run(["task", "add", "--cwd", folder, "--agent", "kimi", "--brief", "from the command line", "--key", "cli-1"], asOwner);
  check("and again under the same key, it says the task is already there", [again.code, again.stderr.includes("already there")], [0, true]);
  const missing = await run(["task", "get", "t_none"], asOwner);
  check("a refusal exits 1 with the machine's sentence", [missing.code, missing.stderr.includes("no task t_none")], [1, true]);
  check("and a command short of what it needs exits 2", (await run(["task", "add", "--cwd", folder], asOwner)).code, 2);

  const waited = desk.create({ title: "wait for me", brief: "w", agent: "kimi", customAgent: null, assignee: "nobody", status: "ready", column: null, cwd: folder, key: "wait-1", labels: [] });
  const waitedId = waited === "full" ? "" : waited.task.id;
  setTimeout(() => desk.move(waitedId, { to: "review" }), 2_500).unref();
  const reached = await r.tasks.wait(machineId, waitedId, { until: ["review"], intervalMs: 2_000, timeoutMs: 20_000 });
  check("waiting for a status answers once the task reaches it", reached.task.status, "review");
  check("and a wait that runs out says so", await codeOf(() => r.tasks.wait(machineId, waitedId, { until: ["done"], intervalMs: 2_000, timeoutMs: 1_000 })), "client wait_timeout");

  process.stdout.write("  the machine's own list of devices, locked\n");
  gate.setLocked(true);
  check("a device that reached the machine before the lock is let in still", (await r.tasks.list(machineId)).length > 0, true);
  const second = keyRow();
  const secondClient = await reemoat({ server, apiKey: second.key, home: tmp("cli-home-two-"), deviceName: "second script" });
  const waiting = await failure(() => secondClient.tasks.list(machineId));
  const pending = gate.list().find((row) => row.state === "pending");
  check("a new one is refused until somebody lets it in", waiting instanceof DeviceNotApproved, true);
  check(
    "named as it named itself, by the key it came with, and with the code the machine shows",
    [pending?.label, pending?.ref, waiting instanceof DeviceNotApproved ? waiting.approvalCode : null],
    ["second script", second.id, pending?.code],
  );
  check(
    "which is the code of its own key",
    pending?.code,
    approvalCode(new Uint8Array(Buffer.from((await secondClient.client.deviceKey()).publicKey, "base64url"))),
  );
  check("nothing was made by the refused call", (await r.tasks.list(machineId)).length, 104);
  gate.approve(pending?.id ?? "");
  check("and let in, it is answered", (await secondClient.tasks.list(machineId)).length, 104);
  const third = keyRow();
  const held = await run(["task", "list"], { REEMOAT_API_KEY: third.key, REEMOAT_CLIENT_HOME: tmp("cli-home-four-"), REEMOAT_DEVICE_NAME: "third script" });
  const heldRow = gate.list().find((row) => row.state === "pending" && row.label === "third script");
  check("the command waiting to be let in exits 3 and prints the machine's code", [held.code, heldRow !== undefined && held.stderr.includes(heldRow.code ?? "?")], [3, true]);
  gate.setLocked(false);

  process.stdout.write("  channels the daemon refuses\n");
  const unbound = keyRow();
  const unboundToken = ((await (await fetch(`${server}/v1/tokens`, { method: "POST", headers: { authorization: `Bearer ${unbound.key}`, "content-type": "application/json" }, body: JSON.stringify({ machine: machineId }) })).json()) as { token: string }).token;
  const stranger = generateStaticKey();
  const refusedUnbound = await channelRequest(
    { relayUrl: tapUrl, token: unboundToken, machineKey: machinePublic(), staticKey: localStaticKey(stranger.secretKey), device: { name: "x", platform: "x" } },
    { method: "GET", path: "/tasks" },
  );
  check(
    "an unbound key's token opens no channel, and nothing was sent",
    refusedUnbound.kind === "refused" ? [refusedUnbound.reason, refusedUnbound.requestSent] : refusedUnbound.kind,
    ["unbound_capability", false],
  );
  const shared = await helloWith(tapUrl, minted.token, "hunter2", machinePublic());
  check("nor does the shared secret, under both", shared.kind === "refused" ? shared.reason : shared.kind, "unbound_capability");

  process.stdout.write("  the machine's key\n");
  const elsewhereKey = Buffer.from(generateStaticKey().publicKey).toString("base64url");
  db.prepare("UPDATE machines SET machine_key = ? WHERE id = ?").run(elsewhereKey, machineId);
  check("a key the server names later is never dialled: the held one still answers", (await r.tasks.list(machineId)).length, 104);
  await tunnel.stop();
  machineStatic = generateStaticKey();
  setMachineKey(db, machineId, machinePublic());
  tunnel = dial();
  check("the machine comes back on a new key", await ctx.waitForTunnel(machineId), true);
  const swapped = await failure(() => r.tasks.list(machineId));
  const offered = keyFingerprint(machineStatic.publicKey);
  check("and the held key no longer answering is a change for a person", swapped instanceof MachineKeyChanged ? swapped.offeredFingerprint : String(swapped), offered);
  check("who must name the fingerprint on offer", await codeOf(() => r.client.trust(machineId, "AAAA-BBBB")), "client fingerprint_mismatch");
  await r.client.trust(machineId, offered);
  check("and having named it, is answered", (await r.tasks.list(machineId)).length, 104);

  process.stdout.write("  one API key, two installations\n");
  const other = await reemoat({ server, apiKey: owner.key, home: tmp("cli-home-three-") });
  check("a second installation is told the key is bound elsewhere", await codeOf(() => other.tasks.list(machineId)), "server key_bound_elsewhere");
  await other.client.rebind();
  check("and moved here, it is answered", (await other.tasks.list(machineId)).length, 104);
  const rerun = await reemoat({ server, apiKey: owner.key, home });
  check("while the first, run again, is told it moved", await codeOf(() => rerun.tasks.list(machineId)), "server key_bound_elsewhere");

  process.stdout.write("  revoking the key\n");
  await fetch(`${server}/v1/me/keys/${owner.id}`, { method: "DELETE", headers: { authorization: `Bearer ${owner.key}` } });
  check("a revoked key signs nobody in", await codeOf(() => reemoat({ server, apiKey: owner.key, home })), "server api_key_revoked");
  check("though a token it already minted lives out its 300 seconds", (await other.tasks.list(machineId)).length, 104);

  await registry.shutdown();
  await tunnel.stop();
  await new Promise<void>((resolve) => daemon.close(() => resolve()));
  await new Promise<void>((resolve) => cpServer.close(() => resolve()));
  tap.close();
}

/** A channel whose HELLO carries something other than the token the relay authorized: what only a hand-made client sends. */
async function helloWith(relayUrl: string, token: string, capability: string, machineKey: string): Promise<ChannelOutcome> {
  const url = new URL(RELAY_CHANNEL_PATH, relayUrl);
  url.protocol = "ws:";
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  const device = generateStaticKey();
  const exchange = ChannelExchange.start({
    staticKey: localStaticKey(device.secretKey),
    remoteStatic: new Uint8Array(Buffer.from(machineKey, "base64url")),
    hello: { capability },
    request: { method: "GET", path: "/tasks" },
    carrier: { send: (bytes) => ws.send(bytes) },
    maxResponseBytes: 1 << 20,
  });
  ws.on("open", () => exchange.opened());
  ws.on("message", (data: Buffer) => exchange.receiveBytes(new Uint8Array(data)));
  ws.on("close", () => exchange.closed());
  ws.on("error", () => exchange.abort("unreachable"));
  const outcome = await exchange.outcome;
  ws.terminate();
  return outcome;
}
