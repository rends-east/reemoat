#!/usr/bin/env node
import { parseArgs } from "node:util";
import { isSettingKey, SECRET_SETTING_KEYS } from "../src/settings.js";

const BASE_URL = process.env["REEMOAT_CP_URL"] ?? "http://127.0.0.1:7888";
const API_KEY = process.env["REEMOAT_CP_KEY"] ?? "";
// Its own variable, never REEMOAT_CP_KEY: a script holding the wrong one should fail rather than half-work.
const PROVISION_KEY = process.env["REEMOAT_CP_PROVISION_KEY"] ?? "";

// Imported from settings.ts so any secret is refused on argv here, where it would land in ps and shell history.
const SECRET_KEYS = [...SECRET_SETTING_KEYS].join(", ");

const USAGE = `cpctl — drive the Reemoat control plane

  login <name|email>                        sign in; prints a REEMOAT_CP_KEY to export
  logout                                    end this session
  sessions [--all]                          where you are signed in; --all signs them all out
  passwd                                    change your own password
  key                                       mint yourself an API key
  keys [--revoke <keyId>]                   your API keys, and how to retire one
  devices [--revoke <deviceId>]             the apps signed in to this account. Retiring one ends
                                            its sign-ins and touches no other device. There is no
                                            way to register one here: an API key has no session
                                            for a device to belong to
  email [<address>]                         your address; setting one sends a confirmation
  me                                        who this credential belongs to
  machines                                  machines you may reach

  addmachine <name>                         register a machine of your own, and enroll it
  setmachine <machineId> --name <n>         rename one you own
  enroll <machineId>                        mint a fresh enrollment code for one you own
  revoke <machineId>                        retire one you own
  shares <machineId>                        who you have shared one of yours with
  share <machineId> <userId> [--scopes a,b] share one of yours with somebody. They read
                                            their own id off 'cpctl me' and tell you: there
                                            is no directory an ordinary account may read,
                                            and a name lookup here would be a way to test
                                            whether an account exists
  unshare <machineId> <userId>              take that back
  leave <machineId>                         give up a share somebody made to you. The three
                                            verbs above are the sharer's; this is the only one
                                            the other person can run, and a share is written
                                            without asking them
  token <machine>                           mint a short-lived token for one machine

  admin users                               every user
  admin adduser <name> [--admin] [--email <addr>]
                                            create a user; with an address they are
                                            invited and no password is ever generated
  admin invite <userId>                     send an invitation again; the only way back
                                            for an invited account whose link never arrived
  admin deluser <userId>                    irreversible; disable is the one you can undo
  admin disable <userId> | enable <userId>  ban a user, or lift it
  provision <user> <machine>                add a daemon for somebody else, with the fleet
                                            provisioning key in REEMOAT_CP_PROVISION_KEY
                                            rather than anybody's account. Raises their
                                            machine limit if it would not fit. <user> is an
                                            id or a name. This is the ONE command here that
                                            needs no REEMOAT_CP_KEY.
                                            ⚠ Run it where you provision FROM. The key makes
                                            machines for any user; a host that runs a daemon
                                            runs agents as its owner, who can read anything
                                            on it. Only the enrollment code goes to the host
  admin provisionkey [--new]                whether a provisioning key exists; --new mints
                                            one, retiring the previous in the same act. Shown
                                            once — only its hash is stored, and nothing ever
                                            prints it again, not even its prefix

  admin machinelimit <userId> [<n>|default] how many machines they may own; no value reads it.
                                            Lowering it switches off the ones they added most
                                            recently and deletes nothing — raising it again
                                            brings them back on their own. The fleet-wide
                                            default is 'admin settings machines.per_user'
  admin settings [<key> <value> | --clear <key>]
                                            registration and SMTP; no key prints them all
  admin settings <secret key>               a secret takes no <value>: it is prompted for
                                            with echo off, or read as one line from stdin
                                            when there is no terminal, so a script pipes
                                            it in. Secrets: ${SECRET_KEYS}
  admin mail [--limit N]                    what has been sent, and what failed
  admin testmail [<address>]                queue a test message

  ⚠ There is no 'admin passwd' and no 'admin key'. An admin may take a credential
    away and may never issue one — a person resets their own password by mail
    ('cpctl email' sets the address) and mints their own key with 'cpctl key'.
    Where no SMTP is configured, a forgotten password has no remedy but deleting
    and recreating the account.

  admin machines                            every machine, including ones nobody owns
  admin addmachine <name> --owner <userId>
                                            register a machine for somebody. --owner is
                                            required: a machine with no owner is outside
                                            the machine limit and outside the ban check
  admin setmachine <machineId> --name <n>   rename it
  admin enroll <machineId>                  mint a single-use enrollment code. Refused (409) for a
                                            machine that is enrolled and has an owner or grantees:
                                            redeeming replaces their daemon rather than reading it,
                                            so its owner mints their own with 'cpctl enroll' 
  admin clearkey <machineId>                forget the encryption key pinned for a machine, so its
                                            next dial pins the one it announces. The way out of a
                                            daemon that dials for ever and never connects because
                                            it announces a key this service pinned a different one
                                            for — a restored backup, a wiped ~/.reemoat. On a daemon
                                            new enough to send its key, re-enrolling does this by
                                            itself; this is for the ones already out there.
                                            ⚠ Nothing reaches that machine between this and its
                                            next dial: there is no unencrypted mode
  admin revoke <machineId>                  revoke a machine
  admin relay                               tunnels connected, and how much each carried
  admin fleet                               what every machine is running, connected or not —
                                            the daemon, the protocol and each agent CLI's
                                            build, as of its last dial; the inventory a
                                            protocol change or an agent rollout is planned from

  admin signingkeys                         the fleet's signing keys, and which one signs
  admin rotatekey                           mint a new one; both stay published
  admin retirekey <kid>                     retire an old one, once every daemon has re-enrolled

  admin grants [--limit N] [--offset N]     every grant, paged; says so when there are more

  ⚠ There is no 'admin grant' and no 'admin ungrant'. Sharing a machine is its
    owner's act — 'cpctl share <machineId> <userId>' — because a grant is full
    access to a machine that runs agents as its owner, and an admin writing one
    for somebody else's machine was one request from that. The list above is
    kept: seeing who holds what is not the power that was removed.

  --scopes    comma-separated; default session:read,session:write
  --json      print the raw response

  A password is never taken as an argument — it would be in \`ps\` for every
  process on the host. It is read from the terminal, or from stdin when there
  is no terminal. A secret *setting* is read the same way and for the same
  reason, which is what keeps this scriptable:

      cpctl admin settings <key> < secret-file
      printf '%s' "$SECRET" | cpctl admin settings <key>

  REEMOAT_CP_URL  ${BASE_URL}
  REEMOAT_CP_KEY  ${API_KEY ? "(set)" : "(NOT SET)"}
  REEMOAT_CP_PROVISION_KEY  ${PROVISION_KEY ? "(set)" : "(not set)"}   # only 'provision' reads it
`;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${API_KEY}` };
  if (init.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(new URL(path, BASE_URL), { ...init, headers });
  } catch (error) {
    fail(`could not reach the control plane at ${BASE_URL}: ${describe(error)}`);
  }

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!response.ok) throw new ApiError(response.status, body, describeError(response.status, body));
  return body as T;
}

function describeError(status: number, body: unknown): string {
  const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
  if (error?.message) return `${status} ${error.code ?? ""}: ${error.message}`.trim();
  return `${status}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An absent field (an older control plane) prints nothing rather than "never seen": absence is not a fact about the machine. */
function agoText(at: number | null | undefined): string | null {
  if (at === undefined) return null;
  if (at === null) return "never seen";
  return `last seen ${coarseAge(at)}`;
}

function coarseAge(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return "just now";
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 129_600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/** Here an absent value and null both mean never used (Q1.629), unlike agoText. */
function usedText(at: number | null | undefined): string {
  if (at === undefined || at === null) return "never used";
  return `last used ${coarseAge(at)}`;
}

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`\n!! ${message}\n`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    admin: { type: "boolean", default: false },
    name: { type: "string" },
    email: { type: "string" },
    revoke: { type: "string" },
    clear: { type: "string" },
    owner: { type: "string" },
    all: { type: "boolean", default: false },
    /** `admin users --ids`: `<id> <name>` per line, for deploy/install.sh. */
    ids: { type: "boolean", default: false },
    limit: { type: "string" },
    offset: { type: "string" },
    scopes: { type: "string" },
    new: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

const asJson = values.json === true;

function show(value: unknown, render: () => void): void {
  if (asJson) out(JSON.stringify(value, null, 2));
  else render();
}

/** Never an argument (it would show in ps and shell history): echo off at a terminal, one line from stdin otherwise. */
async function readSecret(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const input = process.stdin;
  const tty = input.isTTY === true;

  process.stderr.write(`  ${prompt}: `);
  if (tty) input.setRawMode?.(true);

  const rl = createInterface({ input, terminal: false });
  const line = await new Promise<string>((resolve) => {
    let buffer = "";
    if (!tty) {
      rl.once("line", (value) => resolve(value));
      return;
    }
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          input.setRawMode?.(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        if (byte === 0x0d || byte === 0x0a) {
          input.off("data", onData);
          resolve(buffer);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += String.fromCharCode(byte);
      }
    };
    input.on("data", onData);
  });

  if (tty) input.setRawMode?.(false);
  rl.close();
  process.stderr.write("\n");
  return line;
}

interface SettingsAnswer {
  settings: {
    key: string;
    secret: boolean;
    value: string | null;
    set?: boolean;
    source: string;
    envName: string;
    envValue?: string | null;
  }[];
  mail: { configured: boolean; problems: string[] };
  registration: { enabled: boolean; requiresEmail: boolean };
}

function printSettings(body: SettingsAnswer, did: string | null): void {
  if (did !== null) out(did);
  for (const row of body.settings) {
    // A secret prints as set or unset, never its value; (unset) because an empty string is itself a legal value.
    const shown = row.secret ? (row.set === true ? "(set)" : "(unset)") : (row.value ?? "(unset)");
    out(`${row.key.padEnd(30)} ${String(shown).padEnd(34)} ${row.source}`);
  }
  out("");
  out(`registration: ${body.registration.enabled ? "open" : "closed"}`);
  out(`mail: ${body.mail.configured ? "configured" : "not configured"}`);
  for (const problem of body.mail.problems) out(`  ${problem}`);
}

/** What remains of selfProof: prompts for the current password only for an API-key caller that has one (Q1.630). */
async function currentPasswordBody(): Promise<string> {
  const me = await api<{ id: string; hasPassword: boolean; via: "api_key" | "session" }>("/v1/me");
  if (!me.hasPassword) return JSON.stringify({});
  if (me.via === "session") return JSON.stringify({});
  const currentPassword = await readSecret("your current password");
  return JSON.stringify({ currentPassword });
}

/** Both values are single-quoted: controlPlaneUrl derives from the caller's Host header, and unquoted the pasted line would execute it. */
function enrollmentLines(controlPlaneUrl: string, code: string): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    "export REEMOAT_AUTH=signed",
    `export REEMOAT_CONTROL_PLANE=${quote(controlPlaneUrl || BASE_URL)}`,
    `export REEMOAT_ENROLL_CODE=${quote(code)}`,
  ].join("\n");
}

function grantQuery(): string {
  const params = new URLSearchParams();
  if (values.limit !== undefined) params.set("limit", values.limit);
  if (values.offset !== undefined) params.set("offset", values.offset);
  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

async function main(): Promise<void> {
  const [first, ...rest] = positionals;
  if (first === undefined || first === "help") {
    out(USAGE);
    return;
  }
  if (first === "login") {
    const name = rest[0];
    if (!name) fail("usage: cpctl login <name|email>");
    const password = await readSecret(`password for ${name}`);
    const response = await fetch(new URL("/v1/login", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, password }),
    }).catch((error: unknown) => fail(`could not reach the control plane at ${BASE_URL}: ${describe(error)}`));
    const body = (await response.json()) as { token?: string; expiresAt?: number; error?: { message?: string } };
    if (!response.ok) fail(describeError(response.status, body));
    show(body, () => {
      out(`export REEMOAT_CP_KEY=${body.token}`);
      out(`# expires ${new Date(body.expiresAt ?? 0).toISOString()}`);
    });
    return;
  }

  // Above the REEMOAT_CP_KEY check, like login: it carries the provisioning key instead of a person's.
  if (first === "provision") {
    const [user, machine] = rest;
    if (!user || !machine) fail("usage: cpctl provision <user> <machine>   (REEMOAT_CP_PROVISION_KEY)");
    if (!PROVISION_KEY) {
      fail(
        "REEMOAT_CP_PROVISION_KEY is not set.\n" +
          "   an admin mints one with:  cpctl admin provisionkey --new\n" +
          "   it is shown once — only its hash is stored, so a lost one is rotated rather than recovered",
      );
    }
    const response = await fetch(new URL("/v1/provision", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: PROVISION_KEY, user, machine }),
    }).catch((error: unknown) => fail(`could not reach the control plane at ${BASE_URL}: ${describe(error)}`));
    const body = (await response.json()) as {
      machine?: { id: string; name: string };
      owner?: { id: string; name: string };
      enrollment?: { code: string; expiresAt: number };
      controlPlaneUrl?: string;
      machineLimitRaisedTo?: number | null;
      error?: { message?: string };
    };
    if (!response.ok) fail(describeError(response.status, body));
    show(body, () => {
      out(`created ${body.machine?.name} (${body.machine?.id}) for ${body.owner?.name}`);
      if (typeof body.machineLimitRaisedTo === "number") {
        out(`their machine limit was raised to ${body.machineLimitRaisedTo} so it would work.`);
      }
      out("");
      out(enrollmentLines(body.controlPlaneUrl ?? BASE_URL, body.enrollment?.code ?? ""));
      out("");
      out(`# single-use, expires ${new Date(body.enrollment?.expiresAt ?? 0).toISOString()}`);
    });
    return;
  }

  if (!API_KEY) fail("REEMOAT_CP_KEY is not set");

  if (first === "admin") return admin(rest);

  switch (first) {
    case "logout": {
      const body = await api<{ revoked: boolean }>("/v1/me/sessions/current", { method: "DELETE" });
      show(body, () => out("signed out"));
      return;
    }
    case "sessions": {
      if (values.all === true) {
        // The route answers revokedCount, unlike its single-session siblings; api casts, so the compiler cannot catch a mismatch.
        const body = await api<{ revokedCount: number }>("/v1/me/sessions", { method: "DELETE" });
        show(body, () => out(`signed out of ${body.revokedCount} session(s)`));
        return;
      }
      const body = await api<{
        sessions: { id: string; createdAt: number; lastSeenAt: number; current: boolean }[];
      }>("/v1/me/sessions");
      show(body, () => {
        if (body.sessions.length === 0) {
          out("no sessions — this credential is an API key");
          return;
        }
        for (const session of body.sessions) {
          out(
            `${session.id}  started ${new Date(session.createdAt).toISOString()}` +
              `  last seen ${new Date(session.lastSeenAt).toISOString()}${session.current ? "  (this one)" : ""}`,
          );
        }
      });
      return;
    }
    case "passwd": {
      const me = await api<{ hasPassword: boolean }>("/v1/me");
      // Asked only when one exists: an account from before passwords sets its first with its API key as proof.
      const currentPassword = me.hasPassword ? await readSecret("current password") : undefined;
      const newPassword = await readSecret("new password");
      const again = await readSecret("new password (again)");
      if (newPassword !== again) fail("those do not match");
      const body = await api<{ sessionsRevoked: number }>("/v1/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      show(body, () => {
        out("password changed");
        if (body.sessionsRevoked > 0) out(`${body.sessionsRevoked} other session(s) were signed out`);
      });
      return;
    }
    case "key": {
      // No body and no prompt: the route reads none (Q1.630).
      const body = await api<{ apiKey: string }>("/v1/me/keys", { method: "POST" });
      show(body, () => {
        out(`API key: ${body.apiKey}`);
        out("Shown once — only its hash is stored. It never expires; retire it with: cpctl keys");
      });
      return;
    }
    case "keys": {
      const list = await api<{
        keys: { id: string; prefix: string; createdAt: number; revokedAt: number | null; lastUsedAt?: number | null }[];
      }>("/v1/me/keys");
      const retire = values.revoke;
      if (typeof retire === "string") {
        const body = await api<{ revoked: boolean }>(`/v1/me/keys/${retire}`, { method: "DELETE" });
        show(body, () => out(`revoked ${retire}. If that was this shell's key, the next command will 401.`));
        return;
      }
      show(list, () => {
        if (list.keys.length === 0) {
          out("no API keys. Mint one with: cpctl key");
          return;
        }
        for (const key of list.keys) {
          out(`${key.id}  ${key.prefix}…  ${(key.revokedAt === null ? "live" : "revoked").padEnd(7)}  ${usedText(key.lastUsedAt)}`);
        }
        out("Retire one with: cpctl keys --revoke <id>");
      });
      return;
    }
    // No way to register a device here: the route refuses an API key, which has no session for a device to belong to.
    case "devices": {
      const retire = values.revoke;
      if (typeof retire === "string") {
        const body = await api<{ revoked: boolean; sessionsRevoked: number }>(`/v1/me/devices/${retire}`, {
          method: "DELETE",
        });
        show(body, () => {
          out(`retired ${retire}`);
          out(`${body.sessionsRevoked} sign-in(s) on it were ended. Other devices are untouched.`);
        });
        return;
      }
      const list = await api<{
        devices: {
          id: string;
          name: string;
          platform: string;
          lastSeenAt: number | null;
          revokedAt: number | null;
          current: boolean;
        }[];
        limit: number;
      }>("/v1/me/devices");
      show(list, () => {
        if (list.devices.length === 0) {
          out("no devices. One is registered when you sign in from the app.");
          return;
        }
        for (const device of list.devices) {
          const state = device.revokedAt === null ? "live" : `retired ${new Date(device.revokedAt).toISOString()}`;
          const seen = device.lastSeenAt === null ? "never used" : `last seen ${new Date(device.lastSeenAt).toISOString()}`;
          out(
            `${device.id}  ${device.name}  ${device.platform.padEnd(8)}  ${state.padEnd(34)}  ${seen}` +
              (device.current ? "  (this one)" : ""),
          );
        }
        out(`${list.devices.filter((d) => d.revokedAt === null).length} live of ${list.limit} allowed.`);
        out("Retire one with: cpctl devices --revoke <id>   (its sign-ins end; no other device is touched)");
      });
      return;
    }
    case "email": {
      const address = rest[0];
      if (!address) {
        const me = await api<{ email: string | null; emailVerified: boolean }>("/v1/me");
        show(me, () => {
          if (me.email === null) {
            out("no address. Without one this account cannot reset its own password.");
            out("set one with: cpctl email <address>");
            return;
          }
          out(`${me.email}  ${me.emailVerified ? "confirmed" : "NOT confirmed — check your mail"}`);
        });
        return;
      }
      const body = await api<{ email: string; verified: boolean }>("/v1/me/email", {
        method: "PUT",
        body: JSON.stringify({ email: address, ...JSON.parse(await currentPasswordBody()) }),
      });
      show(body, () => {
        out(`${body.email} — a confirmation link is on its way.`);
        out("Until it is opened, this address cannot reset your password.");
      });
      return;
    }
    case "addmachine": {
      const name = rest[0];
      if (!name) fail("usage: cpctl addmachine <name>");
      const body = await api<{
        machine: { id: string };
        enrollment: { code: string; expiresAt: number };
        controlPlaneUrl: string;
      }>("/v1/machines", { method: "POST", body: JSON.stringify({ name }) });
      show(body, () => {
        out(`created ${name}  ${body.machine.id}`);
        out("");
        out(enrollmentLines(body.controlPlaneUrl, body.enrollment.code));
        out("");
        out(`# single-use, expires ${new Date(body.enrollment.expiresAt).toISOString()}`);
      });
      return;
    }
    case "setmachine": {
      const machineId = rest[0];
      const name = values.name;
      if (!machineId || !name) fail("usage: cpctl setmachine <machineId> --name <n>");
      const body = await api<{ name: string }>(`/v1/machines/${machineId}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      show(body, () => out(`renamed to ${body.name}`));
      return;
    }
    case "enroll": {
      const machineId = rest[0];
      if (!machineId) fail("usage: cpctl enroll <machineId>");
      const body = await api<{ code: string; expiresAt: number; controlPlaneUrl: string }>(
        `/v1/machines/${machineId}/enrollments`,
        { method: "POST" },
      );
      show(body, () => {
        out(enrollmentLines(body.controlPlaneUrl, body.code));
        out("");
        out(`# single-use, expires ${new Date(body.expiresAt).toISOString()}`);
      });
      return;
    }
    case "revoke": {
      const machineId = rest[0];
      if (!machineId) fail("usage: cpctl revoke <machineId>");
      const body = await api<{ enrollmentCodesInvalidated: number }>(`/v1/machines/${machineId}/revoke`, {
        method: "POST",
      });
      show(body, () => out(`revoked. ${body.enrollmentCodesInvalidated} unused enrollment code(s) burned.`));
      return;
    }
    case "shares": {
      const machineId = rest[0];
      if (!machineId) fail("usage: cpctl shares <machineId>");
      const body = await api<{ grants: { userId: string; name: string; scopes: string[] }[] }>(
        `/v1/machines/${machineId}/grants`,
      );
      show(body, () => {
        if (body.grants.length === 0) out("shared with nobody");
        for (const grant of body.grants) out(`${grant.name}  ${grant.userId}  ${grant.scopes.join(",")}`);
      });
      return;
    }
    case "share": {
      const [machineId, userId] = rest;
      if (!machineId || !userId) fail("usage: cpctl share <machineId> <userId> [--scopes a,b]");
      const scopes = (values.scopes ?? "session:read,session:write")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const body = await api<unknown>(`/v1/machines/${machineId}/grants`, {
        method: "PUT",
        body: JSON.stringify({ userId, scopes }),
      });
      show(body, () => out(`shared ${machineId} with ${userId}  ${scopes.join(",")}`));
      return;
    }
    case "unshare": {
      const [machineId, userId] = rest;
      if (!machineId || !userId) fail("usage: cpctl unshare <machineId> <userId>");
      const body = await api<{ outstandingTokensExpireWithinSeconds: number }>(
        `/v1/machines/${machineId}/grants?userId=${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
      show(body, () =>
        out(`revoked. Tokens already issued keep working for up to ${body.outstandingTokensExpireWithinSeconds}s.`),
      );
      return;
    }
    case "leave": {
      const machineId = rest[0];
      if (!machineId) fail("usage: cpctl leave <machineId>");
      const body = await api<{ outstandingTokensExpireWithinSeconds: number }>(
        `/v1/machines/${machineId}/grants/me`,
        { method: "DELETE" },
      );
      show(body, () =>
        out(`left. Tokens already issued keep working for up to ${body.outstandingTokensExpireWithinSeconds}s.`),
      );
      return;
    }
    case "me": {
      const me = await api<{ id: string; name: string; isAdmin: boolean }>("/v1/me");
      show(me, () => out(`${me.name}  ${me.id}${me.isAdmin ? "  (admin)" : ""}`));
      return;
    }
    case "machines": {
      const body = await api<{
        machines: {
          id: string;
          name: string;
          enrolled: boolean;
          scopes: string[];
          relayOnline: boolean;
          /** Whose enrollment code this machine enrolled with, when not yours; `null` for yours or never enrolled. Optional for older control planes. */
          enrolledBy?: string | null;
        }[];
      }>("/v1/machines");
      show(body, () => {
        if (body.machines.length === 0) {
          out("no machines granted to you");
          return;
        }
        for (const machine of body.machines) {
          out(
            `${machine.name.padEnd(20)} ${machine.id}` +
              `${machine.enrolled ? "" : "  [not enrolled]"}` +
              `${machine.relayOnline ? "  [online]" : "  [offline]"}  ${machine.scopes.join(",")}` +
              `${machine.enrolledBy ? `  [enrolled by ${machine.enrolledBy}]` : ""}`,
          );
        }
      });
      return;
    }
    case "token": {
      const machine = rest[0];
      if (!machine) fail("usage: cpctl token <machine>");
      const body = await api<{
        token: string;
        expiresAt: number;
        machine: { relayUrl: string | null; relayOnline: boolean };
      }>("/v1/tokens", { method: "POST", body: JSON.stringify({ machine }) });
      show(body, () => {
        out(`export REEMOAT_URL=${body.machine.relayUrl ?? ""}`);
        out(`export REEMOAT_TOKEN=${body.token}`);
        out(`# expires ${new Date(body.expiresAt).toISOString()}`);
      });
      return;
    }
    default:
      fail(`unknown command "${first}"`);
  }
}

async function admin(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  switch (action) {
    case "users": {
      const body = await api<{
        users: {
          id: string;
          name: string;
          isAdmin: boolean;
          disabled: boolean;
          hasPassword: boolean;
          machines: number;
          machineLimit: number;
        }[];
      }>("/v1/admin/users");
      // Enabled users only: a banned one would get a machine they cannot sign in to.
      if (values.ids === true) {
        for (const user of body.users) {
          if (!user.disabled) out(`${user.id} ${user.name}`);
        }
        return;
      }
      show(body, () => {
        for (const user of body.users) {
          const quota = `${user.machines}/${user.machineLimit}`;
          out(
            `${user.name.padEnd(20)} ${user.id}  ${quota.padEnd(7)}${user.isAdmin ? "  admin" : ""}` +
              `${user.disabled ? "  DISABLED" : ""}${user.hasPassword ? "" : "  (no password)"}` +
              `${user.machines > user.machineLimit ? "  OVER LIMIT" : ""}`,
          );
        }
      });
      return;
    }
    case "adduser": {
      const name = rest[0];
      if (!name) fail("usage: cpctl admin adduser <name> [--admin] [--email <address>]");
      const body = await api<{
        id: string;
        invited: boolean;
        email?: string;
        password?: string;
        mailQueued?: boolean;
      }>("/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({
          name,
          isAdmin: values.admin === true,
          ...(typeof values.email === "string" ? { email: values.email } : {}),
        }),
      });
      show(body, () => {
        out(`created ${name}  ${body.id}`);
        if (body.invited) {
          out(`invited ${body.email} — they choose their own password from the link.`);
          if (body.mailQueued === false) out("warning: the message could not be queued. Check: cpctl admin mail");
          return;
        }
        out(`password: ${body.password}`);
        out("Shown once — only its hash is stored. They must replace it at first sign-in.");
      });
      return;
    }
    case "invite": {
      const userId = rest[0];
      if (!userId) fail("usage: cpctl admin invite <userId>");
      const body = await api<{ email: string; mailQueued: boolean }>(
        `/v1/admin/users/${userId}/invite`,
        { method: "POST" },
      );
      show(body, () => {
        out(`invited ${body.email} — they choose their own password from the link.`);
        if (!body.mailQueued) out("warning: the message could not be queued. Check: cpctl admin mail");
      });
      return;
    }
    case "enable": {
      const userId = rest[0];
      if (!userId) fail("usage: cpctl admin enable <userId>");
      const body = await api<{ disabled: boolean }>(`/v1/admin/users/${userId}/enable`, { method: "POST" });
      show(body, () => out("enabled. Their old sessions stay signed out."));
      return;
    }
    case "provisionkey": {
      if (values.new === true) {
        const body = await api<{ key: string }>("/v1/admin/provisioning-key", { method: "POST" });
        show(body, () => {
          out(`export REEMOAT_CP_PROVISION_KEY=${body.key}`);
          out("");
          out("# Shown once; only its hash is stored. The previous key stopped working just now.");
        });
        return;
      }
      // Only a boolean: nothing ever prints this key or any part of it.
      const body = await api<{ minted: boolean }>("/v1/admin/provisioning-key");
      show(body, () =>
        out(
          body.minted
            ? "a provisioning key exists. Its value is not stored; mint another: cpctl admin provisionkey --new"
            : "no provisioning key. Mint one: cpctl admin provisionkey --new",
        ),
      );
      return;
    }
    case "machinelimit": {
      const [userId, value] = rest;
      if (!userId) fail("usage: cpctl admin machinelimit <userId> [<n>|default]");

      if (value === undefined) {
        const listed = await api<{
          users: {
            id: string;
            name: string;
            machines: number;
            machineLimit: number;
            machineLimitSource: string;
          }[];
        }>("/v1/admin/users");
        const user = listed.users.find((row) => row.id === userId);
        if (!user) fail(`no such user: ${userId}`);
        show(user, () =>
          out(`${user.name}  ${user.machines}/${user.machineLimit} machines  (${user.machineLimitSource})`),
        );
        return;
      }

      interface LimitAnswer {
        maxMachines: number;
        source: string;
        instanceDefault: number;
        owned: number;
        suspended: { id: string; label: string }[];
      }
      let body: LimitAnswer;
      if (value === "default") {
        body = await api<LimitAnswer>(`/v1/admin/users/${userId}/machine-limit`, { method: "DELETE" });
      } else {
        const parsed = Number.parseInt(value, 10);
        // Checked here too: parseInt of a word is NaN, which JSON sends as null and the route would report as missing.
        if (!Number.isInteger(parsed) || String(parsed) !== value) {
          fail(`the limit must be a whole number or "default", got "${value}"`);
        }
        body = await api<LimitAnswer>(`/v1/admin/users/${userId}/machine-limit`, {
          method: "PUT",
          body: JSON.stringify({ maxMachines: parsed }),
        });
      }

      show(body, () => {
        out(
          `limit is now ${body.maxMachines} (${body.source}; instance default ${body.instanceDefault}), ` +
            `${body.owned} owned`,
        );
        if (body.suspended.length > 0) {
          out(`${body.suspended.length} machine(s) are over the limit and stop working now:`);
          for (const machine of body.suspended) out(`  ${machine.id}  ${machine.label}`);
          out("Nothing was deleted — raising the limit brings them back on their own.");
        }
      });
      return;
    }
    case "deluser": {
      const userId = rest[0];
      if (!userId) fail("usage: cpctl admin deluser <userId>");
      const body = await api<{ name: string; machinesRevoked: number; enrollmentCodesInvalidated?: number }>(
        `/v1/admin/users/${userId}`,
        { method: "DELETE" },
      );
      show(body, () => {
        out(`deleted ${body.name}. There is no enable for this one.`);
        // Revoked rather than left ownerless as the old machinesReleased did: an ownerless machine escapes the limit and the ban check.
        if (body.machinesRevoked > 0) {
          out(`${body.machinesRevoked} machine(s) they registered were revoked and are off the network.`);
          out("Getting one back means enrolling it again on that host.");
        }
        const codes = body.enrollmentCodesInvalidated ?? 0;
        if (codes > 0) {
          out(`${codes} unredeemed enrollment code(s) they minted were invalidated.`);
        }
      });
      return;
    }
    case "settings": {
      const key = rest[0];
      const value = rest[1];
      const clear = values.clear;

      if (typeof clear === "string") {
        const body = await api<SettingsAnswer>("/v1/admin/settings", {
          method: "PUT",
          body: JSON.stringify({ clear: [clear] }),
        });
        show(body, () => printSettings(body, `cleared ${clear}`));
        return;
      }
      if (key !== undefined) {
        // A secret setting is read from the terminal or stdin, never taken as an argument; unknown keys fall through to the server's refusal.
        const secret = isSettingKey(key) && SECRET_SETTING_KEYS.has(key);
        if (secret && value !== undefined) {
          fail(
            `${key} is a secret and is never taken as an argument — it would be in \`ps\` for ` +
              `every process on this host, and in your shell history.\n` +
              `   type it in:     cpctl admin settings ${key}\n` +
              `   from a script:  cpctl admin settings ${key} < secret-file\n` +
              `   remove it:      cpctl admin settings --clear ${key}`,
          );
        }
        const written = secret ? await readSecret(`value for ${key}`) : value;
        if (written === undefined) fail(`usage: cpctl admin settings ${key} <value>   (or --clear ${key})`);
        // An empty secret is refused: stored, it would win over the environment while mailConfigured still reports it unset.
        if (secret && written === "") {
          fail(`nothing was read for ${key}. To unset it: cpctl admin settings --clear ${key}`);
        }
        const body = await api<SettingsAnswer>("/v1/admin/settings", {
          method: "PUT",
          body: JSON.stringify({ set: { [key]: written } }),
        });
        show(body, () => printSettings(body, `set ${key}`));
        return;
      }
      const body = await api<SettingsAnswer>("/v1/admin/settings");
      show(body, () => printSettings(body, null));
      return;
    }
    case "mail": {
      const limit = values.limit ?? "20";
      const body = await api<{
        total: number;
        deliveries: {
          id: string;
          to: string;
          kind: string;
          createdAt: number;
          attempts: number;
          sentAt: number | null;
          failedAt: number | null;
          error: string | null;
        }[];
      }>(`/v1/admin/mail?limit=${encodeURIComponent(limit)}`);
      show(body, () => {
        if (body.deliveries.length === 0) {
          out("nothing sent yet");
          return;
        }
        for (const row of body.deliveries) {
          const state = row.sentAt !== null ? "sent" : row.failedAt !== null ? "FAILED" : `queued (${row.attempts})`;
          out(`${new Date(row.createdAt).toISOString()}  ${state.padEnd(12)} ${row.kind.padEnd(16)} ${row.to}`);
          if (row.error !== null) out(`    ${row.error}`);
        }
        out(`${body.deliveries.length} of ${body.total}`);
      });
      return;
    }
    case "testmail": {
      const body = await api<{ id: string; to: string }>("/v1/admin/settings/test", {
        method: "POST",
        body: JSON.stringify(rest[0] === undefined ? {} : { to: rest[0] }),
      });
      show(body, () => {
        out(`queued to ${body.to}`);
        out("see what happened with: cpctl admin mail");
      });
      return;
    }
    case "disable": {
      const userId = rest[0];
      if (!userId) fail("usage: cpctl admin disable <userId>");
      const body = await api<{ outstandingTokensExpireWithinSeconds: number; enrollmentCodesInvalidated: number }>(
        `/v1/admin/users/${userId}/disable`,
        { method: "POST" },
      );
      show(body, () => {
        out(`disabled. Tokens already issued keep working for up to ${body.outstandingTokensExpireWithinSeconds}s.`);
        if (body.enrollmentCodesInvalidated > 0) {
          out(`${body.enrollmentCodesInvalidated} unredeemed enrollment code(s) they minted were invalidated.`);
        }
      });
      return;
    }
    case "machines": {
      const body = await api<{
        machines: {
          id: string;
          name: string;
          enrolled: boolean;
          revoked: boolean;
          relayOnline: boolean;
          overLimit: boolean;
          owner: { userId: string; label: string } | null;
          lastSeenAt?: number | null;
        }[];
      }>("/v1/admin/machines");
      show(body, () => {
        for (const machine of body.machines) {
          const flags = [
            machine.enrolled ? "enrolled" : "not enrolled",
            machine.revoked ? "REVOKED" : null,
            machine.relayOnline ? "online" : "offline",
            machine.overLimit ? "OVER LIMIT" : null,
            // Ownerless machines have no limit (there is no owner to hold one), so they are flagged.
            machine.owner === null ? "no owner" : null,
            // Last seen only when offline; optional on the wire for older control planes.
            machine.relayOnline ? null : agoText(machine.lastSeenAt),
          ]
            .filter(Boolean)
            .join(", ");
          out(`${machine.name.padEnd(20)} ${machine.id}  [${flags}]`);
        }
      });
      return;
    }
    case "relay": {
      const body = await api<{
        enabled: boolean;
        url: string | null;
        tunnels: { machineId: string; relayId?: string; since: number; activeStreams: number; requestsProxied: number }[];
        /** Relay ids holding tunnels with no entry in REEMOAT_CP_RELAY_URLS. */
        unmapped?: string[];
      }>("/v1/admin/relay");
      show(body, () => {
        if (!body.enabled) {
          out("relay disabled (set REEMOAT_CP_RELAY_URL to enable)");
          return;
        }
        out(`relay ${body.url}`);
        if (body.tunnels.length === 0) {
          out("no tunnels connected");
          return;
        }
        for (const id of body.unmapped ?? []) {
          out(
            `warning: relay "${id}" holds tunnels and is not in REEMOAT_CP_RELAY_URLS —\n` +
              "  those machines fall back to the shared relay name, which reaches them\n" +
              "  only when they happen to be on the relay it points at.",
          );
        }
        for (const tunnel of body.tunnels) {
          const age = Math.round((Date.now() - tunnel.since) / 1000);
          // The relay id is the only shipped way to spot a wrong REEMOAT_CP_RELAY_URLS entry, which degrades silently.
          out(
            `${tunnel.machineId.padEnd(14)} ${(tunnel.relayId ?? "?").padEnd(10)} up ${String(age).padStart(6)}s  ` +
              `${tunnel.activeStreams} active  ${tunnel.requestsProxied} proxied`,
          );
        }
      });
      return;
    }
    case "fleet": {
      const body = await api<{
        relay: { protocol: number; oldestAccepted: number };
        controlPlane: { version: string };
        byProtocol: Record<string, number>;
        machines: {
          id: string;
          name: string;
          revoked: boolean;
          version: string | null;
          protocol: number | null;
          agents?: Record<string, string | null> | null;
          seenAt: number | null;
        }[];
      }>("/v1/admin/fleet");
      show(body, () => {
        out(
          `control plane ${body.controlPlane.version}, relay speaks ` +
            `v${body.relay.oldestAccepted}-v${body.relay.protocol}`,
        );
        const counts = Object.entries(body.byProtocol).sort();
        if (counts.length > 0) {
          out(`machines by protocol: ${counts.map(([v, n]) => `v${v}=${n}`).join("  ")}`);
        }
        const seenLine = (seenAt: number | null): string =>
          seenAt === null ? "never seen" : `${Math.round((Date.now() - seenAt) / 86400000)}d ago`;
        const live = body.machines.filter((machine) => !machine.revoked);
        if (live.length > 0) {
          out("");
          out("what each machine would launch, as of its last dial:");
          for (const machine of live) {
            const agents = machine.agents ?? null;
            const clis =
              agents === null
                ? "not reported"
                : Object.entries(agents)
                    .map(([id, version]) => `${id} ${version ?? "?"}`)
                    .join("  ");
            out(`  ${machine.name.padEnd(20)} ${(machine.version ?? "unknown").padEnd(12)} ${clis}  (${seenLine(machine.seenAt)})`);
          }
        }
        const stale = body.machines.filter(
          (machine) => !machine.revoked && (machine.protocol === null || machine.protocol < body.relay.protocol),
        );
        if (stale.length > 0) {
          out("");
          out("behind the relay, and what raising the floor would cut off:");
          for (const machine of stale) {
            out(
              `  ${machine.name.padEnd(20)} ${(machine.version ?? "unknown").padEnd(12)} ` +
                `protocol ${machine.protocol === null ? "?" : `v${machine.protocol}`}  ${seenLine(machine.seenAt)}`,
            );
          }
        }
      });
      return;
    }
    // Rotation is three acts (mint, re-enroll every daemon, retire): a daemon captures the key set once, at enrollment.
    case "signingkeys": {
      const body = await api<{ keys: { kid: string; createdAt: number; retiredAt: number | null }[] }>(
        "/v1/admin/signing-keys",
      );
      show(body, () => {
        for (const key of body.keys) {
          const age = Math.round((Date.now() - key.createdAt) / 86_400_000);
          out(
            `${key.kid.padEnd(18)} ${key.retiredAt === null ? "active " : "retired"}  ${age}d old` +
              (key.retiredAt === null && key.kid === body.keys.find((k) => k.retiredAt === null)?.kid
                ? "   (signs)"
                : ""),
          );
        }
      });
      return;
    }
    case "rotatekey": {
      const body = await api<{ kid: string; active: number }>("/v1/admin/signing-keys", { method: "POST" });
      show(body, () => {
        out(`minted ${body.kid} — it signs from the next request.`);
        out(`${body.active} keys are active and all of them are published.`);
        out("");
        out("Every daemon keeps verifying against the set it captured at enrollment,");
        out("so nothing breaks and nothing is fixed yet: re-enroll each machine, then");
        out(`retire the old key with  cpctl admin retirekey <kid>`);
      });
      return;
    }
    case "retirekey": {
      const kid = rest[0];
      if (!kid) fail("usage: cpctl admin retirekey <kid>");
      const body = await api<{ retired: boolean }>(`/v1/admin/signing-keys/${encodeURIComponent(kid)}`, {
        method: "DELETE",
      });
      show(body, () => out(`retired ${kid}. Daemons still holding it verify until they re-enroll.`));
      return;
    }
    case "addmachine": {
      const name = rest[0];
      if (!name) fail("usage: cpctl admin addmachine <name> --owner <userId>");
      // Required here as well as on the route, so the message names the flag.
      if (values.owner === undefined || values.owner.length === 0) {
        fail(
          "usage: cpctl admin addmachine <name> --owner <userId>\n" +
            "   a machine with no owner is outside the machine limit and outside the ban check.\n" +
            `   who is there:  cpctl admin users`,
        );
      }
      const body = await api<{ id: string }>("/v1/admin/machines", {
        method: "POST",
        body: JSON.stringify({ name, ownerId: values.owner }),
      });
      show(body, () => out(`created ${name}  ${body.id}  owner ${values.owner}`));
      return;
    }
    case "setmachine": {
      const machineId = rest[0];
      if (!machineId) fail("usage: cpctl admin setmachine <machineId> --name <name>");
      const patch: Record<string, unknown> = {};
      if (values.name !== undefined) patch["name"] = values.name;
      if (Object.keys(patch).length === 0) fail("nothing to change: pass --name");

      const body = await api<{ id: string; name: string; relayOnline: boolean }>(
        `/v1/admin/machines/${machineId}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
      show(body, () => {
        out(`${body.name}  ${body.id}`);
        out(body.relayOnline ? "  online" : "  offline — no tunnel from it right now");
      });
      return;
    }
    case "enroll": {
      const machineId = rest[0];
      if (!machineId) fail("usage: cpctl admin enroll <machineId>");
      const body = await api<{ code: string; expiresAt: number; controlPlaneUrl?: string }>(
        `/v1/admin/machines/${machineId}/enrollments`,
        { method: "POST" },
      );
      show(body, () => {
        out("Start the daemon on that machine with:");
        out(enrollmentLines(body.controlPlaneUrl ?? "", body.code));
        out(`# single-use, expires ${new Date(body.expiresAt).toISOString()}`);
      });
      return;
    }
    case "clearkey": {
      const machineId = rest[0];
      if (!machineId) fail("usage: cpctl admin clearkey <machineId>");
      const body = await api<{ machineId: string; cleared: boolean; previousKey: string | null }>(
        `/v1/admin/machines/${machineId}/machine-key`,
        { method: "DELETE" },
      );
      show(body, () => {
        if (!body.cleared) {
          out(`${body.machineId} had no encryption key pinned — nothing to clear.`);
        } else {
          out(`cleared the encryption key pinned for ${body.machineId}.`);
          // The only place a pinned key is ever printed.
          out(`  was ${body.previousKey ?? ""}`);
        }
        out("Its next dial pins whatever it announces, so start or restart that daemon now.");
        out("Until that dial nothing can reach it — a token minted now carries no key,");
        out("and there is no unencrypted mode to fall back to. Sessions already open are");
        out("unaffected: the key is read when a token is minted and never again.");
      });
      return;
    }
    case "revoke": {
      const machineId = rest[0];
      if (!machineId) fail("usage: cpctl admin revoke <machineId>");
      const body = await api<{ enrollmentCodesInvalidated: number; outstandingTokensExpireWithinSeconds: number }>(
        `/v1/admin/machines/${machineId}/revoke`,
        { method: "POST" },
      );
      show(body, () => {
        out(`revoked. ${body.enrollmentCodesInvalidated} unused enrollment code(s) invalidated.`);
        out(`Tokens already issued keep working for up to ${body.outstandingTokensExpireWithinSeconds}s —`);
        out("the daemon is never asked, so they expire rather than being rejected.");
      });
      return;
    }
    case "grants": {
      const body = await api<{
        grants: { userId: string; machineId: string; scopes: string[] }[];
        total: number;
        limit: number;
        offset: number;
      }>(`/v1/admin/grants${grantQuery()}`);
      show(body, () => {
        for (const grant of body.grants) out(`${grant.userId}  ->  ${grant.machineId}  ${grant.scopes.join(",")}`);
        if (body.offset + body.grants.length < body.total) {
          out(`\nshowing ${body.offset + 1}-${body.offset + body.grants.length} of ${body.total}`);
          out(`more: cpctl admin grants --offset ${body.offset + body.grants.length}`);
        }
      });
      return;
    }
    // Named in a refusal rather than just removed: scripts and shell history still carry these verbs.
    case "grant":
    case "ungrant":
      fail(
        `there is no 'cpctl admin ${action}'. Sharing a machine is its owner's act: ` +
          "'cpctl share <machineId> <userId>' and 'cpctl unshare <machineId> <userId>', " +
          "run with that owner's credential. 'cpctl admin grants' still lists them.",
      );
    default:
      fail(`unknown admin command "${action ?? ""}"`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ApiError) fail(error.message);
  fail(describe(error));
});
