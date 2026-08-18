import { ApiError } from "./http";

/**
 * What a credential is, and what a refusal of one means.
 *
 * Pure, and out here rather than inside `AppStore`, for the reason `groups.ts`
 * and `keys.ts` both state: `webcheck` has no DOM and no control plane, so a rule
 * that lives in a method is a rule nothing can assert. That is not abstract for
 * these — every one of them decides whether somebody is thrown out of a running
 * app, and getting one wrong is invisible until it happens to a person mid-turn.
 */

export type AuthFailure = "credentials" | "disabled" | "expired";

/**
 * Whether an answered request means this credential is finished.
 *
 * **Keyed on the code, never the status**, and that is the whole point of the
 * function. The test used to be `status === 401 || status === 403`, which was
 * correct only because the browser never called an admin route: the control
 * plane's `requireAdmin` answers `403 forbidden` to every non-admin, so the
 * moment there is a Users section, opening it would clear the credential and
 * return somebody to the sign-in screen for looking at a page they may not have.
 * `meansMachineGone` in `http.ts` argues the same thing one file over.
 *
 * A transport failure is `null` and must be: `fetch` rejecting says nothing about
 * the credential, and clearing it there means a tunnel on the underground signs
 * you out.
 *
 * An **unrecognised 401 still ends the session**, and the asymmetry with 403 is
 * deliberate. `wire.ts`'s rule is that a client behind the server passes unknown
 * words through rather than guessing — but falling open here would park the app
 * in a loop where every request 401s and nothing ever offers a way back in.
 */
export function authFailure(error: unknown): AuthFailure | null {
  if (!ApiError.isApiError(error)) return null;
  if (error.status === 403) {
    /*
     * The only 403 that is about *this credential* rather than about the route or
     * the thing being asked for. The others this client can now reach are
     * `forbidden` (`requireAdmin`, i.e. a screen you may not have) and
     * `machine_revoked` (a machine that has been retired, from re-enrolling or
     * minting a token for it) — both of which leave the credential perfectly
     * good, and neither of which may throw somebody out of the app.
     */
    return error.code === "user_disabled" ? "disabled" : null;
  }
  if (error.status !== 401) return null;
  /*
   * **A 401 about the request body is not a 401 about the credential.**
   *
   * `POST /v1/me/password` answers `401 invalid_password` when the *current
   * password* field is wrong — the session that carried the request is
   * perfectly good, and it is the one thing standing between the person and the
   * screen they are trying to use. Treating it as a dead credential signed
   * somebody out for mistyping their own password, which is both the worst
   * moment to do it and the moment they are most likely to.
   *
   * Found by driving the real form in a browser; every offline assertion passed,
   * because each one asked about a credential and this code is not about one. It
   * also made `changePasswordError`'s "That is not your current password."
   * unreachable — the session was cleared before the message could be shown.
   *
   * It is reachable from **three** routes, and they are not the three this used
   * to name: the two admin routes it cited are deleted, and `proveSelf` with
   * them. The three now are `POST /v1/me/password`, `POST /v1/me/keys` and
   * `PUT /v1/me/email` — minting a permanent credential and repointing the reset
   * channel both being acts that take the account, exactly like changing the
   * password. Two of them ask through `proveCurrentPassword`; `/v1/me/password`
   * verifies inline, because it is also the route that has to allow an account
   * with no password row to set a first one. Every one of the three is a screen
   * where being signed out for mistyping your own password is the same
   * catastrophe.
   *
   * `invalid_login` is here for the same reason and reachable by nobody: it comes
   * from `/v1/login`, which carries no credential and does not go through
   * `cpFetch`. Listed anyway, because the next person to route it through here
   * should not have to rediscover this.
   */
  if (error.code === "invalid_password" || error.code === "invalid_login") return null;
  if (error.code === "session_expired") return "expired";
  /*
   * Everything else that is a 401, which is `session_revoked`,
   * `api_key_revoked`, `invalid_api_key`, `missing_api_key` and anything a later
   * release adds.
   *
   * **`api_key_revoked` is newly reachable and no arm of its own is needed.**
   * `revoked_at` was a column nothing could write, so a key was immortal; there
   * are **two** writers now, both deliberate revocations — `DELETE
   * /v1/me/keys/:keyId` and its admin twin `DELETE
   * /v1/admin/users/:id/keys/:keyId`. The third this used to name was the sweep
   * inside the admin password reset, and that route is deleted: an admin can no
   * longer end this tab by resetting somebody's password, because an admin can
   * no longer reset somebody's password. They can still revoke the key, which is
   * the same outcome arrived at by saying so.
   *
   * It answers `"credentials"` rather than a fourth `AuthFailure` member,
   * deliberately: the union names what the person must **do**, and the remedy
   * for a revoked credential is the sign-in screen — the same one a stolen
   * session and an unknown token lead to. `"expired"` is separate only because
   * nothing was taken away there, which is not what any of these are.
   */
  return "credentials";
}

/**
 * How long the server said to wait, or `null` when it did not say.
 *
 * **The number was computed twice and read nowhere.** `tooManyAttempts` on the
 * control plane sends `Retry-After` *and* `detail.retryAfterSeconds`, precisely
 * so a client can wait instead of retrying into the block — and both halves were
 * thrown away here, while somebody facing a fifteen-minute lockout was told to
 * "wait a moment". The **body** is what is read, and it has to be: `parseBody`
 * takes a status, a status text and a string, never a `Response`, so no header
 * can reach an `ApiError` at all. That is why the server says it twice, and why
 * only one of the two was ever reachable from here.
 *
 * `null` for anything that is not a positive finite number, including a server
 * that predates the field. The wording then falls back, because "wait 0 seconds"
 * and "wait NaN minutes" are both worse than saying nothing precise.
 */
export function retryAfter(error: unknown): number | null {
  if (!ApiError.isApiError(error)) return null;
  const detail = error.detail as { retryAfterSeconds?: unknown } | null;
  const seconds = detail?.retryAfterSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  // Up, never down: telling somebody to come back before the block lifts sends
  // them into a refusal that then extends it — the throttle doubles.
  return Math.ceil(seconds);
}

/**
 * A number of seconds as a duration somebody reads rather than counts.
 *
 * Two units and no more. The throttle's own steps are 30s doubling to 15 min, so
 * "seconds" and "minutes" cover every value it can produce, and an hour would be
 * a unit for a state this service cannot reach.
 */
export function waitText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * What a `429 too_many_attempts` says, wherever it arrives from.
 *
 * One sentence for the sign-in form and the password form, because it is one
 * refusal from one throttle — the login route and `passwordChangeKey` are
 * different key spaces on the same counter, and a person who meets both should
 * not have to notice that they were worded differently.
 */
export function tooManyAttemptsText(error: unknown): string {
  const seconds = retryAfter(error);
  // "a moment" is the honest answer when the server did not say, and the only
  // one that stays true whatever the block turns out to be.
  if (seconds === null) return "Too many attempts. Wait a moment and try again.";
  return `Too many attempts. Wait ${waitText(seconds)} and try again.`;
}

/** What the sign-in screen says about a sign-out nobody asked for. */
export function signedOutText(failure: AuthFailure): string {
  switch (failure) {
    case "expired":
      return "Your session expired. Sign in again.";
    case "disabled":
      return "This account has been disabled.";
    case "credentials":
      return "You were signed out. Sign in again.";
  }
}

/** What the sign-in screen says about a sign-in that was refused. */
export function signInError(error: unknown): string {
  if (!ApiError.isApiError(error)) {
    // Named apart from a wrong password on purpose: somebody whose password is
    // right and whose network is not should not go and change their password.
    return "Cannot reach the control plane. This is not your password.";
  }
  switch (error.code) {
    case "invalid_login":
      // One sentence for a wrong name and a wrong password, because the server
      // gives one answer for both and a client that split them would put the
      // enumeration back.
      return "That name and password do not match.";
    case "user_disabled":
      return "This account has been disabled.";
    case "too_many_attempts":
      // The real number, from `detail.retryAfterSeconds`. A sign-in throttle
      // reaches fifteen minutes, and "wait a moment" in front of that sends
      // somebody back in thirty seconds to be refused again — which, because the
      // block doubles on a refusal, is advice that makes the wait longer.
      return tooManyAttemptsText(error);
    default:
      return error.message;
  }
}

/**
 * Whether Sign in can be pressed.
 *
 * Deliberately **not** the password policy. A policy tightened after somebody's
 * password was set would otherwise disable the only button that leads to the
 * screen where they could change it.
 */
export function signInReady(name: string, password: string): boolean {
  return name.trim().length > 0 && password.length > 0;
}

/**
 * Mirrored from the control plane's `password.ts`, which is the only side that
 * can enforce anything. Two numbers, so they can be kept in step by looking.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

export type PasswordProblem = "too_short" | "too_long" | "mismatch" | "unchanged";

/**
 * What is wrong with a proposed password, or `null`.
 *
 * The order is part of the rule. Length first, because it has to be fixed
 * whatever else is true; `unchanged` before `mismatch`, because "you typed your
 * old password twice" is a more useful sentence than "these do not match" when
 * they in fact do.
 */
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

/**
 * What a gate screen says when a link does not work.
 *
 * **Every way a token can be unusable reads the same**, and that is asserted as
 * an equality rather than trusted to the prose: unknown, already spent and
 * expired are indistinguishable to anybody who does not hold the token, and
 * telling them apart helps only somebody sweeping. The server already answers
 * one code for the three; this makes sure a future second code cannot quietly
 * split them on screen.
 */
export function linkError(error: unknown): string {
  if (!ApiError.isApiError(error)) return "Cannot reach the control plane.";
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

/** What the sign-up form says when the server refuses. */
export function registerError(error: unknown): string {
  if (!ApiError.isApiError(error)) return "Cannot reach the control plane.";
  switch (error.code) {
    case "name_taken":
      return "Somebody already has that name. Pick another.";
    case "registration_disabled":
      return "This control plane does not accept new accounts.";
    case "weak_password":
      return error.message;
    case "too_many_attempts":
      return tooManyAttemptsText(error);
    default:
      return error.message;
  }
}

/**
 * The one state badge a person's row carries, beside the `admin` role.
 *
 * A row could now say `admin`, `disabled`, `no password`, `temporary password`
 * and `unverified email` at once — five boxes beside a truncating name on a
 * 390px phone, which is the exact collapse the kebab menu was introduced to end.
 * So `admin` is a *role* and always draws, and everything else is **one** badge
 * chosen by precedence.
 *
 * The precedence is the rule, ordered by how stuck the person is, each strictly
 * subsuming the next: nothing else matters about an account nobody can use; an
 * account with no password cannot sign in at all; one holding a temporary
 * password can sign in and do nothing else; one with an unverified address can
 * use the app and simply cannot recover it.
 *
 * `emailEnabled` is the second argument because on an instance with no SMTP
 * *nobody* has a verified address, so a badge on every row would be noise. It is
 * the honest signature: how stuck is this person on **this** instance.
 */
export type UserState = "disabled" | "no_password" | "temporary_password" | "unverified_email" | null;

export function userState(
  user: { disabled: boolean; hasPassword: boolean; mustChangePassword?: boolean; emailVerified?: boolean; email?: string | null },
  emailEnabled: boolean,
): UserState {
  if (user.disabled) return "disabled";
  if (!user.hasPassword) return "no_password";
  if (user.mustChangePassword === true) return "temporary_password";
  // No address is not an *unverified* address. A bare `!emailVerified` test
  // brands every account that simply never added one.
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

/**
 * Whether changing the address needs the current password.
 *
 * **Setting the address is taking the account**, because the address is the
 * reset channel — one request and the thief no longer needs the password at
 * all. So the answer is yes for every account that has a password, whatever its
 * current address is.
 *
 * ⚠ **This read `me.emailVerified === true && …`, and the server agreed with
 * it.** Both were wrong in the same direction, which is why the mirror is worth
 * having only while it *is* the mirror: adding an address for the first time was
 * exempt on the grounds that "there is nothing to steal yet", which is true of
 * the address and false of the account this route hands over. A stolen session
 * on any account without a verified address — the bootstrap admin included —
 * walked the whole chain to a password of the thief's choosing. `PUT
 * /v1/me/email` in the control plane's `app.ts` is the other half; changing one
 * without the other is a `400 currentPassword is required` on screen.
 *
 * The `hasPassword !== false` half stays and is `PasswordForm`'s `firstTime`
 * rule reappearing: an account with no password row is proved by its API key,
 * and demanding a password nobody ever set would make the migration impossible.
 * It is not a hole — no session can exist without a password row, so only a key
 * reaches it, and a key is already full authority.
 */
export function emailChangeNeedsProof(me: { emailVerified?: boolean; hasPassword?: boolean }): boolean {
  return me.hasPassword !== false;
}

/** What the password form says when the server refuses. */
export function changePasswordError(error: unknown): string {
  if (!ApiError.isApiError(error)) return "Cannot reach the control plane.";
  switch (error.code) {
    case "invalid_password":
      return "That is not your current password.";
    case "too_many_attempts":
      // Same sentence as the sign-in form, same reason — see `tooManyAttemptsText`.
      // This throttle is keyed on the *user id* (`passwordChangeKey`), so being
      // here means the person themselves has been mistyping, and the number of
      // minutes is the only actionable part of the refusal.
      return tooManyAttemptsText(error);
    case "weak_password":
      // The server's own sentence, not a repeat of the client's: this arm is
      // reachable only when the mirror above has drifted, and the number that
      // matters then is the one the server is actually using.
      return error.message;
    default:
      return error.message;
  }
}
