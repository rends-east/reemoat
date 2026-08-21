import type { MailDelivery } from "./cp";

/**
 * What this control plane allows, and where each setting's value came from.
 *
 * Two separate jobs that share a shape. The first is read by the signed-out
 * screen, which has no credential; the second only by an admin looking at Server
 * settings. They live together because both are *statements about the instance*
 * rather than about a person, and neither belongs in `settings.ts` — that module
 * answers "which settings screen does this URL name, and who may see it".
 */

/* ------------------------------------------------------------------ *
 * What the signed-out screen learns
 * ------------------------------------------------------------------ */

export interface InstanceConfig {
  registration: "off" | "open";
  /**
   * Whether this instance can send mail at all.
   *
   * **Independent of `registration`, and that independence is the point.** The
   * fourth combination — registration off, mail configured — is a real and
   * important instance: admin-only, where people still recover their own
   * accounts. Folding the two into one "self-service" flag closes the reset door
   * whenever registration closes, which is exactly the cell that costs somebody
   * their account.
   */
  email: boolean;
  /**
   * Where this instance's source is, and which version it is running.
   *
   * The AGPL §13 offer, drawn on the signed-out screen because that is where the
   * people it is owed to are. `null` when the control plane did not say — an
   * older one, or one rolled back past the field — and the footer then draws
   * nothing rather than guessing a URL, because a *wrong* source link is worse
   * than none: it looks like the offer was made.
   */
  source: { url: string; version: string | null } | null;
}

/**
 * The body of `GET /v1/instance`, turned into the flat thing this client
 * reasons about — or `null` when it cannot be read.
 *
 * **This function exists because its absence was a live defect, and a cast is
 * not a parse.** `cp.ts` read the response as `readJson<InstanceConfig>`, and
 * the two shapes have never matched: the server answers
 * `{registration: {enabled, requiresEmail}, mail: {configured}}` and this type
 * is flat, so `config.registration` was an *object* that `=== "open"` could
 * never match and `config.email` was `undefined`. On an instance with
 * registration on and SMTP working, the sign-in screen therefore drew neither
 * door and printed the sentence written for an instance that has neither.
 *
 * Every driver was green throughout: `relaycheck` asserted the nested body
 * against the live route, `webcheck` asserted every predicate here against
 * hand-written *flat* fixtures, and nothing anywhere ran one through the other.
 * The generic on `readJson<T>` is an unchecked assertion, so the compiler had
 * nothing to say either. That gap is what this function closes and what
 * `webcheck` now spans by extracting the server's own literal.
 *
 * **An unreadable body is `null`, never a defaulted config.** `null` means
 * "unknown", which `showsGateLink` fails *open* on; returning
 * `{registration: "off", email: false}` would fail closed — which is exactly
 * the failure above, reached by a different road.
 *
 * `registration.requiresEmail` is deliberately **not** read: on the server it is
 * `mailConfigured().configured`, i.e. the same fact as `mail.configured`, and
 * `signupMode` derives it here rather than carrying two fields that can drift.
 */
/**
 * Is this something a browser will treat as a link off this origin?
 *
 * ⚠ **The §13 offer is the one field where "non-empty string" is not enough.** It
 * is rendered straight into an `href`, and a fork editing `SOURCE_URL` to a
 * scheme-less value — `github.com/them/theirs`, which reads like a URL — produces a
 * **relative** href. That path has no extension and is not under `/assets/`, so the
 * control plane's SPA fallback answers it with `index.html`: the "Source" link opens
 * a second copy of this app. A wrong source link is worse than none, because it
 * looks like the offer was made — reached here by a typo rather than by malice.
 *
 * ⚠ **Nothing in this client renders it any more** — see `ui/gate/GateCard.tsx`
 * for what was removed and why. This guard stays, and it is not dead: the field
 * is still parsed, still asserted on the wire by `relaycheck`, and still the one
 * value in `InstanceConfig` that a fork is told to change. A reader that comes
 * back finds it already refusing the shape that would embarrass it, rather than a
 * plain `string` somebody has to re-derive this whole paragraph about.
 */
function isAbsoluteHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    // Not a URL at all. `new URL` is the only parser here and it throws rather
    // than answering, so this is the whole of the negative case.
    return false;
  }
}

export function parseInstanceConfig(body: unknown): InstanceConfig | null {
  const read = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

  const enabled = read(read(body, "registration"), "enabled");
  const configured = read(read(body, "mail"), "configured");
  if (typeof enabled !== "boolean" || typeof configured !== "boolean") return null;

  /*
   * `source` is read leniently and is the one field whose absence is not a
   * refusal: a control plane that predates it, or one rolled back past it, still
   * has a readable config and must still draw a sign-in screen. Only the URL is
   * required — a version without one names nothing, while a URL without a version
   * is still a complete §13 offer.
   */
  const url = read(read(body, "source"), "url");
  const version = read(read(body, "source"), "version");
  const source =
    typeof url === "string" && isAbsoluteHttpUrl(url)
      ? { url, version: typeof version === "string" && version.length > 0 ? version : null }
      : null;

  return { registration: enabled ? "open" : "off", email: configured, source };
}

/**
 * What the registration form has to ask for.
 *
 * `null` when the config is not known yet, and that is **a different answer from
 * `gateOffer`'s fail-open**, deliberately. `gateOffer` decides whether to draw a
 * door and guessing wrong costs one tap; this decides what fields a form
 * contains, and both wrong guesses are bad — assume verified and an instance
 * with no SMTP silently drops an address somebody typed; assume local and an
 * instance with SMTP produces an account that can never be confirmed. So the
 * register screen waits rather than guesses.
 */
export type SignupMode = "closed" | "open_local" | "open_verified";

export function signupMode(config: InstanceConfig | null): SignupMode | null {
  if (config === null) return null;
  if (config.registration !== "open") return "closed";
  return config.email ? "open_verified" : "open_local";
}

/** Whether an admin creating a person can invite them instead of handing over a password. */
export function adminMayInvite(config: InstanceConfig | null): boolean {
  /*
   * **Fails closed on `null`, the opposite of `gateOffer`**, and the same
   * sentence reconciles them: here the cost of being wrong is that the admin
   * passes a password along by hand, which is the status quo and not a lockout.
   */
  return config?.email === true;
}

/**
 * Whether an address on an account can do anything on this instance.
 *
 * **Every promise Settings → Account's Email block makes is `mailConfigured`'s
 * to keep**, and on an instance without SMTP it keeps none of them: `PUT
 * /v1/me/email` answers `409 mail_unconfigured` before it reads the body, no
 * confirmation link is ever sent, and `POST /v1/forgot` has nothing to send
 * either. The screen nonetheless drew the whole block by default — an "Add an
 * address" button over the sentence *"Add an address and confirm it, and you can
 * reset your own password"*, which is the **exact** capability the instance
 * lacks, offered to the exact people who have no other way back in. `Me` carries
 * nothing that could have said otherwise, which is why the answer comes from the
 * config the store already holds rather than from a new field on the wire.
 *
 * **Shown with the reason rather than hidden**, and that is the choice this
 * function exists to support rather than make: a block that quietly disappears
 * is looked for, and a person who cannot find "where do I add my email" learns
 * nothing about why they will never be able to reset their password. So the
 * heading, any address already on the account, and a sentence naming what the
 * operator has to configure all stay; what goes is every *control*, because a
 * control that can only be refused is the thing this UI's rule about "true in
 * the state it is drawn in" forbids.
 *
 * **Fails open on `null`, with `gateOffer`, and against `adminMayInvite`.** The
 * reconciling sentence is the same one: *fail closed where the cost is a missing
 * screen, fail open where the cost is a locked-out person.* Hiding the form on
 * an unknown config would take away the only route to a recovery channel — on an
 * instance whose mail may well be working, since `config` is `null` for a
 * control plane rolled back past `/v1/instance` and for a single failed fetch,
 * neither of which is evidence about SMTP. What failing open costs instead is
 * one refused submit carrying the server's own sentence, which is the ordinary
 * shape of every other form here.
 */
export function mailUsable(config: InstanceConfig | null): boolean {
  return config === null || config.email;
}

/* ------------------------------------------------------------------ *
 * Whether mail is actually arriving
 * ------------------------------------------------------------------ */

/**
 * How long a queued message may sit before that is worth saying out loud.
 *
 * The pump retries 60s → 1h with full jitter over 8 attempts, so a message in
 * flight for a few minutes is a provider being slow rather than a fault. An hour
 * means the retries are losing.
 */
export const MAIL_BACKLOG_WARN_MS = 60 * 60 * 1000;

export type MailTrouble =
  | { kind: "paused"; text: string }
  | { kind: "failed"; text: string }
  | { kind: "backlog"; text: string };

/**
 * The one sentence Server settings owes an admin about delivery, or `null`.
 *
 * ⚠ **Nothing said any of this, and the silence was the defect.** `send()` on the
 * server reports whether a *row was inserted*; the Users screen turns that into
 * "Invitation queued for …" and stops. A permanent SMTP failure after that point
 * reached one `console.error` inside a container with rotating logs, the delivery
 * log was removed from this UI as noise, and `cpctl admin mail` only helps
 * somebody who already suspects a problem. So the first user's invitation could
 * fail and every surface an admin looks at said things were fine — while the
 * invited account, holding no password and an unverified address, had no door
 * left: `POST /v1/forgot` mails nothing for an address nobody has confirmed.
 *
 * **Ordered by remedy, not by severity**, which is the same rule the machine
 * badge follows for `ownerDisabled` before `overLimit`. An open breaker is the
 * only one that is *currently stopping* delivery, so it outranks a count of past
 * failures; and a failure that has already happened outranks a backlog that may
 * still clear on its own.
 *
 * `null` for a config this client has not read, deliberately — a rolled-back
 * control plane sends no `delivery` object, and inventing "all clear" from
 * absence is how a banner becomes something nobody trusts.
 */
export function mailTrouble(delivery: MailDelivery | undefined): MailTrouble | null {
  if (delivery === undefined) return null;
  if (delivery.paused) {
    return {
      kind: "paused",
      text: "Delivery is paused: five sends failed in a row, so the server has stopped dialling for a few minutes. It will try again by itself.",
    };
  }
  if (delivery.failed > 0) {
    const many = delivery.failed === 1 ? "1 message has" : `${delivery.failed} messages have`;
    return {
      kind: "failed",
      text: `${many} failed to send. Anybody waiting on an invitation or a password reset did not get it.`,
    };
  }
  if (delivery.oldestPendingMs !== null && delivery.oldestPendingMs >= MAIL_BACKLOG_WARN_MS) {
    return {
      kind: "backlog",
      text: `${delivery.pending} message${delivery.pending === 1 ? "" : "s"} queued and not going out. The oldest has been waiting over an hour.`,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Where a setting's value came from
 * ------------------------------------------------------------------ */

/**
 * One setting, both sides of the fallback.
 *
 * Not two parallel `env`/`stored` objects: that would put a second
 * implementation of the precedence rule in the client, and the server already
 * computed it. `value` is the *effective* one.
 */
export interface ConfigField {
  key: string;
  /** Never carries a value for a secret. See `smtp.password` on the server. */
  secret: boolean;
  value: string | null;
  /** For a secret only: whether a row exists at all. */
  set?: boolean;
  source: "database" | "environment" | "unset";
  envName: string;
  envValue?: string | null;
  envSet: boolean;
}

export type FieldOrigin = "env" | "overrides_env" | "stored" | "unset";

/**
 * Which of the four states a field is in.
 *
 * `overrides_env` is the only one where "reset to environment" means anything,
 * which is why it is a state rather than two booleans a screen has to combine.
 */
export function fieldOrigin(field: ConfigField): FieldOrigin {
  if (field.source === "environment") {
    // An incoherent pair — the server said "environment" while reporting no
    // environment value — degrades to `unset` rather than throwing. `wire.ts`'s
    // posture: a client renders what it can and never crashes on a shape.
    return field.envSet ? "env" : "unset";
  }
  if (field.source === "database") return field.envSet ? "overrides_env" : "stored";
  return "unset";
}

/**
 * The one sentence a write-only secret's row says about itself.
 *
 * **Both halves of that sentence used to be computed separately and could
 * contradict each other inside one line.** The screen read
 * `field.set === true ? "A password is set." : "No password set."` and then
 * appended `originText(fieldOrigin(field))` — but `set` is the server answering
 * *"is there a database row"*, not *"does a password exist"*: `app.ts` writes
 * `set: resolved.source === "database"`, and a password supplied by
 * `REEMOAT_CP_SMTP_PASSWORD` is a documented, working configuration that
 * `mailConfigured` reads and that produces `set: false, envSet: true`. The line
 * then rendered **"No password set. from the environment"** — telling the
 * operator of a working instance that the credential is missing, beside a Send
 * test button the same screen had enabled.
 *
 * So existence and provenance are one answer here rather than two, and there is
 * no concatenation left for them to disagree across. **Presence is
 * `set || envSet`; removability is `set` alone** — those are genuinely different
 * questions, because an environment value cannot be cleared from a screen, and
 * conflating them is what put "Remove it" and the truth on opposite sides of one
 * boolean.
 *
 * `null` for a field the server did not send: that is *unknown*, and claiming
 * "no password" about it would be the same lie one step further out.
 */
export function secretFieldText(field: ConfigField | undefined): string | null {
  if (field === undefined) return null;
  if (field.set === true) {
    return field.envSet
      ? "A password is set here, overriding the environment."
      : "A password is set here.";
  }
  return field.envSet ? "A password is set in the environment." : "No password is set.";
}

export function originText(origin: FieldOrigin): string {
  switch (origin) {
    case "env":
      return "from the environment";
    case "overrides_env":
      return "set here, overriding the environment";
    case "stored":
      return "set here";
    case "unset":
      return "not set";
  }
}

/**
 * Whether "reset to environment" is offered.
 *
 * True for exactly one origin. `stored` with nothing in the environment is
 * **false**: there is nothing to reset *to*, and the act there is "clear", which
 * is a different control with a different consequence.
 */
export function canResetField(field: ConfigField): boolean {
  return fieldOrigin(field) === "overrides_env";
}

/* ------------------------------------------------------------------ *
 * The SMTP form
 * ------------------------------------------------------------------ */

export interface SmtpDraft {
  host: string;
  port: string;
  security: string;
  username: string;
  from: string;
  publicUrl: string;
}

/**
 * What is wrong with what has been typed, or `null`.
 *
 * A **typo catcher, not a validator** — the server is the only side that can
 * enforce anything, which is `account.ts`'s stated posture about every other
 * form here. In particular the address checks look for an `@` and stop: this
 * repository's position on canonical email patterns is that they are wrong in
 * both directions, and refusing somebody's real address in a form is worse than
 * letting the server say so.
 *
 * **An entirely empty draft is `null`, not a problem.** That is "mail is not
 * configured", which is a legal state — a form that refused to save it could
 * never turn mail off.
 */
export function smtpProblem(draft: SmtpDraft): string | null {
  const empty =
    draft.host.trim().length === 0 &&
    draft.from.trim().length === 0 &&
    draft.publicUrl.trim().length === 0 &&
    draft.username.trim().length === 0;
  if (empty) return null;

  if (draft.port.trim().length > 0) {
    const port = Number.parseInt(draft.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "Port must be between 1 and 65535.";
  }
  if (draft.from.trim().length > 0 && !draft.from.includes("@")) {
    return "The from address needs an @.";
  }
  if (draft.publicUrl.trim().length > 0 && !/^https?:\/\//.test(draft.publicUrl.trim())) {
    return "The public URL must start with http:// or https://.";
  }
  return null;
}

/**
 * Whether the sender and the sign-in look like they will disagree.
 *
 * A warning the screen shows and never a refusal: most submission servers insist
 * the envelope sender is the mailbox you authenticated as, and answer
 * `550 sender not allowed` otherwise — but a relay that authorises a whole
 * verified domain legitimately sends as any address in it. The server makes the
 * same judgement in `mailConfigured` and also declines to enforce it.
 */
export function senderMismatch(draft: SmtpDraft): boolean {
  const username = draft.username.trim().toLowerCase();
  const from = draft.from.trim().toLowerCase();
  return username.includes("@") && from.length > 0 && username !== from;
}
