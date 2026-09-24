#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  CipherState,
  FRAME,
  MAX_FRAME_PAYLOAD,
  MAX_HEADER_JSON_BYTES,
  MAX_SOCKET_MESSAGE_BYTES,
  MessageAssembler,
  NoiseHandshake,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJsonFrame,
  encodeMessageFrames,
  frameLength,
  localStaticKey,
  publicFromSecret,
  randomSecretKey,
  tryEncodeJsonFrame,
  type Ephemeral,
} from "@reemoat/protocol";

/**
 * Regression driver for packages/protocol: the published Noise_IK vectors in both roles, the reserved nonce and the frame table.
 * The vector file stays .txt: docscheck's SOURCE_EXT includes json, so a .json file would join the cited-symbol corpus.
 */

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    process.stdout.write(`  ok    ${name}  (${detail})\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}  (${detail})\n`);
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const unhex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "hex"));

function pinned(...secrets: readonly string[]): () => Ephemeral {
  let at = 0;
  return () => {
    const secret = secrets[at];
    at += 1;
    if (secret === undefined) throw new Error("protocolcheck: the handshake asked for an ephemeral the vector does not pin");
    const secretKey = unhex(secret);
    return { secretKey, publicKey: publicFromSecret(secretKey) };
  };
}

interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_static: string;
  init_ephemeral: string;
  init_remote_static: string;
  resp_static: string;
  resp_ephemeral: string;
  messages: { payload: string; ciphertext: string }[];
}

const vectorFile = JSON.parse(
  readFileSync(new URL("../packages/protocol/vectors/noise.txt", import.meta.url), "utf8"),
) as { source: string; vectors: Vector[] };

const vector = vectorFile.vectors.find((v) => v.protocol_name === "Noise_IK_25519_ChaChaPoly_BLAKE2s");
if (vector === undefined) throw new Error("protocolcheck: the IK vector is missing from the vendored file");

process.stdout.write("\nNoise_IK_25519_ChaChaPoly_BLAKE2s against the published vectors\n");

const prologue = unhex(vector.init_prologue);
const initStatic = localStaticKey(unhex(vector.init_static));
const respStatic = localStaticKey(unhex(vector.resp_static));

check("the vector's remote static really is the responder's public key", hex(respStatic.publicKey), vector.init_remote_static);
report("the vector carries handshake messages and transport messages", vector.messages.length === 4, `${vector.messages.length} messages`);

{
  const initiator = NoiseHandshake.start({
    initiator: true,
    staticKey: initStatic,
    remoteStatic: unhex(vector.init_remote_static),
    prologue,
    ephemeral: pinned(vector.init_ephemeral),
  });
  const responder = NoiseHandshake.start({
    initiator: false,
    staticKey: respStatic,
    prologue,
    ephemeral: pinned(vector.resp_ephemeral),
  });

  const first = vector.messages[0]!;
  const written = await initiator.writeMessage(unhex(first.payload));
  check("message 1 is byte-for-byte the published ciphertext", hex(written), first.ciphertext);

  const readBack = await responder.readMessage(unhex(first.ciphertext));
  check("and the responder reads the payload out of the published bytes", hex(readBack), first.payload);

  check(
    "the responder learns the initiator's static key, which is the device binding",
    hex(responder.remoteStaticKey ?? new Uint8Array(0)),
    hex(initStatic.publicKey),
  );

  const second = vector.messages[1]!;
  const reply = await responder.writeMessage(unhex(second.payload));
  check("message 2 is byte-for-byte the published ciphertext", hex(reply), second.ciphertext);
  check("and the initiator reads its payload", hex(await initiator.readMessage(unhex(second.ciphertext))), second.payload);

  report("both ends finished the handshake", initiator.complete && responder.complete, "split available on both");

  const fromInitiator = initiator.split();
  const fromResponder = responder.split();

  const third = vector.messages[2]!;
  check(
    "the first transport message matches the vector",
    hex(fromInitiator.send.encrypt(new Uint8Array(0), unhex(third.payload))),
    third.ciphertext,
  );
  check(
    "and the responder opens it with the key pointed the other way",
    hex(fromResponder.receive.decrypt(new Uint8Array(0), unhex(third.ciphertext))),
    third.payload,
  );

  const fourth = vector.messages[3]!;
  check(
    "the reply transport message matches the vector",
    hex(fromResponder.send.encrypt(new Uint8Array(0), unhex(fourth.payload))),
    fourth.ciphertext,
  );
  check(
    "and the initiator opens that one",
    hex(fromInitiator.receive.decrypt(new Uint8Array(0), unhex(fourth.ciphertext))),
    fourth.payload,
  );

  check("both ends agree on the handshake hash", hex(fromInitiator.handshakeHash), hex(fromResponder.handshakeHash));
}

process.stdout.write("\na live handshake\n");

async function establish(
  machine = respStatic,
  claimed: Uint8Array = respStatic.publicKey,
  device = initStatic,
): Promise<{ initiator: NoiseHandshake; responder: NoiseHandshake }> {
  const initiator = NoiseHandshake.start({ initiator: true, staticKey: device, remoteStatic: claimed });
  const responder = NoiseHandshake.start({ initiator: false, staticKey: machine });
  await responder.readMessage(await initiator.writeMessage());
  await initiator.readMessage(await responder.writeMessage());
  return { initiator, responder };
}

{
  const one = await establish();
  const two = await establish();

  const sealOne = one.initiator.split().send.encrypt(new Uint8Array(0), new TextEncoder().encode("prompt"));
  const sealTwo = two.initiator.split().send.encrypt(new Uint8Array(0), new TextEncoder().encode("prompt"));

  report("two sessions seal the same plaintext differently", hex(sealOne) !== hex(sealTwo), "independent session keys");

  let opened = false;
  try {
    two.responder.split().receive.decrypt(new Uint8Array(0), sealOne);
    opened = true;
  } catch {
    // Expected: a session's keys are its own.
  }
  report("and one session cannot open the other's traffic", !opened, "cross-session open refused");
}

{
  const { initiator, responder } = await establish();
  const send = initiator.split().send;
  const receive = responder.split().receive;

  const sealed = send.encrypt(new Uint8Array(0), new TextEncoder().encode("a diff nobody else may read"));
  const tampered = Uint8Array.from(sealed);
  tampered[0] = (tampered[0]! ^ 0x01) & 0xff;

  let accepted = false;
  try {
    receive.decrypt(new Uint8Array(0), tampered);
    accepted = true;
  } catch {
    // Expected: Poly1305 refuses it.
  }
  report("a flipped bit is refused rather than delivered", !accepted, "one byte of ciphertext altered");

  report("and the refusal did not advance the nonce", receive.nonce === 0n, `nonce ${receive.nonce}`);
  report("so the genuine frame still opens", hex(receive.decrypt(new Uint8Array(0), sealed)).length > 0, `nonce now ${receive.nonce}`);
}

{
  const impostor = localStaticKey(randomSecretKey());
  const initiator = NoiseHandshake.start({ initiator: true, staticKey: initStatic, remoteStatic: respStatic.publicKey });
  const responder = NoiseHandshake.start({ initiator: false, staticKey: impostor });

  let reached = false;
  try {
    await responder.readMessage(await initiator.writeMessage());
    reached = true;
  } catch {
    // Expected: `es` mixed a different key, so `DecryptAndHash` fails.
  }
  report("a machine that is not the expected one cannot complete the handshake", !reached, "wrong responder static");
}

{
  let refused = "";
  try {
    NoiseHandshake.start({ initiator: true, staticKey: initStatic });
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  report("an IK initiator with no responder key is refused up front", refused.includes("static key"), refused || "(not refused)");
}

{
  const initiator = NoiseHandshake.start({
    initiator: true,
    staticKey: initStatic,
    remoteStatic: respStatic.publicKey,
    prologue: new TextEncoder().encode("m_alice"),
  });
  const responder = NoiseHandshake.start({
    initiator: false,
    staticKey: respStatic,
    prologue: new TextEncoder().encode("m_bob"),
  });

  let agreed = false;
  try {
    await responder.readMessage(await initiator.writeMessage());
    agreed = true;
  } catch {
    // Expected: the prologue is mixed into `h` before anything else.
  }
  report("two ends that disagree about the prologue cannot handshake", !agreed, "different machine ids");
}

{
  const { initiator } = await establish();
  let replayed = false;
  try {
    await initiator.readMessage(new Uint8Array(96));
    replayed = true;
  } catch {
    // Expected: there is no third message in IK.
  }
  report("a message after the handshake is over is refused", !replayed, "IK has two messages");
}

{
  const initiator = NoiseHandshake.start({ initiator: true, staticKey: initStatic, remoteStatic: respStatic.publicKey });
  const responder = NoiseHandshake.start({ initiator: false, staticKey: respStatic });
  const full = await initiator.writeMessage();

  let short = false;
  try {
    await responder.readMessage(full.subarray(0, 20));
    short = true;
  } catch {
    // Expected.
  }
  report("a truncated handshake message is refused", !short, `${full.length} bytes cut to 20`);
}

{
  const bare = new CipherState(null);
  const message = new TextEncoder().encode("plain");
  check("a keyless cipher state is a pass-through", hex(bare.encrypt(new Uint8Array(0), message)), hex(message));
}

process.stdout.write("\nthe top of the nonce's range\n");

// 2^64 - 1, reserved by revision 34 §5.1; stated here because noise.ts deliberately does not export it.
const RESERVED_NONCE = (1n << 64n) - 1n;

{
  const key = new Uint8Array(32).fill(7);
  const ad = new Uint8Array(0);
  const plaintext = new TextEncoder().encode("one message past the end");

  const exhausted = CipherState.at(key, RESERVED_NONCE);

  let sealing = "(not refused)";
  try {
    exhausted.encrypt(ad, plaintext);
  } catch (error) {
    sealing = error instanceof Error ? error.message : String(error);
  }
  report("a cipher standing on the reserved nonce refuses to seal", sealing.includes("nonce exhausted"), sealing);

  // Asserts on the words: a bad tag also throws, so "did it throw" would pass either way.
  let opening = "(not refused)";
  try {
    exhausted.decrypt(ad, new Uint8Array(32));
  } catch (error) {
    opening = error instanceof Error ? error.message : String(error);
  }
  report("and refuses to open one", opening.includes("nonce exhausted"), opening);
  report("with the counter left exactly where it was", exhausted.nonce === RESERVED_NONCE, `nonce ${exhausted.nonce}`);
}

{
  const key = new Uint8Array(32).fill(9);
  const ad = new Uint8Array(0);
  const plaintext = new TextEncoder().encode("the last message this key may seal");

  const sender = CipherState.at(key, RESERVED_NONCE - 1n);
  const sealed = sender.encrypt(ad, plaintext);
  report("the last legal nonce still seals a message", sealed.length === plaintext.length + 16, `${sealed.length} bytes, tag included`);
  report("and spends itself doing it", sender.nonce === RESERVED_NONCE, `nonce ${sender.nonce}`);

  let again = "(not refused)";
  try {
    sender.encrypt(ad, plaintext);
  } catch (error) {
    again = error instanceof Error ? error.message : String(error);
  }
  report("so the next one is refused rather than sealed under the reserved value", again.includes("nonce exhausted"), again);

  const receiver = CipherState.at(key, RESERVED_NONCE - 1n);
  check("and the far end opens what it sealed", hex(receiver.decrypt(ad, sealed)), hex(plaintext));
}

{
  const key = new Uint8Array(32).fill(3);
  const ad = new Uint8Array(0);
  const message = new TextEncoder().encode("the first frame of a session");
  check(
    "a cipher handed a starting counter of zero is the one a session builds",
    hex(CipherState.at(key, 0n).encrypt(ad, message)),
    hex(new CipherState(key).encrypt(ad, message)),
  );

  let above = "(not refused)";
  try {
    CipherState.at(key, RESERVED_NONCE + 1n);
  } catch (error) {
    above = error instanceof Error ? error.message : String(error);
  }
  report("a starting counter outside the 64-bit range is refused where it is written", above.includes("64-bit"), above);

  let below = "(not refused)";
  try {
    CipherState.at(key, -1n);
  } catch (error) {
    below = error instanceof Error ? error.message : String(error);
  }
  report("in both directions", below.includes("64-bit"), below);
}

process.stdout.write("\nthe frames inside the channel\n");

{
  const largest = encodeFrame(FRAME.MESSAGE, new Uint8Array(MAX_FRAME_PAYLOAD));
  check("a frame may carry MAX_FRAME_PAYLOAD bytes behind its type byte", largest.length, MAX_FRAME_PAYLOAD + 1);

  let over = "(not refused)";
  try {
    encodeFrame(FRAME.MESSAGE, new Uint8Array(MAX_FRAME_PAYLOAD + 1));
  } catch (error) {
    over = error instanceof Error ? error.message : String(error);
  }
  report("and one byte more is refused", over === "frame payload is too large", over);

  const sealed = new CipherState(new Uint8Array(32).fill(1)).encrypt(new Uint8Array(0), largest);
  check("a full frame, sealed, is exactly what a length prefix can describe", sealed.length, 65535);
  check("so the largest frame still frames", frameLength(sealed).length, 65537);

  let unframeable = "(not refused)";
  try {
    frameLength(new Uint8Array(65536));
  } catch (error) {
    unframeable = error instanceof Error ? error.message : String(error);
  }
  report("while anything above 65535 is refused rather than silently truncated by the prefix", unframeable === "noise message is too large to frame", unframeable);
}

{
  report(
    "the header bound cannot exceed what one frame carries",
    MAX_HEADER_JSON_BYTES <= MAX_FRAME_PAYLOAD,
    `${MAX_HEADER_JSON_BYTES} ≤ ${MAX_FRAME_PAYLOAD}`,
  );

  /** A description whose JSON is exactly `bytes` long: `{"pad":"…"}` is ten. */
  const description = (bytes: number): { pad: string } => ({ pad: "x".repeat(bytes - 10) });
  check("the fixture description is the size it claims", JSON.stringify(description(MAX_HEADER_JSON_BYTES)).length, MAX_HEADER_JSON_BYTES);

  check(
    "a description at exactly the bound encodes",
    encodeJsonFrame(FRAME.REQUEST, description(MAX_HEADER_JSON_BYTES)).length,
    MAX_FRAME_PAYLOAD + 1,
  );

  let over = "(not refused)";
  try {
    encodeJsonFrame(FRAME.REQUEST, description(MAX_HEADER_JSON_BYTES + 1));
  } catch (error) {
    over = error instanceof Error ? error.message : String(error);
  }
  report("one byte more is refused by the layer that owns the bound", over === "frame description is too large", over);

  report(
    "and answers null, rather than throwing, for the one caller that did not choose it",
    tryEncodeJsonFrame(FRAME.RESPONSE, description(MAX_HEADER_JSON_BYTES + 1)) === null,
    "tryEncodeJsonFrame",
  );
}

{
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  check("a control frame's JSON is read back", decodeJson<{ a: number }>(bytes('{"a":1}')), { a: 1 });
  check("an array is refused rather than handed back as an object", decodeJson(bytes("[1,2,3]")), null);
  check("so is JSON's own null", decodeJson(bytes("null")), null);
  check("bytes that are not JSON at all are refused", decodeJson(bytes("not json")), null);
  check(
    "and a payload above the header bound is refused before it is parsed",
    decodeJson(new Uint8Array(MAX_HEADER_JSON_BYTES + 1)),
    null,
  );

  check("an empty frame decodes to nothing, rather than to frame type zero", decodeFrame(new Uint8Array(0)), null);
  const decoded = decodeFrame(encodeFrame(FRAME.MESSAGE, bytes("hi")));
  check("and a frame gives back its type and its payload", [decoded?.type, new TextDecoder().decode(decoded?.payload)], [FRAME.MESSAGE, "hi"]);
}

process.stdout.write("\none socket message, in pieces\n");

{
  // A two-byte character sits exactly on the first chunk boundary: reassembly must be over bytes, never over text.
  const head = '{"pad":"';
  const tail = '"}';
  const before = "a".repeat(MAX_FRAME_PAYLOAD - head.length - 1);
  const after = "b".repeat(200_000 - head.length - before.length - 2 - tail.length);
  const text = `${head}${before}é${after}${tail}`;
  const message = new TextEncoder().encode(text);

  check("the fixture message is 200 000 bytes", message.length, 200_000);
  report("which is more than one frame can carry", message.length > MAX_FRAME_PAYLOAD, `${MAX_FRAME_PAYLOAD} bytes per frame`);

  const frames = encodeMessageFrames(message);
  check(
    "so it travels as several MESSAGE frames and one terminator",
    [frames.length, frames[frames.length - 1]![0], frames[frames.length - 1]!.length],
    [5, FRAME.MESSAGE_END, 1],
  );

  const assembler = new MessageAssembler();
  let refused = 0;
  for (const frame of frames.slice(0, -1)) {
    if (!assembler.push(frame.subarray(1))) refused += 1;
  }
  report("every chunk is taken", refused === 0, `${frames.length - 1} chunks`);

  const whole = assembler.end();
  check("and the terminator hands back the message, byte for byte", hex(whole ?? new Uint8Array(0)), hex(message));

  const parsed = JSON.parse(new TextDecoder().decode(whole ?? new Uint8Array(0))) as { pad: string };
  report("which parses, with the character on the boundary intact", parsed.pad.includes("é"), `${parsed.pad.length} characters`);

  const perChunk = frames
    .slice(0, -1)
    .map((frame) => new TextDecoder().decode(frame.subarray(1)))
    .join("");
  report(
    "while decoding each chunk as it arrives corrupts the boundary silently",
    perChunk !== text && perChunk.includes("�"),
    "U+FFFD where é was, and still parses",
  );
}

{
  const frames = encodeMessageFrames(new Uint8Array(0));
  check("a zero-length message is a terminator and nothing else", [frames.length, frames[0]![0]], [1, FRAME.MESSAGE_END]);

  const assembler = new MessageAssembler();
  const whole = assembler.end();
  report("and comes back as zero bytes rather than as nothing at all", whole !== null && whole.length === 0, "an empty message is a message");
}

{
  const assembler = new MessageAssembler();
  const chunk = new Uint8Array(MAX_FRAME_PAYLOAD);
  let taken = 0;
  let stopped = false;
  while (taken * MAX_FRAME_PAYLOAD < MAX_SOCKET_MESSAGE_BYTES + MAX_FRAME_PAYLOAD) {
    if (!assembler.push(chunk)) {
      stopped = true;
      break;
    }
    taken += 1;
  }
  report("the assembler stops taking chunks past MAX_SOCKET_MESSAGE_BYTES", stopped, `${taken} × ${MAX_FRAME_PAYLOAD} bytes taken`);
  report("and refuses every chunk after the one that overflowed", !assembler.push(chunk), "still overflowed");
  check("the terminator then answers null rather than a short message", assembler.end(), null);

  const next = assembler.push(new Uint8Array(4)) ? assembler.end() : null;
  report("while the same assembler is ready for the next message", next?.length === 4, `${next?.length ?? -1} bytes`);
}

process.stdout.write(failures === 0 ? "\nall green\n" : `\n${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
