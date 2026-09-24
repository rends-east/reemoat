import { ApiError } from "./http";

export type AuthFailure = "credentials" | "disabled" | "expired" | "device_revoked";

/** Keyed on the code, never the status. A transport failure is null; an unrecognised 401 still ends the session. */
export function authFailure(error: unknown): AuthFailure | null {
  if (!ApiError.isApiError(error)) return null;
  if (error.status === 403) {
    // user_disabled is the only 403 about the credential; forbidden and machine_revoked leave it good.
    return error.code === "user_disabled" ? "disabled" : null;
  }
  if (error.status !== 401) return null;
  // A 401 about the body, such as a wrong current password from verifyCurrentPassword (which replaced proveSelf), is not about the credential.
  if (error.code === "invalid_password" || error.code === "invalid_login") return null;
  if (error.code === "session_expired") return "expired";
  // device_revoked retires the stored device id as well, so it may not be folded into credentials, and session_revoked may not join it.
  if (error.code === "device_revoked") return "device_revoked";
  return "credentials";
}

/** Read from the body, since an ApiError carries no headers. null unless a positive finite number. */
export function retryAfter(error: unknown): number | null {
  if (!ApiError.isApiError(error)) return null;
  const detail = error.detail as { retryAfterSeconds?: unknown } | null;
  const seconds = detail?.retryAfterSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  // Round up: coming back before the block lifts extends it.
  return Math.ceil(seconds);
}

export function waitText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function tooManyAttemptsText(error: unknown): string {
  const seconds = retryAfter(error);
  if (seconds === null) return "Too many attempts. Wait a moment and try again.";
  return `Too many attempts. Wait ${waitText(seconds)} and try again.`;
}

export function signedOutText(failure: AuthFailure): string {
  switch (failure) {
    case "expired":
      return "Your session expired. Sign in again.";
    case "disabled":
      return "This account has been disabled.";
    case "credentials":
      return "You were signed out. Sign in again.";
    case "device_revoked":
      return "This device was signed out and retired. Sign in again to use it.";
  }
}

export const CONTROL_PLANE_UNREACHABLE = "Cannot reach the control plane.";

/** A sign-in as somebody else in this account's window: the host refuses it and revokes the session, adopting nothing (Q1.651). */
export class WrongAccount extends Error {
  constructor() {
    super("that sign-in belongs to a different account");
    this.name = "WrongAccount";
  }
}

export function signInError(error: unknown): string {
  if (error instanceof WrongAccount) {
    return "That is a different account — add it from Add account, or remove this one.";
  }
  if (!ApiError.isApiError(error)) {
    return `${CONTROL_PLANE_UNREACHABLE} This is not your password.`;
  }
  switch (error.code) {
    case "invalid_login":
      // One sentence for every way in: splitting them would put account enumeration back.
      return "Those sign-in details do not match.";
    case "user_disabled":
      return "This account has been disabled.";
    case "too_many_attempts":
      return tooManyAttemptsText(error);
    default:
      return error.message;
  }
}

/** Deliberately not the password policy: a tightened policy must not disable the way to change a password. */
export function signInReady(name: string, password: string): boolean {
  return name.trim().length > 0 && password.length > 0;
}

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

export type PasswordProblem = "too_short" | "too_long" | "mismatch" | "unchanged";

export function passwordProblem(current: string, next: string, confirm: string): PasswordProblem | null {
  if (next.length < PASSWORD_MIN) return "too_short";
  if (next.length > PASSWORD_MAX) return "too_long";
  if (current.length > 0 && next === current) return "unchanged";
  if (next !== confirm) return "mismatch";
  return null;
}

export function passwordProblemText(problem: PasswordProblem): string {
  switch (problem) {
    case "too_short":
      return `At least ${PASSWORD_MIN} characters.`;
    case "too_long":
      return `At most ${PASSWORD_MAX} characters.`;
    case "mismatch":
      return "Those do not match.";
    case "unchanged":
      return "That is the password you already have.";
  }
}

/** Unknown, spent and expired tokens must read the same. */
export function linkError(error: unknown): string {
  if (!ApiError.isApiError(error)) return CONTROL_PLANE_UNREACHABLE;
  switch (error.code) {
    case "token_unusable":
      return "This link no longer works. It may have been used already, or it may have expired — ask for a new one.";
    case "email_taken":
      return "Somebody else confirmed that address first. Sign in with the account that has it, or use another address.";
    case "name_taken":
      return "Somebody took that name while this link was waiting. Sign up again with a different one.";
    case "user_disabled":
      return "This account has been disabled.";
    case "weak_password":
      return error.message;
    case "too_many_attempts":
      return tooManyAttemptsText(error);
    default:
      return error.message;
  }
}

export function registerError(error: unknown): string {
  if (!ApiError.isApiError(error)) return CONTROL_PLANE_UNREACHABLE;
  switch (error.code) {
    case "name_taken":
      return "Somebody already has that name. Pick another.";
    case "registration_disabled":
      return "This control plane does not accept new accounts.";
    case "weak_password":
      return error.message;
    case "too_many_attempts":
      return tooManyAttemptsText(error);
    case "terms_not_accepted":
      return "Tick the box to say you agree, then try again.";
    default:
      return error.message;
  }
}

/** One badge chosen by how stuck the person is; an unconfirmed address counts only on an instance with mail. */
export type UserState = "disabled" | "no_password" | "temporary_password" | "unverified_email" | null;

export function userState(
  user: { disabled: boolean; hasPassword: boolean; mustChangePassword?: boolean; emailVerified?: boolean; email?: string | null },
  emailEnabled: boolean,
): UserState {
  if (user.disabled) return "disabled";
  if (!user.hasPassword) return "no_password";
  if (user.mustChangePassword === true) return "temporary_password";
  // No address is not an unverified address.
  if (emailEnabled && typeof user.email === "string" && user.email.length > 0 && user.emailVerified !== true) {
    return "unverified_email";
  }
  return null;
}

export function userStateText(state: NonNullable<UserState>): string {
  switch (state) {
    case "disabled":
      return "disabled";
    case "no_password":
      return "no password";
    case "temporary_password":
      return "temporary password";
    case "unverified_email":
      return "unconfirmed email";
  }
}

export function changePasswordError(error: unknown): string {
  if (!ApiError.isApiError(error)) return CONTROL_PLANE_UNREACHABLE;
  switch (error.code) {
    case "invalid_password":
      return "That is not your current password.";
    case "too_many_attempts":
      return tooManyAttemptsText(error);
    case "weak_password":
      return error.message;
    default:
      return error.message;
  }
}

/** Only for an api_key credential: the listed prefix is the eight characters after rk_. */
export function thisBrowsersKey(
  credential: { value: string; kind: "session" | "api_key" } | null,
  prefix: string,
): boolean {
  return credential !== null && credential.kind === "api_key" && credential.value.slice(3, 11) === prefix;
}

export function ageText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return "<1m";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months}mo`;
  return `${Math.round(days / 365)}y`;
}

export function orderKeys<K extends { createdAt: number; revokedAt: number | null }>(keys: readonly K[]): K[] {
  const live = keys.filter((key) => key.revokedAt === null).sort((a, b) => b.createdAt - a.createdAt);
  const dead = keys.filter((key) => key.revokedAt !== null).sort((a, b) => b.createdAt - a.createdAt);
  return [...live, ...dead];
}

/** Shown once: peek in a state initialiser, clear in an effect, so StrictMode can neither drop nor repeat it. */
export const REVOKED_KEY_NOTICE = "reemoat.revokedKey";

export function revokedKeyNotice(prefix: string): string {
  return `Key rk_${prefix}… revoked. Sign in again.`;
}

export interface NoticeStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

export function rememberRevokedKey(storage: NoticeStorage, prefix: string): void {
  storage.setItem(REVOKED_KEY_NOTICE, prefix);
}

/** The notice, if a revoke wrote one. Reading leaves it where it is. */
export function peekRevokedKeyNotice(storage: NoticeStorage): string | null {
  const prefix = storage.getItem(REVOKED_KEY_NOTICE);
  if (prefix === null || prefix.length === 0) return null;
  return revokedKeyNotice(prefix);
}

/** What consumes the notice: called once the value is in state, never before. */
export function clearRevokedKeyNotice(storage: NoticeStorage): void {
  storage.removeItem(REVOKED_KEY_NOTICE);
}
