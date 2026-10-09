import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { Duplex, PassThrough } from "node:stream";
import {
  FRAME,
  LengthReader,
  NoiseHandshake,
  approvalCode,
  decodeFrame,
  decodeJson,
  encodeJsonFrame,
  frameLength,
  generateStaticKey,
  keyFingerprint,
  localStaticKey,
  type CipherState,
  type CloseFrame,
  type HelloFrame,
} from "@reemoat/protocol";
import { check, report } from "./daemoncheck.env.js";
import { app as bareApp, boundToken, now, registry, signedClaims, tokenFor, tokenWith, verifier } from "./daemoncheck.fixtures.js";
import {
  DeviceGate,
  decodeDeviceKey,
  readDeviceDescription,
  MAX_DEVICE_LABEL_CHARS,
  MAX_KNOWN_DEVICES,
  MAX_PENDING_DEVICES,
  PENDING_DEVICE_TTL_MS,
  type KnownDevice,
  type KnownDeviceStore,
} from "../src/devices.js";
import { DEVICE_NOT_APPROVED, serveSecureSession } from "../src/e2ee.js";
import { SHELL_ORIGINS, bindIsLoopback, hostIsLoopback, pageOriginAllowed } from "../src/origin.js";
import { createApp } from "../src/server.js";
import { SqliteKnownDeviceStore, SqliteMachineSettingsStore } from "../src/store/sqlite.js";
import { jwkThumbprint, x25519Jwk } from "../src/token.js";
import { sentFileName } from "../src/uploads.js";
import type { Principal } from "../src/auth.js";

process.stdout.write("\nthe devices a machine knows, and the lock over them\n");

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const kthOf = (publicKey: Uint8Array): string => jwkThumbprint(x25519Jwk(publicKey));

function realStore(): { store: SqliteKnownDeviceStore; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../src/store/schema.sql", import.meta.url), "utf8"));
  return { store: new SqliteKnownDeviceStore(db), db };
}

/** Counts writes, which is the only way to see that a second dial inside the interval wrote nothing, and whole-table reads. */
function counting(inner: SqliteKnownDeviceStore): KnownDeviceStore & { saves: number; lists: number } {
  return {
    saves: 0,
    lists: 0,
    get: (kth) => inner.get(kth),
    list() {
      this.lists += 1;
      return inner.list();
    },
    save(device: KnownDevice) {
      this.saves += 1;
      inner.save(device);
    },
    remove: (kth) => inner.remove(kth),
    locked: () => inner.locked(),
    setLocked: (on) => inner.setLocked(on),
    countPending: (seenAfter) => inner.countPending(seenAfter),
  };
}

/** Everything but the count, as a store that predates it: the gate then counts by the list. */
function uncounted(inner: KnownDeviceStore): KnownDeviceStore {
  return {
    get: (kth) => inner.get(kth),
    list: () => inner.list(),
    save: (device) => inner.save(device),
    remove: (kth) => inner.remove(kth),
    locked: () => inner.locked(),
    setLocked: (on) => inner.setLocked(on),
  };
}

function principal(extra: Partial<Principal> = {}): Principal {
  return {
    subject: "u_ab",
    scopes: ["session:read", "session:write", "machine:admin"],
    machineId: "m_self",
    expiresAt: null,
    tokenId: null,
    deviceId: "dv_one",
    keyThumbprint: null,
    via: "signed",
    link: null,
    ...extra,
  };
}

const machine = generateStaticKey();
const laptop = generateStaticKey();
const phone = generateStaticKey();
const intruder = generateStaticKey();
const peerOf = (key: { publicKey: Uint8Array }) => ({ kth: kthOf(key.publicKey), publicKey: key.publicKey });

{
  const { store, db } = realStore();
  check("a machine nobody has locked is not locked", store.locked(), false);
  db.prepare("INSERT INTO machine_settings (key, value) VALUES ('deviceLock', 'yes')").run();
  check("and a value this build cannot read does not lock it", store.locked(), false);
  store.setLocked(true);
  check("the one stored spelling of on does", store.locked(), true);
  store.setLocked(false);

  const row: KnownDevice = {
    kth: "kth-a",
    publicKey: b64(laptop.publicKey),
    kind: "device",
    label: "Laptop",
    platform: "macos",
    subject: "u_ab",
    ref: "dv_one",
    state: "known",
    firstSeenAt: 100,
    lastSeenAt: 100,
  };
  store.save(row);
  store.save({ ...row, label: "Laptop, renamed", firstSeenAt: 999, lastSeenAt: 200 });
  check("a second save replaces the row", store.get("kth-a")?.label, "Laptop, renamed");
  check("and leaves its age alone", store.get("kth-a")?.firstSeenAt, 100);
  check("while moving when it was last seen", store.get("kth-a")?.lastSeenAt, 200);

  db.prepare("UPDATE known_devices SET state = 'trusted' WHERE kth = 'kth-a'").run();
  check("a state this build cannot place reads as waiting, never as let in", store.get("kth-a")?.state, "pending");
  check("and is counted as waiting, as the list reads it", store.countPending(0), 1);
  check("a row counts only when it was seen after the moment asked about", [store.countPending(199), store.countPending(200)], [1, 0]);
  check("removing a row says it removed one", store.remove("kth-a"), true);
  check("and removing it again says it did not", store.remove("kth-a"), false);
}

{
  const store = counting(realStore().store);
  const gate = new DeviceGate(store, () => b64(machine.publicKey));
  const at = Date.now();

  check("unlocked, a key nobody has seen is let in", gate.admit(peerOf(laptop), principal(), { name: "Laptop", platform: "macos" }, at), true);
  const first = store.get(kthOf(laptop.publicKey));
  check("and recorded as known", first?.state, "known");
  check("under the name it gave itself", [first?.label, first?.platform], ["Laptop", "macos"]);
  check("with the Authority's id for it kept beside", first?.ref, "dv_one");

  const before = store.saves;
  gate.admit(peerOf(laptop), principal(), { name: "Laptop", platform: "macos" }, at + 1_000);
  check("a second dial a second later writes nothing", store.saves, before);
  gate.admit(peerOf(laptop), principal(), { name: "Laptop", platform: "macos" }, at + 6 * 60_000);
  check("one five minutes on moves the row", store.saves, before + 1);
  gate.admit(peerOf(laptop), principal(), null, at + 6 * 60_000 + 1);
  check("a build that names nothing does not blank the name", store.get(kthOf(laptop.publicKey))?.label, "Laptop");
  gate.admit(peerOf(laptop), principal(), { name: "Work laptop", platform: "macos" }, at + 6 * 60_000 + 2);
  check("and a new name is taken at once", store.get(kthOf(laptop.publicKey))?.label, "Work laptop");

  gate.admit(
    peerOf(phone),
    principal({ deviceId: null, link: { id: "lk_1", sourceMachineId: "m_other", sourceLabel: "mac-mini" } }),
    { name: "a name a machine should not get to choose", platform: "x" },
    at,
  );
  const linked = store.get(kthOf(phone.publicKey));
  check("a linked machine is filed as a machine", linked?.kind, "machine");
  check("named by its link, never by what it says of itself", [linked?.label, linked?.ref], ["mac-mini", "m_other"]);

  const dirty = generateStaticKey();
  const said = readDeviceDescription({ name: `  evil\u001b[2Jname\n${"x".repeat(400)}`, platform: "p".repeat(99) });
  gate.admit(peerOf(dirty), principal(), said, at);
  const cleaned = store.get(kthOf(dirty.publicKey));
  check("a description with no name is no description", readDeviceDescription({ platform: "ios" }), null);
  check("nor is one that is not an object", [readDeviceDescription("Laptop"), readDeviceDescription(null), readDeviceDescription([])], [null, null, null]);
  report("a name's control characters are gone before it is stored", !/[\u0000-\u001f]/.test(cleaned?.label ?? ""), JSON.stringify(cleaned?.label?.slice(0, 24)));
  check("and it is cut to its bound", [cleaned?.label?.length, cleaned?.platform?.length], [128, 32]);

  // A name is drawn beside the code somebody compares, so it may not carry one (Q1.656).
  const named = (name: string): string | null => readDeviceDescription({ name, platform: "" })?.name ?? null;
  const phoneCode = approvalCode(phone.publicKey);
  const machinePrint = keyFingerprint(machine.publicKey);
  const labelOf = (key: { publicKey: Uint8Array }): string | null | undefined => store.get(kthOf(key.publicKey))?.label;

  const spoof = generateStaticKey();
  gate.admit(peerOf(spoof), principal(), readDeviceDescription({ name: `Rends-iPhone  ${phoneCode}`, platform: "ios" }), at);
  check("a name carrying the code of a device that is waiting is stored without it", labelOf(spoof), "Rends-iPhone");
  check("whatever the code, by its shape alone", named("Rends-iPhone  7K2M9-PQ4XA"), "Rends-iPhone");
  check(
    "in either case, and with its hyphen a space, another dash, a letter drawn as one, or nothing",
    ["7k2m9-pq4xa", "7K2M9 PQ4XA", "7K2M9PQ4XA", "7K2M9\u2010PQ4XA", "7K2M9 \u2013 PQ4XA", "7K2M9\u30fcPQ4XA"].map((code) => named(`Phone ${code}`)),
    ["Phone", "Phone", "Phone", "Phone", "Phone", "Phone"],
  );
  check("nor in fullwidth letters, which are the same ten characters", named("Phone \uff17\uff2b\uff12\uff2d\uff19\uff0d\uff30\uff31\uff14\uff38\uff21"), "Phone");
  check(
    "a name carrying this machine's fingerprint loses that too, however it is spelled",
    [machinePrint, "f8bt 4p50 pc49 gm8e", machinePrint.replace(/-/g, "")].map((print) => named(`Laptop ${print}`)),
    ["Laptop", "Laptop", "Laptop"],
  );
  const words = ["Steve Adams", "Karen-James", "testserver", "server2024", "Smartwatch"];
  check("two words, or a word with a year, are a name and not a code", words.map(named), words);
  check("the same words in capitals are written as a code is, and go", [named("STEVE ADAMS"), named("Phone SERVER2024")], [null, "Phone"]);
  check("what turns the line round or takes no room is gone", named("Lap\u202etop\u200b \u2066Pro\u2069\ufeff"), "Laptop Pro");
  check(
    "so a code cannot be split by something nobody sees",
    [`7K\u200b2M9-PQ\u200d4XA`, `7K\ufe002M9-PQ4XA`, `\u202e7K2M9-PQ4XA`].map((code) => named(`Phone ${code}`)),
    ["Phone", "Phone", "Phone"],
  );
  const lost: string[] = [];
  for (let point = 0; point <= 0xffff; point += 1) {
    const one = String.fromCharCode(point);
    if ((point < 0xd800 || point > 0xdfff) && sentFileName(`a${one}b`) === "ab") lost.push(one);
  }
  const kept = lost.filter((one) => (named(`Lap${one}top`) ?? "").includes(one));
  report("nothing a sent file's name loses is kept in a device's", lost.length > 50 && kept.length === 0, `${lost.length} characters lost there, ${kept.length} kept here`);

  const ordinary = ["Rends-MacBook-Pro", "iPhone 16", "Rends-MacBook-Pro.local", "Rend\u2019s iPhone", "DESKTOP-AB12CDE", "mac-mini", "192.168.1.100", "\u041d\u043e\u0443\u0442\u0431\u0443\u043a"];
  check("an ordinary name is left exactly as it was said", ordinary.map(named), ordinary);
  check("one glued to a longer word is not a code and stays", named("Steves-Desktop"), "Steves-Desktop");

  check("a name that was only a code is no name at all", readDeviceDescription({ name: phoneCode, platform: "ios" }), null);
  const nameless = generateStaticKey();
  gate.admit(peerOf(nameless), principal(), readDeviceDescription({ name: phoneCode, platform: "ios" }), at);
  check("so its row is the one an unnamed device gets", gate.list(at).find((one) => one.id === kthOf(nameless.publicKey))?.label, null);
  check(
    "a cut cannot leave a code standing, nor can taking one out",
    [named(`${"a".repeat(MAX_DEVICE_LABEL_CHARS - 11)} 7K2M9PQ4XAZZZ`), named("7K2M9 ABCD-EFGH-JKMN-PQRS PQ4XA")],
    ["a".repeat(MAX_DEVICE_LABEL_CHARS - 11), null],
  );
  const halved = `${"x".repeat(MAX_DEVICE_LABEL_CHARS - 1)}\u{1f600}`;
  check("half a character is none, sent so or made by the cut", [named("Lap\ud83dtop"), named(halved)], ["Laptop", "x".repeat(MAX_DEVICE_LABEL_CHARS - 1)]);
  const cut = generateStaticKey();
  gate.admit(peerOf(cut), principal(), readDeviceDescription({ name: halved, platform: "" }), at);
  const savedOnce = store.saves;
  gate.admit(peerOf(cut), principal(), readDeviceDescription({ name: halved, platform: "" }), at + 1);
  check("so the row reads back as it was written, and its next dial writes nothing", store.saves, savedOnce);
  check(
    "the platform is held to the same rule",
    [readDeviceDescription({ name: "Laptop", platform: "mac\u202eos" }), readDeviceDescription({ name: "Laptop", platform: phoneCode })],
    [{ name: "Laptop", platform: "macos" }, { name: "Laptop", platform: "" }],
  );
  const linkSpoof = generateStaticKey();
  gate.admit(peerOf(linkSpoof), principal({ deviceId: null, link: { id: "lk_2", sourceMachineId: "m_far", sourceLabel: `mac\u202e-mini ${phoneCode}` } }), null, at);
  check("and so is the label a link gives a machine", labelOf(linkSpoof), "mac-mini");
  store.save({ ...store.get(kthOf(spoof.publicKey))!, label: `Old row ${phoneCode}`, platform: `ios ${machinePrint}` });
  const drawn = gate.list(at).find((one) => one.id === kthOf(spoof.publicKey));
  check("a row written some other way is listed under the rule all the same", [drawn?.label, drawn?.platform], ["Old row", "ios"]);
}

{
  const store = counting(realStore().store);
  const gate = new DeviceGate(store, () => b64(machine.publicKey));
  const at = Date.now();
  gate.admit(peerOf(laptop), principal(), { name: "Laptop", platform: "macos" }, at);
  gate.setLocked(true);

  check("locked, the device already known is still let in", gate.admit(peerOf(laptop), principal(), null, at + 1), true);
  check("and one the Authority vouches for but this machine has not seen is refused", gate.admit(peerOf(phone), principal({ deviceId: "dv_two" }), { name: "Phone", platform: "ios" }, at + 2), false);
  check("recorded as waiting", store.get(kthOf(phone.publicKey))?.state, "pending");
  const listsBefore = store.lists;
  check("which the count the poll carries says", gate.pendingCount(at + 3), 1);
  check("counted where the rows are kept, with the table never read out for it", store.lists, listsBefore);
  check("asking again is refused again", gate.admit(peerOf(phone), principal({ deviceId: "dv_two" }), null, at + 4), false);

  const listed = gate.list(at + 5);
  check("the waiting one is listed first", listed.map((one) => one.label), ["Phone", "Laptop"]);
  const code = listed[0]?.code ?? "";
  check("with the code both screens derive", code, approvalCode(phone.publicKey));
  report("which is ten characters in two groups", /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(code), code);
  check("and another for another device", code === approvalCode(intruder.publicKey), false);
  check("the machine's own fingerprint is the one its key gives", gate.fingerprint(), keyFingerprint(machine.publicKey));

  check("the code finds the row as it is read aloud", gate.find(code.toLowerCase().replace("-", " "))?.kth, kthOf(phone.publicKey));
  check("and so does the id", gate.find(kthOf(phone.publicKey))?.kth, kthOf(phone.publicKey));
  check("a code nothing shows finds nothing", gate.find("ZZZZZ-ZZZZZ"), null);
  check("approving something that is not there says so", gate.approve("no-such"), false);
  check("approving the waiting one says so", gate.approve(kthOf(phone.publicKey)), true);
  check("after which it is let in", gate.admit(peerOf(phone), principal({ deviceId: "dv_two" }), null, at + 6), true);
  check("and nothing is waiting any more", gate.pendingCount(at + 7), 0);

  let ended = 0;
  const forget = gate.watch(kthOf(phone.publicKey), () => {
    ended += 1;
  });
  const other = gate.watch(kthOf(laptop.publicKey), () => {
    ended += 100;
  });
  check("removing a device ends the channels open on its key", [gate.remove(kthOf(phone.publicKey)), ended], [true, 1]);
  check("and it is refused at its next dial", gate.admit(peerOf(phone), principal({ deviceId: "dv_two" }), null, at + 8), false);
  forget();
  other();
  gate.remove(kthOf(laptop.publicKey));
  check("a watcher that was given back is not called", ended, 1);
}

{
  const { store } = realStore();
  const gate = new DeviceGate(store, () => b64(machine.publicKey));
  const at = Date.now();
  gate.admit(peerOf(laptop), principal(), null, at);
  gate.setLocked(true);
  const asked: string[] = [];
  for (let n = 0; n < MAX_PENDING_DEVICES + 3; n += 1) {
    const key = generateStaticKey();
    asked.push(kthOf(key.publicKey));
    gate.admit(peerOf(key), principal(), { name: `flood ${n}`, platform: "" }, at + 10 + n);
  }
  const waiting = store.list().filter((one) => one.state === "pending");
  check("a flood of requests is bounded", waiting.length, MAX_PENDING_DEVICES);
  check("by dropping the oldest", [store.get(asked[0]!), store.get(asked[2]!)], [null, null]);
  report("and never a device already let in", store.get(kthOf(laptop.publicKey))?.state === "known", "the known row survived the flood");
  const flooded = at + 10 + MAX_PENDING_DEVICES + 3;
  check("the count says as many as are waiting", gate.pendingCount(flooded), MAX_PENDING_DEVICES);
  check("and a store with no count of its own is counted by its list, to the same number", new DeviceGate(uncounted(store), () => null).pendingCount(flooded), MAX_PENDING_DEVICES);
  gate.setLocked(false);
  check("with the lock off the same rows wait on nobody", [gate.pendingCount(flooded), new DeviceGate(uncounted(store), () => null).pendingCount(flooded)], [0, 0]);
  gate.setLocked(true);
  check(
    "a request nobody answered in a day is not counted, before anything has swept it",
    [gate.pendingCount(at + 1_000 + PENDING_DEVICE_TTL_MS), new DeviceGate(uncounted(store), () => null).pendingCount(at + 1_000 + PENDING_DEVICE_TTL_MS), store.list().filter((one) => one.state === "pending").length],
    [0, 0, MAX_PENDING_DEVICES],
  );

  check("a request nobody answered in a day is gone", gate.list(at + 1_000 + PENDING_DEVICE_TTL_MS).filter((one) => one.state === "pending").length, 0);
  check("and the known row is not", gate.list(at + 1_000 + PENDING_DEVICE_TTL_MS).length, 1);
}

{
  const { store } = realStore();
  const gate = new DeviceGate(store, () => b64(machine.publicKey));
  const at = Date.now();
  const known = (): number => store.list().filter((one) => one.state === "known").length;
  for (let n = 0; n < MAX_KNOWN_DEVICES + 2; n += 1) gate.admit(peerOf(generateStaticKey()), principal(), null, at + n);
  check("unlocked, the journal is bounded", store.list().length, MAX_KNOWN_DEVICES);
  gate.setLocked(true);
  gate.vouch(b64(laptop.publicKey), kthOf(laptop.publicKey), principal(), { name: "Laptop", platform: "macos" }, at + 1_000);
  check("locked, whoever turned it on is added past that bound", known(), MAX_KNOWN_DEVICES + 1);
  const later = at + 3_600_000;
  check(
    "and the list is never trimmed, every row being somebody's way in: not by a known device's dial, which writes its row",
    [gate.admit(peerOf(laptop), principal(), null, later), store.get(kthOf(laptop.publicKey))?.lastSeenAt, known()],
    [true, later, MAX_KNOWN_DEVICES + 1],
  );
  check("nor by the dial of one that has to wait", [gate.admit(peerOf(phone), principal(), null, later + 1), known()], [false, MAX_KNOWN_DEVICES + 1]);
  gate.setLocked(false);
  gate.admit(peerOf(generateStaticKey()), principal(), null, later + 2);
  check("unlocked again, the next new device's dial trims the journal back to its bound", known(), MAX_KNOWN_DEVICES);
  check("least recently seen first, so the device that was vouched for is still in", store.get(kthOf(laptop.publicKey))?.state, "known");
  check("a key that is not a key cannot be vouched for", gate.vouch("short", "kth", principal(), null), false);
  check(
    "a key is 43 characters of base64url that are 32 bytes, and nothing else is one",
    [decodeDeviceKey(b64(laptop.publicKey))?.length, decodeDeviceKey("short"), decodeDeviceKey(`${b64(laptop.publicKey)}A`), decodeDeviceKey(b64(laptop.publicKey).replace(/.$/, "+"))],
    [32, null, null, null],
  );

  const none = new DeviceGate(store, () => null);
  report("with no machine key every row still shows its code, which is of the asking key alone", none.list().every((one) => one.code !== null), `${none.list().length} rows`);
  check("and there is no fingerprint to show", none.fingerprint(), null);
  store.save({ ...store.get(kthOf(laptop.publicKey))!, publicKey: "not-a-key" });
  check("a stored key this build cannot read has no code", none.list().find((one) => one.id === kthOf(laptop.publicKey))?.code, null);
}

{
  const { store } = realStore();
  let broken: "none" | "write" | "read" = "none";
  const flaky: KnownDeviceStore = {
    get: (kth) => {
      if (broken === "read") throw new Error("SQLITE_BUSY");
      return store.get(kth);
    },
    list: () => store.list(),
    save: (device) => {
      if (broken !== "none") throw new Error("SQLITE_BUSY");
      store.save(device);
    },
    remove: (kth) => store.remove(kth),
    locked: () => store.locked(),
    setLocked: (on) => store.setLocked(on),
  };
  const gate = new DeviceGate(flaky, () => b64(machine.publicKey));
  broken = "write";
  check("unlocked, a journal row that will not land costs no channel", gate.admit(peerOf(laptop), principal(), null), true);
  broken = "none";
  gate.admit(peerOf(laptop), principal(), null);
  gate.setLocked(true);
  broken = "write";
  check("locked, a known device is let in though its row cannot be touched", gate.admit(peerOf(laptop), principal(), null, Date.now() + 3_600_000), true);
  check("and an unknown one is still refused though its request cannot be filed", gate.admit(peerOf(phone), principal(), null), false);
  broken = "read";
  check("a list that cannot be read lets nobody in, the known device included", gate.admit(peerOf(laptop), principal(), null), false);
}

// The channel: the same gate, behind the real responder.

const { store: channelStore, db: channelDb } = realStore();
const channelGate = new DeviceGate(channelStore, () => b64(machine.publicKey));
const lockedApp = createApp({
  registry,
  verifier,
  instanceId: "i_devices",
  startedAt: now,
  devices: channelGate,
  machineKey: () => b64(machine.publicKey),
  // The lock's own table, so PATCH /settings gets as far as its key census.
  machineSettings: new SqliteMachineSettingsStore(channelDb),
});
const listener = await new Promise<ReturnType<typeof serve>>((resolve) => {
  const started = serve({ fetch: lockedApp.app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(started));
});
const local = { host: "127.0.0.1", port: (listener.address() as AddressInfo).port };

class Dial {
  private readonly reader = new LengthReader();
  private readonly frames: { type: number; payload: Uint8Array }[] = [];
  private send: CipherState | null = null;
  private receive: CipherState | null = null;
  private wake: (() => void) | null = null;
  ended = false;

  private constructor(
    private readonly handshake: NoiseHandshake,
    private readonly out: PassThrough,
  ) {}

  static async open(secretKey: Uint8Array): Promise<Dial> {
    const toDaemon = new PassThrough();
    const toPeer = new PassThrough();
    const dial = new Dial(
      NoiseHandshake.start({ initiator: true, staticKey: localStaticKey(secretKey), remoteStatic: machine.publicKey }),
      toDaemon,
    );
    toPeer.on("data", (chunk: Buffer) => dial.consume(new Uint8Array(chunk)));
    toPeer.on("close", () => {
      dial.ended = true;
      dial.wake?.();
    });
    serveSecureSession({
      stream: Duplex.from({ readable: toDaemon, writable: toPeer }),
      staticKey: localStaticKey(machine.secretKey),
      verifier,
      devices: channelGate,
      local,
    });
    dial.out.write(frameLength(await dial.handshake.writeMessage()));
    await dial.until(() => dial.send !== null || dial.ended);
    return dial;
  }

  private consume(chunk: Uint8Array): void {
    for (const message of this.reader.push(chunk)) {
      if (this.send === null) {
        void this.handshake.readMessage(message).then(() => {
          const transport = this.handshake.split();
          this.send = transport.send;
          this.receive = transport.receive;
          this.wake?.();
        });
        continue;
      }
      const frame = decodeFrame(this.receive!.decrypt(new Uint8Array(0), message));
      if (frame !== null) this.frames.push(frame);
      this.wake?.();
    }
  }

  async until(done: () => boolean): Promise<void> {
    if (done()) return;
    await new Promise<void>((resolve) => {
      this.wake = () => {
        if (!done()) return;
        this.wake = null;
        resolve();
      };
      setTimeout(() => {
        this.wake = null;
        resolve();
      }, 4_000).unref();
    });
  }

  async hello(frame: HelloFrame): Promise<{ type: number; refusal: CloseFrame | null }> {
    this.out.write(frameLength(this.send!.encrypt(new Uint8Array(0), encodeJsonFrame(FRAME.HELLO, frame))));
    await this.until(() => this.frames.length > 0 || this.ended);
    const answer = this.frames.shift();
    if (answer === undefined) return { type: -1, refusal: null };
    return { type: answer.type, refusal: answer.type === FRAME.FAILED ? decodeJson<CloseFrame>(answer.payload) : null };
  }
}

{
  const laptopKth = kthOf(laptop.publicKey);
  const phoneKth = kthOf(phone.publicKey);

  const bad = await Dial.open(intruder.secretKey);
  const refused = await bad.hello({ capability: boundToken("u_ab", laptopKth), device: { name: "Not the laptop", platform: "x" } });
  check("a capability minted for another key is refused as before", refused.refusal?.reason, "wrong_device");
  check("and a caller with no capability of its own writes no row", channelStore.list().length, 0);

  const first = await Dial.open(laptop.secretKey);
  check("unlocked, a device the Authority vouches for is let in", (await first.hello({ capability: boundToken("u_ab", laptopKth), device: { name: "Laptop", platform: "macos" } })).type, FRAME.READY);
  check("and the machine now knows it by the name it gave", channelStore.get(laptopKth)?.label, "Laptop");

  const old = await Dial.open(phone.secretKey);
  check("a build that describes nothing is let in all the same", (await old.hello({ capability: boundToken("u_ab", phoneKth) })).type, FRAME.READY);
  check("and is listed with no name", channelStore.get(phoneKth)?.label, null);
  channelGate.remove(phoneKth);
  await old.until(() => old.ended);
  check("removing it ends the channel it had open", old.ended, true);

  channelGate.setLocked(true);
  const kept = await Dial.open(laptop.secretKey);
  check("locked, the known device still connects", (await kept.hello({ capability: boundToken("u_ab", laptopKth) })).type, FRAME.READY);

  const waiting = await Dial.open(phone.secretKey);
  const answer = await waiting.hello({ capability: boundToken("u_ab", phoneKth), device: { name: "Phone", platform: "ios" } });
  check("a capability the Authority signed is no longer enough", answer.type, FRAME.FAILED);
  check("and the refusal says which kind it is", [answer.refusal?.code, answer.refusal?.reason], [403, DEVICE_NOT_APPROVED]);
  await waiting.until(() => waiting.ended);
  check("the channel is torn down, not left open", waiting.ended, true);
  check("and the request is waiting on the machine", channelStore.get(phoneKth)?.state, "pending");

  const forged = await Dial.open(intruder.secretKey);
  const forgedAnswer = await forged.hello({
    capability: boundToken("u_ab", kthOf(intruder.publicKey)),
    device: { name: "Laptop", platform: "macos" },
  });
  check("a key of the Authority's own choosing, under a familiar name, waits like any other", forgedAnswer.refusal?.reason, DEVICE_NOT_APPROVED);
  const codes = channelGate.list().filter((one) => one.state === "pending").map((one) => one.code);
  check("and its code is not the phone's", new Set(codes).size, 2);

  channelGate.approve(phoneKth);
  const let_in = await Dial.open(phone.secretKey);
  check("once approved on the machine, the phone connects", (await let_in.hello({ capability: boundToken("u_ab", phoneKth) })).type, FRAME.READY);
  const still = await Dial.open(intruder.secretKey);
  check("and the other key still does not", (await still.hello({ capability: boundToken("u_ab", kthOf(intruder.publicKey)) })).refusal?.reason, DEVICE_NOT_APPROVED);

  const linkKey = generateStaticKey();
  const link = await Dial.open(linkKey.secretKey);
  const linkAnswer = await link.hello({
    capability: signedClaims({ lnk: "lk_9", src: "m_other", srcl: "mac-mini", cnf: { jkt: kthOf(linkKey.publicKey) } }),
  });
  check("another machine's link waits too", linkAnswer.refusal?.reason, DEVICE_NOT_APPROVED);
  check("filed as a machine under the link's own label", [channelStore.get(kthOf(linkKey.publicKey))?.kind, channelStore.get(kthOf(linkKey.publicKey))?.label], ["machine", "mac-mini"]);
}

// The routes.

async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  app = lockedApp.app,
): Promise<{ status: number; body: any }> {
  const response = await app.fetch(
    new Request(`http://d${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

{
  const laptopKth = kthOf(laptop.publicKey);
  const admin = boundToken("u_ab", laptopKth);
  const reader = tokenWith("u_ab", ["session:read", "session:write"], { jkt: laptopKth });

  const without = await bareApp.fetch(new Request("http://d/devices", { headers: { authorization: `Bearer ${tokenFor("u_ab")}` } }));
  check("a daemon with no device list says so rather than answering an empty one", [without.status, ((await without.json()) as { error: { code: string } }).error.code], [503, "devices_unavailable"]);

  check("the list is machine:admin's", (await call("GET", "/devices", reader)).status, 403);
  for (const [method, path] of [["PUT", "/devices/lock"], ["POST", "/devices/x/approve"], ["DELETE", "/devices/x"]] as const) {
    check(`and so is ${method} ${path}`, (await call(method, path, reader, method === "PUT" ? { on: false } : undefined)).status, 403);
  }

  const listed = await call("GET", "/devices", admin);
  check("the list says the lock is on", [listed.status, listed.body.lock], [200, true]);
  check("names the machine's fingerprint", listed.body.fingerprint, keyFingerprint(machine.publicKey));
  check("and says which row is the one asking", listed.body.you, laptopKth);
  report("with every waiting row carrying its code", listed.body.devices.every((one: { state: string; code: string | null }) => one.code !== null), `${listed.body.devices.length} rows`);

  const health = await lockedApp.app.fetch(new Request("http://d/health"));
  check("the machine names its own key on the unauthenticated route an app on this computer reads", ((await health.json()) as { machineKey?: string }).machineKey, b64(machine.publicKey));

  const sessions = await call("GET", "/sessions", admin);
  check("the session listing every app already polls carries how many are waiting", sessions.body.devicesPending, channelGate.pendingCount());
  report("which is more than none here", sessions.body.devicesPending > 0, String(sessions.body.devicesPending));
  check("on the cut listing too", (await call("GET", "/sessions?limit=1", admin)).body.devicesPending, sessions.body.devicesPending);
  const readers = [await call("GET", "/sessions", reader), await call("GET", "/sessions?limit=1", reader)];
  check(
    "a capability on this machine that could let nobody in is listed its sessions and told nothing of who waits",
    readers.map((answer) => [answer.status, Array.isArray(answer.body.sessions), "devicesPending" in answer.body]),
    [[200, true, false], [200, true, false]],
  );

  check("a body that is not a switch is refused", (await call("PUT", "/devices/lock", admin, { on: "yes" })).status, 400);

  const unlocked = await call("PUT", "/devices/lock", admin, { on: false });
  check("the lock comes off", [unlocked.status, unlocked.body.lock], [200, false]);
  check("and with it off nothing is waiting on anybody", (await call("GET", "/sessions", admin)).body.devicesPending, undefined);

  const local1 = generateStaticKey();
  const localKth = kthOf(local1.publicKey);
  const localToken = boundToken("u_ab", localKth);
  const lied = await call("PUT", "/devices/lock", localToken, { on: true, device: { publicKey: b64(intruder.publicKey), name: "x", platform: "y" } });
  check("turning it on while naming somebody else's key is refused", [lied.status, lied.body.error.code], [400, "invalid_device"]);
  check("and changes nothing: the lock is still off", channelGate.locked, false);
  check("nor is that key now known", channelStore.get(kthOf(intruder.publicKey))?.state ?? "pending", "pending");

  const on = await call("PUT", "/devices/lock", localToken, { on: true, device: { publicKey: b64(local1.publicKey), name: "Desk", platform: "macos" } });
  check("turning it on with the caller's own key works", [on.status, on.body.lock], [200, true]);
  check("and whoever turned it on stays in, although no channel ever recorded them", channelStore.get(localKth)?.state, "known");

  const lockRow = (): unknown => channelDb.prepare("SELECT value FROM machine_settings WHERE key = 'deviceLock'").get()?.["value"];
  const named = await call("PATCH", "/settings", reader, { deviceLock: "0" });
  check(
    "and PATCH /settings, which session:write reaches, cannot name the lock though it is a row in the table that route writes",
    [named.status, named.body?.error?.code, lockRow(), channelGate.locked],
    [400, "unknown_setting", "1", true],
  );

  const pendingRow = channelGate.list().find((one) => one.state === "pending" && one.kind === "machine");
  const approved = await call("POST", `/devices/${encodeURIComponent(pendingRow?.code ?? "none")}/approve`, admin);
  check("a waiting row is approved by the code it shows", [approved.status, approved.body.approved, approved.body.id], [200, true, pendingRow?.id]);
  check("which is the row let in on the machine, and not only in the answer", channelStore.get(pendingRow?.id ?? "")?.state, "known");
  check("an id nothing answers to is a 404", (await call("POST", "/devices/nope/approve", admin)).status, 404);

  const own = await call("DELETE", `/devices/${laptopKth}`, admin);
  check("the device asking cannot remove itself", [own.status, own.body.error.code], [409, "own_device"]);
  check("and is still there", channelStore.get(laptopKth)?.state, "known");
  const gone = await call("DELETE", `/devices/${localKth}`, admin);
  check("another device is removed", [gone.status, gone.body.removed], [200, true]);
  const again = await call("DELETE", `/devices/${localKth}`, admin);
  check("and a replayed removal is a 200 that removed nothing", [again.status, again.body.removed], [200, false]);
}

{
  const { store } = realStore();
  let broken: "none" | "lock" | "count" = "none";
  const failing: KnownDeviceStore = {
    ...uncounted(store),
    locked: () => {
      if (broken === "lock") throw new Error("SQLITE_BUSY");
      return store.locked();
    },
    countPending: (seenAfter) => {
      if (broken === "count") throw new Error("SQLITE_CORRUPT");
      return store.countPending(seenAfter);
    },
  };
  class Unvouching extends DeviceGate {
    override vouch(): boolean {
      return false;
    }
  }
  const gate = new Unvouching(failing, () => b64(machine.publicKey));
  const { app } = createApp({ registry, verifier, instanceId: "i_devices_failing", startedAt: now, devices: gate });
  const caller = generateStaticKey();
  const admin = boundToken("u_ab", kthOf(caller.publicKey));
  const listing = async (): Promise<unknown[]> => {
    const answer = await call("GET", "/sessions", admin, undefined, app);
    return [answer.status, Array.isArray(answer.body.sessions), answer.body.devicesPending ?? null];
  };

  gate.setLocked(true);
  gate.admit(peerOf(phone), principal(), null);
  check("a second machine, locked with one device waiting, says so on its listing", await listing(), [200, true, 1]);
  broken = "count";
  check("a device list that cannot be counted leaves the session listing a 200, with no count", await listing(), [200, true, null]);
  broken = "lock";
  check("and so does a lock that cannot be read", await listing(), [200, true, null]);
  broken = "none";

  gate.setLocked(false);
  const own = { on: true, device: { publicKey: b64(caller.publicKey), name: "Desk", platform: "macos" } };
  const refused = await call("PUT", "/devices/lock", admin, own, app);
  check("a key the gate will not vouch for is refused as a key that is not the caller's", [refused.status, refused.body?.error?.code], [400, "invalid_device"]);
  check("and the lock stays off, since turning it on would shut out whoever asked", gate.locked, false);
}

// Loopback has no channel and so no key to hold a caller to: what it is held to is being this computer's own (Q1.655).
{
  process.stdout.write("\nwho may speak to the listener at all\n");
  check(
    "the app's own document may, wherever the shell serves it from, and so may a program, which sends no Origin",
    [...SHELL_ORIGINS, undefined].map(pageOriginAllowed),
    [true, true, true, true],
  );
  check(
    "so may a page served from this computer, which is the shell in development",
    ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"].map(pageOriginAllowed),
    [true, true, true],
  );
  const foreign = ["https://evil.example", "null", "", "tauri://evil", "http://localhost.evil.example", "http://tauri.localhost.evil.example", "http://127.0.0.1:5173/"];
  check("no page from elsewhere may: not a sandboxed one, not one whose name only begins like ours", foreign.filter(pageOriginAllowed), []);
  check(
    "a request is this computer's by the name it was addressed to",
    [["127.0.0.1:7887", "localhost:7887", "[::1]:7887", "127.0.0.1"].map(hostIsLoopback), ["evil.example:7887", "127.0.0.1.evil.example", "", undefined].map(hostIsLoopback)],
    [[true, true, true, true], [false, false, false, false]],
  );
  check(
    "and a daemon is bound to this computer or beyond it",
    [["127.0.0.1", "localhost", "::1", "127.0.0.53"].map(bindIsLoopback), ["0.0.0.0", "192.168.1.5", "::", "example.com"].map(bindIsLoopback)],
    [[true, true, true, true], [false, false, false, false]],
  );

  const guarded = createApp({ registry, verifier, instanceId: "i_devices_guarded", startedAt: now, devices: channelGate, listensOn: "loopback" }).app;
  const admin = boundToken("u_ab", kthOf(laptop.publicKey));
  const ask = async (headers: Record<string, string>, method = "GET", path = "/health", body?: unknown): Promise<unknown[]> => {
    const response = await guarded.fetch(
      new Request(`http://d${path}`, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    const code = text.length > 0 ? ((JSON.parse(text) as { error?: { code?: string } }).error?.code ?? null) : null;
    return [response.status, code, response.headers.get("access-control-allow-origin")];
  };
  const here = { host: "127.0.0.1:7887" };
  const elsewhere = { ...here, origin: "https://evil.example" };

  check("this computer's own app is answered, and may read the answer", await ask({ ...here, origin: "tauri://localhost" }), [200, null, "*"]);
  check("so is a program on it", (await ask(here)).slice(0, 2), [200, null]);
  check("a page from elsewhere is refused before anything else, with nothing it could read", await ask(elsewhere), [403, "foreign_origin", null]);
  check("its preflight too, so the request it guards is never sent", await ask({ ...elsewhere, "access-control-request-method": "PUT" }, "OPTIONS", "/devices/lock"), [403, "foreign_origin", null]);
  check("and a sandboxed page with it", await ask({ ...here, origin: "null" }), [403, "foreign_origin", null]);
  const wasLocked = channelGate.locked;
  channelGate.setLocked(true);
  check(
    "a signed admin token carried by such a page turns no lock off",
    [await ask({ ...elsewhere, authorization: `Bearer ${admin}` }, "PUT", "/devices/lock", { on: false }), channelGate.locked],
    [[403, "foreign_origin", null], true],
  );
  check("the same token from this computer does, which is the door after every device is lost", [(await ask({ ...here, authorization: `Bearer ${admin}` }, "PUT", "/devices/lock", { on: false })).slice(0, 2), channelGate.locked], [[200, null], false]);
  channelGate.setLocked(wasLocked);
  check("a name rebound to this address is not this computer, and its GET carries no Origin to refuse", await ask({ host: "evil.example:7887" }), [403, "foreign_host", null]);
  check("nor is a request that names no host", await ask({}), [403, "foreign_host", null]);
  check("an upgrade is a request like any other", await ask({ ...elsewhere, upgrade: "websocket", connection: "upgrade" }, "GET", "/sessions/s_none/ws"), [403, "foreign_origin", null]);

  const { store: beyondStore } = realStore();
  const beyondGate = new DeviceGate(beyondStore, () => b64(machine.publicKey));
  const beyond = createApp({ registry, verifier, instanceId: "i_devices_beyond", startedAt: now, devices: beyondGate, listensOn: "beyond" }).app;
  const taken = await call("PUT", "/devices/lock", admin, { on: true }, beyond);
  check("a daemon that listens beyond this computer will not take the lock, which covers the relay alone", [taken.status, taken.body?.error?.code, beyondGate.locked], [409, "lock_needs_loopback", false]);
  check("and is still unlocked on request", [(await call("PUT", "/devices/lock", admin, { on: false }, beyond)).status, beyondGate.locked], [200, false]);
}

listener.close();
