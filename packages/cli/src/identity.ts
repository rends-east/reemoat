import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generateStaticKey, localStaticKey, publicFromSecret, readMachineKey, type StaticKey } from "@reemoat/protocol";
import { ReemoatError } from "./errors.js";

// A script's device key is a file, where the app's is in the OS keyring: one per server and account, as the app's is,
// since one key on two accounts' rows links them (Q1.651). Never under REEMOAT_HOME, which is a daemon's state root.

export interface DeviceKey {
  readonly staticKey: StaticKey;
  /** base64url, 43 characters: what the Authority binds and the machine's list shows. */
  readonly publicKey: string;
  /** base64url: what `reemoat device export` prints for a CI secret, and nothing else reads. */
  readonly secret: string;
}

export function clientHome(env: NodeJS.ProcessEnv = process.env): string {
  const own = env["REEMOAT_CLIENT_HOME"];
  if (own !== undefined && own.length > 0) return own;
  if (process.platform === "win32" && env["APPDATA"]) return join(env["APPDATA"], "reemoat");
  const config = env["XDG_CONFIG_HOME"];
  return join(config !== undefined && config.length > 0 ? config : join(homedir(), ".config"), "reemoat");
}

/** A directory name for a server: its host and port, nothing a path could be steered by. */
export function serverSlug(origin: string): string {
  const url = new URL(origin);
  return `${url.hostname}${url.port.length > 0 ? `_${url.port}` : ""}`.replace(/[^A-Za-z0-9.-]/g, "_");
}

export function deviceKeyFrom(secret: string): DeviceKey {
  const secretKey = new Uint8Array(Buffer.from(secret.trim(), "base64url"));
  if (secretKey.length !== 32) {
    throw new ReemoatError("client", 0, "bad_device_key", "REEMOAT_DEVICE_KEY is 32 bytes of unpadded base64url, as `reemoat device export` prints it");
  }
  return {
    staticKey: localStaticKey(secretKey),
    publicKey: Buffer.from(publicFromSecret(secretKey)).toString("base64url"),
    secret: Buffer.from(secretKey).toString("base64url"),
  };
}

/** The key this installation dials with, made on first use. Two first runs at once agree: the file is linked into place, never overwritten. */
export function loadDeviceKey(home: string, origin: string, userId: string): DeviceKey {
  const dir = join(home, serverSlug(origin), userId.replace(/[^A-Za-z0-9_-]/g, "_"));
  const file = join(dir, "device.json");
  const held = readKeyFile(file);
  if (held !== null) return held;
  privateDir(dir);
  const fresh = generateStaticKey();
  const temporary = join(dir, `.device.${process.pid}.${Date.now()}.json`);
  const content = JSON.stringify({
    secretKey: Buffer.from(fresh.secretKey).toString("base64url"),
    publicKey: Buffer.from(fresh.publicKey).toString("base64url"),
    createdAt: Date.now(),
  });
  writeFileSync(temporary, `${content}\n`, { mode: 0o600 });
  // mode is narrowed by the umask, never widened past it; set again so the file is 0600 whatever the umask said.
  chmodSync(temporary, 0o600);
  try {
    linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temporary);
  }
  const written = readKeyFile(file);
  if (written === null) throw new ReemoatError("client", 0, "device_key_unreadable", `${file} could not be read back`);
  return written;
}

function readKeyFile(file: string): DeviceKey | null {
  let text: string;
  try {
    if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
      throw new ReemoatError("client", 0, "device_key_exposed", `${file} can be read by other users`, null, `chmod 600 ${file}`);
    }
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof ReemoatError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let secret: unknown;
  try {
    secret = (JSON.parse(text) as { secretKey?: unknown }).secretKey;
  } catch {
    secret = undefined;
  }
  if (typeof secret !== "string") throw new ReemoatError("client", 0, "device_key_unreadable", `${file} holds no device key`, null, "move it aside and run again for a new one");
  return deviceKeyFrom(secret);
}

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
}

/** The key each machine was first reached with (Q1.657), per server, as the app keeps them. */
export class PinFile {
  private readonly file: string;
  private readonly dir: string;

  constructor(home: string, origin: string) {
    this.dir = join(home, serverSlug(origin));
    this.file = join(this.dir, "pins.json");
  }

  get(machineId: string): string | null {
    return readMachineKey(this.read()[machineId]);
  }

  set(machineId: string, key: string): void {
    privateDir(this.dir);
    // Read again just before writing: another process may have pinned another machine since.
    const next = { ...this.read(), [machineId]: key };
    const temporary = `${this.file}.${process.pid}.${Date.now()}`;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  private read(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      // Absent or hand-edited: nothing held, so each machine is a first use again.
      return {};
    }
  }
}
