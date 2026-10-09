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
  let named: string | null = first;
  let outcome: "ok" | "dead" | "pending" = "ok";
  const { factory, built } = channels({ answer: () => outcome });
  const restore = mintsWith(() => named);
  const connection = new MachineConnection(
    { id: "m_trust", name: "mac-mini", relayUrl: RELAY, relayOnline: true, enrolled: true, owned: true, scopes: [] } as never,
    () => {},
    factory,
    { pins, devicePublicKey: () => b64(device.publicKey) },
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
  connection.forgetRoute();
  await connection.resolveRoute();
  check("when the held key no longer answers, the change is what is said, not a dead wire", connection.state().offlineReason, "machine_key_changed");
  check("naming the key that trusting would switch to", connection.state().offeredKeyFingerprint, keyFingerprint(Buffer.from(second, "base64url")));
  check("and still nothing was dialled with it", built.includes(second), false);

  outcome = "ok";
  check("trusting it is a step somebody takes", connection.acceptOfferedKey(), true);
  check("after which it is the key held", held.get("m_trust"), second);
  await connection.resolveRoute();
  check("and the one dialled", built[built.length - 1], second);
  check("with nothing left to confirm", [connection.state().reach, connection.state().offeredKeyFingerprint], ["online", null]);
  check("and there is nothing to trust a second time", connection.acceptOfferedKey(), false);

  // The machine is locked and this device is not on its list.
  outcome = "pending";
  connection.forgetRoute();
  await connection.resolveRoute();
  check("a machine that will not let this device in is not called unreachable", connection.state().offlineReason, "device_pending");
  check(
    "and the device shows the code the machine's owner sees beside the request",
    connection.state().approvalCode,
    approvalCode(device.publicKey, Buffer.from(second, "base64url")),
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
  const { deviceName, deviceRows, removable, waitingText } = await import("../src/deviceAccess.js");
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
    /Settings → Machines/.test(OFFLINE_TEXT.machine_key_changed) && /Settings → Machines/.test(OFFLINE_TEXT.device_pending),
    `${OFFLINE_TEXT.machine_key_changed} / ${OFFLINE_TEXT.device_pending}`,
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

  const screen = stripComments(srcFile("ui/settings/MachineDevicesSection.tsx"));
  check("turning the lock on is one tap, and only unlocking is confirmed", /if \(answer\.lock\) setUnlocking\(true\);\s*else void setLock\(true\)/.test(screen), true);
  check("letting a device in names the code to compare before it happens", /Only if it shows \$\{row\.code \?\? "this same code"\}/.test(screen), true);
  check("the code is drawn whole, in mono, beside the name", /<span className="shrink-0 font-mono text-2xs text-muted">\{row\.code\}<\/span>/.test(screen), true);
  // Order is the property: armed, Cancel takes the last button's pixels, so the act that widens access must be the last one at rest.
  const rest = /rest=\{\s*<span className="ml-auto flex gap-2">([\s\S]*?)<\/span>\s*\}/.exec(screen)?.[1] ?? "";
  report("letting a device in is the last button at rest, so a double tap lands on Cancel", rest.indexOf("Let in") > rest.indexOf("Deny") && rest.indexOf("Deny") !== -1, "Deny, then Let in");
  check("and the device asking gets no button over its own row", /\{!own && decision\}/.test(screen), true);

  const section = stripComments(srcFile("ui/settings/MachineSection.tsx"));
  check("a changed key is trusted through a confirmation", /question=\{<>Trust \{machine\.name\}'s new key\?<\/>\}/.test(section), true);
  check("which is offered only while the held key no longer answers", /machine\.offlineReason === "machine_key_changed" && machine\.offeredKeyFingerprint !== null/.test(section), true);

  const browser = stripComments(srcFile("ui/SessionBrowser.tsx"));
  check("the bell leads to a waiting device only when no session waits", /const asking = waiting\.length === 0 \? \(\[\.\.\.state\.devicesWaiting\.keys\(\)\]\[0\] \?\? null\) : null;/.test(browser), true);
}
