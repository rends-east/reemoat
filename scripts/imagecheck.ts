#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

/**
 * Builds and starts the control plane's image, so unlike the other drivers it needs docker and a network and runs as its own CI job.
 * It is what catches an import missing from .dockerignore or the Dockerfile's COPY lines, which every offline driver misses.
 */

const root = new URL("../", import.meta.url).pathname;
const IMAGE = "reemoat/imagecheck:test";
const PROJECT = "reemoat-imagecheck";
const VOLUME = `${PROJECT}-state`;
const PORT = 17988;
const RELAY_PORT = 17989;

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}\n`);
}

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    process.stdout.write(`  ok    ${name}\n`);
    return;
  }
  failures += 1;
  process.stdout.write(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}\n`);
}

function docker(args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (opts.allowFail) {
      const e = error as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    throw error;
  }
}

/** A one-shot run; docker run propagates the container's exit code, which is what makes the exit-2 contract testable. */
function runOnce(env: Record<string, string>): { code: number; out: string } {
  const args = ["run", "--rm"];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(IMAGE);
  try {
    const out = execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Includes stderr, where every diagnostic main.ts prints goes. */
function dockerLogs(name: string): string {
  try {
    const out = execFileSync("docker", ["logs", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return out;
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

function cleanup(): void {
  docker(["rm", "-f", `${PROJECT}-cp`], { allowFail: true });
  docker(["rm", "-f", `${PROJECT}-relay`], { allowFail: true });
  docker(["volume", "rm", "-f", VOLUME], { allowFail: true });
}

async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; type: string; cache: string }> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers, signal: AbortSignal.timeout(5000) });
  return {
    status: res.status,
    body: await res.text(),
    type: res.headers.get("content-type") ?? "",
    cache: res.headers.get("cache-control") ?? "",
  };
}

async function waitHealthy(): Promise<boolean> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await get("/health");
      if (r.status === 200) return true;
    } catch {
      // Not up yet. The loop is the wait.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

process.stdout.write("\nimagecheck\n\n");

process.stdout.write("  building (this is the slow part)\n");
try {
  // --load is required: under CI's docker-container buildx driver the image otherwise stays in the build cache.
  execFileSync("docker", ["build", "--load", "-f", "deploy/docker/Dockerfile", "-t", IMAGE, "."], {
    cwd: root,
    stdio: ["ignore", "ignore", "pipe"],
  });
  check("image builds", true, true);
} catch (error) {
  const e = error as { stderr?: Buffer | string };
  failures += 1;
  process.stdout.write(`  FAIL  image builds\n${String(e.stderr ?? "").split("\n").slice(-25).join("\n")}\n`);
  process.stdout.write(`\n${failures} FAILED\n\n`);
  process.exit(1);
}

// deploy.sh recreates the control plane by comparing cp_image_fingerprint, so a cached rebuild must compare equal; the format is read from lib.sh.
{
  const libSource = readFileSync(join(root, "deploy/lib.sh"), "utf8");
  const format = /--format '(\{\{json \.RootFS\}\}[^']*)'/.exec(libSource)?.[1];
  ok("lib.sh still builds the fingerprint out of a --format string", format !== undefined, String(format));

  if (format !== undefined) {
    const fingerprint = (): string => docker(["image", "inspect", "--format", format, IMAGE]).trim();
    const before = fingerprint();
    execFileSync("docker", ["build", "--load", "-f", "deploy/docker/Dockerfile", "-t", IMAGE, "."], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const after = fingerprint();
    ok("a fully-cached rebuild leaves the image compared equal", before === after, `${before.length} vs ${after.length} chars`);
    ok("and the fingerprint is not empty, so the comparison means something", before.length > 0, `${before.length} chars`);
  }
}

const findSecrets = docker([
  "run", "--rm", "--entrypoint", "sh", IMAGE,
  "-c", "find / -xdev \\( -name '.env' -o -name '*.db' -o -name '.git' \\) -not -path '*/node_modules/*' 2>/dev/null | head -20",
]).trim();
check("no .env, *.db or .git anywhere in the image", findSecrets, "");

const store = docker(["run", "--rm", "--entrypoint", "sh", IMAGE, "-c", "ls /app/node_modules/.pnpm"]).trim().split("\n");
// Guards against the daemon's dependencies riding back in: bare names anchored on @ so diff misses diff-sequences, opencode as a family (Q4.114).
const daemonOnly = store.filter((k) =>
  /^(@agentclientprotocol|@anthropic-ai|@modelcontextprotocol|@openai)|^(zod|zod-to-json-schema|diff|open|vscode-jsonrpc)@|^opencode(-[a-z0-9-]+)?@/.test(
    k,
  ),
);
check("the daemon's dependency closure is not in the image", daemonOnly, []);
ok("the control plane's own dependencies are", store.some((k) => k.startsWith("hono@")) && store.some((k) => k.startsWith("tsx@")) && store.some((k) => k.startsWith("ws@")), `store: ${store.join(" ")}`);

const uid = docker(["run", "--rm", "--entrypoint", "id", IMAGE, "-u"]).trim();
ok("runs as a non-root user", uid !== "0", `uid=${uid}`);

const dbEnv = docker(["run", "--rm", "--entrypoint", "sh", IMAGE, "-c", "printf %s \"$REEMOAT_CP_DB\""]).trim();
ok("REEMOAT_CP_DB is set explicitly, not left to homedir()", dbEnv.startsWith("/"), `got ${JSON.stringify(dbEnv)}`);

const bind = docker(["run", "--rm", "--entrypoint", "sh", IMAGE, "-c", "printf '%s %s' \"$REEMOAT_CP_HOST\" \"$REEMOAT_CP_RELAY_HOST\""]).trim();
check("both listeners bind wide inside the container", bind, "0.0.0.0 0.0.0.0");

const issuer = docker(["run", "--rm", "--entrypoint", "sh", IMAGE, "-c", "printf %s \"${REEMOAT_CP_ISSUER-unset}\""]).trim();
check("REEMOAT_CP_ISSUER is left unset (daemons check iss against enrollment)", issuer, "unset");

const noRelay = runOnce({});
check("exits 2 with no REEMOAT_CP_RELAY_URL", noRelay.code, 2);
ok("and says which variable", noRelay.out.includes("REEMOAT_CP_RELAY_URL is required"), noRelay.out.slice(0, 200));

const samePort = runOnce({
  REEMOAT_CP_RELAY_URL: "http://relay.example",
  REEMOAT_CP_PORT: "7888",
  REEMOAT_CP_RELAY_PORT: "7888",
});
check("exits 2 when the API and relay ports are equal", samePort.code, 2);

// Under external mode equal port numbers are the ordinary case, so this run must get past the port check to a later refusal.
const externalSamePort = runOnce({
  REEMOAT_CP_RELAY_URL: "http://relay.example",
  REEMOAT_CP_RELAY_MODE: "external",
  REEMOAT_CP_PORT: "7888",
  REEMOAT_CP_RELAY_PORT: "7888",
  REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD: "short",
});
ok(
  "but equal ports are fine when another container holds the relay",
  !externalSamePort.out.includes("must differ from REEMOAT_CP_PORT"),
  externalSamePort.out.slice(0, 300),
);

const badMode = runOnce({ REEMOAT_CP_RELAY_URL: "http://relay.example", REEMOAT_CP_RELAY_MODE: "off" });
check("exits 2 on a relay mode that is neither", badMode.code, 2);
ok(
  "and names both, because 'off' is the one somebody will try",
  badMode.out.includes("embedded") && badMode.out.includes("external"),
  badMode.out.slice(0, 300),
);

const badTtl = runOnce({ REEMOAT_CP_RELAY_URL: "http://relay.example", REEMOAT_CP_TOKEN_TTL_SECONDS: "10" });
check("exits 2 below the token TTL floor", badTtl.code, 2);

const shortPassword = runOnce({
  REEMOAT_CP_RELAY_URL: "http://relay.example",
  REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD: "short",
});
check("exits 2 on a supplied bootstrap password that fails the policy", shortPassword.code, 2);
ok(
  "and names the variable to change rather than the rule alone",
  shortPassword.out.includes("REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD"),
  shortPassword.out.slice(0, 200),
);

cleanup();
docker(["volume", "create", VOLUME]);
docker([
  "run", "-d", "--name", `${PROJECT}-cp`,
  "-v", `${VOLUME}:/var/lib/reemoat`,
  "-e", `REEMOAT_CP_RELAY_URL=http://127.0.0.1:${RELAY_PORT}`,
  "-e", `REEMOAT_CP_PORT=${PORT}`,
  "-e", `REEMOAT_CP_RELAY_PORT=${RELAY_PORT}`,
  "-p", `127.0.0.1:${PORT}:${PORT}`,
  "-p", `127.0.0.1:${RELAY_PORT}:${RELAY_PORT}`,
  IMAGE,
]);

const healthy = await waitHealthy();
ok("answers /health on the published port, from outside the container", healthy);

if (!healthy) {
  process.stdout.write(dockerLogs(`${PROJECT}-cp`));
  cleanup();
  process.stdout.write(`\n${failures + 1} FAILED\n\n`);
  process.exit(1);
}

const logs1 = dockerLogs(`${PROJECT}-cp`);
const keys1 = logs1.split("\n").filter((l) => l.includes("API key: "));
check("the admin key is printed exactly once", keys1.length, 1);

const adminKey = keys1[0]?.trim().split(/\s+/).pop() ?? "";
const me = await fetch(`http://127.0.0.1:${PORT}/v1/me`, {
  headers: { authorization: `Bearer ${adminKey}` },
  signal: AbortSignal.timeout(5000),
});
check("that key authenticates", me.status, 200);

// install.sh scrapes the key and password lines with two anchored patterns, so neither line may carry the other's marker.
const passwords1 = logs1.split("\n").filter((l) => /^\s*admin password: /.test(l));
check("the admin password is printed exactly once", passwords1.length, 1);
check("and cannot be mistaken for the key line", passwords1[0]?.includes("API key: ") ?? true, false);

const adminPassword = passwords1[0]?.trim().split(/\s+/).pop() ?? "";
const signedIn = await fetch(`http://127.0.0.1:${PORT}/v1/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "admin", password: adminPassword }),
  signal: AbortSignal.timeout(10_000),
});
check("that password signs in", signedIn.status, 200);
const sessionToken = ((await signedIn.json()) as { token?: string }).token ?? "";
const asSession = await fetch(`http://127.0.0.1:${PORT}/v1/me`, {
  headers: { authorization: `Bearer ${sessionToken}` },
  signal: AbortSignal.timeout(5000),
});
check("and the session it returns authenticates", asSession.status, 200);

const pool = docker(["exec", `${PROJECT}-cp`, "printenv", "UV_THREADPOOL_SIZE"]).trim();
check("the image sets a threadpool larger than libuv's default", pool, "64");

const jwks1 = JSON.parse((await get("/v1/jwks")).body) as { keys: { kid: string }[] };
const kid1 = jwks1.keys[0]?.kid ?? "";
ok("a signing key exists", kid1.startsWith("k_"), kid1);

// The gate is in the image because mailed links land on it; the app is not in the image at all.
const register = await get("/register");
ok(
  "/register serves the gate",
  register.status === 200 && register.body.includes("<!doctype html"),
  `status ${register.status}`,
);
const handoff = await get("/app");
ok("and /app is the handoff", handoff.status === 200 && handoff.body.includes("<!doctype html"), `status ${handoff.status}`);
const terms = await get("/terms");
ok("and the legal documents are readable with no credential", terms.status === 200, `status ${terms.status}`);

const index = await get("/");
ok(
  "/ answers the error envelope rather than a page",
  index.status === 404 && index.body.includes('"not_found"'),
  `status ${index.status}`,
);
const deep = await get("/m/m_x/s/s_y");
ok("as does a deep link the app would own", deep.status === 404 && deep.body === index.body, `status ${deep.status}`);
const bundles = docker([
  "exec",
  `${PROJECT}-cp`,
  "sh",
  "-c",
  "test -e /app/packages/web/dist && echo app || echo no-app; test -e /app/packages/web/dist-gate && echo gate || echo no-gate",
]).trim();
check("the image carries the gate and not the app", bundles.split("\n").map((line) => line.trim()), ["no-app", "gate"]);

// bootstrap.sh reaches the image through both .dockerignore and a runtime COPY, and only a real container notices a missing COPY.
const installer = await get("/install.sh");
ok(
  "GET /install.sh serves the bootstrap script",
  installer.status === 200 && installer.body.startsWith("#!/bin/sh"),
  `status ${installer.status}`,
);
check("as text a browser will show rather than download", installer.type.startsWith("text/plain"), true);
// The body varies by Host, so a path-keyed shared cache would hand one instance's address to another's users.
check("and is not stored by anything in front of it", installer.cache, "no-store");
check("the placeholder is gone", installer.body.includes("@REEMOAT_CONTROL_PLANE@"), false);
check(
  "and this instance's own address is in it, quoted",
  installer.body.includes(`CONTROL_PLANE_DEFAULT='http://127.0.0.1:${PORT}'`),
  true,
);
// The substituted origin comes from the Host header, so unquoted this route is code execution in a piped script.
// Over a raw socket because fetch silently replaces a caller-set Host header.
const rawHost = async (host: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(PORT, "127.0.0.1");
    let body = "";
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("timed out"));
    });
    socket.on("connect", () => {
      socket.write(`GET /install.sh HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => (body += chunk.toString()));
    socket.on("error", reject);
    socket.on("close", () => resolve(body));
  });

const hostile = await rawHost("a`id`b");
check(
  "a hostile Host arrives as data, not as source",
  hostile.includes("CONTROL_PLANE_DEFAULT='http://a`id`b'"),
  true,
);
// An apostrophe is the arm that could close the quoting and step out of it.
const apostrophe = await rawHost("a'b");
check(
  "and an apostrophe is closed, escaped and reopened",
  apostrophe.includes("CONTROL_PLANE_DEFAULT='http://a'\\''b'"),
  true,
);
check(
  "and exactly once",
  hostile.split("CONTROL_PLANE_DEFAULT=").length - 1,
  1,
);
const spoofed = await get("/install.sh", { "x-forwarded-proto": "https" });
check(
  "an untrusted x-forwarded-proto is ignored",
  spoofed.body.includes(`CONTROL_PLANE_DEFAULT='http://127.0.0.1:${PORT}'`),
  true,
);

const api401 = await get("/v1/nope");
ok(
  "an unknown /v1 path is refused, not answered with the SPA",
  api401.status === 401 && !api401.body.includes("<!doctype html"),
  `${api401.status} ${api401.body.slice(0, 80)}`,
);
const api404 = await get("/v1/nope", { authorization: `Bearer ${adminKey}` });
ok(
  "and is a JSON 404 to somebody holding a credential",
  api404.status === 404 && api404.body.includes("not_found"),
  api404.body.slice(0, 120),
);

const stopStart = Date.now();
docker(["stop", `${PROJECT}-cp`]);
const stopMs = Date.now() - stopStart;
const exitCode = docker(["inspect", "-f", "{{.State.ExitCode}}", `${PROJECT}-cp`]).trim();
check("SIGTERM is handled: a clean exit 0", exitCode, "0");
// Prompt only because main.ts is PID 1; tsx as the entry point would put a signal-forwarding wrapper in front of it.
ok("and promptly, so nothing waited for SIGKILL", stopMs < 8000, `${stopMs}ms`);

docker(["start", `${PROJECT}-cp`]);
const healthy2 = await waitHealthy();
ok("comes back after a restart", healthy2);

if (healthy2) {
  const logs2 = dockerLogs(`${PROJECT}-cp`);
  const keys2 = logs2.split("\n").filter((l) => l.includes("API key: "));
  check("no second admin key on a start against an existing database", keys2.length, 1);
  // The log accumulates, so still exactly one proves the second start minted nothing.
  const passwords2 = logs2.split("\n").filter((l) => /^\s*admin password: /.test(l));
  check("and no second password either", passwords2.length, 1);
  check("no password nag when the admin already has one", logs2.includes("no user has a password yet"), false);

  const jwks2 = JSON.parse((await get("/v1/jwks")).body) as { keys: { kid: string }[] };
  check("the signing key survived the restart", jwks2.keys[0]?.kid, kid1);

  const me2 = await fetch(`http://127.0.0.1:${PORT}/v1/me`, {
    headers: { authorization: `Bearer ${adminKey}` },
    signal: AbortSignal.timeout(5000),
  });
  check("and the first key still authenticates", me2.status, 200);
}

docker(["rm", "-f", `${PROJECT}-cp`], { allowFail: true });
docker(["volume", "rm", "-f", VOLUME], { allowFail: true });
docker(["volume", "create", VOLUME]);
docker([
  "run", "-d", "--name", `${PROJECT}-cp`,
  "-v", `${VOLUME}:/var/lib/reemoat`,
  "-e", `REEMOAT_CP_RELAY_URL=http://127.0.0.1:${RELAY_PORT}`,
  "-e", `REEMOAT_CP_PORT=${PORT}`,
  "-e", `REEMOAT_CP_RELAY_PORT=${RELAY_PORT}`,
  "-p", `127.0.0.1:${PORT}:${PORT}`,
  IMAGE,
]);
// Asserted before it is branched on, so a container that never came up cannot skip this section green.
const healthy3 = await waitHealthy();
ok("comes up on a volume that was just deleted", healthy3);

if (healthy3) {
  const jwks3 = JSON.parse((await get("/v1/jwks")).body) as { keys: { kid: string }[] };
  ok("deleting the volume mints a new signing key (i.e. un-enrolls the fleet)", jwks3.keys[0]?.kid !== kid1, `${jwks3.keys[0]?.kid} vs ${kid1}`);
}

const SUPPLIED_PASSWORD = "imagecheck-supplied-password";

docker(["rm", "-f", `${PROJECT}-cp`], { allowFail: true });
docker(["volume", "rm", "-f", VOLUME], { allowFail: true });
docker(["volume", "create", VOLUME]);
docker([
  "run", "-d", "--name", `${PROJECT}-cp`,
  "-v", `${VOLUME}:/var/lib/reemoat`,
  "-e", `REEMOAT_CP_RELAY_URL=http://127.0.0.1:${RELAY_PORT}`,
  "-e", `REEMOAT_CP_PORT=${PORT}`,
  "-e", `REEMOAT_CP_RELAY_PORT=${RELAY_PORT}`,
  "-e", `REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD=${SUPPLIED_PASSWORD}`,
  "-p", `127.0.0.1:${PORT}:${PORT}`,
  IMAGE,
]);

const healthySupplied = await waitHealthy();
ok("starts against a bootstrap password taken from the environment", healthySupplied);

if (healthySupplied) {
  const logsSupplied = dockerLogs(`${PROJECT}-cp`);

  // The installer's scrape pattern, restated: a generated password is one field with no spaces.
  const scrapeable = logsSupplied.split("\n").filter((l) => /^ *admin password: [^ ]+$/.test(l));
  check("nothing scrapeable is printed when the password came from the environment", scrapeable, []);
  ok("and the supplied password appears nowhere in the log at all", !logsSupplied.includes(SUPPLIED_PASSWORD));

  // The installer polls until it sees one of these two lines, so silence would stall it for its whole bound.
  const source = logsSupplied.split("\n").filter((l) => /^ *admin password source: /.test(l));
  check("the source marker is printed exactly once instead", source.length, 1);

  const keysSupplied = logsSupplied.split("\n").filter((l) => l.includes("API key: "));
  check("the admin key is still printed exactly once on this arm", keysSupplied.length, 1);

  const suppliedSignIn = await fetch(`http://127.0.0.1:${PORT}/v1/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "admin", password: SUPPLIED_PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  });
  check("and the password nobody printed is the one that signs in", suppliedSignIn.status, 200);
}

// Two containers from one image: catches a COPY missing only from the relay's import closure.
{
  cleanup();
  docker(["volume", "create", VOLUME]);
  const env = [
    "-e", `REEMOAT_CP_RELAY_URL=http://127.0.0.1:${RELAY_PORT}`,
    "-e", `REEMOAT_CP_PORT=${PORT}`,
    "-e", `REEMOAT_CP_RELAY_PORT=${RELAY_PORT}`,
    // One declared hop, as the deployed stack sets, so x-forwarded-proto is believed.
    "-e", "REEMOAT_CP_TRUSTED_PROXY_HOPS=1",
  ];
  docker([
    "run", "-d", "--name", `${PROJECT}-cp`,
    "-v", `${VOLUME}:/var/lib/reemoat`,
    ...env,
    "-e", "REEMOAT_CP_RELAY_MODE=external",
    "-p", `127.0.0.1:${PORT}:${PORT}`,
    IMAGE,
  ]);
  // No start ordering on purpose: the relay authorizes from live rows and never asks the API.
  docker([
    "run", "-d", "--name", `${PROJECT}-relay`,
    "-v", `${VOLUME}:/var/lib/reemoat`,
    ...env,
    "-p", `127.0.0.1:${RELAY_PORT}:${RELAY_PORT}`,
    "--entrypoint", "node",
    IMAGE,
    "--enable-source-maps", "--import", "tsx", "src/relay/main.ts",
  ]);

  const apiUp = await waitHealthy();
  ok("the API comes up with the relay in another container", apiUp);

  let relayUp = false;
  for (let i = 0; i < 60 && !relayUp; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/__relay/health`, { signal: AbortSignal.timeout(5000) });
      relayUp = r.status === 200;
    } catch {
      // Not up yet. The loop is the wait.
    }
    if (!relayUp) await new Promise((r) => setTimeout(r, 1000));
  }
  ok("and the relay runs from the same image, on its own entry point", relayUp, dockerLogs(`${PROJECT}-relay`).slice(-1500));

  // Production serves plain HTTP behind a TLS proxy and bootstrap.sh follows no redirect, so the https default must come from x-forwarded-proto.
  const proxied = await get("/install.sh", { "x-forwarded-proto": "https" });
  check(
    "a declared proxy's x-forwarded-proto reaches the installer's default",
    proxied.body.includes("CONTROL_PLANE_DEFAULT='https://"),
    true,
  );

  if (apiUp && relayUp) {
    const relayLogs = dockerLogs(`${PROJECT}-relay`);
    ok("saying it is a relay rather than a control plane", relayLogs.includes("Reemoat relay listening on"), relayLogs.slice(-500));
    // The relay must never mint a signing key: ensureSigningKey is the API's alone.
    ok("and never printing a signing key of its own", !relayLogs.includes("signing key:"), relayLogs.slice(-500));

    const logs = dockerLogs(`${PROJECT}-cp`);
    ok("while the API says its tunnels are somebody else's", logs.includes("(external —"), logs.slice(-500));

    const key = logs.split("\n").filter((l) => l.includes("API key: "))[0]?.trim().split(/\s+/).pop() ?? "";
    const admin = await get("/v1/admin/relay", { authorization: `Bearer ${key}` });
    check("and the relay view still answers, from the table this time", admin.status, 200);
    const view = JSON.parse(admin.body) as { enabled: boolean; tunnels: unknown[] };
    check("with the relay reported as present and carrying nothing yet", [view.enabled, view.tunnels], [true, []]);
  } else {
    process.stdout.write(dockerLogs(`${PROJECT}-cp`));
  }
}

cleanup();
docker(["rmi", "-f", IMAGE], { allowFail: true });

process.stdout.write(failures === 0 ? "\nall green\n\n" : `\n${failures} FAILED\n\n`);
process.exit(failures === 0 ? 0 : 1);
