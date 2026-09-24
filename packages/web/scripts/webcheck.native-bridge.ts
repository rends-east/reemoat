import { readFileSync, readdirSync, statSync } from "node:fs";
import { check, report, storage } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

// inNativeShell reads the injected global on every call, so enterShell and leaveShell flip the arm without re-importing; only hydration is fixed at import.

process.stdout.write("\nthe native bridge, and the browser arm it must not disturb\n");

const SRC = new URL("../src/", import.meta.url);
const src = (rel: string): string => readFileSync(new URL(rel, SRC), "utf8");

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string, base: string): void => {
    for (const entry of readdirSync(new URL(dir, SRC))) {
      const path = `${dir}${entry}`;
      if (statSync(new URL(path, SRC)).isDirectory()) walk(`${path}/`, `${base}${entry}/`);
      else if (/\.tsx?$/.test(entry)) out.push(`${base}${entry}`);
    }
  };
  walk("", "");
  return out;
}

const files = sources();
report("there are files to sweep at all", files.length >= 50, `${files.length} modules under src/`);

{
  const named = files.filter((f) => /__TAURI__/.test(stripComments(src(f))));
  check("the injected global is named in one file", named, ["native.ts"]);
  const invokes = files.filter((f) => /\binvoke[<(]/.test(stripComments(src(f))));
  check("and so is every call through it", invokes, ["native.ts"]);
  report("the sweep can see a call at all", /__TAURI__/.test("window.__TAURI__"), "pattern matches a real read");

  const native = src("native.ts");
  check("the bridge is feature-detected rather than assumed", /typeof held\?\.core\?\.invoke === "function"/.test(native), true);
  check("and it still answers for a plain browser", /export function inNativeShell\(\): boolean/.test(native), true);
  check(
    "the transport's browser arm is a bare fetch",
    /if \(!inNativeShell\(\)\) return await fetch\(path, init\);/.test(native),
    true,
  );
  check(
    "no module imports a Tauri package",
    files.filter((f) => /from "@tauri-apps/.test(src(f))),
    [],
  );
}

{
  // An exact set: a screen holding a connection would be a second place deciding what a transport failure means.
  const holders = files.filter((f) => /\bMachineConnection\b/.test(stripComments(src(f)))).sort();
  check("the daemon transport is named in four modules", holders, [
    "daemon.ts",
    "machine.ts",
    "store.ts",
    "stream.ts",
  ]);
  report(
    "and no screen is one of them",
    holders.every((f) => !f.startsWith("ui/")),
    holders.join(", "),
  );
}

{
  // Root-relative literals only: the shell's loopback navigation allowance is debug-only, and no CSP directive constrains a location change.
  const sites: string[] = [];
  for (const file of files) {
    const body = stripComments(src(file));
    for (const match of body.matchAll(/location\.(?:assign\(|replace\(|href\s*=)\s*([^;)]*)/g)) {
      sites.push(`${file}: ${(match[1] ?? "").trim()}`);
    }
  }
  report(
    "the sweep sees a replace as a navigation",
    /location\.(?:assign\(|replace\(|href\s*=)/.test('window.location.replace("/")'),
    "positive control",
  );
  check(
    "and the account moves are among what it found",
    sites.filter((site) => site.startsWith("store.ts:") || site.startsWith("native.ts:")).length >= 5,
    true,
  );
  report("there are navigations to check", sites.length > 0, `${sites.length} assignments`);
  check(
    "every navigation this app makes is a root-relative literal",
    sites.filter((site) => !/:\s*"\/[^"]*"$/.test(site)),
    [],
  );
}

{
  // The page-calls-versus-registered direction of the command pin; nativecheck holds declared-versus-registered.
  const native = stripComments(src("native.ts"));
  const called = [
    ...new Set(
      [...native.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)]
        .map((m) => m[1])
        .filter((c): c is string => c !== undefined),
    ),
  ].sort();
  // Edit this list when a conditional command pair is added: the failure will name the shell, not this list.
  const conditional = [
    ...new Set(
      [...native.matchAll(/"(host_device_(?:set|clear))"/g)]
        .map((m) => m[1])
        .filter((c): c is string => c !== undefined),
    ),
  ];
  check(
    "the one conditional pair left is the device's, both halves",
    [...conditional].sort(),
    ["host_device_clear", "host_device_set"],
  );
  check(
    "and the credential's two are literal calls of their own",
    [called.includes("host_credential_set"), called.includes("host_credential_clear")],
    [true, true],
  );
  const wanted = [...new Set([...called, ...conditional])].sort();

  const rust = readFileSync(new URL("../../native/src-tauri/src/lib.rs", SRC), "utf8");
  const handler = /generate_handler!\[([\s\S]*?)\]/.exec(rust)?.[1] ?? "";
  const registered = [...handler.matchAll(/commands::(\w+)/g)]
    .map((m) => m[1])
    .filter((c): c is string => c !== undefined)
    .sort();

  report("commands were found on both sides", wanted.length > 0 && registered.length > 0, `${wanted.length} called, ${registered.length} registered`);
  check("every command this page calls exists in the shell", wanted.filter((c) => !registered.includes(c)), []);
  check("and every command the shell registers is called", registered.filter((c) => !wanted.includes(c)), []);
  check("no command name is assembled from a variable", /invoke(?:<[^>]*>)?\(\s*[^"a-z]/.test(native.replace(/invoke<T>\(command/g, "")), false);
}

{
  const download = stripComments(src("ui/download.ts"));
  check(
    "the download seam still re-types the blob",
    /new Blob\(\[blob\], \{ type: "application\/octet-stream" \}\)/.test(download),
    true,
  );
  check("and the native arm returns before it rather than beside it", /if \(inNativeShell\(\)\) \{\s*void saveNative\(blob, filename\);\s*return;/.test(download), true);
  check(
    "nothing in this app opens a URL in a new browsing context",
    files.filter((f) => /window\.open\(/.test(stripComments(src(f)))),
    [],
  );
  check(
    "and nothing binds an iframe to one",
    files.filter((f) => /<iframe[^>]*\bsrc=\{/.test(stripComments(src(f)))),
    [],
  );

  // A blob: URL inherits this origin, which holds reemoat.credential: it may reach an anchor only as a save (Q5.71).
  const objectUrls = files.filter((f) => /URL\.createObjectURL\(/.test(stripComments(src(f)))).sort();
  check("object URLs are made in two files", objectUrls, ["ui/ImagePreview.tsx", "ui/download.ts"]);
  check("and neither names a target", objectUrls.filter((f) => /\btarget\b/.test(stripComments(src(f)))), []);
  check(
    "the one anchor built in script is download.ts's",
    files.filter((f) => /createElement\(\s*["'`]a["'`]\s*\)/.test(stripComments(src(f)))),
    ["ui/download.ts"],
  );
  check("and it is told to save before it is clicked", /anchor\.download = filename;[\s\S]*anchor\.click\(\);/.test(download), true);
  check("no script gives any element a target", files.filter((f) => /\.target\s*=\s*["'`]|setAttribute\(\s*["'`]target/.test(stripComments(src(f)))), []);

  // `>` ends a tag only outside braces and quotes, so an arrow or a `[&>svg]` class does not cut it short.
  const anchorTags = (text: string): string[] =>
    [...text.matchAll(/<a\s/g)].map((match) => {
      const start = match.index ?? 0;
      let depth = 0;
      let quoted = false;
      let at = start + 2;
      for (; at < text.length; at += 1) {
        const c = text[at];
        if (quoted) quoted = c !== '"';
        else if (depth === 0 && c === '"') quoted = true;
        else if (c === "{") depth += 1;
        else if (c === "}") depth -= 1;
        else if (c === ">" && depth === 0) break;
      }
      return text.slice(start, at + 1);
    });
  const hrefOf = (tag: string): string => {
    const at = tag.search(/\shref=/);
    if (at < 0) return "";
    const rest = tag.slice(at + 6);
    if (rest.startsWith('"')) return rest.slice(0, rest.indexOf('"', 1) + 1);
    let depth = 0;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "{") depth += 1;
      else if (rest[i] === "}" && --depth === 0) return rest.slice(1, i);
    }
    return rest;
  };
  const probe = anchorTags('<a href={`${origin}/x`} className="[&>svg]:w-4" onClick={() => go()} target="_blank">');
  report(
    "the anchor sweep reads a tag whole",
    probe.length === 1 && probe[0]?.endsWith('target="_blank">') === true && hrefOf(probe[0]) === "`${origin}/x`",
    probe[0] ?? "no tag",
  );
  // New entries here are reviewed, not appended: each must be an address, never an object URL.
  check(
    "every anchor that opens a new browsing context without download goes to an address",
    files.flatMap((f) =>
      anchorTags(stripComments(src(f)))
        .filter((tag) => /\starget=/.test(tag) && !/\sdownload\b/.test(tag))
        .map((tag) => [f, hrefOf(tag)] as const),
    ).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    [
      ["ui/Markdown.tsx", "target"],
      ["ui/SignIn.tsx", "`${authority}/forgot`"],
      ["ui/SignIn.tsx", "`${authority}/register`"],
      ["ui/gate/Gate.tsx", "legalPath(doc)"],
      ["ui/legal/LegalScreen.tsx", "credit.workUrl"],
      ["ui/legal/LegalScreen.tsx", "credit.licenceUrl"],
      ["ui/plugins/MarketEntry.tsx", "href"],
      ["ui/settings/AgentsPanel.tsx", "url"],
    ],
  );

  const bridge = stripComments(src("native.ts"));
  const pickBody = /export async function pickFolderNative[\s\S]*?\n\}/.exec(bridge)?.[0] ?? "";
  report("the folder seam was found", pickBody.length > 0, `${String(pickBody.length)} chars`);
  check(
    "a dismissed folder panel answers null rather than throwing",
    /\(await invoke<string \| null>\("host_pick_folder", \{ start \}\)\) \?\? null/.test(pickBody),
    true,
  );
  check("and a real failure is not swallowed into one", /\btry\b|\bcatch\b/.test(pickBody), false);

  const clipboard = stripComments(src("ui/clipboard.ts"));
  check("the clipboard seam still carries its fallback", /execCommand\("copy"\)/.test(clipboard), true);
  check("and asks the platform first", /if \(inNativeShell\(\)\) return await copyNative\(text\);/.test(clipboard), true);

  const links = stripComments(src("ui/links.ts"));
  check("the openable scheme list is still exactly three", /new Set\(\["http:", "https:", "mailto:"\]\)/.test(links), true);
  check("and the interceptor decides with it rather than its own copy", /openableHref\(anchor\.getAttribute\("href"\)/.test(stripComments(src("native.ts"))), true);
}

{
  // Under the shell's custom scheme the page's origin is not the control plane, so the installer would join nothing.
  const offenders = files.filter((f) => /installCommand\(\s*(?:window\.)?location\.origin\s*\)/.test(stripComments(src(f))));
  check("no screen builds the install command out of its own origin", offenders, []);
  const callers = files.filter((f) => /installCommand\(/.test(stripComments(src(f))) && f !== "enrollment.ts");
  report("there are install-command screens to sweep", callers.length >= 3, `${callers.length} call sites`);
  check(
    "and every one of them asks where the control plane is",
    callers.filter((f) => !/installCommand\(controlPlaneOrigin\(\)\)/.test(stripComments(src(f)))),
    [],
  );
}

const cp = await import("../src/cp.js");
const holder = (globalThis as Record<string, unknown>)["window"] as Record<string, unknown>;

interface Call {
  command: string;
  args: Record<string, unknown>;
  /** The invoke headers, or null for none: the document's generation rides here. */
  headers: Record<string, string> | null;
}
const calls: Call[] = [];
let answer: (call: Call) => Promise<unknown> = async () => undefined;

function enterShell(): void {
  holder["__TAURI__"] = {
    core: {
      invoke: async (command: string, args: unknown, options?: { headers?: Record<string, string> }): Promise<unknown> => {
        const call = { command, args: (args ?? {}) as Record<string, unknown>, headers: options?.headers ?? null };
        calls.push(call);
        return await answer(call);
      },
    },
  };
}
function leaveShell(): void {
  delete holder["__TAURI__"];
}

process.stdout.write("\nthe credential, in a browser\n");
{
  storage.clear();
  cp.setSession("rs_browser");
  check("a session is written under the new name", storage.get("reemoat.credential"), "rs_browser");
  check("and read back from memory", cp.currentCredential()?.value, "rs_browser");
  cp.clearSession();
  check("clearing removes it rather than blanking it", storage.has("reemoat.credential"), false);
  check("nothing was asked of a shell that is not there", calls.length, 0);
}

process.stdout.write("\nthe credential, in the shell\n");
{
  storage.clear();
  calls.length = 0;
  enterShell();
  check("the shell is detected", cp.currentCredential(), null);

  cp.setSession("rs_native");
  check("the credential is held in memory exactly as in a browser", cp.currentCredential()?.value, "rs_native");
  check("and asks the store for nothing: the write is login's, which knows the account", calls.length, 0);
  // The two pre-rename names are read on the next load, so a value under either would be adopted from unprotected storage.
  check(
    "and never to localStorage under any of the three names",
    ["reemoat.credential", "remoslop.credential", "remoslop.apiKey"].map((k) => storage.has(k)),
    [false, false, false],
  );

  calls.length = 0;
  cp.clearSession();
  check("signing out clears the memory copy", cp.currentCredential(), null);
  check("and asks the store to forget it", calls.map((c) => c.command), ["host_credential_clear"]);
  check("and names no account: the host reads the calling window's", calls[0]?.args, {});
  check("still touching no browser storage", [...storage.keys()], []);
  // A server change drops the memory copy without a keyring clear, so the server left behind stays signed in (Q7.148).
  cp.setSession("rs_leaving");
  calls.length = 0;
  cp.detachSession();
  check("a server change lets go of the memory copy", cp.currentCredential(), null);
  check("and asks the store for nothing, so that server stays signed in", calls.length, 0);
  check("and touches no browser storage either", [...storage.keys()], []);
  leaveShell();
}

process.stdout.write("\nsigning in, in the shell: the host decides whose account it is\n");
{
  const { WrongAccount, signInError } = await import("../src/account.js");
  const LOGIN_ANSWER = {
    status: 200,
    statusText: "OK",
    body: JSON.stringify({
      token: "rs_login",
      sessionId: "s_1",
      expiresAt: 0,
      user: { id: "u_ada", name: "ada", isAdmin: false },
    }),
  };
  const boundAs = (outcome: string): Record<string, unknown> => ({
    outcome,
    account: "https://cp.example#u_ada",
    name: "ada",
    deviceId: "dv_ada",
    devicePublicKey: null,
    deviceKeyAtRest: null,
  });
  /** One sign-in, with the host answering `set` for the bind, from a clean slate. */
  const signInWith = async (set: () => Promise<unknown>): Promise<unknown> => {
    storage.clear();
    cp.clearSession();
    calls.length = 0;
    answer = async (call) => {
      if (call.command === "host_cp") return LOGIN_ANSWER;
      if (call.command === "host_credential_set") return await set();
      return undefined;
    };
    return await cp.login("ada", "correct horse battery").catch((error: unknown) => error);
  };

  enterShell();

  const signedIn = await signInWith(async () => boundAs("bound"));
  check("a sign-in the host binds is this window's", (signedIn as { name?: string }).name, "ada");
  check("the request, then the bind, and nothing else", calls.map((c) => c.command), ["host_cp", "host_credential_set"]);
  const loginRequest = calls[0]?.args["req"] as { path?: string; body?: string } | undefined;
  check("the first is the sign-in itself", loginRequest?.path, "/v1/login");
  check(
    "and it names no device: the device is an account's, and the account is what this finds out",
    Object.keys(JSON.parse(loginRequest?.body ?? "{}") as Record<string, unknown>).sort(),
    ["name", "password"],
  );
  check("the store is handed the token and nothing else", calls[1]?.args, { value: "rs_login" });
  check("and only then does the page hold it", cp.currentCredential()?.value, "rs_login");
  check(
    "still never in localStorage",
    ["reemoat.credential", "remoslop.credential", "remoslop.apiKey"].map((k) => storage.has(k)),
    [false, false, false],
  );

  const duplicate = await signInWith(async () => boundAs("existing"));
  check("an account already open is a named rejection", duplicate instanceof cp.AccountAlreadyOpen, true);
  check("naming the account the host keyed it on", (duplicate as { account?: string }).account, "https://cp.example#u_ada");
  check("and the page adopted nothing", cp.currentCredential(), null);
  check("nor sent anything with a bearer it never held", calls.map((c) => c.command), ["host_cp", "host_credential_set"]);

  const adopted = await signInWith(async () => boundAs("adopted"));
  check("an account signed out elsewhere here takes the sign-in, and the window moves", adopted instanceof cp.AccountAlreadyOpen, true);
  check("and this window adopted nothing", cp.currentCredential(), null);

  const stranger = await signInWith(async () => boundAs("refused"));
  check("somebody else on this account's screen is refused", stranger instanceof WrongAccount, true);
  check("and nothing is adopted", cp.currentCredential(), null);
  check("and the screen says which way forward", /different account/.test(signInError(stranger)), true);

  const unreachable = await signInWith(async () => {
    throw "could not ask the control plane whose this is";
  });
  check("a bind the host could not make fails the sign-in", unreachable instanceof Error || typeof unreachable === "string", true);
  check("and leaves the page holding nothing", cp.currentCredential(), null);

  const unknown = await signInWith(async () => boundAs("merged"));
  check("an answer this page does not know is not a success", unknown instanceof Error, true);
  check("and adopts nothing", cp.currentCredential(), null);

  await signInWith(async () => boundAs("bound"));
  report("and the stub itself adopts when bound, so the nulls above are the page's", cp.currentCredential()?.value === "rs_login", "bound adopts");

  cp.clearSession();
  answer = async () => undefined;
  leaveShell();
  storage.clear();
}

process.stdout.write("\nwhich document a command comes from\n");
{
  // The wiring is read off source: hostReady settles once at import, and here it settled with no shell.
  const bridge = await import("../src/native.js");
  check(
    "a command after boot carries the document's generation",
    bridge.withGeneration("host_cp", "g_1"),
    { headers: { "reemoat-generation": "g_1" } },
  );
  check("host_boot never does: it is how a document learns one", bridge.withGeneration("host_boot", "g_1"), undefined);
  check("and nothing is claimed before the host has answered", bridge.withGeneration("host_cp", null), undefined);
  check(
    "a caller's own headers ride beside it",
    bridge.withGeneration("host_save_file", "g_1", { headers: { "x-reemoat-filename": "a%20b" } }),
    { headers: { "x-reemoat-filename": "a%20b", "reemoat-generation": "g_1" } },
  );
  check(
    "and cannot overwrite the value the host issued",
    bridge.withGeneration("host_cp", "g_1", { headers: { "reemoat-generation": "forged" } }),
    { headers: { "reemoat-generation": "g_1" } },
  );

  const source = stripComments(src("native.ts"));
  check(
    "every command goes out through that one rule",
    /held\.invoke<T>\(command, args, withGeneration\(command, sent, options\)\)/.test(source),
    true,
  );
  check(
    "every command but host_boot waits for the host to have answered, while it has not",
    /if \(command !== "host_boot" && generation === null && hydrating\) await hostReady;/.test(source),
    true,
  );
  check(
    "and what it sends is read after that wait, never before it",
    source.indexOf("await hostReady;") < source.indexOf('const sent = command === "host_boot" ? null : generation;') &&
      source.indexOf("await hostReady;") >= 0,
    true,
  );
  check("with the generation the boot answer issued", /generation = answer\.generation \?\? null;/.test(source), true);
  check("under the name the host reads", /const GENERATION_HEADER = "reemoat-generation";/.test(source), true);
  check("and a rebinding answer is asked again rather than drawn", /answer\.rebinding !== true/.test(source), true);

  enterShell();
  calls.length = 0;
  answer = async () => null;
  await bridge.nativeAccounts();
  check(
    "in a document the host never answered, no command claims a generation",
    calls.map((c) => [c.command, c.headers]),
    [["host_accounts", null]],
  );

  check(
    "a stale refusal is known by its code, whoever words the rest",
    [
      bridge.isStaleDocument("stale_document: this window shows another account now"),
      bridge.isStaleDocument(new Error("stale_document")),
      bridge.isStaleDocument("not_shown"),
    ],
    [true, true, false],
  );
  const location = holder["location"] as Record<string, unknown>;
  const replaced: unknown[] = [];
  location["replace"] = (to: unknown): void => {
    replaced.push(to);
  };
  answer = async () => {
    throw "stale_document: this window shows another account now";
  };
  const swallowed = await bridge.nativeAccounts();
  const refused = await bridge.switchNativeAccount(null).catch((error: unknown) => error);
  await bridge.nativeAccounts();
  check("a wrapper that swallows still answers what it always did", swallowed, null);
  check("and one that rejects still rejects, so the caller stops", String(refused).startsWith("stale_document"), true);
  check(
    "a document the host never named reloads on nothing — that is the loop the first build made",
    replaced,
    [],
  );
  check(
    "only a refusal of a call that carried a generation sends the document away",
    [
      bridge.shouldLeave("g_1", "stale_document: this window shows another account now"),
      bridge.shouldLeave(null, "stale_document: this window shows another account now"),
      bridge.shouldLeave("g_1", "not_shown"),
    ],
    [true, false, false],
  );
  check(
    "and the document is replaced by the app's own root, once",
    [/if \(!leaving && shouldLeave\(sent, error\)\) \{\s*leaving = true;\s*window\.location\.replace\("\/"\);/.test(source)],
    [true],
  );
  delete location["replace"];
  answer = async () => undefined;
  leaveShell();
}

process.stdout.write("\nadopting what the keyring held\n");
{
  storage.clear();
  cp.clearSession();
  cp.adoptHydratedCredential("rs_fromkeyring");
  check("a keyring credential is adopted", cp.currentCredential()?.value, "rs_fromkeyring");
  check("and its kind is read off the prefix", cp.currentCredential()?.kind, "session");
  cp.adoptHydratedCredential("rs_second");
  check("but it never replaces one already held", cp.currentCredential()?.value, "rs_fromkeyring");
  cp.clearSession();
  cp.adoptHydratedCredential(null);
  check("and a keyring with nothing in it adopts nothing", cp.currentCredential(), null);

  const boot = await import("../src/native.js");
  check("a browser is never hydrating", boot.nativeHydrating(), false);
  check("and has no host to describe", boot.nativeBoot(), null);
  check("so the control plane is this page's own origin", boot.controlPlaneOrigin(), "http://127.0.0.1");
}

process.stdout.write("\nthe control-plane transport\n");
{
  const { cpSend } = await import("../src/native.js");
  const fetched: { path: string; init: unknown }[] = [];
  const original = (globalThis as Record<string, unknown>)["fetch"];
  (globalThis as Record<string, unknown>)["fetch"] = async (path: string, init: unknown): Promise<Response> => {
    fetched.push({ path, init });
    return new Response('{"ok":true}', { status: 200 });
  };

  leaveShell();
  calls.length = 0;
  const browserAnswer = await cpSend("/v1/me", { method: "GET" });
  check("in a browser the path goes to fetch untouched", fetched.map((f) => f.path), ["/v1/me"]);
  check("and the answer is the browser's own", await browserAnswer.json(), { ok: true });
  check("nothing reached the shell", calls.length, 0);

  enterShell();
  calls.length = 0;
  fetched.length = 0;
  answer = async () => ({ status: 200, statusText: "OK", body: '{"ok":true}' });
  const shellAnswer = await cpSend("/v1/me", { method: "GET", headers: { authorization: "Bearer rs_x" } });
  check("in the shell nothing reaches the page's fetch", fetched.length, 0);
  check("the one command carries the request", calls.map((c) => c.command), ["host_cp"]);
  // A path, never a URL: the base URL lives in the host, or the host becomes a general proxy for this page.
  const sent = calls[0]?.args["req"] as Record<string, unknown>;
  check("as a path rather than a URL", sent["path"], "/v1/me");
  check("with no origin named by the page", sent["origin"], null);
  check("and only the headers cp.ts built", sent["headers"], [["authorization", "Bearer rs_x"]]);
  check("the answer is rebuilt as a Response", shellAnswer.status, 200);
  check("and its body survives", await shellAnswer.json(), { ok: true });

  const { ApiError, readJson } = await import("../src/http.js");
  answer = async () => ({ status: 401, statusText: "Unauthorized", body: '{"error":{"code":"session_expired","message":"gone"}}' });
  const refused = await cpSend("/v1/me");
  let caught: unknown = null;
  await readJson(refused).catch((error: unknown) => {
    caught = error;
  });
  check("a refusal is an ApiError with the server's own code", caught instanceof ApiError && caught.code, "session_expired");

  // A host failure must reject, never answer a status: isTransportFailure is a negation, so a 401 would sign the fleet out.
  const { isTransportFailure } = await import("../src/http.js");
  answer = async () => {
    throw new Error("could not reach the server");
  };
  let thrown: unknown = null;
  await cpSend("/v1/me").catch((error: unknown) => {
    thrown = error;
  });
  check("a host failure rejects rather than answering", thrown instanceof Error, true);
  check("and reads as a transport failure rather than a credential one", isTransportFailure(thrown), true);
  const { authFailure } = await import("../src/account.js");
  check("so it never ends the session", authFailure(thrown), null);

  /* A bodiless status must not be handed a body; `new Response` throws on one. */
  answer = async () => ({ status: 204, statusText: "No Content", body: "" });
  check("a 204 is rebuilt without throwing", (await cpSend("/v1/me")).status, 204);

  (globalThis as Record<string, unknown>)["fetch"] = original;
  leaveShell();
}

process.stdout.write("\na refusal about a credential that is no longer held\n");
{
  storage.clear();
  enterShell();
  cp.setSession("rs_stale");

  // Initialized rather than nullable: the compiler still sees null for a let assigned inside a Promise executor.
  let release = (): void => undefined;
  const parked = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  answer = async () => {
    await parked;
    return { status: 401, statusText: "Unauthorized", body: '{"error":{"code":"session_expired","message":"gone"}}' };
  };

  const inFlight = cp.me().catch((error: unknown) => error);
  cp.setSession("rs_fresh");
  check("a sign-in during the call replaces the credential", cp.currentCredential()?.value, "rs_fresh");
  release();
  const landed = await inFlight;
  check("the caller is still told the call failed", (landed as { code?: string }).code, "session_expired");
  check("but the credential it was not about is untouched", cp.currentCredential()?.value, "rs_fresh");

  calls.length = 0;
  answer = async () => ({ status: 401, statusText: "Unauthorized", body: '{"error":{"code":"session_expired","message":"gone"}}' });
  await cp.me().catch(() => undefined);
  check("a refusal about the credential in hand does clear it", cp.currentCredential(), null);
  check("and the store is told to forget it", calls.some((c) => c.command === "host_credential_clear"), true);

  leaveShell();
  storage.clear();
}

{
  const srcRoot = new URL("../src/", import.meta.url);
  const OS_WORD = /\bmacOS\b|\bWindows\b|\bLinux\b/;
  const walk = (dir: URL, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) return walk(new URL(`${entry.name}/`, dir), `${path}/`);
      if (!/\.tsx?$/.test(entry.name)) return [];
      return OS_WORD.test(stripComments(readFileSync(new URL(entry.name, dir), "utf8"))) ? [path] : [];
    });

  check("exactly these files name an operating system", walk(srcRoot, "").sort(), [
    "device.ts",
    "enrollment.ts",
    "legal/terms.ts",
    "platform.ts",
    "ui/agentCard.ts",
  ]);

  const bootstrap = readFileSync(new URL("../../../deploy/bootstrap.sh", import.meta.url), "utf8");
  const detect = bootstrap.slice(bootstrap.indexOf("detect_platform"));
  check("the bootstrap sweep found its own function", detect.length > 0, true);
  check("the installer still accepts exactly the two this names", [/Darwin\)/.test(detect), /Linux\)/.test(detect)], [true, true]);
  const enrollment = stripComments(readFileSync(new URL("../src/enrollment.ts", import.meta.url), "utf8"));
  check("and the clause beside the command names no third", /AGENT_HOST_OS = "macOS or Linux"/.test(enrollment), true);
  check("and is never computed from what this client runs on", /nativeBoot/.test(enrollment), false);
}

{
  const { hostPlatform, localNetworkDetail, platformName } = await import("../src/platform.js");
  const all = ["macos", "windows", "linux", "other"] as const;

  check("every platform is narrowed to itself", all.map((p) => hostPlatform(p)), [...all]);
  check("and anything else is a platform we say nothing special about", [
    hostPlatform("freebsd"),
    hostPlatform("android"),
    hostPlatform(null),
    hostPlatform(undefined),
    hostPlatform(""),
  ], ["other", "other", "other", "other", "other"]);

  check(
    "the three platforms this app knows are drawn as their own names",
    (["macos", "windows", "linux"] as const).map((p) => [p, platformName(p)]),
    [
      ["macos", "macOS"],
      ["windows", "Windows"],
      ["linux", "Linux"],
    ],
  );

  check(
    "and every platform it does not know is handed back as it was reported",
    ["freebsd", "ios", "android", "solaris"].map((raw) => platformName(raw)),
    ["freebsd", "ios", "android", "solaris"],
  );

  check(
    "a daemon's vocabulary is not understood here, it is passed through",
    ["darwin", "win32"].map((raw) => platformName(raw)),
    ["darwin", "win32"],
  );

  const said = all.map((p) => localNetworkDetail(p));
  check("every platform gets a sentence", said.filter((s) => s.length > 20).length, said.length);
  // Only the macOS remedy is measured; move this count with a measurement, never ahead of one.
  check("exactly one of them names an operating system", said.filter((s) => /\bmacOS\b/.test(s)).length, 1);
  check("and none of them names one nobody has measured", said.some((s) => /\bWindows\b|\bLinux\b/.test(s)), false);
  check("and none of them names the logs screen the caller points at", said.some((s) => /Settings → Logs/.test(s)), false);

  const platformSrc = readFileSync(new URL("../src/platform.ts", import.meta.url), "utf8");
  const platformCode = stripComments(platformSrc);
  const exhaustiveArms = (platformCode.match(/const exhaustive: never = platform;/g) ?? []).length;
  check("both switches over HostPlatform end in a never arm", exhaustiveArms, 2);
  for (const fn of ["localNetworkDetail", "platformName"]) {
    const body = new RegExp(`export function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(platformCode)?.[1] ?? "";
    check(`a fifth platform is a compile error in ${fn} rather than a blank sentence`, /const exhaustive: never = platform;/.test(body), true);
  }

  // The client's (Rust) and the daemon's (Node) platform vocabularies share one spelling, so neither module may import the other.
  const agentCard = stripComments(readFileSync(new URL("../src/ui/agentCard.ts", import.meta.url), "utf8"));
  check("the daemon's platform reader knows nothing of the client's", /from "\.\.\/platform"/.test(agentCard), false);
  check("and the client's knows nothing of the daemon's", /agentCard/.test(platformCode), false);
  const storeSrc = stripComments(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
  check("the one caller asks the host rather than the wire", /hostPlatform\(this\.snapshot\.host\?\.platform\)/.test(storeSrc), true);

  const devicesSrc = stripComments(
    readFileSync(new URL("../src/ui/settings/DevicesSection.tsx", import.meta.url), "utf8"),
  );
  check("the devices row draws the platform through it", /\{platformName\(row\.platform\)\}/.test(devicesSrc), true);
  check("and never draws the raw field beside a separator", /\{row\.platform\}/.test(devicesSrc), false);
  report(
    "and that absence is a real search rather than a typo",
    /\{row\.platform\}/.test("<span>{row.platform}</span>"),
    "the pattern matches a raw draw when there is one",
  );
}
