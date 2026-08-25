import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { linkError, passwordProblem, passwordProblemText, registerError, signInReady } from "../../account";
import * as cp from "../../cp";
import {
  gateNeedsSession,
  gateNeedsToken,
  gateUsable,
  incompleteLinkRemedy,
  readGateToken,
  signupScreen,
  type GateScreen,
} from "../../gate";
import { navigate } from "../../router";
import { store, type AppState } from "../../store";
import { Button, FIELD, Spinner } from "../bits";
import { SignIn } from "../SignIn";
import { BackToSignIn, GateCard } from "./GateCard";

/**
 * The five screens somebody reaches before there is a credential.
 *
 * One file rather than five, because they are one thing: the same card, the same
 * token read out of the same fragment, and the same two error mappers. Five
 * forty-line files with identical imports would be the drift, not the tidiness.
 *
 * ## Nothing here submits on mount
 *
 * `/confirm` and `/reset` render a **button**. The temptation is to spend the
 * token as soon as the page loads — one fewer tap — and it is wrong for a reason
 * that has nothing to do with taste: corporate mail gateways and link
 * prefetchers issue `GET`s for every URL in an inbound message. With an
 * auto-submitting page, a scanner spends the link before the human has seen the
 * mail — creating the account on `/confirm`, and on `/reset` taking over an
 * account that already exists. The token being in the fragment already stops the
 * scanner from *having* it; this is the second, independent answer, because one
 * of the two is a thing somebody can undo without noticing.
 *
 * `/confirm` no longer signs anybody in either, which narrows what a spent link
 * is worth but does not replace this rule: a scanner that creates somebody's
 * account before they see the mail has still burned their one link.
 *
 * `/verify` is the exception and fires on mount: confirming an address on an
 * account you are already signed in to is idempotent and grants nothing. **On an
 * account you are signed in to** — the clause is load-bearing and was for a while
 * only a sentence here. See `gateNeedsSession`.
 */

const field = `mt-1 w-full ${FIELD}`;
const label = "mt-3 block text-2xs font-semibold tracking-wider text-muted uppercase";

/**
 * A field's name, and whether it has to be filled in.
 *
 * ⚠ **Every field on the sign-up form is required, and drawing that on none of
 * them turned out not to be neutral.** Reported from a phone as "it asks for a
 * name" — the first field is a *username*, `USER_NAME` on the control plane
 * refuses `@` outright, and somebody who expected to sign up with an email
 * address read the first box as the place to put one. Naming the requirement is
 * what tells the two boxes apart: the account is a name **and** an address, and
 * both are wanted.
 *
 * On **every** field rather than on the email alone, which is the version this
 * was first written as. A marker on one field is read as a contrast with the
 * others — it says the rest are optional — so marking only the ambiguous one
 * would have introduced a second, quieter lie to fix the first.
 *
 * Lower-case beside an upper-cased label, and `text-faint`: it is a qualifier
 * about the field rather than part of its name, and a second word at the same
 * weight would read as one longer label.
 */
function FieldLabel({ htmlFor, children }: { htmlFor: string; children: string }): ReactNode {
  return (
    <label htmlFor={htmlFor} className={label}>
      {children} <span className="font-normal text-faint normal-case">(required)</span>
    </label>
  );
}

export function Gate({ screen, state }: { screen: GateScreen; state: AppState }): ReactNode {
  /*
   * Read once, from the fragment, and never from the path. `readGateToken`
   * refuses anything that is not token-shaped, so a link truncated by a chat app
   * arrives here as `null` and produces a sentence rather than a request the
   * server answers about a token nobody typed.
   */
  const [token] = useState(() => readGateToken(window.location.hash));

  if (gateNeedsToken(screen) && !gateUsable(screen, token)) {
    // The remedy is per screen and used to be `/forgot` for all three, which is
    // the wrong door for two of them. See `incompleteLinkRemedy`.
    const remedy = incompleteLinkRemedy(screen);
    return (
      <GateCard
        title="This link is incomplete"
        lead="It was cut short on its way here. Links are single-use, so ask for a new one."
        footer={<BackToSignIn />}
      >
        {remedy === null ? (
          <></>
        ) : (
          <Button tone="primary" className="mt-4 w-full" onClick={() => navigate(remedy.path, true)}>
            {remedy.label}
          </Button>
        )}
      </GateCard>
    );
  }

  /*
   * **A link that needs a session, and nobody is signed in.**
   *
   * Not an error and not a refusal: the token is intact and unspent — `cpFetch`
   * declines before a request is built, so the server has never seen it — and
   * the one thing missing is the half the control plane keeps below THE LINE on
   * purpose. What was drawn instead was "That link did not work" over the string
   * `not signed in`, which is `cpFetch`'s message to a developer, about a link
   * that works.
   *
   * **The sign-in form itself rather than a card pointing at one**, and that is
   * the whole of "a way to sign in that comes back": `/verify#t=…` is where the
   * token is, and any navigation away from here is a navigation away from it —
   * back onto a mail somebody then has to find again. Signing in leaves this URL
   * untouched, so the same `Gate` re-renders, this branch stops holding, and
   * `VerifyEmail` mounts and spends the token with no second tap. `SignIn` is
   * reused rather than reproduced for `GateCard`'s reason one file over: a
   * second copy of a password form is drift, and this one is already the screen
   * every password manager on this origin has a saved entry for.
   *
   * The notice is what tells them why they are looking at it, and it composes
   * with `authError` rather than replacing it — a tab signed out *while* sitting
   * here has two things worth saying and the involuntary one comes first.
   */
  if (gateNeedsSession(screen) && state.phase === "signed_out") {
    const why = "This link needs you signed in. Sign in here and it finishes by itself — nothing has been spent.";
    return (
      <SignIn
        notice={state.authError === null ? why : `${state.authError} ${why}`}
        config={state.config}
      />
    );
  }

  /*
   * Signed in already, on a screen that does not need a token.
   *
   * Not a redirect and not a fall-through. A redirect would need an effect in
   * `App`, which has none and should not grow one; a fall-through would leave
   * `/register` in the address bar over the session list, and a reload would do
   * the whole thing again.
   */
  if (!gateNeedsToken(screen) && state.phase === "ready" && state.me !== null) {
    return (
      <GateCard title={`You are signed in as ${state.me.name}.`}>
        <Button tone="plain" className="mt-4 w-full" onClick={() => navigate("/", true)}>
          Go to your machines
        </Button>
        <Button tone="ghost" className="mt-2 w-full" onClick={() => void store.signOut()}>
          Sign out and use another account
        </Button>
      </GateCard>
    );
  }

  switch (screen) {
    case "register":
      return <Register state={state} />;
    case "forgot":
      return <Forgot />;
    case "reset":
      return <ResetPassword token={token ?? ""} />;
    case "confirm":
      return <Confirm token={token ?? ""} />;
    case "verify":
      return <VerifyEmail token={token ?? ""} />;
  }
}

/* ------------------------------------------------------------------ *
 * Sign up
 * ------------------------------------------------------------------ */

function Register({ state }: { state: AppState }): ReactNode {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  /*
   * **How this screen tells "the answer is coming" from "there is no answer".**
   *
   * The store cannot: `loadConfig`'s catch is bare and load-bearing — a control
   * plane rolled back past `/v1/instance` answers 404 and that is not an outage
   * to draw — so `config` is `null` for both, for ever, and a signed-out tab
   * never asks again. This screen therefore does its own asking and latches when
   * an attempt *finishes*, whatever it produced. It is the shape `Devices` uses
   * one file over, with the catch already spent inside the store: a settled read
   * that left the config `null` is a real answer, and this is where it stops
   * being a spinner.
   */
  const [settled, setSettled] = useState(false);
  /** Bumped by Try again, and the only reason the probe below can run twice. */
  const [attempt, setAttempt] = useState(0);

  const screen = signupScreen(state.config, settled);

  useEffect(() => {
    // Nothing to ask once it is known — and this is the guard that keeps a
    // second `GET /v1/instance` off the ordinary visit, where `bootstrap`
    // already fetched it before anybody reached this screen.
    if (screen !== "waiting") return;
    let live = true;
    // `refreshConfig` swallows the failure, by design, so this cannot be a
    // `catch`: what is observed is that the attempt is over.
    void store.refreshConfig().then(() => {
      if (live) setSettled(true);
    });
    return () => {
      live = false;
    };
  }, [screen, attempt]);

  /*
   * **Waits rather than guesses**, which is the one place this differs from
   * `gateOffer`'s fail-open. Both wrong guesses are bad: assume an address is
   * wanted and an instance with no SMTP refuses the form; assume it is not and
   * an instance with SMTP makes an account nobody can confirm.
   *
   * The footer arrived with the terminal state below and belongs on both: a
   * spinner with no way off it is the same dead end however long it is going to
   * last.
   */
  if (screen === "waiting") {
    return (
      <GateCard title="Create an account" footer={<BackToSignIn />}>
        <div className="mt-6 flex justify-center">
          <Spinner />
        </div>
      </GateCard>
    );
  }

  /*
   * **Asked, and it did not answer.**
   *
   * Deliberately not "registration is closed": nothing here knows that, and
   * saying it would turn a control plane that was briefly unreachable into a
   * permanent refusal in the reader's head. What is offered is the act that can
   * change the answer, plus the way out that every other card on this screen
   * has. The retry re-arms the probe rather than reloading the page, because a
   * reload on a phone is a gesture nobody finds and this is one request.
   */
  if (screen === "unavailable") {
    return (
      <GateCard
        title="Cannot tell whether sign-up is open"
        lead="This control plane did not say what it allows, so this form cannot know what to ask for. It may be down, or it may be older than this screen."
        footer={<BackToSignIn />}
      >
        <Button
          tone="primary"
          className="mt-4 w-full"
          onClick={() => {
            setSettled(false);
            setAttempt((previous) => previous + 1);
          }}
        >
          Try again
        </Button>
      </GateCard>
    );
  }

  if (screen === "closed") {
    return (
      <GateCard
        title="Registration is closed"
        lead="Ask whoever runs this control plane for an account."
        footer={<BackToSignIn />}
      >
        <></>
      </GateCard>
    );
  }

  /*
   * **A statement, with nothing to press.** This carried a "Send it again"
   * button, which is a control that cannot report what it does: the mail has
   * already been queued, delivery takes as long as it takes, and a second
   * button that also answers instantly teaches somebody to press it until
   * something happens — mailing themselves four copies and superseding three
   * links on the way. If it really did not arrive, the sign-up form is one
   * navigation away and submitting it again mints a fresh link and burns the old
   * one (`nameTakenByAnother` on the server exists so that same name still
   * works). One way to do it, and it is the way somebody already knows.
   */
  if (sentTo !== null) {
    return (
      <GateCard
        title="Check your mail"
        lead={`We sent a confirmation link to ${sentTo}. Open it to finish signing up.`}
        footer={<BackToSignIn />}
      >
        {/*
          The spam line is not filler. This service sends from a domain with no
          history to a link that is frequently a bare host — the two things that
          most reliably put a first message in a spam folder — so "it did not
          arrive" is the common case rather than the edge one, and the remedy
          costs one sentence.
        */}
        <p className="mt-3 text-sm text-muted">
          The link is good for 24 hours. If it does not arrive, check your spam folder.
        </p>
      </GateCard>
    );
  }

  const wantsEmail = screen === "open_verified";
  const problem = password.length > 0 || confirm.length > 0 ? passwordProblem("", password, confirm) : null;
  const ready =
    !busy &&
    signInReady(name, password) &&
    confirm.length > 0 &&
    problem === null &&
    (!wantsEmail || email.trim().length > 0);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    void cp
      .register({ name: name.trim(), password, ...(wantsEmail ? { email: email.trim() } : {}) })
      .then(async (answer) => {
        if (answer.kind === "sent") {
          setSentTo(email.trim());
          return;
        }
        // No mail on this instance, so there is nothing to confirm and the
        // server has already signed them in.
        await store.adoptSession(answer.session);
        navigate("/", true);
      })
      .catch((cause: unknown) => setError(registerError(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <GateCard title="Create an account" footer={<BackToSignIn />}>
      <form onSubmit={submit}>
        <FieldLabel htmlFor="reg-name">Username</FieldLabel>
        <input
          id="reg-name"
          name="username"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="username"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={field}
        />
        {/* The shape rule is unchanged and still true; the sentence after it was
            not, from the moment `POST /v1/login` started taking a confirmed
            address as well. Saying so here is the only place somebody signing up
            learns that the address below is a second way in rather than only a
            way to recover the account. */}
        <p className="mt-1 text-xs text-muted">
          Letters, digits and . _ - only, and not an email address. You can sign in with this or,
          once it is confirmed, with your email address.
        </p>

        {/*
         * **The absent field says why it is absent.**
         *
         * `signupScreen` answers `open_local` when the control plane has no SMTP,
         * and there the address is not merely unasked-for — `POST /v1/register`
         * *refuses* a non-empty one, because an instance that cannot send mail
         * cannot confirm anything. So the field is genuinely not there, and until
         * now nothing said so: the form simply had one box fewer than the same
         * form on the instance next door, and somebody arriving expecting to sign
         * up with an email had a "username" box and no explanation.
         *
         * The consequence is the half worth writing down rather than the cause.
         * Password recovery is by mail and by nothing else here, so on this
         * instance there is none — which is a thing to know *before* choosing a
         * password, not after forgetting one.
         */}
        {!wantsEmail && (
          <p className="mt-1 text-xs text-muted">
            This server cannot send mail, so it does not ask for an address — and there is no
            password recovery on it.
          </p>
        )}

        {wantsEmail && (
          <>
            <FieldLabel htmlFor="reg-email">Email</FieldLabel>
            <input
              id="reg-email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={field}
            />
            <p className="mt-1 text-xs text-muted">
              We send a confirmation link here. It is also how you reset a lost password.
            </p>
          </>
        )}

        <FieldLabel htmlFor="reg-password">Password</FieldLabel>
        <input
          id="reg-password"
          name="new-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          className={field}
        />
        <FieldLabel htmlFor="reg-confirm">Confirm password</FieldLabel>
        <input
          id="reg-confirm"
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
          enterKeyHint="go"
          className={field}
        />

        {problem !== null && <p className="mt-2 text-sm text-muted">{passwordProblemText(problem)}</p>}
        {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}

        <Button type="submit" tone="primary" disabled={!ready} className="mt-4 w-full">
          {busy ? "Signing up…" : "Create account"}
        </Button>
      </form>
    </GateCard>
  );
}

/* ------------------------------------------------------------------ *
 * Forgot
 * ------------------------------------------------------------------ */

function Forgot(): ReactNode {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sent) {
    /*
     * **The same sentence whatever the address was.** The server answers
     * identically for known, unknown and unverified, and `requestPasswordReset`
     * returns `void` so there is nothing here to branch on even by accident.
     * Saying "if that address has an account" rather than "we sent it" is what
     * keeps the screen honest about what it does not know.
     */
    return (
      <GateCard
        title="Check your mail"
        lead="If that address has an account here, a reset link is on its way. It works once and expires in an hour."
        footer={<BackToSignIn />}
      >
        <p className="mt-3 text-sm text-muted">If it does not arrive, check your spam folder.</p>
      </GateCard>
    );
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || email.trim().length === 0) return;
    setBusy(true);
    setError(null);
    void cp
      .requestPasswordReset(email.trim())
      .then(() => setSent(true))
      .catch((cause: unknown) => setError(linkError(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <GateCard
      title="Reset your password"
      lead="We send a link to the address on your account."
      footer={<BackToSignIn />}
    >
      <form onSubmit={submit}>
        <label htmlFor="forgot-email" className={label}>
          Email
        </label>
        <input
          id="forgot-email"
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          className={field}
        />
        {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
        <Button type="submit" tone="primary" disabled={busy || email.trim().length === 0} className="mt-4 w-full">
          {busy ? "Sending…" : "Send reset link"}
        </Button>
      </form>
    </GateCard>
  );
}

/* ------------------------------------------------------------------ *
 * Spend a reset or invitation link
 * ------------------------------------------------------------------ */

function ResetPassword({ token }: { token: string }): ReactNode {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keysLeft, setKeysLeft] = useState<number | null>(null);

  const problem = password.length > 0 || confirm.length > 0 ? passwordProblem("", password, confirm) : null;
  const ready = !busy && password.length > 0 && confirm.length > 0 && problem === null;

  if (keysLeft !== null) {
    return (
      <GateCard title="Password set" lead="You are signed in, and every other device was signed out.">
        {keysLeft > 0 && (
          <p className="mt-3 text-sm text-muted">
            This account still has {keysLeft} API key{keysLeft === 1 ? "" : "s"}. They were left alone — retire them
            under Settings → Account if you think somebody else has one.
          </p>
        )}
        <Button tone="primary" className="mt-4 w-full" onClick={() => navigate("/", true)}>
          Go to your machines
        </Button>
      </GateCard>
    );
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    void cp
      .consumePasswordReset(token, password)
      .then(async (answer) => {
        await store.adoptSession(answer);
        setKeysLeft(answer.apiKeysActive);
      })
      .catch((cause: unknown) => setError(linkError(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <GateCard
      title="Choose a password"
      lead="Setting it signs you in and signs out every other device."
      footer={<BackToSignIn />}
    >
      <form onSubmit={submit}>
        {/* A password manager updating a saved entry has to know which entry. */}
        <input type="text" name="username" autoComplete="username" className="sr-only" tabIndex={-1} readOnly value="" />
        <label htmlFor="reset-password" className={label}>
          New password
        </label>
        <input
          id="reset-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          className={field}
        />
        <label htmlFor="reset-confirm" className={label}>
          Confirm password
        </label>
        <input
          id="reset-confirm"
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
          enterKeyHint="go"
          className={field}
        />
        {problem !== null && <p className="mt-2 text-sm text-muted">{passwordProblemText(problem)}</p>}
        {error !== null && <p className="mt-2 text-sm text-danger">{error}</p>}
        <Button type="submit" tone="primary" disabled={!ready} className="mt-4 w-full">
          {busy ? "Saving…" : "Set password"}
        </Button>
      </form>
    </GateCard>
  );
}

/* ------------------------------------------------------------------ *
 * Finish a sign-up
 * ------------------------------------------------------------------ */

function Confirm({ token }: { token: string }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);

  // Deliberately a button rather than an effect. See the file's docblock.
  const finish = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void cp
      .confirmRegistration(token)
      .then((answer) => setConfirmed(answer.user.name))
      .catch((cause: unknown) => setError(linkError(cause)))
      .finally(() => setBusy(false));
  };

  /*
   * **Confirmed, and then the sign-in form — not the app.**
   *
   * This used to adopt a session and land on the machine list, so the link in
   * the mail *was* a credential: whoever reached that message was signed in with
   * one tap and never needed the password. A mailbox proves control of an
   * address; it does not prove you are the person who chose the password at
   * sign-up, and this is the one flow where those can be different people,
   * because the password already exists and was chosen minutes ago.
   *
   * So the card states what happened and sends them to the form. The name is
   * repeated back because it is the thing they now have to type, and somebody
   * confirming a day later has genuinely forgotten which one they picked.
   */
  if (confirmed !== null) {
    return (
      <GateCard title="Account confirmed" lead={`Sign in as ${confirmed} to get started.`}>
        <Button tone="primary" className="mt-4 w-full" onClick={() => navigate("/", true)}>
          Sign in
        </Button>
      </GateCard>
    );
  }

  /*
   * **Confirmation, not creation, and that is a wording fix rather than a
   * correction of fact.** The account really does not exist until this button is
   * pressed — it is a `pending_registrations` row and not a `users` one — and
   * the screen used to say so twice, in the heading and in the lead. That is an
   * implementation detail narrated at somebody who signed up two minutes ago and
   * is here to finish the ordinary thing every service asks: confirm your
   * address. Being told their account "does not exist yet" reads as a failure
   * report about the step they already completed.
   *
   * The one place the fact still earns its keep is the mail, where "nothing has
   * been created" is what somebody who did *not* sign up needs to know.
   */
  return (
    <GateCard
      title="Confirm your account"
      lead="This finishes your sign-up. You then sign in with the password you chose."
      footer={<BackToSignIn />}
    >
      {error !== null && <p className="mt-3 text-sm text-danger">{error}</p>}
      <Button tone="primary" className="mt-4 w-full" disabled={busy} onClick={finish}>
        {busy ? "Confirming…" : "Confirm account"}
      </Button>
    </GateCard>
  );
}

/* ------------------------------------------------------------------ *
 * Confirm an address on an account that already exists
 * ------------------------------------------------------------------ */

function VerifyEmail({ token }: { token: string }): ReactNode {
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");

  /*
   * The one screen that acts on mount, and the exception is narrow: confirming
   * an address on an account you are already signed in to is idempotent and
   * grants nothing, so a scanner following the link changes nothing. It also
   * needs a session, which is why the route it calls sits below THE LINE — the
   * token alone must not be able to repoint where a reset goes.
   */
  useEffect(() => {
    let live = true;
    void cp
      .verifyMyEmail(token)
      .then((answer) => {
        if (!live) return;
        setAddress(answer.email);
        setState("done");
        void store.refreshMe();
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(linkError(cause));
        setState("failed");
      });
    return () => {
      live = false;
    };
  }, [token]);

  if (state === "working") {
    /*
     * The footer is the same rule the sign-up screen's wait now follows: a card
     * somebody can only wait on says how to leave it. This wait is bounded by
     * `CP_TIMEOUT_MS` where that one was not, which makes it the cheaper half of
     * one rule rather than a second fix — and the way out is worded for
     * somebody who, by the branch above, is certainly signed in.
     */
    return (
      <GateCard title="Confirming your address" footer={<BackToSignIn>Go to your machines</BackToSignIn>}>
        <div className="mt-6 flex justify-center">
          <Spinner />
        </div>
      </GateCard>
    );
  }

  if (state === "failed") {
    return (
      <GateCard title="That link did not work" footer={<BackToSignIn />}>
        <p className="mt-3 text-sm text-danger">{error}</p>
        <p className="mt-3 text-xs text-muted">
          If you are signed in on another device, ask for a new link under Settings → Account.
        </p>
      </GateCard>
    );
  }

  return (
    <GateCard title="Address confirmed" lead={`${address} can now reset this account's password.`}>
      <Button tone="primary" className="mt-4 w-full" onClick={() => navigate("/", true)}>
        Go to your machines
      </Button>
    </GateCard>
  );
}
