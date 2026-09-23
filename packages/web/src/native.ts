import { openableHref } from "./ui/links";

/**
 * The native shell, from inside the page.
 *
 * **Hand-written, feature-detected, and with no dependency of its own** — the ⚠
 * below is why the third and `core()` is why the second. This bundle runs in a
 * Tauri window and, as the gate, in an ordinary browser: `cp.ts` imports this
 * module and the gate imports `cp.ts`, so the browser arm ships and is reached.
 * The way it stays one app is that the host is a module answering "not here" when
 * it is not there. Every export below has a browser arm, and no call site branches.
 *
 * ⚠ **No `@tauri-apps/*` package is imported, and that is a property rather than a
 * simplification.** `packages/web` is the bundle the control plane's image serves,
 * so a native-only module in its dependency tree would ship to every browser in
 * the fleet. `app.withGlobalTauri` in `tauri.conf.json` puts the one function this
 * needs on `window`, and `TauriCore` below is the whole of what is assumed about
 * it. `pnpm nativecheck` asserts both halves, because either alone would pass
 * while the other broke.
 *
 * **What the shell is for, in one list.** Five things the webview cannot do for
 * itself, and nothing else:
 *
 *   1. reach the control plane, which mounts no CORS at all (`src/cors.ts` is the
 *      daemon's and the relay's; `packages/control-plane/src/app.ts` has none),
 *   2. keep sign-ins in the operating system's credential store rather than in
 *      `localStorage` — one per account on this computer, keyed on the server
 *      *and* the person each belongs to — and decide which of them a window is,
 *      which is the one question this page is never allowed to answer for itself
 *      (Q1.651),
 *   3. open a link in the real browser,
 *   4. write a file through a save panel,
 *   5. ask this computer for a folder, through its own file panel.
 *
 * ⚠ **The fifth is the only one that is per *machine* rather than per process.**
 * The other four are true wherever this shell runs; that one is offered for the
 * daemon running on this same computer and for no other, because a panel can only
 * see this computer's disk. On every other machine the folder is still walked over
 * the wire. `.claude/rules/native-panels.md` is where that predicate lives, and
 * `NewSession.tsx` is where it is applied.
 *
 * Everything else — the relay, the daemons, the WebSocket, the cursor rules, the
 * make-before-break rotation, `sendWithProgress`'s upload progress — stays in the
 * webview and is the same code the browser client runs. `.claude/rules/native-shell.md`
 * carries the four reasons that split is a count rather than a habit.
 */

/**
 * What `withGlobalTauri` injects, and the only thing assumed about it.
 *
 * `invoke` is the whole surface: the commands are this app's own, declared in
 * `packages/native/src-tauri/src/commands.rs`, and an app-defined command needs no
 * entry in a capability file — so `commands.rs` *is* the capability surface and
 * this interface is the client for it.
 */
interface TauriCore {
  invoke?: <T>(command: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<T>;
}

interface TauriGlobal {
  core?: TauriCore;
}

/**
 * Keyed on the transport existing, never on a user-agent string or a build flag.
 *
 * **Read out of `window` on every call, cached nowhere**, and the idiom is the
 * point: the only honest question is "is the thing that carries a call actually
 * here", and a `import.meta.env`-style flag would answer it wrongly in exactly the
 * case that matters — a native build whose bridge failed to inject.
 */
function core(): TauriCore | null {
  const held = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return typeof held?.core?.invoke === "function" ? held.core : null;
}

export function inNativeShell(): boolean {
  return core() !== null;
}

/**
 * The header every command after the first carries, naming the document it came
 * from.
 *
 * ⚠ **A document, not a window, and that difference is an account.** The host
 * resolves which account a command is about from the calling webview's label —
 * and where one webview is *rebound* to another account (every platform but
 * macOS, and macOS too if the child-webview arm is ever switched off), the label
 * outlives the document that was on it. Android's Back, a bfcache restore or a
 * late fire-and-forget from the page being left would otherwise land on the
 * account that replaced it: the old bearer sent to the new account's server
 * through `host_cp`, which is Q5.116's disclosure, or a stray
 * `host_credential_clear` erasing the new account's sign-in, which is Q7.148's
 * race crossing accounts. So `host_boot` issues a random generation per page load,
 * the host rotates it on every rebind and every new load, and a command carrying
 * any other value is refused with `stale_document` (Q5.120).
 *
 * **A header rather than an argument**, which is the whole of why no command here
 * takes an account, an origin or a scope: the page never names the account a
 * command is about, and a header is the one field Tauri carries beside the
 * arguments without the command's signature seeing it.
 */
const GENERATION_HEADER = "reemoat-generation";

/**
 * Which document this is, as the host named it — `null` until `host_boot` answers.
 *
 * Module state rather than a field of {@link boot}: a snapshot that `store.ts`
 * hands to React is replaced whole on every update, and the one value every
 * command reads has no business travelling through a render.
 */
let generation: string | null = null;

/**
 * The options a command is sent with: the caller's own, plus the generation.
 *
 * Pure and exported so the rule is something `webcheck` can drive rather than
 * read: **every command but `host_boot`** — which is how a document learns its
 * generation, and is answered without one — and **nothing before the host has
 * answered**, where there is no generation to send. {@link invoke} waits for that
 * answer before sending anything else, so the only document that sends none is one
 * the host never gave one to — and a refusal of *that* reloads nothing (see
 * {@link invoke}); sending an empty value instead would ask the host to decide what
 * an empty value means.
 *
 * The caller's headers survive — `saveNative`'s filename rides beside it — and are
 * never overwritten by a caller's own `reemoat-generation`, because the value this
 * module holds is the only one the host issued.
 */
export function withGeneration(
  command: string,
  current: string | null,
  options?: { headers?: Record<string, string> },
): { headers?: Record<string, string> } | undefined {
  if (current === null || command === "host_boot") return options;
  return { ...options, headers: { ...options?.headers, [GENERATION_HEADER]: current } };
}

/**
 * Whether a rejection is the host refusing this document rather than the command.
 *
 * A **prefix**, which is the contract's own word: the host is free to say why after
 * the code, and the code is the only part a page may branch on.
 */
export function isStaleDocument(error: unknown): boolean {
  const said = error instanceof Error ? error.message : String(error);
  return said.startsWith("stale_document");
}

/**
 * Whether a refused call means this document must go: a `stale_document` refusal
 * of a call that **carried** a generation.
 *
 * Pure and exported for the reason {@link withGeneration} is. The second condition
 * is the one that was missing: a call sent with none is refused by the host for
 * that alone, and reloading on it is what turned one early `host_cp` into 728 page
 * loads in twelve seconds.
 */
export function shouldLeave(sent: string | null, error: unknown): boolean {
  return sent !== null && isStaleDocument(error);
}

/** Whether this document has already been told to go. See {@link invoke}. */
let leaving = false;

/**
 * Call a command, or throw.
 *
 * This does **not** swallow. A bridge whose callers are all decoration can afford
 * to eat a throw, because the cost of one is the chrome rather than the app; here
 * a caller is a control-plane request or a sign-in being saved, and a failure that
 * reads as a success is the worse outcome. Each caller below decides what to do
 * with it.
 *
 * ⚠ **One refusal is answered here, once, for every caller.** `stale_document`
 * means the webview this page is in now belongs to a different document — the
 * host rebound it to another account and a new page load is on its way, or this
 * one was restored from a history the host has already moved past. Nothing this
 * document holds is about the account on that label any more, so the only honest
 * move is to become the document the host expects: `location.replace("/")`, never
 * `assign`, so Back cannot bring this one back to be refused again. **Once** —
 * a burst of refused calls from the poll, a socket and a panel would otherwise
 * queue a navigation each. The rejection is still re-thrown, so the caller stops
 * rather than carrying on as though it had been answered.
 *
 * ⚠ **Every command but `host_boot` waits for {@link hostReady} while it is still
 * in flight, and only a refusal of a call that *carried* a generation reloads.** Both halves were one
 * defect, measured in the first bundled build: `store.bootstrap` fires
 * `loadConfig` before it awaits `hostReady`, so `host_cp` went out with no
 * generation, was refused `stale_document`, and the reload did the same again —
 * 728 page loads in twelve seconds, nothing ever drawn. Waiting is what makes the
 * early call legitimate; the second half is what keeps any *other* call made
 * without a generation — a host that never issued one — from becoming the same
 * loop. A document the host never named has nothing a reload would fix.
 */
async function invoke<T>(command: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<T> {
  const held = core();
  if (held?.invoke === undefined) throw new TypeError("not running in the Reemoat shell");
  if (command !== "host_boot" && generation === null && hydrating) await hostReady;
  const sent = command === "host_boot" ? null : generation;
  try {
    return await held.invoke<T>(command, args, withGeneration(command, sent, options));
  } catch (error: unknown) {
    if (!leaving && shouldLeave(sent, error)) {
      leaving = true;
      window.location.replace("/");
    }
    throw error;
  }
}

/**
 * What the first paint needs, and it arrives in one round trip.
 *
 * ⚠ **About this window's account, and never about the computer's.** A window is
 * bound to one account for the life of its document — `server` is that account's
 * control plane, `credential` its sign-in, the device fields and `claimed` its
 * own — so every screen under it is a single-account app, and `cp.ts`'s one
 * credential, the 401-by-identity rule and the store singleton hold unchanged.
 * Which account that is, the host decides from the window and the document
 * ({@link withGeneration}); nothing here names one back.
 */
export interface NativeBoot {
  /**
   * This window's control-plane origin, or `null` where nobody has chosen one —
   * first run, or an account being added that has not been given a server yet.
   */
  server: string | null;
  /**
   * This window's account's credential, out of the OS keyring.
   *
   * It lives in this page's memory from here, exactly as it does in a browser, and
   * **never in `localStorage`**. Holding the value in the shell instead was
   * considered and refused: `cpFetch` attributes a 401 by comparing
   * `credential === sent` by identity, and a handle it cannot compare would lose
   * the rule that stops a late 401 signing you out of a session you just started.
   *
   * ⚠ **Handed over at most once per page load.** A second `host_boot` from the
   * same document is answered `null`, so a script in this window cannot re-read
   * the keyring on demand — which closes the widening Q7.148 recorded, where
   * moving the origin and asking again reached every kept server's credential.
   */
  credential: string | null;
  platform: string;
  /**
   * Whether this shell can open a folder panel at all.
   *
   * ⚠ **Declared by the host rather than inferred here, and the two things it
   * replaces were both wrong.** Keying on `platform` would have read
   * `"android"` through `hostPlatform`, which narrows it to `"other"` along with
   * every future desktop target — a guess that reads as a fact. Relying on a phone
   * having no local daemon, and therefore never matching `localMachineId`, is true
   * today and is luck rather than a rule.
   *
   * `false` on Android and iOS: `tauri-plugin-dialog` has no
   * `blocking_pick_folder` there, because the platform's own answer is a Storage
   * Access Framework tree *URI* rather than a path. Found by an APK failing to
   * compile while every offline check was green — none of them builds for
   * `aarch64-linux-android`.
   */
  picksFolder: boolean;
  /**
   * Whether a daemon could be on *this* computer at all.
   *
   * ⚠ **Declared by the host for the reason {@link NativeBoot.picksFolder} is,
   * and it is the case that docblock names without covering.** The inference it
   * refuses — a phone having no local daemon and therefore never matching
   * `localMachineId`, *"true today and is luck rather than a rule"* — was carrying
   * all five of the daemon wrappers below at the same time.
   * `mod daemon` and `mod local` compile for Android, so those commands exist
   * there and answer `"unsupported"` or `null` only because `Payload::locate`
   * finds nothing staged and `~/.reemoat/daemon.json` is not on a phone. The
   * folder panel was forced into a declared capability by an APK that failed to
   * compile; nothing forced these, so nothing wrote them down.
   *
   * `false` on Android and iOS. **Not the same question as the host's
   * `"unsupported"`**, which is about the *bundle* — a desktop client build
   * carries no payload and still reaches a daemon `deploy/install.sh` put on that
   * computer, which is why that one stays a run-time answer.
   */
  canHostDaemon: boolean;
  /**
   * What this computer is called, for naming the machine it becomes.
   *
   * ⚠ **Not {@link NativeBoot.platform}.** That is the operating system — the
   * literal string `"macos"` on every Mac — and a machine named from it collides
   * on the second computer an account sets up, against a check the control plane
   * makes case-insensitively across everything that account can see.
   *
   * `null` where the host could not read one, which is a real state rather than a
   * failure: the caller has to ask instead of guessing.
   */
  hostName: string | null;
  appVersion: string;
  /**
   * `false` where this machine's credential store took a canary and lost it — a
   * Linux box with no unlocked keyring, most often. The app works for the session
   * and asks for the password again next time, which is the state `cp.ts` already
   * has a sentence for; this is the same state arriving by a different cause, and
   * it must draw the same words.
   */
  durable: boolean;
  /**
   * Which device this installation is registered as for this window's account,
   * or `null`.
   *
   * ⚠ **The account's, not the server's.** Two accounts on one server are two
   * device rows, because a device row names its owner and offering one account's
   * id — above all its public key — to whoever signs in next would link the two
   * accounts on the control plane (`credential.rs` carries that argument for the
   * key). So this is `null` for a window nobody has signed in to yet.
   *
   * ⚠ **Not out of the keyring**, unlike {@link NativeBoot.credential} beside it,
   * and the difference is the whole reason it works: a device id is an identifier
   * the control plane handed back rather than a secret, so it lives in ordinary
   * configuration — which means it survives `durable: false`, the very state where
   * a keyring-held one would be discarded on every launch and this app would
   * register a fresh device each time until the account hit its limit.
   *
   * `null` is an ordinary state and the only one at first run: `store.bootstrap()`
   * registers a device when it sees one and stores what comes back.
   */
  deviceId: string | null;
  /**
   * This installation's X25519 public key for this window's account, base64url,
   * or `null` — one key per account, for {@link NativeBoot.deviceId}'s reason.
   *
   * ⚠ **The private half is not here and there is no field that would carry it.**
   * The shell keeps it and answers `hostDeviceDh` with the *output* of a
   * Diffie-Hellman instead, so the one place somebody else's JavaScript could ever
   * run never holds the key. That is what a capability's device binding is worth:
   * a copy of one taken out of a log or a proxy cannot be used from anywhere else,
   * because the copier cannot produce this key.
   *
   * `null` before the first launch that generates one, or where no store would
   * answer at all. A remote machine is then unreachable and says so — there is no
   * unencrypted mode to fall back to.
   */
  devicePublicKey: string | null;
  /**
   * Where that key is actually kept: `"keyring"` or `"file"`.
   *
   * A **disclosure rather than a setting**, and it exists for the machines
   * {@link NativeBoot.durable} already names. On a box whose credential store
   * silently discards writes, a keyring-only device key would be regenerated every
   * launch and this app would register a new device each time until the account hit
   * its limit — the same failure `deviceId` above avoids by not being in the
   * keyring. So the key falls back to a 0600 file, and the Devices screen says
   * which of the two this installation used, per account. The alternative to the
   * file is that machine having no remote access at all.
   */
  deviceKeyAtRest: string | null;
  /**
   * The address this build suggests, for the setup screen's field to open on.
   *
   * ⚠ **A suggestion, and never {@link NativeBoot.server}.** They answer
   * different questions — *what shall the box open on* against *which fleet is
   * this installation on* — and the first draft answered both with one field, by
   * writing the compiled-in default into the shell's config on first run. That
   * skipped the setup screen, so the app chose a fleet and said so afterwards,
   * and it made a `credential#<origin>` keyring account for an origin nobody had
   * confirmed. Nothing is written down until somebody presses Continue.
   *
   * `null` in a browser and on any build that compiled none in — which is every
   * build from this repository.
   */
  defaultServer: string | null;
  /**
   * The machine this app created for this window's account, if it created one —
   * the claim {@link DaemonState.claimed} also carries, read here with no daemon
   * and no probe. Per account rather than per server: every account is this
   * computer as a machine of its own, with a daemon root of its own (Q7.149).
   *
   * ⚠ **The seed for `AppState.localMachineId`, and identity is the whole of
   * what it is for.** The app stops its own daemon at quit and the daemon removes
   * its announce file on that clean stop, so {@link localDaemon} answers `null`
   * on every cold launch until the store has drawn the list and started the
   * daemon again — which renamed and moved this computer's tile a moment after
   * the first paint. The claim survives the quit; it is what this computer *is*
   * on that server, not whether anything is listening (Q7.139).
   *
   * `null` in a browser, before this app has set a computer up for that server,
   * and for a daemon it adopted rather than created — the live read is then the
   * only answer, exactly as before.
   */
  claimed: string | null;
  /**
   * Which account this window is, as the host keys it — `<origin>#<userId>` — or
   * `null` while it is nobody's yet: a sign-in not finished, or a sign-in kept
   * from before this computer held accounts that has not been attributed.
   *
   * ⚠ **Opaque, and never assembled here.** The host proves who a credential
   * belongs to by asking the control plane itself (`GET /v1/me` with the token, to
   * this window's own origin) and keys on the answer; a page that could name the
   * user a token is filed under could file one person's session under another's
   * account (Q1.651). The one place this value travels back is `slot.ts` reading it
   * as present or absent — and `host_account_switch`, which takes a key the host
   * itself listed.
   */
  account: string | null;
  /**
   * The name the control plane last gave this account, cached by the host so a
   * list of accounts can be drawn without a request per account. `null` where
   * none has been seen yet.
   *
   * A cache and nothing more: `store.bootstrap()` compares it with `Me.name` and
   * asks the host to confirm the account whenever the two differ, which is the
   * one way a rename on the server reaches the drawer (`confirmDue` in `slot.ts`).
   */
  name: string | null;
  /**
   * `true` while this window holds a sign-in from before accounts existed that
   * nobody has attributed yet — or while anything this computer kept for this
   * server from then is still waiting for proof of whose it is.
   *
   * ⚠ **Nothing is inherited without proof, and this is how the page learns a
   * proof is owed.** A credential kept as `credential#<origin>` belongs to whoever
   * `GET /v1/me` names; the device and the daemon root that sat beside it belong
   * to that person only if the control plane lists them as theirs. The host makes
   * those requests itself, when `store.bootstrap()` asks it to — which it does
   * whenever this is `true`, so a proof that could not be reached is retried at
   * the next launch rather than guessed at.
   */
  legacy: boolean;
  /**
   * Whether this account's device id is bound to the sign-in this window holds.
   *
   * ⚠ **The reason a sign-in no longer registers a device in its own request.**
   * `POST /v1/login` used to carry the stored id and key; in the shell that id is
   * an *account's*, and the account is exactly what the sign-in finds out — so
   * the request would offer one person's device, and its public key, to whoever
   * signed in next. It is bound one round trip later instead, in the bootstrap
   * that follows (`ensureDevice`), and `false` here is what makes that bootstrap
   * register rather than trust an id that belongs to an earlier session.
   *
   * `false` from the moment a credential is written, `true` once
   * `host_device_set` has stored what the control plane answered.
   */
  deviceBound: boolean;
  /**
   * This document's generation, sent back on every command after this one.
   * {@link withGeneration} carries the argument.
   *
   * `null` only while {@link NativeBoot.rebinding}: the host has not seen this
   * document's page load yet, so there is nothing to issue.
   */
  generation: string | null;
  /**
   * `true` where the host rebound this window to another account and has not yet
   * seen the page load that follows — this document asked before its own load was
   * reported.
   *
   * ⚠ **A wait, never an answer.** Everything else in the payload is withheld
   * while it holds, so reading it as "signed out" would draw a sign-in form over
   * an account that is signed in. {@link hostReady} asks again, with a backoff,
   * for about two seconds — which is Android's case in particular, where the
   * platform reports a page load on its own thread and the new document's first
   * call can arrive before it (Q5.120).
   */
  rebinding: boolean;
}

/**
 * What `host_credential_set` and `host_account_confirm` answer.
 *
 * `outcome` is the host's verdict on whose sign-in this is, having asked the
 * control plane itself:
 *
 *   - `bound` — this window is that account now: a new one, or its own again.
 *   - `adopted` — that account is already on this computer, signed out, and the
 *     fresh sign-in was given to it. This window moves there; nothing is revoked.
 *   - `existing` — that account is already here and signed in. The host revoked
 *     the fresh session, and this window moves there.
 *   - `refused` — a signed-out account's window, signed in to as somebody else.
 *     The host revoked the fresh session; nothing moves, and the screen says so.
 *   - `unchanged` — a confirm that found nothing to do.
 *
 * A string rather than a union, for `wire.ts`'s rule: an unknown value must fail
 * toward "keep working" rather than crash a screen — and for a sign-in, keeping
 * working means adopting nothing (`cp.login`).
 *
 * The device fields are the account's own, which is what a window becomes when the
 * outcome is `bound`; for every other outcome the page moves away and reads none of
 * them.
 */
export interface NativeBound {
  outcome: string;
  account: string | null;
  name: string | null;
  deviceId: string | null;
  devicePublicKey: string | null;
  deviceKeyAtRest: string | null;
}

/**
 * One account on this computer, as the host lists it.
 *
 * ⚠ **`signedIn` is a flag the host keeps beside the list, never a keyring read.**
 * The drawer asks on every open, and on an unsigned development build every
 * keychain item can prompt — N accounts would be N dialogs for one tap. So it is
 * what this computer last knew: an account whose session was revoked elsewhere
 * reads as signed in until its own window next asks the control plane.
 *
 * `key` is opaque, and only `switchNativeAccount` reads it.
 */
export interface NativeAccountSummary {
  key: string;
  origin: string;
  name: string | null;
  current: boolean;
  signedIn: boolean;
}

/**
 * Every account on this computer, whether another may be added, and where Cancel
 * goes.
 *
 * `back` is the account most recently shown other than this window's, or `null`
 * where there is none — the one condition on every control that leaves this
 * account for another. **Read live, never out of {@link NativeBoot}**: a window
 * lives for the whole session on a desktop, so a snapshot taken at its launch would
 * offer no way back after an account was added and a way back to one since removed.
 */
export interface NativeAccountList {
  accounts: NativeAccountSummary[];
  canAdd: boolean;
  back: string | null;
}

/**
 * What an account move asks of the page that asked for it.
 *
 * `reload` is `true` exactly where this document must become the new one —
 * the host rebound this window's label rather than showing another window — and
 * the page then leaves with `location.replace("/")`. Where it is `false` another
 * window was shown, or this one is being closed, and there is nothing to do.
 * **The page never branches on which model the host runs**; this one field is the
 * whole of what it knows about that.
 */
export interface NativeAccountMove {
  reload: boolean;
}

let boot: NativeBoot | null = null;
let hydrating = inNativeShell();

/**
 * How long a rebinding window keeps asking before it takes the answer it has.
 *
 * About two seconds: the gap it waits out is one platform thread posting a page
 * load to another, which is milliseconds when it happens at all. Long enough that a
 * slow phone does not draw a sign-in form over a signed-in account; short enough
 * that a host which never reports the load costs a pause rather than a spinner.
 *
 * ⚠ **Above {@link hostReady}, and that is not tidiness.** That constant is
 * evaluated in this module's body and calls {@link askHost} at once, in the shell;
 * a `const` declared below it would be read before its initialiser ran.
 */
const REBIND_PATIENCE_MS = 2_000;

/** `host_boot`, asked again with a doubling pause while the host is rebinding. */
async function askHost(): Promise<NativeBoot> {
  const giveUpAt = Date.now() + REBIND_PATIENCE_MS;
  let pause = 50;
  for (;;) {
    const answer = await invoke<NativeBoot>("host_boot");
    if (answer.rebinding !== true) return answer;
    if (Date.now() + pause > giveUpAt) {
      /*
       * The host has not seen this page load after two seconds of asking. A reload
       * is itself a page load it will see — `on_page_load(Started)` is what ends
       * rebinding — so it is the one move that can succeed; drawing the answer
       * instead would leave a document with no generation, which every command
       * refuses and which {@link invoke} deliberately never reloads.
       */
      window.location.replace("/");
      return answer;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pause));
    pause = Math.min(pause * 2, 400);
  }
}

/**
 * One call, started at import, awaited by `store.bootstrap()`.
 *
 * ⚠ **The ordering this exists for.** `cp.ts` reads its credential
 * **synchronously in the module body**, because a module is imported once and that
 * is what makes the migration rule testable without a DOM. A keyring is async. So
 * rather than making `currentCredential()` async — which would ripple into every
 * call site and into `webcheck`'s module-evaluation order — the native arm starts
 * empty and is filled here, and `nativeHydrating()` is what stops the store
 * drawing the sign-in screen in the frame before it lands.
 *
 * The two alternatives were both worse and both are recorded rather than
 * rediscovered. An `await` gate in `main.tsx` moves `installWakeDetection()` and
 * `store.bootstrap()` into an async body. ⚠ **That ordering is no longer asserted
 * off disk**: it was checked beside the Telegram launch sequence, which is deleted,
 * and no driver under `packages/web/scripts/` names `main.tsx` now except as a
 * bundle entry point — so `main.tsx`'s own comment, that StrictMode mounts twice
 * and a resume path running twice would mint two tokens per machine, is the whole
 * of what holds it. Injecting the value with Tauri's `initialization_script` is
 * fixed at window creation, so the reload in `store.signOut()` would re-inject
 * the credential `clearSession()` had just deleted — which is exactly the defect
 * `setSession`'s own docblock records having shipped once.
 *
 * ⚠ **It may ask more than once, and only while the host says it is rebinding.**
 * See {@link NativeBoot.rebinding}: that answer withholds everything, so it is
 * asked again rather than drawn. After {@link REBIND_PATIENCE_MS} it reloads the
 * document, since the reload is a page load the host sees — a recovery at the
 * patience's pace rather than a hang, and never the refusal-driven loop
 * {@link invoke} refuses to make.
 */
export const hostReady: Promise<NativeBoot | null> = inNativeShell()
  ? askHost()
      .then((answer) => {
        boot = answer;
        generation = answer.generation ?? null;
        return answer;
      })
      .catch(() => null)
      .finally(() => {
        hydrating = false;
      })
  : Promise.resolve(null);

/**
 * True only between this module's import and `hostReady` settling, and only in the
 * shell.
 *
 * Synchronous, because `inNativeShell()` is: the global is injected before any
 * page script runs, so the answer to "will there be a credential" is knowable in
 * the first frame even though the credential itself is not.
 */
export function nativeHydrating(): boolean {
  return hydrating;
}

/** What the shell answered, once it has. `null` in a browser, for ever. */
export function nativeBoot(): NativeBoot | null {
  return boot;
}

/**
 * Where the control plane is.
 *
 * `location.origin` in a browser, which is what every caller used to pass
 * directly. In the shell it is the chosen server — and the callers that matter are
 * the ones printing an install command: `installCommand(location.origin)` under a
 * custom scheme prints `curl -fsSL 'tauri://localhost/install.sh' | sh`, an
 * installer that joins nothing.
 *
 * ⚠ Not the relay, and never derived from this. A machine's relay URL arrives per
 * machine from `POST /v1/tokens`; the two addresses are unrelated by design, and a
 * client that derived one from the other would break the first fleet that moved
 * its relay.
 */
export function controlPlaneOrigin(): string {
  return boot?.server ?? window.location.origin;
}

/**
 * What may cross the bridge on a control-plane request, stated as a type.
 *
 * Deliberately narrower than `RequestInit`. A `FormData`, a `ReadableStream` or a
 * `Blob` body has no representation on the other side, and all four call sites in
 * `cp.ts` pass a string or nothing — so this type is complete, and widening it is
 * the edit that would otherwise silently drop a body.
 */
export interface CpInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

interface CpAnswer {
  status: number;
  statusText: string;
  body: string;
}

/** Statuses a `Response` may not carry a body for; `new Response` throws otherwise. */
const BODILESS = new Set([204, 205, 304]);

function answerToResponse(answer: CpAnswer): Response {
  const body = BODILESS.has(answer.status) || answer.body.length === 0 ? null : answer.body;
  return new Response(body, { status: answer.status, statusText: answer.statusText });
}

/**
 * Send a `/v1` request, wherever this app is running.
 *
 * **In a browser this is `fetch` and nothing else**, which is what makes the web
 * build provably unchanged: same function, same arguments, same `Response`.
 *
 * In the shell it goes through the host process, because the control plane mounts
 * no CORS middleware at all — deliberately, on its side: `vite.config.ts` proxies
 * `/v1` in dev *"instead of making dev the one place a CORS rule has to exist for
 * the control plane"*. A webview `fetch` from `tauri://localhost` would preflight
 * and be refused, and the remedy nobody wants is a CORS layer on the one service
 * that has never needed one.
 *
 * ⚠ **A path is sent, never a URL.** The base lives in the host process, so
 * `cp.ts`'s oldest rule — *the credential is sent here and nowhere else* — is
 * enforced somewhere the page cannot reach, which is stronger than same-origin
 * rather than weaker.
 *
 * ⚠ **A failure is a rejection, never a status.** `isTransportFailure` in
 * `http.ts` is a *negation* — anything that is not an `ApiError` — and `errorText`
 * narrows on `instanceof Error`, so the host's failures are re-thrown as
 * `TypeError`. Get this backwards and either a subway tunnel signs the whole fleet
 * out, or a real `401 session_expired` never signs anybody out at all.
 */
export async function cpSend(path: string, init: CpInit = {}): Promise<Response> {
  if (!inNativeShell()) return await fetch(path, init);
  return answerToResponse(await hostCall(path, init, null));
}

/**
 * The same request against an origin that has not been adopted yet.
 *
 * The server picker's own verb, and the only caller that names an origin at all:
 * every other call takes the stored one. Kept separate from `cpSend` rather than
 * given an optional argument, so "which origin does a control-plane call go to" has
 * exactly one answer at every other call site in this app.
 */
export async function probeServer(origin: string, path: string, init: CpInit = {}): Promise<Response> {
  return answerToResponse(await hostCall(path, init, origin));
}

async function hostCall(path: string, init: CpInit, origin: string | null): Promise<CpAnswer> {
  const headers = Object.entries(init.headers ?? {}).map(([name, value]) => [name, value] as [string, string]);
  const request = {
    path,
    method: init.method ?? "GET",
    headers,
    body: init.body ?? null,
    origin,
  };
  /*
   * The caller's `AbortSignal` cannot cancel an `invoke`, so it is raced rather
   * than passed. `CP_TIMEOUT_MS` stays the one number that decides how long a
   * control-plane call may take; the host's own timeout is a backstop against a
   * socket that neither answers nor closes, set deliberately longer so it can
   * never become a second policy.
   */
  const call = invoke<CpAnswer>("host_cp", { req: request }).catch((error: unknown) => {
    throw new TypeError(error instanceof Error ? error.message : String(error));
  });
  const signal = init.signal;
  if (signal === undefined) return await call;
  return await Promise.race([
    call,
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  ]);
}

/**
 * Hand a fresh sign-in to the host, and learn whose it is.
 *
 * ⚠ **The host decides, and this function only reports.** It sends the token and
 * nothing else — no user id, no name, no account — and the host asks the control
 * plane `GET /v1/me` with it, against this window's own origin, before it writes a
 * keyring entry, a config line or a root. A page that named the user would be a
 * page able to file one person's session under another's account (Q1.651); the
 * `{value}` shape is the whole of that rule on this side, and `webcheck` pins it.
 *
 * **Awaited, and it rejects.** This is not the fire-and-forget the old setter was:
 * where `setSession` used to write the keyring on the side and treat a failure as
 * a degraded mode, a sign-in in the shell is now *filed under an account*, and a
 * token the host could not attribute is one the page must not hold. So a rejection
 * — the host could not reach the control plane, or refused — is the caller's to
 * turn into a failed sign-in, and `cp.login` does (Q5.120).
 *
 * On `bound` the cached {@link boot} becomes that account, for the reason
 * {@link setNativeDevice} gives: the bootstrap that follows in this same document
 * reads it — which device to register, which name the drawer draws — and
 * `hostReady` will never answer again. `deviceBound` goes `false`, because the
 * account's device is not bound to a session that did not exist a moment ago.
 * **The token is not put in the snapshot**: `credential` there is what the keyring
 * held at load, and the page's own copy is `cp.ts`'s.
 */
export async function bindNativeCredential(value: string): Promise<NativeBound> {
  const bound = await invoke<NativeBound>("host_credential_set", { value });
  if (bound.outcome === "bound" && boot !== null) {
    boot = {
      ...boot,
      account: bound.account,
      name: bound.name,
      deviceId: bound.deviceId,
      devicePublicKey: bound.devicePublicKey,
      deviceKeyAtRest: bound.deviceKeyAtRest,
      deviceBound: false,
    };
  }
  return bound;
}

/**
 * Erase this window's account's credential from the OS store.
 *
 * Fire-and-forget with the same posture as `setSession`'s `try`: in-memory is a
 * usable degraded mode and an exception here must not stop the caller. A machine
 * whose keyring is unusable is exactly the `durable: false` state, and the app
 * already has a sentence for it.
 *
 * **No argument, and that is the rule rather than an omission**: the host erases
 * the credential of the account this document is, which it knows from the window
 * and the generation. A late one from a document the host has moved past is
 * refused `stale_document` rather than landing on whoever replaced it — which is
 * how Q7.148's recorded race, a sign-out's clear arriving after a switch, stopped
 * being able to cross accounts.
 */
export function clearNativeCredential(): void {
  if (!inNativeShell()) return;
  void invoke("host_credential_clear", {}).catch(() => undefined);
}

/**
 * Ask the host to prove whose account this window is, again.
 *
 * Two jobs, both the host's, and the page only says *now*. A window holding a
 * sign-in from before accounts existed ({@link NativeBoot.legacy}) is attributed:
 * the host reads the kept credential itself, asks `GET /v1/me` with it, and moves
 * it — and the device and daemon root beside it, only where the control plane
 * lists them as that person's — under the account that answer names. And an
 * account's cached name is refreshed, which is how a rename on the server reaches
 * the drawer.
 *
 * On `bound` or `unchanged` the cached {@link boot} takes what came back. The
 * device's bound flag survives only where the device did: an id the host moved is
 * the same row still bound to the same session, and a different one is not.
 * `existing` — the account was already added here — is the caller's to act on,
 * because what follows is a sign-out.
 *
 * ⚠ **`legacy` is left as the payload said it.** The answer does not say whether
 * every proof was had — a device the control plane did not list, a root whose
 * machine it could not be asked about — and that is the host's to say, in the next
 * launch's payload. So a later bootstrap in this document asks again, which costs
 * the host one request and is the direction to be wrong in: a proof owed and not
 * asked for is a device or a root left with nobody.
 */
export async function confirmNativeAccount(): Promise<NativeBound> {
  const answer = await invoke<NativeBound>("host_account_confirm", {});
  if ((answer.outcome === "bound" || answer.outcome === "unchanged") && boot !== null) {
    boot = {
      ...boot,
      account: answer.account,
      name: answer.name,
      deviceId: answer.deviceId,
      devicePublicKey: answer.devicePublicKey,
      deviceKeyAtRest: answer.deviceKeyAtRest,
      deviceBound: boot.deviceBound && answer.deviceId !== null && answer.deviceId === boot.deviceId,
    };
  }
  return answer;
}

/**
 * Every account on this computer, or `null` where there is no shell to ask or it
 * did not answer — `localDaemon`'s posture: the one question a caller has is
 * *what can I offer*, and nothing is the honest answer to both.
 *
 * Read **live**, on every mount of what draws it; {@link NativeAccountList}
 * carries why a snapshot would be wrong.
 */
export async function nativeAccounts(): Promise<NativeAccountList | null> {
  if (!inNativeShell()) return null;
  try {
    return await invoke<NativeAccountList>("host_accounts", {});
  } catch {
    // The bridge, or the host, said nothing usable. Offering no account is what
    // a browser does, and every control drawn from this is a door, not a duty.
    return null;
  }
}

/*
 * The three account moves, and the one rule they share: **the page reloads when it
 * is told to and otherwise does nothing**, because whether the host showed another
 * window or rebound this one is the host's to know ({@link NativeAccountMove}).
 * All three reject — a refusal (`not_shown` from a window that is not on screen,
 * `account_limit` at ten) is a sentence for whoever pressed the control, and a
 * move that silently did nothing is the worse failure.
 */

/**
 * Show another account: the one named, or with `null` the one shown most recently
 * before this — Cancel, wherever it appears. The key is one the host listed; this
 * is the one call in which the page names an account at all.
 */
export async function switchNativeAccount(account: string | null): Promise<NativeAccountMove> {
  return await invoke<NativeAccountMove>("host_account_switch", { account });
}

/** Open a window for a sign-in nobody has made yet. Refused at ten accounts. */
export async function addNativeAccount(): Promise<NativeAccountMove> {
  return await invoke<NativeAccountMove>("host_account_add", {});
}

/**
 * Take this window's account off this computer: its credential erased, its daemon
 * stopped and not started again at launch, and the account shown before it shown
 * instead — or, where none is left, a sign-in to the same server.
 *
 * **Its device id, key and daemon root are kept** (Q7.149): signing in again as the
 * same person reuses the same device row and the same machine rather than spending
 * a second of each. Only the caller can forget itself, which is why it takes no
 * argument.
 */
export async function forgetNativeAccount(): Promise<NativeAccountMove> {
  return await invoke<NativeAccountMove>("host_account_forget", {});
}

/**
 * Save or forget which device this account registered us as.
 *
 * Written to the shell's configuration rather than its keyring — see
 * {@link NativeBoot.deviceId} — and fire-and-forget for `clearNativeCredential`'s
 * reason: losing it costs one extra registration on the next launch, which is a
 * degraded mode rather than a failure.
 *
 * ⚠ **It updates {@link boot} as well as the file, and that is not an
 * optimisation.** `hostReady` settles once, at import, and `nativeBoot()` answers
 * that same snapshot for the life of the process — so an app that signed out and
 * back in without quitting would re-read a `deviceId` from before it registered,
 * decide it had none, and register a *second* device for one computer. The object
 * is replaced rather than mutated because `store.ts` hands it to React as
 * `state.host`, and an identical reference never re-renders.
 *
 * `deviceBound` moves with it: a stored id is one the control plane has just bound
 * to this session, and a cleared one is bound to nothing. The host flips its own
 * flag in the same two commands.
 */
export function setNativeDevice(value: string | null): void {
  if (!inNativeShell()) return;
  if (boot !== null) boot = { ...boot, deviceId: value, deviceBound: value !== null };
  void invoke(value === null ? "host_device_clear" : "host_device_set", value === null ? {} : { value }).catch(
    () => undefined,
  );
}

/**
 * One Diffie-Hellman with this installation's device key, done in the shell.
 *
 * The Noise handshake runs **here, in the page**, and `native-shell.md` gives four
 * reasons the daemon leg may not leave the webview — one of which is that an
 * encrypted stream with two decryptors is not a design. So the two operations in
 * the IK pattern that need the *static* key (`ss` and `se`) come back across the
 * bridge and nothing else does; every other operation uses an ephemeral this page
 * generated and holds.
 *
 * Rejects rather than returning `null`, because a caller mid-handshake has no
 * useful smaller answer: there is no session to have without this.
 */
export async function hostDeviceDh(peer: string): Promise<string> {
  if (!inNativeShell()) throw new Error("no native shell");
  return await invoke<string>("host_device_dh", { peer });
}

/**
 * Start this installation over with a fresh device key for this window's account.
 *
 * For a credential store that was reset out from under the app, and for somebody
 * deliberately re-keying from Settings → Devices. The server registers the new
 * public half against the **same** device row, so this does not spend a slot.
 *
 * ⚠ **The caller is `DevicesSection`'s device row, and until now there was
 * none.** This function shipped with the sentence above already in it while a
 * grep for it over `packages/web/src` returned one hit — its own declaration — so
 * the one state a client cannot otherwise leave had no exit: the Authority keeps
 * a registration whose `publicKey` it refused, reports `hasKey: false` for ever,
 * and every sign-in re-sends the same refused bytes. The row wearing that badge
 * is where the act belongs, offered in the shell alone because a browser holds
 * no keyring, and on your own row alone because this resets *this* installation.
 *
 * ⚠ **It makes the key and registers nothing.** What it does beyond the keyring
 * is refresh the cached `NativeBoot`, so `describeDevice()` reads the new public
 * half on the next call; sending it is the caller's separate `cp.registerDevice()`,
 * which `adoptDevice` writes onto the same row. Two steps rather than one because
 * the registration is a control-plane call and this module holds no credential.
 *
 * And `deviceBound` goes `false` in the snapshot for exactly that reason: until
 * the registration lands, the key the row holds is the old one, and a bootstrap in
 * this document must register rather than trust it. It is **this account's** key
 * that is reset; every other account on this computer keeps its own.
 */
export async function hostDeviceKeyReset(): Promise<{ publicKey: string; atRest: string }> {
  if (!inNativeShell()) throw new Error("no native shell");
  const fresh = await invoke<{ publicKey: string; atRest: string }>("host_device_key_reset", {});
  if (boot !== null) {
    boot = { ...boot, devicePublicKey: fresh.publicKey, deviceKeyAtRest: fresh.atRest, deviceBound: false };
  }
  return fresh;
}

/**
 * Whether anything below is worth asking, as the **shell** declared it.
 *
 * ⚠ **One reader rather than five, and it reads a capability rather than a
 * platform.** {@link NativeBoot.canHostDaemon} carries the argument in full: the
 * five wrappers under this one were relying on a phone having no payload staged
 * and no `~/.reemoat/daemon.json`, which is the inference `picksFolder` exists to
 * refuse. Keyed on `hostPlatform()` instead it would be wrong in the other
 * direction, that function narrowing `"android"` to `"other"` along with every
 * future desktop target.
 *
 * ⚠ **`await hostReady` rather than `nativeBoot()`, and the difference is a
 * race.** The cached payload is `null` until the one `host_boot` call settles, so
 * a synchronous read would answer "this device cannot" for every call made in
 * the frames before it lands — and `localRoute.ts` resolves a route on a wake,
 * which is exactly then. Awaiting an already-settled promise costs a microtask.
 *
 * ⚠ **Only an explicit `false` refuses, and the asymmetry is what a refusal
 * costs.** This read `?.canHostDaemon === true`, which folds three different
 * states into one `no`: a browser, a shell that answered `false`, and a shell
 * whose `host_boot` never settled. The third is not a refusal — it is silence —
 * and treating it as one costs the **whole local route**, so the app reaches a
 * daemon on its own computer over the relay instead. Measured: with that reading,
 * `webcheck.local-route.ts` went to eight failures, because `hostReady` is a
 * module-level `const` settled at import and that driver installs its shell
 * afterwards, so the payload is `null` for its entire run (the driver pins that
 * fact about itself at its own line 533). An explicit `false` is the only answer
 * that means *no daemon can be on this device*, and it is the one Android sends.
 *
 * What silence costs the other way is one wasted loopback probe that answers
 * nothing — which is the same trade `installable` decides in the opposite
 * direction, and for the stated reason: there a refusal is a bare `404` with
 * nothing to render, here it is a slower path that still works. `webcheck`'s
 * `installable !== false` sweep is scoped to that field and does not reach this
 * one.
 */
async function canHostDaemonHere(): Promise<boolean> {
  const boot = await hostReady;
  // Silence, not a refusal: fall back to whether a shell is there at all, which
  // is the inference this field narrows rather than replaces.
  if (boot === null) return inNativeShell();
  return boot.canHostDaemon;
}

/**
 * A daemon running on *this computer*, as the host process found it.
 *
 * The daemon writes `daemon.json` into its state root from its own listening
 * callback (`src/announce.ts`); the host reads this window's account's —
 * `~/.reemoat/servers/<server>/` for a daemon it runs for a second server, and
 * `~/.reemoat/servers/<server>@<userId>` for a second *account* on one — and,
 * for the account that owns this server's root, then `~/.reemoat`'s, and answers
 * the first live one, or `null` (Q7.148, Q7.149). A second account on a server is
 * never answered the first one's root: that daemon is somebody else's machine.
 * Everything that could go wrong there — no file, an unknown version, a
 * non-loopback host, a `shared_secret` daemon — is the same `null`, because the
 * caller has exactly one question and it is not *why not*.
 *
 * So the machine this answers can belong to another fleet — an `install.sh` daemon
 * in `~/.reemoat` for the server that file names — and every caller compares its
 * id with a machine it already holds: `localAnnouncedFor` with the machine it is
 * routing to, the `this device` badge and the home screen's `local` with the rows
 * in the list, and the setup flow with its connections. Another fleet's id
 * matches none of them — so it is never called `local` and never put first.
 *
 * ⚠ **`base` is finished, and nothing here builds one.** Loopback is enforced in
 * the host, where the page cannot reach it, for the reason `host_cp` keeps the
 * control-plane origin there: this app renders agent output, and a rule the page
 * holds is a rule a page can be talked into breaking. So the shell hands over an
 * origin rather than a host and a port, and `localRoute.ts` concatenates nothing.
 *
 * `machineId` is a **hint, not a proof.** What establishes that the thing on that
 * port is that machine is the daemon's own `aud` check, which `machine.ts` spends
 * one authenticated request on. This only decides whether that request is worth
 * making — and, because the file sits in a directory this uid owns, whether it is
 * safe to show a token to whatever is listening at all.
 */
export interface LocalDaemon {
  machineId: string;
  base: string;
  instanceId: string;
}

export async function localDaemon(): Promise<LocalDaemon | null> {
  // Not `inNativeShell()` alone: see {@link canHostDaemonHere}. On a platform
  // where no daemon can be here, "there is none" is the answer by rule rather
  // than because a file happened to be missing.
  if (!(await canHostDaemonHere())) return null;
  try {
    return (await invoke<LocalDaemon | null>("host_local_daemon")) ?? null;
  } catch {
    // The command is the only thing that can fail here and its every refusal is
    // already `None`. A throw means the bridge itself is gone, which is the same
    // answer: there is no local daemon this client can reach.
    return null;
  }
}

/**
 * How the daemon on this computer is doing — the *second* question about it.
 *
 * ⚠ **Not a replacement for {@link localDaemon}, and the split is deliberate.**
 * That one answers "is there a daemon here worth showing a token to?" and answers
 * `null` to every failure, which is right for a daemon somebody installed with the
 * shell installer. This one exists because the app can now be the thing that
 * *started* it, and "there is no daemon" is a dishonest answer about a process the
 * app launched and watched exit. `commands.rs` carries the state table.
 *
 * `status` is a string rather than a union because the host owns the set and
 * `wire.ts`'s rule applies: an unknown value has to fail toward "keep working"
 * rather than crash a screen, so the caller matches the states it knows and treats
 * anything else as "nothing to say".
 */
export interface DaemonState {
  status: string;
  /** What a *running* daemon says it is. */
  machineId: string | null;
  /**
   * What this app already spent a `POST /v1/machines` on, for this server.
   *
   * ⚠ **Not the same question as {@link DaemonState.machineId}, and treating them
   * as one costs a quota slot permanently.** A machine row is counted with no
   * revoked filter, so every create spends one of fifty for ever. This is set
   * whenever a machine was created here — including when the daemon never came up
   * — so a caller that sees it must re-mint a code against that machine rather
   * than create another.
   */
  claimed: string | null;
  /**
   * What this account's env file on this computer already says: one of
   * {@link DAEMON_CONFIG}. `~/.reemoat/daemon.env` when that file names this
   * server and this account owns that root, a folder of its own under
   * `~/.reemoat/servers` otherwise (Q7.148, Q7.149).
   *
   * ⚠ **Asked before a machine is created, and the whole reason a machine used to
   * be created for a computer that already had one.** Without it the only visible
   * state was `absent`, which reads as *nothing here* and is wrong for a computer
   * carrying a half-finished `deploy/install.sh` install. The host answers it
   * rather than handing over the file, because deciding whether it names *this*
   * server means comparing origins, and the origin is deliberately something only
   * the host knows.
   */
  config: string;
  /**
   * How the daemon exited, when this app started it and it has finished.
   *
   * ⚠ **The structured half of "why did it stop", and the reason no arm in the
   * store reads the log.** `scripts/daemon.ts` answers {@link DAEMON_EXIT}: `3`
   * for an enrollment code the control plane refused, `4` for a control plane it
   * could not reach. Everything else is `2`, which is also a held database lock, a
   * missing token and a database a newer daemon migrated — none of which a fresh
   * code can touch. `null` where it was signalled rather than exiting, or where
   * this app did not start it.
   */
  exitCode: number | null;
  /**
   * Whether the daemon behind {@link DaemonState.machineId} says it enrolled with
   * a control plane other than this server's.
   *
   * ⚠ **Why a status is not enough on its own.** `~/.reemoat` is the root of every
   * daemon started without `REEMOAT_HOME` and its announcement is
   * last-writer-wins, so the daemon the host finds in the root it gives a server
   * can be a `pnpm daemon` from a checkout, enrolled to another fleet entirely.
   * Its machine is in no list this account holds, and reading that as *a daemon
   * for this server that you cannot see* put a false sentence and a remedy that
   * cannot work on the screen. The host compares the origins, because the origin
   * is something only the host knows. **A flag, never `absent`**: the status
   * stays what the file and the probe say, since this server's own daemon may be
   * up under that file and adopting "nothing" would start a second one over its
   * database. `false` for a daemon older than the field.
   */
  stranger: boolean;
}

/**
 * The exits `scripts/daemon.ts` gives that mean something different to a parent.
 *
 * Mirrored from that file's own constants, which `nativecheck` compares against
 * this object. Reading the log instead was the alternative, and a supervisor that
 * greps its child's output is one rewording away from silently doing nothing.
 */
export const DAEMON_EXIT = {
  /** The control plane refused the code: single-use, expired or unknown. */
  codeRefused: 3,
  /** The control plane could not be reached, or did not answer. */
  controlPlaneUnreachable: 4,
  /**
   * The operating system refused a connection to an address on this network.
   *
   * Its own answer because its remedy is its own: nothing is down and waiting
   * changes nothing — somebody has to grant Local Network access to this app.
   */
  localNetworkBlocked: 5,
} as const;

/**
 * The three answers {@link DaemonState.config} may carry.
 *
 * Mirrored from `daemon.rs`'s `CONFIG_*` constants, which `nativecheck` compares
 * against this object — a fourth answer added on one side and not the other would
 * otherwise fall through every arm in the store and do nothing at all.
 */
export const DAEMON_CONFIG = {
  /** No env file on this computer for this server. */
  none: "none",
  /** This server's env file, and it names the server this app is signed in to. */
  here: "here",
  /** This server's env file names another server, or nothing this can read. */
  elsewhere: "elsewhere",
} as const;

export async function daemonState(): Promise<DaemonState | null> {
  // `null` rather than a synthesised `"unsupported"`: `store.ts` already treats
  // the two as one state, and inventing a status here would be this module
  // answering for the host. See {@link canHostDaemonHere}.
  if (!(await canHostDaemonHere())) return null;
  try {
    return (await invoke<DaemonState | null>("host_daemon_state")) ?? null;
  } catch {
    // The bridge itself is gone. Same answer as a build with no payload.
    return null;
  }
}

/**
 * What the daemon on this computer has printed, newest last.
 *
 * ⚠ **The second question about the daemon's output, and the first one is not
 * this.** {@link daemonState} is a word on the setup screen's one-second poll,
 * and it asks the ring only whether anything was ever printed — that bit is the
 * whole of `exited` against `absent`. This is the ring itself, for the one screen
 * somebody opens to read it. The split is `commands.rs`'s and is why a log never
 * rides a poll; Q7.140 is the argument.
 *
 * **`[]` for every absence, and they are deliberately one answer.** No native
 * shell; a daemon this app did not start, because the shell installer's daemon is
 * somebody else's child and this app holds no pipe to it; a daemon that has
 * printed nothing yet. The screen tells them apart from the state it already has
 * rather than from the shape of this answer.
 *
 * The bytes are a ring bounded at 200 lines in the host, not a file. Nothing here
 * rotates, and nothing on disk is being read — which is what keeps this from
 * being a second, weaker copy of `~/Library/Logs`.
 */
export async function daemonLog(): Promise<readonly string[]> {
  // The same `[]` every other absence answers — see the docblock, and
  // {@link canHostDaemonHere} for why the platform is asked rather than assumed.
  if (!(await canHostDaemonHere())) return [];
  try {
    return (await invoke<string[]>("host_daemon_log")) ?? [];
  } catch {
    // The bridge itself is gone — the same answer as a shell with no payload, and
    // the same answer as a daemon that has said nothing. See the docblock.
    return [];
  }
}

/**
 * Set this computer up as a machine, and start the daemon.
 *
 * ⚠ **No control-plane URL crosses this bridge.** The host writes the origin it
 * is already signed in to, which is `native-shell.md`'s standing rule and, here,
 * the difference between an app that can re-read its own env file and one that
 * decides the file belongs to a stranger the moment a proxy reports a scheme.
 *
 * ⚠ **The enrollment code crosses the bridge and is written by the host to a
 * `0600` file — it is never put on a command line.** `deploy/bootstrap.sh` passes
 * it on stdin for the same reason: argv is readable by every account on the host,
 * and a code is a full machine identity until it is redeemed.
 *
 * A rejection is a sentence, not a status. ⚠ **And the host does not simply
 * refuse when an env file already exists** — the sentence that used to stand here
 * said it did, and `host_daemon_start`'s own docblock records the measurement that
 * killed it. The three cases are its, not this module's: a code *rewrites* the
 * file, preserving every key this app does not own; no code with a file naming
 * this server is adoption; a file naming another server is the only refusal.
 */
export async function startLocalDaemon(enrollCode: string, machineId: string): Promise<DaemonState> {
  /*
   * ⚠ **A rejection rather than a `null`, because this one has a return type
   * somebody is waiting on.** The other three wrappers answer an absence; this
   * answers a state, and there is no state meaning "nothing was attempted". The
   * host says `this build carries no daemon` for the same shape one layer down,
   * and `store.ts` puts whichever sentence it gets on the setup screen. Nothing
   * reaches this on a phone anyway — {@link daemonState} answered `null` and
   * `setUpThisComputer` returned — which is what makes this the backstop and not
   * the gate. See {@link canHostDaemonHere}.
   */
  if (!(await canHostDaemonHere())) throw new Error("this device cannot run a Reemoat daemon");
  /*
   * ⚠ **Both empty is adoption, and is a real call rather than a mistake.**
   * The host then starts what this account's env file already configures and
   * creates nothing — which is what a machine set up by `deploy/install.sh`, or by
   * this app before a restart, needs. Passing a code instead makes it provisioning,
   * and the host rewrites the file.
   */
  return await invoke<DaemonState>("host_daemon_start", { enrollCode, machineId });
}

/**
 * Stop the daemon this app started for this window's account, and only that one.
 *
 * Nothing happens to a daemon the shell installer set up: the host holds a handle
 * to the child it spawned and stopping is identity-checked against it, because a
 * pid is reused and `~/.reemoat` is shared with whatever else set one up. Nor to
 * another account's: each has its own, the host starts every configured one at
 * launch whichever account is on screen, and they stop together when the app
 * quits — or one at a time, when its account is taken off this computer (Q7.149).
 */
export async function stopLocalDaemon(): Promise<void> {
  // Nothing to stop, and silence is the honest answer: stopping a daemon that
  // cannot exist has already succeeded. See {@link canHostDaemonHere}.
  if (!(await canHostDaemonHere())) return;
  await invoke<void>("host_daemon_stop");
}

/**
 * Adopt a server, and answer the one canonical spelling of it.
 *
 * **The host normalizes, and this returns its answer** rather than computing one
 * here. One authority on "which server is this" is the whole point: two
 * normalizers is two spellings of one origin, which is two credential keys, one of
 * which a sign-out would not reach. So there is deliberately no validator in this
 * file — the form submits, and the host answers either the origin or a sentence.
 *
 * ⚠ **Only for a window nobody has signed in to.** An account *is* an origin and a
 * person, so repointing a signed-in window at another server would quietly make it
 * a different account with the old one's keyring entry, device and daemon behind
 * it; the host refuses anything but a pending sign-in (Q5.120), and another server
 * is another account, added from the menu (Q3.643).
 */
export async function setNativeServer(url: string): Promise<string> {
  return await invoke<string>("host_set_server", { url });
}

/** The clipboard, through the platform rather than through the webview. */
export async function copyNative(text: string): Promise<boolean> {
  try {
    await invoke("host_copy_text", { text });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand a file to the person who asked for it, through a real save panel.
 *
 * **Raw bytes, never JSON.** The client's download bound is 100 MiB, and that as a
 * JSON array of numbers is roughly 600 MB of string — so the body is an
 * `ArrayBuffer`, which Tauri carries over its own IPC protocol as bytes, and the
 * filename rides in a header because a header is the only other field a raw
 * request has. Percent-encoded, because a header value is ASCII and a filename is
 * the one field somebody definitely did not type in ASCII.
 *
 * `false` where the panel was dismissed, which is not a failure.
 */
export async function saveNative(blob: Blob, filename: string): Promise<boolean> {
  const bytes = await blob.arrayBuffer();
  return await invoke<boolean>("host_save_file", bytes, {
    headers: { "x-reemoat-filename": encodeURIComponent(filename) },
  });
}

/**
 * Ask this computer for a folder, through its own file panel.
 *
 * `null` is a **cancel**, and it must not be drawn as a failure nor as "no
 * folder": the caller keeps whatever it already had. A real failure **throws** —
 * which is where this parts company with {@link copyNative}, one function up,
 * that swallows because losing a clipboard write costs the chrome and nothing
 * else. Losing a folder silently is how `Start` comes to be dead over a folder
 * nobody can see is missing.
 *
 * `start` is a seed for where the panel opens and nothing more; the host ignores
 * one it cannot honour rather than refusing.
 *
 * Only ever called for the machine this app is running on. That is not enforced
 * here and could not be — this file has no idea which daemon a screen is talking
 * to — it is `NewSession.tsx`'s predicate, and `webcheck.local-route.ts` holds it
 * there.
 */
export async function pickFolderNative(start: string | null): Promise<string | null> {
  return (await invoke<string | null>("host_pick_folder", { start })) ?? null;
}

/**
 * Send a link to the browser instead of to this window.
 *
 * ⚠ **Installed from the module body, gated on the shell, and that is the whole
 * reason `main.tsx` needs no line for any of this.** A host with chrome to
 * configure or a readiness to announce would need one there; this has neither.
 * In a browser nothing is installed at all, so the driver's `window` stub
 * — which has a `location` and a `localStorage` and no more — is never touched.
 *
 * **Capture phase, and `openableHref` is the decision.** Reusing that function
 * rather than re-deriving the rule is what keeps one allowlist: `links.ts` holds
 * the argument for why the list is three schemes long, and a second copy here
 * would be a second policy on a page that renders agent output. The shell carries
 * a third copy as a backstop, and `pnpm nativecheck` compares it to this one's
 * source.
 *
 * A modified click is left alone: on a desktop those are the shortcuts that mean
 * "not the default thing", and `preventDefault` on them would be this app deciding
 * it knows better.
 */
function interceptExternalLinks(): void {
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (anchor === null) return;
      const href = openableHref(anchor.getAttribute("href") ?? undefined);
      if (href === null) return;
      event.preventDefault();
      void invoke("host_open_external", { url: href }).catch(() => undefined);
    },
    true,
  );
}

if (inNativeShell()) interceptExternalLinks();
