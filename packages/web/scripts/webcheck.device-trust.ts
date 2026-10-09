import { readFileSync } from "node:fs";
import { approvalCode, generateStaticKey, keyFingerprint } from "@reemoat/protocol";
import { check, report, storage } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";

// Which key a machine is dialled with, and what a device says while it waits to be let in. The daemon's half is daemoncheck's.

process.stdout.write("\nthe key a machine was first reached with, and a device waiting to be let in\n");

const RELAY = "https://r1.example";
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const first = b64(generateStaticKey().publicKey);
const second = b64(generateStaticKey().publicKey);
const device = generateStaticKey();

{
  const { readMachineKey, weighOfferedKey } = await import("../src/machinePins.js");

  check("with nothing held and nothing named there is nothing to dial with", weighOfferedKey(null, null), { kind: "none" });
  check("a first key is used and kept", weighOfferedKey(null, first), { kind: "use", key: first, pin: true });
  check("the same key again is used and not written again", weighOfferedKey(first, first), { kind: "use", key: first, pin: false });
  check(
    "a server that stops naming a key does not take the held one away",
    weighOfferedKey(first, null),
    { kind: "use", key: first, pin: false },
  );
  check(
    "a different key later is never the one dialled: the held one is, and the other waits on a person",
    weighOfferedKey(first, second),
    { kind: "changed", key: first, offered: second },
  );
  // Total over both arguments: no pair is left to fall through as undefined.
  const pairs = [null, first, second].flatMap((pinned) => [null, first, second].map((offered) => weighOfferedKey(pinned, offered)));
  report("every pair of held and named has an answer", pairs.every((one) => one !== undefined), `${pairs.length} pairs`);
  check(
    "and only the two disagreeing pairs are a change",
    pairs.filter((one) => one.kind === "changed").length,
    2,
  );

  check("a key is 43 URL-safe characters", readMachineKey(first), first);
  check(
    "and anything else is no key",
    [readMachineKey(`${first}=`), readMachineKey(first.slice(1)), readMachineKey(`${first.slice(0, 42)}+`), readMachineKey(null), readMachineKey(7)],
    [null, null, null, null, null],
  );
}

{
  const { storedPins } = await import("../src/machinePins.js");
  let server = "https://one.example";
  const pins = storedPins(() => server);

  check("a machine nobody has reached has no key held", pins.get("m_a"), null);
  pins.set("m_a", first);
  check("a key set is the key held", pins.get("m_a"), first);
  report("and it is written where a restart finds it", (storage.get("reemoat.machinePins") ?? "").includes(first), "localStorage");
  server = "https://two.example";
  check("the same machine id on another server is another machine", pins.get("m_a"), null);
  pins.set("m_a", second);
  server = "https://one.example";
  check("and pinning it there leaves this one alone", pins.get("m_a"), first);

  // Every account's webview on one computer writes this one value, so what this document holds is not all there is.
  const KEY = "reemoat.machinePins";
  const ONE = "https://one.example";
  const onDisk = (): Record<string, Record<string, string>> => JSON.parse(storage.get(KEY) ?? "{}") as Record<string, Record<string, string>>;
  const elsewhere = (id: string, key: string): void => {
    const all = onDisk();
    all[ONE] = { ...all[ONE], [id]: key };
    storage.set(KEY, JSON.stringify(all));
  };
  check("what a restart finds is what was set, under its server", [onDisk()[ONE]?.["m_a"], onDisk()["https://two.example"]?.["m_a"]], [first, second]);
  elsewhere("m_b", second);
  check("a key another document pinned is found here, with nothing told", pins.get("m_b"), second);
  elsewhere("m_c", first);
  pins.set("m_d", second);
  check("a key set here does not erase one another document wrote in between", [onDisk()[ONE]?.["m_c"], onDisk()[ONE]?.["m_d"], onDisk()[ONE]?.["m_a"]], [first, second, first]);
  // Somebody trusted a changed key in the other window: a write from this one may not put the old one back.
  elsewhere("m_a", second);
  pins.set("m_e", first);
  check("nor put back a key another document has since replaced", [onDisk()[ONE]?.["m_a"], pins.get("m_a")], [second, second]);

  // A second copy of the module is a second document: a cache of its own over the one storage, and not yet listening.
  const heard: ((event: { key: string | null }) => void)[] = [];
  const told = (key: string): void => {
    for (const listener of heard) listener({ key });
  };
  const page = (globalThis as unknown as { window: { addEventListener?: unknown; localStorage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } } }).window;
  const listening = page.addEventListener;
  page.addEventListener = (type: string, listener: (event: { key: string | null }) => void): void => {
    if (type === "storage") heard.push(listener);
  };
  const secondDocument = "../src/machinePins.js?document=2";
  const other = ((await import(secondDocument)) as typeof import("../src/machinePins.js")).storedPins(() => ONE);
  check("a document starts listening to storage when it first reads it", [other.get("m_a"), heard.length], [second, 1]);
  check("and finds there what the first one set", [other.get("m_d"), other.get("m_e")], [second, first]);
  elsewhere("m_a", first);
  check("a key held is believed until storage says it moved", other.get("m_a"), second);
  told("reemoat.somethingElse");
  check("another key's change is not that", other.get("m_a"), second);
  told(KEY);
  check("and its own change drops what was held, so the next read is storage's", other.get("m_a"), first);
  check("it listens once, however often it reads", [other.get("m_nobody"), heard.length], [null, 1]);

  const whole = storage.get(KEY) ?? "";
  storage.set(KEY, "{\"https://one.example\":{\"m_a\":");
  told(KEY);
  check("a value nobody can read is nothing held, not a throw", [other.get("m_a"), other.get("m_b")], [null, null]);
  storage.set(KEY, JSON.stringify({ [ONE]: { m_a: "not a key", m_b: second }, "https://three.example": "nor is this" }));
  told(KEY);
  check("and of a value half readable, the half that reads is kept", [other.get("m_a"), other.get("m_b")], [null, second]);

  // Private mode: storage refuses both ways, and this document's own copy still governs the session.
  const real = { getItem: page.localStorage.getItem, setItem: page.localStorage.setItem };
  page.localStorage.getItem = (): string | null => {
    throw new Error("storage is off");
  };
  page.localStorage.setItem = (): void => {
    throw new Error("storage is off");
  };
  told(KEY);
  let threw = false;
  try {
    other.set("m_f", first);
  } catch {
    threw = true;
  }
  check("storage that refuses is survived, and the key set is still the key held", [threw, other.get("m_f"), other.get("m_a")], [false, first, null]);
  other.set("m_a", second);
  page.localStorage.getItem = real.getItem;
  storage.set(KEY, whole);
  told(KEY);
  check(
    "a key storage would not keep outranks the older one it still holds, for as long as this document lives",
    [onDisk()[ONE]?.["m_a"], other.get("m_a"), other.get("m_f")],
    [first, second, first],
  );
  page.localStorage.setItem = real.setItem;
  other.set("m_g", second);
  check("and is written with the next key that storage does take", [onDisk()[ONE]?.["m_a"], onDisk()[ONE]?.["m_f"], onDisk()[ONE]?.["m_g"]], [second, first, second]);
  storage.set(KEY, whole);
  told(KEY);
  if (listening === undefined) delete page.addEventListener;
  else page.addEventListener = listening;
}

/** A channel factory that records the key each channel was built with, and answers or refuses as told. */
function channels(behaviour: { answer: () => "ok" | "dead" | "pending" }): {
  factory: never;
  built: string[];
} {
  const built: string[] = [];
  const factory = ((options: { machineKey: string }) => {
    built.push(options.machineKey);
    return {
      async request(): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: Uint8Array }> {
        const { ChannelRefused, DEVICE_NOT_APPROVED } = await import("../src/e2ee.js");
        const outcome = behaviour.answer();
        if (outcome === "dead") throw new Error("the channel closed");
        if (outcome === "pending") throw new ChannelRefused(403, DEVICE_NOT_APPROVED);
        return {
          status: 200,
          statusText: "OK",
          headers: {},
          body: new TextEncoder().encode(JSON.stringify({ ok: true, instanceId: "i_x" })),
        };
      },
      openSocket(): unknown {
        throw new Error("no socket in this driver");
      },
      dropRedialable(): void {},
      dropIdle(): void {},
      closeDialledBefore(): void {},
      dispose(): void {},
    };
  }) as never;
  return { factory, built };
}

function mintsWith(key: () => string | null): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url !== "/v1/tokens") throw new TypeError(`unexpected request ${url}`);
    const now = Date.now();
    const named = key();
    return new Response(
      JSON.stringify({
        token: "jws",
        expiresAt: now + 300_000,
        serverTime: now,
        machine: { relayUrl: RELAY, relayOnline: true, ...(named === null ? {} : { key: named }) },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

{
  const cp = await import("../src/cp.js");
  const { MachineConnection } = await import("../src/machine.js");
  cp.setSession("rs_trust");

  const held = new Map<string, string>();
  const pins = { get: (id: string) => held.get(id) ?? null, set: (id: string, key: string) => void held.set(id, key) };
  const print = (key: string): string => keyFingerprint(Buffer.from(key, "base64url"));
  let named: string | null = first;
  let outcome: "ok" | "dead" | "pending" = "ok";
  let inDoubt = false;
  const { factory, built } = channels({ answer: () => outcome });
  const restore = mintsWith(() => named);
  const connection = new MachineConnection(
    { id: "m_trust", name: "mac-mini", relayUrl: RELAY, relayOnline: true, enrolled: true, owned: true, scopes: [] } as never,
    () => {},
    factory,
    { pins, devicePublicKey: () => b64(device.publicKey), linkInDoubt: () => inDoubt },
  );

  await connection.resolveRoute();
  check("the first key the server names is the one dialled", built, [first]);
  check("and is kept on this device from then on", held.get("m_trust"), first);
  check("the machine is drawn up", connection.state().reach, "online");
  check("with the fingerprint of the key in use", connection.state().keyFingerprint, keyFingerprint(Buffer.from(first, "base64url")));
  check("and nothing offered beside it", connection.state().offeredKeyFingerprint, null);

  // The server names another key while the machine still answers on the old one: a lie, or a pin it lost.
  named = second;
  await connection.ensureToken(true);
  connection.forgetRoute();
  await connection.resolveRoute();
  check("a different key named later is not dialled", built.includes(second), false);
  check("and the machine it was pinned to still answers, so nothing is asked of anybody", [connection.state().reach, connection.state().offlineReason], ["online", null]);
  check("the key held is still the first", held.get("m_trust"), first);

  // Now the held key stops answering: the machine was reinstalled, and only a person can say so.
  outcome = "dead";
  // The server that names the other key carries the relay too: with the link itself in question, a dead probe says nothing of a key.
  inDoubt = true;
  connection.forgetRoute();
  await connection.resolveRoute();
  check(
    "a probe that fails while the device is offline or the server is not answering is a dead wire, whatever key is on offer",
    [connection.state().offlineReason, connection.state().offeredKeyFingerprint],
    ["no_route", print(second)],
  );
  inDoubt = false;
  await connection.resolveRoute();
  check("when the held key no longer answers, the change is what is said, not a dead wire", connection.state().offlineReason, "machine_key_changed");
  check("naming the key that trusting would switch to", connection.state().offeredKeyFingerprint, keyFingerprint(Buffer.from(second, "base64url")));
  check("and still nothing was dialled with it", built.includes(second), false);

  outcome = "ok";
  const before = JSON.stringify(connection.state());
  check(
    "trusting a fingerprint that is not the one on offer pins nothing and changes nothing",
    [connection.acceptOfferedKey(print(first)), connection.acceptOfferedKey(""), held.get("m_trust"), JSON.stringify(connection.state()) === before, built.includes(second)],
    [false, false, first, true, false],
  );
  check("trusting the one that was compared is a step somebody takes", connection.acceptOfferedKey(print(second)), true);
  check("after which it is the key held", held.get("m_trust"), second);
  await connection.resolveRoute();
  check("and the one dialled", built[built.length - 1], second);
  check("with nothing left to confirm", [connection.state().reach, connection.state().offeredKeyFingerprint], ["online", null]);
  check("and there is nothing to trust a second time", connection.acceptOfferedKey(print(second)), false);

  // The machine is locked and this device is not on its list.
  outcome = "pending";
  connection.forgetRoute();
  await connection.resolveRoute();
  check("a machine that will not let this device in is not called unreachable", connection.state().offlineReason, "device_pending");
  check(
    "and the device shows the code the machine's owner sees beside the request",
    connection.state().approvalCode,
    approvalCode(device.publicKey),
  );
  outcome = "ok";
  connection.forgetRoute();
  await connection.resolveRoute();
  check("once let in it is simply up", [connection.state().reach, connection.state().offlineReason, connection.state().approvalCode], ["online", null, null]);

  // Dropped while connected: an ordinary request, not a probe, meets the refusal.
  outcome = "pending";
  const refused = await connection.request("/sessions").then(
    () => "answered",
    (error: unknown) => (error as { code?: string }).code ?? "threw",
  );
  check("a request refused that way reports the machine's own word", refused, "device_not_approved");
  check("and leaves the machine waiting rather than up", [connection.state().reach, connection.state().offlineReason], ["offline", "device_pending"]);

  // A server that names no key at all, on a device that holds one.
  outcome = "ok";
  named = null;
  await connection.ensureToken(true);
  connection.forgetRoute();
  await connection.resolveRoute();
  check("a server that stops naming a key costs nothing: the held one is dialled", [connection.state().reach, built[built.length - 1]], ["online", second]);

  // The listing names the key too, and is asked the moment a machine stops answering: no token renewal has to come round first.
  const record = (key: string | null | undefined) =>
    ({ id: "m_listed", name: "nas", relayUrl: RELAY, relayOnline: true, enrolled: true, owned: true, scopes: [], ...(key === undefined ? {} : { key }) }) as never;
  const listedHeld = new Map<string, string>();
  const listedPins = { get: (id: string) => listedHeld.get(id) ?? null, set: (id: string, key: string) => void listedHeld.set(id, key) };
  const listed = new MachineConnection(record(first), () => {}, factory, { pins: listedPins, devicePublicKey: () => null });
  check("a machine first heard of in a listing is pinned from it", listedHeld.get("m_listed"), first);
  listed.update(record(second));
  check("a listing that names another key changes nothing held", listedHeld.get("m_listed"), first);
  check("and is remembered as an offer", listed.state().offeredKeyFingerprint, keyFingerprint(Buffer.from(second, "base64url")));
  listed.update(record(undefined));
  check("an older server's listing, which names no key, takes the offer no further and no way back", listed.state().offeredKeyFingerprint, keyFingerprint(Buffer.from(second, "base64url")));
  listed.update(record(first));
  check("and a listing back on the held key withdraws it", listed.state().offeredKeyFingerprint, null);

  // Every listing can replace the offer while the question is open: what is trusted is what was compared, or nothing is.
  const third = b64(generateStaticKey().publicKey);
  listed.update(record(second));
  const compared = listed.state().offeredKeyFingerprint;
  listed.update(record(third));
  check(
    "an offer replaced while somebody was comparing is not what they agreed to",
    [listed.acceptOfferedKey(compared ?? ""), listedHeld.get("m_listed"), listed.state().offeredKeyFingerprint],
    [false, first, print(third)],
  );

  // Through the store, which is what the screen calls.
  const { store } = await import("../src/store.js");
  const { machineId } = await import("../src/ids.js");
  const internals = store as unknown as { connections: Map<string, unknown>; nextProbeAt: Map<string, number>; probeFailures: Map<string, number> };
  internals.connections.set("m_listed", listed);
  internals.nextProbeAt.set("m_listed", Date.now() + 60_000);
  internals.probeFailures.set("m_listed", 3);
  check(
    "the store refuses the same stale fingerprint, and says so",
    [store.trustMachineKey(machineId("m_listed"), compared ?? ""), listedHeld.get("m_listed"), internals.nextProbeAt.has("m_listed")],
    [false, first, true],
  );
  check("and one for a machine it does not hold", store.trustMachineKey(machineId("m_nowhere"), print(third)), false);
  check(
    "with the fingerprint on offer it pins, and the machine is asked again at once",
    [store.trustMachineKey(machineId("m_listed"), print(third)), listedHeld.get("m_listed"), internals.nextProbeAt.has("m_listed"), internals.probeFailures.has("m_listed")],
    [true, third, false, false],
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("on the key that was trusted", [built[built.length - 1], listed.state().offeredKeyFingerprint], [third, null]);
  store.forgetMachine(machineId("m_listed"));

  const fresh = new MachineConnection(
    { id: "m_keyless", name: "old", relayUrl: RELAY, relayOnline: true, enrolled: true, owned: true, scopes: [] } as never,
    () => {},
    factory,
    { pins, devicePublicKey: () => null },
  );
  await fresh.resolveRoute();
  check("while one never reached and never named a key has no route, as before", fresh.state().offlineReason, "no_machine_key");
  restore();
}

{
  const { deviceName, deviceRows, mayLetIn, removable, waitingMachine, waitingText } = await import("../src/deviceAccess.js");
  const row = (extra: Record<string, unknown>) =>
    ({
      id: "k1",
      kind: "device",
      label: "Laptop",
      platform: "macos",
      subject: "u_a",
      ref: null,
      state: "known",
      firstSeenAt: 1,
      lastSeenAt: 2,
      code: "AAAAA-BBBBB",
      ...extra,
    }) as never;

  check("a device is called what it calls itself", deviceName({ label: "Laptop", kind: "device" }), "Laptop");
  check("one that said nothing still has words", deviceName({ label: null, kind: "device" }), "Unnamed device");
  check("and a linked machine is never called a device", deviceName({ label: null, kind: "machine" }), "A linked machine");

  const mixed = [row({ id: "a" }), row({ id: "b", state: "pending" }), row({ id: "c", state: "pending" })];
  check(
    "under the lock the waiting rows are their own band",
    [deviceRows({ lock: true, fingerprint: null, you: null, devices: mixed }).waiting.length, deviceRows({ lock: true, fingerprint: null, you: null, devices: mixed }).known.length],
    [2, 1],
  );
  check(
    "with it off nothing is waiting on anybody, whatever rows are left over",
    deviceRows({ lock: false, fingerprint: null, you: null, devices: mixed }).waiting,
    [],
  );
  check("nothing waiting draws no word", [waitingText(0), waitingText(-1)], [null, null]);
  check("and a count draws one", [waitingText(1), waitingText(3)], ["1 waiting", "3 waiting"]);
  check("the device asking is not offered its own removal", [removable({ id: "k1" }, "k1"), removable({ id: "k1" }, "k2"), removable({ id: "k1" }, null)], [false, true, true]);

  // Letting a device in is a machine admin's act: nobody else is told one is waiting, whatever a listing carried.
  const { machineId } = await import("../src/ids.js");
  const guest = { id: machineId("m_guest"), scopes: ["session:read", "session:write"] as const };
  const admin = { id: machineId("m_admin"), scopes: ["session:read", "session:write", "machine:admin"] as const };
  check("only a machine's admin may let a device in", [mayLetIn(guest), mayLetIn(admin), mayLetIn({ scopes: [] })], [false, true, false]);
  const count = (pairs: [string, number][]): Map<never, number> => new Map(pairs) as Map<never, number>;
  check(
    "the bell counts a waiting device only on a machine this account may let it in to",
    [
      waitingMachine([guest, admin], count([["m_guest", 2], ["m_admin", 1]])),
      waitingMachine([guest, admin], count([["m_guest", 2]])),
      waitingMachine([guest, admin], count([["m_admin", 0]])),
      waitingMachine([guest, admin], count([])),
      waitingMachine([], count([["m_admin", 1]])),
    ],
    ["m_admin", null, null, null, null],
  );
}

{
  // The four calls the screen makes, as they leave: read off a stand-in connection, then held against the daemon's own route table.
  const { DaemonClient } = await import("../src/daemon.js");
  const { slowRoute } = await import("../src/machine.js");
  const sent: { path: string; method: string; body: unknown; type: string | null }[] = [];
  const client = new DaemonClient({
    request: (path: string, init: RequestInit = {}): Promise<unknown> => {
      sent.push({
        path,
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null,
        type: (init.headers as Record<string, string> | undefined)?.["content-type"] ?? null,
      });
      return Promise.resolve({});
    },
  } as never);
  const self = { publicKey: b64(device.publicKey), name: "Laptop", platform: "macos" };
  await client.devices();
  await client.setDeviceLock(true, self);
  await client.setDeviceLock(true, null);
  await client.setDeviceLock(false, self);
  await client.approveDevice("k/1 a");
  await client.removeDevice("k/1 a");
  check(
    "the list is read, a device is let in and one is removed at the addresses the machine serves, an id escaped",
    sent.filter((one) => !one.path.endsWith("/lock")).map((one) => `${one.method} ${one.path}`),
    ["GET /devices", "POST /devices/k%2F1%20a/approve", "DELETE /devices/k%2F1%20a"],
  );
  check(
    "turning the lock on carries this device's own key and name, so whoever locks is let in beside it; a shell with none sends none, and unlocking never does",
    sent.filter((one) => one.path.endsWith("/lock")).map((one) => [one.method, one.path, one.type, one.body]),
    [
      ["PUT", "/devices/lock", "application/json", { on: true, device: self }],
      ["PUT", "/devices/lock", "application/json", { on: true }],
      ["PUT", "/devices/lock", "application/json", { on: false }],
    ],
  );
  check("none of them waits on an agent, so each keeps the ordinary budget", sent.filter((one) => slowRoute(one.method, one.path)), []);
  const served = stripComments(readFileSync(new URL("../../../src/server.ts", import.meta.url), "utf8"));
  const shape = (one: { path: string; method: string }): string =>
    `app.${one.method.toLowerCase()}("${one.path.replace(/^\/devices\/k%2F1%20a/, "/devices/:id")}"`;
  check("and the daemon serves every one of them under that verb", sent.filter((one) => !served.includes(shape(one))).map(shape), []);
}

{
  const { parseSettingsRoute, settingsPaneTitle, settingsUp, machineListPath } = await import("../src/settings.js");
  const { machineId } = await import("../src/ids.js");
  const route = parseSettingsRoute(["machines", "m_1", "devices"]);
  check("a machine's device list is a screen of its own", [route.list, route.machineId], ["devices", "m_1"]);
  check("built by the same function that parses it", machineListPath(machineId("m_1"), "devices"), "/settings/machines/m_1/devices");
  check("one level under the machine", settingsUp(route)?.path, "/settings/machines/m_1");
  check("and not named as the account's own Devices screen is", [settingsPaneTitle(route), settingsPaneTitle(parseSettingsRoute(["devices"]))], ["Device access", "Devices"]);
}

{
  const { OFFLINE_TEXT } = await import("../src/ui/bits.js");
  check("the two new states are two sentences", OFFLINE_TEXT.machine_key_changed === OFFLINE_TEXT.device_pending, false);
  report(
    "each ending where it is acted on",
    /Settings → Machines$/.test(OFFLINE_TEXT.machine_key_changed) && /Settings → Machines$/.test(OFFLINE_TEXT.device_pending),
    `${OFFLINE_TEXT.machine_key_changed} / ${OFFLINE_TEXT.device_pending}`,
  );
  // The server that names the other key carries the relay as well, so a change is its claim and never this app's.
  check(
    "a held key that stopped answering is said as what is known: no answer on it, and the server naming another",
    [/key changed|has changed|was changed/.test(OFFLINE_TEXT.machine_key_changed), /not answering on the key this device holds/.test(OFFLINE_TEXT.machine_key_changed), /the server names another/.test(OFFLINE_TEXT.machine_key_changed)],
    [false, true, true],
  );

  const web = stripComments(srcFile("e2ee.ts"));
  const daemon = stripComments(readFileSync(new URL("../../../src/e2ee.ts", import.meta.url), "utf8"));
  const literal = (source: string): string | null => /export const DEVICE_NOT_APPROVED = "([a-z_]+)";/.exec(source)?.[1] ?? null;
  // The app may import neither src/ nor the daemon's constant, so the two spellings are compared here and nowhere else.
  report("the refusal is spelled the same at both ends", literal(web) !== null && literal(web) === literal(daemon), String(literal(web)));
  check("the hello carries what this device calls itself, when it has a name", /\.\.\.\(this\.device === null \? \{\} : \{ device: this\.device \}\)/.test(web), true);

  const machine = stripComments(srcFile("machine.ts"));
  check("the key the server names is weighed, never assigned", /this\.machineKey = issued\.machine\.key/.test(machine), false);
  check("and a key read over loopback is the machine's own word", /this\.learnLocalKey\(health\.machineKey\);/.test(machine), true);

  const storeSrc = stripComments(srcFile("store.ts"));
  check(
    "the store tells every connection when a failed probe proves nothing about a key: the device offline, or the server not answering",
    [
      /linkInDoubt: \(\) => this\.snapshot\.device === "offline" \|\| serverTroubled\(this\.serverRaw\.state\),/.test(storeSrc),
      (storeSrc.match(/new MachineConnection\(/g) ?? []).length,
      (storeSrc.match(/this\.connect\(record\)/g) ?? []).length,
      /import \{[^}]*\} from "\.\/store"/.test(machine),
    ],
    [true, 1, 2, false],
  );
  check(
    "and passes the fingerprint somebody compared down to the connection, answering whether it took",
    /trustMachineKey\(id: MachineId, expected: string\): boolean \{\s*const connection = this\.connections\.get\(id\);\s*if \(connection === undefined \|\| !connection\.acceptOfferedKey\(expected\)\) return false;/.test(storeSrc),
    true,
  );

  const screen = stripComments(srcFile("ui/settings/MachineDevicesSection.tsx"));
  check("turning the lock on is one tap, and only unlocking is confirmed", /if \(answer\.lock\) setUnlocking\(true\);\s*else void setLock\(true\)/.test(screen), true);
  // The name is the device's own claim, so the code shares a line with none of it: armed or at rest.
  const CODE = /const CODE = "([^"]+)";/.exec(screen)?.[1] ?? "";
  check("a code is mono and never broken at its hyphen, nor cut short", [CODE.split(" ").includes("font-mono"), CODE.split(" ").includes("whitespace-nowrap"), /truncate|line-clamp|overflow-hidden/.test(CODE)], [true, true, false]);
  const nameLine = /<span className="flex min-w-0 items-center gap-2">([\s\S]*?)\n {8}<\/span>/.exec(screen)?.[1] ?? "";
  report("the waiting row's name line was found", nameLine.includes("<Badge"), `${String(nameLine.length)} chars`);
  check(
    "at rest the code has a line of its own, holding nothing a device chose",
    [
      /<span className=\{`block text-muted \$\{CODE\}`\}>\s*<span className="sr-only">code <\/span>\s*\{row\.code\}\s*<\/span>/.test(screen),
      /row\.code|CODE/.test(nameLine),
      (screen.match(/\{row\.code\}/g) ?? []).length,
    ],
    [true, false, 1],
  );
  check(
    "the name keeps its own line's width, and its direction to itself",
    [/<span className="min-w-0 truncate font-medium">\s*<bdi>\{name\}<\/bdi>\s*<\/span>/.test(nameLine), (screen.match(/<bdi>\{name\}<\/bdi>/g) ?? []).length, /\$\{name\}\?`/.test(screen)],
    [true, 2, false],
  );
  check(
    "letting a device in names the code to compare before it happens, as a code and not as prose",
    [
      /confirming === "approve"\s*\? approveOnly\(row\.code\)/.test(screen),
      /Only if it shows <span className=\{CODE\}>\{code\}<\/span>\./.test(screen),
      /Only if it shows \$\{/.test(screen),
    ],
    [true, true, false],
  );
  check(
    "a list that could not be read says so with a way to ask again, and is never drawn as an empty one",
    [
      /<Empty\s+failed\s+action=\{\s*<Button size="sm" onClick=\{ask\}>\s*Try again\s*<\/Button>\s*\}\s*>\s*Could not read this machine's devices\.\s*<\/Empty>/.test(screen),
      /if \(meansRouteAbsent\(cause\)\) setAbsent\(true\);\s*else setUnread\(true\);/.test(screen),
      screen.indexOf("if (unread) {") !== -1 && screen.indexOf("if (unread) {") < screen.indexOf("No device has connected through the relay yet."),
      (screen.match(/setError\(errorText\(cause\)\)/g) ?? []).length,
      /else void setLock\(true\)\.catch\(\(cause: unknown\) => setError\(errorText\(cause\)\)\);/.test(screen),
    ],
    [true, true, true, 1, true],
  );
  check(
    "the count this screen wrote, coming back as the listing's, is not a cue to read the list it already holds",
    [
      /const count = deviceRows\(next\)\.waiting\.length;\s*wrote\.current = count;[\s\S]{0,120}store\.noteDevicesWaiting\(machineId, count\);/.test(screen),
      /const own = wrote\.current === waiting;\s*wrote\.current = null;\s*if \(!own\) ask\(\);/.test(screen),
      /\}, \[machineId, waiting\]\);/.test(screen),
    ],
    [true, true, true],
  );
  // Order is the property: armed, Cancel takes the last button's pixels, so the act that widens access must be the last one at rest.
  const rest = /rest=\{\s*<span className="ml-auto flex gap-2">([\s\S]*?)<\/span>\s*\}/.exec(screen)?.[1] ?? "";
  report("letting a device in is the last button at rest, so a double tap lands on Cancel", rest.indexOf("Let in") > rest.indexOf("Deny") && rest.indexOf("Deny") !== -1, "Deny, then Let in");
  check("and the device asking gets no button over its own row", /\{!own && decision\}/.test(screen), true);

  const section = stripComments(srcFile("ui/settings/MachineSection.tsx"));
  check("a changed key is trusted through a confirmation", /question=\{<>Trust \{machine\.name\}'s new key\?<\/>\}/.test(section), true);
  check("which is offered only while the held key no longer answers", /machine\.offlineReason === "machine_key_changed" && machine\.offeredKeyFingerprint !== null/.test(section), true);
  check(
    "what is trusted is the fingerprint on offer when the question was armed, and a refusal says the offer changed",
    [
      /const \[trusting, setTrusting\] = useState<string \| null>\(null\);/.test(section),
      /<Button size="sm" onClick=\{\(\) => setTrusting\(machine\.offeredKeyFingerprint\)\}>\s*Trust\s*<\/Button>/.test(section),
      /armed=\{trusting !== null\}\s*onArm=\{\(next\) => \{\s*if \(!next\) setTrusting\(null\);\s*\}\}/.test(section),
      /const trust = \(\): void => \{\s*if \(trusting !== null && store\.trustMachineKey\(machine\.id, trusting\)\) return;\s*toast\("error", "The key on offer changed\. Compare it again\."\);\s*\};/.test(section),
      /onAct=\{trust\}/.test(section),
      (section.match(/store\.trustMachineKey\(/g) ?? []).length,
    ],
    [true, true, true, true, true, 1],
  );
  check(
    "and its consequence says where the true value is: what the machine's own daemon prints",
    [/Only if its daemon prints this fingerprint at start, or\{" "\}\s*<span className="font-mono text-2xs">pnpm client devices<\/span> does\./.test(section), /Only after reinstalling/.test(section)],
    [true, false],
  );
  // A device waiting to be let in, or holding a key the server no longer names, cannot list the machine at all.
  const security = section.indexOf('<Group title="Security">');
  const listableArm = section.indexOf("{listable ? (");
  const unreachableArm = section.indexOf("<NotReachable machine={machine} />");
  check(
    "the Security group is drawn outside the listable gate, by the key held or by what this account may do there",
    [
      /\{\(machine\.keyFingerprint !== null \|\| devicesOffered\) && \(\s*<Group title="Security">/.test(section),
      listableArm !== -1 && unreachableArm > listableArm && security > unreachableArm,
      /\{machine\.keyFingerprint !== null && <ValueRow title="Key fingerprint" value=\{machine\.keyFingerprint\} mono \/>\}/.test(section),
    ],
    [true, true, true],
  );
  check(
    "a device waiting to be let in reads its code there, in mono",
    /\{machine\.approvalCode !== null && <ValueRow title="Approval code" value=\{machine\.approvalCode\} mono \/>\}/.test(section),
    true,
  );
  check(
    "the Device access row is drawn for a machine's admin, on a machine that can be listed",
    [/const devicesOffered = listable && mayLetIn\(machine\);/.test(section), /\{devicesOffered && \(\s*<LinkRow\s+title="Device access"/.test(section)],
    [true, true],
  );

  const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
  check(
    "the bell leads to a waiting device only when no session waits, and only on a machine this account may let it in to",
    /const asking = waiting\.length === 0 \? waitingMachine\(state\.machines, state\.devicesWaiting\) : null;/.test(browser),
    true,
  );
}
