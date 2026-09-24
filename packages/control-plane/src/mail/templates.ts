// Pure functions with no templating engine: every value that reaches HTML goes through esc. A link is always a full URL, never a bare code.

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

// The one HTML shape. Inline styles and system fonts: mail clients strip style blocks and fetch no webfonts.
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

export function lifetimeText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

const PRODUCT = "Reemoat";

export interface LinkArgs {
  name: string;
  url: string;
  lifetime: string;
}

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

/** Must not name the account: the request was anonymous, so naming it would make this an address oracle. */
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

export function invitation(a: LinkArgs & { invitedBy: string }): Template {
  const heading = `You have a ${PRODUCT} account`;
  const paragraphs = [
    `${esc(a.invitedBy)} created the account <strong>${esc(a.name)}</strong> for you on ${PRODUCT}. ` +
      `Choose a password with this link.`,
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

/** Names the new address by its domain only; the reader may be the victim of a takeover. */
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
