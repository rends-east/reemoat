import { LogOut } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  changePasswordError,
  emailChangeNeedsProof,
  PASSWORD_MIN,
  passwordProblem,
  passwordProblemText,
} from "../../account";
import * as cp from "../../cp";
import type { ApiKeyRecord } from "../../cp";
import { agentWasRecorded, describeAgent, deviceLine } from "../../device";
import { errorText } from "../../http";
import { mailUsable, type InstanceConfig } from "../../instance";
import { store } from "../../store";
import { OneTimeSecret } from "./OneTimeSecret";
import type { Me, SessionRecord } from "../../wire";
import {
  Badge,
  Button,
  DangerButton,
  Empty,
  FIELD,
  SETTINGS_HEADING,
  SETTINGS_SECTION,
  Spinner,
  shortDuration,
} from "../bits";
import { toast } from "../Toast";

/**
 * Your own account: the password, the devices, and the way out.
 *
 * One section rather than a separate one per form. The complaint this whole split
 * answers was a single 650-line scroll mixing agent credentials with the
 * sign-out button; four sections answers it, and a fifth holding one form would
 * be a screen whose entire content is what its own list row already said.
 *
 * **It takes the instance as well as the person**, because one block here is
 * about something only the instance can do — see `mailUsable`.
 */
export function AccountSection({
  me,
  config,
}: {
  me: Me | null;
  /**
   * What this instance allows, or `null` while it is unknown.
   *
   * A prop rather than a read of the store, `SignIn`'s reason: the caller holds
   * whatever there is and this file decides what to do with it, so both states
   * are reachable from a driver.
   */
  config: InstanceConfig | null;
}): ReactNode {
  return (
    <div>
      {me === null ? (
        // Reachable: `bootstrap` keeps `phase: "ready"` with `me: null` when the
        // control plane is unreachable but machines are already known.
        <Empty>Cannot reach the control plane, so your account cannot be shown.</Empty>
      ) : (
        <>
          <p className="text-sm">
            Signed in as <span className="font-medium">{me.name}</span>{" "}
            {me.isAdmin && <Badge tone="strong">admin</Badge>}
          </p>

          <PasswordForm me={me} />
          {/*
            Directly under the password form, because it is that form's
            completion rather than a separate concern: an address is the **only**
            way an account that predates this feature ever becomes able to reset
            its own password.
          */}
          <EmailForm me={me} config={config} />
          <MyKeys me={me} />
          <Devices />
        </>
      )}

      {/*
       * **Outside the `me === null` branch, and that is the fix rather than a
       * layout preference.**
       *
       * This whole screen used to early-return the notice above, with Sign out
       * inside the returned tree — so the one moment somebody most needs to leave
       * (a control plane that is down, or a credential this tab is no longer sure
       * about) was the one moment the button was not drawn, and the app had no
       * other way out. The flat `Settings.tsx` this section was split out of
       * rendered it unconditionally; that property was lost in the split rather
       * than decided against.
       *
       * It works in that state, which is what makes hiding it purely a loss:
       * `cp.logout` puts the local half in a `finally` precisely so a control
       * plane that is down cannot trap somebody in an app they are trying to
       * leave.
       */}
      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Sign out</h2>
        <p className="mt-1 text-xs text-muted">
          Ends this session on the control plane, not just on this device.
        </p>
        <DangerButton icon={LogOut} className="mt-3" onClick={() => void store.signOut()}>
          Sign out
        </DangerButton>
      </section>
    </div>
  );
}

function PasswordForm({ me }: { me: Me }): ReactNode {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * A user carried over from before passwords existed has none, and sets a first
   * one with no current password to prove — their API key is the proof, and it was
   * already full authority over the account. `hasPassword` is how the client knows
   * which of the two forms this is; without it, "set a password" is
   * indistinguishable from "you have forgotten yours".
   */
  const firstTime = me.hasPassword === false;
  const problem = next.length > 0 || confirm.length > 0 ? passwordProblem(current, next, confirm) : null;
  const ready = !busy && next.length > 0 && confirm.length > 0 && problem === null && (firstTime || current.length > 0);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    void cp
      .changePassword(firstTime ? undefined : current, next)
      .then((revoked) => {
        setCurrent("");
        setNext("");
        setConfirm("");
        toast(
          "ok",
          revoked > 0
            ? `Password changed. ${revoked} other device${revoked === 1 ? "" : "s"} signed out.`
            : "Password changed.",
        );
        /*
         * `refreshMe()`, not `resume()` — one `GET /v1/me`, which is the request
         * this line always meant to make.
         *
         * `resume()` re-lists *machines*; `cp.me()` is called from `bootstrap`
         * alone. So `hasPassword` never moved: after setting a first password
         * this form stayed in its first-time shape with no current-password box,
         * and the next submit answered `400 currentPassword is required` about a
         * field that was not on screen. The old comment beside it claimed "one
         * request", which is also what made the bug hard to see — a full wake is
         * a token refresh, a route re-probe, a session re-list and a socket
         * reconnect *per machine*, none of which reads this boolean.
         */
        void store.refreshMe();
      })
      .catch((cause: unknown) => setError(changePasswordError(cause)))
      .finally(() => setBusy(false));
  };

  /*
   * **`block` is load-bearing, not decoration.** An `<input>` is `inline-block`
   * by default, so `w-full max-w-sm` caps it at 384px and leaves the rest of the
   * line free — and the submit button, which is `inline-flex`, floated up into
   * that gap and sat beside the last field as though it belonged to it. Making
   * every field its own block ends that class of bug rather than the one instance.
   *
   * The chrome comes from `FIELD` now. These were `py-2` against `SignIn`'s
   * `py-3` — the same control one screen earlier, ~39px against ~47px once
   * `index.css` forces 16px on a coarse pointer, i.e. below the 44px minimum on
   * this side of the drift and above it on the other.
   */
  const field = `mt-1.5 block w-full max-w-sm ${FIELD}`;
  const label = `mt-4 block ${SETTINGS_HEADING}`;

  return (
    <form onSubmit={submit} className={SETTINGS_SECTION}>
      {/* `h2` under `Settings.tsx`'s `h1`. It was `h3`, which skipped a level —
          and there was no `h2` anywhere on the screen for it to be under. */}
      <h2 className={SETTINGS_HEADING}>
        {firstTime ? "Set a password" : "Change password"}
      </h2>
      <p className="mt-1 text-xs text-muted">
        {firstTime
          ? "This account has no password yet — it predates them. Your API key is what proves this is you."
          : `Changing it signs out every other device. At least ${PASSWORD_MIN} characters.`}
      </p>

      {/* A password manager updating a saved entry has to know *which* entry.
          Without a username field on the form, Chrome and Safari either save a
          second, nameless credential for this origin or offer to save nothing. */}
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={me.name}
        readOnly
        tabIndex={-1}
        className="sr-only"
      />

      {!firstTime && (
        <>
          <label htmlFor="pw-current" className={label}>
            Current password
          </label>
          <input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            className={field}
          />
        </>
      )}

      <label htmlFor="pw-new" className={label}>
        New password
      </label>
      <input
        id="pw-new"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(event) => setNext(event.target.value)}
        className={field}
      />

      <label htmlFor="pw-confirm" className={label}>
        New password again
      </label>
      <input
        id="pw-confirm"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        className={field}
      />

      {problem !== null && <p className="mt-2 text-sm font-medium text-fg">{passwordProblemText(problem)}</p>}
      {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}

      {/* Its own block, and a wider gap than the one between fields — so it reads
          as "the thing that acts on all three" rather than as a fourth row of the
          form. */}
      <div className="mt-6">
        <Button type="submit" tone="primary" disabled={!ready}>
          {busy ? <Spinner /> : firstTime ? "Set password" : "Change password"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Where you are signed in, one row each, and how to end any of them.
 *
 * **The list is back, and what it needed was something to say.** It printed
 * `s_69ad31c3` and a date — an id of *ours*, naming a row in our database and
 * corresponding to nothing a person could recognise — so the only question it
 * exists to answer, *which of these is not me?*, was unanswerable and the per-row
 * sign-out was a coin flip between identical things. A count replaced it for
 * exactly as long as it took to give the rows a device and an address.
 *
 * That took a table rather than two columns, because this package has no
 * `migrate()`; the consequence reaches all the way here, as a row that predates
 * the table and can still only say when it was used. It is listed anyway, and it
 * is the one you are most likely to want to end.
 *
 * **Recognition, not evidence.** Both fields are caller-supplied — see
 * `device.ts` — so this list is a way to end sessions rather than a way to judge
 * them, and the remedy it offers is the same whatever a row says.
 */
function Devices(): ReactNode {
  const [rows, setRows] = useState<SessionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = (): void => {
    void cp
      .sessions()
      .then((next) => {
        setRows(next);
        setError(null);
      })
      .catch(() => setError("Could not read your sessions."));
  };

  useEffect(refresh, []);

  const others = rows === null ? 0 : rows.filter((row) => !row.current).length;

  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>Signed in</h2>
      {/*
       * The first round trip says so, in the words `UsersSection` and
       * `AgentDetail` already use for the same wait.
       *
       * Without it this heading stood over nothing at all until the list landed —
       * which reads as a section that failed to render rather than one that is
       * loading, and then shoves Sign out down the page when the rows arrive. A
       * heading with a spinner under it does neither.
       */}
      {rows === null && error === null && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <Spinner /> reading your sessions…
        </div>
      )}
      {error !== null && <Empty>{error}</Empty>}
      {rows !== null && rows.length === 0 && (
        // An API key has no session row. Said rather than shown as an empty list,
        // which would read as "you are signed in nowhere" while you plainly are.
        <p className="mt-1.5 text-xs text-muted">
          This credential is an API key rather than a sign-in, so there is nothing to end.
        </p>
      )}
      {rows !== null && rows.length > 0 && (
        <>
          <p className="mt-1.5 text-xs text-muted">
            Browser and address are what each sign-in reported, not proof. End anything you do not recognise.
          </p>
          {/*
           * Shown only while a row that predates the recording is on screen, and
           * gone by itself once they are.
           *
           * Without it "Signed in before this was recorded" is a label that
           * reports a fact about our own deploy history in the middle of a list
           * about devices, and the reader's question is *did detection fail?* —
           * which it did not. A permanent caption would then outlive the rows it
           * explains and become a second thing to wonder about. The wording was
           * cut on 2026-09-04 for fewer words; what it keeps is that the row
           * recorded nothing and that signing in again there fills it in.
           */}
          {rows.some((row) => !agentWasRecorded(row.userAgent)) && (
            <p className="mt-1.5 text-xs text-faint">
              Sessions from before this update recorded nothing about the device; sign in again there and it will.
            </p>
          )}

          <div className="mt-3 max-w-lg overflow-hidden rounded-lg border border-edge">
            {rows.map((row) => (
              <DeviceRow key={row.id} row={row} onChanged={refresh} />
            ))}
          </div>

          {others > 0 && (
            <div className="mt-3">
              <Button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void cp
                    .revokeOtherSessions()
                    .then((count) => {
                      // The number the server actually revoked, not the number
                      // this button was labelled with — the list is a poll old,
                      // and `revokedCount` is the answer to what just happened.
                      toast("ok", count === 1 ? "One other device signed out." : `${count} other devices signed out.`);
                      refresh();
                    })
                    .catch((cause: unknown) => toast("error", errorText(cause)))
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? <Spinner /> : `Sign out ${others === 1 ? "the other one" : `all ${others} others`}`}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function DeviceRow({ row, onChanged }: { row: SessionRecord; onChanged: () => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const now = Date.now();

  return (
    <div className="flex items-center gap-3 border-b border-edge/60 px-3 py-2.5 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {/* The raw agent on hover, and only where the row could not read it —
              elsewhere it would be 130 characters of tooltip repeating two words
              already on screen. It is the escape hatch for "unrecognised by
              what?" without putting that string in the layout. */}
          <span
            className="truncate text-sm font-medium"
            title={agentWasRecorded(row.userAgent) && describeAgent(row.userAgent) === null ? (row.userAgent ?? undefined) : undefined}
          >
            {deviceLine(row.userAgent)}
          </span>
          {/* Which row you are on is the one thing here that is certain, so it is
              the badge and not the title — the title is what the agent said. */}
          {row.current && <Badge tone="strong">this device</Badge>}
        </span>
        <span className="mt-0.5 block truncate text-2xs text-muted">
          {/* The address first, because it is the half somebody scans for. A row
              with neither still says when it was last used, which is what makes
              a pre-table session recognisable at all. */}
          {row.ip !== null && row.ip !== undefined && row.ip !== "unknown" && (
            <span className="font-mono">{row.ip}</span>
          )}
          {row.ip !== null && row.ip !== undefined && row.ip !== "unknown" && " · "}
          {row.current ? "in use" : `last used ${shortDuration(Math.max(0, now - row.lastSeenAt))} ago`}
          {` · signed in ${shortDuration(Math.max(0, now - row.createdAt))} ago`}
        </span>
      </span>

      {/*
       * Absent on your own row, and that is the same rule the Users table
       * applies to disabling yourself: the act exists, it is the Sign out button
       * at the bottom of this screen, and offering it twice — once as the
       * dangerous-looking one beside four other devices — is how somebody ends
       * the session they are reading this in by aiming at a neighbour.
       */}
      {!row.current && (
        <DangerButton
          icon={LogOut}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void cp
              .revokeSession(row.id)
              .then(onChanged)
              .catch((cause: unknown) => toast("error", errorText(cause)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Spinner /> : "Sign out"}
        </DangerButton>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Your address
 * ------------------------------------------------------------------ */

/**
 * Set or change the address this account can be reset from.
 *
 * Three shapes, and the middle one is the state most worth naming: an address
 * that has been *claimed* and not proved reserves nothing and cannot receive a
 * reset, so saying "unconfirmed" out loud is the difference between somebody
 * believing they have a way back and having one.
 *
 * **A confirmed address wears no badge.** `Badge`'s `strong` tone means "this
 * one is not like the others", so the ordinary case is the absence of one.
 *
 * **A fourth shape, and it has no controls at all.** On an instance with no SMTP
 * every one of the three above is a promise nothing can keep: `PUT /v1/me/email`
 * answers `409 mail_unconfigured` before it reads the body, so "Add an address"
 * led straight to a refusal and the sentence under it — *"and you can reset your
 * own password"* — described the exact capability the instance does not have, to
 * the people who most need to know they have no way back. `mailUsable` decides,
 * fails **open** on an unknown config, and its docblock carries the argument for
 * both halves.
 */
function EmailForm({ me, config }: { me: Me; config: InstanceConfig | null }): ReactNode {
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState("");
  const [proof, setProof] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsProof = emailChangeNeedsProof(me);
  const has = typeof me.email === "string" && me.email.length > 0;

  if (!mailUsable(config)) {
    /*
     * **Said, not hidden.** A block that quietly disappears is a block somebody
     * hunts for, and what they would fail to learn is the thing that matters
     * most about this account: there is no self-service way back into it. So
     * the heading stays, an address the account already holds stays — it is a
     * fact, and it predates SMTP being switched off — and the only thing removed
     * is every control, because each one could now only be refused.
     *
     * The remedy is named on the side the reader is on. An admin has the screen
     * that fixes it; everybody else has somebody to ask, and telling them to
     * "configure SMTP" would be telling them to do something they cannot. The
     * wording was cut on 2026-09-04 for fewer words; what it keeps is the two
     * arms, and "cannot send mail" verbatim, which `webcheck` pins.
     */
    return (
      <section className={SETTINGS_SECTION}>
        <h2 className={SETTINGS_HEADING}>Email</h2>
        {has && (
          <p className="mt-2 flex items-center gap-2 text-sm">
            <span className="truncate">{me.email}</span>
            {me.emailVerified !== true && <Badge tone="strong">unconfirmed</Badge>}
          </p>
        )}
        <p className="mt-1 max-w-sm text-xs text-muted">
          This control plane cannot send mail, so an address cannot be confirmed and a password cannot be reset from
          one.{" "}
          {me.isAdmin ? "Configure SMTP under Server settings." : "Whoever runs it can configure SMTP."}
        </p>
      </section>
    );
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || address.trim().length === 0) return;
    setBusy(true);
    setError(null);
    void cp
      .setMyEmail(address.trim(), needsProof ? proof : undefined)
      .then(() => {
        setEditing(false);
        setAddress("");
        setProof("");
        toast("ok", "Check that address for a confirmation link.");
        void store.refreshMe();
      })
      .catch((cause: unknown) => setError(changePasswordError(cause)))
      .finally(() => setBusy(false));
  };

  const field = `mt-1.5 block w-full max-w-sm ${FIELD}`;
  const label = `mt-3 block ${SETTINGS_HEADING}`;

  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>Email</h2>

      {!has && !editing && (
        <>
          <p className="mt-1 max-w-sm text-xs text-muted">
            Add and confirm an address and you can reset your own password. Without one, only whoever runs this
            control plane can.
          </p>
          <Button tone="primary" className="mt-3" onClick={() => setEditing(true)}>
            Add an address
          </Button>
        </>
      )}

      {has && !editing && (
        <>
          <p className="mt-2 flex items-center gap-2 text-sm">
            <span className="truncate">{me.email}</span>
            {me.emailVerified !== true && <Badge tone="strong">unconfirmed</Badge>}
          </p>
          {me.emailVerified !== true && (
            <p className="mt-1 max-w-sm text-xs text-muted">
              Until you open the link we sent, this address cannot reset your password.
            </p>
          )}
          <Button className="mt-3" onClick={() => setEditing(true)}>
            {me.emailVerified === true ? "Change" : "Use a different address"}
          </Button>
        </>
      )}

      {editing && (
        <form onSubmit={submit}>
          <label htmlFor="account-email" className={label}>
            Address
          </label>
          <input
            id="account-email"
            type="email"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            autoComplete="email"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={field}
          />
          {/*
            Changing a **confirmed** address needs the current password, and for a
            sharper reason than a password change does: the address is the reset
            channel, so repointing it *is* taking the account. Adding the first
            one needs no proof — there is nothing to steal yet, and opening the
            link is itself the proof.
          */}
          {needsProof && (
            <>
              <label htmlFor="account-email-proof" className={label}>
                Your current password
              </label>
              <input
                id="account-email-proof"
                type="password"
                value={proof}
                onChange={(event) => setProof(event.target.value)}
                autoComplete="current-password"
                className={field}
              />
            </>
          )}
          {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
          <div className="mt-3 flex items-center gap-2">
            <Button
              type="submit"
              tone="primary"
              disabled={busy || address.trim().length === 0 || (needsProof && proof.length === 0)}
            >
              {busy ? <Spinner /> : "Send a link"}
            </Button>
            <Button
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Your API keys
 * ------------------------------------------------------------------ */

/**
 * Where `myKeys` and `revokeMyKey` finally get callers.
 *
 * They have existed with none since keys became listable, which is the shape
 * `UsersSection` names: *a credential the code can read is a credential
 * something must be able to write.* This is also the **only** place a key is
 * minted now — `adminMintKey` is deleted, because an admin may take a credential
 * away and may never issue one.
 */
function MyKeys({ me }: { me: Me }): ReactNode {
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [proof, setProof] = useState("");
  const [asking, setAsking] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    void cp
      .myKeys()
      .then(setKeys)
      .catch(() => setKeys([]));
  };
  useEffect(load, []);

  const needsProof = me.hasPassword !== false;

  const mint = (): void => {
    setBusy(true);
    setError(null);
    void cp
      .mintMyKey(needsProof ? proof : undefined)
      .then((answer) => {
        setMinted(answer.apiKey);
        setAsking(false);
        setProof("");
        load();
      })
      .catch((cause: unknown) => setError(changePasswordError(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section className={SETTINGS_SECTION}>
      <h2 className={SETTINGS_HEADING}>API keys</h2>
      <p className="mt-1 max-w-sm text-xs text-muted">
        For <code>cpctl</code> and scripts. They never expire.
      </p>

      {minted !== null && (
        <OneTimeSecret
          label="Your new API key"
          value={minted}
          note="Shown once. Revoke it here when you no longer need it."
          onDone={() => setMinted(null)}
        />
      )}

      {keys !== null && keys.length > 0 && (
        <div className="mt-3 max-w-sm rounded-lg border border-edge">
          {keys.map((key) => (
            <div key={key.id} className="flex items-center gap-2 border-b border-edge/60 px-3 py-2 last:border-b-0">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{key.prefix}…</span>
              {key.revokedAt !== null && <Badge tone="strong">revoked</Badge>}
              {key.revokedAt === null && (
                <Button
                  size="sm"
                  onClick={() => {
                    void cp
                      .revokeMyKey(key.id)
                      .then(load)
                      .catch((cause: unknown) => toast("error", errorText(cause)));
                  }}
                >
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/*
        The warning goes **before** the button, not after the surprise. Revoking
        the key this browser is holding is allowed and is sometimes the point —
        "this key leaked" is precisely the case where the leaked one is in your
        hand — but it should not be a discovery. The wording was cut on
        2026-09-04 for fewer words; what it keeps is the consequence, that this
        tab is signed out.
      */}
      <p className="mt-2 max-w-sm text-xs text-muted">
        Revoking the key this browser is signed in with signs this tab out.
      </p>

      {asking ? (
        <div className="mt-3 max-w-sm">
          {needsProof && (
            <input
              type="password"
              value={proof}
              onChange={(event) => setProof(event.target.value)}
              placeholder="your current password"
              autoComplete="current-password"
              aria-label="Your current password"
              className={`w-full ${FIELD}`}
            />
          )}
          {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
          <div className="mt-2 flex items-center gap-2">
            <Button tone="primary" disabled={busy || (needsProof && proof.length === 0)} onClick={mint}>
              {busy ? <Spinner /> : "Create the key"}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setAsking(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button tone="primary" className="mt-3" onClick={() => setAsking(true)}>
          New key
        </Button>
      )}
    </section>
  );
}
