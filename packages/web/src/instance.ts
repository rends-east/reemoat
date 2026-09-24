import type { MailDelivery } from "./cp";

export interface InstanceConfig {
  registration: "off" | "open";
  /** Independent of registration: an admin-only instance with mail still lets people recover their accounts. */
  email: boolean;
  source: { url: string; version: string | null } | null;
  catalogue: string | null;

  appDownload: string | null;

  /** Only a literal true adopts the built-in documents; anything else means no documents and no consent box (Q1.638). */
  legal: boolean;
}

/** Absolute http(s) only: a scheme-less value becomes a relative href that the SPA fallback answers with the app itself. */
function isAbsoluteHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function parseInstanceConfig(body: unknown): InstanceConfig | null {
  const read = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

  const enabled = read(read(body, "registration"), "enabled");
  const configured = read(read(body, "mail"), "configured");
  if (typeof enabled !== "boolean" || typeof configured !== "boolean") return null;

  const url = read(read(body, "source"), "url");
  const version = read(read(body, "source"), "version");
  const source =
    typeof url === "string" && isAbsoluteHttpUrl(url)
      ? { url, version: typeof version === "string" && version.length > 0 ? version : null }
      : null;

  const catalogue = read(read(body, "plugins"), "catalogue");
  const appDownload = read(read(body, "app"), "download");
  // machines.offer from an older control plane is dropped on purpose (Q1.650).
  const legal = read(read(body, "legal"), "documents");
  return {
    registration: enabled ? "open" : "off",
    email: configured,
    source,
    catalogue: typeof catalogue === "string" && isAbsoluteHttpUrl(catalogue) ? catalogue : null,
    appDownload: typeof appDownload === "string" && isAbsoluteHttpUrl(appDownload) ? appDownload : null,
    legal: legal === true,
  };
}

/** Fails closed on an unknown config: a missing market costs a screen, never a lockout. */
export function catalogueUrl(config: InstanceConfig | null): string | null {
  return config?.catalogue ?? null;
}

/** null while the config is unknown: the fields depend on it, so the register screen waits rather than guesses. */
export type SignupMode = "closed" | "open_local" | "open_verified";

export function signupMode(config: InstanceConfig | null): SignupMode | null {
  if (config === null) return null;
  if (config.registration !== "open") return "closed";
  return config.email ? "open_verified" : "open_local";
}

export function adminMayInvite(config: InstanceConfig | null): boolean {
  return config?.email === true;
}

/** Fails open on null: hiding the controls on an unknown config would remove the only route to recovery. */
export function mailUsable(config: InstanceConfig | null): boolean {
  return config === null || config.email;
}

export const MAIL_BACKLOG_WARN_MS = 60 * 60 * 1000;

export type MailTrouble =
  | { kind: "paused"; text: string }
  | { kind: "failed"; text: string }
  | { kind: "backlog"; text: string };

/** Ordered by remedy: open breaker, then past failures, then backlog. null when no delivery object was sent. */
export function mailTrouble(delivery: MailDelivery | undefined): MailTrouble | null {
  if (delivery === undefined) return null;
  if (delivery.paused) {
    return {
      kind: "paused",
      text: "Delivery paused after five failures. It will retry.",
    };
  }
  if (delivery.failed > 0) {
    const many = delivery.failed === 1 ? "1 message has" : `${delivery.failed} messages have`;
    return { kind: "failed", text: `${many} failed to send.` };
  }
  if (delivery.oldestPendingMs !== null && delivery.oldestPendingMs >= MAIL_BACKLOG_WARN_MS) {
    return {
      kind: "backlog",
      text: `${delivery.pending} message${delivery.pending === 1 ? "" : "s"} queued for over an hour.`,
    };
  }
  return null;
}

export interface ConfigField {
  key: string;
  secret: boolean;
  value: string | null;
  set?: boolean;
  source: "database" | "environment" | "unset";
  envName: string;
  envValue?: string | null;
  envSet: boolean;
}

export type FieldOrigin = "env" | "overrides_env" | "stored" | "unset";

export function fieldOrigin(field: ConfigField): FieldOrigin {
  if (field.source === "environment") {
    return field.envSet ? "env" : "unset";
  }
  if (field.source === "database") return field.envSet ? "overrides_env" : "stored";
  return "unset";
}

/** Presence is set or envSet; removability is set alone, since an environment value cannot be cleared here. */
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

export function canResetField(field: ConfigField): boolean {
  return fieldOrigin(field) === "overrides_env";
}

export interface SmtpDraft {
  host: string;
  port: string;
  security: string;
  username: string;
  from: string;
  publicUrl: string;
}

export const SMTP_DRAFT_FIELD: Readonly<Record<string, keyof SmtpDraft>> = {
  "smtp.host": "host",
  "smtp.port": "port",
  "smtp.security": "security",
  "smtp.username": "username",
  "mail.from": "from",
  "mail.public_url": "publicUrl",
};

/** Only the cleared key takes the server's value; every other field keeps what was typed, so Save cannot write the old value back. */
export function draftAfterClear(draft: SmtpDraft, key: string, answerDraft: SmtpDraft): SmtpDraft {
  const field = SMTP_DRAFT_FIELD[key];
  if (field === undefined) return draft;
  return { ...draft, [field]: answerDraft[field] };
}

/** Seeds this page's origin only where nothing is set anywhere; the screen calls it once, at mount. */
export function seedPublicUrl(
  draft: SmtpDraft,
  field: ConfigField | undefined,
  origin: string,
): { draft: SmtpDraft; dirty: boolean } {
  const unset = field === undefined || fieldOrigin(field) === "unset";
  if (!unset || !/^https?:\/\//.test(origin)) return { draft, dirty: false };
  return { draft: { ...draft, publicUrl: origin }, dirty: true };
}

/** A typo catcher, not a validator. An entirely empty draft means mail is off, which is legal. */
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

export function senderMismatch(draft: SmtpDraft): boolean {
  const username = draft.username.trim().toLowerCase();
  const from = draft.from.trim().toLowerCase();
  return username.includes("@") && from.length > 0 && username !== from;
}
