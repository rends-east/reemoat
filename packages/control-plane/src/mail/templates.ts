/**
 * What each message says, as pure functions.
 *
 * No templating engine and no caller-supplied HTML: every value that reaches a
 * document goes through `esc`, and the only structure is a paragraph and a link.
 * These are transactional messages read once on a phone, so the plain-text part
 * is the real one and the HTML part exists so a client that refuses to show
 * plain text is not blank.
 *
 * **The link is always a full URL, never a bare code.** "Paste this into the
 * field" is a flow that fails on a phone, where the mail app and the browser are
 * different applications and the clipboard is the only bridge.
 */

export interface Template {
  subject: string;
  text: string;
  html: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The one HTML shape, so seven templates cannot become seven layouts.
 *
 * Inline styles because every mail client strips a `<style>` block, and a
 * system font stack because none of them will fetch a webfont.
 */
function document(parts: { heading: string; paragraphs: string[]; action?: { label: string; url: string } }): string {
  const body = parts.paragraphs.map((line) => `    <p style="margin:0 0 16px">${line}</p>`).join("\n");
  const action =
    parts.action === undefined
      ? ""
      : `\n    <p style="margin:24px 0"><a href="${esc(parts.action.url)}" ` +
        `style="display:inline-block;padding:12px 20px;border-radius:8px;` +
        `background:#111;color:#fff;text-decoration:none">${esc(parts.action.label)}</a></p>` +
        `\n    <p style="margin:0 0 16px;color:#666;font-size:13px">` +
        `If the button does not work, paste this into your browser:<br>` +
        `<span style="word-break:break-all">${esc(parts.action.url)}</span></p>`;

  return (
    `<!doctype html><html><body style="margin:0;padding:24px;` +
    `font:16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111">\n` +
    `  <div style="max-width:520px;margin:0 auto">\n` +
    `    <h1 style="margin:0 0 16px;font-size:20px">${esc(parts.heading)}</h1>\n` +
    `${body}${action}\n` +
    `  </div>\n</body></html>`
  );
}

/** How a link's lifetime is said to somebody, rather than as a timestamp. */
export function lifetimeText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * What these messages call the thing you have an account on.
 *
 * **The product's name and not the host, which is a reversal.** The host was in
 * every subject and every opening sentence, on the argument that a message read
 * out of context should say which server it is about. Measured against a real
 * inbox that reasoning inverted: `mail.public_url` is routinely a bare
 * `host:port`, mail clients auto-link anything that looks like one, and the
 * result was a message from a domain whose first line contained a clickable
 * `192.0.2.10:7888` — the exact shape of a phishing mail, sitting *above* the
 * link somebody is being asked to trust. Two links in a transactional message,
 * one of which goes nowhere useful, is one link too many.
 *
 * What is lost is real and small: somebody with accounts on two instances tells
 * them apart by the link rather than by the first line. The link has to be read
 * before it is opened anyway.
 */
/*
 * Capitalised, because in a subject line this is a name and not a command.
 *
 * It reaches an inbox — "Confirm your Reemoat account" beside mail from banks and
 * airlines — where a lowercase word reads as a typo or as a package somebody is
 * being asked to install. The lowercase spelling is kept for identifiers only:
 * `REEMOAT_*`, `@reemoat/web`, `~/.reemoat`, the browser's storage keys and the
 * `reemoat-sub` header, none of which a person reads as prose.
 */
const PRODUCT = "Reemoat";

export interface LinkArgs {
  /** The person's chosen login name, so a message is not addressed to nobody. */
  name: string;
  url: string;
  lifetime: string;
}

/**
 * Every link message is one instruction, one link, and one line about what
 * happens if it was not you.
 *
 * The long form said the same thing three times — what the link does, that the
 * account does not exist, that nothing was created — which is prose to read
 * rather than a button to press, in a message nobody reads twice.
 *
 * **The verb is "confirm", not "create", and the message and the page it opens
 * use the same word.** That the account does not exist yet is true and is an
 * implementation fact: somebody who signed up two minutes ago is doing the
 * ordinary thing every service asks, and telling them their account "does not
 * exist" reads as a failure report about the step they just completed. The fact
 * survives in exactly one place — the last line, addressed to somebody who did
 * *not* sign up, where "no account was created" is the reassurance that makes
 * ignoring the message the right move.
 */
export function registrationConfirm(a: LinkArgs): Template {
  const heading = "Confirm your account";
  const paragraphs = [
    `Confirm the account <strong>${esc(a.name)}</strong> on ${PRODUCT} to finish signing up.`,
    `The link is good for ${esc(a.lifetime)}. If this was not you, ignore this message — ` +
      `no account was created.`,
  ];
  return {
    subject: `Confirm your ${PRODUCT} account`,
    text:
      `Confirm the account "${a.name}" on ${PRODUCT} to finish signing up:\n\n` +
      `${a.url}\n\n` +
      `The link is good for ${a.lifetime}. If this was not you, ignore this message — ` +
      `no account was created.\n`,
    html: document({ heading, paragraphs, action: { label: "Confirm account", url: a.url } }),
  };
}

/**
 * To the person who already owns an address somebody tried to register with.
 *
 * **It must not say the account's name.** The request that triggered it was
 * anonymous, so naming the account would turn this message into the address
 * oracle that answering with the same 200 exists to close — a stranger would
 * learn a login name by mailing it to its owner.
 */
export function registrationNotice(a: { instance: string; signInUrl: string; forgotUrl: string }): Template {
  const heading = "Somebody tried to sign up with your address";
  const paragraphs = [
    `Somebody asked to create an account on ${esc(a.instance)} using this address. ` +
      `It already belongs to an account, so nothing was created and nothing has changed.`,
    `If it was you, you already have an account — <a href="${esc(a.signInUrl)}">sign in</a>, ` +
      `or <a href="${esc(a.forgotUrl)}">reset your password</a> if you have lost it.`,
    `If it was not you, there is nothing to do. Nobody can reach your account with this message.`,
  ];
  return {
    subject: `Somebody tried to sign up with your address on ${a.instance}`,
    text:
      `Somebody asked to create an account on ${a.instance} using this address.\n` +
      `It already belongs to an account, so nothing was created and nothing has changed.\n\n` +
      `If it was you, you already have an account:\n  ${a.signInUrl}\n\n` +
      `Lost the password?\n  ${a.forgotUrl}\n\n` +
      `If it was not you, there is nothing to do.\n`,
    html: document({ heading, paragraphs }),
  };
}

export function passwordReset(a: LinkArgs): Template {
  const heading = "Set a new password";
  const paragraphs = [
    `To set a new password for <strong>${esc(a.name)}</strong> on ${PRODUCT}, open this link.`,
    `It is good for ${esc(a.lifetime)} and can be used once. If this was not you, ignore this message — ` +
      `your password has not changed.`,
  ];
  return {
    subject: `Set a new ${PRODUCT} password`,
    text:
      `To set a new password for "${a.name}" on ${PRODUCT}, open this link:\n\n` +
      `${a.url}\n\n` +
      `It is good for ${a.lifetime} and can be used once. If this was not you, ignore this message — ` +
      `your password has not changed.\n`,
    html: document({ heading, paragraphs, action: { label: "Set a new password", url: a.url } }),
  };
}

/**
 * An account an admin created, which has no password at all.
 *
 * Its own words rather than `passwordReset`'s, even though it rides the same
 * token: "reset the password" is wrong for somebody who has never had one, and
 * the sentence that matters here — nobody else has ever known a password for
 * this account — is the whole reason the invitation path exists.
 */
export function invitation(a: LinkArgs & { invitedBy: string }): Template {
  const heading = `You have a ${PRODUCT} account`;
  const paragraphs = [
    `${esc(a.invitedBy)} created the account <strong>${esc(a.name)}</strong> for you on ${PRODUCT}. ` +
      `Choose a password with this link.`,
    // The one sentence that is not boilerplate: it is the whole reason an
    // invitation exists rather than an admin handing over a password.
    `Nobody else has ever known a password for this account. The link is good for ${esc(a.lifetime)}.`,
  ];
  return {
    subject: `You have a ${PRODUCT} account`,
    text:
      `${a.invitedBy} created the account "${a.name}" for you on ${PRODUCT}. ` +
      `Choose a password with this link:\n\n` +
      `${a.url}\n\n` +
      `Nobody else has ever known a password for this account. The link is good for ${a.lifetime}.\n`,
    html: document({ heading, paragraphs, action: { label: "Choose a password", url: a.url } }),
  };
}

export function emailVerify(a: LinkArgs): Template {
  const heading = "Confirm this address";
  const paragraphs = [
    `<strong>${esc(a.name)}</strong> on ${PRODUCT} added this address. Confirming it is what lets ` +
      `that account reset its own password.`,
    `The link is good for ${esc(a.lifetime)}. If this was not you, ignore this message — ` +
      `an unconfirmed address can do nothing at all.`,
  ];
  return {
    subject: `Confirm this address for ${PRODUCT}`,
    text:
      `"${a.name}" on ${PRODUCT} added this address. Confirming it is what lets that account ` +
      `reset its own password:\n\n` +
      `${a.url}\n\n` +
      `The link is good for ${a.lifetime}. If this was not you, ignore this message — ` +
      `an unconfirmed address can do nothing at all.\n`,
    html: document({ heading, paragraphs, action: { label: "Confirm this address", url: a.url } }),
  };
}

/**
 * To the address being replaced, sent before the row is overwritten.
 *
 * The new address is named only by its domain. Somebody reading this may be
 * reading it because their account was taken, and printing the attacker's full
 * address into a mailbox is not information they can act on — but "it moved to
 * an address at a domain you do not recognise" is.
 */
export function emailChanged(a: { instance: string; name: string; newDomain: string }): Template {
  const heading = "The address on your account changed";
  const paragraphs = [
    `The address for <strong>${esc(a.name)}</strong> on ${esc(a.instance)} was changed to an address ` +
      `at <strong>${esc(a.newDomain)}</strong>. This address will no longer receive password resets.`,
    `If you did this, there is nothing to do.`,
    `If you did not, somebody has your password. Sign in, change it, and check your API keys.`,
  ];
  return {
    subject: `The address on your ${a.instance} account changed`,
    text:
      `The address for "${a.name}" on ${a.instance} was changed to an address at ${a.newDomain}.\n` +
      `This address will no longer receive password resets.\n\n` +
      `If you did this, there is nothing to do.\n` +
      `If you did not, somebody has your password. Sign in, change it, and check your API keys.\n`,
    html: document({ heading, paragraphs }),
  };
}

export function testMessage(a: { instance: string; sentBy: string }): Template {
  const heading = "Mail works";
  const paragraphs = [
    `${esc(a.sentBy)} sent this from ${esc(a.instance)} to check that outgoing mail is configured.`,
    `It arrived, so registration and password resets will too.`,
  ];
  return {
    subject: `Test message from ${a.instance}`,
    text:
      `${a.sentBy} sent this from ${a.instance} to check that outgoing mail is configured.\n\n` +
      `It arrived, so registration and password resets will too.\n`,
    html: document({ heading, paragraphs }),
  };
}
