import type { AuthFailure } from "./account";
import { authFailure, WrongAccount } from "./account";
import { ApiError, readJson, withTimeout } from "./http";
import { parseInstanceConfig } from "./instance";
import type { CpInit } from "./native";
import {
  bindNativeCredential,
  clearNativeCredential,
  cpSend,
  inNativeShell,
  nativeBoot,
  setNativeDevice,
} from "./native";
import type { ConfigField, InstanceConfig } from "./instance";
import type {
  AdminUser,
  CreatedMachine,
  CreatedUser,
  DeviceRecord,
  EnrollmentCode,
  IssuedToken,
  MachineLinkGrant,
  MachineLinkRecord,
  MachineRecord,
  Me,
  SessionRecord,
  SessionToken,
} from "./wire";

const CREDENTIAL_STORAGE = "reemoat.credential";

/**
 * What previous builds wrote, read once and adopted under the name above.
 *
 * Two of them now, and both are read for the same reason: **a rename must not sign
 * anybody out.** `remoslop.credential` is the same credential under the old
 * product name, and `remoslop.apiKey` is older still — an `rk_` key, which is a
 * valid bearer either way, since `callerAuth` on the control plane takes both
 * kinds. A deploy that stopped reading either would have logged out every open tab
 * in the fleet for no reason at all.
 *
 * Adopted rather than merely tolerated: the value moves to the new name and the
 * old one is removed, so these have an end date rather than being extra names that
 * have to keep working for ever. Ordered newest-first, so a tab holding both takes
 * the session token over the older key.
 */
/*
 * ⚠ **These are historical literals and must never be renamed with the product.**
 *
 * A blanket rename caught them once and the failure was immediate and total:
 * `setSession` writes `CREDENTIAL_STORAGE` and then sweeps this list, so with the
 * same string in both, signing in deleted the credential it had just written and
 * every request went out unauthenticated. `webcheck` caught it on the first run.
 *
 * What these name is not this product — it is **what is already sitting in
 * somebody's browser**, written by a build that shipped under the old name. They
 * stop being useful only once no tab in the fleet has been signed in since before
 * the rename, and then they are deleted rather than updated.
 */
const LEGACY_STORAGE = ["remoslop.credential", "remoslop.apiKey"];

/**
 * Which device this browser is registered as, on this origin.
 *
 * **Deliberately a separate key rather than a field beside the credential**, and
 * not merely for tidiness: it survives a sign-out. That is the whole behaviour —
 * signing out ends a session, and the computer you signed out of is still the same
 * computer, so the next sign-in re-binds the same row rather than registering a
 * second one for one machine.
 *
 * `LEGACY_STORAGE` has no twin here and never will: nothing wrote this under an
 * older name, so there is nothing to adopt and nothing to sweep.
 *
 * A browser origin scopes this for free, which is why it needs no origin in the
 * key — the asymmetry with the native shell, where one webview origin serves every
 * server and `config.rs` keys the same value by origin, is `native-shell.md`'s and
 * is not an inconsistency.
 */
const DEVICE_STORAGE = "reemoat.device";

const CP_TIMEOUT_MS = 10_000;

export type CredentialKind = "session" | "api_key";

export interface Credential {
  value: string;
  kind: CredentialKind;
}

export function credentialKind(value: string): CredentialKind {
  return value.startsWith("rk_") ? "api_key" : "session";
}

export function pickStored(
  fresh: string | null,
  legacy: string | null,
): { value: string; kind: CredentialKind; migrated: boolean } | null {
  if (fresh !== null && fresh.length > 0) {
    return { value: fresh, kind: credentialKind(fresh), migrated: false };
  }
  if (legacy !== null && legacy.length > 0) {
    return { value: legacy, kind: credentialKind(legacy), migrated: true };
  }
  return null;
}

export function authHeader(credential: Credential | null): Record<string, string> | null {
  if (credential === null) return null;
  return { authorization: `Bearer ${credential.value}` };
}

// Native: the credential lives in the OS keyring keyed by server and account, and arrives async via adoptHydratedCredential (Q1.651).
let credential: Credential | null = inNativeShell() ? null : readStoredCredential();

/** A credential adopted meanwhile is newer than the keyring's and wins. */
export function adoptHydratedCredential(value: string | null): void {
  if (value === null || credential !== null) return;
  credential = { value, kind: credentialKind(value) };
}

function readStoredCredential(): Credential | null {
  try {
    const picked = pickStored(
      window.localStorage.getItem(CREDENTIAL_STORAGE),
      LEGACY_STORAGE.map((key) => window.localStorage.getItem(key)).find(
        (value) => value !== null && value.length > 0,
      ) ?? null,
    );
    if (picked === null) return null;
    if (picked.migrated) {
      window.localStorage.setItem(CREDENTIAL_STORAGE, picked.value);
      for (const key of LEGACY_STORAGE) window.localStorage.removeItem(key);
    }
    return { value: picked.value, kind: picked.kind };
  } catch {
    return null;
  }
}

export function currentCredential(): Credential | null {
  return credential;
}

export function setSession(token: string): void {
  credential = { value: token.trim(), kind: credentialKind(token.trim()) };
  // Native: memory only. The host already filed the token against its account, and webview storage must hold no copy.
  if (inNativeShell()) return;
  try {
    window.localStorage.setItem(CREDENTIAL_STORAGE, credential.value);
    // Sweep the legacy names on every write, or the next load re-adopts a token somebody signed out of.
    for (const key of LEGACY_STORAGE) window.localStorage.removeItem(key);
  } catch {
    // See above: in-memory is a usable degraded mode, an exception here is not.
  }
}

export function clearSession(): void {
  credential = null;
  // The device is deliberately kept: signing out ends a session, not this computer's registration.
  if (inNativeShell()) {
    clearNativeCredential();
    return;
  }
  try {
    window.localStorage.removeItem(CREDENTIAL_STORAGE);
    for (const key of LEGACY_STORAGE) window.localStorage.removeItem(key);
  } catch {
    // Nothing to do; the in-memory value is already cleared.
  }
}

/** Drops only the in-memory credential, for a server switch; the keyring entry stays so switching back asks nothing (Q7.148). */
export function detachSession(): void {
  credential = null;
}

export function currentDevice(): string | null {
  if (inNativeShell()) return nativeBoot()?.deviceId ?? null;
  try {
    const held = window.localStorage.getItem(DEVICE_STORAGE);
    return held === null || held.length === 0 ? null : held;
  } catch {
    return null;
  }
}

export function deviceBound(): boolean {
  return !inNativeShell() || nativeBoot()?.deviceBound !== false;
}

export function rememberDevice(id: string): void {
  if (inNativeShell()) {
    setNativeDevice(id);
    return;
  }
  try {
    window.localStorage.setItem(DEVICE_STORAGE, id);
  } catch {
    // See `currentDevice`: in-memory-only is a working degraded mode.
  }
}

export function forgetDevice(): void {
  if (inNativeShell()) {
    setNativeDevice(null);
    return;
  }
  try {
    window.localStorage.removeItem(DEVICE_STORAGE);
  } catch {
    // Nothing to do.
  }
}

let signedOutHandler: ((failure: AuthFailure) => void) | null = null;

export function onSignedOut(handler: (failure: AuthFailure) => void): void {
  signedOutHandler = handler;
}

async function cpFetch<T>(path: string, init: CpInit = {}): Promise<T> {
  // Attribute a refusal to the credential this request carried, not to whatever is current when it lands.
  const sent = credential;
  const headers = authHeader(sent);
  if (headers === null) throw new ApiError(401, "missing_api_key", "not signed in");
  if (init.body !== undefined) headers["content-type"] = "application/json";

  const response = await cpSend(path, { ...init, headers, signal: withTimeout(CP_TIMEOUT_MS) });
  try {
    return await readJson<T>(response);
  } catch (error) {
    const failure = authFailure(error);
    if (failure !== null && credential === sent) {
      clearSession();
      signedOutHandler?.(failure);
    }
    throw error;
  }
}

async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const response = await cpSend(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: withTimeout(CP_TIMEOUT_MS),
  });
  return await readJson<T>(response);
}

/** Parsed, never cast: the server's shape is not InstanceConfig's, and an unreadable body throws. */
export async function instanceConfig(): Promise<InstanceConfig> {
  const response = await cpSend("/v1/instance", { signal: withTimeout(CP_TIMEOUT_MS) });
  const config = parseInstanceConfig(await readJson<unknown>(response));
  if (config === null) throw new Error("this control plane described itself in a shape this client cannot read");
  return config;
}

export type RegisterAnswer =
  | { kind: "session"; session: SessionToken }
  | { kind: "sent"; expiresAt: number };

export async function register(input: {
  name: string;
  password: string;
  email?: string;
  acceptedTerms?: boolean;
}): Promise<RegisterAnswer> {
  const body = await publicPost<SessionToken & { pending: boolean; expiresAt: number }>("/v1/register", input);
  if (body.pending) return { kind: "sent", expiresAt: body.expiresAt };
  return { kind: "session", session: body };
}

export function confirmRegistration(token: string): Promise<{ user: { name: string } }> {
  return publicPost<{ user: { name: string } }>("/v1/register/confirm", { token });
}

/** Returns nothing, so no screen can reveal whether an address has an account. */
export async function requestPasswordReset(email: string): Promise<void> {
  await publicPost<{ sent: boolean }>("/v1/forgot", { email });
}

export function consumePasswordReset(token: string, newPassword: string): Promise<SessionToken & { apiKeysActive: number }> {
  return publicPost<SessionToken & { apiKeysActive: number }>("/v1/reset", { token, newPassword });
}

export class AccountAlreadyOpen extends Error {
  constructor(readonly account: string | null) {
    super("that account is already on this computer");
    this.name = "AccountAlreadyOpen";
  }
}

export async function login(name: string, password: string): Promise<Me> {
  // Names no device: in the shell the device belongs to the account this request discovers, so registration follows in bootstrap.
  const response = await cpSend("/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
    signal: withTimeout(CP_TIMEOUT_MS),
  });
  const body = await readJson<SessionToken>(response);
  if (inNativeShell()) {
    // Native: adopt only once the host answers bound; any other answer leaves the page holding nothing (Q1.651).
    const bound = await bindNativeCredential(body.token);
    if (bound.outcome === "adopted" || bound.outcome === "existing") throw new AccountAlreadyOpen(bound.account);
    if (bound.outcome === "refused") throw new WrongAccount();
    if (bound.outcome !== "bound") throw new Error("this computer did not keep that sign-in");
  }
  setSession(body.token);
  return body.user;
}

function describeDevice(): { id?: string; name: string; platform: string; publicKey?: string } | null {
  const boot = nativeBoot();
  if (!inNativeShell() || boot === null) return null;
  const name = boot.hostName ?? "This computer";
  const held = currentDevice();
  const key = boot.devicePublicKey ?? undefined;
  return {
    ...(held === null ? {} : { id: held }),
    name,
    platform: boot.platform,
    ...(key === undefined ? {} : { publicKey: key }),
  };
}

/** Single-flight: a sign-in and a device_key_required mint can both call it, and two calls would register two rows. */
export function registerDevice(): Promise<string | null> {
  registering ??= registerOnce().finally(() => {
    registering = null;
  });
  return registering;
}

let registering: Promise<string | null> | null = null;

async function registerOnce(): Promise<string | null> {
  const device = describeDevice();
  if (device === null) return null;
  const body = await cpFetch<{ id: string; hasKey?: boolean }>("/v1/me/devices", {
    method: "POST",
    body: JSON.stringify(device),
  });
  rememberDevice(body.id);
  return body.id;
}

export async function devices(): Promise<{ devices: DeviceRecord[]; limit: number }> {
  return await cpFetch<{ devices: DeviceRecord[]; limit: number }>("/v1/me/devices");
}

export function revokeDevice(id: string): Promise<{ revoked: boolean; sessionsRevoked: number }> {
  return cpFetch<{ revoked: boolean; sessionsRevoked: number }>(`/v1/me/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function logout(): Promise<void> {
  try {
    await cpFetch<{ revoked: boolean }>("/v1/me/sessions/current", { method: "DELETE" });
  } catch {
    // Expired, an API key, or the service is down: none is a reason to stay signed in.
  } finally {
    clearSession();
  }
}

export async function changePassword(current: string | undefined, next: string): Promise<number> {
  const body = await cpFetch<{ sessionsRevoked: number }>("/v1/me/password", {
    method: "POST",
    body: JSON.stringify({ currentPassword: current, newPassword: next }),
  });
  return body.sessionsRevoked;
}

export function me(): Promise<Me> {
  return cpFetch<Me>("/v1/me");
}

export async function sessions(): Promise<SessionRecord[]> {
  const body = await cpFetch<{ sessions: SessionRecord[] }>("/v1/me/sessions");
  return body.sessions;
}

export function revokeSession(id: string): Promise<{ revoked: boolean }> {
  return cpFetch<{ revoked: boolean }>(`/v1/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function revokeOtherSessions(): Promise<number> {
  const body = await cpFetch<{ revokedCount: number }>("/v1/me/sessions?keepCurrent=1", { method: "DELETE" });
  return body.revokedCount;
}

export interface ApiKeyRecord {
  id: string;
  prefix: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt?: number | null;
}

export async function myKeys(): Promise<ApiKeyRecord[]> {
  const body = await cpFetch<{ keys: ApiKeyRecord[] }>("/v1/me/keys");
  return body.keys;
}

/** Allowed on the key you hold; KeysSection then clears the credential and reloads itself (Q3.546). */
export function revokeMyKey(keyId: string): Promise<{ revoked: boolean }> {
  return cpFetch<{ revoked: boolean }>(`/v1/me/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
}

export function mintMyKey(): Promise<{ apiKey: string }> {
  return cpFetch<{ apiKey: string }>("/v1/me/keys", { method: "POST" });
}

/**
 * Set or change it. A confirmation goes out; nothing is verified until it is used.
 *
 * A session is the whole proof (Q1.630): the route asked for the current
 * password until 2026-09-04 and the owner took that out, knowing the chain the
 * control plane's own docblock on `PUT /v1/me/email` records. An API key is not
 * (Q1.630, amended 2026-09-05): the route asks a key holder with a password for
 * `currentPassword`, which this call never sends — `SignIn` takes no key, so the
 * one browser that presents one is the legacy adoption from `LEGACY_STORAGE`,
 * and on the email leaf it draws the server's 400 sentence with no field to
 * answer it. Whether that adoption should drop an `rk_` key rather than adopt
 * it as a bearer is an owner's call, recorded here rather than decided.
 */
export function setMyEmail(email: string): Promise<{ email: string; verified: boolean }> {
  return cpFetch<{ email: string; verified: boolean }>("/v1/me/email", {
    method: "PUT",
    body: JSON.stringify({ email }),
  });
}

export function verifyMyEmail(token: string): Promise<{ email: string; verified: boolean }> {
  return cpFetch<{ email: string; verified: boolean }>("/v1/me/email/verify", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function machines(): Promise<MachineRecord[]> {
  const body = await cpFetch<{ machines: MachineRecord[] }>("/v1/machines");
  return body.machines;
}

export function renameMachine(id: string, name: string): Promise<{ id: string; name: string; owned: boolean }> {
  return cpFetch<{ id: string; name: string; owned: boolean }>(`/v1/machines/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export function mintEnrollment(id: string): Promise<EnrollmentCode> {
  return cpFetch<EnrollmentCode>(`/v1/machines/${encodeURIComponent(id)}/enrollments`, { method: "POST" });
}

/** Every call permanently spends one of the owner's machine slots, so check the limit first. */
export function createMachine(name: string): Promise<CreatedMachine> {
  return cpFetch<CreatedMachine>("/v1/machines", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function revokeMachine(id: string): Promise<{
  revoked: boolean;
  enrollmentCodesInvalidated?: number;
  outstandingTokensExpireWithinSeconds?: number;
}> {
  return cpFetch(`/v1/machines/${encodeURIComponent(id)}/revoke`, { method: "POST" });
}

/** Finds or makes a link from this machine to every other one the caller owns, and mints each a fresh token. */
export async function linkMachine(id: string): Promise<MachineLinkGrant[]> {
  const body = await cpFetch<{ links: MachineLinkGrant[] }>(`/v1/machines/${encodeURIComponent(id)}/links`, {
    method: "POST",
  });
  return body.links;
}

export async function machineLinks(id: string): Promise<MachineLinkRecord[]> {
  const body = await cpFetch<{ links: MachineLinkRecord[] }>(`/v1/machines/${encodeURIComponent(id)}/links`);
  return body.links;
}

export async function revokeLink(id: string): Promise<void> {
  await cpFetch<null>(`/v1/links/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function mintToken(machine: string): Promise<IssuedToken> {
  return cpFetch<IssuedToken>("/v1/tokens", {
    method: "POST",
    body: JSON.stringify({ machine }),
  });
}

export interface AdminUserRow extends AdminUser {
  machines?: number;
  machineLimit?: number;
  machineLimitSource?: "default" | "override";
  machineLimitDefault?: number;
  machinesOverLimit?: number;
}

export interface MachineLimitAnswer {
  userId: string;
  maxMachines: number;
  source: "default" | "user";
  instanceDefault: number;
  owned: number;
  suspended: { id: string; label: string }[];
}

/** Clearing is its own verb: 0 and no override mean opposite things. */
export function adminSetMachineLimit(userId: string, maxMachines: number): Promise<MachineLimitAnswer> {
  return cpFetch<MachineLimitAnswer>(`/v1/admin/users/${encodeURIComponent(userId)}/machine-limit`, {
    method: "PUT",
    body: JSON.stringify({ maxMachines }),
  });
}

/** A boolean only: nothing ever draws the key or any part of it. */
export async function adminHasProvisioningKey(): Promise<boolean> {
  const body = await cpFetch<{ minted: boolean }>("/v1/admin/provisioning-key");
  return body.minted;
}

export function adminMintProvisioningKey(): Promise<{ key: string }> {
  return cpFetch("/v1/admin/provisioning-key", { method: "POST" });
}

export function adminClearMachineLimit(userId: string): Promise<MachineLimitAnswer> {
  return cpFetch<MachineLimitAnswer>(`/v1/admin/users/${encodeURIComponent(userId)}/machine-limit`, {
    method: "DELETE",
  });
}

export async function adminUsers(): Promise<AdminUserRow[]> {
  const body = await cpFetch<{ users: AdminUserRow[] }>("/v1/admin/users");
  return body.users;
}

export function adminCreateUser(name: string, isAdmin: boolean, email?: string): Promise<CreatedUser> {
  return cpFetch<CreatedUser>("/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({ name, isAdmin, email: email !== undefined && email.trim().length > 0 ? email.trim() : undefined }),
  });
}

export interface DisabledAnswer {
  disabled: boolean;
  sessionsRevoked?: number;
  enrollmentCodesInvalidated?: number;
  outstandingTokensExpireWithinSeconds?: number;
}

export function adminSetDisabled(userId: string, disabled: boolean): Promise<DisabledAnswer> {
  return cpFetch<DisabledAnswer>(
    `/v1/admin/users/${encodeURIComponent(userId)}/${disabled ? "disable" : "enable"}`,
    { method: "POST" },
  );
}

export interface InviteAnswer {
  email: string;
  mailQueued: boolean;
  expiresAt: number;
}

export function adminInviteUser(userId: string): Promise<InviteAnswer> {
  return cpFetch<InviteAnswer>(`/v1/admin/users/${encodeURIComponent(userId)}/invite`, { method: "POST" });
}

export function adminDeleteUser(userId: string): Promise<{
  name: string;
  machinesRevoked: number;
  enrollmentCodesInvalidated?: number;
}> {
  return cpFetch(`/v1/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

export interface MailDelivery {
  pending: number;
  failed: number;
  oldestPendingMs: number | null;
  lastError: string | null;
  lastFailedAt: number | null;
  paused: boolean;
}

export interface SettingsAnswer {
  settings: ConfigField[];
  mail: { configured: boolean; problems: string[]; delivery?: MailDelivery };
  registration: { enabled: boolean; requiresEmail: boolean };
}

export function adminSettings(): Promise<SettingsAnswer> {
  return cpFetch<SettingsAnswer>("/v1/admin/settings");
}

/** Clearing is its own verb because an empty string is a real value; every value is a string. */
export function adminSaveSettings(input: {
  set?: Record<string, string>;
  clear?: string[];
}): Promise<SettingsAnswer> {
  return cpFetch<SettingsAnswer>("/v1/admin/settings", { method: "PUT", body: JSON.stringify(input) });
}

export function adminTestMail(to?: string): Promise<{ id: string; to: string }> {
  return cpFetch<{ id: string; to: string }>("/v1/admin/settings/test", {
    method: "POST",
    body: JSON.stringify(to === undefined ? {} : { to }),
  });
}
