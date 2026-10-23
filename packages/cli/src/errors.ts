/** Which hop refused: the Authority, the relay's upgrade, the encrypted channel, the daemon's own answer, or this client. */
export type ErrorWhere = "server" | "relay" | "channel" | "machine" | "client";

export class ReemoatError extends Error {
  constructor(
    readonly where: ErrorWhere,
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: unknown = null,
    readonly remedy: string | null = null,
  ) {
    super(message);
    this.name = "ReemoatError";
  }

  toJSON(): Record<string, unknown> {
    return { error: { where: this.where, status: this.status, code: this.code, message: this.message, detail: this.detail, remedy: this.remedy } };
  }
}

/** The machine keeps a list of the devices it lets in and this key is not on it yet; nothing was sent. */
export class DeviceNotApproved extends ReemoatError {
  constructor(
    readonly machine: string,
    readonly approvalCode: string,
  ) {
    super(
      "channel",
      403,
      "device_not_approved",
      `${machine} only lets in devices its owner approved, and this one is waiting`,
      { approvalCode },
      `compare the code ${approvalCode} and let it in from the Reemoat app (the machine's Device access), or on ${machine} itself run ` +
        `pnpm client devices approve ${approvalCode}. Nothing was sent; run this again once it is let in`,
    );
    this.name = "DeviceNotApproved";
  }
}

/** The server names a different key for the machine than the one this device first reached it with, and the held one no longer answers. */
export class MachineKeyChanged extends ReemoatError {
  constructor(
    readonly machine: string,
    readonly held: string,
    readonly offered: string,
    readonly heldFingerprint: string,
    readonly offeredFingerprint: string,
  ) {
    super(
      "channel",
      0,
      "machine_key_changed",
      `${machine} no longer answers on the key this device first reached it with, and the server now names another`,
      { held: heldFingerprint, offered: offeredFingerprint },
      `compare ${offeredFingerprint} with what the daemon prints at start on ${machine}, then run ` +
        `reemoat machines trust ${machine} --fingerprint ${offeredFingerprint}`,
    );
    this.name = "MachineKeyChanged";
  }
}

interface Envelope {
  code: string;
  message: string;
  detail: unknown;
}

/** The error envelope both services answer in; null for any other body. */
export function readEnvelope(body: unknown): Envelope | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message, detail } = error as Record<string, unknown>;
  if (typeof code !== "string") return null;
  return { code, message: typeof message === "string" ? message : code, detail: detail ?? null };
}

const SERVER_REMEDIES: Record<string, string> = {
  invalid_api_key: "check REEMOAT_API_KEY; a key is shown once, when it is made",
  api_key_revoked: "make a new key in the Reemoat app's settings",
  machine_not_found: "name a machine as `reemoat machines` lists it, by its id or its name",
  machine_not_enrolled: "the machine has not finished enrolling; run its installer",
  password_change_required: "sign in to the Reemoat app and set a new password first",
  key_bound_elsewhere: "give each installation its own API key, or run `reemoat device rebind` to move this one here",
};

export function serverError(status: number, body: unknown): ReemoatError {
  const envelope = readEnvelope(body);
  if (envelope === null) return new ReemoatError("server", status, `http_${status}`, `the server answered ${status}`);
  return new ReemoatError("server", status, envelope.code, envelope.message, envelope.detail, SERVER_REMEDIES[envelope.code] ?? null);
}

const RELAY_REMEDIES: Record<string, string> = {
  no_tunnel: "the machine is offline, or this account has too many connections open to it; try again shortly",
  encryption_unsupported: "the machine's daemon is too old for an encrypted channel; update it",
};

export function relayError(status: number, code: string): ReemoatError {
  return new ReemoatError("relay", status, code, `the relay refused the connection: ${status} ${code}`, null, RELAY_REMEDIES[code] ?? null);
}

/** The daemon's own answer; a bare 404 is a route this build of the daemon does not have. */
export function machineError(status: number, body: unknown): ReemoatError {
  const envelope = readEnvelope(body);
  if (envelope !== null) return new ReemoatError("machine", status, envelope.code, envelope.message, envelope.detail);
  if (status === 404) {
    return new ReemoatError("machine", 404, "http_404", "the machine's daemon has no such route", null, "update that machine's daemon");
  }
  return new ReemoatError("machine", status, `http_${status}`, `the machine answered ${status}`);
}

/** Whether nothing past the dial could be blamed: the machine was not there to answer. */
export function isUnreachable(error: unknown): boolean {
  if (!(error instanceof ReemoatError)) return false;
  if (error.where === "relay") return error.code === "no_tunnel" || error.status === 502 || error.status === 504;
  return error.where === "client" && (error.code === "unreachable" || error.code === "timeout" || error.code === "closed");
}
