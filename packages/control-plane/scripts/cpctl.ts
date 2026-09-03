#!/usr/bin/env node
import { parseArgs } from "node:util";
import { isSettingKey, SECRET_SETTING_KEYS } from "../src/settings.js";

/**
 * The control plane's terminal client.
 *
 * Shaped like the daemon's `scripts/client.ts`: the same `api()` helper, the
 * same `{error:{code,message}}` unwrapping, the same "nothing prints from a
 * library" split. It is the only UI this service has, and it exists because a
 * control plane you can only drive with hand-written curl is a control plane
 * nobody will keep the grants straight in.
 */

const BASE_URL = process.env["REEMOAT_CP_URL"] ?? "http://127.0.0.1:7888";
const API_KEY = process.env["REEMOAT_CP_KEY"] ?? "";
/**
 * The fleet provisioning key, which is not anybody's credential.
 *
 * Its own variable rather than overloading `REEMOAT_CP_KEY`, because the two
 * grant very different things and a script that had one where it meant the other
 * should fail rather than half-work.
 */
const PROVISION_KEY = process.env["REEMOAT_CP_PROVISION_KEY"] ?? "";

/**
 * The settings whose value may never arrive on argv, **named rather than
 * counted**, and read from the server's own list.
 *
 * `SECRET_SETTING_KEYS` is the same set `GET /v1/admin/settings` consults to
 * decide that a value is reported as two booleans and never returned, and the
 * same one the web form consults to decide it renders a write-only field. This
 * file was the hole in that: `PUT /v1/admin/settings` takes `smtp.password` in
 * `set` like any other key — correctly, because the browser sends it in a
 * body — so the refusal belongs at the one door that puts the value in `ps`
 * output and shell history, which is this one.
 *
 * Imported rather than transcribed so a second secret is covered here by
 * arriving in `settings.ts`, and so USAGE, the refusal and the prompt cannot
 * come to disagree about which keys they are talking about.
 */
const SECRET_KEYS = [...SECRET_SETTING_KEYS].join(", ");

const USAGE = `cpctl — drive the Reemoat control plane

  login <name|email>                        sign in; prints a REEMOAT_CP_KEY to export
  logout                                    end this session
  sessions [--all]                          where you are signed in; --all signs them all out
  passwd                                    change your own password
  key                                       mint yourself an API key
  keys [--revoke <keyId>]                   your API keys, and how to retire one
  email [<address>]                         your address; setting one sends a confirmation
  me                                        who this credential belongs to
  machines                                  machines you may reach

  addmachine <name>                         register a machine of your own, and enroll it
  setmachine <machineId> --name <n>         rename one you own
  enroll <machineId>                        mint a fresh enrollment code for one you own
  revoke <machineId>                        retire one you own
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
  admin enroll <machineId>                  mint a single-use enrollment code
  admin revoke <machineId>                  revoke a machine
  admin relay                               tunnels connected, and how much each carried
  admin fleet                               what every machine is running, connected or not —
                                            the inventory a protocol change is planned from

  admin signingkeys                         the fleet's signing keys, and which one signs
  admin rotatekey                           mint a new one; both stay published
  admin retirekey <kid>                     retire an old one, once every daemon has re-enrolled

  admin grants [--limit N] [--offset N]     every grant, paged; says so when there are more
  admin grant <userId> <machineId> [--scopes a,b]
                                            grant a user access to a machine
  admin ungrant <userId> <machineId>        remove a grant

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
    // The one failure worth naming: a control plane that is simply not running.
    // Daemons keep working through this; only issuance stops.
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

/**
 * How long ago something was, as a phrase, or `null` when nothing was recorded.
 *
 * `null` and "never" are deliberately different answers here. A machine that has
 * never held a tunnel has never been seen; a control plane that predates
 * `machine_last_seen` sends no field at all and cannot claim either. Printing
 * "last seen never" for the second would be inventing a fact about a fleet that
 * has been running fine.
 *
 * Coarse on purpose — the question this answers is "did this work today", and a
 * timestamp to the second reads as precision the row does not have.
 */
function agoText(at: number | null | undefined): string | null {
  if (at === undefined) return null;
  if (at === null) return "never seen";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return "last seen just now";
  if (seconds < 5400) return `last seen ${Math.round(seconds / 60)}m ago`;
  if (seconds < 129_600) return `last seen ${Math.round(seconds / 3600)}h ago`;
  return `last seen ${Math.round(seconds / 86_400)}d ago`;
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
    /**
     * `admin adduser --email`: invite instead of generating a password.
     *
     * `--with-key` used to live here and is gone with the route behind it: an
     * admin issuing a permanent credential to somebody else was the third
     * credential-issuing door, and the one this CLI actually drove.
     */
    email: { type: "string" },
    /** `keys --revoke <id>`: retire one of your own. */
    revoke: { type: "string" },
    /** `admin settings --clear <key>`: drop the override, fall back to the env. */
    clear: { type: "string" },
    /** Who a machine registered by an admin belongs to. */
    owner: { type: "string" },
    /** `sessions --all`: sign out everywhere. */
    all: { type: "boolean", default: false },
    /** `admin users --ids`: `<id> <name>` per line, for deploy/install.sh. */
    ids: { type: "boolean", default: false },
    // Paging for `admin grants`, the one admin list that is users × machines.
    limit: { type: "string" },
    offset: { type: "string" },
    scopes: { type: "string" },
    /** `admin provisionkey --new`: mint one, retiring the previous. */
    new: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

const asJson = values.json === true;

function show(value: unknown, render: () => void): void {
  if (asJson) out(JSON.stringify(value, null, 2));
  else render();
}

/**
 * Read a password without putting it anywhere it can be read back.
 *
 * **Never an argument.** `deploy/lib.sh` already goes to the trouble of passing
 * `REEMOAT_CP_KEY` into a container by *name* rather than by value so it never
 * appears in `ps`; taking a password on argv would undo that for the one
 * credential a human chose, and put it in shell history besides.
 *
 * Echo is turned off when there is a terminal. When there is not — a pipe, a
 * script — one line is read from stdin, which is what makes this usable from
 * `install.sh` and testable at all.
 */
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
    // Raw mode delivers keystrokes, so the line editor is ours: this is
    // deliberately the smallest one that works — backspace, Enter, Ctrl-C.
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

/**
 * The body for a route that asks you to prove the account is still yours.
 *
 * What is left of `selfProof` after `admin passwd` and `admin key` were deleted.
 * Those took a target id because they could be aimed at somebody else; **no
 * command here can be aimed at somebody else any more** — an admin may take a
 * credential away and may never issue one — so this asks about the caller and
 * takes no argument.
 *
 * `hasPassword` is asked for the reason `case "passwd"` asks it: an account
 * carried over from before passwords existed has none to give, the server lets
 * it past on its API key, and prompting for a secret that does not exist would
 * be a dead end rather than a question.
 */
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

/** One renderer for the read and both writes, so the three cannot drift. */
function printSettings(body: SettingsAnswer, did: string | null): void {
  if (did !== null) out(did);
  for (const row of body.settings) {
    // A secret is reported as set or not, and never shown — the same rule
    // `apiKeyRows` states about a key. `(unset)` rather than an empty string,
    // because an empty string is itself a legal value here.
    const shown = row.secret ? (row.set === true ? "(set)" : "(unset)") : (row.value ?? "(unset)");
    out(`${row.key.padEnd(30)} ${String(shown).padEnd(34)} ${row.source}`);
  }
  out("");
  out(`registration: ${body.registration.enabled ? "open" : "closed"}`);
  out(`mail: ${body.mail.configured ? "configured" : "not configured"}`);
  for (const problem of body.mail.problems) out(`  ${problem}`);
}

async function currentPasswordBody(): Promise<string> {
  const me = await api<{ id: string; hasPassword: boolean }>("/v1/me");
  if (!me.hasPassword) return JSON.stringify({});
  const currentPassword = await readSecret("your current password");
  return JSON.stringify({ currentPassword });
}

/**
 * The three lines a daemon is started with.
 *
 * One printer for both routes that mint a code — the owner's and the admin's —
 * because this is text somebody pastes into a shell on another machine and the
 * code inside it is single-use. Two copies that drift means one of them mints a
 * code that is then spent on a typo, and the error arrives at daemon startup
 * talking about enrollment rather than about a variable name.
 *
 * **Both values are single-quoted, and that is not tidiness.** `controlPlaneUrl`
 * is the server's `installOrigin(c, trustedProxyHops)` — `new URL(c.req.url).origin`
 * with the scheme corrected behind declared proxy hops, i.e. derived from
 * the request's own `Host` header, which any caller writes. Measured 2026-08-08
 * through a real `node:http` server, a `Host` of ``a`id`b``, `a$(id)b`, `a'b` and
 * `a;id` all reach `URL.origin` intact; unquoted, the paste executes it —
 * sourcing ``REEMOAT_CONTROL_PLANE=http://a`touch PWNED`b`` created the file and
 * left the variable reading `http://ab`. It is the rule `deploy/lib.sh`'s `sq`
 * already applies to the env file after the measured
 * `REEMOAT_ENROLL_CODE=xy$(touch PWNED)` incident, applied to the other place
 * the same text lands. The `'\''` arm is reachable rather than defensive: an
 * apostrophe survives `URL.origin`, so without it the quoting can be stepped out
 * of. The replacement holds no `$`, so `replaceAll`'s `$&` expansion cannot fire.
 *
 * `packages/web/src/enrollment.ts` prints the same three lines. `webcheck`
 * asserts *that* copy against a literal and **nothing anywhere compares the
 * two** — this comment used to say it pinned the pair, which it never did.
 */
function enrollmentLines(controlPlaneUrl: string, code: string): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    "export REEMOAT_AUTH=signed",
    `export REEMOAT_CONTROL_PLANE=${quote(controlPlaneUrl || BASE_URL)}`,
    `export REEMOAT_ENROLL_CODE=${quote(code)}`,
  ].join("\n");
}

/** `--limit`/`--offset` as a query string, or empty when neither was given. */
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
  /*
   * `login` is the one command that runs without a credential, because it is
   * where one comes from. Handled above the check for the same reason
   * `POST /v1/login` sits above the route gate.
   */
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
      // Shell-pasteable, like `token`. The same variable an API key goes in —
      // the control plane accepts either, so nothing downstream has to care.
      out(`export REEMOAT_CP_KEY=${body.token}`);
      out(`# expires ${new Date(body.expiresAt ?? 0).toISOString()}`);
    });
    return;
  }

  /*
   * `provision` is the second command that runs without `REEMOAT_CP_KEY`, and
   * for the mirror of `login`'s reason: it carries a credential of its own.
   *
   * Handled above the check because that check is about a *person's* key, and
   * the whole point of the provisioning key is that whoever is installing a host
   * does not need one. `POST /v1/provision` sits above THE LINE for exactly the
   * same reason.
   */
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
        // The one thing this did outside the machine it was asked for.
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
        // `revokedCount`, not `revoked` — the route was renamed away from the
        // boolean its two single-session siblings answer with, and only the
        // browser client followed. `api<T>` casts, so the declared type was a
        // lie the compiler could not catch and the one command whose entire
        // output is the count printed "signed out of undefined session(s)".
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
      // Only asked for when there is one to give: a user carried over from before
      // passwords existed sets a first one with their API key as the proof.
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
    /*
     * Mint yourself a key. **This replaces `admin key <userId>`**, which is gone
     * along with every other way one person issues a credential to another.
     *
     * It is the only way an API key comes into existence outside the bootstrap in
     * `main.ts`, which matters because `~/.reemoat/cpctl.env` holds one and
     * `deploy/install.sh` used to ask an admin to mint it for somebody else.
     */
    case "key": {
      const body = await api<{ apiKey: string }>("/v1/me/keys", {
        method: "POST",
        body: await currentPasswordBody(),
      });
      show(body, () => {
        out(`API key: ${body.apiKey}`);
        out("Shown once — only its hash is stored. It never expires; retire it with: cpctl keys");
      });
      return;
    }
    case "keys": {
      const list = await api<{ keys: { id: string; prefix: string; createdAt: number; revokedAt: number | null }[] }>(
        "/v1/me/keys",
      );
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
          out(`${key.id}  ${key.prefix}…  ${key.revokedAt === null ? "live" : "revoked"}`);
        }
        out("Retire one with: cpctl keys --revoke <id>");
      });
      return;
    }
    /*
     * Your address, which is the only thing that makes `cpctl` able to recover an
     * account at all — a password reset arrives by mail or not at all.
     */
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
              // Reachability outright now, not one of two paths: a machine with
              // no tunnel has no other door.
              `${machine.relayOnline ? "  [online]" : "  [offline]"}  ${machine.scopes.join(",")}`,
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
        // Shell-pasteable, because that is what this is for. The relay is the
        // address now; there is no other one to print.
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
      /*
       * `--ids` prints `<id> <name>`, one per line, and nothing else.
       *
       * For `deploy/install.sh`, which has to put a list of people in front of an
       * operator so a machine can be registered to one of them. `json_field`
       * reads a single scalar and `--json` needs a parser the control-plane host
       * is not required to have — this is the shape `read` and `choose` already
       * consume. Enabled users only: offering a banned one leads to a machine
       * registered to somebody who cannot sign in.
       */
      if (values.ids === true) {
        for (const user of body.users) {
          if (!user.disabled) out(`${user.id} ${user.name}`);
        }
        return;
      }
      show(body, () => {
        for (const user of body.users) {
          // `machines/limit` on every line, so somebody at their limit — or over
          // it, which is what a lowering looks like from here — is visible
          // without asking per user.
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
          // The whole point of the invited arm: no secret exists at any moment,
          // so there is nothing here to print and nothing to hand over.
          out(`invited ${body.email} — they choose their own password from the link.`);
          if (body.mailQueued === false) out("warning: the message could not be queued. Check: cpctl admin mail");
          return;
        }
        out(`password: ${body.password}`);
        out("Shown once — only its hash is stored. They must replace it at first sign-in.");
      });
      return;
    }
    /*
     * Send an invitation again.
     *
     * Here because the state it fixes has no other exit: an invited account holds
     * no password and an unverified address, so it can neither sign in nor use
     * the forgotten-password link, and `adduser` answers 409. An invitation that
     * was never delivered or never opened locked the person out permanently.
     * Issues nothing to the caller — the link goes to their address, exactly as
     * it did at creation.
     */
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
    /**
     * Raise or lower one person's machine limit.
     *
     * Three forms rather than a flag: `<n>` sets, `default` clears, and no
     * argument reads. `default` is a literal and deliberately **not** `--clear`
     * — that global option is a *string* carrying a setting key
     * (`admin settings --clear smtp.host`), and overloading it to also be a
     * boolean here is how one option comes to mean two things.
     *
     * The read form goes through `GET /v1/admin/users`, which already carries
     * the number, rather than a route of its own: a second route answering a
     * question the first already answers is a second thing to keep in agreement.
     */
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
      /*
       * A boolean, because nothing anywhere prints this key or any part of it —
       * not the value, not the prefix, not an id. "There is one" is the whole of
       * what an admin can act on, since the only act is minting another.
       */
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
        // Refused here as well as on the route, because `Number.parseInt("five")`
        // is NaN and a NaN in a JSON body arrives as `null` — which the route
        // would then report as a missing field, about one this command did fill
        // in.
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
        // The lasting side effect, printed for `deluser`'s reason: it is the one
        // thing that happens outside the row this wrote, and the operator is the
        // person who repeats it to somebody.
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
        /*
         * The one lasting effect outside their own rows, and the reason it is
         * printed rather than left to be discovered: those daemons stop being
         * reachable, and getting one back means registering and enrolling it
         * again on its host.
         *
         * They used to be left ownerless and still enrolled, which put them
         * outside the machine limit and outside the ban check — both being facts
         * about the owner — so deleting a person was the one act that made a
         * live machine no rule applied to.
         */
        if (body.machinesRevoked > 0) {
          out(`${body.machinesRevoked} machine(s) they registered were revoked and are off the network.`);
          out("Getting one back means enrolling it again on that host.");
        }
        // Beside it for the same reason, and this is the *stronger* of the two
        // acts that burn codes — `admin disable` says it and this one did not,
        // which is the wrong way round. A code that was still live is a machine
        // identity somebody could have been about to redeem.
        const codes = body.enrollmentCodesInvalidated ?? 0;
        if (codes > 0) {
          out(`${codes} unredeemed enrollment code(s) they minted were invalidated.`);
        }
      });
      return;
    }
    /**
     * Registration and SMTP, with **where each value came from**.
     *
     * The source is printed beside every value because a row in
     * `instance_settings` beats the environment: without it an operator reads
     * their env file, reads this, and cannot tell which one is live.
     */
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
        /*
         * A secret setting is read, never taken.
         *
         * Everything else around this value goes to real trouble to keep it
         * write-only — the read route returns `value: null` and omits
         * `envValue`, the admin screen renders a field that never claims to
         * know it — and this command was the hole: `smtp.password` is an
         * ordinary member of `SETTING_KEYS`, so it arrived as a positional and
         * went into `ps` for every process on the host, and into shell
         * history, on the machine that also holds the fleet's signing key.
         *
         * Asked of `SECRET_SETTING_KEYS` and never of the key's spelling, for
         * the reason that set exists at all. `isSettingKey` first because the
         * set is typed on `SettingKey`, and because an unknown key must keep
         * falling through to the server's own `unknown_setting` naming it
         * rather than being answered here.
         */
        const secret = isSettingKey(key) && SECRET_SETTING_KEYS.has(key);
        if (secret && value !== undefined) {
          // Naming the remedy, not just the refusal: an admin told only "no"
          // puts it straight back on the command line with a shrug.
          fail(
            `${key} is a secret and is never taken as an argument — it would be in \`ps\` for ` +
              `every process on this host, and in your shell history.\n` +
              `   type it in:     cpctl admin settings ${key}\n` +
              `   from a script:  cpctl admin settings ${key} < secret-file\n` +
              `   remove it:      cpctl admin settings --clear ${key}`,
          );
        }
        // The same reader `login` and the password change use: echo off at a
        // terminal, one line from stdin when there is not one.
        const written = secret ? await readSecret(`value for ${key}`) : value;
        if (written === undefined) fail(`usage: cpctl admin settings ${key} <value>   (or --clear ${key})`);
        // An empty line is how an empty file and a stray Enter both arrive, and
        // storing "" would leave a row that wins over the environment while
        // `mailConfigured` still reports the password as not set. Unsetting has
        // its own verb, so point at it rather than guessing which was meant.
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
          // The server's own words, which is the whole reason this list exists.
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
      // Queued rather than sent: the route does not hold a socket open for up to
      // ninety seconds against an admin-supplied host on the process that carries
      // every relay tunnel. The result lands in the log within a second.
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
        // Printed for the same reason `deluser` prints `machinesReleased`: a code
        // that was still live is a machine identity somebody could have been
        // about to redeem, and `enable` does not give it back.
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
          /** Optional so an older control plane reads as "never recorded". */
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
            /*
             * A machine nobody owns is **unlimited**, because there is no owner
             * to have a limit — every row registered before ownership existed,
             * every one created here with no `--owner`, and every one a deleted
             * user left behind. Printed so that gap is a list an admin can read
             * and adopt out of rather than an unseen hole.
             */
            machine.owner === null ? "no owner" : null,
            /*
             * **Only when it is offline**, which is the only time it answers a
             * question. `offline` on its own was the same word for a lid that
             * closed a minute ago and a host that died last week, and the second
             * is the one somebody is looking for. Optional on the wire, so an
             * older control plane prints the flag list it always did.
             */
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
        // `relayId` optional so an older control plane, which does not send it,
        // prints `?` rather than `undefined`.
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
        /*
         * Said **before** the list rather than after it, because it is the
         * reason to read the list at all: a relay id with no entry in the
         * routing map sends its machines to the shared name, which keeps
         * working and is therefore invisible in every other way.
         */
        for (const id of body.unmapped ?? []) {
          out(
            `warning: relay "${id}" holds tunnels and is not in REEMOAT_CP_RELAY_URLS —\n` +
              "  those machines fall back to the shared relay name, which reaches them\n" +
              "  only when they happen to be on the relay it points at.",
          );
        }
        for (const tunnel of body.tunnels) {
          const age = Math.round((Date.now() - tunnel.since) / 1000);
          /*
           * The relay id is printed because it is the only shipped way to see
           * whether `REEMOAT_CP_RELAY_URLS` is right: a wrong entry degrades to
           * the shared name and keeps working, one request in N slowly, with no
           * error and no log. In external mode this list merges every relay's
           * rows, so without the name they are indistinguishable.
           */
          out(
            `${tunnel.machineId.padEnd(14)} ${(tunnel.relayId ?? "?").padEnd(10)} up ${String(age).padStart(6)}s  ` +
              `${tunnel.activeStreams} active  ${tunnel.requestsProxied} proxied`,
          );
        }
      });
      return;
    }
    /*
     * What every machine is running, connected or not.
     *
     * The question a staged rollout is planned from, and the reason the tunnel
     * handshake carries a version at all. `admin relay` above answers "what is
     * up right now"; this answers "what is out there", which is a different set
     * and a strictly larger one — the machine that decides whether a protocol
     * floor can be raised is the one that has been dark for a month.
     *
     * The summary is printed before the list for `admin relay`'s reason: it is
     * why you would read the list.
     */
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
        /*
         * Named rather than counted, because this is the set somebody has to go
         * and touch. `unknown` is a machine that has not dialled since daemons
         * began reporting — which is either very old or simply off, and both are
         * the same job: visit it.
         */
        const stale = body.machines.filter(
          (machine) => !machine.revoked && (machine.protocol === null || machine.protocol < body.relay.protocol),
        );
        if (stale.length > 0) {
          out("");
          out("behind the relay, and what raising the floor would cut off:");
          for (const machine of stale) {
            const seen = machine.seenAt === null ? "never seen" : `${Math.round((Date.now() - machine.seenAt) / 86400000)}d ago`;
            out(
              `  ${machine.name.padEnd(20)} ${(machine.version ?? "unknown").padEnd(12)} ` +
                `protocol ${machine.protocol === null ? "?" : `v${machine.protocol}`}  ${seen}`,
            );
          }
        }
      });
      return;
    }
    /*
     * The fleet's signing keys.
     *
     * `schema.sql` has described an overlapping rotation since the table existed
     * and nothing could perform one: two readers of `retired_at`, no writer, on
     * the key that mints every token in the fleet. The remedy for a leaked
     * database was hand-editing SQLite inside a read-only container.
     *
     * Three verbs because rotating is genuinely three acts spread over as long
     * as it takes every daemon to re-enroll — mint, watch, retire — and collapsing
     * them into one would be the one arrangement that cannot work: a daemon
     * captures the key set once at enrollment and never asks again, so retiring
     * the old key before they have all been back takes the fleet off the network.
     */
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
      /*
       * **`--owner` is required now, and the whole block that used to explain
       * how to live without it is gone with the arm behind it.**
       *
       * That block printed "no owner: this machine belongs to nobody" and then
       * three ways to cope. The route refuses it outright instead: a machine
       * with no owner is outside the machine limit and outside the ban check —
       * both being facts about the owner — so forgetting one flag produced a
       * live machine no rule applied to. Refused here as well as on the route so
       * the message names the flag rather than the field.
       */
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
    /*
     * Rename only. This used to carry `--url` and `--no-url` as well, which
     * between them were the whole routing policy for a machine — with an address
     * it was probed directly first, without one it was relay-only. There is one
     * route into a machine now, so there is nothing here to choose.
     */
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
        // Said out loud, because a table that quietly stops short reads as the
        // whole set. Grants are users × machines and this is the list that grows.
        if (body.offset + body.grants.length < body.total) {
          out(`\nshowing ${body.offset + 1}-${body.offset + body.grants.length} of ${body.total}`);
          out(`more: cpctl admin grants --offset ${body.offset + body.grants.length}`);
        }
      });
      return;
    }
    case "grant": {
      const [userId, machineId] = rest;
      if (!userId || !machineId) fail("usage: cpctl admin grant <userId> <machineId> [--scopes a,b]");
      const scopes = (values.scopes ?? "session:read,session:write")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const body = await api<unknown>("/v1/admin/grants", {
        method: "PUT",
        body: JSON.stringify({ userId, machineId, scopes }),
      });
      show(body, () => out(`granted ${userId} -> ${machineId}  ${scopes.join(",")}`));
      return;
    }
    case "ungrant": {
      const [userId, machineId] = rest;
      if (!userId || !machineId) fail("usage: cpctl admin ungrant <userId> <machineId>");
      const body = await api<{ outstandingTokensExpireWithinSeconds: number }>(
        `/v1/admin/grants?userId=${encodeURIComponent(userId)}&machineId=${encodeURIComponent(machineId)}`,
        { method: "DELETE" },
      );
      show(body, () =>
        out(`revoked. Tokens already issued keep working for up to ${body.outstandingTokensExpireWithinSeconds}s.`),
      );
      return;
    }
    default:
      fail(`unknown admin command "${action ?? ""}"`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof ApiError) fail(error.message);
  fail(describe(error));
});
