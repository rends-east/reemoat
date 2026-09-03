#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

/**
 * The regression driver for the control plane's image.
 *
 * **The one driver in this repository that is not offline-in-one-process**, and
 * that is a deliberate exception rather than an oversight. Every other check
 * here runs with no fleet, no agent and no network — the property
 * `.github/workflows/check.yml` names as what makes them runnable in CI at all.
 * This one builds a container image and starts it. It therefore lives in its own
 * CI job, and the header of that file says so, because leaving the old claim
 * standing beside a job that contradicts it is exactly the failure the claim is
 * a warning about.
 *
 * **It is not the driver that was deleted for needing an agent.** That one was
 * `dockercheck`, it was about the per-tenant *agent* sandbox, and it was removed
 * because it needed a real `claude` or `kimi` on PATH — the one thing CI cannot
 * hold. This image contains no agent and spawns nothing, so that objection does
 * not apply. The name is different for the same reason: reusing it would make
 * two unrelated things share a cautionary citation.
 *
 * What it asserts, and why each one is here rather than assumed:
 *
 *   * **The image builds.** The highest-value line in the file. `packages/
 *     control-plane` reaches into the repository root for four files by literal
 *     relative path, and the Dockerfile copies exactly those four — so adding a
 *     fifth import passes typecheck, passes every other driver, and breaks only
 *     the image. Nothing else in this repository would notice.
 *   * **No secret rode into a layer.** The build context is the repository root
 *     and that directory holds a 0600 `.env` with the daemon's REEMOAT_TOKEN.
 *     The `.dockerignore` is deny-first; this is what proves it still is.
 *   * **The root workspace package's dependencies are not in there.** pnpm
 *     always installs the workspace root, and this repository's root is a
 *     package whose dependencies are the daemon's — measured, 260 MB of
 *     `claude-agent-sdk` platform binary in the image of a process that spawns
 *     no agent. `prune-store.mjs` removes what is unreachable; over-pruning
 *     fails the start below, under-pruning fails this.
 *   * **`GET /install.sh` answers, with this instance's own origin quoted into
 *     it.** `deploy/bootstrap.sh` reaches the image through two lines written
 *     down separately — `.dockerignore` and a runtime `COPY` — and a miss in the
 *     second is silent in every other driver, because they all read the file
 *     from the checkout. This is also the only place the shell-quoting is proved
 *     *on the path a request takes*: `webcheck` proves the three copies of
 *     `shellQuote` agree, and a hostile `Host` header through a real socket is
 *     what proves one of them is actually called.
 *   * **The refusal paths refuse.** `main.ts` exits 2 without
 *     REEMOAT_CP_RELAY_URL and on equal ports; those are its config contract,
 *     asserted through the container rather than around it.
 *   * **Health answers on the *published* port, from outside.** This is the one
 *     thing the design invents — the bind is pinned to 0.0.0.0 in the image and
 *     the security decision moves to the publish spec — and it is the thing that
 *     would fail silently.
 *   * **The key is minted exactly once, and the signing key survives a
 *     restart.** Both halves of the property the whole volume exists for. If the
 *     second ever breaks, the fleet's Ed25519 key is gone and every enrolled
 *     daemon rejects every token.
 *   * **Both arms of the bootstrap, not just the one that generates.** Added
 *     after the arm this file never drove shipped broken: with
 *     `REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD` set, `main.ts` printed the marker
 *     `admin password: ` on a line carrying no password, and `install.sh`'s
 *     scrape handed the operator its last word. So the supplied arm gets its own
 *     start, and what is asserted is that nothing scrapeable is printed, that
 *     the password itself never reaches the log, that the source marker is there
 *     to say so, and that the password nobody printed is the one that signs in.
 *   * **The SPA fallback serves the same bytes as `/`.** The invariant that a
 *     cached copy once broke, now asserted against a real bundle.
 *   * **The shape it is actually deployed in: two containers from this one
 *     image.** The first bullet's argument, which is the highest-value line in
 *     this file, now has a *second* entry point to be true of —
 *     `src/relay/main.ts` reaches files `src/main.ts` does not, and a COPY or
 *     `.dockerignore` that misses one of them breaks only the relay, only in the
 *     image, and nothing else here would notice. Started with no ordering
 *     between them on purpose, because the relay authorizing from live rows and
 *     never asking the API anything is the property the split exists for.
 *
 * What it cannot honestly assert, said here so nobody reads more into a green
 * run than it earned: nothing about launchd, systemd, `render_unit`, the
 * interview or `deploy.sh`'s gating — the parts of `deploy/` most likely to be
 * wrong stay unchecked. Nothing about macOS; CI is Linux and Docker Desktop
 * differs on exactly the two points this design touches, mount ownership and
 * what `.State.Pid` means. Nothing about whether the operator's *chosen* publish
 * address is right, because a runner can only probe loopback. And nothing about
 * the build being reproducible — only that it succeeded today, with a network.
 *
 *   pnpm imagecheck
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

/**
 * A one-shot run whose *exit status and output* are the assertion.
 *
 * `docker run` propagates the container's exit code, which is what makes the
 * exit-2 contract testable at all.
 */
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

/**
 * `docker logs`, with stderr.
 *
 * `docker()` returns stdout, and `docker logs` exits 0 — so the diagnostic path
 * printed only stdout, which in `main.ts` is the bootstrap block and the
 * listening banner. Every diagnostic there is `console.error`: the config
 * refusals, `relay: cannot listen on …` and its exit(2), the unhandled-rejection
 * and uncaught-exception handlers, the shutdown trace. That is the entire
 * content of the case this exists for.
 */
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

/** Unauthenticated by default; `headers` is for the few checks that need a credential. */
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

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

process.stdout.write("  building (this is the slow part)\n");
try {
  // **`--load` is not optional, and its absence is invisible locally.** `docker
  // build` is an alias for `docker buildx build` and resolves the *selected*
  // builder. On this machine that is a moby driver, which exports into the image
  // store automatically. In CI, `docker/setup-buildx-action` defaults to
  // `driver: docker-container`, where a build with neither `--load` nor
  // `--output` leaves the result in the build cache, warns, and exits 0 — so
  // "image builds" would pass and the very next `docker run` would try to pull
  // the tag from Docker Hub.
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

/*
 * **What a second, fully-cached build must and must not change.**
 *
 * `deploy.sh` decides whether to recreate `control-plane` by comparing
 * `cp_image_fingerprint` across the build, so the property everything downstream
 * rests on is that a rebuild of an unchanged tree compares equal. It is asserted
 * here because it needs a real build, which is exactly what `deploycheck` cannot
 * have — `cp_image_id` and its neighbours are in that file's named uncovered
 * half for this reason.
 *
 * The format string is read out of `lib.sh` rather than restated, so the day
 * somebody widens the fingerprint this asserts the widened one.
 *
 * What is deliberately **not** asserted is that `.Id` moves. It does here — that
 * measurement is what put this check in the file, `.Id` being the OCI index
 * digest that buildkit re-exports every build — but it is a fact about a
 * container engine rather than about this repository, and pinning it would go
 * red the day the engine stops doing it, which is the direction nobody needs
 * telling about.
 */
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

// ---------------------------------------------------------------------------
// What is, and is not, inside it
// ---------------------------------------------------------------------------

const findSecrets = docker([
  "run", "--rm", "--entrypoint", "sh", IMAGE,
  "-c", "find / -xdev \\( -name '.env' -o -name '*.db' -o -name '.git' \\) -not -path '*/node_modules/*' 2>/dev/null | head -20",
]).trim();
check("no .env, *.db or .git anywhere in the image", findSecrets, "");

const store = docker(["run", "--rm", "--entrypoint", "sh", IMAGE, "-c", "ls /app/node_modules/.pnpm"]).trim().split("\n");
/*
 * Scoped names by prefix, bare names by name-then-`@`.
 *
 * The bare half needs that boundary and the scoped half does not: `.pnpm` keys look
 * like `@openai+codex@0.145.0` and `diff@9.0.0`, so an unanchored `diff` would also
 * claim `diff-sequences` and report a package nobody shipped.
 *
 * `@openai` was missing and is the expensive one. `@agentclientprotocol` already
 * covered `codex-acp` itself, but the CLI it vendors — `@openai/codex`, plus a
 * platform binary per architecture — is the same order of weight as the claude SDK
 * this line was written for, and it would have ridden into the image with every
 * check green.
 *
 * **`zod-to-json-schema` is named because adding that boundary silently dropped
 * it.** `zod` used to be a bare prefix, so it also claimed
 * `zod-to-json-schema@3.25.2_zod@4.4.3` — which is in this repo's store and is
 * daemon-only. Anchoring `zod@` to stop `diff` matching `diff-sequences` narrowed
 * this one at the same time, which is the shape of regression a tightened pattern
 * makes: it fails by going *greener*.
 *
 * **`opencode` is the heaviest of the lot and is a family rather than a name.**
 * `opencode-ai` is a shim whose postinstall unpacks one platform executable —
 * measured, 144 MB — chosen from twelve optional dependencies named
 * `opencode-<os>-<arch>[-musl][-baseline]`. On this machine the store holds
 * `opencode-ai@1.18.23` and `opencode-darwin-arm64@1.18.23`; in the image it
 * would be a linux pair. The optional group is why the arm is a pattern: naming
 * only `opencode-ai@` would pass while a quarter-gigabyte of agent rode in beside
 * it, which is `@openai`'s lesson one paragraph up.
 *
 * (All of that is history as of Q4.114: the claude SDK's and `@openai/codex`'s
 * platform packages are excluded by `pnpm-workspace.yaml`'s overrides, and
 * `opencode-ai` is no longer a dependency at all — the CLIs come from
 * `deploy/agents.sh`. The patterns stay exactly as they are: they are the guard
 * against any of it riding back in with a bump.)
 */
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

// ---------------------------------------------------------------------------
// The refusal paths
// ---------------------------------------------------------------------------

const noRelay = runOnce({});
check("exits 2 with no REEMOAT_CP_RELAY_URL", noRelay.code, 2);
ok("and says which variable", noRelay.out.includes("REEMOAT_CP_RELAY_URL is required"), noRelay.out.slice(0, 200));

const samePort = runOnce({
  REEMOAT_CP_RELAY_URL: "http://relay.example",
  REEMOAT_CP_PORT: "7888",
  REEMOAT_CP_RELAY_PORT: "7888",
});
check("exits 2 when the API and relay ports are equal", samePort.code, 2);

/*
 * **And does not, when the two numbers name listeners in two containers.**
 *
 * The refusal above is about one process binding one port twice. Under
 * `external` they are different network namespaces and equal numbers are the
 * ordinary case — `compose.yml` publishes the same number on both sides of each
 * mapping deliberately. Refusing there would refuse the shipped deployment.
 *
 * Asserted by *reaching a later refusal*: this run still has no database it may
 * write and no bootstrap, so what it must not do is stop at the port check.
 */
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

/*
 * A supplied bootstrap password that fails the policy is the fourth refusal, and
 * it is the one whose alternative is silent. `main.ts` documents why it exits
 * rather than generating one instead: a control plane that accepted
 * `REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD` and then stored something else is one
 * whose admin password is not the password the operator believes it is, and they
 * would find that out at the sign-in screen with the generated one already
 * scrolled out of a log.
 *
 * No volume, so this bootstraps against a container-local database and destroys
 * it on exit — which is what makes it a one-shot rather than a fixture.
 */
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

// ---------------------------------------------------------------------------
// A real start, on a scratch volume
// ---------------------------------------------------------------------------

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

/*
 * The admin's password, printed beside the key on the same first start.
 *
 * Two markers on two lines, and the pair is what `deploy/install.sh` scrapes with
 * two anchored `awk` patterns. The assertion below that they cannot pick up each
 * other's value is the direct test of that scrape: a password line containing
 * `API key: ` would be written into `cpctl.env` as though it were a key, and the
 * operator would find out the next time they ran `cpctl`.
 */
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

/*
 * The threadpool, in the environment rather than assigned from JavaScript.
 *
 * `deploy/run-daemon.sh` records why the image `ENV` is the placement that
 * decides it: libuv reads the variable once, lazily, at the first piece of pool
 * work, which under `tsx` happens during module loading. Password verification is
 * scrypt on that pool and `serveStatic` draws from the same one, so a silent 4
 * means a spray against the login endpoint queues the login page behind it —
 * which is a denial of the remedy, and has no symptom from inside.
 */
const pool = docker(["exec", `${PROJECT}-cp`, "printenv", "UV_THREADPOOL_SIZE"]).trim();
check("the image sets a threadpool larger than libuv's default", pool, "64");

const jwks1 = JSON.parse((await get("/v1/jwks")).body) as { keys: { kid: string }[] };
const kid1 = jwks1.keys[0]?.kid ?? "";
ok("a signing key exists", kid1.startsWith("k_"), kid1);

// The web UI, and the invariant a cached copy once broke.
const index = await get("/");
ok("/ serves the built web UI", index.status === 200 && index.body.includes("<!doctype html"), `status ${index.status}`);
const spa = await get("/m/m_x/s/s_y");
check("a client-side route serves the same index.html", spa.body === index.body, true);
/*
 * **This used to assert a 404 and now asserts a 401, and the change is
 * deliberate.** `app.ts` gates the whole of `/v1` behind one middleware placed
 * after the four public routes, so an unknown path under it is refused before the
 * SPA fallback is ever reached. The subject of this check is unchanged — the
 * fallback must not swallow the API and answer HTML — and both statuses prove it;
 * a stranger simply stops learning which routes exist as well.
 */
/*
 * **`GET /install.sh`, and this is the only place it is proved at all.**
 *
 * The route reads `deploy/bootstrap.sh` off disk at a path `main.ts` resolves
 * relative to its own file URL. That file reaches the image through **two**
 * lines — `!deploy/bootstrap.sh` in `.dockerignore` and a `COPY` in the runtime
 * stage — and a miss in the second is silent everywhere else: `typecheck`,
 * `webcheck`, `deploycheck` and `docscheck` all pass, and the route answers 404.
 * So the assertion is made against a real container or it is not made.
 */
const installer = await get("/install.sh");
ok(
  "GET /install.sh serves the bootstrap script",
  installer.status === 200 && installer.body.startsWith("#!/bin/sh"),
  `status ${installer.status}`,
);
/*
 * `text/plain` is part of the safety story rather than a formality:
 * `application/x-sh` makes a browser download the file, and "read it before you
 * pipe it into a shell" is advice this route has to be able to honour.
 */
check("as text a browser will show rather than download", installer.type.startsWith("text/plain"), true);
// The body varies by `Host`, so a shared cache keyed on the path alone would
// hand one instance's address to another instance's users.
check("and is not stored by anything in front of it", installer.cache, "no-store");
check("the placeholder is gone", installer.body.includes("@REEMOAT_CONTROL_PLANE@"), false);
check(
  "and this instance's own address is in it, quoted",
  installer.body.includes(`CONTROL_PLANE_DEFAULT='http://127.0.0.1:${PORT}'`),
  true,
);
/*
 * ⚠ **The one assertion no offline driver can reach, and the one that matters
 * most.** The substituted value is `new URL(c.req.url).origin`, i.e. the `Host`
 * header — measured 2026-08-08 to carry a backtick through `URL.origin` intact.
 * Unquoted, this route is remote code execution in a script people pipe into
 * `sh`. `webcheck` proves the three `shellQuote` copies agree; only this proves
 * the quoting is on the path a real request takes.
 */
/*
 * ⚠ **Over a raw socket, because `fetch` cannot ask this question.** undici
 * treats `Host` as a forbidden header and silently replaces whatever the caller
 * sets with the URL's own authority — measured against a local `node:http`
 * server, `fetch(url, {headers: {host: "a`id`b"}})` arrives as
 * `host: 127.0.0.1:<port>`. So the first version of this check could only ever
 * fail, which is the safe direction and still not a test of what it claims.
 * Thirty lines of HTTP/1.1 is the whole cost, and this is the one assertion in
 * the repository that proves the quoting is on the path a request takes rather
 * than merely present in three files.
 */
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
// And an apostrophe, which is the arm the `'\''` rendering exists for: without
// it the quoting can be closed and stepped out of, which is the whole attack
// rather than a corner of it.
const apostrophe = await rawHost("a'b");
check(
  "and an apostrophe is closed, escaped and reopened",
  apostrophe.includes("CONTROL_PLANE_DEFAULT='http://a'\\''b'"),
  true,
);
// Exactly once — the route asserts `split(...).length === 2`, and a second
// substitution site would mean a value spliced somewhere nobody quoted for.
check(
  "and exactly once",
  hostile.split("CONTROL_PLANE_DEFAULT=").length - 1,
  1,
);
/*
 * **`x-forwarded-proto` is ignored where no proxy has been declared**, which is
 * this container: `REEMOAT_CP_TRUSTED_PROXY_HOPS` is unset, so the default is
 * zero hops. The header is caller-supplied, and believing it from a direct
 * client would let anybody make a plaintext instance hand out an `https://`
 * default — an installer that then cannot reach the thing it was told to join.
 * The half where it *is* believed needs a proxy declared and is asserted on the
 * two-container start below.
 */
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

// ---------------------------------------------------------------------------
// Restart: the volume is the fleet's signing key
// ---------------------------------------------------------------------------

const stopStart = Date.now();
docker(["stop", `${PROJECT}-cp`]);
const stopMs = Date.now() - stopStart;
const exitCode = docker(["inspect", "-f", "{{.State.ExitCode}}", `${PROJECT}-cp`]).trim();
check("SIGTERM is handled: a clean exit 0", exitCode, "0");
// The compose stop_grace_period is 20s and docker's default is 10s; either way a
// process that ignored SIGTERM would be SIGKILLed at the timeout. This asserts
// main.ts's handler ran, which is only true because it is PID 1 — `tsx` as the
// entry point would put a signal-forwarding wrapper in front of it.
ok("and promptly, so nothing waited for SIGKILL", stopMs < 8000, `${stopMs}ms`);

docker(["start", `${PROJECT}-cp`]);
const healthy2 = await waitHealthy();
ok("comes back after a restart", healthy2);

if (healthy2) {
  const logs2 = dockerLogs(`${PROJECT}-cp`);
  const keys2 = logs2.split("\n").filter((l) => l.includes("API key: "));
  check("no second admin key on a start against an existing database", keys2.length, 1);
  // Same rule for the password, and the same counting trick: the log accumulates,
  // so "still exactly one" is what proves the second start minted nothing.
  const passwords2 = logs2.split("\n").filter((l) => /^\s*admin password: /.test(l));
  check("and no second password either", passwords2.length, 1);
  // The nag is for a database with users and no passwords. This one bootstrapped
  // an admin *with* a password, so it must stay quiet.
  check("no password nag when the admin already has one", logs2.includes("no user has a password yet"), false);

  const jwks2 = JSON.parse((await get("/v1/jwks")).body) as { keys: { kid: string }[] };
  check("the signing key survived the restart", jwks2.keys[0]?.kid, kid1);

  const me2 = await fetch(`http://127.0.0.1:${PORT}/v1/me`, {
    headers: { authorization: `Bearer ${adminKey}` },
    signal: AbortSignal.timeout(5000),
  });
  check("and the first key still authenticates", me2.status, 200);
}

// ---------------------------------------------------------------------------
// A fresh volume is a different fleet — asserted so the destructive path is
// documented by something that runs.
// ---------------------------------------------------------------------------

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
// The wait is asserted before it is branched on, the same shape the restart above
// uses. Written as a bare `if (await waitHealthy())`, a container that never came
// up skipped the one assertion in this section and the whole driver still ended
// green — the destructive path documenting itself by not running.
const healthy3 = await waitHealthy();
ok("comes up on a volume that was just deleted", healthy3);

if (healthy3) {
  const jwks3 = JSON.parse((await get("/v1/jwks")).body) as { keys: { kid: string }[] };
  ok("deleting the volume mints a new signing key (i.e. un-enrolls the fleet)", jwks3.keys[0]?.kid !== kid1, `${jwks3.keys[0]?.kid} vs ${kid1}`);
}

// ---------------------------------------------------------------------------
// The other arm of the bootstrap: a password the operator supplied
//
// **This file only ever drove the generated arm, and that is how the credential
// bug shipped.** `main.ts`'s second arm used to print `admin password: taken
// from …_PASSWORD (not printed)` — the marker, on a line carrying no password —
// and `deploy/install.sh` scraped its last field and handed the operator the
// literal word `printed)` as their admin password. Every assertion above was
// green throughout, because every one of them starts a container with no
// `REEMOAT_CP_BOOTSTRAP_ADMIN_PASSWORD` set.
//
// What this can cover is the container-side half: what the process *prints*, and
// that the supplied password is the one that works. The scrape itself belongs to
// a wizard on a terminal, and `scripts/deploycheck.ts` drives it there — against
// both arms, with the lines extracted from `install.sh` and the strings from
// `main.ts`. So the pattern below is stated rather than shared: it is what an
// installer looking for a credential matches, and the assertion is that nothing
// here answers to it.
// ---------------------------------------------------------------------------

/** Long enough for the policy, and not the account name, which is the one rule. */
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

  /*
   * The scrape, restated: `^ *admin password: ` followed by a *value*, which is
   * one field with no spaces because `generatePassword` is
   * `randomBytes(24).toString("base64url")`. Nothing on this arm may answer to
   * it — not a sentence, and least of all a sentence whose last word looks like
   * a credential.
   */
  const scrapeable = logsSupplied.split("\n").filter((l) => /^ *admin password: [^ ]+$/.test(l));
  check("nothing scrapeable is printed when the password came from the environment", scrapeable, []);
  ok("and the supplied password appears nowhere in the log at all", !logsSupplied.includes(SUPPLIED_PASSWORD));

  /*
   * Silence would be its own failure: the installer waits for one of these two
   * lines before it stops polling, so an arm that printed neither would spend the
   * whole sixty-second bound waiting for a password that is never coming.
   */
  const source = logsSupplied.split("\n").filter((l) => /^ *admin password source: /.test(l));
  check("the source marker is printed exactly once instead", source.length, 1);

  // Unchanged by which arm ran: the key is minted and printed on any first start.
  const keysSupplied = logsSupplied.split("\n").filter((l) => l.includes("API key: "));
  check("the admin key is still printed exactly once on this arm", keysSupplied.length, 1);

  /*
   * The half that makes the silence above safe rather than merely quiet: the
   * password that was never printed is the password that works. Without this,
   * "prints nothing" is satisfied by a control plane that stored something else.
   */
  const suppliedSignIn = await fetch(`http://127.0.0.1:${PORT}/v1/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "admin", password: SUPPLIED_PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  });
  check("and the password nobody printed is the one that signs in", suppliedSignIn.status, 200);
}

// ---------------------------------------------------------------------------
// The shape it is actually deployed in: two containers, one image
// ---------------------------------------------------------------------------
//
// **This is the check that catches a missing COPY on the relay's half.** The
// header's highest-value line — "adding a fifth import passes typecheck, passes
// every other driver, and breaks only the image" — now has a second entry point
// to be true of, and `src/relay/main.ts` reaches files `src/main.ts` does not.
// Nothing else in this repository would notice.
//
// It also asserts the property the whole split exists for, as far as a driver
// with no daemon can: the API answers `relayOnline` from a table rather than
// from a registry it no longer has.
{
  cleanup();
  docker(["volume", "create", VOLUME]);
  const env = [
    "-e", `REEMOAT_CP_RELAY_URL=http://127.0.0.1:${RELAY_PORT}`,
    "-e", `REEMOAT_CP_PORT=${PORT}`,
    "-e", `REEMOAT_CP_RELAY_PORT=${RELAY_PORT}`,
    // One declared hop, which is what the deployed stack sets and what makes the
    // `x-forwarded-proto` half of `/install.sh` reachable at all.
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
  /*
   * No ordering between them, deliberately, and that is the property rather than
   * a shortcut: the relay authorizes from live rows and never asks the API
   * anything, so it must come up beside a control plane that may not be there.
   * Whichever wins creates the schema.
   */
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

  /*
   * ⚠ **The one that decides whether the installer works in production at all.**
   * This service is served over plain HTTP behind a proxy that terminates TLS —
   * Traefik forwards `app.reemoat.com` to `http://control-plane:7888` — so
   * `publicUrl` answers `http://app.reemoat.com`. Measured against the live
   * deployment: `http://app.reemoat.com/v1/instance` is a **301** to the `https`
   * form, and `bootstrap.sh` does not follow redirects. An installer built from
   * `publicUrl` alone therefore refuses on its first request, on the only
   * deployment shape this feature exists for. With a hop declared, the header
   * that says so is believed.
   */
  // No `host:` here — undici silently replaces a caller-set `Host` with the
  // URL's own authority (measured), so passing one would read as testing
  // something this call cannot test. The scheme is the whole subject.
  const proxied = await get("/install.sh", { "x-forwarded-proto": "https" });
  check(
    "a declared proxy's x-forwarded-proto reaches the installer's default",
    proxied.body.includes("CONTROL_PLANE_DEFAULT='https://"),
    true,
  );

  if (apiUp && relayUp) {
    const relayLogs = dockerLogs(`${PROJECT}-relay`);
    ok("saying it is a relay rather than a control plane", relayLogs.includes("Reemoat relay listening on"), relayLogs.slice(-500));
    /*
     * The one line that would be a real defect rather than a cosmetic one: the
     * relay must never mint a signing key. `ensureSigningKey` is the API's, and
     * a second minter would be a race over the one secret in this system.
     */
    ok("and never printing a signing key of its own", !relayLogs.includes("signing key:"), relayLogs.slice(-500));

    const logs = dockerLogs(`${PROJECT}-cp`);
    ok("while the API says its tunnels are somebody else's", logs.includes("(external —"), logs.slice(-500));

    const key = logs.split("\n").filter((l) => l.includes("API key: "))[0]?.trim().split(/\s+/).pop() ?? "";
    const admin = await get("/v1/admin/relay", { authorization: `Bearer ${key}` });
    check("and the relay view still answers, from the table this time", admin.status, 200);
    /*
     * `enabled` is what `POST /v1/tokens` reads through — a control plane that
     * reported the relay switched off would hand every client `relayOnline:
     * false` and draw a fleet with no reachable machines. `tunnels` is empty
     * because there is no daemon here, which is the correct answer rather than a
     * missing one.
     */
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
