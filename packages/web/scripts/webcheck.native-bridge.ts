import { readFileSync, readdirSync, statSync } from "node:fs";
import { check, report, storage } from "./webcheck.env.js";
import { stripComments } from "./webcheck.source.js";

/* ------------------------------------------------------------------ *
 * The native shell, from this side of the bridge
 *
 * **This section exists because the credential moves.** In a browser it is in
 * `localStorage` and every rule about it has been asserted here for releases; in
 * the native shell it is in the operating system's credential store, and the two
 * arms share one function. So every one of those rules has to hold twice, and the
 * second time through a transport nothing else here has ever driven.
 *
 * Two of the assertions below are the ones that would otherwise be lost silently
 * rather than loudly, and they are worth naming:
 *
 *   - **the credential never reaches `localStorage` in the shell.** A native build
 *     that wrote to both would work perfectly and would have put the credential in
 *     the one place the whole exercise exists to get it out of.
 *   - **a 401 for a *superseded* credential still does not clear the current one.**
 *     `cpFetch` captures `const sent = credential` and compares by identity, and
 *     the ten-second window that rule defends is unchanged by which transport
 *     answered. A host that mapped its failures wrongly would either sign the fleet
 *     out on every subway tunnel or never sign anybody out at all, and the existing
 *     table one section over would stay green through both.
 *
 * **The arms are reachable in one process, and that is a property of the design
 * rather than a trick.** `inNativeShell()` reads the injected global on *every*
 * call rather than latching it at import time, so installing it mid-run flips the
 * arm without re-importing anything. What is decided at import time and stays
 * decided is only the hydration state, which is driven through its own exported
 * function.
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe native bridge, and the browser arm it must not disturb\n");

const SRC = new URL("../src/", import.meta.url);
const src = (rel: string): string => readFileSync(new URL(rel, SRC), "utf8");

/** Every `.ts`/`.tsx` under `packages/web/src`, the sweep the clipboard census uses. */
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

/* ------------------------------------------------------------------ *
 * One file names the platform, the way one file names the clipboard
 * ------------------------------------------------------------------ */
{
  /*
   * The same shape of rule as `navigator.clipboard`'s census, and for the same
   * reason: what is interesting is the **absence** of a call anywhere else. A React
   * component reaching for `__TAURI__` directly is how a shared codebase acquires a
   * native-only branch that a browser silently takes the wrong side of.
   *
   * Comments stripped first, because this file's own docblocks name the global while
   * forbidding it elsewhere — exactly what the clipboard docblocks do.
   */
  const named = files.filter((f) => /__TAURI__/.test(stripComments(src(f))));
  check("the injected global is named in one file", named, ["native.ts"]);
  const invokes = files.filter((f) => /\binvoke[<(]/.test(stripComments(src(f))));
  check("and so is every call through it", invokes, ["native.ts"]);
  report("the sweep can see a call at all", /__TAURI__/.test("window.__TAURI__"), "pattern matches a real read");

  const native = src("native.ts");
  /*
   * The reverse half, which the clipboard census also has: a file that became
   * native-only would pass the census above and break every browser. So the
   * predicate has to exist, and it has to be the thing every export is gated on.
   */
  check("the bridge is feature-detected rather than assumed", /typeof held\?\.core\?\.invoke === "function"/.test(native), true);
  check("and it still answers for a plain browser", /export function inNativeShell\(\): boolean/.test(native), true);
  check(
    "the transport's browser arm is a bare fetch",
    /if \(!inNativeShell\(\)\) return await fetch\(path, init\);/.test(native),
    true,
  );
  /*
   * No `@tauri-apps` import anywhere, asserted over the source as well as over the
   * manifest: a dependency can be added to a file without being added to a
   * `package.json`, and it is the *import* that ends up in the bundle the control
   * plane's image serves.
   */
  check(
    "no module imports a Tauri package",
    files.filter((f) => /from "@tauri-apps/.test(src(f))),
    [],
  );
}

/* ------------------------------------------------------------------ *
 * The transport is five modules, and no screen is one of them
 * ------------------------------------------------------------------ */
{
  /*
   * **The separation this client is built on, asserted instead of described.**
   *
   * `MachineConnection` is where a token, a route, a retry budget, a timeout table
   * and what a failure *means* all live, and `DaemonClient` is the logical session
   * API above it — the same object whether the answer came down the relay's tunnel
   * or over loopback, which is the whole reason adding the second arm changed no
   * screen. A component that reached past `store.daemonFor(id)` and held a
   * connection would be a second place deciding what a transport failure is, and
   * `isTransportFailure` is a **negation**: the two ways a second opinion can
   * disagree are "every subway tunnel signs the fleet out" and "nobody is ever
   * signed out".
   *
   * An exact set rather than a ceiling, in this file's own idiom: a ceiling passes
   * for ever while the set drifts, and what is interesting here is the **absence**
   * of a fifth name. Comments are stripped first, so `http.ts` — whose
   * `meansMachineGone` docblock names the class it is the rule for — is correctly
   * not one of them: the point is who *holds* a connection, not who mentions one.
   */
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

/* ------------------------------------------------------------------ *
 * Nothing navigates this window off its own document
 * ------------------------------------------------------------------ */
{
  /*
   * ⚠ **The caller-side half of `is_our_own`, and it became load-bearing.** The
   * shell's navigation guard allowed `http://localhost` and `http://127.0.0.1`
   * unconditionally, on the reasoning that they are the Vite dev server — and a
   * Reemoat control plane on loopback is the ordinary self-hosted shape, serving
   * its own `index.html` at `/`. So a navigation to it would have replaced the
   * running app with the *backend's* page, inside the window holding the fleet's
   * credential: precisely what bundling the frontend exists to make impossible.
   * The guard is `#[cfg(debug_assertions)]` now, and this is the other side of it.
   *
   * Every assignment in this client passes a **root-relative literal** — `"/"`,
   * today, at every site — which stays inside the app whatever origin it is
   * serving from. A computed one would be a value an agent's output could reach.
   * The CSP cannot help here: there is no `navigate-to` directive, and neither
   * `form-action` nor `base-uri` constrains `location.assign`.
   */
  const sites: string[] = [];
  for (const file of files) {
    const body = stripComments(src(file));
    for (const match of body.matchAll(/location\.(?:assign\(|href\s*=)\s*([^;)]*)/g)) {
      sites.push(`${file}: ${(match[1] ?? "").trim()}`);
    }
  }
  report("there are navigations to check", sites.length > 0, `${sites.length} assignments`);
  check(
    "every navigation this app makes is a root-relative literal",
    sites.filter((site) => !/:\s*"\/[^"]*"$/.test(site)),
    [],
  );
}

/* ------------------------------------------------------------------ *
 * The commands this side calls are the commands the shell registers
 * ------------------------------------------------------------------ */
{
  /*
   * **The third direction of a three-way pin.** `nativecheck` compares the commands
   * the Rust *declares* with the ones it *registers*; this compares what the page
   * *calls* with what is registered — the direction that fails at runtime with
   * `Command … not found` and which no offline check on either side alone can see.
   */
  const native = stripComments(src("native.ts"));
  const called = [
    ...new Set(
      [...native.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)]
        .map((m) => m[1])
        .filter((c): c is string => c !== undefined),
    ),
  ].sort();
  /*
   * Two command names are built by a conditional rather than written as a literal
   * — the credential set/clear pair and the device set/clear pair, each an
   * `invoke(value === null ? "…_clear" : "…_set", …)` — so they are named here
   * too. Written out rather than pattern-matched: a name this census cannot see
   * is a name the pin does not cover, and saying which ones is cheaper than a
   * cleverer regex.
   *
   * ⚠ **This list is the thing to edit when a conditional pair is added**, and it
   * is easy to miss because the failure names the *shell* — "a command the shell
   * registers is not called" — for commands that are called on every launch. The
   * person hitting it will look in `nativecheck`, which holds the other direction
   * of the same census and has nothing to say about this.
   */
  const conditional = [
    ...new Set(
      [...native.matchAll(/"(host_(?:credential|device)_(?:set|clear))"/g)]
        .map((m) => m[1])
        .filter((c): c is string => c !== undefined),
    ),
  ];
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
  /*
   * A computed command name makes the census above vacuous, so it is refused
   * outright — the two `host_credential_*` names are picked by a ternary over two
   * *literals*, which this still sees.
   */
  check("no command name is assembled from a variable", /invoke(?:<[^>]*>)?\(\s*[^"a-z]/.test(native.replace(/invoke<T>\(command/g, "")), false);
}

/* ------------------------------------------------------------------ *
 * The seams keep their rules, and gain an arm
 * ------------------------------------------------------------------ */
{
  const download = stripComments(src("ui/download.ts"));
  /*
   * ⚠ **The line `download.ts`'s own docblock calls the one that must not change**,
   * asserted for the first time here: it was enforced by prose alone, and a native
   * arm arriving above it is exactly the edit that could have moved it.
   */
  check(
    "the download seam still re-types the blob",
    /new Blob\(\[blob\], \{ type: "application\/octet-stream" \}\)/.test(download),
    true,
  );
  check("and the native arm returns before it rather than beside it", /if \(inNativeShell\(\)\) \{\s*void saveNative\(blob, filename\);\s*return;/.test(download), true);
  /* The three negatives that docblock states, turned into assertions. */
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

  /*
   * ⚠ **A cancel is not a failure, and the two seams say so in opposite ways.**
   * `saveNative` answers `false` for a dismissed panel; `pickFolderNative` answers
   * `null`. What both must never do is turn a dismissal into an error, and what
   * *this* one must never do is turn an error into a dismissal — which is where it
   * parts company with `copyNative` one block up, that swallows because losing a
   * clipboard write costs the chrome and nothing else. A swallowed folder is a
   * `Start` button dead over a folder nobody can see is missing, so the absence of
   * a `try` in that body is asserted rather than left to a docblock.
   */
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

  /*
   * The scheme allowlist stays three long and stays in `links.ts`. `nativecheck`
   * compares it to the shell's copy; this asserts the page's own reuse of it, which
   * is what makes the click interceptor one policy rather than a fourth.
   */
  const links = stripComments(src("ui/links.ts"));
  check("the openable scheme list is still exactly three", /new Set\(\["http:", "https:", "mailto:"\]\)/.test(links), true);
  check("and the interceptor decides with it rather than its own copy", /openableHref\(anchor\.getAttribute\("href"\)/.test(stripComments(src("native.ts"))), true);
}

/* ------------------------------------------------------------------ *
 * The install command names the server, not the page
 * ------------------------------------------------------------------ */
{
  /*
   * ⚠ **Three call sites, and only two of them were ever asserted.** Under a custom
   * scheme `installCommand(location.origin)` prints
   * `curl -fsSL 'tauri://localhost/install.sh' | sh` — an installer that joins
   * nothing, on the one screen whose whole job is to be copied. Swept rather than
   * named, so a fourth screen drawing it is covered by arriving.
   */
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

/* ------------------------------------------------------------------ *
 * The credential: the browser arm, unchanged
 * ------------------------------------------------------------------ */

const cp = await import("../src/cp.js");
const holder = (globalThis as Record<string, unknown>)["window"] as Record<string, unknown>;

interface Call {
  command: string;
  args: Record<string, unknown>;
}
const calls: Call[] = [];
let answer: (call: Call) => Promise<unknown> = async () => undefined;

function enterShell(): void {
  holder["__TAURI__"] = {
    core: {
      invoke: async (command: string, args: unknown): Promise<unknown> => {
        const call = { command, args: (args ?? {}) as Record<string, unknown> };
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

/* ------------------------------------------------------------------ *
 * The credential: the native arm
 * ------------------------------------------------------------------ */

process.stdout.write("\nthe credential, in the shell\n");
{
  storage.clear();
  calls.length = 0;
  enterShell();
  check("the shell is detected", cp.currentCredential(), null);

  cp.setSession("rs_native");
  check("the credential is held in memory exactly as in a browser", cp.currentCredential()?.value, "rs_native");
  check("and handed to the operating system's store", calls.map((c) => c.command), ["host_credential_set"]);
  check("with the value and nothing else", calls[0]?.args, { value: "rs_native" });
  /*
   * ⚠ **The assertion this whole section exists for.** All three names, because the
   * two pre-rename ones are read on the next page load in preference to nothing —
   * so a value left under either is a credential a later launch would adopt out of
   * unprotected storage.
   */
  check(
    "and never to localStorage under any of the three names",
    ["reemoat.credential", "remoslop.credential", "remoslop.apiKey"].map((k) => storage.has(k)),
    [false, false, false],
  );

  calls.length = 0;
  cp.clearSession();
  check("signing out clears the memory copy", cp.currentCredential(), null);
  check("and asks the store to forget it", calls.map((c) => c.command), ["host_credential_clear"]);
  check("still touching no browser storage", [...storage.keys()], []);
  /*
   * ⚠ **The other half, and the one a server change takes (Q7.148).** Switching
   * servers keeps the one being left signed in, so the page lets go of its copy
   * — which is what stops the old fleet's bearer riding a request to the new host
   * — and asks the store for nothing. A `detachSession` that reached the keyring
   * would put the sign-out back into every switch, silently.
   */
  cp.setSession("rs_leaving");
  calls.length = 0;
  cp.detachSession();
  check("a server change lets go of the memory copy", cp.currentCredential(), null);
  check("and asks the store for nothing, so that server stays signed in", calls.length, 0);
  check("and touches no browser storage either", [...storage.keys()], []);
  leaveShell();
}

/* ------------------------------------------------------------------ *
 * Hydration: what the store adopts, and what it may not overwrite
 * ------------------------------------------------------------------ */

process.stdout.write("\nadopting what the keyring held\n");
{
  storage.clear();
  cp.clearSession();
  cp.adoptHydratedCredential("rs_fromkeyring");
  check("a keyring credential is adopted", cp.currentCredential()?.value, "rs_fromkeyring");
  check("and its kind is read off the prefix", cp.currentCredential()?.kind, "session");
  cp.adoptHydratedCredential("rs_second");
  /*
   * **A credential adopted since wins**, which is the same reasoning `cpFetch` uses
   * about a late 401: a sign-in that completed while the keyring read was in flight
   * is newer than what the keyring held, and an async read landing afterwards must
   * not put the old one back.
   */
  check("but it never replaces one already held", cp.currentCredential()?.value, "rs_fromkeyring");
  cp.clearSession();
  cp.adoptHydratedCredential(null);
  check("and a keyring with nothing in it adopts nothing", cp.currentCredential(), null);

  const boot = await import("../src/native.js");
  check("a browser is never hydrating", boot.nativeHydrating(), false);
  check("and has no host to describe", boot.nativeBoot(), null);
  check("so the control plane is this page's own origin", boot.controlPlaneOrigin(), "http://127.0.0.1");
}

/* ------------------------------------------------------------------ *
 * The transport, and the two ways a host can get a refusal wrong
 * ------------------------------------------------------------------ */

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
  /*
   * ⚠ **A path, never a URL.** The base URL lives in the host process, so this is
   * the assertion that `cp.ts`'s oldest rule — the credential goes to one origin and
   * nowhere else — is enforced somewhere the page cannot reach. A `req.path` that
   * were ever absolute would make the host a general-purpose proxy for this page.
   */
  const sent = calls[0]?.args["req"] as Record<string, unknown>;
  check("as a path rather than a URL", sent["path"], "/v1/me");
  check("with no origin named by the page", sent["origin"], null);
  check("and only the headers cp.ts built", sent["headers"], [["authorization", "Bearer rs_x"]]);
  check("the answer is rebuilt as a Response", shellAnswer.status, 200);
  check("and its body survives", await shellAnswer.json(), { ok: true });

  /*
   * A refusal the control plane authored comes back as a `Response`, so `parseBody`
   * reads the error envelope exactly as it does in a browser.
   */
  const { ApiError, readJson } = await import("../src/http.js");
  answer = async () => ({ status: 401, statusText: "Unauthorized", body: '{"error":{"code":"session_expired","message":"gone"}}' });
  const refused = await cpSend("/v1/me");
  let caught: unknown = null;
  await readJson(refused).catch((error: unknown) => {
    caught = error;
  });
  check("a refusal is an ApiError with the server's own code", caught instanceof ApiError && caught.code, "session_expired");

  /*
   * ⚠ **And a failure is a rejection, never a status.** `isTransportFailure` is a
   * negation — anything that is not an `ApiError` — so a host that answered a
   * transport failure as a 401 would sign the whole fleet out on the first subway
   * tunnel, with the table in the previous section still green.
   */
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

/* ------------------------------------------------------------------ *
 * The rule a transport swap loses silently
 * ------------------------------------------------------------------ */

process.stdout.write("\na refusal about a credential that is no longer held\n");
{
  /*
   * ⚠ **The sharpest hazard in the whole migration, driven over the native
   * transport.** `cpFetch` captures `const sent = credential` before building the
   * header and tears down only while `credential === sent`; its docblock records the
   * exact ten-second race — a slow call sent with an expired token, a wake, a
   * sign-in that succeeds, and then the old request answering `401 session_expired`
   * and clearing the *new* credential. The window is `CP_TIMEOUT_MS` wide whichever
   * transport is carrying the request, so the rule has to hold on both.
   */
  storage.clear();
  enterShell();
  cp.setSession("rs_stale");

  // Initialized rather than nullable: a `let x: (() => void) | null = null` assigned
  // inside a Promise executor is still `null` to the compiler at the call below.
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

  /* And the ordinary case still signs you out, or the rule above is vacuous. */
  calls.length = 0;
  answer = async () => ({ status: 401, statusText: "Unauthorized", body: '{"error":{"code":"session_expired","message":"gone"}}' });
  await cp.me().catch(() => undefined);
  check("a refusal about the credential in hand does clear it", cp.currentCredential(), null);
  check("and the store is told to forget it", calls.some((c) => c.command === "host_credential_clear"), true);

  leaveShell();
  storage.clear();
}

/* ------------------------------------------------------------------ *
 * Which operating system a sentence may name, and where
 * ------------------------------------------------------------------ */

/**
 * **One function names an operating system, and this is the census that keeps it
 * to one.**
 *
 * The defect it generalises: `LOCAL_NETWORK_DETAIL` in `store.ts` told everybody
 * on every platform to *"allow it under System Settings → Privacy & Security →
 * Local Network"*, while the classifier that produced that state keys on an errno
 * and fires on any Unix. So a Linux box behind a firewall was handed a remedy
 * naming a screen that does not exist. Nothing could have caught it: it compiles,
 * it renders, and it is wrong only where nobody developing it was sitting.
 *
 * Stated as an **exact set** rather than a ceiling, in this driver's own idiom —
 * what is interesting is the *absence* of a fifth name, and a `<= 4` would pass
 * over a fifth screen that had quietly grown one.
 */
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

  /*
   * Each of the four is a different reason, and none of them is "a screen
   * explaining itself":
   *
   *   platform.ts      the one sentence with a measured per-platform remedy
   *   device.ts        a *user-agent's* own words, read back on a sign-in row
   *   ui/agentCard.ts  the **daemon's** platform, which is Node's vocabulary
   *   legal/terms.ts   what an agent host must be, which is a fact about the
   *                    service rather than about this client
   *   enrollment.ts    `AGENT_HOST_OS`, the machines `install.sh` can be run on
   *
   * ⚠ **Not one of them is a screen describing the computer it is drawn on**, and
   * that is the line. The last two are about the machine that will run *agents* —
   * a Windows client adding a Linux machine is the ordinary case — which is why
   * neither may ever be computed from `nativeBoot()?.platform`.
   */
  check("exactly these files name an operating system", walk(srcRoot, "").sort(), [
    "device.ts",
    "enrollment.ts",
    "legal/terms.ts",
    "platform.ts",
    "ui/agentCard.ts",
  ]);

  /*
   * And the clause beside the install command agrees with the script that
   * refuses everything else. `deploy/bootstrap.sh`'s `detect_platform` is the
   * authority; a screen that promised a third platform would be promising an
   * installer that answers a sentence.
   */
  const bootstrap = readFileSync(new URL("../../../deploy/bootstrap.sh", import.meta.url), "utf8");
  const detect = bootstrap.slice(bootstrap.indexOf("detect_platform"));
  check("the bootstrap sweep found its own function", detect.length > 0, true);
  check("the installer still accepts exactly the two this names", [/Darwin\)/.test(detect), /Linux\)/.test(detect)], [true, true]);
  const enrollment = stripComments(readFileSync(new URL("../src/enrollment.ts", import.meta.url), "utf8"));
  check("and the clause beside the command names no third", /AGENT_HOST_OS = "macOS or Linux"/.test(enrollment), true);
  check("and is never computed from what this client runs on", /nativeBoot/.test(enrollment), false);
}

/**
 * The platform sentence is total and only one of its arms names an OS — and the
 * platform *name*, which is a different rule living in the same file: a mapping
 * for the three this app knows, and a **passthrough** for everything else.
 */
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

  /*
   * ⚠ **The row that read `macos · in use`, and what was missing is a
   * *behavioural* assertion.** `platformName`'s `never` arm is pinned off disk
   * below and both of its siblings in this file are swept over every arm — but
   * nothing ever asserted that `macos` draws **macOS**, so the defect it fixes is
   * one character from returning with every other assertion here green.
   *
   * Stated as **pairs**, and split from the passthrough table below, because the
   * two ways this regresses fail on opposite halves: an identity function passes
   * every passthrough row and fails all three of these, and a function that
   * invented a word for the unknown case passes all three of these and fails every
   * passthrough row. Neither table alone is a control for the other's mutant.
   */
  check(
    "the three platforms this app knows are drawn as their own names",
    (["macos", "windows", "linux"] as const).map((p) => [p, platformName(p)]),
    [
      ["macos", "macOS"],
      ["windows", "Windows"],
      ["linux", "Linux"],
    ],
  );

  /*
   * ⚠ **And everything else is answered *raw*, which is a decision rather than a
   * fallback.** `std::env::consts::OS` also says `freebsd`, `ios` and `android`,
   * and the argument is in `platformName`'s own docblock: a row reading "Other"
   * tells somebody less about their own computer than the lower-case name it
   * actually reported. Over several inputs, because a single one is satisfied by
   * any function that happens to echo that one string. `""` is deliberately not
   * among them — the control plane refuses a registration whose platform clamps to
   * nothing, so pinning it here would be asserting a state that cannot arrive.
   */
  check(
    "and every platform it does not know is handed back as it was reported",
    ["freebsd", "ios", "android", "solaris"].map((raw) => platformName(raw)),
    ["freebsd", "ios", "android", "solaris"],
  );

  /*
   * ⚠ **The behavioural half of "the two vocabularies never cross".** The
   * structural half — neither module importing the other — is asserted at the foot
   * of this block, and it is silent about the edit that actually breaks this: a
   * `case "darwin"` added to `hostPlatform` out of helpfulness. Node's words belong
   * to a *daemon* and `ui/agentCard.ts`'s `osName` is what reads them; arriving
   * here they are an unknown platform like any other and must come back unchanged
   * rather than be quietly translated into this client's vocabulary.
   */
  check(
    "a daemon's vocabulary is not understood here, it is passed through",
    ["darwin", "win32"].map((raw) => platformName(raw)),
    ["darwin", "win32"],
  );

  const said = all.map((p) => localNetworkDetail(p));
  check("every platform gets a sentence", said.filter((s) => s.length > 20).length, said.length);
  /*
   * ⚠ **This is the assertion that stops a guess being added as a remedy.**
   * Local Network Privacy is a measurement — 2026-09-15, macOS 15, the daemon
   * being a child of this app. Nothing equivalent has been measured on Windows or
   * Linux, so those arms say what happened and stop. The day somebody measures
   * one, this number moves *with the measurement* rather than ahead of it.
   */
  check("exactly one of them names an operating system", said.filter((s) => /\bmacOS\b/.test(s)).length, 1);
  check("and none of them names one nobody has measured", said.some((s) => /\bWindows\b|\bLinux\b/.test(s)), false);
  /*
   * The caller appends the pointer to the logs, so no arm may carry one — two
   * copies in one sentence is how it ends up said twice.
   */
  check("and none of them names the logs screen the caller points at", said.some((s) => /Settings → Logs/.test(s)), false);

  /*
   * The `never` arm, off disk. A `switch` answering `string` that falls off the
   * end returns `undefined`, which the type system cannot see — `AgentGlyph`
   * shipped exactly that for four releases.
   */
  const platformSrc = readFileSync(new URL("../src/platform.ts", import.meta.url), "utf8");
  /*
   * ⚠ **Comment-stripped, and it was the one read in this block that was not.**
   * Every other source this block reaches — `agentCard.ts`, `store.ts`,
   * `DevicesSection.tsx`, `enrollment.ts` — goes through `stripComments` for the
   * standing reason that this codebase deliberately restates code facts in prose.
   * These three assertions are about a `never` arm, and both real arms sit inside
   * a `default: {` block carrying its own comment arguing for them, so the prose
   * and the code are a line apart here rather than a file apart.
   *
   * The counts agree today, which is exactly what makes raw source a trap.
   * Measured on the real file: paste `const exhaustive: never = platform;` into
   * `platformName`'s docblock and the raw count goes to 3 while the stripped count
   * stays at 2 — so over raw source a sentence answers for an implementation that
   * may already be gone. Stripped once and shared, so the three reads below cannot
   * disagree about which bytes they are reading.
   */
  const platformCode = stripComments(platformSrc);
  /*
   * ⚠ **Counted, not tested.** A single `.test()` stopped pinning its subject the
   * moment `platformName` added a second switch: either arm satisfied it, so
   * deleting the one in `localNetworkDetail` — the function this was written for —
   * left the check green. Both switches over `HostPlatform` must carry it, and a
   * third has to raise this number rather than ride the other two.
   */
  const exhaustiveArms = (platformCode.match(/const exhaustive: never = platform;/g) ?? []).length;
  check("both switches over HostPlatform end in a never arm", exhaustiveArms, 2);
  for (const fn of ["localNetworkDetail", "platformName"]) {
    const body = new RegExp(`export function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(platformCode)?.[1] ?? "";
    check(`a fifth platform is a compile error in ${fn} rather than a blank sentence`, /const exhaustive: never = platform;/.test(body), true);
  }

  /*
   * ⚠ **The two platform vocabularies never cross.** `hostPlatform` takes Rust's
   * (`macos`/`windows`/`linux`, from `NativeBoot.platform`); `osName` in
   * `ui/agentCard.ts` takes Node's (`darwin`/`win32`/`linux`, from a daemon's
   * `SystemInfo`). They agree on exactly one spelling, which is what makes a
   * mixed-up call look right in review and answer `other` for every Mac in the
   * fleet. Neither module may reach the other.
   */
  const agentCard = stripComments(readFileSync(new URL("../src/ui/agentCard.ts", import.meta.url), "utf8"));
  check("the daemon's platform reader knows nothing of the client's", /from "\.\.\/platform"/.test(agentCard), false);
  check("and the client's knows nothing of the daemon's", /agentCard/.test(platformCode), false);
  const storeSrc = stripComments(readFileSync(new URL("../src/store.ts", import.meta.url), "utf8"));
  check("the one caller asks the host rather than the wire", /hostPlatform\(this\.snapshot\.host\?\.platform\)/.test(storeSrc), true);

  /*
   * ⚠ **And `platformName`'s one caller actually calls it.** Everything above is
   * about a function; nothing held the *screen* to using it, and the defect was a
   * devices row reading `macos · in use` — the raw field drawn straight, beside a
   * separator, on the one line somebody reads to identify their own computer. Off
   * disk, because a JSX expression swapped from `platformName(row.platform)` to
   * `row.platform` compiles, renders, and is wrong only in the word it prints.
   *
   * Comments stripped, this file's own standing rule: the region around that line
   * carries JSX docblocks, and one of them naming either spelling would answer for
   * the code.
   */
  const devicesSrc = stripComments(
    readFileSync(new URL("../src/ui/settings/DevicesSection.tsx", import.meta.url), "utf8"),
  );
  check("the devices row draws the platform through it", /\{platformName\(row\.platform\)\}/.test(devicesSrc), true);
  check("and never draws the raw field beside a separator", /\{row\.platform\}/.test(devicesSrc), false);
  /*
   * The negative above is an **absence**, so it owes the same proof of life every
   * other absence in this file carries: a regex that matched nothing because it was
   * mistyped reads exactly like a screen that is correct.
   */
  report(
    "and that absence is a real search rather than a typo",
    /\{row\.platform\}/.test("<span>{row.platform}</span>"),
    "the pattern matches a raw draw when there is one",
  );
}
