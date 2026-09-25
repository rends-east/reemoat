import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { serve } from "@hono/node-server";
import { generateStaticKey, localStaticKey } from "@reemoat/protocol";
import type { AgentId, AgentLaunchConfig } from "../src/acp/agents.js";
import { SignedTokenVerifier } from "../src/auth.js";
import { MemoryEventStore, type PromptEvent } from "../src/events.js";
import { PEER_CHANNEL_PATH } from "../src/peers/channel.js";
import { OUTBOX_RETRY_MIN_MS, PeerHub } from "../src/peers/hub.js";
import { createPeerNetwork } from "../src/peers/links.js";
import { SessionRegistry, type ManagedSession } from "../src/registry.js";
import { RelayTunnel } from "../src/relay/tunnel.js";
import { LocalRuntime } from "../src/runtime/local.js";
import type { AgentAvailability, AgentProcess } from "../src/runtime/types.js";
import { createApp } from "../src/server.js";
import { SqlitePeerLinkStore, SqlitePeerOutboxStore, type StoredMachineKey } from "../src/store/sqlite.js";
import { jwkThumbprint, signToken, x25519Jwk, type TokenClaims } from "../src/token.js";
import { activeSigningKeys, issueTunnelKey, newApiKey, newId } from "../packages/control-plane/src/keys.js";
import { setMachineKey } from "../packages/control-plane/src/machinekeys.js";
import { createControlPlaneApp } from "../packages/control-plane/src/app.js";
import { RELAY_CHANNEL_PATH } from "../packages/control-plane/src/relay/listener.js";
import type { TunnelRegistry } from "../packages/control-plane/src/relay/registry.js";

export interface PeerEndToEnd {
  db: DatabaseSync;
  issuer: string;
  relayUrl: string;
  registry: TunnelRegistry;
  check: (name: string, got: unknown, want: unknown) => void;
  waitForTunnel: (machineId: string, timeoutMs?: number) => Promise<boolean>;
}

/** Two daemons of the shipped shape, one owner, the shipped relay between them: the only place a link is driven end to end. */
export async function peerEndToEnd(ctx: PeerEndToEnd): Promise<void> {
  const { db, issuer, relayUrl, check } = ctx;
  // Read here, not handed in: sections before this one rotate the control plane's key, and it mints with the newest.
  const keys = activeSigningKeys(db);
  const signing = keys[0]!;
  const acp = await import("@agentclientprotocol/sdk");
  process.stdout.write("\nagents on two machines, through the relay\n");

  check("the daemon dials the path the relay listens on", PEER_CHANNEL_PATH, RELAY_CHANNEL_PATH);

  const now = Date.now();
  const ownerId = newId("u");
  const apiKey = newApiKey();
  db.prepare("INSERT INTO users (id, name, is_admin, created_at) VALUES (?, ?, 0, ?)").run(ownerId, "peer-owner", now);
  db.prepare("INSERT INTO api_keys (id, user_id, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
    newId("ak"),
    ownerId,
    apiKey.prefix,
    apiKey.hash,
    now,
  );
  const cp = createControlPlaneApp({ db, issuer, tokenTtlSeconds: 300, relayUrl, relay: ctx.registry });
  const asOwner = { authorization: `Bearer ${apiKey.key}`, "content-type": "application/json" };

  interface Stub {
    prompts: string[];
    held: unknown;
    finish: () => void;
  }
  const stubs = new Map<string, Stub>();
  let launched = 0;
  const spawn = (): AgentProcess => {
    const toAgent = new PassThrough();
    const toClient = new PassThrough();
    const send = (m: unknown) => toClient.write(`${JSON.stringify(m)}\n`);
    let current: Stub | null = null;
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
              result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] },
            });
            break;
          case acp.methods.agent.session.new: {
            const sessionId = `s_e2e_${++launched}`;
            const stub: Stub = { prompts: [], held: null, finish: () => {} };
            stub.finish = () => {
              if (stub.held === null) return;
              const ending = stub.held;
              stub.held = null;
              send({ jsonrpc: "2.0", id: ending, result: { stopReason: "end_turn" } });
            };
            stubs.set(sessionId, stub);
            current = stub;
            send({ jsonrpc: "2.0", id, result: { sessionId } });
            break;
          }
          case acp.methods.agent.session.prompt:
            current?.prompts.push(
              (message["params"]?.["prompt"] ?? []).map((block: any) => (block?.type === "text" ? block.text : "")).join(""),
            );
            if (current !== null) current.held = id;
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
    };
  };
  class StubRuntime extends LocalRuntime {
    override async availability(): Promise<AgentAvailability[]> {
      return [{ id: "kimi", displayName: "kimi", available: true, installable: false, loggedIn: true, hint: null, lastStartRefusal: null }];
    }
    override describe(agent: AgentId): AgentLaunchConfig {
      return { id: agent, displayName: agent, command: `/nonexistent/relaycheck/${agent}`, args: [], env: {}, authHint: "" };
    }
    override async launch(): Promise<AgentProcess> {
      return spawn();
    }
  }

  let clock = Date.now();
  const machine = async (label: string) => {
    const id = newId("m");
    const key = generateStaticKey();
    const publicKey = Buffer.from(key.publicKey).toString("base64url");
    db.prepare("INSERT INTO machines (id, name, created_at, enrolled_at) VALUES (?, ?, ?, ?)").run(id, `${label}-${id}`, now, now);
    db.prepare("INSERT INTO machine_owners (machine_id, user_id, label, created_at) VALUES (?, ?, ?, ?)").run(id, ownerId, label, now);
    db.prepare("INSERT INTO grants (user_id, machine_id, scopes, created_at) VALUES (?, ?, ?, ?)").run(
      ownerId,
      id,
      "session:read session:write machine:admin",
      now,
    );
    setMachineKey(db, id, publicKey);
    const stored: StoredMachineKey = {
      kth: jwkThumbprint(x25519Jwk(key.publicKey)),
      publicKey,
      privateKey: Buffer.from(key.secretKey).toString("base64url"),
      createdAt: now,
      retiredAt: null,
    };
    const store = new DatabaseSync(":memory:");
    store.exec(readFileSync(new URL("../src/store/schema.sql", import.meta.url), "utf8"));
    const links = new SqlitePeerLinkStore(store);
    const outbox = new SqlitePeerOutboxStore(store);
    const sessions = new SessionRegistry(new MemoryEventStore(), null, undefined, new StubRuntime(), null);
    const hub = new PeerHub({
      registry: sessions,
      enabled: true,
      machineId: id,
      network: createPeerNetwork(links, { active: () => stored }),
      outbox,
      now: () => clock,
    });
    const verifier = new SignedTokenVerifier({ identity: { machineId: id, issuer, keys: keys.map((one) => ({ kid: one.kid, jwk: one.jwk })) } });
    const { app } = createApp({ registry: sessions, verifier, instanceId: `i_${label}`, startedAt: now, roots: ["/"], peers: { hub, links } });
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const started = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
    });
    const port = (server.address() as AddressInfo).port;
    const tunnelKey = issueTunnelKey(db, id);
    const dial = () =>
      RelayTunnel.start({
        relayUrl,
        tunnelKey,
        local: { host: "127.0.0.1", port },
        staticKey: localStaticKey(key.secretKey),
        machineKey: publicKey,
        verifier,
      });
    let tunnel = dial();
    const asOwnerHere = (): string => {
      const seconds = Math.floor(Date.now() / 1000);
      const claims: TokenClaims = {
        iss: issuer,
        sub: ownerId,
        aud: id,
        jti: newId("t"),
        iat: seconds,
        nbf: seconds,
        exp: seconds + 300,
        scp: ["session:read", "session:write", "machine:admin"],
      };
      return signToken(claims, signing.kid, signing.privateKey);
    };
    /** What the owner's app does: ask the control plane, hand the answer to the daemon unread. */
    const syncLinks = async (): Promise<string[]> => {
      const minted = (await (await cp.request(`/v1/machines/${id}/links`, { method: "POST", headers: asOwner })).json()) as {
        links: unknown[];
      };
      const answer = await app.request("/peers/links", {
        method: "PUT",
        headers: { authorization: `Bearer ${asOwnerHere()}`, "content-type": "application/json" },
        body: JSON.stringify({ links: minted.links }),
      });
      return ((await answer.json()) as { links: { id: string }[] }).links.map((link) => link.id);
    };
    return {
      id,
      label,
      sessions,
      hub,
      links,
      outbox,
      syncLinks,
      stopTunnel: () => tunnel.stop(),
      redial: () => {
        tunnel = dial();
      },
      close: async () => {
        hub.close();
        await tunnel.stop();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  };

  const studio = await machine("studio");
  const laptop = await machine("laptop");
  check("both daemons dial in", [await ctx.waitForTunnel(studio.id), await ctx.waitForTunnel(laptop.id)], [true, true]);
  check("the owner's app hands each its link to the other", [(await studio.syncLinks()).length, (await laptop.syncLinks()).length], [1, 1]);

  const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (test: () => boolean, ms = 3_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (test()) return true;
      await settle(25);
    }
    return test();
  };
  const stubOf = (managed: ManagedSession): Stub => stubs.get(managed.agentSessionId ?? "")!;
  const promptsOf = (managed: ManagedSession): PromptEvent[] =>
    managed.log
      .read(0, 10_000, 1 << 24)
      .map((stored) => stored.event)
      .filter((event): event is PromptEvent => event.type === "prompt");

  const lead = await studio.sessions.create({ agent: "kimi", cwd: "/tmp" });
  lead.setMeta({ title: "Lead" });
  const worker = await laptop.sessions.create({ agent: "kimi", cwd: "/tmp" });
  worker.setMeta({ title: "Worker" });
  const workerAddress = `worker [${laptop.id}/${worker.id}]`;

  const listed = await studio.hub.list(lead.id);
  check(
    "list_agents on one machine shows the other's sessions, named by their machine",
    listed.agents.filter((row) => !row.machine.isThis).map((row) => [row.address, row.machine.label]),
    [[workerAddress, "laptop"]],
  );
  check(
    "and tells the caller the address those machines know it by",
    listed.selfElsewhere,
    `lead [${studio.id}/${lead.id}]`,
  );

  const sent = await studio.hub.send(lead.id, { to: workerAddress, message: "run the suite on your side", notify: true });
  check("a message crosses the relay and starts a turn there", sent.ok ? [sent.delivery, sent.notify] : sent.code, ["started_turn", true]);
  const landed = (await until(() => stubOf(worker).prompts.length === 1)) ? stubOf(worker).prompts[0]! : "";
  check(
    "the agent there is told which machine sent it, from the capability rather than the message",
    landed.includes(`machine="studio"`) && landed.includes(`from="lead [${studio.id}/${lead.id}]"`),
    true,
  );
  check("and that it can answer, since that machine holds a link back", landed.includes("Reply with send_message"), true);
  check("the log there records the sending machine", promptsOf(worker).at(-1)?.from?.machineId, studio.id);

  const report = await laptop.hub.send(worker.id, { to: `lead [${studio.id}/${lead.id}]`, message: "suite green on laptop", notify: false });
  check("the answer goes back the other way and wakes the lead", report.ok ? report.delivery : report.code, "started_turn");
  const woke = await until(() => stubOf(lead).prompts.length === 1, 5_000);
  check("with the answer in it", woke && stubOf(lead).prompts[0]!.includes("suite green on laptop"), true);
  stubOf(worker).finish();
  stubOf(lead).finish();
  await settle(200);
  check("and the worker going idle after answering wakes nobody a second time", stubOf(lead).prompts.length, 1);

  const second = await studio.hub.send(lead.id, { to: workerAddress, message: "now the slow suite", notify: true });
  check("a second one is taken the same way", second.ok ? second.delivery : second.code, "started_turn");
  await until(() => stubOf(worker).prompts.length === 2);
  stubOf(worker).finish();
  const noticed = await until(() => stubOf(lead).prompts.length === 2, 5_000);
  check("a worker that goes idle without answering is reported by its machine", noticed && stubOf(lead).prompts[1]!.includes("<peer-notice"), true);
  stubOf(lead).finish();
  await settle();

  process.stdout.write("  a revoked link, and a machine that is off\n");
  const rows = (await (await cp.request(`/v1/machines/${studio.id}/links`, { headers: asOwner })).json()) as {
    links: { id: string; source: { id: string } }[];
  };
  const outgoing = rows.links.find((link) => link.source.id === studio.id);
  await cp.request(`/v1/links/${outgoing?.id}`, { method: "DELETE", headers: asOwner });
  clock += 10_000;
  const refused = await studio.hub.send(lead.id, { to: workerAddress, message: "are you there", notify: false });
  check("a revoked link is refused at the relay on its next use", refused.ok ? null : refused.code, "link_refused");
  await studio.syncLinks();
  clock += 10_000;
  const renewed = await studio.hub.send(lead.id, { to: workerAddress, message: "and now", notify: false });
  check("and the owner's app hands over a new one", renewed.ok ? renewed.delivery : renewed.code, "started_turn");
  await until(() => stubOf(worker).prompts.length === 3);
  stubOf(worker).finish();
  await settle();

  await laptop.stopTunnel();
  await until(() => !ctx.registry.isOnline(laptop.id));
  clock += 10_000;
  const held = await studio.hub.send(lead.id, { to: workerAddress, message: "when you are back", notify: false });
  check("a message for a machine that is off is held on the sender", [held.ok ? held.delivery : held.code, studio.outbox.count()], ["pending", 1]);
  laptop.redial();
  check("the machine comes back", await ctx.waitForTunnel(laptop.id), true);
  const before = stubOf(worker).prompts.length;
  clock += OUTBOX_RETRY_MIN_MS;
  await studio.hub.pumpOutbox();
  check(
    "and gets it, once",
    [studio.outbox.count(), await until(() => stubOf(worker).prompts.length === before + 1), stubOf(worker).prompts.at(-1)?.includes("when you are back")],
    [0, true, true],
  );
  stubOf(worker).finish();
  await settle();

  for (const managed of [lead, worker]) await managed.stop();
  await studio.close();
  await laptop.close();
}
