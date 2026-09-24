import { openableHref } from "./ui/links";

/** The native shell from inside the page: feature-detected, no `@tauri-apps/*` import (this bundle also ships to browsers), a browser arm for every export. */

interface TauriCore {
  invoke?: <T>(command: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<T>;
}

interface TauriGlobal {
  core?: TauriCore;
}

function core(): TauriCore | null {
  const held = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return typeof held?.core?.invoke === "function" ? held.core : null;
}

export function inNativeShell(): boolean {
  return core() !== null;
}

/** Names the document, not the window: the host refuses a stale generation, so a rebound label cannot act for another account (Q5.120). */
const GENERATION_HEADER = "reemoat-generation";

let generation: string | null = null;

export function withGeneration(
  command: string,
  current: string | null,
  options?: { headers?: Record<string, string> },
): { headers?: Record<string, string> } | undefined {
  if (current === null || command === "host_boot") return options;
  return { ...options, headers: { ...options?.headers, [GENERATION_HEADER]: current } };
}

export function isStaleDocument(error: unknown): boolean {
  const said = error instanceof Error ? error.message : String(error);
  return said.startsWith("stale_document");
}

/** Only a refusal of a call that carried a generation means leave; reloading on any other loops. */
export function shouldLeave(sent: string | null, error: unknown): boolean {
  return sent !== null && isStaleDocument(error);
}

let leaving = false;

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

export interface NativeBoot {
  server: string | null;
  /** Handed over at most once per page load, then held in page memory, never `localStorage` (Q7.148). */
  credential: string | null;
  platform: string;
  picksFolder: boolean;
  canHostDaemon: boolean;
  hostName: string | null;
  appVersion: string;
  durable: boolean;
  /** Per account; kept in config rather than the keyring so it survives `durable: false`. */
  deviceId: string | null;
  devicePublicKey: string | null;
  deviceKeyAtRest: string | null;
  defaultServer: string | null;
  claimed: string | null;
  /** Opaque and never assembled here: only the host attributes a token to a user (Q1.651). */
  account: string | null;
  name: string | null;
  legacy: boolean;
  deviceBound: boolean;
  generation: string | null;
  /** A wait, never an answer: the payload is withheld, so never read it as signed out (Q5.120). */
  rebinding: boolean;
}

export interface NativeBound {
  outcome: string;
  account: string | null;
  name: string | null;
  deviceId: string | null;
  devicePublicKey: string | null;
  deviceKeyAtRest: string | null;
}

export interface NativeAccountSummary {
  key: string;
  origin: string;
  name: string | null;
  current: boolean;
  signedIn: boolean;
}

export interface NativeAccountList {
  accounts: NativeAccountSummary[];
  canAdd: boolean;
  back: string | null;
}

export interface NativeAccountMove {
  reload: boolean;
}

let boot: NativeBoot | null = null;
let hydrating = inNativeShell();

/** Declared above `hostReady`, whose module-body call reads it synchronously. */
const REBIND_PATIENCE_MS = 2_000;

async function askHost(): Promise<NativeBoot> {
  const giveUpAt = Date.now() + REBIND_PATIENCE_MS;
  let pause = 50;
  for (;;) {
    const answer = await invoke<NativeBoot>("host_boot");
    if (answer.rebinding !== true) return answer;
    if (Date.now() + pause > giveUpAt) {
      // A reload is a page load the host sees, which ends rebinding; drawing now would leave a document with no generation.
      window.location.replace("/");
      return answer;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pause));
    pause = Math.min(pause * 2, 400);
  }
}

/** Started at import because `cp.ts` reads its credential synchronously; `nativeHydrating()` holds the sign-in screen until it lands. */
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

export function nativeHydrating(): boolean {
  return hydrating;
}

export function nativeBoot(): NativeBoot | null {
  return boot;
}

export function controlPlaneOrigin(): string {
  return boot?.server ?? window.location.origin;
}

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

const BODILESS = new Set([204, 205, 304]);

function answerToResponse(answer: CpAnswer): Response {
  const body = BODILESS.has(answer.status) || answer.body.length === 0 ? null : answer.body;
  return new Response(body, { status: answer.status, statusText: answer.statusText });
}

/** In the shell the host sends it (the control plane has no CORS). Host failures rethrow as TypeError, never as a status. */
export async function cpSend(path: string, init: CpInit = {}): Promise<Response> {
  if (!inNativeShell()) return await fetch(path, init);
  return answerToResponse(await hostCall(path, init, null));
}

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

/** Sends the token alone; the host asks `GET /v1/me` and files it (Q1.651). Rejects when it cannot (Q5.120). */
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

export function clearNativeCredential(): void {
  if (!inNativeShell()) return;
  void invoke("host_credential_clear", {}).catch(() => undefined);
}

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

export async function nativeAccounts(): Promise<NativeAccountList | null> {
  if (!inNativeShell()) return null;
  try {
    return await invoke<NativeAccountList>("host_accounts", {});
  } catch {
    return null;
  }
}

export async function switchNativeAccount(account: string | null): Promise<NativeAccountMove> {
  return await invoke<NativeAccountMove>("host_account_switch", { account });
}

export async function addNativeAccount(): Promise<NativeAccountMove> {
  return await invoke<NativeAccountMove>("host_account_add", {});
}

export async function forgetNativeAccount(): Promise<NativeAccountMove> {
  return await invoke<NativeAccountMove>("host_account_forget", {});
}

/** Also replaces the cached `boot`, which `hostReady` never refreshes, or a re-sign-in would register a second device. */
export function setNativeDevice(value: string | null): void {
  if (!inNativeShell()) return;
  if (boot !== null) boot = { ...boot, deviceId: value, deviceBound: value !== null };
  void invoke(value === null ? "host_device_clear" : "host_device_set", value === null ? {} : { value }).catch(
    () => undefined,
  );
}

export async function hostDeviceDh(peer: string): Promise<string> {
  if (!inNativeShell()) throw new Error("no native shell");
  return await invoke<string>("host_device_dh", { peer });
}

export async function hostDeviceKeyReset(): Promise<{ publicKey: string; atRest: string }> {
  if (!inNativeShell()) throw new Error("no native shell");
  const fresh = await invoke<{ publicKey: string; atRest: string }>("host_device_key_reset", {});
  if (boot !== null) {
    boot = { ...boot, devicePublicKey: fresh.publicKey, deviceKeyAtRest: fresh.atRest, deviceBound: false };
  }
  return fresh;
}

async function canHostDaemonHere(): Promise<boolean> {
  const boot = await hostReady;
  if (boot === null) return inNativeShell();
  return boot.canHostDaemon;
}

export interface LocalDaemon {
  machineId: string;
  base: string;
  instanceId: string;
}

export async function localDaemon(): Promise<LocalDaemon | null> {
  if (!(await canHostDaemonHere())) return null;
  try {
    return (await invoke<LocalDaemon | null>("host_local_daemon")) ?? null;
  } catch {
    return null;
  }
}

export interface DaemonState {
  status: string;
  machineId: string | null;
  /** Set whenever this app created a machine, even if the daemon never came up: re-mint against it, never create another. */
  claimed: string | null;
  config: string;
  exitCode: number | null;
  stranger: boolean;
}

/** Mirrors `scripts/daemon.ts`'s exit constants; nativecheck compares them. */
export const DAEMON_EXIT = {
  codeRefused: 3,
  controlPlaneUnreachable: 4,
  localNetworkBlocked: 5,
} as const;

/** Mirrors `daemon.rs`'s CONFIG_* constants; nativecheck compares them. */
export const DAEMON_CONFIG = {
  none: "none",
  here: "here",
  elsewhere: "elsewhere",
} as const;

export async function daemonState(): Promise<DaemonState | null> {
  if (!(await canHostDaemonHere())) return null;
  try {
    return (await invoke<DaemonState | null>("host_daemon_state")) ?? null;
  } catch {
    return null;
  }
}

export async function daemonLog(): Promise<readonly string[]> {
  if (!(await canHostDaemonHere())) return [];
  try {
    return (await invoke<string[]>("host_daemon_log")) ?? [];
  } catch {
    return [];
  }
}

/** The enrollment code goes to a 0600 file, never argv, and no control-plane URL crosses the bridge. */
export async function startLocalDaemon(enrollCode: string, machineId: string): Promise<DaemonState> {
  if (!(await canHostDaemonHere())) throw new Error("this device cannot run a Reemoat daemon");
  // Both empty is adoption: start what the env file configures and create nothing.
  return await invoke<DaemonState>("host_daemon_start", { enrollCode, machineId });
}

export async function stopLocalDaemon(): Promise<void> {
  if (!(await canHostDaemonHere())) return;
  await invoke<void>("host_daemon_stop");
}

export async function setNativeServer(url: string): Promise<string> {
  return await invoke<string>("host_set_server", { url });
}

export async function copyNative(text: string): Promise<boolean> {
  try {
    await invoke("host_copy_text", { text });
    return true;
  } catch {
    return false;
  }
}

/** Raw bytes, never JSON: 100 MiB as a number array would be ~600 MB of string. */
export async function saveNative(blob: Blob, filename: string): Promise<boolean> {
  const bytes = await blob.arrayBuffer();
  return await invoke<boolean>("host_save_file", bytes, {
    headers: { "x-reemoat-filename": encodeURIComponent(filename) },
  });
}

/** `null` is a cancel, not a failure; a real failure throws. */
export async function pickFolderNative(start: string | null): Promise<string | null> {
  return (await invoke<string | null>("host_pick_folder", { start })) ?? null;
}

/** The window's title bar and the webview's own controls follow the switch. */
export function setNativeTheme(theme: "light" | "dark"): void {
  // A hidden seat is refused and the window keeps what it has, which is what every seat asked for anyway.
  void invoke("host_set_theme", { theme }).catch(() => undefined);
}

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
