import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { linkError, passwordProblem, passwordProblemText, registerError, signInReady } from "../../account";
import * as cp from "../../cp";
import {
  gateNeedsSession,
  gateNeedsToken,
  gateOutranksSession,
  gateUsable,
  incompleteLinkRemedy,
  readGateToken,
  readPastedGateToken,
  signupScreen,
  type GateScreen,
} from "../../gate";
import type { InstanceConfig } from "../../instance";
import { LEGAL_DOCS, legalPath, legalTitle, legalPublishable } from "../../legal";
import { navigate } from "../../router";
import { store, type GateState } from "../../gateStore";
import { Button, FIELD, LINK, SETTINGS_HEADING, Spinner } from "../bits";
import { SignIn } from "../SignIn";
import { GateCard, HANDOFF_LABEL, HANDOFF_PATH, ToHandoff } from "./GateCard";
import { Handoff } from "./Handoff";

// The pre-credential screens. Nothing submits on mount, because mail scanners GET every link in a message;
// /verify is the one exception, and only on an account already signed in (see gateNeedsSession).

const field = `mt-1 w-full ${FIELD}`;
const label = `mt-3 block ${SETTINGS_HEADING}`;

// Marked on every field: a marker on one alone would read as the rest being optional.
function FieldLabel({ htmlFor, children }: { htmlFor: string; children: string }): ReactNode {
  return (
    <label htmlFor={htmlFor} className={label}>
      {children} <span className="font-normal text-faint normal-case">(required)</span>
    </label>
  );
}

// Carries a mailed link across by hand; a paste that is not token-shaped is refused locally, never sent.
function PasteLink({ onToken }: { onToken: (token: string) => void }): ReactNode {
  const [value, setValue] = useState("");
  const [rejected, setRejected] = useState(false);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const token = readPastedGateToken(value);
    if (token === null) {
      setRejected(true);
      return;
    }
    onToken(token);
  };

  return (
    <form onSubmit={submit} className="mt-4">
      <label htmlFor="gate-paste" className={label}>
        Link or code
      </label>
      <input
        id="gate-paste"
        // Off: autocomplete would offer a one-time token that has already been spent.
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className={FIELD}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setRejected(false);
        }}
        placeholder="https://…#t=et_… or et_…"
      />
      {rejected && (
        <p className="mt-1.5 text-xs text-danger">
          That does not look like one of our links. Copy the whole link from the email.
        </p>
      )}
      <Button type="submit" tone="primary" className="mt-3 w-full" disabled={value.trim().length === 0}>
        Continue
      </Button>
    </form>
  );
}

export function Gate({ screen, state }: { screen: GateScreen; state: GateState }): ReactNode {
  // Read once, from the fragment and never the path, so the token stays out of server logs.
  const [fromUrl] = useState(() => readGateToken(window.location.hash));
  const [pasted, setPasted] = useState<string | null>(null);
  const token = fromUrl ?? pasted;

  if (gateNeedsToken(screen) && !gateUsable(screen, token)) {
    const remedy = incompleteLinkRemedy(screen);
    return (
      <GateCard
        title="This link is incomplete"
        lead="Some mail apps cut the end off a link. Paste the whole one from your email, or ask for a new one."
        footer={<ToHandoff />}
      >
        <PasteLink onToken={setPasted} />
        {remedy === null ? (
          <></>
        ) : (
          <Button className="mt-3 w-full" onClick={() => navigate(remedy.path, true)}>
            {remedy.label}
          </Button>
        )}
      </GateCard>
    );
  }

  // Needs a session and nobody is signed in: draw SignIn in place, so the URL keeps its unspent token and finishes after sign-in.
  if (gateNeedsSession(screen) && state.phase === "signed_out") {
    const why = "This link needs you signed in. Sign in here and it finishes by itself — nothing has been spent.";
    return (
      <SignIn
        notice={state.authError === null ? why : `${state.authError} ${why}`}
        config={state.config}
      />
    );
  }

  // Asks gateOutranksSession rather than the token rule (Q3.598).
  if (!gateOutranksSession(screen) && state.phase === "ready" && state.me !== null) {
    return (
      <GateCard title={`You are signed in as ${state.me.name}.`}>
        {/* The handoff rather than the root, which this surface does not serve. */}
        <Button tone="plain" className="mt-4 w-full" onClick={() => navigate(HANDOFF_PATH, true)}>
          {HANDOFF_LABEL}
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
      return <ResetPassword token={token ?? ""} config={state.config} />;
    case "confirm":
      return <Confirm token={token ?? ""} config={state.config} />;
    case "verify":
      return <VerifyEmail token={token ?? ""} config={state.config} />;
  }
}

function Register({ state }: { state: GateState }): ReactNode {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  // refreshConfig swallows failure and leaves config null, so this screen latches once an attempt settles instead of spinning.
  const [settled, setSettled] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const screen = signupScreen(state.config, settled);

  useEffect(() => {
    // Only while waiting, so an ordinary visit makes no second instance read.
    if (screen !== "waiting") return;
    let live = true;
    void store.refreshConfig().then(() => {
      if (live) setSettled(true);
    });
    return () => {
      live = false;
    };
  }, [screen, attempt]);

  // Waits rather than guessing whether an address is wanted: either wrong guess breaks sign-up.
  if (screen === "waiting") {
    return (
      <GateCard title="Create an account" footer={<ToHandoff />}>
        <div className="mt-6 flex justify-center">
          <Spinner />
        </div>
      </GateCard>
    );
  }

  if (screen === "unavailable") {
    return (
      <GateCard
        title="Cannot tell whether sign-up is open"
        lead="This control plane did not say what it allows, so this form cannot know what to ask for. It may be down, or it may be older than this screen."
        footer={<ToHandoff />}
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
        footer={<ToHandoff />}
      >
        <></>
      </GateCard>
    );
  }

  if (sentTo !== null) {
    return (
      <GateCard
        title="Check your mail"
        lead={`We sent a confirmation link to ${sentTo}. Open it to finish signing up.`}
        footer={<ToHandoff />}
      >
        <p className="mt-3 text-sm text-muted">
          The link is good for 24 hours. If it does not arrive, check your spam folder.
        </p>
      </GateCard>
    );
  }

  const wantsEmail = screen === "open_verified";
  // Consent is asked only when the instance opts in and the documents are finished (Q1.638).
  const wantsConsent = state.config?.legal === true && legalPublishable();
  const problem = password.length > 0 || confirm.length > 0 ? passwordProblem("", password, confirm) : null;
  const ready =
    !busy &&
    signInReady(name, password) &&
    confirm.length > 0 &&
    problem === null &&
    (!wantsEmail || email.trim().length > 0) &&
    (!wantsConsent || accepted);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    void cp
      .register({
        name: name.trim(),
        password,
        ...(wantsEmail ? { email: email.trim() } : {}),
        ...(wantsConsent ? { acceptedTerms: true } : {}),
      })
      .then(async (answer) => {
        if (answer.kind === "sent") {
          setSentTo(email.trim());
          return;
        }
        await store.adoptSession(answer.session);
        navigate(HANDOFF_PATH, true);
      })
      .catch((cause: unknown) => setError(registerError(cause)))
      .finally(() => setBusy(false));
  };

  // The register route demands consent on legalDocuments alone while this form withholds it until the documents
  // are finished, so the mismatch is drawn here rather than submitted into a 400 (Q1.638).
  if (state.config?.legal === true && !legalPublishable()) {
    return (
      <GateCard title="Sign-up is unavailable" footer={<ToHandoff />}>
        <p className="text-sm text-muted">
          This instance requires agreement to its legal documents, but it does not publish them
          yet — so there is nothing to agree to and no account can be created.
        </p>
        <p className="mt-3 text-sm text-muted">
          If you run this instance: fill in every field of <code>OPERATOR</code> in{" "}
          <code>packages/web/src/legal/operator.ts</code>, or turn{" "}
          <code>REEMOAT_CP_LEGAL_DOCUMENTS</code> off.
        </p>
      </GateCard>
    );
  }

  return (
    <GateCard title="Create an account" footer={<ToHandoff />}>
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
        <p className="mt-1 text-xs text-muted">
          Letters, digits and . _ - only, and not an email address. You can sign in with this or,
          once it is confirmed, with your email address.
        </p>

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

        {/* Before the button it gates, and never in the footer slot where SourceNotice used to draw (Q3.599). Nothing is stored (Q7.134); the links open a new tab so the half-filled form survives. */}
        {wantsConsent && (
          <label className="mt-3 flex min-h-11 items-start gap-2 pr-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-fg"
            />
            <span>
              I agree to
              {LEGAL_DOCS.map((doc, position) => (
                <span key={doc}>
                  {position === 0 ? " " : position === LEGAL_DOCS.length - 1 ? " and " : ", "}
                  the{" "}
                  <a href={legalPath(doc)} target="_blank" rel="noreferrer" className={LINK}>
                    {legalTitle(doc)}
                  </a>
                </span>
              ))}
              .
            </span>
          </label>
        )}

        <Button type="submit" tone="primary" disabled={!ready} className="mt-4 w-full">
          {busy ? "Signing up…" : "Create account"}
        </Button>
      </form>
    </GateCard>
  );
}

function Forgot(): ReactNode {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sent) {
    // One sentence whatever the address, since the server answers identically for unknown ones.
    return (
      <GateCard
        title="Check your mail"
        lead="If that address has an account here, a reset link is on its way. It works once and expires in an hour."
        footer={<ToHandoff />}
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
      footer={<ToHandoff />}
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

function ResetPassword({ token, config }: { token: string; config: InstanceConfig | null }): ReactNode {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keysLeft, setKeysLeft] = useState<number | null>(null);

  const problem = password.length > 0 || confirm.length > 0 ? passwordProblem("", password, confirm) : null;
  const ready = !busy && password.length > 0 && confirm.length > 0 && problem === null;

  if (keysLeft !== null) {
    // A reset leaves API keys alone, so the survivors are named where they can be retired.
    return (
      <Handoff config={config} title="Password set" lead="You are signed in, and every other device was signed out.">
        {keysLeft > 0 && (
          <p className="mt-3 text-sm text-muted">
            This account still has {keysLeft} API key{keysLeft === 1 ? "" : "s"}. They were left alone — retire them
            under Settings → API keys in the app if you think somebody else has one.
          </p>
        )}
      </Handoff>
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
      footer={<ToHandoff />}
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

function Confirm({ token, config }: { token: string; config: InstanceConfig | null }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string | null>(null);

  // A button rather than an effect, so a link scanner cannot spend the token.
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

  // Confirming signs nobody in: control of a mailbox does not prove who chose the password.
  if (confirmed !== null) {
    return (
      <Handoff
        config={config}
        title="Account confirmed"
        lead={`The account ${confirmed} is ready. You sign in with the password you chose when you signed up.`}
      />
    );
  }

  return (
    <GateCard
      title="Confirm your account"
      lead="This finishes your sign-up. You then sign in with the password you chose."
      footer={<ToHandoff />}
    >
      {error !== null && <p className="mt-3 text-sm text-danger">{error}</p>}
      <Button tone="primary" className="mt-4 w-full" disabled={busy} onClick={finish}>
        {busy ? "Confirming…" : "Confirm account"}
      </Button>
    </GateCard>
  );
}

function VerifyEmail({ token, config }: { token: string; config: InstanceConfig | null }): ReactNode {
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");

  // Acts on mount: idempotent on a signed-in account and grants nothing, so a scanner changes nothing.
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
    return (
      <GateCard title="Confirming your address" footer={<ToHandoff />}>
        <div className="mt-6 flex justify-center">
          <Spinner />
        </div>
      </GateCard>
    );
  }

  if (state === "failed") {
    return (
      <GateCard title="That link did not work" footer={<ToHandoff />}>
        <p className="mt-3 text-sm text-danger">{error}</p>
        <p className="mt-3 text-xs text-muted">
          If you are signed in on another device, ask for a new link under Settings → Account.
        </p>
      </GateCard>
    );
  }

  return <Handoff config={config} title="Address confirmed" lead={`${address} can now reset this account's password.`} />;
}
