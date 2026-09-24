import { readFileSync } from "node:fs";
import { check, fetchChannel, report, storage } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

// inNativeShell reads the injected global on every call, so installing and removing the shell reaches both arms in one process.

process.stdout.write("\nthe local route, and the browser that may never take it\n");

const LOCAL = "http://127.0.0.1:7887";
const RELAY = "https://r1.example";
// Any 43 base64url characters: probeRoute requires a key, but nothing here runs a handshake.
const MACHINE_KEY = "A".repeat(43);

/** What `host_local_daemon` will answer. `null` is "no daemon on this computer". */
let announced: { machineId: string; base: string; instanceId: string } | null = null;

type Shell = { core: { invoke: (command: string, args?: unknown) => Promise<unknown> } };

// host_cp too: the shell sends every /v1 request through the host, and with no token no route candidate is reached.
function installShell(): void {
  (globalThis as unknown as { window: { __TAURI__?: Shell } }).window.__TAURI__ = {
    core: {
      invoke: async (command: string, args?: unknown): Promise<unknown> => {
        if (command === "host_local_daemon") return announced;
        if (command === "host_credential_set" || command === "host_credential_clear") return null;
        if (command === "host_cp") {
          const request = (args as { req: { path: string; method: string; body: string | null } }).req;
          const answer = await globalThis.fetch(request.path, {
            method: request.method,
            body: request.body,
          });
          return { status: answer.status, statusText: answer.statusText, body: await answer.text() };
        }
        throw new TypeError(`unexpected command ${command}`);
      },
    },
  };
}

function removeShell(): void {
  delete (globalThis as unknown as { window: { __TAURI__?: Shell } }).window.__TAURI__;
}

let asked: string[] = [];

interface Answers {
  /** What `/fs/roots` on loopback answers. A number is a bare status. */
  roots: number | { status: number; code: string };
  relayUp?: boolean;
  // false omits the field entirely, as the Authority does for a daemon that never announced a key.
  machineKey?: false;
  // Refused as the Authority does, 409 device_key_required (a 401 would sign the store out); transport throws, since an outage has no status.
  mint?: { status: number; code: string } | "transport";
}

let mints = 0;

function stubFetch(answers: Answers): () => void {
  const real = globalThis.fetch;
  asked = [];
  mints = 0;
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === "/v1/tokens") {
      // Counted before refusing: a refusal is still an ask, and the device-key section reads the count.
      mints += 1;
      const refusal = answers.mint;
      if (refusal === "transport") throw new TypeError("Failed to fetch");
      if (refusal !== undefined) {
        return json({ error: { code: refusal.code, message: refusal.code } }, refusal.status);
      }
      const now = Date.now();
      return json({
        token: `jws-${String(mints)}`,
        expiresAt: now + 300_000,
        serverTime: now,
        machine: {
          relayUrl: RELAY,
          relayOnline: answers.relayUp !== false,
          ...(answers.machineKey === false ? {} : { key: MACHINE_KEY }),
        },
      });
    }
    asked.push(url);
    if (url.startsWith(LOCAL)) {
      if (url.endsWith("/health")) return json({ ok: true, instanceId: "i_x", authMode: "signed" });
      const answer = answers.roots;
      if (typeof answer === "number") return json({ roots: [] }, answer);
      return json({ error: { code: answer.code, message: answer.code } }, answer.status);
    }
    if (url.endsWith("/health")) return json({ ok: true, instanceId: "i_relay" });
    return json({ sessions: [] });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

async function connect(id: string, channels: never = fetchChannel) {
  const cp = await import("../src/cp.js");
  const { MachineConnection } = await import("../src/machine.js");
  cp.setSession("rs_local");
  // Overridable: fetchChannel can never throw ChannelRefused, so the last section passes a refusing factory.
  return new MachineConnection(
    { id, name: "laptop", relayUrl: RELAY, relayOnline: true, enrolled: true, owned: true, scopes: [] } as never,
    () => {},
    channels,
  );
}

{
  // A browser must not even try loopback: an https page cannot reach it (mixed content).
  removeShell();
  announced = { machineId: "m_1", base: LOCAL, instanceId: "i_x" };
  const restore = stubFetch({ roots: 200 });
  const connection = await connect("m_1");
  const route = await connection.resolveRoute();
  check("a browser settles on the relay", [route?.base, route?.kind], [RELAY, "relay"]);
  check(
    "and asked loopback nothing at all",
    asked.filter((url) => url.startsWith(LOCAL)),
    [],
  );
  restore();
}

{
  installShell();
  announced = { machineId: "m_2", base: LOCAL, instanceId: "i_x" };
  const restore = stubFetch({ roots: 200 });
  const connection = await connect("m_2");
  const route = await connection.resolveRoute();
  check("the app takes the local path", [route?.base, route?.kind], [LOCAL, "local"]);
  check(
    "having proved it with a credential before believing anything unauthenticated",
    asked.map((url) => url.slice(LOCAL.length)),
    ["/fs/roots", "/health"],
  );
  restore();
}

{
  // Any status but 401 is proof: 403 and 404 come from after the auth gate, so the identity claim passed.
  installShell();
  for (const [what, roots] of [
    ["a 403 about a scope", { status: 403, code: "insufficient_scope" }],
    ["a 404 from an older daemon", { status: 404, code: "http_404" }],
  ] as const) {
    announced = { machineId: "m_3", base: LOCAL, instanceId: "i_x" };
    const restore = stubFetch({ roots });
    const connection = await connect("m_3");
    const route = await connection.resolveRoute();
    check(`${what} still establishes the machine`, route?.kind, "local");
    restore();
  }

  announced = { machineId: "m_4", base: LOCAL, instanceId: "i_x" };
  const restore = stubFetch({ roots: { status: 401, code: "wrong_machine" } });
  const connection = await connect("m_4");
  const route = await connection.resolveRoute();
  check("but a wrong_machine refusal is not", [route?.base, route?.kind], [RELAY, "relay"]);

  // Sticky, to spare a loopback request on every offline retry.
  connection.forgetRoute();
  const before = asked.filter((url) => url.startsWith(LOCAL)).length;
  await connection.resolveRoute();
  check(
    "and it is not asked again in the same session",
    asked.filter((url) => url.startsWith(LOCAL)).length,
    before,
  );

  connection.update({
    id: "m_4",
    name: "laptop",
    relayUrl: RELAY,
    relayOnline: true,
    enrolled: true,
    owned: true,
    scopes: [],
  } as never);
  connection.forgetRoute();
  await connection.resolveRoute();
  report(
    "a wake asks loopback again",
    asked.filter((url) => url.startsWith(LOCAL)).length > before,
    `loopback calls: ${asked.filter((url) => url.startsWith(LOCAL)).length}`,
  );
  restore();
}

{
  installShell();
  announced = { machineId: "m_5", base: LOCAL, instanceId: "i_x" };
  let roots: number | { status: number; code: string } = 200;
  const real = globalThis.fetch;
  const calls: string[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === "/v1/tokens") {
      const now = Date.now();
      return json({
        token: "jws-1",
        expiresAt: now + 300_000,
        serverTime: now,
        machine: { relayUrl: RELAY, relayOnline: true, key: MACHINE_KEY },
      });
    }
    calls.push(url);
    if (url.startsWith(LOCAL)) {
      if (url.endsWith("/health")) return json({ ok: true, instanceId: "i_x", authMode: "signed" });
      if (typeof roots === "number") return json({ roots: [] }, roots);
      return json({ error: { code: roots.code, message: roots.code } }, roots.status);
    }
    return json({ sessions: ["from the relay"] });
  }) as typeof fetch;

  const connection = await connect("m_5");
  check("it starts local", (await connection.resolveRoute())?.kind, "local");

  // Retrying a POST is safe only here: wrong_machine comes from the middleware above every route, so no handler ran.
  roots = { status: 401, code: "wrong_machine" };
  const answer = await connection.request<{ sessions: string[] }>("/fs/roots", { method: "POST" });
  check("a stale route repairs itself mid-request", answer.sessions, ["from the relay"]);
  check("landing on the relay", connection.currentRoute()?.kind, "relay");

  globalThis.fetch = real;
  removeShell();
}

{
  installShell();
  const { localOff, setLocalOff, localAnnouncedFor, localBaseFor } = await import("../src/localRoute.js");
  announced = { machineId: "m_6", base: LOCAL, instanceId: "i_x" };

  check("a machine nobody has touched is on", localOff("m_6"), false);
  check("and has a local base", await localBaseFor("m_6"), LOCAL);

  setLocalOff("m_6", true);
  check("switching it off is remembered", localOff("m_6"), true);
  check("and takes the base away", await localBaseFor("m_6"), null);
  check("while the announcement itself is still there to say so", await localAnnouncedFor("m_6"), LOCAL);

  check(
    "it is stored as the off list rather than as every machine",
    storage.get("reemoat.localDaemons"),
    '{"off":["m_6"]}',
  );
  setLocalOff("m_6", false);
  check("and switching it back leaves nothing behind", storage.get("reemoat.localDaemons"), '{"off":[]}');

  announced = { machineId: "m_other", base: LOCAL, instanceId: "i_x" };
  check("an announcement for another machine is not an answer", await localBaseFor("m_6"), null);

  announced = null;
  check("and no announcement at all is the ordinary case", await localBaseFor("m_6"), null);
  removeShell();
}

{
  // No plaintext fallback, and nothing is dialled: this channel would answer 200, so a dial would fail the reason check.
  removeShell();
  let dialled = 0;
  const wouldAnswer = (() => ({
    async request(): Promise<{
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: Uint8Array;
    }> {
      dialled += 1;
      return {
        status: 200,
        statusText: "OK",
        headers: {},
        body: new TextEncoder().encode(JSON.stringify({ ok: true, instanceId: "i_relay" })),
      };
    },
    openSocket(): never {
      throw new Error("this section never opens one");
    },
    dispose(): void {},
  })) as never;

  announced = null;
  const restore = stubFetch({ roots: 200, machineKey: false });
  const connection = await connect("m_nokey", wouldAnswer);
  const route = await connection.resolveRoute();
  check("a machine with no announced key has no route", route, null);
  check("and says which of the two key states it is in", connection.state().offlineReason, "no_machine_key");
  check("while the machine itself is not drawn as reachable", connection.state().reach, "offline");
  report("⭐ and no channel was opened to find that out", dialled === 0, `${String(dialled)} channel request(s)`);
  check(
    "nor was anything asked of the relay by any other route",
    asked.filter((url) => url.startsWith(RELAY)),
    [],
  );

  restore();
  const withKey = stubFetch({ roots: 200 });
  const second = await connect("m_haskey", wouldAnswer);
  check("the same fleet with a key settles on the relay", (await second.resolveRoute())?.kind, "relay");
  report("having actually opened one", dialled > 0, `${String(dialled)} channel request(s)`);
  withKey();
}

{
  // Drives the reachable arm (no shell, nothing to register, one mint), not production's retry, which no driver can reach:
  // native.ts fills its boot payload only at import, so an installed shell still has none.
  removeShell();
  announced = null;

  const settle = async (
    id: string,
    mint?: { status: number; code: string } | "transport",
  ): Promise<{ route: string | null; reason: string | null; reach: string; asked: string[]; mints: number }> => {
    const restore = stubFetch({ roots: 200, mint });
    try {
      const connection = await connect(id);
      const route = await connection.resolveRoute();
      return {
        route: route?.kind ?? null,
        reason: connection.state().offlineReason,
        reach: connection.state().reach,
        asked: [...asked],
        mints,
      };
    } finally {
      // In finally: globalThis.fetch is process-wide, so a throw must not leave the stub installed.
      restore();
    }
  };

  const missing = await settle("m_nodevice", { status: 409, code: "device_key_required" });
  check("⭐ an installation with no device key has no route", missing.route, null);
  check("and is told so as the device half rather than as a missing token", missing.reason, "no_device_key");
  check("while the machine is not drawn as reachable over a cause on this device", missing.reach, "offline");
  check("having asked for exactly one capability, there being nothing to register", missing.mints, 1);
  check("and probed nothing to find that out", missing.asked, []);

  // The code, never the status: another 409 from the same route must not read as the device half.
  const notEnrolled = await settle("m_notenrolled", { status: 409, code: "machine_not_enrolled" });
  check("another 409 from the same route is not the device half", notEnrolled.reason, "no_token");
  const revoked = await settle("m_revoked", { status: 403, code: "machine_revoked" });
  check("nor is a refusal that arrives under another status", revoked.reason, "no_token");

  const down = await settle("m_cpdown", "transport");
  check("and an unreachable control plane is neither of them", down.reason, "cp_unreachable");

  const minted = await settle("m_minted");
  check(
    "while the same fleet with a mint that answers settles on the relay",
    [minted.route, minted.reason, minted.reach],
    ["relay", null, "online"],
  );
  report(
    "having actually probed it, which is what makes the emptiness above a measurement",
    minted.asked.some((url) => url.startsWith(RELAY)),
    minted.asked.join(", ") || "(nothing was asked)",
  );

  // Pins the cause of the gap: with the bridge but no boot payload, registerDevice answers null without asking anything.
  {
    installShell();
    const { registerDevice } = await import("../src/cp.js");
    const restore = stubFetch({ roots: 200 });
    try {
      // Caught so a regression that starts sending fails this line rather than the rest of the run.
      const registered = await registerDevice().catch((error: unknown) => `threw: ${String(error)}`);
      check("a shell with no boot payload describes no device to register", registered, null);
      check("and asked the control plane nothing to find that out", asked, []);
    } finally {
      restore();
      removeShell();
    }
  }

  // The production order no fleet can reach, read off disk: register, re-mint, then settle a reason.
  {
    const mint =
      /private async mint\(firstAttempt = true\): Promise<string> \{([\s\S]*?)\n  \}/.exec(
        stripComments(readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8")),
      )?.[1] ?? "";
    // Proof of life: every slice below defaults to the empty string.
    report("mint was found to read", mint.length > 0, `${String(mint.length)} bytes`);
    const flat = mint.replace(/\s+/g, " ");

    check(
      "the one self-repair is guarded on the first attempt rather than run on every refusal",
      flat.includes("if (firstAttempt && meansDeviceKeyMissing(error)) {"),
      true,
    );
    check(
      "and the re-mint it runs says it is not the first attempt",
      flat.includes("if (registered !== null) return await this.mint(false);"),
      true,
    );
    const repairAt = mint.indexOf("registerDevice");
    const reasonAt = mint.indexOf("this.offlineReason");
    report(
      "and the repair is tried before a reason is settled rather than after",
      repairAt > 0 && repairAt < reasonAt,
      `registerDevice at ${String(repairAt)}, offlineReason at ${String(reasonAt)}`,
    );
    // Pinned as the whole expression, so a third arm or swapped arms fail.
    check(
      "and the reason it settles is keyed on the refusal's code rather than on the attempt",
      (/this\.offlineReason = [\s\S]*?;/.exec(mint)?.[0] ?? "").replace(/\s+/g, " "),
      'this.offlineReason = isTransportFailure(error) ? "cp_unreachable" : meansDeviceKeyMissing(error) ? "no_device_key" : "no_token";',
    );
  }
}

{
  const { OFFLINE_TEXT } = await import("../src/ui/bits.js");

  // The sweep over the whole table is webcheck.machine-limit-and-probe.ts's; this pins the pair that must differ.
  report("both key states have a sentence", OFFLINE_TEXT.no_device_key.length > 0 && OFFLINE_TEXT.no_machine_key.length > 0, `${OFFLINE_TEXT.no_machine_key} / ${OFFLINE_TEXT.no_device_key}`);
  check("and the device half is not the credential half's", OFFLINE_TEXT.no_device_key === OFFLINE_TEXT.no_token, false);
  check("nor the machine half's", OFFLINE_TEXT.no_device_key === OFFLINE_TEXT.no_machine_key, false);
  check(
    "and each names the computer its remedy is on",
    [/daemon/.test(OFFLINE_TEXT.no_machine_key), /this device/.test(OFFLINE_TEXT.no_device_key)],
    [true, true],
  );
}

{
  removeShell();
  const { ChannelRefused } = await import("../src/e2ee.js");
  const { errorText } = await import("../src/http.js");

  /** Refusals answered, not counting the `/health` the route probe spends. */
  let refusals = 0;

  // Answers the probe and then refuses, the real shape; refusing the probe too would settle no route.
  const refusing = (status: number, reason: string) =>
    (() => ({
      async request(wanted: { path: string }): Promise<{
        status: number;
        statusText: string;
        headers: Record<string, string>;
        body: Uint8Array;
      }> {
        if (wanted.path === "/health") {
          return {
            status: 200,
            statusText: "OK",
            headers: {},
            body: new TextEncoder().encode(JSON.stringify({ ok: true, instanceId: "i_relay" })),
          };
        }
        refusals += 1;
        throw new ChannelRefused(status, reason);
      },
      openSocket(): never {
        throw new Error("this section never opens one");
      },
      dispose(): void {},
    })) as never;

  const refused = async (
    id: string,
    status: number,
    reason: string,
  ): Promise<{ code: string; message: string; sentence: string; attempts: number; mints: number; reach: string; route: string | null }> => {
    const restore = stubFetch({ roots: 200 });
    refusals = 0;
    const connection = await connect(id, refusing(status, reason));
    check(`${reason}: the route settles before anything is refused`, (await connection.resolveRoute())?.kind, "relay");
    const mintsAfterRoute = mints;
    let caught: unknown;
    try {
      await connection.request("/sessions");
    } catch (error) {
      caught = error;
    }
    const answer = {
      code: (caught as { code?: string }).code ?? "(not an ApiError)",
      message: (caught as Error).message,
      sentence: errorText(caught),
      attempts: refusals,
      mints: mints - mintsAfterRoute,
      reach: connection.state().reach,
      route: connection.currentRoute()?.kind ?? null,
    };
    restore();
    return answer;
  };

  {
    // The assertion is the count: a replayed refusal reaches the caller with the same message, and GET is replayable (Q6.103).
    const truncated = await refused("m_truncated", 502, "truncated");
    check("⭐ a 502 truncated is asked exactly once", truncated.attempts, 1);
    check("and reaches the caller as an answered refusal", [truncated.code, truncated.route], ["truncated", "relay"]);
    check("the machine is not drawn as unreachable over it", truncated.reach, "online");
    check(
      "and the sentence names what happened rather than the weather",
      truncated.sentence,
      "laptop refused this connection: truncated",
    );
  }

  {
    // The channel goes with the token: the daemon pins the HELLO capability onto every inner request, so settleRefusal closes it first.
    const expired = await refused("m_expired", 401, "token_expired");
    check("⭐ a token_expired refusal is retried once", expired.attempts, 2);
    report("having minted a fresh capability in between", expired.mints > 0, `${String(expired.mints)} mint(s)`);
    check("and the second refusal is the one the caller gets", expired.code, "token_expired");
    check("the route is still believed", [expired.reach, expired.route], ["online", "relay"]);
    check(
      "with the daemon's own word in the sentence",
      expired.sentence,
      "laptop refused this connection: token_expired",
    );
  }

  {
    // Guarded on route.kind: from the relay, wrong_machine is two services disagreeing, not a reason to abandon the only path.
    const wrong = await refused("m_wrongmachine", 401, "wrong_machine");
    check("⭐ a wrong_machine from the relay is not retried", wrong.attempts, 1);
    check("and the relay route survives it", [wrong.reach, wrong.route], ["online", "relay"]);
    check("while the caller is told the code rather than a network story", wrong.code, "wrong_machine");
    check(
      "and the sentence says which machine refused it",
      wrong.sentence,
      "laptop refused this connection: wrong_machine",
    );
  }

  {
    const unbound = await refused("m_unbound", 401, "unbound_capability");
    check("⭐ an unbound capability is reported by its own name", unbound.code, "unbound_capability");
    check("once, with no replay", unbound.attempts, 1);
    check(
      "and the sentence carries the verifier's word",
      unbound.sentence,
      "laptop refused this connection: unbound_capability",
    );
    check(
      "which is not the sentence a dropped connection draws",
      unbound.sentence === errorText(new TypeError("Failed to fetch")),
      false,
    );
  }
}

{
  const machine = stripComments(readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8"));

  // The guard is the local tag, not the predicate; read off source because a driver cannot make a relay send it.
  check(
    "the mid-request drop is guarded on the local tag",
    /this\.chosen\?\.kind === "local" && meansWrongMachine\(error\)/.test(machine),
    true,
  );

  // denyLocal, not forgetRoute: the latter re-probes loopback on the next resolve, for ever.
  check("and it is denyLocal rather than forgetRoute that runs", /denyLocal\(\);\s*\n\s*if \(firstAttempt\)/.test(machine), true);

  // The loopback candidate must sit above the relayOnline check, or a laptop with its tunnel down never reaches it.
  // The switch must sit outside the listable gate: an unreachable machine is exactly when loopback repairs the screen.
  const section = readFileSync(
    new URL("../src/ui/settings/MachineSection.tsx", import.meta.url),
    "utf8",
  );
  const gateOpens = section.indexOf("{listable ? (");
  const gateCloses = section.indexOf("\n      )}", gateOpens);
  const drawn = section.indexOf("<LocalPath ");
  report(
    "the local-path switch survives a machine reading unreachable",
    gateOpens > 0 && gateCloses > gateOpens && drawn > gateCloses,
    `gate ${gateOpens}..${gateCloses}, drawn at ${drawn}`,
  );

  const localAt = machine.indexOf("localBaseFor(this.id)");
  const relayAt = machine.indexOf("this.relayOnline ? this.relayUrl : null");
  report(
    "and the candidate is tried above the control plane's own opinion",
    localAt > 0 && relayAt > 0 && localAt < relayAt,
    `local at ${localAt}, relayOnline at ${relayAt}`,
  );
}

// Which computer this is comes per client from the announce file localDaemon reads, never from the route.
{
  const store = stripComments(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));

  check("the store keeps which machine this computer is", /localMachineId: MachineId \| null;/.test(store), true);
  check("and fills it from the daemon's announce file", /const found = await localDaemon\(\);/.test(store), true);

  // Not route.kind: the route is a preference setLocalOff changes, and identity must not move with it.
  const refresher = /private async refreshLocalMachine\(\)[\s\S]*?\n  \}/.exec(store)?.[0] ?? "";
  check("refreshLocalMachine was found to read", refresher.length > 0, true);
  check("and it never consults the routing preference", /localOff|localBaseFor|kind === "local"/.test(refresher), false);

  // A memo, so runResume, the funnel every wake and machine change passes, must refresh it.
  const resume = /private async runResume\([\s\S]*?\n    this\.patch\(\{ resuming: true \}\);[\s\S]{0,400}/.exec(store)?.[0] ?? "";
  check("and the resume funnel is what asks again", /await this\.refreshLocalMachine\(\);/.test(resume), true);
  // And once before the rail's first paint, or this machine is renamed and moved just after it.
  const boot = /async bootstrap\(\)[\s\S]*?this\.patch\(\{ phase: "ready", me/.exec(store)?.[0] ?? "";
  check("bootstrap was found to read", boot.length > 0, true);
  check(
    "and it asks which computer this is inside the same wait as the listing",
    /await Promise\.all\(\[[\s\S]*?cp\.machines\(\)[\s\S]*?this\.refreshLocalMachine\(\),\s*\]\);/.test(boot),
    true,
  );
  // Seeded before that wait: on a cold launch the app-run daemon is stopped, so the live read finds nothing.
  const seedAt = boot.indexOf("this.seedLocalMachine(boot.claimed);");
  check("bootstrap seeds it from the boot payload's claim", seedAt > 0, true);
  check("before the live read is asked", seedAt < boot.indexOf("await Promise.all(["), true);
  check("and the live read is weighed rather than assigned", /this\.weighLocalMachine\(\);/.test(refresher), true);
  check(
    "against what is known and the machines held",
    /weighLocalMachine\(answer: MachineId \| null = this\.announcedMachine\)[\s\S]{0,160}localMachineAfter\(known, answer, /.test(store),
    true,
  );
  // Weighed again once each listing lands: a just-created machine is ours only after it.
  check(
    "bootstrap weighs it again before the first paint",
    /this\.weighLocalMachine\(\);\s*this\.patch\(\{ phase: "ready", me/.test(store),
    true,
  );
  check(
    "and a resume, after its re-list",
    (store.match(/this\.dropMachine\(id\);\s*\}\s*this\.weighLocalMachine\(\);/g) ?? []).length,
    1,
  );
  check(
    "a machine created for this computer is weighed as it the moment the listing holds it",
    (
      store.match(
        /await this\.machinesChanged\("machine-added"\);\s*this\.weighLocalMachine\(machineId\(created\.machine\.id\)\);\s*await this\.settleDaemon\(created\.machine\.id/g,
      ) ?? []
    ).length,
    2,
  );

  // The OS folder panel is only right where the daemon is this computer, which only localMachineId answers.
  const start = stripComments(readFileSync(new URL("../src/ui/NewSession.tsx", import.meta.url), "utf8"));
  check(
    "the OS panel is gated on which computer this is, and on the shell saying it can",
    /osDialog=\{nativeBoot\(\)\?\.picksFolder === true && state\.localMachineId === selected\}/.test(start),
    true,
  );
  // picksFolder, not inNativeShell: the Android shell has no folder panel.
  check("and a shell that cannot do it is not asked", /inNativeShell\(\)/.test(start), false);
  check("and never on the routing preference", /localOff|route\.kind|kind === "local"/.test(start), false);
  check("it is derived once", (start.match(/localMachineId/g) ?? []).length, 1);
  check("and there is one picker for both arms to live in", (start.match(/<DirectoryPicker/g) ?? []).length, 1);
  check("the listing effect stands down where the panel stands up", /path === null \|\| osDialog\) return;/.test(start), true);
}

// Every publish is recorded, because a publish is all a screen ever renders from.
process.stdout.write("\nan offline machine being re-probed\n");
{
  removeShell();
  announced = null;
  const cp = await import("../src/cp.js");
  const { MachineConnection, daemonRead } = await import("../src/machine.js");
  cp.setSession("rs_local");
  const restore = stubFetch({ roots: 200, relayUp: false });
  try {
    const record = { id: "m_reprobe", name: "laptop", relayUrl: RELAY, relayOnline: false, enrolled: true, owned: true, scopes: [] };
    const published: string[] = [];
    const connection: InstanceType<typeof MachineConnection> = new MachineConnection(
      record as never,
      () => published.push(connection.state().reach),
      fetchChannel,
    );
    const reads = (): string[] => published.map((reach) => daemonRead(reach as never));

    await connection.resolveRoute();
    check(
      "a first probe is announced, and reads as a question until it is answered",
      [published[0], reads().slice(0, -1).every((read) => read === "asking"), reads().at(-1)],
      ["probing", true, "unreachable"],
    );

    // What the store's tick does every OFFLINE_RETRY_MS.
    published.length = 0;
    connection.forgetRoute();
    check("the re-probe finds nothing either", await connection.resolveRoute(), null);
    report("having published its answer", published.length > 0, `${String(published.length)} publish(es)`);
    check("⭐ and nothing it published reads as readable", reads().filter((read) => read === "readable"), []);
    check("nor as a question the machine had already answered", published.filter((reach) => reach !== "offline"), []);
    check("and the reason is still the one it had", connection.state().offlineReason, "no_route");

    connection.update({ ...record, relayOnline: true } as never);
    published.length = 0;
    connection.forgetRoute();
    const back = await connection.resolveRoute();
    check("a re-probe that finds it back publishes once, as the answer", [back?.kind, published], ["relay", ["online"]]);
  } finally {
    restore();
  }
}

// The stand-in connections answer only state, so nothing below may yield to a poll tick before they are deleted.
process.stdout.write("\nwhich computer this is, seeded and then sticky\n");
{
  const { store } = await import("../src/store.js");
  const internals = store as unknown as {
    seedLocalMachine(claimed: string | null): void;
    refreshLocalMachine(): Promise<void>;
    weighLocalMachine(): void;
    patch(fields: { localMachineId: string | null }): void;
    connections: Map<string, unknown>;
  };
  const local = (): string | null => store.getSnapshot().localMachineId;
  const live = (id: string) => ({ machineId: id, base: LOCAL, instanceId: "i_sticky" });

  installShell();
  internals.patch({ localMachineId: null });
  const standIn = (id: string) => ({ state: () => ({ id, name: id }) });
  internals.connections.set("m_claim", standIn("m_claim"));
  internals.connections.set("m_moved", standIn("m_moved"));
  announced = null;

  internals.seedLocalMachine("m_claim");
  check("the claim is which computer this is before any daemon has answered", local(), "m_claim");
  await internals.refreshLocalMachine();
  check("and a live read that finds nothing — every cold launch — leaves it", local(), "m_claim");
  announced = live("m_stranger");
  await internals.refreshLocalMachine();
  check("a daemon for another fleet answering first does not move it", local(), "m_claim");
  announced = live("m_moved");
  await internals.refreshLocalMachine();
  check("a different machine of ours, live, replaces it", local(), "m_moved");
  announced = null;
  await internals.refreshLocalMachine();
  check("and a /health that misses its probe does not clear that either", local(), "m_moved");
  internals.seedLocalMachine("m_claim");
  check("while a seed never replaces what a live read said", local(), "m_moved");
  internals.patch({ localMachineId: null });
  internals.seedLocalMachine(null);
  check("and no claim seeds nothing", local(), null);

  internals.seedLocalMachine("m_claim");
  announced = live("m_fresh");
  await internals.refreshLocalMachine();
  check("a machine not in the list yet does not replace one that is", local(), "m_claim");
  internals.connections.set("m_fresh", standIn("m_fresh"));
  internals.weighLocalMachine();
  check("and does once the listing that holds it has landed", local(), "m_fresh");

  internals.connections.delete("m_claim");
  internals.connections.delete("m_moved");
  internals.connections.delete("m_fresh");
  internals.patch({ localMachineId: null });
  announced = null;
  removeShell();
}
