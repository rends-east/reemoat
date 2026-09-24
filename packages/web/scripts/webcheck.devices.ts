import { readFileSync } from "node:fs";
import { check, report, storage } from "./webcheck.env.js";
import { srcFile, stripComments } from "./webcheck.source.js";
import { ApiError, meansDeviceKeyMissing } from "../src/http.js";

process.stdout.write("\nthe gate's two entry points, devices, and a pasted link\n");

{
  // gate.html copies index.html's head by design, with no templating step; titles are excluded since each names itself.
  const headTags = (file: string): string[] => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const head = /<head>([\s\S]*?)<\/head>/.exec(text)?.[1] ?? "";
    // Comments out first: both files carry long ones and only one carries the
    // note about being a copy.
    const bare = head.replace(/<!--[\s\S]*?-->/g, "");
    return [...bare.matchAll(/<(?:meta|link)\b[^>]*>/g)]
      .map((m) => (m[0] ?? "").replace(/\s+/g, " ").trim())
      .sort();
  };
  const app = headTags("index.html");
  const gate = headTags("gate.html");
  report("both entry points were read", app.length > 0 && gate.length > 0, `${String(app.length)} tags each side`);
  check("the gate's head is the app's head", gate, app);
  // Different entry scripts, or a byte copy of index.html passes and boots the whole app on the gate.
  const entry = (file: string): string => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    return /<script type="module" src="([^"]+)"/.exec(text)?.[1] ?? "";
  };
  check("and they load different entry points", entry("index.html") !== entry("gate.html"), true);
  check("the gate loads the gate's", entry("gate.html"), "/src/gate-main.tsx");
}


const SRC = new URL("../src/", import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, SRC), "utf8");

{
  const { isGateToken, readGateToken, readPastedGateToken } = await import("../src/gate.js");

  // et_ is what user_email_tokens mints and pr_ a pending registration: the two prefixes isGateToken admits.
  const TOKEN = "et_abcdefghijklmnopqrstuvwxyz012345";
  const PENDING = "pr_abcdefghijklmnopqrstuvwxyz012345";

  check("the fixture is a token at all", [isGateToken(TOKEN), isGateToken(PENDING)], [true, true]);

  check("a whole link", readPastedGateToken(`https://cp.example/reset#t=${TOKEN}`), TOKEN);
  check("with a port and a path that is not ours", readPastedGateToken(`http://localhost:7888/verify#t=${TOKEN}`), TOKEN);
  check("a bare fragment, which is what selecting half a link gives", readPastedGateToken(`#t=${TOKEN}`), TOKEN);
  check("the fragment without its hash", readPastedGateToken(`t=${TOKEN}`), TOKEN);
  check("the code on its own, which is what a mail client that ate the link leaves", readPastedGateToken(TOKEN), TOKEN);
  check("a registration token too", readPastedGateToken(PENDING), PENDING);
  check("surrounded by whitespace", readPastedGateToken(`  ${TOKEN}\n`), TOKEN);
  check("and a link with whitespace", readPastedGateToken(`\n https://cp.example/confirm#t=${TOKEN} `), TOKEN);

  check("nothing at all", readPastedGateToken(""), null);
  check("whitespace only", readPastedGateToken("   \n "), null);
  check("a link with no fragment", readPastedGateToken("https://cp.example/reset"), null);
  check("a link whose fragment carries something else", readPastedGateToken("https://cp.example/reset#hello"), null);
  check("a fragment with the wrong parameter", readPastedGateToken(`#token=${TOKEN}`), null);
  check("a truncated token", readPastedGateToken("et_abc"), null);
  check("a token with the wrong prefix", readPastedGateToken("rs_abcdefghijklmnopqrstuvwxyz012345"), null);
  check("a sentence", readPastedGateToken("here is the link from my email"), null);
  // rs_ is a live bearer credential: refused by shape so it never leaves the page.
  check("and a credential, which must never be sent anywhere", readPastedGateToken("rs_0123456789abcdef0123456789abcdef"), null);

  check("the fragment reader still refuses what it always did", readGateToken("#t=nope"), null);
  check("and the pasted reader agrees with it on a real one", readPastedGateToken(`#t=${TOKEN}`), readGateToken(`#t=${TOKEN}`));
}

{
  const { parseGateRoute } = await import("../src/gate.js");

  for (const screen of ["register", "confirm", "forgot", "reset", "verify"]) {
    check(`/${screen} draws its gate screen`, parseGateRoute(`/${screen}`), { name: "gate", screen });
  }
  for (const doc of ["terms", "acceptable-use", "privacy"]) {
    check(`/${doc} draws the document`, parseGateRoute(`/${doc}`), { name: "legal", doc });
  }
  check("/app is the handoff", parseGateRoute("/app"), { name: "handoff" });

  // The fallback is the handoff, never not-found: this page's job is to say where the product is.
  check("and so is anything else", parseGateRoute("/"), { name: "handoff" });
  check("including an address belonging to the app", parseGateRoute("/settings"), { name: "handoff" });
  check("and one that names nothing", parseGateRoute("/nope"), { name: "handoff" });

  check("a trailing slash changes nothing", parseGateRoute("/reset/"), { name: "gate", screen: "reset" });
  check("nor does a doubled leading one", parseGateRoute("//reset"), { name: "gate", screen: "reset" });

  // Nothing decodes: a bare decodeURIComponent over a lone % throws URIError during module evaluation.
  check("a lone percent does not throw", parseGateRoute("/%"), { name: "handoff" });
  check("nor does an incomplete escape", parseGateRoute("/re%zzset"), { name: "handoff" });
}

{
  const cp = await import("../src/cp.js");

  storage.clear();
  check("nothing stored is no device", cp.currentDevice(), null);

  cp.rememberDevice("dv_abc123");
  check("a registered device is remembered", cp.currentDevice(), "dv_abc123");

  // Signing out keeps the device, or every sign-out registers another row for the same computer.
  cp.setSession("rs_0123456789abcdef0123456789abcdef");
  cp.clearSession();
  check("⭐ signing out keeps the device", cp.currentDevice(), "dv_abc123");
  check("and really did clear the credential", cp.currentCredential(), null);

  cp.forgetDevice();
  check("⭐ and a retirement gives it up", cp.currentDevice(), null);

  const cpSrc = stripComments(read("cp.ts"));
  const credentialKey = /const CREDENTIAL_STORAGE = "([^"]+)"/.exec(cpSrc)?.[1] ?? "";
  const deviceKey = /const DEVICE_STORAGE = "([^"]+)"/.exec(cpSrc)?.[1] ?? "";
  report("both storage keys were found", credentialKey.length > 0 && deviceKey.length > 0, `${credentialKey} / ${deviceKey}`);
  check("and they are not the same name", credentialKey === deviceKey, false);
  // A device key under a LEGACY_STORAGE name would be swept by setSession on every sign-in.
  const legacy = /const LEGACY_STORAGE = \[([^\]]*)\]/.exec(cpSrc)?.[1] ?? "";
  report("the legacy list was found", legacy.length > 0, legacy.trim());
  check("and the device key is not one of them", legacy.includes(deviceKey), false);
}

// Source reads only: registerDevice answers null outside the shell, and relaycheck drives the server half.

{
  const cpSrc = stripComments(srcFile("cp.ts"));
  const machineSrc = stripComments(srcFile("machine.ts"));

  check("the registration carries the shell's device key", /publicKey/.test(cpSrc), true);
  check("read off the boot payload rather than invented", /boot\.devicePublicKey/.test(cpSrc), true);

  // Keyed on the code through meansDeviceKeyMissing, never the status: a 409 carries unrelated refusals.
  check("the mint recognises the refusal", /meansDeviceKeyMissing/.test(machineSrc), true);
  check("and answers it by registering the key", /registerDevice\(\)/.test(machineSrc), true);
  check("exactly once, on the first attempt", /firstAttempt && meansDeviceKeyMissing/.test(machineSrc), true);

  check("the code is what it keys on", meansDeviceKeyMissing(new ApiError(409, "device_key_required", "no key")), true);
  check(
    "and a different 409 is not it",
    meansDeviceKeyMissing(new ApiError(409, "device_needs_session", "no session")),
    false,
  );
  check("nor is a transport failure", meansDeviceKeyMissing(new TypeError("offline")), false);
}

// webcheck.plugin-protocol.ts never looks in control-plane files, so DeviceRecord is compared with DeviceRow here, as a census.

{
  const fieldsOf = (source: string, name: string): string[] => {
    const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(stripComments(source))?.[1] ?? "";
    return [...body.matchAll(/^\s*(\w+)\??:/gm)].map((one) => one[1] ?? "");
  };

  const served = fieldsOf(readFileSync(new URL("../../control-plane/src/devices.ts", import.meta.url), "utf8"), "DeviceRow");
  const mirrored = fieldsOf(read("wire.ts"), "DeviceRecord");

  report("both sides of the mirror were found", served.length > 0 && mirrored.length > 0, `${String(served.length)} served, ${String(mirrored.length)} mirrored`);
  check("⭐ every field the control plane serves on a device row is declared here", served.filter((field) => !mirrored.includes(field)), []);
  check("including the pair the encryption put there", [mirrored.includes("hasKey"), mirrored.includes("keySetAt")], [true, true]);

  // Optional on the mirror: an older control plane sends neither, and undefined means nobody said, not false.
  const mirrorSource = stripComments(read("wire.ts"));
  check("the mirror declares them optional", /hasKey\?: boolean;/.test(mirrorSource) && /keySetAt\?: number \| null;/.test(mirrorSource), true);

  const devicesSection = stripComments(read("ui/settings/DevicesSection.tsx"));
  check("⭐ the devices screen reads the field at all", /row\.hasKey/.test(devicesSection), true);
  check("comparing it against false rather than for truthiness", /row\.hasKey === false/.test(devicesSection), true);
  check("and never as a bare negation", /!row\.hasKey\b/.test(devicesSection), false);
  report(
    "on both the row's badge and the sentence that explains it",
    [...devicesSection.matchAll(/row\.hasKey === false/g)].length >= 2,
    `${String([...devicesSection.matchAll(/row\.hasKey === false/g)].length)} readers`,
  );

  check("⭐ the re-key control calls the shell's reset", /await hostDeviceKeyReset\(\);/.test(devicesSection), true);
  // Reset first, then register: registerDevice reads the key the reset just refreshed, so a race sends the retired one.
  // Ordered by position rather than adjacency, so wrapping either call does not break the check.
  const resetAt = devicesSection.indexOf("hostDeviceKeyReset()");
  const registerAt = devicesSection.indexOf("cp.registerDevice()");
  report(
    "both halves of a re-key are present to be ordered",
    resetAt >= 0 && registerAt >= 0,
    `reset at ${resetAt}, register at ${registerAt}`,
  );
  check("and registers the device after it", resetAt >= 0 && registerAt > resetAt, true);
  check("so the two halves are never raced", /Promise\.all/.test(devicesSection), false);
  check("the control exists only in the native shell", /const rekeyable = [^;]*inNativeShell\(\)/.test(devicesSection), true);
  check("only on this installation's own row", /const rekeyable =[^;]*row\.current/.test(devicesSection), true);
  check("and only where the key is what is missing", /const rekeyable =[^;]*row\.hasKey === false/.test(devicesSection), true);
  check("and the button is gated on exactly that", /rekeyable &&/.test(devicesSection), true);
  // The verdict comes off the refreshed row: the POST answers an id whether or not the key was taken.
  check("and the verdict is read off the refreshed row", /listed\.hasKey === false/.test(devicesSection), true);
}

{
  // The device id lives in config.rs, not the keyring: a keyring that discards writes would register a new device every launch.
  const NATIVE = new URL("../../native/src-tauri/src/", import.meta.url);
  // Comments stripped because these files restate their rules in prose; Rust doc comments start with // and strip safely.
  const rust = (rel: string): string => stripComments(readFileSync(new URL(rel, NATIVE), "utf8"));
  const credentialRs = rust("credential.rs");
  const configRs = rust("config.rs");

  check("the device id is kept in the configuration file", /fn (read|write|erase)_device\b/.test(configRs), true);

  // Anchored: read_device and read_device_key differ only by a suffix.
  check("and the device key is kept in the keyring", /fn read_device_key\b/.test(credentialRs), true);
  check(
    "with a fallback for a store that keeps nothing, in the file beside the id",
    /fn read_device_key_fallback\b/.test(configRs),
    true,
  );

  const secrets = [...credentialRs.matchAll(/^pub const (\w+): &str = /gm)].map((m) => m[1] ?? "");
  check("the keyring holds exactly two kinds of secret", secrets, ["CREDENTIAL", "DEVICE_KEY"]);
  check("and still cannot be enumerated", /fn list\b/.test(credentialRs), false);

  // No command hands the private key to the page: it answers a public key and a Diffie-Hellman output only.
  const commandsRs = rust("commands.rs");
  const deviceRs = rust("device.rs");
  // A census, not a floor: bodies found must equal attributes present, so a spelling the regex misses fails.
  const commandAttrs = [...commandsRs.matchAll(/#\[tauri::command/g)].length;
  const commandBodies = [...commandsRs.matchAll(/#\[tauri::command(?:\([^)]*\))?\][\s\S]*?\n\}/g)].map((m) => m[0]);
  const swept = commandBodies.map((body) => /\bfn (\w+)/.exec(body)?.[1] ?? "");
  report("the commands were found to read at all", commandAttrs > 5, `${String(commandAttrs)} declared`);
  check("⭐ and every one of them was read as a body", commandBodies.length, commandAttrs);
  check("each of which is one named function", swept.filter((name) => name === ""), []);
  check(
    "including every command that handles a device key",
    ["host_device_clear", "host_device_dh", "host_device_key_reset", "host_device_set"].filter(
      (one) => !swept.includes(one),
    ),
    [],
  );
  check(
    "no command returns what the keyring holds for a device",
    commandBodies.filter((body) => /read_device_key\b/.test(body)).map((body) => /\bfn (\w+)/.exec(body)?.[1] ?? ""),
    [],
  );
  check(
    "and the module that does read it returns a shared secret instead",
    /fn diffie_hellman[\s\S]*?shared\.as_bytes\(\)/.test(deviceRs),
    true,
  );
  // A low-order peer point forces an all-zero shared secret both ends would agree on.
  check("and refuses a peer key that contributes nothing", /was_contributory\(\)/.test(deviceRs), true);
}
